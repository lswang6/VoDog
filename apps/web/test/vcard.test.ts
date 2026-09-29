import assert from 'node:assert/strict';
import test from 'node:test';
import {composeName, parseVCard} from '../src/vcard.ts';

const crlf = (lines: string[]) => lines.join('\r\n');

test('vCard 3.0 folded lines rejoin before the property is parsed', () => {
  const [contact] = parseVCard(
    crlf([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:张三',
      'NOTE:这是一段很长的备注，',
      ' 它被折行写在了两行里。',
      'ORG:云图科技;研发部',
      'UID:urn:uuid:9c1f-abc',
      'TEL;TYPE=CELL:202 555 0117',
      'END:VCARD',
    ]),
  );
  assert.ok(contact);
  assert.equal(contact.displayName, '张三');
  assert.equal(contact.notes, '这是一段很长的备注，它被折行写在了两行里。');
  assert.equal(contact.organization, '云图科技 · 研发部');
  assert.equal(contact.sourceContactId, 'urn:uuid:9c1f-abc');
  assert.deepEqual(contact.phones, [{rawNumber: '202 555 0117', label: 'mobile'}]);
});

test('every TEL is kept with its label and PREF decides the order', () => {
  const [contact] = parseVCard(
    crlf([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Jane Doe',
      'TEL;TYPE=HOME,VOICE:202-555-0199',
      'TEL;TYPE=CELL:+12025550111',
      'TEL;TYPE=WORK,FAX:202-555-0125',
      'TEL;TYPE=WORK;TYPE=PREF:+1 202 555 0120',
      'EMAIL;TYPE=INTERNET,WORK:jane@example.com',
      'EMAIL;TYPE=HOME:jane@home.example',
      'END:VCARD',
    ]),
  );
  assert.ok(contact);
  assert.deepEqual(contact.phones, [
    {rawNumber: '+1 202 555 0120', label: 'work'},
    {rawNumber: '202-555-0199', label: 'home'},
    {rawNumber: '+12025550111', label: 'mobile'},
    {rawNumber: '202-555-0125', label: 'fax'},
  ]);
  assert.deepEqual(contact.emails, [
    {address: 'jane@example.com', label: 'work'},
    {address: 'jane@home.example', label: 'home'},
  ]);
});

test('vCard 2.1 quoted-printable decodes with its charset across a soft line break', () => {
  const [contact] = parseVCard(
    crlf([
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E5=BC=A0;=E4=B8=89;;;',
      'NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E4=BD=A0=E5=A5=BD=',
      '=EF=BC=8C=E4=B8=96=E7=95=8C',
      'TEL;CELL;PREF:2025550111',
      'TEL;HOME:202-555-0124',
      'END:VCARD',
    ]),
  );
  assert.ok(contact);
  assert.equal(contact.familyName, '张');
  assert.equal(contact.givenName, '三');
  assert.equal(contact.displayName, '张三', 'a missing FN falls back to the composed N');
  assert.equal(contact.notes, '你好，世界');
  assert.deepEqual(contact.phones, [
    {rawNumber: '2025550111', label: 'mobile'},
    {rawNumber: '202-555-0124', label: 'home'},
  ]);
});

test('a quoted-printable semicolon stays inside its component instead of splitting the name', () => {
  const [contact] = parseVCard(
    crlf([
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Doe=3B Jr.;Jane;;;',
      'TEL;CELL:2025550113',
      'END:VCARD',
    ]),
  );
  assert.ok(contact);
  assert.equal(contact.familyName, 'Doe; Jr.');
  assert.equal(contact.displayName, 'Jane Doe; Jr.');
});

test('missing FN falls back to N, then ORG, then the first number', () => {
  const contacts = parseVCard(
    crlf([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Doe;Jane;Q;;',
      'TEL:+15550100',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'ORG:只有公司名有限公司',
      'TEL;TYPE=WORK:202-555-0198',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'TEL;TYPE=CELL:2025550109',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'NOTE:没有姓名也没有号码',
      'END:VCARD',
    ]),
  );
  assert.equal(contacts.length, 3, 'a card with neither name, phone nor email is dropped');
  assert.equal(contacts[0]!.displayName, 'Jane Q Doe');
  assert.equal(contacts[1]!.displayName, '只有公司名有限公司');
  assert.equal(contacts[2]!.displayName, '2025550109');
});

test('vCard 4.0 URI phone values, quoted type lists and PREF=1 are understood', () => {
  const [contact] = parseVCard(
    crlf([
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:李四',
      'item1.TEL;VALUE=uri;TYPE="voice,home";PREF=1:tel:+12025550117;ext=12',
      'TEL;VALUE=uri;TYPE="cell":tel:+12025550107',
      'ADR;TYPE=home:;;和平路 12 号;深圳市;广东省;518000;中国',
      'END:VCARD',
    ]),
  );
  assert.ok(contact);
  assert.deepEqual(contact.phones, [
    {rawNumber: '+12025550117', label: 'home'},
    {rawNumber: '+12025550107', label: 'mobile'},
  ]);
  assert.deepEqual(contact.addresses, [
    {
      street: '和平路 12 号',
      city: '深圳市',
      region: '广东省',
      postalCode: '518000',
      country: '中国',
      label: 'home',
      formatted: '中国广东省深圳市和平路 12 号518000',
    },
  ]);
});

test('escaped separators and newlines survive, latin addresses read street first', () => {
  const [contact] = parseVCard(
    crlf([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Acme\\, Inc.',
      'NOTE:line one\\nline two\\; still note',
      'ADR;TYPE=WORK:;Suite 5;1 Market St;San Francisco;CA;94103;USA',
      'END:VCARD',
    ]),
  );
  assert.ok(contact);
  assert.equal(contact.displayName, 'Acme, Inc.');
  assert.equal(contact.notes, 'line one\nline two; still note');
  assert.equal(contact.addresses[0]!.formatted, '1 Market St, Suite 5, San Francisco, CA, 94103, USA');
});

test('a truncated export still yields its last card and unknown properties are ignored', () => {
  const contacts = parseVCard(
    ['BEGIN:VCARD', 'VERSION:3.0', 'X-CUSTOM:ignored', 'PHOTO;ENCODING=B:AAAA=', 'FN:王五', 'TEL:2025550108'].join('\n'),
  );
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]!.displayName, '王五');
  assert.deepEqual(contacts[0]!.phones, [{rawNumber: '2025550108'}]);
  assert.deepEqual(contacts[0]!.emails, []);
  assert.deepEqual(contacts[0]!.addresses, []);
});

test('name composition joins CJK without a space and latin with one', () => {
  assert.equal(composeName('三', '张'), '张三');
  assert.equal(composeName('Jane', 'Doe'), 'Jane Doe');
  assert.equal(composeName('Jane', 'Doe', 'Q'), 'Jane Q Doe');
  assert.equal(composeName('', '张'), '张');
  assert.equal(composeName('', ''), '');
});

test('an empty file parses to no contacts instead of throwing', () => {
  assert.deepEqual(parseVCard(''), []);
  assert.deepEqual(parseVCard('not a vcard at all'), []);
});
