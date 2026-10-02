import React, {useEffect, useState} from 'react';
import type {ApiRequest} from './contacts';

/** `00:07` from the start of the recording / first turn (S95 transcript timestamps). */
export function clockOffset(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * “AI 对话” block on a record row (S21 §E/§F).
 *
 * `GET /calls/:id/ai-transcript` is the live transcript written by the Voice worker while the AI answered the
 * call, which is a different thing from the post-call `/transcript` job. Most calls have none, and an older
 * Control has no route at all, so anything other than a non-empty list renders nothing.
 */
export type AiTranscriptLine = {role?: string; text?: string; at?: string};

export function aiTranscriptRoleLabel(role: string | null | undefined): string {
  return role === 'ai' ? 'AI 助理' : role === 'caller' ? '对方' : '通话';
}

/** `00:07` since the first turn; blank when the turn carries no time. */
function turnOffset(first: string | undefined, at: string | undefined): string {
  const start = Date.parse(first || ''), value = Date.parse(at || '');
  return Number.isFinite(start) && Number.isFinite(value) ? clockOffset(value - start) : '';
}

export function AiTranscript({
  callId,
  request,
  settled = true,
}: {
  callId: string;
  request: ApiRequest;
  /** A call still in progress has nothing final to show; the row fetches once it reaches a terminal state. */
  settled?: boolean;
}) {
  const [items, setItems] = useState<AiTranscriptLine[]>([]);

  useEffect(() => {
    if (!settled) return;
    let cancelled = false;
    request<{items: AiTranscriptLine[]}>(`/calls/${encodeURIComponent(callId)}/ai-transcript`)
      .then(result => {
        if (!cancelled) setItems((result.items || []).filter(item => (item.text || '').trim()));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [callId, settled, request]);

  if (!items.length) return null;
  return (
    <div className="ai-transcript">
      <h3>AI 对话</h3>
      {items.map((item, index) => (
        <p
          key={index}
          className={'ai-turn ai-turn-' + (item.role === 'ai' ? 'ai' : item.role === 'caller' ? 'caller' : 'other')}
        >
          <span className="ai-turn-time num">{turnOffset(items[0]?.at, item.at)}</span>
          <strong>{aiTranscriptRoleLabel(item.role)}</strong>
          <span className="ai-turn-text">{item.text}</span>
        </p>
      ))}
      <p className="note">这是 AI 接听时的实时对话记录。</p>
    </div>
  );
}
