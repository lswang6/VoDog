import React, {useEffect, useRef, useState} from 'react';
import {useReportedError} from './ui-error';
import {parseVCard} from './vcard';
import {useVisibleRefresh} from './visible-refresh';
import {
  addImportSummary,
  contactDraftBody,
  contactDraftError,
  contactDraftFrom,
  contactPickerSupported,
  contactPrimaryPhone,
  contactVersion,
  contactsPath,
  emailLabelText,
  emptyContactDraft,
  emptyImportSummary,
  importBatches,
  importSummaryText,
  pickedContactsToImport,
  phoneLabelText,
  type ApiRequest,
  type ContactDraft,
  type ContactDto,
  type ContactImportEntry,
  type ContactImportSource,
  type ContactImportSummary,
  type PickedContact,
} from './contacts';

/**
 * 通讯录 tab (S21 §A/§F).
 *
 * The browser only formats and uploads: 架构决策 2 keeps de-duplication and matching on the server, so a file
 * with 2000 near-identical cards is still sent as-is and the server's 新增/更新/合并/跳过 counts are what the
 * summary reports. Each tile is a summary; the detail actions live in the contact card opened on click.
 */

type PanelMode = {kind: 'list'} | {kind: 'create'} | {kind: 'edit'; id: string};

function errorStatus(error: unknown): number {
  return typeof (error as {status?: number})?.status === 'number' ? (error as {status: number}).status : 0;
}

function errorCode(error: unknown): string {
  return typeof (error as {code?: unknown})?.code === 'string' ? String((error as {code: string}).code) : '';
}

export function ContactsPanel({
  busy,
  run,
  request,
  createFor = null,
  editFor = null,
  reloadToken = 0,
  onCreateConsumed,
  onEditConsumed,
  onOpenNumber,
  onChanged,
  selectedId = null,
}: {
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<boolean>;
  request: ApiRequest;
  createFor?: {remoteNumber: string; token: number} | null;
  editFor?: {contact: ContactDto; token: number} | null;
  /** Contact shown in the detail pane (wide layout); its row is marked current. */
  selectedId?: string | null;
  /** Bumped by the opener after a card blocked, unblocked or deleted a number, so the 已屏蔽 badge stays current. */
  reloadToken?: number;
  onCreateConsumed?: () => void;
  onEditConsumed?: () => void;
  onOpenNumber?: (remoteNumber: string, contact: ContactDto) => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<ContactDto[] | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<PanelMode>({kind: 'list'});
  const [draft, setDraft] = useState<ContactDraft>(emptyContactDraft());
  const [draftError, setDraftError] = useState('');
  const [conflictCurrent, setConflictCurrent] = useState<ContactDto | null>(null);
  const [conflictBlocked, setConflictBlocked] = useState(false);
  const [summary, setSummary] = useState<ContactImportSummary | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  useReportedError('通讯录', 'contacts', error);
  useReportedError('通讯录', 'contacts.draft', draftError);
  const [unsupported, setUnsupported] = useState(false);
  const [reloads, setReloads] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  // The 搜索 box drives the server-side filter, so a burst of keystrokes issues one request.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    request<{items: ContactDto[]}>(contactsPath(search))
      .then(result => {
        if (cancelled) return;
        setItems(result.items || []);
        setUnsupported(false);
        setError('');
      })
      .catch(caught => {
        if (cancelled) return;
        // A Control without the 通讯录 routes is expected during the staged rollout, not an error to shout about.
        if (errorStatus(caught) === 404) {
          setUnsupported(true);
          setItems([]);
        }
        else setError(caught instanceof Error ? caught.message : '无法读取通讯录');
      });
    return () => {
      cancelled = true;
    };
  }, [search, reloads, reloadToken, request]);

  // The normal effect performs the initial/dependency loads; this adds foreground polling and focus refresh.
  useVisibleRefresh(() => setReloads(value => value + 1), 5000, false);

  useEffect(() => {
    if (!createFor) return;
    setMode({kind: 'create'});
    setDraft(emptyContactDraft(createFor.remoteNumber));
    setDraftError('');
    setConflictCurrent(null);
    setConflictBlocked(false);
    onCreateConsumed?.();
  }, [createFor, onCreateConsumed]);

  // The contact card's 编辑 button closes itself and asks the panel to open the edit form.
  useEffect(() => {
    if (!editFor) return;
    startEdit(editFor.contact);
    onEditConsumed?.();
  }, [editFor, onEditConsumed]);

  function reload() {
    setReloads(value => value + 1);
    onChanged?.();
  }

  async function importContacts(source: ContactImportSource, contacts: ContactImportEntry[]) {
    if (!contacts.length) {
      setSummary(null);
      setError('没有可导入的联系人');
      return;
    }
    let combined = emptyImportSummary();
    const batches = importBatches(contacts);
    try {
      for (let index = 0; index < batches.length; index++) {
        setProgress(`正在导入第 ${index + 1}/${batches.length} 批（共 ${contacts.length} 条）…`);
        const result = await request<Partial<ContactImportSummary>>('/contacts/import', {
          source,
          contacts: batches[index],
        });
        combined = addImportSummary(combined, result);
        setSummary(combined);
      }
    } finally {
      setProgress('');
      reload();
    }
    setSummary(combined);
  }

  function importFiles(files: FileList | null) {
    const list = files ? [...files] : [];
    if (!list.length) return;
    setSummary(null);
    setError('');
    void run(async () => {
      const contacts: ContactImportEntry[] = [];
      for (const file of list) contacts.push(...parseVCard(await file.text()));
      await importContacts('web_vcard', contacts);
    });
  }

  function importFromPicker() {
    setSummary(null);
    setError('');
    // The picker must be reached without an await in front of it or Chrome drops the user gesture.
    void run(async () => {
      const picker = (navigator as unknown as {
        contacts?: {select?: (properties: string[], options?: {multiple?: boolean}) => Promise<PickedContact[]>};
      }).contacts;
      if (!picker?.select) throw new Error('此浏览器不支持读取本机通讯录');
      const picked = await picker.select(['name', 'tel', 'email', 'address'], {multiple: true});
      await importContacts('web_picker', pickedContactsToImport(picked || []));
    });
  }

  function saveDraft() {
    if (mode.kind === 'edit' && conflictBlocked) {
      setDraftError('服务器版本已变化。请先载入服务器最新内容，或取消编辑；不会自动覆盖其他设备的修改。');
      return;
    }
    const invalid = contactDraftError(draft);
    setDraftError(invalid);
    if (invalid) return;
    void run(async () => {
      const body = contactDraftBody(draft);
      // `POST /contacts` sets source='manual' itself and ignores the key, so sending one would only mislead.
      if (mode.kind === 'edit') {
        try {
          await request(`/contacts/${encodeURIComponent(mode.id)}`, {...body, expectedVersion: draft.version}, 'PUT');
        } catch (caught) {
          const conflict =
            errorStatus(caught) === 428 ||
            errorCode(caught) === 'CONTACT_VERSION_REQUIRED' ||
            errorCode(caught) === 'CONTACT_VERSION_CONFLICT';
          if (!conflict) throw caught;
          setConflictCurrent(null);
          setConflictBlocked(true);
          setDraftError('此联系人已在其他设备更新。你的草稿和原版本已保留；载入服务器最新内容后才可再次保存。');
          return;
        }
      } else await request('/contacts', body);
      setMode({kind: 'list'});
      setDraft(emptyContactDraft());
      reload();
    });
  }

  function startEdit(contact: ContactDto) {
    setMode({kind: 'edit', id: contact.id});
    setDraft(contactDraftFrom(contact));
    setConflictCurrent(null);
    setConflictBlocked(false);
    setDraftError('');
  }

  function loadCurrentConflict() {
    if (mode.kind !== 'edit') return;
    const id = mode.id;
    void run(async () => {
      try {
        const latest = await request<{item: ContactDto}>(`/contacts/${encodeURIComponent(id)}`);
        if (!latest.item) throw new Error('服务器未返回联系人');
        setItems(previous => (previous || []).map(item => (item.id === latest.item.id ? latest.item : item)));
        setDraft(contactDraftFrom(latest.item));
        setConflictCurrent(latest.item);
        setConflictBlocked(false);
        setDraftError('已载入服务器最新内容，请核对后再保存。');
      } catch (caught) {
        setDraftError(
          errorStatus(caught) === 404
            ? '联系人已在其他设备删除；草稿仍保留，取消后返回列表。'
            : '暂时无法读取服务器最新内容；草稿仍保留，请重试。',
        );
      }
    });
  }

  function updateList(key: 'phones', index: number, field: 'rawNumber' | 'label', value: string): void;
  function updateList(key: 'emails', index: number, field: 'address' | 'label', value: string): void;
  function updateList(key: 'phones' | 'emails', index: number, field: string, value: string) {
    setDraft(current => {
      const next = [...current[key]];
      next[index] = {...next[index], [field]: value} as never;
      return {...current, [key]: next};
    });
  }

  function updateAddress(index: number, field: keyof ContactDraft['addresses'][number], value: string) {
    setDraft(current => {
      const addresses = [...current.addresses];
      addresses[index] = {...addresses[index]!, [field]: value};
      return {...current, addresses};
    });
  }

  const editing = mode.kind !== 'list';

  return (
    <section className={`panel contacts-panel${editing ? ' is-editing' : ''}`}>
      <div className="panel-heading">
        <div>
          <h2>通讯录</h2>
          <p className="muted">联系人保存在服务器，三端共用；姓名会显示在通话记录和短信里。</p>
        </div>
        {!editing && (
          <button
            type="button"
            className="passkey"
            disabled={busy}
            onClick={() => {
              setMode({kind: 'create'});
              setDraft(emptyContactDraft());
              setDraftError('');
              setConflictCurrent(null);
              setConflictBlocked(false);
            }}
          >
            新建联系人
          </button>
        )}
      </div>

      {unsupported && <p className="note">此服务器尚未启用通讯录功能。</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {editing ? (
        <form
          className="contact-form"
          onSubmit={event => {
            event.preventDefault();
            saveDraft();
          }}
        >
          <h3>{mode.kind === 'edit' ? '编辑联系人' : '新建联系人'}</h3>
          <div className="contact-identity-grid">
          <label>
            显示姓名
            <input
              value={draft.displayName}
              maxLength={120}
              disabled={busy}
              onChange={event => setDraft(current => ({...current, displayName: event.target.value}))}
            />
          </label>
          <label>
            名
            <input
              value={draft.givenName}
              maxLength={120}
              disabled={busy}
              onChange={event => setDraft(current => ({...current, givenName: event.target.value}))}
            />
          </label>
          <label>
            姓
            <input
              value={draft.familyName}
              maxLength={120}
              disabled={busy}
              onChange={event => setDraft(current => ({...current, familyName: event.target.value}))}
            />
          </label>
          <label>
            公司
            <input
              value={draft.organization}
              maxLength={120}
              disabled={busy}
              onChange={event => setDraft(current => ({...current, organization: event.target.value}))}
            />
          </label>
          </div>
          <section className="contact-methods" aria-label="联系电话与邮箱">
          {draft.phones.map((phone, index) => (
            <div className="contact-field-row" key={`phone-${index}`}>
              <label>
                {index === 0 ? '电话' : `电话 ${index + 1}`}
                <input
                  type="tel"
                  inputMode="tel"
                  value={phone.rawNumber}
                  disabled={busy}
                  aria-label={`电话 ${index + 1}`}
                  onChange={event => updateList('phones', index, 'rawNumber', event.target.value)}
                />
                <input
                  value={phone.label}
                  disabled={busy}
                  aria-label={`电话 ${index + 1} 标签`}
                  placeholder="标签（如手机、工作）"
                  onChange={event => updateList('phones', index, 'label', event.target.value)}
                />
              </label>
              <button type="button" className="passkey contact-field-remove" disabled={busy} aria-label={`移除电话 ${index + 1}`} onClick={() => setDraft(current => ({...current, phones: current.phones.filter((_, row) => row !== index)}))}>移除电话</button>
            </div>
          ))}
          {draft.emails.map((email, index) => (
            <div className="contact-field-row" key={`email-${index}`}>
              <label>
                {index === 0 ? '邮箱' : `邮箱 ${index + 1}`}
                <input
                  type="email"
                  value={email.address}
                  disabled={busy}
                  aria-label={`邮箱 ${index + 1}`}
                  onChange={event => updateList('emails', index, 'address', event.target.value)}
                />
                <input
                  value={email.label}
                  disabled={busy}
                  aria-label={`邮箱 ${index + 1} 标签`}
                  placeholder="标签（如工作、住宅）"
                  onChange={event => updateList('emails', index, 'label', event.target.value)}
                />
              </label>
              <button type="button" className="passkey contact-field-remove" disabled={busy} aria-label={`移除邮箱 ${index + 1}`} onClick={() => setDraft(current => ({...current, emails: current.emails.filter((_, row) => row !== index)}))}>移除邮箱</button>
            </div>
          ))}
          </section>
          <div className="record-actions contact-add-actions">
            <button
              type="button"
              className="passkey"
              disabled={busy}
              onClick={() => setDraft(current => ({...current, phones: [...current.phones, {rawNumber: '', label: ''}]}))}
            >
              添加电话
            </button>
            <button
              type="button"
              className="passkey"
              disabled={busy}
              onClick={() => setDraft(current => ({...current, emails: [...current.emails, {address: '', label: ''}]}))}
            >
              添加邮箱
            </button>
          </div>
          {draft.addresses.map((address, index) => (
            <fieldset className="contact-address" key={`address-${index}`}>
              <legend>地址 {index + 1}</legend>
              <div className="contact-address-grid">
              <label className="contact-address-full">完整地址<input value={address.formatted} disabled={busy} onChange={event => updateAddress(index, 'formatted', event.target.value)} /></label>
              <label>标签<input value={address.label} disabled={busy} onChange={event => updateAddress(index, 'label', event.target.value)} /></label>
              <label>街道<input value={address.street} disabled={busy} onChange={event => updateAddress(index, 'street', event.target.value)} /></label>
              <label>城市<input value={address.city} disabled={busy} onChange={event => updateAddress(index, 'city', event.target.value)} /></label>
              <label>州／省<input value={address.region} disabled={busy} onChange={event => updateAddress(index, 'region', event.target.value)} /></label>
              <label>邮编<input value={address.postalCode} disabled={busy} onChange={event => updateAddress(index, 'postalCode', event.target.value)} /></label>
              <label>国家或地区<input value={address.country} disabled={busy} onChange={event => updateAddress(index, 'country', event.target.value)} /></label>
              </div>
              <button type="button" className="passkey contact-field-remove" disabled={busy} aria-label={`移除地址 ${index + 1}`} onClick={() => setDraft(current => ({...current, addresses: current.addresses.filter((_, row) => row !== index)}))}>移除地址</button>
            </fieldset>
          ))}
          <button
            type="button"
            className="passkey contact-add-address"
            disabled={busy}
            onClick={() => setDraft(current => ({
              ...current,
              addresses: [...current.addresses, {formatted: '', label: '', street: '', city: '', region: '', postalCode: '', country: ''}],
            }))}
          >
            添加地址
          </button>
          <label>
            备注
            <input
              value={draft.notes}
              maxLength={500}
              disabled={busy}
              onChange={event => setDraft(current => ({...current, notes: event.target.value}))}
            />
          </label>
          {draftError && (
            <p className="error" role="alert">
              {draftError}
            </p>
          )}
          {conflictBlocked && (
            <div className="note contact-conflict" role="status">
              {conflictCurrent && <p>服务器当前版本：{contactVersion(conflictCurrent)} · {conflictCurrent.displayName}</p>}
              <button
                type="button"
                className="passkey"
                disabled={busy}
                onClick={loadCurrentConflict}
              >
                载入服务器最新内容（替换当前草稿）
              </button>
            </div>
          )}
          <div className="record-actions contact-form-footer">
            <button className="primary" disabled={busy || conflictBlocked}>
              {mode.kind === 'edit' ? '保存修改' : '创建联系人'}
            </button>
            <button
              type="button"
              className="passkey"
              disabled={busy}
              onClick={() => {
                setMode({kind: 'list'});
                setConflictCurrent(null);
                setConflictBlocked(false);
                setDraftError('');
              }}
            >
              取消
            </button>
          </div>
        </form>
      ) : (
        <>
          <label className="contact-search">
            搜索联系人
            <input
              type="search"
              value={query}
              disabled={busy}
              placeholder="姓名或号码…"
              onChange={event => setQuery(event.target.value)}
            />
          </label>

          <div className="contact-import">
            <label className="passkey contact-import-file">
              导入 .vcf 文件
              <input
                ref={fileInput}
                type="file"
                accept=".vcf,text/vcard,text/x-vcard"
                multiple
                disabled={busy}
                onChange={event => {
                  // The File handles are copied synchronously, so clearing the input keeps re-picking possible.
                  importFiles(event.target.files);
                  if (fileInput.current) fileInput.current.value = '';
                }}
              />
            </label>
            {contactPickerSupported() && (
              <button type="button" className="passkey" disabled={busy} onClick={importFromPicker}>
                读取本机通讯录
              </button>
            )}
          </div>
          {progress && (
            <p className="note" role="status">
              {progress}
            </p>
          )}
          {summary && (
            <p className="note import-summary" role="status">
              导入完成：{importSummaryText(summary)}
            </p>
          )}

          {items === null ? (
            <p className="muted">正在读取通讯录…</p>
          ) : !items.length ? (
            <p className="muted">{search.trim() ? '没有匹配的联系人' : '还没有联系人，先导入 .vcf 文件或新建一个。'}</p>
          ) : (
            <div className="contact-grid contact-list">
              {items.map(contact => {
                const phone = contactPrimaryPhone(contact);
                const email = (contact.emails || [])[0] || null;
                const primary = phone?.e164 || phone?.rawNumber || '';
                const initial = (contact.displayName || '?').trim().charAt(0).toUpperCase() || '?';
                const current = selectedId === contact.id;
                return (
                  <button
                    type="button"
                    className={`contact-tile contact-row${current ? ' selected' : ''}`}
                    key={contact.id}
                    disabled={busy}
                    aria-current={current ? 'true' : undefined}
                    aria-label={`查看联系人 ${contact.displayName}`}
                    title={contact.displayName}
                    onClick={() => onOpenNumber?.(primary, contact)}
                  >
                    <span className="contact-avatar" aria-hidden="true">{initial}</span>
                    <span className="contact-row-main">
                      <strong className="contact-row-name">{contact.displayName}</strong>
                      <span className="contact-row-sub">
                        {contact.organization && <span className="contact-row-org">{contact.organization}</span>}
                        {phone ? (
                          <span dir="ltr">{phoneLabelText(phone.label)} <span className="num">{phone.rawNumber}</span></span>
                        ) : email ? (
                          <span>{email.address}</span>
                        ) : (
                          <span className="muted">无号码</span>
                        )}
                      </span>
                    </span>
                    {contact.blocked && <span className="blocked-badge">已屏蔽</span>}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
