import React, {useEffect, useRef, useState} from 'react';
import {useReportedError} from './ui-error';
import {ConfirmAction} from './confirm-action';
import {
  CONTACT_BLOCK_PROMPT,
  CONTACT_CALL_PROMPT,
  CONTACT_DELETE_PROMPT,
  CONTACT_UNBLOCK_PROMPT,
  contactBlockEntry,
  contactCardActions,
  contactVersion,
  contactsPath,
  emailLabelText,
  isBlockedRow,
  numberWithContact,
  phoneLabelText,
  samePhoneNumber,
  type ApiRequest,
  type ContactDto,
} from './contacts';
import {useVisibleRefresh} from './visible-refresh';

/**
 * 联系人卡片 (S21 §F).
 *
 * Web has no record detail page, so this modal is what a record row, an interception row and the 通讯录 list
 * all open: 拨打电话 / 发送短信 on top (which is requirement 2.2), then 新建联系人 / 添加到现有联系人 /
 * 屏蔽此号码, and finally the opener's `media` slot: a call row's 录音 / 转录 toggles, expanded in place.
 */
export type ContactCardTarget = {
  remoteNumber?: string | null;
  simId?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  blocked?: boolean;
  blockedEntryId?: string | null;
  /** Present when the card was opened from a call record, which owns the transcript and recording. */
  callId?: string | null;
};

type Confirming = 'block' | 'unblock' | 'delete' | 'call' | null;

function confirmPrompt(kind: Exclude<Confirming, null>): string {
  switch (kind) {
    case 'block':
      return CONTACT_BLOCK_PROMPT;
    case 'unblock':
      return CONTACT_UNBLOCK_PROMPT;
    case 'delete':
      return CONTACT_DELETE_PROMPT;
    case 'call':
      return CONTACT_CALL_PROMPT;
  }
}

function confirmLabel(kind: Exclude<Confirming, null>): string {
  switch (kind) {
    case 'block':
      return '确认屏蔽';
    case 'unblock':
      return '确认解除';
    case 'delete':
      return '确认删除';
    case 'call':
      return '确认拨打';
  }
}

export function ContactCard({
  target,
  contact: preloaded = null,
  busy,
  mediaLive,
  request,
  run,
  onClose,
  onCall,
  onSms,
  onCreateContact,
  onEdit,
  media,
  onChanged,
  onMissing,
}: {
  target: ContactCardTarget;
  contact?: ContactDto | null;
  busy: boolean;
  mediaLive: boolean;
  request: ApiRequest;
  run: (action: () => Promise<void>) => Promise<boolean>;
  onClose: () => void;
  onCall: (target: ContactCardTarget) => void;
  onSms: (target: ContactCardTarget) => void;
  onCreateContact: (remoteNumber: string) => void;
  /** Present when the card was opened from the 通讯录 list: adds 编辑/删除 and lets 编辑 hand back the contact. */
  onEdit?: (contact: ContactDto) => void;
  /** A call row's 录音 / 转录 sections, rendered inside the card so nothing jumps to another tab. */
  media?: React.ReactNode;
  /** Reports the new blocked state so the opener can keep the card truthful while the lists reload. */
  onChanged?: (update?: {blocked: boolean; blockedEntryId?: string | null}) => void;
  onMissing?: (message: string) => void;
}) {
  const [contact, setContact] = useState<ContactDto | null>(preloaded);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [attaching, setAttaching] = useState(false);
  const [candidates, setCandidates] = useState<ContactDto[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshError, setRefreshError] = useState('');
  useReportedError('contact-card', 'action', error);
  useReportedError('contact-card', 'refresh', refreshError);
  const [liveTarget, setLiveTarget] = useState(target);
  const [liveBlock, setLiveBlock] = useState<{known: boolean; blocked: boolean; blockedEntryId: string | null}>(() => ({
    known: !preloaded && (typeof target.blocked === 'boolean' || Boolean(target.blockedEntryId)),
    blocked: isBlockedRow(target),
    blockedEntryId: target.blockedEntryId || null,
  }));
  const panel = useRef<HTMLDivElement>(null);
  const loadSequence = useRef(0);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const restoreFocusId = useRef('');
  const restoreFocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteNumber = (liveTarget.remoteNumber || '').trim();

  useEffect(() => {
    const mountedPanel = panel.current;
    if (restoreFocusTimer.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(restoreFocusTimer.current);
      restoreFocusTimer.current = null;
    }
    if (typeof document !== 'undefined') {
      const active = document.activeElement;
      // React StrictMode repeats setup/cleanup in development. Its second setup runs with focus already inside
      // this dialog, so retain the genuine outside opener captured by the first setup.
      if (active instanceof HTMLElement && !mountedPanel?.contains(active)) {
        restoreFocusTo.current = active;
        restoreFocusId.current = active.id || '';
      }
    }
    mountedPanel?.focus();
    return () => {
      loadSequence.current++;
      if (typeof document === 'undefined' || typeof window === 'undefined') return;
      const opener = restoreFocusTo.current;
      const deadline = Date.now() + 2000;
      const restore = () => {
        const active = document.activeElement;
        const stillInsideClosingPanel = active instanceof Node && Boolean(mountedPanel?.contains(active));
        if (active instanceof HTMLElement && active.isConnected && active !== document.body && !stillInsideClosingPanel && active !== opener) {
          restoreFocusTimer.current = null;
          return;
        }
        const currentOpener = opener?.isConnected ? opener : restoreFocusId.current ? document.getElementById(restoreFocusId.current) : null;
        if (currentOpener) {
          currentOpener.focus();
          restoreFocusTimer.current = null;
        } else if (restoreFocusId.current && Date.now() < deadline) {
          restoreFocusTimer.current = window.setTimeout(restore, 50);
        } else {
          restoreFocusTimer.current = null;
        }
      };
      // React removes the focused dialog after passive cleanup; restore on the next task so the browser's
      // own fallback-to-body step cannot overwrite the row focus.
      restoreFocusTimer.current = window.setTimeout(restore, 0);
    };
  }, []);

  useEffect(() => {
    setLiveTarget(target);
    if (!preloaded && (typeof target.blocked === 'boolean' || target.blockedEntryId)) {
      setLiveBlock({known: true, blocked: isBlockedRow(target), blockedEntryId: target.blockedEntryId || null});
    }
  }, [target.callId, target.contactId, target.remoteNumber, target.simId, target.blocked, target.blockedEntryId]);

  // The opener may already have received a newer contact snapshot. Adopt it without letting an older
  // preloaded object overwrite a later detail poll during unrelated parent renders.
  useEffect(() => {
    if (preloaded) setContact(preloaded);
  }, [preloaded?.id, preloaded?.version]);

  async function loadDetails() {
    if (busy) return;
    if (!liveTarget.contactId && !remoteNumber && !liveTarget.callId) return;
    const captured = ++loadSequence.current;
    const failures: unknown[] = [];
    const callResult = liveTarget.callId
      ? await request<{call?: ContactCardTarget; item?: ContactCardTarget}>(`/calls/${encodeURIComponent(liveTarget.callId)}`)
          .then(value => ({status: 'fulfilled' as const, value}))
          .catch(reason => ({status: 'rejected' as const, reason}))
      : null;
    if (captured !== loadSequence.current) return;
    if (callResult?.status === 'rejected' && Number((callResult.reason as {status?: unknown})?.status) === 404) {
      onMissing?.('此通话已在其他设备删除，详情已关闭。');
      onClose();
      return;
    }
    if (callResult?.status === 'rejected') failures.push(callResult.reason);
    const currentCall = callResult?.status === 'fulfilled' ? callResult.value.call || callResult.value.item : null;
    if (currentCall) {
      setLiveTarget(current => ({
        ...current,
        remoteNumber: currentCall.remoteNumber ?? current.remoteNumber,
        simId: currentCall.simId ?? current.simId,
        contactId: currentCall.contactId ?? null,
        contactName: currentCall.contactName ?? null,
        blocked: currentCall.blocked,
        blockedEntryId: currentCall.blockedEntryId ?? null,
      }));
    }
    const lookupNumber = (currentCall?.remoteNumber || remoteNumber).trim();
    const contactId = currentCall ? currentCall.contactId : liveTarget.contactId;
    const contactPath = contactId
      ? `/contacts/${encodeURIComponent(contactId)}`
      : lookupNumber ? `/contacts/lookup?number=${encodeURIComponent(lookupNumber)}` : '';
    const [contactResult, blocklistResult] = await Promise.allSettled([
      contactPath ? request<{item: ContactDto | null}>(contactPath) : Promise.resolve({item: null}),
      lookupNumber ? request<{items?: {id?: string; remoteNumber?: string}[]}>('/blocklist?scope=call') : Promise.resolve({items: []}),
    ]);
    if (captured !== loadSequence.current) return;
    if (contactResult.status === 'fulfilled') {
      if ('item' in contactResult.value) setContact(contactResult.value.item || null);
    } else {
      if (contactId && Number((contactResult.reason as {status?: unknown})?.status) === 404) {
        if (liveTarget.callId) setContact(null);
        else {
          onMissing?.('此联系人已在其他设备删除，详情已关闭。');
          onClose();
          return;
        }
      } else {
        failures.push(contactResult.reason);
      }
    }
    // A successful current blocklist read is authoritative. Page membership and the row snapshot are not.
    if (blocklistResult.status === 'fulfilled' && Array.isArray(blocklistResult.value.items)) {
      const entry = (blocklistResult.value.items || []).find(item => samePhoneNumber(item.remoteNumber, lookupNumber));
      setLiveBlock({known: true, blocked: Boolean(entry), blockedEntryId: entry?.id || null});
    } else if (blocklistResult.status === 'rejected' && Number((blocklistResult.reason as {status?: unknown})?.status) !== 404) {
      failures.push(blocklistResult.reason);
    }
    const failure = failures[0];
    setRefreshError(failure ? (failure instanceof Error ? failure.message : '详情刷新失败。') : '');
  }
  useVisibleRefresh(loadDetails, 5000, true);

  const contactName = contact?.displayName || liveTarget.contactName || '';
  const contactId = contact?.id || liveTarget.contactId || null;
  /**
   * A call or interception row is authoritative for its own number, so its annotation wins whenever it has
   * one. The 通讯录 list has no per-row annotation, and there the contact itself carries the entry id.
   */
  const fromContact = contactBlockEntry(contact, remoteNumber);
  const blocked = liveBlock.known ? liveBlock.blocked : fromContact.blocked;
  const blockedEntryId = liveBlock.known ? liveBlock.blockedEntryId : (blocked ? fromContact.blockedEntryId : null);
  const actions = contactCardActions({
    remoteNumber,
    simId: liveTarget.simId,
    mediaLive,
    blocked,
    blockedEntryId,
    contactId,
  });
  const title = contactName || numberWithContact(remoteNumber, null);
  const phones = contact?.phones || [];
  const emails = contact?.emails || [];
  const addresses = contact?.addresses || [];

  function openAttach() {
    setAttaching(true);
    setError('');
    setNotice('');
    if (candidates) return;
    request<{items: ContactDto[]}>(contactsPath(''))
      .then(result => setCandidates(result.items || []))
      .catch(caught => setError(caught instanceof Error ? caught.message : '无法读取通讯录'));
  }

  function attachTo(item: ContactDto) {
    loadSequence.current++;
    void run(async () => {
      await request(`/contacts/${encodeURIComponent(item.id)}/phones`, {rawNumber: remoteNumber});
      setAttaching(false);
      setNotice(`已把此号码加入「${item.displayName}」`);
      const lookup = await request<{item: ContactDto | null}>(
        `/contacts/lookup?number=${encodeURIComponent(remoteNumber)}`,
      ).catch(() => ({item: null}));
      setContact(lookup.item || item);
      loadSequence.current++;
      onChanged?.();
    });
  }

  function setBlocked(next: boolean) {
    // Invalidate a read that began before this accepted mutation; its stale blocklist must never win afterwards.
    loadSequence.current++;
    void run(async () => {
      if (next) {
        // The created entry id comes straight back, so 解除屏蔽 works without waiting for a list reload.
        const created = await request<{item?: {id?: string}}>('/blocklist', {
          remoteNumber,
          ...(liveTarget.callId ? {sourceCallId: liveTarget.callId} : {}),
          scope: 'call',
        });
        const entryId = created?.item?.id ?? null;
        setContact(current => current ? {...current, blocked: true, blockedEntryId: entryId, phones: (current.phones || []).map(phone => samePhoneNumber(phone.rawNumber, remoteNumber) ? {...phone, blocked: true, blockedEntryId: entryId} : phone)} : current);
        setLiveBlock({known: true, blocked: true, blockedEntryId: entryId});
        loadSequence.current++;
        setConfirming(null);
        onChanged?.({blocked: true, blockedEntryId: entryId});
        return;
      }
      let entryId = blockedEntryId;
      if (!entryId) {
        const current = await request<{items?: {id?: string; remoteNumber?: string}[]}>('/blocklist?scope=call');
        entryId = (current.items || []).find(item => samePhoneNumber(item.remoteNumber, remoteNumber))?.id || null;
      }
      if (entryId) {
        await request(`/blocklist/${encodeURIComponent(entryId)}`, undefined, 'DELETE');
      } else {
        setNotice('此号码已在其他设备解除屏蔽。');
      }
      setContact(current => {
        if (!current) return current;
        const phones = (current.phones || []).map(phone => samePhoneNumber(phone.rawNumber, remoteNumber) ? {...phone, blocked: false, blockedEntryId: null} : phone);
        const stillBlocked = phones.some(phone => phone.blocked);
        return {...current, phones, blocked: stillBlocked, blockedEntryId: stillBlocked ? current.blockedEntryId : null};
      });
      setLiveBlock({known: true, blocked: false, blockedEntryId: null});
      loadSequence.current++;
      setConfirming(null);
      onChanged?.({blocked: false, blockedEntryId: null});
    });
  }

  function deleteContact() {
    const id = contact?.id;
    if (!id) return;
    void run(async () => {
      try {
        await request(
          `/contacts/${encodeURIComponent(id)}?expectedVersion=${encodeURIComponent(String(contactVersion(contact)))}`,
          undefined,
          'DELETE',
        );
      } catch (caught) {
        const status = Number((caught as {status?: unknown})?.status);
        const code = typeof (caught as {code?: unknown})?.code === 'string' ? (caught as {code: string}).code : '';
        if (status === 428 || code === 'CONTACT_VERSION_REQUIRED' || code === 'CONTACT_VERSION_CONFLICT') {
          setNotice('此联系人已在其他设备更新，未执行删除。请关闭后重新打开再试。');
          setConfirming(null);
          return;
        }
        throw caught;
      }
      setConfirming(null);
      onClose();
      onChanged?.();
    });
  }

  const shown = (candidates || []).filter(item =>
    !query.trim() ? true : item.displayName.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div
      className="modal-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="contact-card"
        role="dialog"
        aria-modal="true"
        aria-label={`联系人卡片 ${title}`}
        ref={panel}
        tabIndex={-1}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Tab') {
            const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
              .filter(element => element.offsetParent !== null);
            if (!focusable.length) {
              event.preventDefault();
              event.currentTarget.focus();
            } else if (event.shiftKey && (document.activeElement === event.currentTarget || document.activeElement === focusable[0])) {
              event.preventDefault();
              focusable.at(-1)?.focus();
            } else if (!event.shiftKey && document.activeElement === event.currentTarget) {
              event.preventDefault();
              focusable[0]?.focus();
            } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
              event.preventDefault();
              focusable[0]?.focus();
            }
          }
        }}
      >
        <header className="contact-card-heading">
          <div>
            <h2>{title}</h2>
            {contactName && remoteNumber && <small dir="ltr">{remoteNumber}</small>}
            {blocked && <span className="blocked-badge">已屏蔽</span>}
          </div>
          <button type="button" className="contact-card-close" aria-label="关闭联系人卡片" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="contact-card-primary">
          <button
            type="button"
            className="primary"
            disabled={busy || !actions.canCall}
            onClick={() => setConfirming('call')}
          >
            拨打电话
          </button>
          <button type="button" className="passkey" disabled={busy || !actions.canSms} onClick={() => onSms(liveTarget)}>
            发送短信
          </button>
        </div>

        {(phones.length > 0 || emails.length > 0 || addresses.length > 0 || contact?.organization) && (
          <div className="contact-card-details">
            {contact?.organization && <p className="muted">{contact.organization}</p>}
            {phones.map((phone, index) => (
              <p key={phone.id || `phone-${index}`}>
                <small>{phoneLabelText(phone.label)}</small>
                <span dir="ltr">
                  {phone.rawNumber}
                  {/* A contact can have one blocked number and one normal one. */}
                  {phone.blocked && <span className="blocked-badge">已屏蔽</span>}
                </span>
              </p>
            ))}
            {emails.map((email, index) => (
              <p key={email.id || `email-${index}`}>
                <small>{emailLabelText(email.label)}</small>
                <span>{email.address}</span>
              </p>
            ))}
            {addresses.map((address, index) => (
              <p key={address.id || `address-${index}`}>
                <small>地址</small>
                <span>{address.formatted || [address.country, address.region, address.city, address.street].filter(Boolean).join('')}</span>
              </p>
            ))}
            {contact?.notes && <p className="note">{contact.notes}</p>}
          </div>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {refreshError && (
          <div className="note" role="status">
            <p>{refreshError} 已保留上次内容。</p>
            <button type="button" className="passkey" disabled={busy} onClick={() => void loadDetails()}>重试刷新</button>
          </div>
        )}
        {notice && (
          <p className="note" role="status">
            {notice}
          </p>
        )}

        {confirming ? (
          <ConfirmAction
            busy={busy}
            prompt={confirmPrompt(confirming)}
            confirmLabel={confirmLabel(confirming)}
            onConfirm={() => {
              if (confirming === 'block') setBlocked(true);
              else if (confirming === 'unblock') setBlocked(false);
              else if (confirming === 'delete') deleteContact();
              else {
                setConfirming(null);
                onCall(liveTarget);
              }
            }}
            onCancel={() => setConfirming(null)}
          />
        ) : attaching ? (
          <div className="contact-card-picker">
            <label>
              选择联系人
              <input
                aria-label="搜索联系人"
                value={query}
                disabled={busy}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索姓名…"
              />
            </label>
            {candidates === null ? (
              <p className="muted">正在读取通讯录…</p>
            ) : !shown.length ? (
              <p className="muted">没有匹配的联系人</p>
            ) : (
              <div className="contact-picker-list">
                {shown.slice(0, 50).map(item => (
                  <button
                    type="button"
                    className="contact-picker-row"
                    key={item.id}
                    disabled={busy}
                    onClick={() => attachTo(item)}
                  >
                    <strong>{item.displayName}</strong>
                    <small dir="ltr">{item.phones?.[0]?.rawNumber || '无号码'}</small>
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="passkey" disabled={busy} onClick={() => setAttaching(false)}>
              取消
            </button>
          </div>
        ) : (
          <div className="contact-card-actions">
            {actions.canCreateContact && (
              <button type="button" className="passkey" disabled={busy} onClick={() => onCreateContact(remoteNumber)}>
                新建联系人
              </button>
            )}
            {actions.canAttachToContact && (
              <button type="button" className="passkey" disabled={busy} onClick={openAttach}>
                添加到现有联系人
              </button>
            )}
            {actions.canUnblock ? (
              <button type="button" className="passkey hangup" disabled={busy} onClick={() => setConfirming('unblock')}>
                解除屏蔽
              </button>
            ) : (
              <button
                type="button"
                className="passkey hangup"
                disabled={busy || !actions.canBlock}
                onClick={() => setConfirming('block')}
              >
                {actions.blockLabel}
              </button>
            )}
            {onEdit && contact && (
              <button type="button" className="passkey" disabled={busy} onClick={() => onEdit(contact)}>
                编辑
              </button>
            )}
            {onEdit && contact && (
              <button type="button" className="passkey hangup" disabled={busy} onClick={() => setConfirming('delete')}>
                删除
              </button>
            )}
          </div>
        )}

        {media && (
          <div className="contact-card-links" role="group" aria-label="录音与转录">
            {media}
          </div>
        )}
      </div>
    </div>
  );
}
