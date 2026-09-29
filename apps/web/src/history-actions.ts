import {CONTACT_BLOCK_PROMPT,type ApiRequest} from './contacts.ts';
import {CALL_DELETE_CONFIRM_LABEL,CALL_DELETE_IN_USE_MESSAGE,CALL_DELETE_PROMPT} from './confirm-copy.ts';

/**
 * 记录行与报告卡片的快捷动作文案（S22 决策 10）。
 *
 * The verb is 屏蔽 everywhere — 拉黑 is gone — and the confirmation is literally the 联系人卡片's prompt, so
 * one number cannot be described two different ways depending on which surface the user blocked it from.
 */
export const HISTORY_ACTION_COPY = {
  redial: '回拨',
  sms: '发短信',
  block: '屏蔽',
  blockNow: '立即屏蔽',
  blocked: '已屏蔽',
  blockPrompt: CONTACT_BLOCK_PROMPT,
  blockConfirm: '确认屏蔽',
  delete: '删除',
  deletePrompt: CALL_DELETE_PROMPT,
  deleteConfirm: CALL_DELETE_CONFIRM_LABEL,
} as const;

/**
 * S30: 删除一条通话记录（`DELETE /calls/:id`，204 空体）。
 *
 * The 409 the server raises while the call, its recording archive or its transcript job is still live is the one
 * failure a reader can act on — "try again in a moment" — so it is translated here rather than shown as a raw
 * server message. `ApiFailure` lives inside `main.tsx` and cannot be imported, so the shape is duck-typed.
 */
export async function deleteCallRecord(request: ApiRequest, callId: string): Promise<void> {
  try {
    await request<unknown>(`/calls/${encodeURIComponent(callId)}`, undefined, 'DELETE');
  } catch (caught) {
    const failure = caught as {status?: number; code?: string};
    if (failure?.status === 409 || failure?.code === 'CALL_IN_USE') throw new Error(CALL_DELETE_IN_USE_MESSAGE);
    throw caught;
  }
}

const DIAL_CHARACTERS = new Set('0123456789*#+');

export function normalizedDialNumber(value: string): string {
  let result = '';
  for (const character of value.trim()) {
    if (DIAL_CHARACTERS.has(character)) result += character;
  }
  return result;
}

export function isEmergencyServiceNumber(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits === '112' || digits === '911';
}

function hasRemoteAndSIM(remoteNumber: string | undefined, simId: string | undefined): boolean {
  return Boolean(remoteNumber && normalizedDialNumber(remoteNumber) && simId);
}

export function canRedial(
  remoteNumber: string | undefined,
  simId: string | undefined,
  mediaLive: boolean,
): boolean {
  return hasRemoteAndSIM(remoteNumber, simId) && !mediaLive;
}

export function canSendSMS(remoteNumber: string | undefined, simId: string | undefined): boolean {
  return hasRemoteAndSIM(remoteNumber, simId);
}

export function canBlock(remoteNumber: string | undefined): boolean {
  if (!remoteNumber || !normalizedDialNumber(remoteNumber)) return false;
  return !isEmergencyServiceNumber(remoteNumber);
}
