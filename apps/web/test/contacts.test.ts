import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTACT_BLOCK_PROMPT,
  CONTACT_UNBLOCK_PROMPT,
  IMPORT_BATCH_SIZE,
  MAX_IMPORT_BATCH,
  addImportSummary,
  contactBlockEntry,
  contactCardActions,
  contactDraftBody,
  contactDraftError,
  contactDraftFrom,
  contactPhoneFor,
  contactPickerSupported,
  contactPrimaryNumber,
  contactsPath,
  emptyContactDraft,
  emptyImportSummary,
  importBatches,
  importSummaryText,
  isBlockedRow,
  numberWithContact,
  phoneLabelText,
  pickedContactsToImport,
  samePhoneNumber,
  type ContactDto,
  type ContactImportEntry,
} from '../src/contacts.ts';

const entry = (n: number): ContactImportEntry => ({
  displayName: `联系人 ${n}`,
  phones: [{rawNumber: `1380013${String(n).padStart(4, '0')}`}],
  emails: [],
  addresses: [],
});

test('imports are chunked below the 2000 contact ceiling and never lose a contact', () => {
  const contacts = Array.from({length: 1201}, (_value, index) => entry(index));
  const batches = importBatches(contacts);
  assert.equal(IMPORT_BATCH_SIZE, 500);
  assert.deepEqual(batches.map(batch => batch.length), [500, 500, 201]);
  assert.equal(batches.flat().length, contacts.length);
  assert.deepEqual(importBatches([]), []);
  const huge = Array.from({length: 2500}, (_value, index) => entry(index));
  assert.deepEqual(
    importBatches(huge, 10_000).map(batch => batch.length),
    [MAX_IMPORT_BATCH, 500],
    'a silly size is clamped to the contract cap',
  );
  assert.equal(importBatches(contacts, 0)[0]!.length, 1, 'a zero size still makes progress');
});

test('chunked import summaries add up and tolerate a server that omits a counter', () => {
  let summary = emptyImportSummary();
  summary = addImportSummary(summary, {total: 500, created: 400, updated: 60, merged: 40, skipped: 0, phonesSkipped: 3});
  summary = addImportSummary(summary, {total: 200, created: 10, merged: 5});
  summary = addImportSummary(summary, null);
  assert.deepEqual(summary, {total: 700, created: 410, updated: 60, merged: 45, skipped: 0, phonesSkipped: 3});
  assert.equal(importSummaryText(summary), '共 700 条 · 新增 410 · 更新 60 · 合并 45 · 跳过 0 · 忽略号码 3');
  assert.equal(
    importSummaryText(emptyImportSummary()),
    '共 0 条 · 新增 0 · 更新 0 · 合并 0 · 跳过 0',
    'no skipped numbers means no extra clause',
  );
});

test('a record line shows 号码 · 姓名 only when the server sent a contact name', () => {
  assert.equal(numberWithContact('2025550117', '张三'), '2025550117 · 张三');
  assert.equal(numberWithContact('2025550117', null), '2025550117', 'an old server omits contactName');
  assert.equal(numberWithContact('2025550117', undefined), '2025550117');
  assert.equal(numberWithContact('2025550117', '  '), '2025550117');
  assert.equal(numberWithContact('', '张三'), '张三');
  assert.equal(numberWithContact(undefined, undefined), '未知号码');
  assert.equal(numberWithContact(null, null, '拦截号码'), '拦截号码');
});

test('blocked state falls back to the entry id when the server omits the flag', () => {
  assert.equal(isBlockedRow({blocked: true}), true);
  assert.equal(isBlockedRow({blocked: false, blockedEntryId: 'entry-1'}), false, 'an explicit false wins');
  assert.equal(isBlockedRow({blockedEntryId: 'entry-1'}), true);
  assert.equal(isBlockedRow({}), false, 'an old server that sends neither field is not blocked');
  assert.equal(isBlockedRow(undefined), false);
  assert.equal(isBlockedRow(null), false);
});

test('contact card actions follow the call, block and unblock policy', () => {
  const base = {remoteNumber: '2025550117', simId: 'sim-1'};
  const idle = contactCardActions(base);
  assert.equal(idle.canCall, true);
  assert.equal(idle.canSms, true);
  assert.equal(idle.canBlock, true);
  assert.equal(idle.canUnblock, false);
  assert.equal(idle.blockLabel, '屏蔽此号码');
  assert.equal(idle.canCreateContact, true);
  assert.equal(idle.canAttachToContact, true);

  assert.equal(contactCardActions({...base, mediaLive: true}).canCall, false, 'no second call from this browser');
  assert.equal(contactCardActions({...base, mediaLive: true}).canSms, true);
  assert.equal(contactCardActions({remoteNumber: '2025550117'}).canCall, false, 'a record without a SIM cannot dial');
  assert.equal(contactCardActions({...base, remoteNumber: '112'}).canBlock, false, 'emergency numbers are never blocked');
  assert.equal(contactCardActions({...base, remoteNumber: '911'}).canBlock, false);
  assert.equal(contactCardActions({...base, remoteNumber: ''}).canBlock, false);

  const blocked = contactCardActions({...base, blocked: true, blockedEntryId: 'entry-9'});
  assert.equal(blocked.canBlock, false);
  assert.equal(blocked.canUnblock, true);
  assert.equal(blocked.blockLabel, '解除屏蔽');

  const blockedWithoutEntry = contactCardActions({...base, blocked: true});
  assert.equal(blockedWithoutEntry.canUnblock, true, 'the card resolves a missing entry id from GET /blocklist');
  assert.equal(blockedWithoutEntry.canBlock, false, 'and re-blocking is pointless');

  const known = contactCardActions({...base, contactId: 'contact-1'});
  assert.equal(known.canCreateContact, false, 'a number that already has a contact only opens it');
  assert.equal(known.canAttachToContact, false);

  assert.match(CONTACT_BLOCK_PROMPT, /屏蔽后/);
  assert.match(CONTACT_UNBLOCK_PROMPT, /解除屏蔽/);
});

test('contact drafts require a name plus one reachable field before reaching the server', () => {
  assert.equal(contactDraftError(emptyContactDraft()), '请填写联系人姓名');
  assert.equal(contactDraftError({...emptyContactDraft(), displayName: '张三'}), '请至少填写一个电话或邮箱');
  assert.equal(contactDraftError({...emptyContactDraft('2025550117'), displayName: '张三'}), '');
  assert.equal(
    contactDraftError({...emptyContactDraft(), displayName: '张三', phones: [{rawNumber: '  ', label: ''}], emails: [{address: 'a@b.c', label: ''}]}),
    '',
  );
  assert.deepEqual(
    contactDraftBody({
      ...emptyContactDraft(),
      displayName: '  张三 ',
      organization: ' 云图 ',
      notes: '',
      phones: [{rawNumber: ' 202 555 0117 ', label: ''}, {rawNumber: '', label: ''}, {rawNumber: '  ', label: ''}],
      emails: [{address: 'a@b.c', label: ''}],
    }),
    {
      displayName: '张三',
      organization: '云图',
      phones: [{rawNumber: '202 555 0117'}],
      emails: [{address: 'a@b.c'}],
      addresses: [],
    },
  );
});

test('an existing contact fills the edit form and exposes its primary number', () => {
  const contact: ContactDto = {
    id: 'c-1',
    displayName: '张三',
    organization: '云图科技',
    phones: [
      {id: 'p-1', rawNumber: '202-555-0199', label: 'home'},
      {id: 'p-2', rawNumber: '202 555 0117', e164: '+12025550117', label: 'mobile', isPrimary: true},
    ],
    emails: [{id: 'e-1', address: 'a@b.c'}],
  };
  assert.equal(contactPrimaryNumber(contact), '+12025550117', 'the primary phone wins over list order');
  assert.equal(contactPrimaryNumber({id: 'c-2', displayName: '无号码'}), '');
  assert.equal(contactPrimaryNumber(null), '');
  assert.deepEqual(contactDraftFrom(contact), {
    version: 1,
    displayName: '张三',
    givenName: '',
    familyName: '',
    organization: '云图科技',
    notes: '',
    phones: [{rawNumber: '202-555-0199', label: 'home'}, {rawNumber: '202 555 0117', label: 'mobile'}],
    emails: [{address: 'a@b.c', label: ''}],
    addresses: [],
  });
  assert.equal(phoneLabelText('mobile'), '手机');
  assert.equal(phoneLabelText(null), '电话');
  assert.equal(phoneLabelText('school'), 'school', 'an unknown label is shown verbatim');
});

test('phone comparison lines up the same line written with or without a country code', () => {
  assert.equal(samePhoneNumber('202 555 0117', '+12025550117'), true);
  assert.equal(samePhoneNumber('+12025550117', '2025550117'), true);
  assert.equal(samePhoneNumber('2025550117', '2025550117'), true);
  assert.equal(samePhoneNumber('2025550117', '2025550118'), false);
  assert.equal(samePhoneNumber('202-555-0199', '2025550117'), false);
  assert.equal(samePhoneNumber('112', '112'), true);
  assert.equal(samePhoneNumber('1768', '2025550117'), false, 'a short suffix match would be a coincidence');
  assert.equal(samePhoneNumber('', '2025550117'), false);
  assert.equal(samePhoneNumber(null, undefined), false);
});

test('the card unblocks with the phone-level entry, and the contact-level one only as a fallback', () => {
  const blockedPhone: ContactDto = {
    id: 'c-1',
    displayName: '张三',
    blocked: true,
    blockedEntryId: 'entry-contact',
    phones: [
      {rawNumber: '202 555 0117', e164: '+12025550117', blocked: true, blockedEntryId: 'entry-mobile'},
      {rawNumber: '202-555-0199', blocked: false, blockedEntryId: null},
    ],
  };
  assert.deepEqual(contactBlockEntry(blockedPhone, '+12025550117'), {blocked: true, blockedEntryId: 'entry-mobile'});
  assert.deepEqual(
    contactBlockEntry(blockedPhone, '202-555-0199'),
    {blocked: false, blockedEntryId: null},
    'the other number of a partly blocked contact must still offer 屏蔽此号码',
  );
  assert.equal(contactPhoneFor(blockedPhone, '2025550117')?.blockedEntryId, 'entry-mobile');
  assert.equal(contactPhoneFor(blockedPhone, '2025550111'), null);

  // Phone-level blocked with no entry of its own falls back to the contact-level entry.
  assert.deepEqual(
    contactBlockEntry({id: 'c-2', displayName: '李四', blockedEntryId: 'entry-contact', phones: [{rawNumber: '2025550111', blocked: true}]}, '2025550111'),
    {blocked: true, blockedEntryId: 'entry-contact'},
  );
  // No matching phone: the contact-level entry applies.
  assert.deepEqual(
    contactBlockEntry({id: 'c-3', displayName: '王五', blocked: true, blockedEntryId: 'entry-contact'}, '2025550197'),
    {blocked: true, blockedEntryId: 'entry-contact'},
  );
  // An older Control sends neither level, so there is nothing to delete.
  assert.deepEqual(contactBlockEntry({id: 'c-4', displayName: '赵六', blocked: true}, '2025550111'), {
    blocked: true,
    blockedEntryId: null,
  });
  assert.deepEqual(contactBlockEntry({id: 'c-5', displayName: '钱七'}, '2025550111'), {blocked: false, blockedEntryId: null});
  assert.deepEqual(contactBlockEntry(null, '2025550111'), {blocked: false, blockedEntryId: null});
  // A phone entry id without the boolean still means blocked.
  assert.deepEqual(
    contactBlockEntry({id: 'c-6', displayName: '孙八', phones: [{rawNumber: '2025550111', blockedEntryId: 'entry-p'}]}, '2025550111'),
    {blocked: true, blockedEntryId: 'entry-p'},
  );
});

test('the contacts list path carries the server-side search', () => {
  assert.equal(contactsPath(''), '/contacts?limit=200');
  assert.equal(contactsPath('   '), '/contacts?limit=200');
  assert.equal(contactsPath('张三', 50), '/contacts?limit=50&query=%E5%BC%A0%E4%B8%89');
});

test('Contact Picker results map onto the import body and detection stays feature based', () => {
  assert.deepEqual(
    pickedContactsToImport([
      {
        name: ['', '张三'],
        tel: ['202 555 0117', ' '],
        email: ['a@b.c'],
        address: [{addressLine: ['和平路 12 号'], city: '深圳市', region: '广东省', postalCode: '518000', country: '中国'}],
      },
      {tel: ['2025550111']},
      {name: [], tel: [], email: []},
    ]),
    [
      {
        displayName: '张三',
        phones: [{rawNumber: '202 555 0117'}],
        emails: [{address: 'a@b.c'}],
        addresses: [
          {
            formatted: '和平路 12 号 深圳市 广东省 中国',
            city: '深圳市',
            region: '广东省',
            postalCode: '518000',
            country: '中国',
          },
        ],
      },
      {displayName: '2025550111', phones: [{rawNumber: '2025550111'}], emails: [], addresses: []},
    ],
  );
  assert.equal(contactPickerSupported({}), false);
  assert.equal(contactPickerSupported({navigator: {}}), false);
  assert.equal(contactPickerSupported({navigator: {contacts: {}}}), false);
  assert.equal(contactPickerSupported({navigator: {contacts: {select: () => []}}}), true);
});
