// Concern: the observation job (GY-1675), kept out of src/server/main.ts's budget.
import { observationClaim } from '../observation-priority.js';
import type { Engine } from '../engine.js';

/**
 * The observation job (GY-1675): take one due job and observe its candidate from the local checkout;
 * false when no job was due or the observation failed. A candidate GitHub observed before the control
 * plane became the only merge writer (a pull request head) is observed the same way, from the shared
 * object store, which turns it into a submitted head the merge writer queues. The claimed item is read again after the claim, never judged from
 * the pre-claim snapshot: a submission between `fleet()` and `takeJob` creates the candidate and
 * wakes the very job claimed, and a stale snapshot would discard it. A job for an item with nothing
 * submitted yet is deferred a minute (`deferJob` keeps a wake that lands meanwhile); one for a
 * finished or missing item is dropped.
 */
export async function processControlPlaneJob(engine: Engine): Promise<boolean> {
  const all = await engine.store.fleet();
  const plan = observationClaim(all, Date.now(), false);
  const job = await engine.store.takeJob(plan.order, plan.headCount);
  if (!job) return false;
  let work = await engine.store.workItem(job.work_id);
  if (!work || work.stage === 'done') {
    await engine.store.pool.query('DELETE FROM jobs WHERE work_id=$1 AND token=$2', [job.work_id, job.token]);
    return true;
  }
  if (!work.submission || !work.candidate) {
    await engine.store.deferJob(job.work_id, job.token, new Date(Date.now() + 60_000).toISOString(), 'no submission to observe', null);
    return true;
  }
  let observed = false;
  try {
    const observation = await engine.observeControlPlaneCandidate(work);
    if (observation) {
      work = await engine.observe(work.id, work.revision, observation, job.token);
      observed = true;
    }
    await engine.store.finishJob(job.work_id, job.token, undefined, false, 20_000, observed);
    return true;
  } catch (error: any) {
    await engine.store.finishJob(job.work_id, job.token, error instanceof Error ? error.message : String(error), false, 10_000, observed);
    return false;
  }
}
