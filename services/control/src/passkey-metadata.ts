// S18 decision 7. Passkey列表元数据：AAGUID 名称表、客户端平台推断与展示名。
// AAGUID 取自社区 passkey-authenticator-aaguids 清单，仅保留常见厂商。
const AAGUID_NAMES: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud 钥匙串',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud 钥匙串（托管）',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google 密码管理器',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  'b5397666-4885-aa6b-cebf-e52262a439a2': 'Chromium 浏览器',
  '771b48fd-d3d4-4f74-9232-fc157ab0507a': 'Edge on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
  '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
  'f3809540-7f14-49c1-a8b3-8f813b225541': 'Enpass',
  'b78a0a55-6ef8-d246-a042-ba0f6d55050c': 'LastPass',
  '50726f74-6f6e-5061-7373-50726f746f6e': 'Proton Pass',
  'fdb141b2-5d84-443e-8a35-4698c205a502': 'KeePassXC',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  'de1e552d-db1d-4423-a619-566b625cdc84': 'RoboForm',
  'b35a26b2-8f6e-4697-ab1d-d44db4da28c6': 'Zoho Vault',
};
const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

export type PasskeyPlatform = 'web' | 'ios' | 'android' | 'macos' | null;
export type PasskeyRow = {
  id: Buffer | string; created_at: unknown; device_type: string | null; backed_up: boolean | null;
  transports: string[] | null; label: string | null; aaguid: string | null;
  client_platform: string | null; authenticator_attachment: string | null; last_used_at: unknown;
};
export type PasskeyItem = {
  id: string; createdAt: unknown; deviceType: string | null; backedUp: boolean;
  transports: string[] | null; label: string | null; aaguid: string | null;
  clientPlatform: string | null; authenticatorAttachment: string | null;
  lastUsedAt: unknown; displayName: string;
};

/** Lowercases a registration AAGUID and treats the all-zero placeholder as absent. */
export function normalizeAaguid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const aaguid = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(aaguid)) return null;
  return aaguid === ZERO_AAGUID ? null : aaguid;
}

export function aaguidName(aaguid: unknown): string | null {
  const normalized = normalizeAaguid(aaguid);
  return normalized ? AAGUID_NAMES[normalized] ?? null : null;
}

function browserName(userAgent: string): string | null {
  if (/\bEdg(?:e|A|iOS)?\//.test(userAgent)) return 'Edge';
  if (/\b(?:OPR|Opera)\//.test(userAgent)) return 'Opera';
  if (/\b(?:CriOS|Chrome|Chromium)\//.test(userAgent)) return 'Chrome';
  if (/\b(?:FxiOS|Firefox)\//.test(userAgent)) return 'Firefox';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return null;
}
function osName(userAgent: string): string | null {
  if (/iPad/.test(userAgent)) return 'iPadOS';
  if (/iPhone|iPod/.test(userAgent)) return 'iOS';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'macOS';
  if (/Windows/.test(userAgent)) return 'Windows';
  if (/Linux|X11|CrOS/.test(userAgent)) return 'Linux';
  return null;
}

/** Native clients name themselves; browsers are inferred from the User-Agent only. */
export function clientPlatformLabel(platform: PasskeyPlatform | string | undefined, userAgent?: unknown): string | null {
  if (platform === 'ios') return 'iOS App';
  if (platform === 'android') return 'Android App';
  if (platform === 'macos') return 'macOS App';
  if (platform !== 'web') return null;
  const ua = typeof userAgent === 'string' ? userAgent : '';
  const browser = browserName(ua), os = osName(ua);
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? '浏览器';
}

export function passkeyDisplayName(input: {
  label?: string | null; aaguid?: string | null; clientPlatform?: string | null; authenticatorAttachment?: string | null;
}): string {
  const label = input.label?.trim();
  return (label || null) ?? aaguidName(input.aaguid) ?? input.clientPlatform ?? 'Passkey';
}

/** Never exposes public_key or counter. */
export function toPasskeyItem(row: PasskeyRow): PasskeyItem {
  const id = Buffer.isBuffer(row.id) ? row.id.toString('base64url') : Buffer.from(String(row.id), 'base64').toString('base64url');
  const item = {
    id,
    createdAt: row.created_at,
    deviceType: row.device_type ?? null,
    backedUp: Boolean(row.backed_up),
    transports: row.transports ?? null,
    label: row.label ?? null,
    aaguid: row.aaguid ?? null,
    clientPlatform: row.client_platform ?? null,
    authenticatorAttachment: row.authenticator_attachment ?? null,
    lastUsedAt: row.last_used_at ?? null,
  };
  return { ...item, displayName: passkeyDisplayName(item) };
}
