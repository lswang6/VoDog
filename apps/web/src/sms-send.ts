import type {ApiRequest} from './contacts.ts';
import {browserSessionGeneration} from './session-boundary.ts';
import {OutboundAttempt} from './outbound-attempt.ts';
import {uniqueSmsRecipients} from './sms-recipient-policy.ts';
import type {ThreadMessage} from './message-threads.ts';

export type SmsBatchResult = {batchId: string; intervalSeconds: number; items: ThreadMessage[]};
/** Idempotency metadata is header-only; the strict batch body contains exactly simId, recipients and body. */
export async function enqueueSmsBatch({request, account, simId, recipients, body, storage, onSent, isCurrent = () => true}: {
  request: ApiRequest; account: string; simId: string; recipients: string[]; body: string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  isCurrent?: () => boolean;
  onSent?: (items: ThreadMessage[]) => void | Promise<void>;
}): Promise<SmsBatchResult> {
  const generation = browserSessionGeneration();
  const current = () => generation === browserSessionGeneration() && isCurrent();
  const numbers = uniqueSmsRecipients(recipients.map(number => ({number}))).map(item => item.number);
  if (!account || !simId || numbers.length < 2 || numbers.length > 100 || !body.trim() || body.length > 5000) throw new Error('请检查收件人、短信内容和所选号码');
  const payload = {simId, recipients: numbers, body};
  const attempt = new OutboundAttempt(storage, `vodog:sms-batch:${account}`);
  const key = await attempt.key(payload);
  if (!current()) throw new Error('登录状态已改变');
  const result = await request<SmsBatchResult>('/sms/batch', payload, 'POST', {idempotencyKey: key});
  // A malformed response is uncertain: retain the key and the original draft for safe replay.
  if (!result.batchId || !Array.isArray(result.items) || !result.items.length) throw new Error('短信受理状态待确认，请重试查询同一批次');
  attempt.confirmed(key);
  // Refresh failure must never turn an accepted batch into another logical send.
  try {if (current()) await onSent?.(result.items);} catch { /* Existing foreground refresh will reconcile the queue. */ }
  return result;
}
