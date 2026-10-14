// Concern: waking the sleeping master loop the moment the dispatcher tick sees work the loop acts on (GY-1490).
import type { Work } from '../model.js';
import { assertDispatchable, finishedAgentStates, type HerdrAgent, type MasterConfig } from '../master.js';
import { neededDecision } from './decisions.js';

/*
 * GY-1490. A loop whose last cycle found nothing actionable sleeps `run.intervalSeconds` (300 s on
 * this project), and the dispatcher beside it ticks every `run.dispatchIntervalSeconds` (10 s) but
 * never woke it. Measured over the 88 items merged in the 24 h to 2026-10-07 23:40Z, that sleep was
 * the largest avoidable part of three waits the delivery budget judges:
 *
 *   - ready→first push: an executor refuses a scope request in a second or two, and the loop's
 *     grounded widening (cycle-scope.ts) then waited out the sleep — 372 of 3,183 worker-minutes,
 *     2–5 min per ask (GY-1462: asked 15:30:59, widened by the next cycle at 15:36:04);
 *   - approval→merge: a standing verdict waits for the loop's decision step to request its round,
 *     and eleven verdict→rework waits sat at 5.0–5.7 min, one sleep each;
 *   - ready→claim: a worker slot that frees while ready work waits is filled by the loop's dispatch
 *     step only at its next cycle.
 *
 * The tick already reads the snapshot and Herdr's agents every 10 s. `loopWakeSubjects` names, from
 * those, what the loop's next cycle would act on, and `LoopWake.observe` wakes the sleep for every
 * subject it does not already hold, so a subject wakes the loop once rather than every tick, and no
 * sooner than one dispatch tick after the cycle before (GY-1490 review).
 */

/** One thing the loop's next cycle acts on, keyed so the same standing subject is never a second wake. */
export interface LoopSubject { key: string; reason: string }

type WakeConfig = Pick<MasterConfig, 'workers' | 'autoMerge'> & Partial<Pick<MasterConfig, 'reviewRoundCap' | 'reviewer'>>;

/**
 * What the loop's next cycle acts on, read from one tick's snapshot and agent list: a claimable
 * item (its dispatch step), a launch profile free while one waits (the slot it fills), a scope
 * request open or refused on a live lease (its widening on grounds), and a routine decision the
 * item needs (a verdict's rework, a conflict, a recovery). An unreadable Herdr names no free slot.
 */
export function loopWakeSubjects(work: readonly Work[], config: WakeConfig, now: number, agents: readonly HerdrAgent[] | null): LoopSubject[] {
  const at = new Date(now).toISOString(), all = work as Work[], subjects: LoopSubject[] = [];
  const open = work.filter(item => item.stage !== 'done');
  const live = (item: Work) => !!item.lease && Date.parse(item.lease.expiresAt) > now;
  const claimable = open.filter(item => { try { assertDispatchable(item, all, at); return true; } catch { return false; } });
  for (const item of claimable) subjects.push({ key: `dispatch:${item.key}:${item.epoch}`, reason: `${item.key} is claimable` });
  if (claimable.length && agents) for (const profile of config.workers.filter(entry => entry.mode === 'launch')) {
    const working = agents.some(agent => agent.name === profile.agentName && !finishedAgentStates.includes(agent.agent_status ?? ''));
    const leased = open.some(item => live(item) && item.lease!.owner === profile.principal);
    if (!working && !leased) subjects.push({ key: `slot:${profile.name}`, reason: `worker profile ${profile.name} is free while ${claimable[0].key} waits` });
  }
  for (const item of open) {
    const request = item.scopeRequest;
    if (!request || !live(item) || item.lease!.epoch !== request.epoch || request.decision?.state === 'approved') continue;
    subjects.push({ key: `scope:${item.key}:${request.epoch}:${request.at}:${request.decision?.state ?? 'open'}`, reason: `${item.key}'s scope request is ${request.decision ? 'refused and waits on its grounds' : 'open'}` });
  }
  for (const item of work) {
    let decision: ReturnType<typeof neededDecision> = null;
    try { decision = neededDecision(item, config); } catch { continue; }
    if (decision) subjects.push({ key: `decision:${item.key}:${decision.action}:${decision.binding}`, reason: `${item.key} needs a ${decision.action} decision` });
  }
  return subjects;
}

/** The most reasons one wake carries into the loop's log line; the newest are kept. */
export const loopWakeReasonLimit = 20;

/**
 * The least a woken sleep lasts after the cycle before it, by default one tick at the dispatcher's
 * default cadence (`run.dispatchIntervalSeconds`, 10 s; `master run` passes the configured one). However
 * many subjects the ticks see, woken cycles stand at least that far apart, so the per-cycle reads and
 * refreshes the system invariants bound grow by a known factor at most, never to back-to-back cycles.
 */
export const loopWakeFloorMs = 10_000;

/** How many consecutive ticks a subject is absent before it is forgotten, and could wake the loop again. */
export const loopWakeForgetTicks = 2;

/**
 * The loop's sleep between cycles, which the dispatcher can end early, never before `floorMs` after
 * the cycle. A wake that lands while the loop is cycling is kept for the next sleep: the running cycle
 * may have read its snapshot before the subject appeared. The first observation only records what
 * stands — the loop cycles on start anyway — and a subject that stays is never a second wake, nor one
 * absent for a single tick (Herdr unreadable once, an agent status that flips): only a subject absent
 * `loopWakeForgetTicks` ticks in a row is forgotten.
 */
export class LoopWake {
  private seen: Map<string, number> | null = null;
  private pending: string[] = [];
  private release: (() => void) | null = null;
  constructor(private readonly floor: number | (() => number) = loopWakeFloorMs) {}
  get floorMs(): number { return typeof this.floor === 'function' ? this.floor() : this.floor; }

  /** Record one tick's subjects; wakes the loop for those it does not hold, and returns them. */
  observe(subjects: readonly LoopSubject[]): LoopSubject[] {
    const present = new Map(subjects.map(subject => [subject.key, subject]));
    const fresh = this.seen ? [...present.values()].filter(subject => !this.seen!.has(subject.key)) : [];
    const seen = new Map<string, number>();
    for (const [key, absent] of this.seen ?? []) if (!present.has(key) && absent + 1 < loopWakeForgetTicks) seen.set(key, absent + 1);
    for (const key of present.keys()) seen.set(key, 0);
    this.seen = seen;
    if (fresh.length) this.wake(fresh.map(subject => subject.reason));
    return fresh;
  }

  wake(reasons: readonly string[]) {
    this.pending = [...this.pending, ...reasons].slice(-loopWakeReasonLimit);
    this.release?.();
  }

  /** Whether a sleep of `waitMs` that has lasted `sleptMs` ends now: its wait is over, or it is woken and past the floor. */
  due(sleptMs: number, waitMs: number): boolean {
    return sleptMs >= waitMs || (this.pending.length > 0 && sleptMs >= Math.min(waitMs, this.floorMs));
  }

  /** The wake's reasons, cleared: the cycle about to run acts on them. */
  take(): string[] {
    const reasons = this.pending;
    this.pending = [];
    return reasons;
  }

  /** Sleep up to `ms`, or until woken (never before the floor) or `signal` aborts; answers the wake's reasons, empty when none woke it. */
  async sleep(ms: number, signal?: AbortSignal): Promise<string[]> {
    const started = Date.now(), floor = Math.min(ms, this.floorMs);
    if (!signal?.aborted) await new Promise<void>(resolve => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); this.release = null; resolve(); };
      const end = (at: number) => { clearTimeout(timer); timer = setTimeout(done, Math.max(0, at - Date.now())); };
      end(started + ms);
      this.release = () => end(started + floor);
      if (this.pending.length) this.release();
      signal?.addEventListener('abort', done, { once: true });
    });
    return this.take();
  }
}
