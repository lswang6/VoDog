#!/usr/bin/env python3
"""Generate a private, fresh-host deployment directory; never connect to a host."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets

ROOT = Path(__file__).resolve().parents[1]

def domain(value):
    if len(value) > 253 or not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', value):
        raise argparse.ArgumentTypeError('Use a lowercase DNS hostname, without a scheme or port')
    return value

def ipv4(value):
    try:
        return str(ipaddress.IPv4Address(value))
    except ValueError as error:
        raise argparse.ArgumentTypeError('Use an IPv4 address') from error

def write(path, data):
    with path.open('x') as file:
        file.write(data)
    path.chmod(0o600)

def env(path, values):
    # Generated values only; reject newline injection and Compose interpolation.
    if any('\n' in str(v) or '\r' in str(v) or '$' in str(v) for v in values.values()):
        raise ValueError('Unsafe environment value')
    write(path, ''.join(f'{k}={v}\n' for k, v in values.items()))

def prepare(args):
    out = args.output.resolve()
    if any(c in str(out) for c in '\n\r:$%'):
        raise ValueError('Output path cannot contain newlines, colon or dollar')
    if out == ROOT or ROOT in out.parents:
        raise ValueError('Keep deployment state outside the source checkout')
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(out, 0o700)
    database, cookie, media, turn, ai, password = (secrets.token_hex(32) for _ in range(6))
    origin = f'https://{args.domain}'
    turn_udp = f'turn:{args.turn_domain}:3478?transport=udp'
    node = dict(id='relay-primary', controlBaseUrl='http://127.0.0.1:16881',
                turnUdpUrl=turn_udp, turnTlsUrl=f'turns:{args.turn_domain}:5349?transport=tcp',
                probeUrl=f'{origin}/media/probe', mediaSecret=media, turnSecret=turn)
    env(out / 'postgres.env', dict(POSTGRES_USER='vodog', POSTGRES_DB='vodog', POSTGRES_PASSWORD=database))
    env(out / 'control.env', dict(DATABASE_URL=f'postgresql://vodog:{database}@127.0.0.1:5432/vodog',
        COOKIE_SECRET=cookie, PUBLIC_ORIGIN=origin, RP_ID=args.domain, PORT=16880,
        MEDIA_DEFAULT_NODE_ID='relay-primary', MEDIA_NODES_JSON=json.dumps([node], separators=(',', ':')),
        RECORDING_ROOT='/data/recordings', RECORDING_MP3_CACHE_DIR='/data/mp3',
        PIXEL_ARCHIVE_ENABLED='true', PIXEL_ARCHIVE_ROOT='/data/pixel-archives',
        PIXEL_ARCHIVE_VALIDATOR_PATH='/usr/local/bin/recording-archive-validator',
        AI_ENABLED='false', AI_WORKER_READY='false', AI_INTERNAL_TOKEN=ai, AI_MEDIA_NODE_ID='relay-primary',
        AI_VOICE_PROVIDERS='xai', TRANSCRIPTION_ENABLED='false', FCM_ENABLED='false',
        COMMAND_REPLAY_MIGRATION_ENABLED='true', COMMAND_REPLAY_HORIZON_ENABLED='true',
        CALL_DTMF_ENABLED='true', BUSY_CONFLICT_ENABLED='true', EARLY_MEDIA_ENABLED='true',
        PIXEL_ORIGINATED_CALLS_ENABLED='true', WEB_CALL_LIVENESS_ENABLED='true',
        BADGE_PUSH_ENABLED='false'))
    env(out / 'media.env', dict(MEDIA_SECRET=media, TURN_SECRET=turn, MEDIA_NODE_ID='relay-primary',
        MEDIA_LISTEN_ADDR='127.0.0.1:16881', MEDIA_RECORD_DIR='/data/recordings',
        MEDIA_TURN_UDP_URL=turn_udp, MEDIA_PROBE_ALLOWED_ORIGINS=origin))
    env(out / 'voice.env', dict(VOICE_CONTROL_ORIGIN='http://127.0.0.1:16880',
        AI_INTERNAL_TOKEN_FILE='/run/ai-token', VOICE_NODE_ID='voice-primary',
        VOICE_INSTANCE_ID='voice-primary', VOICE_MEDIA_TRANSPORT='udp', VOICE_PROVIDER='xai', XAI_API_KEY='', XAI_AGENT_ID='', XAI_REALTIME_MODEL=''))
    write(out / 'ai-token', ai + '\n')
    env(out / 'admin.env', dict(TEST_USERNAME='admin@example.com', TEST_PASSWORD=password, TEST_USER_ROLE='admin'))
    cert = f'/etc/letsencrypt/live/{args.domain}'
    denied = ['0.0.0.0-0.255.255.255', '10.0.0.0-10.255.255.255', '127.0.0.0-127.255.255.255',
              '169.254.0.0-169.254.255.255', '172.16.0.0-172.31.255.255', '192.168.0.0-192.168.255.255',
              '100.64.0.0-100.127.255.255', '224.0.0.0-255.255.255', '::1',
              'fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff']
    write(out / 'turnserver.conf', f'''listening-port=3478
tls-listening-port=5349
listening-ip={args.listen_ip}
relay-ip={args.listen_ip}
external-ip={args.public_ip}/{args.listen_ip}
min-port=49160
max-port=49200
realm={args.turn_domain}
server-name={args.turn_domain}
fingerprint
use-auth-secret
static-auth-secret={turn}
cert={cert}/fullchain.pem
pkey={cert}/privkey.pem
no-cli
no-tlsv1
no-tlsv1_1
no-dtls
no-multicast-peers
no-tcp-relay
user-quota=12
total-quota=24
max-bps=128000
bps-capacity=3072000
stale-nonce=600
no-software-attribute
log-file=stdout
simple-log
''' + ''.join(f'denied-peer-ip={value}\n' for value in denied))
    write(out / 'nginx.conf', f'''server {{
    listen 80;
    server_name {args.domain} {args.turn_domain};
    location ^~ /.well-known/acme-challenge/ {{ root /var/www/acme; }}
    location / {{ return 301 https://{args.domain}$request_uri; }}
}}
server {{
    listen 443 ssl;
    server_name {args.domain};
    ssl_certificate {cert}/fullchain.pem;
    ssl_certificate_key {cert}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    root /usr/share/nginx/html;
    client_max_body_size 32m;
    location ^~ /internal/ {{ return 404; }}
    location ^~ /api/v1/ {{
        proxy_pass http://127.0.0.1:16880;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 65s;
    }}
    location = /healthz {{ proxy_pass http://127.0.0.1:16880/healthz; }}
    location = /media/probe {{ proxy_pass http://127.0.0.1:16881/probe; }}
    location = /webrtc-probe/offer {{ proxy_pass http://127.0.0.1:16881/webrtc-probe/offer; }}
    location = /index.html {{ add_header Cache-Control "no-store" always; }}
    location / {{ try_files $uri $uri/ /index.html; }}
}}
''')
    logging = dict(driver='json-file', options={'max-size':'10m', 'max-file':'3'})
    def service(target, **kw):
        return dict(build=dict(context=str(ROOT), dockerfile='infra/Dockerfile', target=target),
                    image=f'vodog-{target}:local', network_mode='host',
                    logging=logging, **{'restart':'unless-stopped', **kw})
    data = f'{out}/data:/data'
    certs = '/etc/letsencrypt:/etc/letsencrypt:ro'
    services = dict(
        postgres=dict(image='postgres:16-bookworm', restart='unless-stopped', env_file=['postgres.env'],
                      ports=['127.0.0.1:5432:5432'], volumes=['postgres:/var/lib/postgresql/data'], logging=logging,
                      healthcheck=dict(test=['CMD-SHELL','pg_isready -U vodog -d vodog'], interval='5s', retries=20)),
        control=service('control', env_file=['control.env'], volumes=[data],
                        depends_on=dict(postgres=dict(condition='service_healthy')),
                        healthcheck=dict(test=['CMD','node','-e',"fetch('http://127.0.0.1:16880/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], interval='10s', retries=12)),
        media=service('media', env_file=['media.env'], volumes=[data]),
        turn=service('turn', volumes=[f'{out}/turnserver.conf:/etc/turnserver.conf:ro', certs]),
        web=service('web', volumes=[f'{out}/nginx.conf:/etc/nginx/conf.d/default.conf:ro', certs,
                                   '/var/www/vodog-acme:/var/www/acme:ro'],
                    depends_on=dict(control=dict(condition='service_healthy'))),
        voice=service('voice', profiles=['voice'], env_file=['voice.env'],
                      volumes=[f'{out}/ai-token:/run/ai-token:ro'],
                      depends_on=dict(control=dict(condition='service_healthy'))),
    )
    services['retention'] = service('retention', profiles=['maintenance'], restart='no')
    services['retention'].update(volumes=[data, f'{out}/control.env:/run/control.env:ro'],
        command=['report', '--env-file', '/run/control.env', '--root', '/data/recording-backups', '--no-remote'])
    services['seed'] = dict(image='vodog-control:local', network_mode='host', profiles=['setup'],
        env_file=['control.env', 'admin.env'], command=['node', 'dist/src/seed.js'],
        depends_on=dict(control=dict(condition='service_healthy')))
    write(out / 'compose.json', json.dumps(dict(name='vodog', services=services, volumes=dict(postgres={})), indent=2)+'\n')
    write(out / 'deployment.json', json.dumps(dict(domain=args.domain, turnDomain=args.turn_domain), indent=2)+'\n')
    print(f'Prepared {out}; no services started. Keep this directory private.')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--domain', type=domain, default='app.example.com')
    parser.add_argument('--turn-domain', type=domain, default='turn.example.com')
    parser.add_argument('--public-ip', type=ipv4, required=True)
    parser.add_argument('--listen-ip', type=ipv4, required=True, help='IPv4 assigned to the host interface')
    parser.add_argument('--output', type=Path, required=True, help='New directory outside checkout')
    prepare(parser.parse_args())

if __name__ == '__main__':
    main()
