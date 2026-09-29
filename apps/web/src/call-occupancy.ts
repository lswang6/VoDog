import {
  CALL_REJECT_CONFIRM_LABEL,
  CALL_REJECT_PROMPT,
  CALL_RELEASE_CONFIRM_LABEL,
  CALL_RELEASE_PROMPT,
} from './confirm-copy.ts';
import {formatCompactCallDate, gatewayDisplayTimeZone} from './gateway-time.ts';
import {gatewayKindLabel} from './gateway-kind.ts';

/**
 * Server-side occupancy of the Pixel gateway for one call (S20 D6, additive).
 *
 * Every field is authoritative when present; the whole object is optional so an older server
 * simply leaves the client on its previous state-derived guess.
 */
export type CallOccupancy = {
  /** Whether this call currently holds the `gateway_call_locks` row. Terminal calls never do. */
  holdsLock: boolean;
  /** `locks.acquired_at` in RFC 3339, or null when the lock has already been released. */
  lockedSince: string | null;
  /** `answeredByPlatform ?? originatingPlatform` of the occupant. */
  occupantPlatform: 'ios' | 'android' | 'macos' | 'web' | 'ai' | 'pixel' | 'device' | null;
  /** `answeredByDevice` of the occupant. */
  occupantDevice: string | null;
  /** Whether this browser session is the originator or the answering winner. */
  isCurrentSession: boolean;
  /** Whether this caller may end the call (snapshot owner, call not terminal). */
  canRelease: boolean;
};

export type OccupiableCall = {
  id: string;
  simId: string;
  state: string;
  startedAt: string;
  answeredByPlatform?: string;
  originatingPlatform?: string;
  answeredByDevice?: string;
  claimedByCurrentSession?: boolean;
  gatewayTimeZone?: string | null;
  /** S58：只选文字（Pixel / DJI 4G 模组），缺失按 Pixel。 */
  gatewayKind?: string | null;
  occupancy?: CallOccupancy;
  /** `mode_snapshot` of the SIM when the call arrived (S22 决策 4); absent on an older Control. */
  answerMode?: string;
  /** Whether an AI run is still the one answering this ringing call (S22 决策 4). */
  aiHandling?: boolean;
  aiTriggerAt?: string | null;
  /** S72：缺失（旧 Control）按非内部。 */
  direction?: string;
  internal?: boolean;
  peerSimLabel?: string | null;
};

/** S72 E：「内部通话 主叫卡 → 被叫卡」；呼入腿的 peer 是主叫卡，呼出腿的 peer 是被叫卡。 */
export function internalCallRoute(call: {direction?: string; peerSimLabel?: string | null}, ownLabel?: string | null): string {
  const peer = (call.peerSimLabel ?? '').trim() || '另一张卡';
  const own = (ownLabel ?? '').trim() || '本卡';
  return call.direction === 'outgoing' ? `${own} → ${peer}` : `${peer} → ${own}`;
}

const TERMINAL_CALL_STATES = ['ended', 'failed'];

/** The status shown instead of 接听/拒接 while the AI answers (S22 客户端合同). */
export const AI_ANSWERING_LABEL = 'AI 接听中';

/**
 * The three-client suppression rule (S22 决策 4, R2 §2.1): `answerMode==='ai' && aiHandling`.
 *
 * `timeout_ai` deliberately fails this test — those calls keep ringing until the AI actually commits the
 * answer — so `aiHandling` alone is never enough, and an older Control (no fields) suppresses nothing.
 */
export function aiSuppressed(call: {answerMode?: string; aiHandling?: boolean} | null | undefined): boolean {
  return call?.answerMode === 'ai' && call?.aiHandling === true;
}

/** The ringing call the browser may ring for: suppressed calls are the AI's, and stay silent. */
export function audibleRingingCall<C extends {state: string; answerMode?: string; aiHandling?: boolean}>(
  calls: readonly C[],
): C | undefined {
  return calls.find(call => call.state === 'incoming_ringing' && !aiSuppressed(call));
}

/** 接听/拒接 belong to a ringing call only while a human is the one expected to answer it. */
export function offersAnswerControls(call: {state: string; answerMode?: string; aiHandling?: boolean}): boolean {
  return call.state === 'incoming_ringing' && !aiSuppressed(call);
}

function occupantPlatform(call: OccupiableCall): string {
  const platform = call.occupancy
    ? call.occupancy.occupantPlatform ?? ''
    : call.answeredByPlatform || call.originatingPlatform || '';
  // A call the AI is answering has no platform yet, but the occupant is known (S22 决策 4).
  if (!platform && aiSuppressed(call)) return 'ai';
  return platform;
}

function occupantDevice(call: OccupiableCall): string {
  return ((call.occupancy ? call.occupancy.occupantDevice : call.answeredByDevice) ?? '').trim();
}

/** Chinese occupant copy shared with the Android client (`ClientViewModel.kt:902-911` `callOccupancyLabel`). */
export function callOccupancyLabel(call: OccupiableCall): string {
  switch (occupantPlatform(call)) {
    case 'ios': return 'iPhone 端通话';
    case 'android': return 'Android 端通话';
    case 'macos': return 'Mac 端通话';
    case 'web': return '网页端通话';
    case 'ai': return 'AI 接听';
    // S38: 手机直拨的占用者是 Pixel 自己，列表行的「通过手机拨打」由 call-history-panel 提供。
    case 'pixel': return gatewayKindLabel(call.gatewayKind).occupied;
    case 'device': return '网关本机';
    default: return '处理另一通电话';
  }
}

/** Device-first occupant copy shared with the Android client (`ClientViewModel.kt:913-921` `callOwnerLabel`). */
export function callOwnerLabel(call: OccupiableCall): string | null {
  const device = occupantDevice(call);
  if (device) return device;
  switch (occupantPlatform(call)) {
    case 'ios': return 'iPhone 端';
    case 'android': return 'Android 端';
    case 'macos': return 'Mac 端';
    case 'web': return '网页端';
    case 'ai': return 'AI 接听';
    case 'pixel': return gatewayKindLabel(call.gatewayKind).occupied;
    case 'device': return '网关本机';
    default: return null;
  }
}

/** The lock time when the server reports one, otherwise the call start. */
export function occupancyStartedAt(call: OccupiableCall): string {
  return call.occupancy?.lockedSince ?? call.startedAt;
}

/** The server's verdict wins; without it the browser falls back to its own claim flag. */
export function isCurrentSessionOccupancy(call: OccupiableCall): boolean {
  return call.occupancy ? call.occupancy.isCurrentSession : call.claimedByCurrentSession === true;
}

/** Releasing is only offered for another session's call that this account is allowed to end. */
export function canReleaseOccupancy(call: OccupiableCall): boolean {
  return Boolean(call.occupancy?.canRelease && !call.occupancy.isCurrentSession);
}

const OCCUPANT_NAMES: Record<string, string> = {ios: 'iPhone 端', android: 'Android 端', macos: 'Mac 端', web: '网页端', device: '网关本机'};

/**
 * S72 A4/B5：「通话中 · 由 {占用者} 接听 · 自 {时间}」（呼出为「拨出」，振铃中为「来电振铃」），
 * 内部通话：「内部通话 · A → B · 由 {占用者} 接听 · 自 {时间}」。时间按网关墙钟显示。
 */
export function occupancyNotice(
  call: OccupiableCall,
  options: {timeZone?: string | null; currentSessionLabel?: string; simLabel?: string | null} = {},
): string {
  const platform = occupantPlatform(call);
  const occupant = isCurrentSessionOccupancy(call) && options.currentSessionLabel
    ? options.currentSessionLabel
    : occupantDevice(call) || OCCUPANT_NAMES[platform]
      || (platform === 'pixel' ? gatewayKindLabel(call.gatewayKind).device : platform === 'ai' ? 'AI' : '');
  const zone = gatewayDisplayTimeZone(call.gatewayTimeZone, options.timeZone);
  const since = `自 ${formatCompactCallDate(occupancyStartedAt(call), zone)}`;
  const head = call.internal ? `内部通话 · ${internalCallRoute(call, options.simLabel)}` : '通话中';
  if (!occupant) return `${call.internal ? head : call.state === 'incoming_ringing' ? '来电振铃' : '通话中'} · ${since}`;
  return `${head} · 由 ${occupant} ${call.direction === 'outgoing' ? '拨出' : '接听'} · ${since}`;
}

/**
 * The call occupying a gateway.
 *
 * `holdsLock` decides as soon as any call on that gateway carries occupancy; otherwise the browser keeps the
 * S17 derivation, where `incoming_ringing` counts as occupied exactly like the server's lock does.
 */
export function gatewayOccupiedCall<C extends OccupiableCall>(
  calls: readonly C[],
  sims: readonly {id: string; gatewayId: string}[],
  gatewayId: string | undefined,
): C | undefined {
  if (!gatewayId) return undefined;
  const onGateway = calls.filter(call => sims.find(sim => sim.id === call.simId)?.gatewayId === gatewayId);
  if (onGateway.some(call => call.occupancy)) return onGateway.find(call => call.occupancy?.holdsLock === true);
  return onGateway.find(call => !TERMINAL_CALL_STATES.includes(call.state));
}

/** A ringing call is rejected for the whole account, an answered one is hung up on the other device. */
export function releaseConfirmPrompt(call: OccupiableCall): string {
  return call.state === 'incoming_ringing' ? CALL_REJECT_PROMPT : CALL_RELEASE_PROMPT;
}

export function releaseConfirmLabel(call: OccupiableCall): string {
  return call.state === 'incoming_ringing' ? CALL_REJECT_CONFIRM_LABEL : CALL_RELEASE_CONFIRM_LABEL;
}
