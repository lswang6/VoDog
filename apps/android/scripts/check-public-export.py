#!/usr/bin/env python3
"""Check public Android identity, JNI linkage and forbidden local artifacts."""
from pathlib import Path
import re
import zipfile

root = Path(__file__).resolve().parents[1]
generated = {"build", ".gradle", ".kotlin", ".cxx", ".externalNativeBuild"}
files = [p for p in root.rglob("*") if p.is_file() and not generated.intersection(p.relative_to(root).parts)]
for p in files:
    rel = p.relative_to(root)
    assert p.name not in {"google-services.json", "local.properties"}, rel
    assert p.suffix not in {".jks", ".keystore", ".p12", ".pfx", ".apk", ".so", ".wav", ".ogg", ".log"}, rel
    if p.suffix == ".kt":
        text = p.read_text()
        package = re.search(r"^package (\S+)", text, re.M).group(1)
        assert package == "org.vodog" or package.startswith("org.vodog."), (rel, package)
        assert ("/" + package.replace(".", "/")) in str(rel.parent), rel
    if p.suffix == ".xml":
        import xml.etree.ElementTree as ET
        ET.parse(p)

native = (root / "gateway/src/main/cpp/libopus_jni.cpp").read_text()
cmake = (root / "gateway/src/main/cpp/CMakeLists.txt").read_text()
assert "add_library(vodog_opus SHARED libopus_jni.cpp)" in cmake
count = 0
for name in ("LibOpusEncoder", "LibOpusDecoder"):
    text = (root / f"gateway/src/main/java/org/vodog/gateway/media/{name}.kt").read_text()
    assert 'System.loadLibrary("vodog_opus")' in text
    for method in re.findall(r"external fun (\w+)\(", text):
        symbol = f"Java_org_vodog_gateway_media_{name}_{method}"
        assert symbol + "(" in native, symbol
        count += 1
assert count == len(re.findall(r"Java_org_vodog_\w+\(", native))
with zipfile.ZipFile(root / "gradle/wrapper/gradle-wrapper.jar") as wrapper:
    assert wrapper.testzip() is None
    assert all(n.startswith(("org/", "META-INF/")) or n in {
        "gradle-wrapper-classpath.properties", "gradle-cli-classpath.properties",
        "build-receipt.properties"} for n in wrapper.namelist())
for module, package in (("client", "org.vodog"), ("gateway", "org.vodog.gateway")):
    gradle = (root / module / "build.gradle.kts").read_text()
    assert f'namespace = "{package}"' in gradle
    assert f'applicationId = "{package}"' in gradle
print(f"PASS: {len(files)} public files; XML, namespaces, wrapper and {count} JNI methods")
