import React, {useEffect, useState} from 'react';
import type {ApiRequest} from './contacts';

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
          <strong>{aiTranscriptRoleLabel(item.role)}</strong>
          <br />
          {item.text}
        </p>
      ))}
      <p className="note">这是 AI 接听时的实时对话记录。</p>
    </div>
  );
}
