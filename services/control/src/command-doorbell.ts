import type { Db } from './db.js';

/**
 * In-process wake-up table for the gateway command long poll (S20 D4).
 *
 * The gateway polls `/gateway/heartbeat` every 2 s (8 s while backing off), which is the only pure
 * polling hop left in the command path. The doorbell lets the gateway suspend one cheap request per
 * gateway; any path that inserts a command rings it after its transaction committed, so dial/answer/
 * hangup reach the device in about one RTT instead of up to a full poll interval.
 *
 * Invariants:
 * - registration happens before the "is a command already waiting" read, so a command inserted
 *   between the read and the wait still wakes the caller;
 * - at most one waiter per gateway (a newer request ends the older one with `wake:false`), so the
 *   table is bounded by the number of paired gateways;
 * - no pg connection or transaction is held while a waiter sleeps.
 */
type Settleable = { settle(woken: boolean): void };

/** Anything with Node's EventEmitter surface; `reply.raw` and the request socket both qualify. */
type CloseSource = {
  on(event: 'close', listener: () => void): unknown;
  removeListener?(event: 'close', listener: () => void): unknown;
  destroyed?: boolean;
};

export class DoorbellWaiter implements Settleable {
  private settled = false;
  private woken = false;
  private timer: NodeJS.Timeout | null = null;
  private resolve: ((woken: boolean) => void) | null = null;
  private detach: (() => void) | null = null;
  constructor(
    private readonly doorbell: CommandDoorbell,
    private readonly gatewayId: string,
  ) {}

  settle(woken: boolean) {
    if (this.settled) return;
    this.settled = true;
    this.woken = woken;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.detach) { this.detach(); this.detach = null; }
    this.doorbell.release(this.gatewayId, this);
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(woken);
  }

  /**
   * Waits up to `holdMs` for a command insert, a client disconnect, or shutdown.
   *
   * `request.raw`'s own `close` is NOT a disconnect signal: Node's IncomingMessage emits it as soon
   * as the request body has been consumed, which is immediately for every JSON request. The client
   * going away is observable on the response stream and on the socket, so both are watched.
   */
  async wait(holdMs: number, ...closeSources: (CloseSource | null | undefined)[]): Promise<boolean> {
    if (this.settled) return this.woken;
    if (holdMs <= 0) { this.settle(false); return this.woken; }
    if (closeSources.some((source) => source?.destroyed === true)) { this.settle(false); return this.woken; }
    return new Promise<boolean>((resolve) => {
      this.resolve = resolve;
      this.timer = setTimeout(() => this.settle(false), holdMs);
      const aborted = () => this.settle(false);
      const attached = closeSources.filter((source): source is CloseSource => typeof source?.on === 'function');
      for (const source of attached) source.on('close', aborted);
      this.detach = () => {
        for (const source of attached) source.removeListener?.('close', aborted);
      };
    });
  }

  dispose() { this.settle(false); }
}

export class CommandDoorbell {
  private readonly waiters = new Map<string, DoorbellWaiter>();

  /** Test/diagnostic hook: number of suspended doorbell requests, optionally for one gateway. */
  waiterCount(gatewayId?: string): number {
    return gatewayId === undefined ? this.waiters.size : this.waiters.has(gatewayId) ? 1 : 0;
  }

  /** Registers the listener. Must be called before the pending-command read, never inside a transaction. */
  listen(gatewayId: string): DoorbellWaiter {
    this.waiters.get(gatewayId)?.settle(false);
    const waiter = new DoorbellWaiter(this, gatewayId);
    this.waiters.set(gatewayId, waiter);
    return waiter;
  }

  /** Rings the doorbell. Only ever called after the inserting transaction has committed. */
  notify(gatewayId: string) {
    this.waiters.get(gatewayId)?.settle(true);
  }

  release(gatewayId: string, waiter: DoorbellWaiter) {
    if (this.waiters.get(gatewayId) === waiter) this.waiters.delete(gatewayId);
  }

  /** Server shutdown: nobody is left holding a request open. */
  closeAll() {
    for (const waiter of [...this.waiters.values()]) waiter.settle(false);
    this.waiters.clear();
  }
}

/**
 * Same delivery predicate the heartbeat uses to return `commands`, narrowed to the
 * pending-and-unexpired subset (reconciliation of already expired commands is a heartbeat-only
 * concern and must not ring the doorbell). Runs outside any transaction on a pooled client.
 */
export async function hasDeliverableCommand(db: Db, gatewayId: string): Promise<boolean> {
  const q = await db.query(
    `SELECT 1 FROM gateways g
       JOIN commands cmd ON cmd.gateway_id=g.id AND cmd.generation=g.device_epoch
       LEFT JOIN gateway_command_replay_horizons h ON h.gateway_id=g.id AND h.generation=g.device_epoch
      WHERE g.id=$1 AND g.control_enabled AND COALESCE(h.state,'ready')='ready'
        AND cmd.status='pending' AND cmd.expires_at>now()
        AND cmd.sequence>=COALESCE(h.committed_floor,1)
        AND ((cmd.kind='send_sms' AND g.sms_ready) OR cmd.kind='apply_sim_settings' OR cmd.kind='hangup'
          OR (cmd.kind NOT IN ('send_sms','apply_sim_settings','hangup') AND g.telephony_ready))
        AND NOT EXISTS (SELECT 1 FROM gateway_command_replay_migrations m
          WHERE m.gateway_id=g.id AND m.state='committed' AND m.confirmed_at IS NULL)
      LIMIT 1`,
    [gatewayId],
  );
  return q.rowCount !== 0;
}
