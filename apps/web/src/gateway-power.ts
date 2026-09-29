/**
 * 远程开关 (待命信标) labels and error mapping (S21 §D).
 *
 * The gateway is reachable in two different ways: a normal heartbeat while it is ON, and a standby beacon
 * while it is OFF but the user allowed remote power-on on the gateway device. "在线" and "待命中" are therefore
 * different states, and every field of `GatewayPowerDto` is optional here because an older Control has no
 * `/gateways/power` route at all.
 */

export type GatewayPowerResult = {
  desired?: string | null;
  ok?: boolean;
  reason?: string | null;
  at?: string | null;
};

export type GatewayPowerDto = {
  gatewayId: string;
  name?: string | null;
  controlEnabled?: boolean;
  online?: boolean;
  lastSeenAt?: string | null;
  standbyOnline?: boolean;
  standbySeenAt?: string | null;
  remotePowerAllowed?: boolean;
  desiredPower?: string | null;
  desiredPowerRequestedAt?: string | null;
  lastPowerResult?: GatewayPowerResult | null;
  occupied?: boolean;
  /** S58：'pixel' | 'dji4g'，只选文字。 */
  kind?: string | null;
};

/** §D: a queued desire that nothing picked up within two minutes is treated as gone. */
export const DESIRED_POWER_EXPIRY_MS = 120_000;
/** §F asks every client to poll the power view on its own 5 s cadence. */
export const GATEWAY_POWER_REFRESH_MS = 5000;

export type GatewayPowerStatus = 'online' | 'standby' | 'offline';

export function gatewayPowerStatus(item: GatewayPowerDto): GatewayPowerStatus {
  if (item.online) return 'online';
  if (item.standbyOnline) return 'standby';
  return 'offline';
}

export function gatewayPowerStatusLabel(item: GatewayPowerDto): string {
  const status = gatewayPowerStatus(item);
  return status === 'online' ? '在线' : status === 'standby' ? '待命中' : '离线';
}

export function remotePowerAllowedLabel(item: GatewayPowerDto): string {
  return item.remotePowerAllowed ? '远程开启已允许' : '远程开启未允许（需在网关设备上打开）';
}

/** True while a request is still queued for the gateway to pick up. */
export function gatewayPowerPending(item: GatewayPowerDto, now: number = Date.now()): boolean {
  if (item.desiredPower !== 'on' && item.desiredPower !== 'off') return false;
  const requested = item.desiredPowerRequestedAt ? Date.parse(item.desiredPowerRequestedAt) : NaN;
  if (Number.isNaN(requested)) return true;
  return now - requested < DESIRED_POWER_EXPIRY_MS;
}

export function gatewayPowerPendingLabel(item: GatewayPowerDto, now: number = Date.now()): string {
  if (!gatewayPowerPending(item, now)) return '';
  return item.desiredPower === 'on' ? '正在开启…' : '正在关闭…';
}

const POWER_ERRORS: Record<string, string> = {
  GATEWAY_REMOTE_POWER_NOT_ALLOWED: '需要先在网关设备上打开“允许远程开启（待命）”。',
  GATEWAY_STANDBY_OFFLINE: '网关未在待命，无法远程开启；请在网关设备上开启网关。',
  GATEWAY_OFFLINE: '网关当前不在线，无法远程关闭。',
  GATEWAY_IN_USE: '网关正在通话中，暂时无法远程关闭。',
};

export function gatewayPowerErrorMessage(code: string | null | undefined, fallback = '操作失败'): string {
  return (code && POWER_ERRORS[code]) || fallback;
}

const POWER_REASONS: Record<string, string> = {
  call_in_progress: '网关上正在通话，已忽略关闭请求',
  permission_denied: '网关缺少必要权限',
  feature_gate_blocked: '网关的功能门未通过',
  not_provisioned: '网关尚未完成配对',
  standby_stopped: '待命通道已停止',
};

export function powerResultReasonText(reason: string | null | undefined): string {
  if (!reason) return '';
  return POWER_REASONS[reason] || reason;
}

/** Last remote attempt as one readable line, or empty when the server never recorded one. */
export function lastPowerResultText(result: GatewayPowerResult | null | undefined): string {
  if (!result || (result.ok === undefined && !result.reason && !result.desired)) return '';
  const action = result.desired === 'on' ? '远程开启' : result.desired === 'off' ? '远程关闭' : '远程操作';
  if (result.ok) return `${action}已成功`;
  const reason = powerResultReasonText(result.reason);
  return reason ? `${action}未成功：${reason}` : `${action}未成功`;
}

export type GatewayPowerToggle = {
  desired: 'on' | 'off';
  checked: boolean;
  disabled: boolean;
  hint: string;
};

/**
 * What the 网关总控 switch should do next.
 *
 * The server re-checks all of this, so these rules only avoid requests that are certain to fail: no standby
 * beacon means a remote power-on cannot reach the phone, and 远程 OFF stays blocked while a call holds the
 * gateway (§D 架构决策 6 — the remote user cannot see the phone).
 */
export function gatewayPowerToggle(item: GatewayPowerDto, now: number = Date.now()): GatewayPowerToggle {
  const online = Boolean(item.online);
  const pending = gatewayPowerPending(item, now);
  const desired: 'on' | 'off' = online ? 'off' : 'on';
  if (!item.remotePowerAllowed) {
    return {desired, checked: online, disabled: true, hint: remotePowerAllowedLabel(item)};
  }
  if (pending) {
    return {desired, checked: online, disabled: true, hint: gatewayPowerPendingLabel(item, now)};
  }
  if (!online && !item.standbyOnline) {
    return {desired, checked: false, disabled: true, hint: '网关未在待命，无法远程开启。'};
  }
  if (online && item.occupied) {
    return {desired, checked: true, disabled: true, hint: '通话进行中，暂不可远程关闭。'};
  }
  return {desired, checked: online, disabled: false, hint: online ? '关闭后网关设备恢复本地通话。' : '开启后网关重新连接服务器。'};
}
