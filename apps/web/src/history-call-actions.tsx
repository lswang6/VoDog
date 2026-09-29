import React, {useState} from 'react';
import {MoreActions} from './more-actions';
import {ConfirmAction} from './confirm-action';
import {
  HISTORY_ACTION_COPY,
  canBlock,
  canRedial,
  canSendSMS,
} from './history-actions';

export function HistoryCallActions({
  remoteNumber,
  simId,
  mediaLive,
  busy,
  blocked = false,
  onRedial,
  onSms,
  onBlock,
  onDelete,
}: {
  remoteNumber?: string;
  simId?: string;
  mediaLive: boolean;
  busy: boolean;
  /** 报告卡片：已屏蔽的号码不再提供 屏蔽；菜单因此为空时改为显示「已屏蔽」标记。 */
  blocked?: boolean;
  onRedial: () => void;
  onSms: () => void;
  onBlock: () => Promise<void> | void;
  /** S30: absent on surfaces that only read records, so the fourth button simply does not render there. */
  onDelete?: () => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState<'block' | 'delete' | null>(null);
  const pending = confirming === 'block' ? onBlock : onDelete;
  return (
    <div className="record-actions history-call-actions">
      {confirming ? (
        <ConfirmAction
          busy={busy}
          prompt={confirming === 'block' ? HISTORY_ACTION_COPY.blockPrompt : HISTORY_ACTION_COPY.deletePrompt}
          confirmLabel={confirming === 'block' ? HISTORY_ACTION_COPY.blockConfirm : HISTORY_ACTION_COPY.deleteConfirm}
          onConfirm={() => {
            void Promise.resolve(pending?.()).finally(() => setConfirming(null));
          }}
          onCancel={() => setConfirming(null)}
        />
      ) : (
        <>
          <button
            type="button"
            className="passkey"
            disabled={busy || !canRedial(remoteNumber, simId, mediaLive)}
            onClick={onRedial}
          >
            {HISTORY_ACTION_COPY.redial}
          </button>
          <button
            type="button"
            className="passkey"
            disabled={busy || !canSendSMS(remoteNumber, simId)}
            onClick={onSms}
          >
            {HISTORY_ACTION_COPY.sms}
          </button>
          {blocked && !onDelete ? <span className="pill pill-blocked">{HISTORY_ACTION_COPY.blocked}</span> : <MoreActions label="更多通话操作">
          {!blocked && (
          <button
            type="button"
            className="passkey hangup"
            disabled={busy || !canBlock(remoteNumber)}
            onClick={() => setConfirming('block')}
          >
            {HISTORY_ACTION_COPY.block}
          </button>
          )}
          {/* 删除 has no number to validate: a row with no remote number at all is still deletable. */}
          {onDelete && (
            <button
              type="button"
              className="passkey hangup"
              disabled={busy}
              onClick={() => setConfirming('delete')}
            >
              {HISTORY_ACTION_COPY.delete}
            </button>
          )}
          </MoreActions>}
        </>
      )}
    </div>
  );
}
