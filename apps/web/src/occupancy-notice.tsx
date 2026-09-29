import React, {useState} from 'react';
import {ConfirmAction} from './confirm-action.tsx';
import {
  canReleaseOccupancy,
  occupancyNotice,
  releaseConfirmLabel,
  releaseConfirmPrompt,
  type OccupiableCall,
} from './call-occupancy.ts';

/**
 * “占用中 · {占用者} · 自 {时间}”, with the release entry for a call this account owns on another device.
 *
 * Releasing runs through the same `/calls/:id/end` route the account already uses, so nothing here can
 * force-release a live cellular call; it only asks the gateway to hang up or reject as the user would.
 */
export function OccupancyNotice({
  call,
  timeZone,
  currentSessionLabel,
  simLabel,
  busy,
  onRelease,
}: {
  call: OccupiableCall;
  timeZone?: string | null;
  currentSessionLabel?: string;
  /** S72：内部通话「A → B」里本卡的显示名。 */
  simLabel?: string | null;
  busy: boolean;
  onRelease: (call: OccupiableCall) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="call-occupancy">
      <p className="note" role="status">{occupancyNotice(call, {timeZone, currentSessionLabel, simLabel})}</p>
      {canReleaseOccupancy(call) && (confirming ? (
        <ConfirmAction
          busy={busy}
          prompt={releaseConfirmPrompt(call)}
          confirmLabel={releaseConfirmLabel(call)}
          onConfirm={() => {setConfirming(false); onRelease(call);}}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <button type="button" className="passkey hangup" disabled={busy} onClick={() => setConfirming(true)}>
          结束该通话
        </button>
      ))}
    </div>
  );
}
