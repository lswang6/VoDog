#!/usr/bin/env python3
"""Check the Git publication set without printing potentially sensitive values.

This is a lightweight guard, not a guarantee that every secret is detectable.
Run a dedicated secret scanner and review the staged diff before publication.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
BLOCKED_NAMES = {'.env', 'google-services.json', 'GoogleService-Info.plist', 'local.properties', '.DS_Store'}
BLOCKED_SUFFIXES = {'.p8', '.p12', '.pfx', '.jks', '.keystore', '.mobileprovision', '.sqlite', '.sqlite3', '.apk', '.ipa'}
PATTERNS = {
    'private key': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'GitHub token': rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b',
    'Google API key': rb'\bAIza[A-Za-z0-9_-]{35}\b',
    'AWS access key': rb'\bAKIA[A-Z0-9]{16}\b',
    'provider API key': rb'\b(?:sk-proj-|sk-ant-api\d+-|xai-)[A-Za-z0-9_-]{25,}\b',
    'personal home path': rb'(?:/Users/|/home/)(?!example(?:/|\b)|user(?:/|\b)|runner(?:/|\b)|vodog(?:/|\b)|build(?:/|\b))[A-Za-z0-9_.-]+/',
}

def findings(path, data):
    result = []
    p = pathlib.PurePosixPath(path)
    archived_apk = p.suffix == '.apk' and str(p).startswith('infra/pixel/external/turbo-ims/')
    if p.name in BLOCKED_NAMES or (p.suffix in BLOCKED_SUFFIXES and not archived_apk):
        result.append('private/generated file')
    # Vendor source can contain upstream developer build paths or key parser fixtures.
    # Such files still need the independent scanner and manual attribution review.
    vendor = any(x in p.parts for x in ('vendor', 'Vendor', 'third_party', 'ThirdParty', 'external'))
    for label, pattern in PATTERNS.items():
        if vendor and label in ('personal home path', 'private key'):
            continue
        if re.search(pattern, data):
            result.append(label)
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        assert findings('config/.env', b'VALUE=x') == ['private/generated file']
        assert 'GitHub token' in findings('src/a.ts', ('ghp_' + 'a'*36).encode())
        assert not findings('README.md', b'https://app.example.com +1 202-555-0142')
        print('Publication guard self-test passed')
        return 0
    paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
    failures = []
    for name in sorted(set(filter(None, paths))):
        file = ROOT / name
        if file.is_symlink():
            failures.append((name, 'symlink requires manual review'))
        elif file.is_file():
            failures.extend((name, reason) for reason in findings(name, file.read_bytes()))
    component_root = ROOT / 'infra/pixel/external'
    manifest = component_root / 'manifest.json'
    if manifest.exists():
        for entry in json.loads(manifest.read_text()):
            component = component_root / entry['path']
            if not component.is_file() or hashlib.sha256(component.read_bytes()).hexdigest() != entry['sha256']:
                failures.append((str(component.relative_to(ROOT)), 'component checksum mismatch'))
    runtime_root = ROOT / 'apps/macos/Resources/ModuleVoice'
    runtime_manifest = json.loads((runtime_root / 'manifest.json').read_text())
    reference = json.loads((ROOT / 'apps/macos/module/runtime-manifest.example.json').read_text())
    if runtime_manifest != reference:
        failures.append((str(runtime_root.relative_to(ROOT)), 'runtime manifest differs from pinned reference'))
    for entry in runtime_manifest['files']:
        component = runtime_root / entry['name']
        if not component.is_file() or component.stat().st_size != entry['size'] or hashlib.sha256(component.read_bytes()).hexdigest() != entry['sha256']:
            failures.append((str(component.relative_to(ROOT)), 'runtime size/checksum mismatch'))
    for name, reason in failures:
        print(f'{name}: {reason}')
    print(f'Publication guard: {len(set(filter(None, paths)))} files, {len(failures)} findings')
    return int(bool(failures))

if __name__ == '__main__':
    sys.exit(main())
