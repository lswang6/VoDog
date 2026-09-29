/**
 * Dependency-free vCard reader for 通讯录 import (S21 §A/§F).
 *
 * Handles the three versions that phone exports actually produce:
 *  - 2.1: bare type parameters (`TEL;CELL;PREF:`), `ENCODING=QUOTED-PRINTABLE` with `CHARSET=`,
 *    and soft line breaks (a trailing `=`) that are *not* space-prefixed continuations.
 *  - 3.0: `TYPE=CELL,VOICE`, RFC 2425 folding (continuation lines start with a space or tab).
 *  - 4.0: quoted parameter lists (`TYPE="cell,voice"`), `PREF=1`, and `VALUE=uri` phone values (`tel:+86…`).
 *
 * The parser deliberately does no de-duplication: S21 架构决策 2 makes the server the only authority on
 * matching and merging, so every card in the file is uploaded as-is.
 */

export type VCardPhone = {rawNumber: string; label?: string};
export type VCardEmail = {address: string; label?: string};
export type VCardAddress = {
  formatted?: string;
  label?: string;
  street?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
};

/** One parsed card, already shaped like an entry of the `POST /contacts/import` body. */
export type VCardContact = {
  sourceContactId?: string;
  displayName: string;
  givenName?: string;
  familyName?: string;
  organization?: string;
  notes?: string;
  phones: VCardPhone[];
  emails: VCardEmail[];
  addresses: VCardAddress[];
};

type Property = {name: string; params: Record<string, string[]>; value: string};

const CJK_NAME = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Checked before folding so a 2.1 soft break is never mistaken for the next property. */
const QUOTED_PRINTABLE_HEADER = /^[^:"]*;[^:"]*ENCODING=(?:QUOTED-PRINTABLE|QP)/i;

/** Splits on a separator that sits outside double quotes (parameter lists). */
function splitUnquoted(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const character of text) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === separator && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/** Splits a property value on unescaped separators, keeping `\;` and `\,` as literal characters. */
function splitComponents(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === '\\' && index + 1 < value.length) {
      current += character + value[index + 1];
      index++;
      continue;
    }
    if (character === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function unescapeText(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character !== '\\' || index + 1 >= value.length) {
      result += character;
      continue;
    }
    const next = value[++index]!;
    result += next === 'n' || next === 'N' ? '\n' : next;
  }
  return result;
}

function decodeQuotedPrintable(value: string, charset: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === '=' && /^[0-9a-fA-F]{2}$/.test(value.slice(index + 1, index + 3))) {
      bytes.push(parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    // Anything that is not a valid escape stays as its own UTF-8 bytes.
    for (const byte of new TextEncoder().encode(character)) bytes.push(byte);
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  }
}

/**
 * Turns physical lines into logical ones.
 *
 * Quoted-printable soft breaks are joined before RFC 2425 folding because a 2.1 continuation line has no
 * leading whitespace: checking folding first would swallow the `=` and split the multi-byte character.
 */
function logicalLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const previous = lines.length ? lines[lines.length - 1]! : '';
    if (lines.length && previous.endsWith('=') && QUOTED_PRINTABLE_HEADER.test(previous)) {
      lines[lines.length - 1] = previous.slice(0, -1) + raw;
      continue;
    }
    if (lines.length && /^[ \t]/.test(raw)) {
      lines[lines.length - 1] = previous + raw.slice(1);
      continue;
    }
    lines.push(raw);
  }
  return lines;
}

function parseProperty(line: string): Property | null {
  let colon = -1;
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;
    if (character === '"') quoted = !quoted;
    else if (character === ':' && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon < 0) return null;
  const head = splitUnquoted(line.slice(0, colon), ';');
  const rawName = (head.shift() || '').trim();
  if (!rawName) return null;
  // `item1.TEL` style grouping carries no meaning for us.
  const name = rawName.slice(rawName.lastIndexOf('.') + 1).toUpperCase();
  const params: Record<string, string[]> = {};
  for (const token of head) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf('=');
    // vCard 2.1 writes bare parameters, which are always type tokens.
    const key = equals < 0 ? 'TYPE' : trimmed.slice(0, equals).trim().toUpperCase();
    const raw = equals < 0 ? trimmed : trimmed.slice(equals + 1);
    const values = splitUnquoted(raw, ',').map(part => part.trim()).filter(Boolean);
    params[key] = [...(params[key] || []), ...values];
  }
  return {name, params, value: line.slice(colon + 1)};
}

function propertyCharset(property: Property): string {
  return property.params.CHARSET?.[0] || 'utf-8';
}

function isQuotedPrintable(property: Property): boolean {
  return (property.params.ENCODING || []).some(value => /^(QUOTED-PRINTABLE|QP)$/i.test(value));
}

/** Decodes one value component; quoted-printable is decoded per component so an encoded `;` stays literal. */
function decodeComponent(property: Property, component: string): string {
  return isQuotedPrintable(property)
    ? decodeQuotedPrintable(component, propertyCharset(property))
    : unescapeText(component);
}

function components(property: Property): string[] {
  return splitComponents(property.value, ';').map(component => decodeComponent(property, component).trim());
}

function singleValue(property: Property): string {
  return decodeComponent(property, property.value).trim();
}

function types(property: Property): string[] {
  return (property.params.TYPE || []).map(value => value.toUpperCase());
}

function isPreferred(property: Property): boolean {
  if (types(property).includes('PREF')) return true;
  const pref = property.params.PREF;
  return Array.isArray(pref) && (pref.length === 0 || pref[0] !== '0');
}

const PHONE_LABELS: [string, string][] = [
  ['FAX', 'fax'],
  ['CELL', 'mobile'],
  ['MOBILE', 'mobile'],
  ['IPHONE', 'mobile'],
  ['MAIN', 'main'],
  ['PAGER', 'pager'],
  ['HOME', 'home'],
  ['WORK', 'work'],
  ['OTHER', 'other'],
];

function phoneLabel(property: Property): string | undefined {
  const list = types(property);
  for (const [token, label] of PHONE_LABELS) if (list.includes(token)) return label;
  return undefined;
}

function plainLabel(property: Property): string | undefined {
  const list = types(property);
  if (list.includes('HOME')) return 'home';
  if (list.includes('WORK')) return 'work';
  if (list.includes('OTHER')) return 'other';
  return undefined;
}

/** `TEL;VALUE=uri:tel:+12025550117;ext=12` carries a URI, not a dial string. */
function phoneNumber(property: Property): string {
  const value = singleValue(property);
  if (!/^tel:/i.test(value)) return value;
  const [number = ''] = value.slice(4).split(';');
  return number.trim();
}

/** 张/三 reads as 张三, while Jane/Doe reads as Jane Doe. */
export function composeName(given: string, family: string, middle = ''): string {
  const parts = [given, middle, family].map(part => part.trim());
  if (!parts.some(Boolean)) return '';
  if (CJK_NAME.test(family) || CJK_NAME.test(given)) return parts.filter(Boolean).reverse().join('');
  return [parts[0], parts[1], parts[2]].filter(Boolean).join(' ');
}

/** Chinese addresses read country-first without separators; latin ones read street-first with commas. */
function formatAddress(address: VCardAddress, extended: string): string {
  const fields = [address.street, extended, address.city, address.region, address.postalCode, address.country];
  if (fields.some(part => part && CJK_NAME.test(part))) {
    return [address.country, address.region, address.city, address.street, extended, address.postalCode]
      .map(part => (part || '').trim())
      .filter(Boolean)
      .join('');
  }
  return fields.map(part => (part || '').trim()).filter(Boolean).join(', ');
}

function finishCard(properties: Property[]): VCardContact | null {
  const contact: VCardContact = {displayName: '', phones: [], emails: [], addresses: []};
  const preferredPhones: VCardPhone[] = [];
  let formatted = '';
  let composed = '';
  for (const property of properties) {
    switch (property.name) {
      case 'FN':
        formatted = formatted || singleValue(property);
        break;
      case 'N': {
        const [family = '', given = '', middle = ''] = components(property);
        if (family) contact.familyName = family;
        if (given) contact.givenName = given;
        composed = composed || composeName(given, family, middle);
        break;
      }
      case 'TEL': {
        const rawNumber = phoneNumber(property);
        if (!rawNumber) break;
        const label = phoneLabel(property);
        const phone: VCardPhone = label ? {rawNumber, label} : {rawNumber};
        (isPreferred(property) ? preferredPhones : contact.phones).push(phone);
        break;
      }
      case 'EMAIL': {
        const address = singleValue(property);
        if (!address) break;
        const label = plainLabel(property);
        contact.emails.push(label ? {address, label} : {address});
        break;
      }
      case 'ADR': {
        const [, extended = '', street = '', city = '', region = '', postalCode = '', country = ''] =
          components(property);
        const address: VCardAddress = {};
        if (street) address.street = street;
        if (city) address.city = city;
        if (region) address.region = region;
        if (postalCode) address.postalCode = postalCode;
        if (country) address.country = country;
        const label = plainLabel(property);
        if (label) address.label = label;
        const text = formatAddress(address, extended);
        if (text) address.formatted = text;
        if (Object.keys(address).length) contact.addresses.push(address);
        break;
      }
      case 'ORG': {
        const organization = components(property).filter(Boolean).join(' · ');
        if (organization) contact.organization = organization;
        break;
      }
      case 'NOTE': {
        const notes = singleValue(property);
        if (notes) contact.notes = notes;
        break;
      }
      case 'UID': {
        const uid = singleValue(property);
        if (uid) contact.sourceContactId = uid;
        break;
      }
      default:
        break;
    }
  }
  // The import body has no primary flag, so PREF is expressed as list order.
  contact.phones = [...preferredPhones, ...contact.phones];
  contact.displayName =
    formatted ||
    composed ||
    contact.organization ||
    contact.phones[0]?.rawNumber ||
    contact.emails[0]?.address ||
    '';
  return contact.displayName ? contact : null;
}

/** Parses a `.vcf` file into contacts ready for `POST /api/v1/contacts/import`. */
export function parseVCard(text: string): VCardContact[] {
  const contacts: VCardContact[] = [];
  let open: Property[] | null = null;
  const flush = () => {
    if (!open) return;
    const contact = finishCard(open);
    if (contact) contacts.push(contact);
    open = null;
  };
  for (const line of logicalLines(text)) {
    if (!line.trim()) continue;
    const property = parseProperty(line);
    if (!property) continue;
    if (property.name === 'BEGIN' && /VCARD/i.test(property.value)) {
      flush();
      open = [];
      continue;
    }
    if (property.name === 'END' && /VCARD/i.test(property.value)) {
      flush();
      continue;
    }
    if (open) open.push(property);
  }
  // A truncated export without the final END:VCARD still yields its last contact.
  flush();
  return contacts;
}
