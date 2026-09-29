import React, {useEffect, useRef, useState} from 'react';
import {useReportedError} from './ui-error';
import {type ContactDto, type ApiRequest} from './contacts';
import {matchesSmsContact, normalizeSmsNumber, sameSmsRecipient, smsContactNumbers, uniqueSmsRecipients, type SmsRecipient} from './sms-recipient-policy';
import {browserSessionGeneration} from './session-boundary';
import './sms-recipients.css';

/** Controlled values belong to the account/SIM draft owner. Mount keyed by that scope. */
export function SmsRecipients({value, onChange, onPendingChange, contacts = [], request, busy = false, loading = false, error = ''}: {
  value: SmsRecipient[]; onChange: (value: SmsRecipient[]) => void; onPendingChange?: (pending: boolean) => void;
  contacts?: ContactDto[]; request?: ApiRequest; busy?: boolean; loading?: boolean; error?: string;
}) {
  const [input, setInput] = useState('');
  const [invalid, setInvalid] = useState('');
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [cached, setCached] = useState<ContactDto[]>(contacts);
  const [fetching, setFetching] = useState(false);
  const [loadError, setLoadError] = useState('');
  useReportedError('短信', 'sms.recipients.invalid', invalid);
  const [reload, setReload] = useState(0);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!picking || !request) return;
    let cancelled = false;
    const generation = browserSessionGeneration();
    const stale = () => cancelled || generation !== browserSessionGeneration();
    setFetching(true);
    const timer = setTimeout(() => {
      if (stale()) return;
      request<{items: ContactDto[]}>(`/contacts?limit=200&offset=${offset}${query.trim() ? `&query=${encodeURIComponent(query.trim())}` : ''}`).then(result => {
        if (stale()) return;
        setCached(old => offset === 0 ? result.items : [...old, ...result.items.filter(item => !old.some(prior => prior.id === item.id))]);
        setMore(result.items.length === 200); setLoadError('');
      }).catch(() => {if (!stale()) setLoadError('读取失败');})
        .finally(() => {if (!stale()) setFetching(false);});
    }, query ? 250 : 0);
    return () => {cancelled = true;clearTimeout(timer);};
  }, [request, picking, query, offset, reload]);
  const opener = useRef<HTMLButtonElement>(null);
  function add() {
    if (!input.trim()) return;
    const number = normalizeSmsNumber(input);
    if (!number) { setInvalid('请输入有效的电话号码'); return; }
    const next = uniqueSmsRecipients([...value, {number}]);
    if (next.length > 100) {setInvalid('每次最多选择 100 个号码');return;}
    onChange(next);onPendingChange?.(false);
    setInput(''); setInvalid('');
  }
  return <div className="sms-recipients">
    <div className="sms-recipient-heading"><span>收件人</span><button ref={opener} type="button" className="sms-recipient-add" aria-label="从通讯录添加收件人" aria-haspopup="dialog" aria-expanded={picking} disabled={busy} onClick={() => {setQuery('');setOffset(0);setPicking(true);}}>＋</button></div>
    <ul className="sms-recipient-chips" aria-label="已选收件人">{value.map((recipient, index) => <li key={recipient.number}>
      <span>{recipient.name && <strong>{recipient.name}</strong>}<span>{recipient.number}</span></span>
      <button type="button" disabled={busy} aria-label={`移除 ${recipient.name ? recipient.name + ' ' : ''}${recipient.number}`} onClick={() => onChange(value.filter((_, at) => at !== index))}>×</button>
    </li>)}</ul>
    <div className="sms-recipient-manual"><input type="tel" inputMode="tel" name="recipient" autoComplete="off" aria-label="收件号码" placeholder="输入电话号码" value={input} disabled={busy} onChange={event => {setInput(event.target.value);onPendingChange?.(Boolean(event.target.value.trim()));setInvalid('');}} onKeyDown={event => {if (event.key === 'Enter' || event.key === ',' || event.key === ';') {event.preventDefault();add();}}}/><button type="button" disabled={busy || !input.trim()} onClick={add}>添加</button></div>
    {input.trim() && <p className="note">请先添加输入的号码，再发送短信。</p>}
    {invalid && <p role="alert">{invalid}</p>}
    {picking && <SmsRecipientPicker contacts={request ? cached : contacts} query={query} onQuery={text => {setQuery(text);setOffset(0);}} more={more} onRetry={() => setReload(value => value + 1)} onMore={() => setOffset(value => value + 200)} value={value} onChange={onChange} loading={loading || fetching} error={error || loadError} onClose={() => {setPicking(false);opener.current?.focus();}}/>}
  </div>;
}

export function SmsRecipientPicker({contacts, value, onChange, onClose, loading, error, query, onQuery, more, onMore, onRetry}: {
  contacts: ContactDto[]; value: SmsRecipient[]; onChange: (value: SmsRecipient[]) => void;
  onClose: () => void; loading?: boolean; error?: string; query: string; onQuery: (value: string) => void; more?: boolean; onMore?: () => void; onRetry?: () => void;
}) {
  const [pending, setPending] = useState(value);
  const [selectionError, setSelectionError] = useState('');
  useReportedError('短信', 'sms.recipients.selection', selectionError);
  useReportedError('短信', 'sms.recipients.load', error ? '通讯录暂时无法更新，仍可选择已加载的号码。' : '');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {panel.current?.focus();}, []);
  const shown = contacts.filter(contact => matchesSmsContact(contact, query));
  return <div className="sms-recipient-overlay" onClick={event => {event.stopPropagation();if (event.target === event.currentTarget) onClose();}}>
    <section className="sms-recipient-picker" role="dialog" aria-modal="true" aria-label="选择短信收件人" tabIndex={-1} ref={panel} onKeyDown={event => {
      // The picker is nested inside the existing SMS modal: never bubble Escape or Tab to it.
      if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();onClose();return;}
      if (event.key !== 'Tab') return;
      event.stopPropagation();
      const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(element => element.offsetParent !== null);
      if (!focusable.length) {event.preventDefault();event.currentTarget.focus();return;}
      if (event.shiftKey && (document.activeElement === event.currentTarget || document.activeElement === focusable[0])) {event.preventDefault();focusable.at(-1)?.focus();}
      else if (!event.shiftKey && (document.activeElement === event.currentTarget || document.activeElement === focusable.at(-1))) {event.preventDefault();focusable[0]?.focus();}
    }}>
      <header><h3>选择收件人</h3><div><button type="button" onClick={onClose}>取消</button><button type="button" onClick={() => {onChange(pending);onClose();}}>完成</button></div></header>
      <input type="search" aria-label="搜索联系人姓名或号码" placeholder="搜索姓名或号码" value={query} onChange={event => onQuery(event.target.value)}/>
      <p role="status">已选 {pending.length} 个号码</p>
      {selectionError && <p role="alert">{selectionError}</p>}
      {loading && <p role="status">正在读取通讯录…</p>}
      {error && <p role="status">通讯录暂时无法更新，仍可选择已加载的号码。{onRetry && <button type="button" disabled={loading} onClick={onRetry}>重试</button>}</p>}
      <div className="sms-recipient-results">{shown.map(contact => <fieldset key={contact.id}><legend>{contact.displayName}</legend>{smsContactNumbers(contact).map(recipient => {
        const checked = pending.some(item => sameSmsRecipient(item.number, recipient.number));
        return <label key={recipient.number}><input type="checkbox" checked={checked} onChange={() => {const next = checked ? pending.filter(item => !sameSmsRecipient(item.number, recipient.number)) : uniqueSmsRecipients([...pending, recipient]);if (next.length > 100) {setSelectionError('每次最多选择 100 个号码');return;}setSelectionError('');setPending(next);}}/><span>{recipient.label && <small>{recipient.label} · </small>}{recipient.number}</span></label>;
      })}{!smsContactNumbers(contact).length && <p>没有电话号码</p>}</fieldset>)}{!shown.length && !loading && <p>{query ? '没有匹配的联系人' : '暂无联系人，可手动输入号码。'}</p>}{more && <button type="button" disabled={loading || !!error} onClick={onMore}>加载更多联系人</button>}</div>
    </section>
  </div>;
}
