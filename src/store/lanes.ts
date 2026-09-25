/**
 * Which connections a transaction may use (GY-274). `lease` renewals — a worker's heartbeat, an
 * executor's claim renewal — run on a small pool of their own, so a saturated main pool can never
 * make a live worker's lease lapse. `background` work — the reconciliation tick — may hold at
 * most half of the main pool's connections at once, so a slow tick (the first one after a deploy
 * ran 65 s) always leaves requests the rest.
 */
export type StoreLane = 'request' | 'lease' | 'background';
/** Connections reserved for lease renewals beside the main pool. */
export const leaseLaneConnections = 2;

/** A counting semaphore over the background share of the pool. */
export class BackgroundLane {
  private held = 0;
  private waiting: (() => void)[] = [];
  constructor(readonly limit: number) {}
  /** Background connections held right now; never more than `limit`. */
  get inUse() { return this.held; }
  async acquire() {
    if (this.held >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.held++;
    let released = false;
    return () => {
      if (released) return; released = true;
      // A waiter inherits the permit directly, so the count never dips below what is held.
      const next = this.waiting.shift();
      if (next) next(); else this.held--;
    };
  }
}
