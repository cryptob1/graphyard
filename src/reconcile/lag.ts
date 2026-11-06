

/** The event-loop lag sampler's timer interval (GY-1777); a sample is that timer's overrun past it. */
const eventLoopLagResolutionMs = 10;
/** The most samples one window keeps (GY-1777): ten minutes at the resolution; a longer window keeps its first ten minutes. */
const eventLoopLagSamples = 60_000;
/**
 * The event-loop lag over one reconciliation tick's window (GY-1777): a timer due every
 * `eventLoopLagResolutionMs` records how far past due it ran, the reading
 * `perf_hooks.monitorEventLoopDelay` gives, kept here because that histogram cannot be windowed
 * per tick (on Node 24 `reset()` stops it recording, and a histogram enabled after one was disabled
 * never fires). The timer holds the process open for nothing.
 */
export class EventLoopLag {
  private samples: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private due = 0;
  /** Open a window: samples from now on belong to it. */
  start() {
    this.stop();
    this.due = performance.now() + eventLoopLagResolutionMs;
    this.timer = setInterval(() => {
      const now = performance.now();
      if (this.samples.length < eventLoopLagSamples) this.samples.push(Math.max(0, now - this.due));
      this.due = now + eventLoopLagResolutionMs;
    }, eventLoopLagResolutionMs);
    this.timer.unref();
  }
  /**
   * The window's lag so far: p50 and max in ms, or null when the window holds no observation yet.
   * A sample exists only once its timer callback has run, so a hold of the loop that ended just
   * before this read — the callback that elapsed during it still queued behind the caller's own
   * work — would go unrecorded and the tick would read no lag at all (GY-1886). The overrun the
   * next callback is still owed counts beside the recorded samples, so a block is seen however the
   * event loop orders its read against the timers phase; when nothing is owed and no callback has
   * run, nothing has been observed and the read says so. Nothing owed is no observation, so it adds
   * no 0 ms sample to pull p50 below what the recorded callbacks saw.
   */
  read(): { p50: number; max: number } | null {
    const pending = this.timer ? Math.max(0, performance.now() - this.due) : 0;
    const sorted = (pending > 0 ? [...this.samples, pending] : [...this.samples]).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return { p50: Math.round(sorted[Math.ceil(sorted.length / 2) - 1]), max: Math.round(sorted[sorted.length - 1]) };
  }
  /** Close the window and forget its samples. */
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.samples = []; }
}
/**
 * The floor on how long reconciliation goes between full evaluations (GY-1867 stretches it past a
 * longer full pass): `GRAPHYARD_RECONCILE_FULL_MS`, 2000..300000 ms, default 300000 (GY-1873 — it
 * was 10000 under GY-1124, when nothing recorded when each item was next due; the per-item due
 * instants wake the clock-driven changes now, and the full evaluation is the rare safety net).
 */
export function configuredReconcileFullMs(value = process.env.GRAPHYARD_RECONCILE_FULL_MS, fallback = 300_000): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 2_000 && parsed <= 300_000 ? parsed : fallback;
}
