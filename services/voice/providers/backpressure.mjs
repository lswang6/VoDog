/**
 * S27（2026-09-12 真实来电修正）：两个适配器共用的上行背压判据。
 *
 * WebSocket 发送缓冲超过软上限只说明"这一刻发不出去"，不说明这通电话完了——relay-secondary 的公网口与
 * 用户自己的代理共享且长期饱和，xAI 那条链路还要跨境走 sing-box 隧道，几十毫秒级的拥塞很常见。
 * 早先把它直接当 fault，导致一通正常的豆包通话在第 34 秒被 `provider_failed` 掐断（失败记录 4）。
 * 现在的语义：软线以上只丢上行、不发包；持续 BACKPRESSURE_FAULT_MS 或冲破硬线才算真故障。
 *
 * 三个阈值放在这里而不是各写一份，是因为两家供应商的判据一旦漂移，`provider_notice` 里同名的
 * 日志就不再代表同一件事，事后没法拿同一把尺子比两条链路。
 */
export const BACKPRESSURE_SOFT_BYTES = 64_000;
export const BACKPRESSURE_HARD_BYTES = 512_000;
export const BACKPRESSURE_FAULT_MS = 5_000;

/**
 * 纯函数：这一刻该 `send`（正常发）、`drop`（只丢这一批，通话继续）还是 `fatal`（链路判死）。
 * 一次拥塞"从什么时候开始"和"通知过没有"这两个状态留在适配器自己的字段上
 * （`backpressureSinceMs` / `backpressureNotified`），helper 不持有任何状态：
 * 豆包在节拍器里按 tick 问、xAI 在 `appendAudio` 里按批问，节奏不同但判据必须同一份，
 * 而且测试可以直接改 `agent.backpressureSinceMs` 造出"已经堵了 5 秒"的场景。
 *
 * 返回的 `notify` 表示"这一段拥塞还没通知过"（一段拥塞只发一条 notice，不是每 tick 一条），
 * `cleared` 表示"上一刻还在堵、现在退下去了"，`sinceMs` 是调用方要写回的新起始时刻。
 */
export function backpressureCheck({ bufferedAmount, now, sinceMs, notified } = {}) {
  if (bufferedAmount > BACKPRESSURE_SOFT_BYTES) {
    const startedMs = sinceMs ?? now;
    const fatal = now - startedMs >= BACKPRESSURE_FAULT_MS || bufferedAmount > BACKPRESSURE_HARD_BYTES;
    return { action: fatal ? 'fatal' : 'drop', sinceMs: startedMs, notify: !notified, cleared: false };
  }
  return { action: 'send', sinceMs: undefined, notify: false, cleared: sinceMs !== undefined };
}
