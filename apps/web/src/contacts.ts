/**
 * 通讯录 contract types and presentation helpers (S21 §A/§F).
 *
 * `contactId`/`contactName`/`blocked`/`blockedEntryId` are optional everywhere: during the staged rollout an
 * older Control returns call, SMS and blocklist rows without them, and the UI must simply omit the extras
 * rather than render "undefined" or claim a number is unblocked-by-decision.
 */
import type {VCardContact} from './vcard.ts';

export type ContactPhoneDto = {
  id?: string;
  rawNumber: string;
  e164?: string | null;
  canonicalKey?: string | null;
  label?: string | null;
  isPrimary?: boolean;
  /** Per-number blocklist state; absent on an older Control. */
  blocked?: boolean;
  blockedEntryId?: string | null;
};
export type ContactEmailDto = {id?: string; address: string; label?: string | null};
export type ContactAddressDto = {
  id?: string;
  formatted?: string | null;
  label?: string | null;
  street?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
};
export type ContactDto = {
  id: string;
  /** S32 optimistic-concurrency token. Older servers omit it, which reads as version 1. */
  version?: number;
  displayName: string;
  givenName?: string | null;
  familyName?: string | null;
  organization?: string | null;
  notes?: string | null;
  source?: string;
  phones?: ContactPhoneDto[];
  emails?: ContactEmailDto[];
  addresses?: ContactAddressDto[];
  blocked?: boolean;
  /** Contact-level blocklist entry; the phone-level one wins when the card is about a specific number. */
  blockedEntryId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

/** The four columns every enriched DTO may carry. */
export type ContactAnnotated = {
  contactId?: string | null;
  contactName?: string | null;
  blocked?: boolean;
  blockedEntryId?: string | null;
};

/** The `api()` wrapper from `main.tsx`, injected so every panel keeps its cookie and 401 handling. */
export type ApiRequest = <T>(path: string, body?: unknown, method?: string, options?: {idempotencyKey?: string}) => Promise<T>;

export type ContactImportEntry = VCardContact;
export type ContactImportSource = 'web_vcard' | 'web_picker' | 'manual';
export type ContactImportSummary = {
  total: number;
  created: number;
  updated: number;
  merged: number;
  skipped: number;
  phonesSkipped: number;
};

/** §A caps one import request at 2000 contacts and 4 MB; 500 keeps both limits comfortable. */
export const MAX_IMPORT_BATCH = 2000;
export const IMPORT_BATCH_SIZE = 500;

export function importBatches(
  contacts: readonly ContactImportEntry[],
  size: number = IMPORT_BATCH_SIZE,
): ContactImportEntry[][] {
  const limit = Math.max(1, Math.min(Math.floor(size) || 1, MAX_IMPORT_BATCH));
  const batches: ContactImportEntry[][] = [];
  for (let index = 0; index < contacts.length; index += limit) {
    batches.push(contacts.slice(index, index + limit));
  }
  return batches;
}

export function emptyImportSummary(): ContactImportSummary {
  return {total: 0, created: 0, updated: 0, merged: 0, skipped: 0, phonesSkipped: 0};
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Chunked imports report one combined summary; an old server that omits a counter contributes zero. */
export function addImportSummary(
  base: ContactImportSummary,
  next: Partial<ContactImportSummary> | null | undefined,
): ContactImportSummary {
  return {
    total: base.total + count(next?.total),
    created: base.created + count(next?.created),
    updated: base.updated + count(next?.updated),
    merged: base.merged + count(next?.merged),
    skipped: base.skipped + count(next?.skipped),
    phonesSkipped: base.phonesSkipped + count(next?.phonesSkipped),
  };
}

export function importSummaryText(summary: ContactImportSummary): string {
  const parts = [
    `共 ${summary.total} 条`,
    `新增 ${summary.created}`,
    `更新 ${summary.updated}`,
    `合并 ${summary.merged}`,
    `跳过 ${summary.skipped}`,
  ];
  if (summary.phonesSkipped > 0) parts.push(`忽略号码 ${summary.phonesSkipped}`);
  return parts.join(' · ');
}

const PHONE_LABELS: Record<string, string> = {
  mobile: '手机',
  home: '住宅',
  work: '工作',
  main: '主要',
  fax: '传真',
  pager: '寻呼',
  other: '其他',
};

export function phoneLabelText(label?: string | null): string {
  if (!label) return '电话';
  return PHONE_LABELS[label.toLowerCase()] || label;
}

export function emailLabelText(label?: string | null): string {
  if (!label) return '邮箱';
  return PHONE_LABELS[label.toLowerCase()] || label;
}

export function contactPrimaryPhone(contact: ContactDto | null | undefined): ContactPhoneDto | null {
  const phones = contact?.phones || [];
  return phones.find(phone => phone.isPrimary) || phones[0] || null;
}

export function contactPrimaryNumber(contact: ContactDto | null | undefined): string {
  const phone = contactPrimaryPhone(contact);
  return phone?.e164 || phone?.rawNumber || '';
}

/** `186…1768 · 张三` for a known contact, bare number otherwise (§F 通话记录行). */
export function numberWithContact(
  remoteNumber: string | null | undefined,
  contactName?: string | null,
  fallback = '未知号码',
): string {
  const number = (remoteNumber || '').trim();
  const name = (contactName || '').trim();
  if (!number) return name || fallback;
  return name ? `${number} · ${name}` : number;
}

/**
 * A row counts as blocked when the server says so, or when it handed back the entry id used to unblock.
 * §B's interception shape omits `blocked`, so the entry id is the only signal there.
 */
export function isBlockedRow(row: ContactAnnotated | null | undefined): boolean {
  if (!row) return false;
  if (typeof row.blocked === 'boolean') return row.blocked;
  return Boolean(row.blockedEntryId);
}

function phoneDigits(value: string | null | undefined): string {
  return (value || '').replace(/\D/g, '');
}

/**
 * Whether two phone strings name the same line.
 *
 * This is not the server's `phoneMatchKeys` matching (架构决策 2 keeps that on Control) — it only decides which
 * of one contact's own phones the card is currently showing, so a shared national-number suffix is enough to
 * line up `202 555 0117`, `+12025550117` and `2025550117`.
 */
export function samePhoneNumber(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = phoneDigits(left);
  const b = phoneDigits(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  // A country code on one side only; below 7 digits a suffix match would be a coincidence.
  return shorter.length >= 7 && longer.endsWith(shorter);
}

export type ContactBlockState = {blocked: boolean; blockedEntryId: string | null};
const NOT_BLOCKED: ContactBlockState = {blocked: false, blockedEntryId: null};

export function contactPhoneFor(
  contact: ContactDto | null | undefined,
  remoteNumber: string | null | undefined,
): ContactPhoneDto | null {
  if (!contact || !remoteNumber) return null;
  return (
    (contact.phones || []).find(
      phone =>
        samePhoneNumber(phone.e164, remoteNumber) ||
        samePhoneNumber(phone.rawNumber, remoteNumber) ||
        samePhoneNumber(phone.canonicalKey, remoteNumber),
    ) || null
  );
}

/**
 * The blocklist entry a contact card may delete (S21 §A).
 *
 * The phone the card is about wins: a contact with one blocked number and one normal number must offer
 * 屏蔽此号码 on the normal one, not 解除屏蔽. Only when that phone says nothing does the contact-level entry
 * apply, and an older Control that sends neither leaves the card with no entry to delete.
 */
export function contactBlockEntry(
  contact: ContactDto | null | undefined,
  remoteNumber?: string | null,
): ContactBlockState {
  if (!contact) return NOT_BLOCKED;
  const phone = contactPhoneFor(contact, remoteNumber);
  if (phone && typeof phone.blocked === 'boolean') {
    return phone.blocked
      ? {blocked: true, blockedEntryId: phone.blockedEntryId || contact.blockedEntryId || null}
      : NOT_BLOCKED;
  }
  if (phone?.blockedEntryId) return {blocked: true, blockedEntryId: phone.blockedEntryId};
  const blocked = contact.blocked ?? Boolean(contact.blockedEntryId);
  return blocked ? {blocked: true, blockedEntryId: contact.blockedEntryId || null} : NOT_BLOCKED;
}

export type ContactCardActions = {
  canCall: boolean;
  canSms: boolean;
  canBlock: boolean;
  canUnblock: boolean;
  canCreateContact: boolean;
  canAttachToContact: boolean;
  blockLabel: string;
};

const DIAL_CHARACTERS = new Set('0123456789*#+');
function dialDigits(value: string): string {
  let result = '';
  for (const character of value.trim()) if (DIAL_CHARACTERS.has(character)) result += character;
  return result;
}

/**
 * Which actions a contact card may offer (§F).
 *
 * Calling needs a usable SIM and no live media; blocking never applies to emergency numbers; unblocking is
 * only possible when the server told us which blocklist entry to delete.
 */
export function contactCardActions(input: {
  remoteNumber?: string | null;
  simId?: string | null;
  mediaLive?: boolean;
  blocked?: boolean;
  blockedEntryId?: string | null;
  contactId?: string | null;
}): ContactCardActions {
  const number = dialDigits(input.remoteNumber || '');
  const digits = number.replace(/\D/g, '');
  const emergency = digits === '112' || digits === '911';
  const hasNumber = Boolean(number);
  const blocked = isBlockedRow(input);
  return {
    canCall: hasNumber && Boolean(input.simId) && !input.mediaLive,
    canSms: hasNumber && Boolean(input.simId),
    canBlock: hasNumber && !emergency && !blocked,
    canUnblock: blocked,
    canCreateContact: hasNumber && !input.contactId,
    canAttachToContact: hasNumber && !input.contactId,
    blockLabel: blocked ? '解除屏蔽' : '屏蔽此号码',
  };
}

export const CONTACT_BLOCK_PROMPT =
  '屏蔽此号码的来电？屏蔽后，该号码的来电会被直接挂断并记在拦截记录里，短信不受影响。';
export const CONTACT_UNBLOCK_PROMPT = '解除屏蔽？该号码之后可以正常呼入。';
export const CONTACT_DELETE_PROMPT = '删除此联系人？通话与短信记录会保留，只是不再显示姓名。';
export const CONTACT_CALL_PROMPT = '拨打此号码？将使用当前所选 SIM 拨出。';

/** `GET /contacts` path with the server-side search applied (§A). */
export function contactsPath(query: string, limit = 200): string {
  const trimmed = query.trim();
  return `/contacts?limit=${limit}${trimmed ? `&query=${encodeURIComponent(trimmed)}` : ''}`;
}

export type ContactDraft = {
  version: number;
  displayName: string;
  givenName: string;
  familyName: string;
  organization: string;
  notes: string;
  phones: {rawNumber: string; label: string}[];
  emails: {address: string; label: string}[];
  addresses: {
    formatted: string;
    label: string;
    street: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
  }[];
};

export function emptyContactDraft(number = ''): ContactDraft {
  return {
    version: 1,
    displayName: '',
    givenName: '',
    familyName: '',
    organization: '',
    notes: '',
    phones: [{rawNumber: number, label: ''}],
    emails: [{address: '', label: ''}],
    addresses: [],
  };
}

export function contactVersion(contact: ContactDto | null | undefined): number {
  return Number.isInteger(contact?.version) && Number(contact?.version) > 0 ? Number(contact?.version) : 1;
}

export function contactDraftFrom(contact: ContactDto): ContactDraft {
  return {
    version: contactVersion(contact),
    displayName: contact.displayName || '',
    givenName: contact.givenName || '',
    familyName: contact.familyName || '',
    organization: contact.organization || '',
    notes: contact.notes || '',
    phones: (contact.phones || []).map(phone => ({rawNumber: phone.rawNumber || '', label: phone.label || ''})),
    emails: (contact.emails || []).map(email => ({address: email.address || '', label: email.label || ''})),
    addresses: (contact.addresses || []).map(address => ({
      formatted: address.formatted || '',
      label: address.label || '',
      street: address.street || '',
      city: address.city || '',
      region: address.region || '',
      postalCode: address.postalCode || '',
      country: address.country || '',
    })),
  };
}

/** §A requires a name plus at least one phone or email before the server will accept the contact. */
export function contactDraftError(draft: ContactDraft): string {
  if (!draft.displayName.trim()) return '请填写联系人姓名';
  const phones = draft.phones.filter(value => value.rawNumber.trim());
  const emails = draft.emails.filter(value => value.address.trim());
  if (!phones.length && !emails.length) return '请至少填写一个电话或邮箱';
  return '';
}

export function contactDraftBody(draft: ContactDraft): {
  displayName: string;
  givenName?: string;
  familyName?: string;
  organization?: string;
  notes?: string;
  phones: {rawNumber: string; label?: string}[];
  emails: {address: string; label?: string}[];
  addresses: Omit<ContactAddressDto, 'id'>[];
} {
  return {
    displayName: draft.displayName.trim(),
    ...(draft.givenName.trim() ? {givenName: draft.givenName.trim()} : {}),
    ...(draft.familyName.trim() ? {familyName: draft.familyName.trim()} : {}),
    ...(draft.organization.trim() ? {organization: draft.organization.trim()} : {}),
    ...(draft.notes.trim() ? {notes: draft.notes.trim()} : {}),
    phones: draft.phones
      .map(phone => ({rawNumber: phone.rawNumber.trim(), label: phone.label.trim()}))
      .filter(phone => Boolean(phone.rawNumber))
      .map(phone => ({rawNumber: phone.rawNumber, ...(phone.label ? {label: phone.label} : {})})),
    emails: draft.emails
      .map(email => ({address: email.address.trim(), label: email.label.trim()}))
      .filter(email => Boolean(email.address))
      .map(email => ({address: email.address, ...(email.label ? {label: email.label} : {})})),
    addresses: draft.addresses.map(address => {
      const values = Object.fromEntries(
        Object.entries(address).map(([key, value]) => [key, value.trim()]).filter(([, value]) => Boolean(value)),
      );
      return values as Omit<ContactAddressDto, 'id'>;
    }).filter(address => Object.keys(address).length > 0),
  };
}

/** Shape handed back by the Contact Picker API (Android Chrome). */
export type PickedContact = {
  name?: string[];
  tel?: string[];
  email?: string[];
  address?: {
    addressLine?: string[];
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
  }[];
};

export function pickedContactsToImport(picked: readonly PickedContact[]): ContactImportEntry[] {
  const contacts: ContactImportEntry[] = [];
  for (const item of picked) {
    const phones = (item.tel || []).map(value => String(value).trim()).filter(Boolean);
    const emails = (item.email || []).map(value => String(value).trim()).filter(Boolean);
    const displayName = (item.name || []).map(value => String(value).trim()).find(Boolean) || phones[0] || emails[0] || '';
    if (!displayName) continue;
    contacts.push({
      displayName,
      phones: phones.map(rawNumber => ({rawNumber})),
      emails: emails.map(address => ({address})),
      addresses: (item.address || []).map(address => {
        const formatted = [...(address.addressLine || []), address.city, address.region, address.country]
          .map(part => (part || '').trim())
          .filter(Boolean)
          .join(' ');
        return {
          ...(formatted ? {formatted} : {}),
          ...(address.city ? {city: address.city} : {}),
          ...(address.region ? {region: address.region} : {}),
          ...(address.postalCode ? {postalCode: address.postalCode} : {}),
          ...(address.country ? {country: address.country} : {}),
        };
      }),
    });
  }
  return contacts;
}

/** The Contact Picker only exists on Android Chrome, so the .vcf input stays the universal path. */
export function contactPickerSupported(scope: {navigator?: unknown} = globalThis): boolean {
  const navigatorLike = scope.navigator as {contacts?: {select?: unknown}} | undefined;
  return typeof navigatorLike?.contacts?.select === 'function';
}
