#!/usr/bin/env python3
"""Check public iOS identity, configuration and generated-project consistency."""
from pathlib import Path
import plistlib
import struct
import re

root = Path(__file__).resolve().parent
for path in root.rglob("*"):
    if not path.is_file():
        continue
    assert not path.is_symlink(), path
    assert not any(p in {".git", "DerivedData", "build", "xcuserdata"} for p in path.relative_to(root).parts), path
    if path.suffix == ".ogg":
        assert path.relative_to(root).as_posix() == "VoDogTests/Fixtures/synthetic-opus.ogg", path
        assert path.read_bytes().startswith(b"OggS"), path
        continue
    if path.suffix == ".png":
        assert path.relative_to(root).as_posix() == "VoDog/Assets.xcassets/AppIcon.appiconset/AppIcon.png", path
        data = path.read_bytes()
        assert data[:8] == bytes([137, 80, 78, 71, 13, 10, 26, 10]), path
        assert struct.unpack(">II", data[16:24]) == (1024, 1024), path
        assert data[25] == 2, "App icon must be opaque RGB"
        continue
    text = path.read_text()
    # Concatenation keeps the forbidden source identifiers out of public inputs.
    for forbidden in ["Caller" + "Center", "Caller" + " Center", "caller" + "center",
                      "clima" + "pro", "/" + "Users/", "/" + "Volumes/", "TX57" + "ZT87FD"]:
        assert forbidden not in text, (path, forbidden)
    assert not re.search(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", text), path

info = plistlib.loads((root / "VoDog/Info.plist").read_bytes())
assert info["CFBundleDisplayName"] == "VoDog"
assert info["VoDogDomain"] == "$(VODOG_DOMAIN)"
entitlements = plistlib.loads((root / "VoDog/VoDog.entitlements").read_bytes())
assert entitlements["com.apple.developer.associated-domains"] == ["webcredentials:$(VODOG_DOMAIN)"]
project = (root / "VoDog.xcodeproj/project.pbxproj").read_text()
for bundle in ["org.vodog", "org.vodog.tests", "org.vodog.uitests"]:
    assert f"PRODUCT_BUNDLE_IDENTIFIER = {bundle};" in project
assert "DEVELOPMENT_TEAM =" not in project
for folder in ["VoDog", "VoDogTests", "VoDogUITests"]:
    for path in (root / folder).glob("*.swift"):
        assert path.name in project, path
assert "@testable import VoDog" in (root / "VoDogTests/ContractTests.swift").read_text()
print("PASS: public iOS inputs, bundle IDs and generated source references")
