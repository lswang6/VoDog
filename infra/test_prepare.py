#!/usr/bin/env python3
"""Offline checks: generated contracts, secret isolation, and synthetic module packaging."""
import argparse
import contextlib
import hashlib
import hmac
import base64
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('prepare', HERE / 'prepare.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

def read_env(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines())

class DeploymentTests(unittest.TestCase):
    def test_generated_contracts_and_no_overwrite(self):
        with tempfile.TemporaryDirectory(prefix='vodog-test-') as tmp:
            out = Path(tmp) / 'state'
            args = argparse.Namespace(output=out, domain='app.example.com', turn_domain='turn.example.com',
                                      public_ip='203.0.113.10', listen_ip='192.0.2.10')
            with contextlib.redirect_stdout(io.StringIO()):
                prepare.prepare(args)
            control, media, voice = (read_env(out / f'{s}.env') for s in ('control','media','voice'))
            node = json.loads(control['MEDIA_NODES_JSON'])[0]
            self.assertEqual(node['id'], control['MEDIA_DEFAULT_NODE_ID'])
            self.assertEqual(node['id'], media['MEDIA_NODE_ID'])
            self.assertEqual(node['mediaSecret'], media['MEDIA_SECRET'])
            self.assertEqual(node['turnSecret'], media['TURN_SECRET'])
            self.assertIn('static-auth-secret='+media['TURN_SECRET'], (out/'turnserver.conf').read_text())
            self.assertEqual(control['AI_INTERNAL_TOKEN'], (out/'ai-token').read_text().strip())
            self.assertFalse({'DATABASE_URL','MEDIA_SECRET','TURN_SECRET'} & voice.keys())
            self.assertEqual(control['AI_ENABLED'], 'false')
            self.assertEqual(out.stat().st_mode & 0o777, 0o700)
            for path in out.iterdir():
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            compose=json.loads((out/'compose.json').read_text())
            self.assertEqual(compose['services']['voice']['profiles'], ['voice'])
            self.assertEqual(compose['services']['postgres']['ports'], ['127.0.0.1:5432:5432'])
            self.assertIn('/webrtc-probe/offer', (out/'nginx.conf').read_text())
            before=hashlib.sha256((out/'control.env').read_bytes()).digest()
            with self.assertRaises(FileExistsError):
                prepare.prepare(args)
            self.assertEqual(before,hashlib.sha256((out/'control.env').read_bytes()).digest())

    def test_probe_grant_matches_media_contract(self):
        spec=importlib.util.spec_from_file_location('check_media', HERE/'check-media.py')
        probe=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(probe)
        secret='a'*64
        options=probe.options({'PUBLIC_ORIGIN':'https://app.example.com', 'MEDIA_NODES_JSON':json.dumps([
            {'id':'relay-primary','mediaSecret':secret,'turnSecret':'b'*64,'turnUdpUrl':'turn:turn.example.com:3478?transport=udp'}])}, 1000)
        node=options['nodes'][0]
        payload,signature=node['grant'].split('.')
        self.assertEqual(signature,probe.b64(hmac.new(secret.encode(),payload.encode(),hashlib.sha256).digest()))
        claim=json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
        self.assertEqual(claim['path'],'/webrtc-probe/offer')
        self.assertEqual(claim['exp'],1030)
        self.assertEqual(options['iceTransportPolicy'],'relay')

    def test_invalid_input(self):
        for value in ('example.com\nattack', 'https://example.com', 'example.com;id', '../example.com'):
            with self.assertRaises(argparse.ArgumentTypeError):
                prepare.domain(value)
        with self.assertRaises(argparse.ArgumentTypeError):
            prepare.ipv4('999.1.1.1')
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                prepare.env(Path(tmp)/'bad.env', {'KEY':'a\nINJECT=yes'})

    def test_synthetic_pixel_module_and_rejections(self):
        with tempfile.TemporaryDirectory(prefix='vodog-module-') as tmp:
            root=Path(tmp)
            apk=root/'synthetic.apk'
            apk.write_bytes(b'synthetic APK; never install')
            aapt=root/'aapt'
            def fake(package='org.vodog.gateway', permissions=True):
                names=['CONTROL_INCALL_EXPERIENCE','MODIFY_PHONE_STATE','CAPTURE_AUDIO_OUTPUT',
                       'BYPASS_CONCURRENT_RECORD_AUDIO_RESTRICTION','READ_PRIVILEGED_PHONE_STATE',
                       'CHANGE_COMPONENT_ENABLED_STATE'] if permissions else []
                aapt.write_text('#!'+sys.executable+'\nimport sys\nprint('+repr("package: name='"+package+"' versionCode='1'")+') if sys.argv[2]=="badging" else print('+repr('\n'.join("uses-permission: name='android.permission."+n+"'" for n in names))+')\n')
                aapt.chmod(0o700)
            fake()
            command=[sys.executable,str(HERE/'pixel/build-module.py'),str(apk),'--aapt',str(aapt),
                     '--output',str(root/'out'),'--selinux-domain','priv_app_36']
            result=subprocess.run(command,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            with zipfile.ZipFile(root/'out/vodog-gateway-magisk.zip') as module:
                self.assertIn('org.vodog.gateway',module.read('module.prop').decode())
                self.assertIn('allow priv_app_36 magisk',module.read('sepolicy.rule').decode())
                self.assertIn('GNU GENERAL PUBLIC LICENSE',module.read('LICENSE').decode())
            fake(package='org.example.unrelated')
            self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)
            fake(permissions=False)
            self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)
            self.assertNotEqual(subprocess.run(command[:-1]+['priv_app;bad'],capture_output=True).returncode,0)

if __name__ == '__main__':
    unittest.main()
