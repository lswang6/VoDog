#!/usr/bin/env python3
"""Explicit synthetic UDP TURN + HTTPS media echo check; no SIM or real call is used."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import subprocess
import time


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()


def options(config, now):
    generation = 'vodog-check-' + secrets.token_hex(8)
    targets = []
    for node in json.loads(config['MEDIA_NODES_JSON']):
        expires = now + 30
        claim = dict(purpose='media-webrtc-probe-v1', method='POST', path='/webrtc-probe/offer',
                     nodeId=node['id'], subjectHash=b64(secrets.token_bytes(24)),
                     networkGeneration=generation, role='client', exp=expires, nonce=b64(secrets.token_bytes(24)))
        payload = b64(json.dumps(claim,separators=(',', ':')).encode())
        grant = payload + '.' + b64(hmac.new(node['mediaSecret'].encode(), payload.encode(), hashlib.sha256).digest())
        username = f'{now+60}:vodog-check-{secrets.token_hex(8)}'
        credential = base64.b64encode(hmac.new(node['turnSecret'].encode(),username.encode(),hashlib.sha1).digest()).decode()
        targets.append(dict(nodeId=node['id'], probeUrl=config['PUBLIC_ORIGIN']+'/webrtc-probe/offer',
            expiresAt=datetime.fromtimestamp(expires,timezone.utc).isoformat(), grant=grant,
            iceServers=[dict(urls=[node['turnUdpUrl']], username=username, credential=credential)]))
    return dict(networkGeneration=generation, measurement='relay_data_channel_echo_v1', lifetimeMs=5000,
                sampleDurationMs=2000, packetIntervalMs=20, maxPackets=250, maxPacketBytes=512,
                iceTransportPolicy='relay', nodes=targets)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('state',type=Path)
    parser.add_argument('--probe-binary',type=Path,required=True,help='Prebuilt services/media/cmd/quality-relay-probe')
    args=parser.parse_args()
    config=dict(line.split('=',1) for line in (args.state/'control.env').read_text().splitlines() if line and not line.startswith('#'))
    # Credentials go through stdin, never arguments, reports or shell expansion.
    result=subprocess.run([str(args.probe_binary.resolve()),'-input','-','-output','-'],
                          input=json.dumps(options(config,int(time.time()))),capture_output=True,text=True,timeout=30)
    if result.returncode:
        raise SystemExit('Media probe failed; no credentials logged')
    report=json.loads(result.stdout)
    print(json.dumps(report,indent=2))
    if not report.get('nodes') or any(node.get('outcome')!='ok' or not node.get('selectedPair',{}).get('udpRelayOnly') for node in report['nodes']):
        raise SystemExit('TURN/media echo failed; inspect the sanitized report')

if __name__=='__main__':
    main()
