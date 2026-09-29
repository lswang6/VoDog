/**
 * S24 决策 3 设置页「AI 语音服务」分组的全部判断。
 *
 * iOS (`VoiceProviderPolicy.swift`) 是三端参考实现；这里的文案、状态语义和禁用逻辑与它以及 Android 的
 * `VoiceProviderPolicy.kt` 逐条对齐。两个布尔位来自两个来源：`configured` 是 Control 的
 * `AI_VOICE_PROVIDERS`（这台服务器允许哪些供应商），`online` 是 Voice worker 心跳宣告的 `providers`。
 * 缺配置永远压过离线——没配好的供应商即使有心跳也切不过去，所以状态先看 `configured`。
 *
 * Every field is optional: a Control that predates S24 has no route at all, and a partial object must read
 * as 未配置 rather than inviting a switch the server would refuse.
 */

export type VoiceProviderDto = {
  id: string;
  label?: string | null;
  configured?: boolean;
  online?: boolean;
};

export type VoiceProviderListDto = {
  items?: VoiceProviderDto[];
  selected?: string | null;
  configVersion?: number;
};

export type VoiceProviderAvailability = 'available' | 'not_configured' | 'offline';

/** 分组底部说明：切换只改之后新建的 AI run，进行中的通话不受影响。 */
export const VOICE_PROVIDER_FOOTER = '切换只影响之后的 AI 即接 / 超时代接来电。';

export function voiceProviderAvailability(item: VoiceProviderDto): VoiceProviderAvailability {
  if (!item.configured) return 'not_configured';
  return item.online ? 'available' : 'offline';
}

/** iOS/Android 印同样的三个词。 */
export function voiceProviderStatusLabel(item: VoiceProviderDto): string {
  const availability = voiceProviderAvailability(item);
  return availability === 'available' ? '可用' : availability === 'not_configured' ? '未配置' : '服务离线';
}

/** 空串表示这一项可以选；否则就是不能选的原因，直接作为副标题显示。 */
export function voiceProviderDisabledReason(item: VoiceProviderDto): string {
  const availability = voiceProviderAvailability(item);
  if (availability === 'available') return '';
  return availability === 'not_configured' ? '服务器未配置这个语音服务' : '语音服务当前离线，暂时无法切换';
}

export function voiceProviderSelectable(item: VoiceProviderDto): boolean {
  return voiceProviderDisabledReason(item) === '';
}

export function voiceProviderLabel(item: VoiceProviderDto): string {
  const label = (item.label || '').trim();
  return label || item.id;
}

/** 被选中的供应商可能同时不可用（worker 掉线），勾还是要显示：它仍然是服务器上的设置。 */
export function voiceProviderSelected(item: VoiceProviderDto, selected: string | null | undefined): boolean {
  return Boolean(selected) && selected === item.id;
}

/** 是否值得发 PUT：不可用的不发，已经是当前选择的也不发（避免多一条审计记录）。 */
export function voiceProviderShouldSubmit(
  item: VoiceProviderDto,
  selected: string | null | undefined,
): boolean {
  return voiceProviderSelectable(item) && !voiceProviderSelected(item, selected);
}

/** Normalises what the routes answer so the panel never has to guard on `items` being absent. */
export function voiceProviderList(payload: VoiceProviderListDto | null | undefined): {
  items: VoiceProviderDto[];
  selected: string;
  configVersion: number;
} {
  return {
    items: Array.isArray(payload?.items) ? payload.items.filter(item => typeof item?.id === 'string' && item.id) : [],
    selected: (payload?.selected || '').trim(),
    configVersion:
      Number.isInteger(payload?.configVersion) && Number(payload?.configVersion) > 0
        ? Number(payload?.configVersion)
        : 1,
  };
}

/** 409 的兜底文案。服务器的 `message` 优先，这里只在 message 为空时用——与 iOS/Android 一致。 */
export function voiceProviderErrorMessage(
  code: string | null | undefined,
  serverMessage?: string | null,
): string {
  const message = (serverMessage || '').trim();
  if (message) return message;
  if (code === 'PROVIDER_UNAVAILABLE') return '这个语音服务当前不可用（未配置或服务离线），已保留原来的选择。';
  return '切换语音服务失败，请稍后重试。';
}
