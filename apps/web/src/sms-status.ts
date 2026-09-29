const states: Record<string, string> = {queued:'等待发送',sending:'发送中',sent:'已发送',delivered:'已送达',received:'已接收',failed:'发送失败',unknown:'状态待确认'};
export function smsStatusLabel(message: {state: string; failureReason?: string | null}): string {
  if (message.state === 'queued' && message.failureReason === 'sms_gateway_execution_unresolved') return '等待上一条短信状态确认';
  if (message.state === 'unknown' && message.failureReason === 'sms_execution_unresolved') return '发送状态待确认，请勿重复发送';
  if (message.state === 'failed' && message.failureReason === 'sms_not_dispatched') return '发送失败，短信尚未下发';
  if (message.state === 'failed' && message.failureReason === 'sms_route_changed_before_release') return '发送失败，发送号码已变更';
  return states[message.state] || message.state;
}
