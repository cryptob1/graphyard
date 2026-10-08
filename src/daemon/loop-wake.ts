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
 * subject the tick before did not hold, so a subject wakes the loop once rather than every tick.
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

/** The most reasons one wake carries into the loop's log line. */
export const loopWakeReasonLimit = 20;

/**
 * The loop's sleep between cycles, which the dispatcher can end early. A wake that lands while the
 * loop is cycling is kept, so the next sleep returns at once: the running cycle may have read its
 * snapshot before the subject appeared. The first observation only records what stands — the loop
 * cycles on start anyway — and a subject that stays is never a second wake.
 */
export class LoopWake {
  private seen: Set<string> | null = null;
  private pending: string[] = [];
  private release: (() => void) | null = null;

  /** Record one tick's subjects; wakes the loop for those the tick before did not hold, and returns them. */
  observe(subjects: readonly LoopSubject[]): LoopSubject[] {
    const fresh = this.seen ? subjects.filter(subject => !this.seen!.has(subject.key)) : [];
    this.seen = new Set(subjects.map(subject => subject.key));
    if (fresh.length) this.wake(fresh.map(subject => subject.reason));
    return fresh;
  }

  wake(reasons: readonly string[]) {
    this.pending = [...this.pending, ...reasons].slice(0, loopWakeReasonLimit);
    this.release?.();
  }

  /** Sleep up to `ms`, or until woken or `signal` aborts; answers the wake's reasons, empty when none woke it. */
  async sleep(ms: number, signal?: AbortSignal): Promise<string[]> {
    if (!this.pending.length && !signal?.aborted) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); this.release = null; resolve(); };
      const timer = setTimeout(done, ms);
      this.release = done;
      signal?.addEventListener('abort', done, { once: true });
    });
    const reasons = this.pending;
    this.pending = [];
    return reasons;
  }
}
