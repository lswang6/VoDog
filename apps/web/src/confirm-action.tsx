import React from 'react';
export {GATEWAY_DELETE_PROMPT,PASSKEY_DELETE_PROMPT} from './confirm-copy';

export function ConfirmAction({
  busy,
  prompt,
  confirmLabel,
  onConfirm,
  onCancel,
  detail,
  tone,
}: {
  busy: boolean;
  prompt: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  detail?: string;
  /** `neutral` drops the red destructive style (S87 open-link). */
  tone?: 'neutral';
}) {
  return (
    <div className="confirm-action" role="alertdialog">
      <p>{prompt}</p>
      {detail && <p>{detail}</p>}
      <div className="record-actions">
        <button type="button" className={tone === 'neutral' ? 'passkey' : 'passkey hangup'} disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
        {/* Every ConfirmAction replaces the button just pressed, so focus follows to the safe choice. */}
        <button type="button" className="passkey" disabled={busy} onClick={onCancel} autoFocus>
          取消
        </button>
      </div>
    </div>
  );
}
