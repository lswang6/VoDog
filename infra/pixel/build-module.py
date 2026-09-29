#!/usr/bin/env python3
"""Build an independent Magisk module; does not install or reboot the phone."""

import argparse
import hashlib
import json
import shutil
from pathlib import Path
import re
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parents[2]
INSTALLER_ROOT = Path(__file__).resolve().parent / "magisk-installer"
PACKAGE = "org.vodog.gateway"
REQUIRED_PERMISSIONS = [
    "CONTROL_INCALL_EXPERIENCE",
    "MODIFY_PHONE_STATE",
    "CAPTURE_AUDIO_OUTPUT",
    "BYPASS_CONCURRENT_RECORD_AUDIO_RESTRICTION",
    "READ_PRIVILEGED_PHONE_STATE",
    "CHANGE_COMPONENT_ENABLED_STATE",
]

parser = argparse.ArgumentParser()
parser.add_argument("apk", type=Path)
parser.add_argument(
    "--aapt",
    type=Path,
    default=Path(shutil.which("aapt") or "aapt"),
)
parser.add_argument("--output", type=Path, default=ROOT / "build/pixel")
parser.add_argument("--selinux-domain", required=True, help="Verified APK SELinux domain for your Android build")
args = parser.parse_args()
if not re.fullmatch(r"[a-z][a-z0-9_]*", args.selinux_domain):
    raise SystemExit("Invalid SELinux domain")

if not args.apk.is_file():
    raise SystemExit("Gateway APK does not exist")
if not args.aapt.is_file():
    raise SystemExit("Provide the installed aapt path")

badging = subprocess.check_output(
    [str(args.aapt), "dump", "badging", str(args.apk)], text=True
)
match = re.search(r"package: name='([^']+)' versionCode='([^']+)'", badging)
if not match or match[1] != PACKAGE:
    raise SystemExit("Refusing APK with unexpected package")

permissions = subprocess.check_output(
    [str(args.aapt), "dump", "permissions", str(args.apk)], text=True
)
if any(
    f"name='android.permission.{name}'" not in permissions
    for name in REQUIRED_PERMISSIONS
):
    raise SystemExit(
        "Gateway APK does not yet declare the required privileged permissions"
    )

output = args.output
output.mkdir(parents=True, exist_ok=True)
archive = output / "vodog-gateway-magisk.zip"
license_path = ROOT / "apps/android/gateway/LICENSE-GPL-3.0.txt"

# Verify this domain on the target OS before building; Android versions differ.
SEPOLICY_RULES = "".join(
    f"allow {args.selinux_domain} magisk {rule}\n" for rule in (
        "unix_stream_socket connectto", "fd use", "fifo_file { read write getattr ioctl }", "process sigchld",
    )
)

xml = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    f'<permissions><privapp-permissions package="{PACKAGE}">\n'
    + "".join(
        f'<permission name="android.permission.{name}"/>\n'
        for name in REQUIRED_PERMISSIONS
    )
    + "</privapp-permissions></permissions>\n"
)

with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as module:
    module.write(args.apk, f"system/priv-app/{PACKAGE}/app.apk")
    module.writestr(
        f"system/etc/permissions/privapp-permissions-{PACKAGE}.xml", xml
    )
    # Permit the gateway to use Magisk for signature-only platform operations.
    module.writestr("sepolicy.rule", SEPOLICY_RULES)
    module.writestr(
        "module.prop",
        f"id={PACKAGE}\n"
        "name=VoDog Gateway\n"
        "version=0.2.0\n"
        "versionCode=2\n"
        "author=VoDog\n"
        "description=Dedicated gateway privileged base with reversible "
        "audio-owner handoff.\n",
    )
    for source, target in [
        ("update-binary", "META-INF/com/google/android/update-binary"),
        ("updater-script", "META-INF/com/google/android/updater-script"),
    ]:
        module.write(INSTALLER_ROOT / source, target)
    module.write(INSTALLER_ROOT / "SOURCE.md", "SOURCE.md")
    module.write(license_path, "LICENSE")

report = {
    "package": PACKAGE,
    "apkVersionCode": int(match[2]),
    "apkSha256": hashlib.sha256(args.apk.read_bytes()).hexdigest(),
    "moduleSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    "privilegedPermissions": REQUIRED_PERMISSIONS,
    "installed": False,
}
(output / "module-manifest.json").write_text(json.dumps(report, indent=2) + "\n")
print(archive)
print(json.dumps(report))
