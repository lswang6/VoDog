#!/usr/bin/env python3
"""Validate local Markdown destinations in first-party project documentation."""
import pathlib
import re
import sys
from urllib.parse import unquote, urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[1]
SKIP = {'node_modules', 'vendor', 'Vendor', 'ThirdParty', 'third_party', 'external', '.git', '.build', 'build', 'graft'}
failures = []
checked = 0
for file in ROOT.rglob('*.md'):
    if any(part in SKIP for part in file.relative_to(ROOT).parts):
        continue
    text = re.sub(r'```.*?```', '', file.read_text(), flags=re.S)
    for match in re.finditer(r'!?\[[^\]]*\]\(([^)]+)\)', text):
        target = match.group(1).strip().split(' "')[0].strip('<>')
        url = urlsplit(target)
        if url.scheme or url.netloc or not url.path:
            continue
        destination = (file.parent / unquote(url.path)).resolve()
        checked += 1
        if not destination.exists():
            failures.append(f'{file.relative_to(ROOT)}: missing {target}')
print('\n'.join(failures))
print(f'Document links: {checked} checked, {len(failures)} broken')
sys.exit(bool(failures))
