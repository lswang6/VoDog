#!/usr/bin/env bash
# Fresh, dedicated Ubuntu 24.04 amd64 host. Run locally on that host as root.
set -euo pipefail
if [[ ${EUID} != 0 || $# != 2 ]]; then
    echo 'Usage: sudo bash infra/install-host.sh /absolute/private/state admin@example.com' >&2
    exit 2
fi
state=$(realpath -- "$1")
email=$2
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(uname -m) == x86_64 ]] || {
    echo 'This bootstrap supports Ubuntu 24.04 amd64 only.' >&2; exit 1;
}
[[ -f "$state/compose.json" && -f "$state/deployment.json" ]] || exit 1
[[ ! -e "$state/installed" ]] || { echo 'Already installed; follow the upgrade instructions.' >&2; exit 1; }
readarray -t domains < <(python3 - "$state/deployment.json" <<'PY'
import json, sys
config=json.load(open(sys.argv[1]))
for key in ('domain','turnDomain'):
    host=config[key]
    if host == 'example.com' or host.endswith('.example.com'):
        raise SystemExit('Replace example domains before installing')
    print(host)
PY
)
[[ ${#domains[@]} == 2 ]] || exit 1
apt-get update
apt-get install -y docker.io docker-compose-v2 certbot python3 curl
systemctl enable --now docker
if docker volume inspect vodog_postgres >/dev/null 2>&1; then
    echo "Existing database volume found; use the upgrade instructions." >&2; exit 1
fi
compose=(docker compose --project-directory "$state" -f "$state/compose.json")
"${compose[@]}" config --quiet
install -d -m 700 "$state/data"
chown 10001:10001 "$state/data" "$state/ai-token" "$state/control.env"
chmod 600 "$state/ai-token"
install -d -m 755 /var/www/vodog-acme
# Build before issuing certificates, so source/dependency errors leave no partial install.
"${compose[@]}" --profile voice --profile maintenance build
bootstrap=''
cleanup() { if [[ -n $bootstrap ]]; then docker rm -f "$bootstrap" >/dev/null; fi; }
trap cleanup EXIT
bootstrap=$(docker run -d --rm -p 80:80 -v /var/www/vodog-acme:/usr/share/nginx/html:ro nginx:stable-bookworm)
certbot certonly --non-interactive --agree-tos --email "$email" --webroot -w /var/www/vodog-acme \
    --cert-name "${domains[0]}" -d "${domains[0]}" -d "${domains[1]}"
cleanup
bootstrap=''
"${compose[@]}" up -d --wait
"${compose[@]}" --profile setup run --rm seed
# Certbot keeps the webroot authenticator; nginx serves its challenge directory on port 80.
python3 - "$state" <<'PY'
from pathlib import Path
import shlex, sys
state=Path(sys.argv[1])
hook=Path('/etc/letsencrypt/renewal-hooks/deploy/vodog-reload')
hook.parent.mkdir(parents=True,exist_ok=True)
if hook.exists():
    raise SystemExit('Refusing to replace an existing certificate renewal hook')
hook.write_text('#!/bin/sh\nset -eu\n/usr/bin/docker compose --project-directory '+shlex.quote(str(state))+' -f '+shlex.quote(str(state/'compose.json'))+' restart web turn\n')
hook.chmod(0o700)
unit=Path('/etc/systemd/system/vodog-retention.service')
unit.write_text('[Unit]\nDescription=VoDog bounded retention\nAfter=docker.service\nRequires=docker.service\n\n[Service]\nType=oneshot\nTimeoutStartSec=20min\nExecStart=/usr/bin/docker compose --project-directory '+shlex.quote(str(state))+' -f '+shlex.quote(str(state/'compose.json'))+' --profile maintenance run --rm retention apply --env-file /run/control.env --root /data/recording-backups --no-remote\n')
Path('/etc/systemd/system/vodog-retention.timer').write_text('[Unit]\nDescription=VoDog daily bounded retention\n\n[Timer]\nOnCalendar=*-*-* 03:30:00 UTC\nRandomizedDelaySec=900\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n')
(state/'installed').touch(mode=0o600)
PY
systemctl daemon-reload
systemctl enable --now certbot.timer vodog-retention.timer
curl --fail --silent --show-error "https://${domains[0]}/healthz"
echo
printf 'VoDog installed. Read %s/admin.env privately for the generated login.\n' "$state"
