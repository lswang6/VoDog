export const GATEWAY_DELETE_PROMPT =
  '只能删除尚未产生通话、命令或防重记录的测试网关。若网关仍被占用或已有历史，服务器会拒绝删除，不会先结束通话再删除。';
export const PASSKEY_DELETE_PROMPT = '确定删除这把通行密钥？删除后无法再用它登录。';
/** Ending another device's answered call for this account (S20 D6). */
export const CALL_RELEASE_PROMPT = '将挂断本账号在另一台设备上的通话。确认后这通电话立即结束。';
/** The same button on a still-ringing call rejects it for every device of this account, so the copy says 拒接. */
export const CALL_REJECT_PROMPT = '将替本账号的所有设备拒接这通来电。确认后来电停止振铃。';
export const CALL_RELEASE_CONFIRM_LABEL = '确认结束';
export const CALL_REJECT_CONFIRM_LABEL = '确认拒接';
/**
 * S30 删除：一条通话记录连同它的录音、转写与报告条目一起消失，服务端没有回收站。
 *
 * The prompt names every artefact that goes with the row, because 报告 is a separate tab and a reader who only
 * sees 全部通话 would otherwise not know the report entry disappears too.
 */
export const CALL_DELETE_PROMPT = '删除这条通话记录？录音、转写、报告条目和手机上的通话记录会一起删除，无法恢复。';
export const CALL_DELETE_CONFIRM_LABEL = '确认删除';
/** Control answers 409 `CALL_IN_USE` while the call, its recording archive or its transcript job is still live. */
export const CALL_DELETE_IN_USE_MESSAGE = '通话仍在进行或处理中，稍后再删';
export const CONVERSATION_DELETE_PROMPT = '删除这段对话？这个号码的全部短信都会被删除，无法恢复。';
export const CONVERSATION_DELETE_AND_BLOCK_PROMPT =
  '删除这段对话并屏蔽该号码的短信？全部短信会被删除且无法恢复，之后该号码的短信不会进入收件箱，会记在拦截记录里。';
export const MESSAGES_DELETE_PROMPT = '删除选中的短信？删除后无法恢复。';
export const MESSAGES_DELETE_CONFIRM_LABEL = '确认删除';
