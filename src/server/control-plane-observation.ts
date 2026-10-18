// Concern: the observation job of a control-plane install with no GitHub App (GY-1675), kept out of src/server/main.ts's budget.
import { observationClaim } from '../observation-priority.js';
import { recordedMergerMode } from '../merger-mode.js';
import type { Engine } from '../engine.js';

/**
 * The observation job of a control-plane install with no GitHub App (GY-1675): take one due job and
 * observe its candidate from the local checkout, as `processJob` does from GitHub; false when no job
 * was due or the observation failed.
 *
 * The path is gated on the recorded merger: while the ledger says `github`, a server with no App
 * claims nothing, so a checkout that is not the configured merger never writes a control-plane
 * observation over a GitHub one. The claimed item is read again after the claim, never judged from
 * the pre-claim snapshot: a submission between `fleet()` and `takeJob` creates the candidate and
 * wakes the very job claimed, and a stale snapshot would discard it. A job for an item with nothing
 * submitted yet is deferred a minute (`deferJob` keeps a wake that lands meanwhile); one for a
 * finished or missing item is dropped.
 */
export async function processControlPlaneJob(engine: Engine): Promise<boolean> {
  if ((await recordedMergerMode(engine.store.pool)).merger !== 'control-plane') return false;
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
