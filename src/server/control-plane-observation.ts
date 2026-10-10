// Concern: the observation job of a control-plane install with no GitHub App (GY-1675), kept out of src/server/main.ts's budget.
import { observationClaim } from '../observation-priority.js';
import type { Engine } from '../engine.js';

/**
 * The observation job of a control-plane install with no GitHub App (GY-1675): take one due job and
 * observe its candidate from the local checkout, as `processJob` does from GitHub; false when no job
 * was due or the observation failed. A job for an item with nothing submitted yet is deferred a
 * minute; one for a finished item, or with no candidate, is dropped.
 */
export async function processControlPlaneJob(engine: Engine): Promise<boolean> {
  const all = await engine.store.fleet();
  const plan = observationClaim(all, Date.now(), false);
  const job = await engine.store.takeJob(plan.order, plan.headCount);
  if (!job) return false;
  let work = all.find(w => w.id === job.work_id);
  if (!work?.submission || work.stage === 'done' || !work.candidate) {
    if (work && !work.submission && work.stage !== 'done') {
      await engine.store.deferJob(job.work_id, job.token, new Date(Date.now() + 60_000).toISOString(), 'no submission to observe', null);
    } else {
      await engine.store.pool.query('DELETE FROM jobs WHERE work_id=$1 AND token=$2', [job.work_id, job.token]);
    }
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
