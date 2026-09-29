/** Poll cadence while a call of this account is still being set up (S20 D5). */
export const SETTLING_DASHBOARD_REFRESH_MS = 1000;
/** Poll cadence when nothing is being set up: idle, talking, or only finished calls. */
export const IDLE_DASHBOARD_REFRESH_MS = 2000;
/**
 * Non-terminal, non-`active` call states: dialing, ringing, being answered, ending, or still connecting media.
 * `active` stays on the slow cadence because a talking call changes nothing until it ends, and `unknown`
 * is excluded on purpose so one unresolved record cannot pin the dashboard to the fast cadence forever.
 */
const SETTLING_CALL_STATES = ['outgoing_pending', 'incoming_ringing', 'connecting', 'ending'];

/**
 * Refresh interval for the dashboard poll loop.
 *
 * `/calls` is already filtered to this account, so every settling call in the list is one this user is waiting on.
 */
export function dashboardRefreshIntervalMs(calls: readonly {state: string}[]): number {
  return calls.some(call => SETTLING_CALL_STATES.includes(call.state))
    ? SETTLING_DASHBOARD_REFRESH_MS
    : IDLE_DASHBOARD_REFRESH_MS;
}

export type DashboardRefreshSources<S, C, M> = {
  epoch: () => number;
  loadSims: () => Promise<S>;
  loadCalls: () => Promise<C>;
  loadMessages: () => Promise<M>;
  applySims: (value: S) => void;
  applyCalls: (value: C) => void;
  applyMessages: (value: M) => void;
};

/** Applies successful dashboard resources independently and coalesces refresh bursts. */
export class DashboardRefreshCoordinator<S, C, M> {
  private readonly sources: DashboardRefreshSources<S, C, M>;
  private sequence = 0;
  private queued = false;
  private inFlight: Promise<boolean> | null = null;

  constructor(sources: DashboardRefreshSources<S, C, M>) { this.sources = sources; }

  invalidate() {
    this.sequence++;
    this.queued = false;
  }

  request(): Promise<boolean> {
    if (this.inFlight) {
      this.queued = true;
      return this.inFlight;
    }
    const operation = this.drain();
    const tracked = operation.finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private async drain(): Promise<boolean> {
    let applied = false;
    let lastError: unknown;
    do {
      this.queued = false;
      try {
        applied = (await this.once()) || applied;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
    } while (this.queued);
    if (lastError !== undefined) throw lastError;
    return applied;
  }

  private async once(): Promise<boolean> {
    const epoch = this.sources.epoch();
    const sequence = ++this.sequence;
    const current = () => epoch === this.sources.epoch() && sequence === this.sequence;
    const apply = async <T>(load: () => Promise<T>, commit: (value: T) => void) => {
      const value = await load();
      if (!current()) return false;
      commit(value);
      return true;
    };
    const results = await Promise.allSettled([
      apply(this.sources.loadSims, this.sources.applySims),
      apply(this.sources.loadCalls, this.sources.applyCalls),
      apply(this.sources.loadMessages, this.sources.applyMessages),
    ]);
    if (epoch !== this.sources.epoch() || sequence !== this.sequence) return false;
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return results.some(result => result.status === 'fulfilled' && result.value);
  }
}
