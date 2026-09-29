#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic bytes for payload integrity tests; never valid loadable drivers."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "module/runtime-manifest.example.json").read_text())
output = root / ".build/self-tests/voice-fixture"
output.mkdir(parents=True, exist_ok=True)
manifest["runtimeVersion"] = "synthetic-test-only"
for entry in manifest["files"]:
    data = ("SYNTHETIC TEST ONLY: " + entry["name"]).encode()
    (output / entry["name"]).write_bytes(data)
    entry["size"] = len(data)
    entry["sha256"] = hashlib.sha256(data).hexdigest()
(output / "manifest.json").write_text(json.dumps(manifest))
