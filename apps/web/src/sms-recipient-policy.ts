import {type ContactDto} from './contacts.ts';

export type SmsRecipient = {number: string; name?: string; label?: string};
export function normalizeSmsNumber(value: string): string {
  const trimmed = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return '';
  const compact = trimmed.replace(/[\s().-]/g, '');
  return /^\+?\d{1,20}$/.test(compact) ? compact : '';
}
export function sameSmsRecipient(left: string, right: string): boolean {
  const number = normalizeSmsNumber(left);
  return !!number && number === normalizeSmsNumber(right);
}
export function uniqueSmsRecipients(values: readonly SmsRecipient[]): SmsRecipient[] {
  const result: SmsRecipient[] = [];
  for (const value of values) {
    const number = normalizeSmsNumber(value.number);
    if (number && !result.some(item => sameSmsRecipient(item.number, number))) result.push({...value, number});
  }
  return result;
}
export function startSmsRecipients(explicitNumber?: string, name?: string): SmsRecipient[] {
  return explicitNumber ? uniqueSmsRecipients([{number: explicitNumber, name}]) : [];
}
export function smsContactNumbers(contact: ContactDto): SmsRecipient[] {
  return uniqueSmsRecipients((contact.phones || []).map(phone => ({number: phone.e164 || phone.rawNumber, name: contact.displayName, label: phone.label || undefined})));
}
export function matchesSmsContact(contact: ContactDto, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [contact.displayName, contact.organization, ...(contact.phones || []).flatMap(phone => [phone.rawNumber, phone.e164])]
    .some(value => value?.toLocaleLowerCase().includes(needle) || (!!normalizeSmsNumber(needle) && normalizeSmsNumber(value || '').includes(normalizeSmsNumber(needle))));
}
