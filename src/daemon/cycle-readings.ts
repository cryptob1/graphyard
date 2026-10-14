// Concern: step 7c — the loop's own due readings of loop-owned observation items on the serving release (GY-1779): taken, recorded as trusted evidence, closed on a pass, escalated on a fail.
import { followUpRequest, patternOfProof, type PatternProjection, type PatternReader } from '../model/observation-window.js';
import { loopObservation, loopObservationProofs, postDeployProofs, type Work } from '../model.js';
import { loopReadingOn, observationPass } from '../model/loop-observation.js';
// Types only: master-verification.ts imports the daemon, so the filer itself arrives through the effects.
import type { PostDeployFiler } from '../master-verification.js';
import type { PostDeployReader, PostDeployReading, ProjectionRead } from '../master/post-deploy-readings.js';
import { type DaemonAction, type DaemonState, message } from './state.js';
import { readyToRetry } from './sessions.js';
import { detailChanged } from './decisions.js';
import { record } from './effects.js';
import { stillVerifying, withinDeploymentBudget } from './deployment.js';
import type { Cycle } from './cycle.js';

/**
 * The effects the readings step records through. A loop without `recordReading` takes no reading
 * and names that once per item and release, so the item is never left owed to nobody.
 */
export interface ReadingEffects {
  /** `POST work/:id/reading` as the coordinator: the loop's reading, bound as loopObservation reads it. */
  recordReading?: (work: Work, reading: { proof: string; sha: string; baseSha: string; policyRevision: number; result: 'pass' | 'fail'; detail: string }) => Promise<unknown>;
  /** `POST work/:id/close` as the coordinator, kind `delivered-observation` on `release`, under the idempotency key; the control plane closes an open pull request as superseded. */
  closeObservation?: (work: Work, release: string, reason: string, key: string) => Promise<unknown>;
  /** The post-deploy-checks filer verify-deployment uses (`localPostDeployChecks`): the parent's check for the proof on the serving release. Without it the parent's own record is not consulted. */
  postDeployFiler?: PostDeployFiler;
  /** The intervention report's reading for a pattern (GY-1698), for the filer's projections. */
  readPattern?: PatternReader;
  /** The live reading of a proof this host can take, or why it cannot (master/post-deploy-readings.ts). */
  readPostDeploy?: PostDeployReader;
}

/** The loop's one record of taking the item's reading, whatever release it read: the backoff is the item's, so a plane that deploys every few minutes costs no read per cycle. */
export const readingKey = (item: Pick<Work, 'id'>) => `reading:${item.id}`;
export const readingEscalationKey = (item: Pick<Work, 'id'>) => `escalation:reading:${item.id}`;
/** The idempotency key of the close a passing reading on `release` ends in: a close that failed is retried under it, never applied twice. */
export const readingCloseKey = (item: Pick<Work, 'id'>, release: string) => `reading:close:${item.id}:${release}`;
const short = (sha: string) => sha.slice(0, 12);

/**
 * Whether the item's reading is asked this cycle: never again once recorded and closed (`done`),
 * a failed reading or one this host could not take (`waiting`) on the failure backoff, so a report
 * read costs one ask per backoff step rather than one per cycle, and a loop failure on its own.
 */
export const readingDue = (previous: DaemonAction | undefined, cycle: number) => readyToRetry(previous?.state === 'waiting' ? { ...previous, state: 'failed' } : previous, cycle);

/**
 * The report's projections for the parent's pattern proofs, read once per item as filePostDeployFollowUps
 * reads them, and threaded through to the filer and the proof's reader so the report is read once: a
 * reader that fails leaves the proof without one for the filer and names the failure to the reader.
 */
async function projections(parent: Pick<Work, 'criteria'>, patterns?: PatternReader): Promise<{ filer: Record<string, PatternProjection | null>; reader: Record<string, ProjectionRead> }> {
  const filer: Record<string, PatternProjection | null> = {}, reader: Record<string, ProjectionRead> = {};
  if (!patterns) return { filer, reader };
  for (const proof of new Set(parent.criteria.flatMap(postDeployProofs))) {
    const pattern = patternOfProof(proof);
    if (!pattern) continue;
    try { filer[proof] = await patterns(pattern); reader[proof] = { read: filer[proof] }; } catch (error) { filer[proof] = null; reader[proof] = { error: message(error) }; }
  }
  return { filer, reader };
}

type Taken = { proof: string; reading: PostDeployReading };
/** The loop's newest own reading of the proof on any release, at the item's current policy revision. */
const newestLoopReading = (item: Work, proof: string) => item.evidence.filter(entry => entry.proof === proof && entry.trusted && !entry.revocation && !!entry.reading && entry.policyRevision === item.policyRevision)
  .reduce<Work['evidence'][number] | null>((best, entry) => !best || Date.parse(entry.at) >= Date.parse(best.at) ? entry : best, null);
const detailOf = (entry: Taken) => (entry.reading as { detail: string }).detail;

/**
 * Step 7c. Every loop-owned observation item whose reading is due (`loopObservation(...).due`) is read
 * on the release the control plane serves, as verified this cycle: the parent's post-deploy check for
 * its proof runs through the filer verify-deployment uses — observed there, the reading passes on the
 * parent's own trusted record — and otherwise through the proof's reader. The result is recorded as
 * trusted evidence bound as loopObservation reads it (the serving release, the parent delivery's
 * merge, the item's policy revision, at or after its window); a pass closes the item as
 * delivered-observation in the same pass, a fail records the reading and raises the item's escalation
 * naming the measured values, and a reading this host cannot take records why. An item still open on
 * a recorded pass — its close refused or failed in the cycle that recorded it, or the pass recorded by
 * hand — is closed on the release the pass was taken on, under the same idempotency key, every cycle
 * until it closes. The reads run under the deployment step's budget, keyed per item: one still
 * running at the bound is left in flight and resumed next cycle. Returns how many the budget deferred.
 */
export async function readingsStep(cycle: Cycle, served: DaemonState['deployment'], deadline: number): Promise<number> {
  const { state, effects, now, snapshot, performed, isolate, open } = cycle;
  let deferred = 0;
  const loopOwned = open.filter(item => !item.blocker && !(item.lease && Date.parse(item.lease.expiresAt) > now()) && loopObservationProofs(item));
  const noteFor = (item: Work, key: string, previous: DaemonAction | undefined, attempts: number) => async (outcome: DaemonAction['state'], detail: string) => {
    const entry = await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: outcome, detail: detail.slice(0, 2000), attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist);
    if (outcome !== 'waiting' || detailChanged(previous, entry.detail)) performed.push(entry);
  };
  /** The close a recorded pass ends in: refused or failed, it is retried next cycle on the same key without a second record. */
  const close = async (item: Work, release: string, summary: string, note: (outcome: DaemonAction['state'], detail: string) => Promise<void>) => {
    if (!effects.closeObservation) return note('failed', `Recorded ${item.key}'s passing reading on release ${short(release)}, and this loop cannot close it: it runs without the coordinator's close effect`);
    try {
      await effects.closeObservation(item, release, `${item.key}'s reading passed on the serving release ${short(release)}: ${summary}`.slice(0, 2000), readingCloseKey(item, release));
      return note('done', `Recorded ${item.key}'s passing reading on release ${short(release)} and closed it as delivered-observation: ${summary}`);
    } catch (error) { return note('failed', `Recorded ${item.key}'s passing reading on release ${short(release)}, and could not close it as delivered-observation: ${message(error)}`); }
  };
  for (const item of loopOwned) await isolate('deployment', item, item.key, async () => {
    if (now() >= deadline) { deferred++; return; }
    const observing = loopObservation(item, new Date(now()), snapshot.work);
    // A recorded pass still open: closed on the release it was read on, whatever the plane serves now.
    if (!observing) {
      const pass = observationPass(item, new Date(now()), snapshot.work);
      if (!pass) return;
      const key = readingKey(item), previous = state.actions[key];
      if (!readingDue(previous, state.cycle)) return;
      const summary = pass.readings.map(entry => `${entry.proof}: ${entry.reading?.detail ?? `a trusted passing record by ${entry.producer} at ${entry.at}`}`).join('; ');
      return close(item, pass.release, summary, noteFor(item, key, previous, (previous?.attempts ?? 0) + 1));
    }
    if (!observing.due) return;
    const release = served && served.source !== 'unavailable' && served.sha ? served.sha : null;
    const key = readingKey(item), previous = state.actions[key];
    if (!readingDue(previous, state.cycle)) return;
    const note = noteFor(item, key, previous, (previous?.attempts ?? 0) + 1);
    if (!release) return note('waiting', `${item.key}'s reading is due, and the release the control plane serves could not be observed this cycle${served?.reason ? `: ${served.reason}` : ''}; the loop reads it once a release is observed`);
    if (!effects.recordReading) return note('waiting', `${item.key}'s reading is due on release ${short(release)}, and this loop records no readings: it runs without the coordinator's reading effect`);
    const request = followUpRequest(item), parent = request ? snapshot.work.find(entry => entry.id === request.work) : item;
    if (!parent || (request && !parent.delivery)) return note('waiting', `${item.key}'s reading is due on release ${short(release)}, and its follow-up request names ${request?.work ?? 'no item'}, which is not a delivered item; the reading has no merge to bind to`);
    if (request && !served!.deployed.includes(parent.key)) return note('waiting', `${item.key}'s reading is due, and the release the control plane serves (${short(release)}) is not observed carrying ${parent.key}'s merge ${short(parent.delivery!.mergeSha)}; the loop reads it on a release that does`);
    const baseSha = request ? parent.delivery!.mergeSha : release;
    const proofs = loopObservationProofs(item) ?? [];
    // The reads — the report once, then the parent's own check through the filer and the proof's reader —
    // under the step's budget (GY-1354): a production coordinator read can take 30 s, so one left running
    // at the bound is deferred to the cycle that finds it settled, never awaited past the deadline.
    const taken = await withinDeploymentBudget(state, `reading:${item.id}`, async (): Promise<Taken[]> => {
      const readings: Taken[] = [];
      const read = await projections(parent, effects.readPattern);
      const servedAt = served!.at ? { servedAt: served!.at } : {};
      const checks = effects.postDeployFiler ? await effects.postDeployFiler({ work: parent, release, now: new Date(now()).toISOString(), projections: read.filer, ...servedAt }) : [];
      for (const proof of proofs) {
        if (loopReadingOn(item, proof, release)?.result === 'pass') { readings.push({ proof, reading: { result: 'pass', detail: 'already recorded' } }); continue; }
        const parentProof = request ? request.proof : proof, criterion = parent.criteria.find(entry => entry.proofs.includes(parentProof)) ?? null;
        // The parent's own check first: the filer verify-deployment uses reads whether the parent already carries a trusted passing observation of the proof on this release.
        const check = checks.find(entry => entry.proof === parentProof);
        if (check?.result === 'observed') { readings.push({ proof, reading: { result: 'pass', detail: `the post-deploy-checks filer reads ${parent.key} ${check.criterion}'s ${parentProof} observed on release ${short(release)}: a trusted passing record is bound there` } }); continue; }
        const reading = effects.readPostDeploy ? await effects.readPostDeploy({ proof: parentProof, parent, item, criterion, release, now: new Date(now()), ...(parentProof in read.reader ? { projection: read.reader[parentProof] } : {}) })
          : { unavailable: `no reader of ${parentProof} is configured on this loop` };
        readings.push({ proof, reading });
      }
      return readings;
    }, deadline, now);
    if (taken === stillVerifying) { deferred++; return; }
    if (!taken.ok) return note('failed', `Could not take ${item.key}'s reading on release ${short(release)}: ${message(taken.error)}`);
    const readings = taken.value;
    const unavailable = readings.filter(entry => 'unavailable' in entry.reading);
    if (unavailable.length) return note('waiting', `${item.key}'s reading is due on release ${short(release)} and cannot be taken from this host: ${unavailable.map(entry => `${entry.proof}: ${(entry.reading as { unavailable: string }).unavailable}`).join('; ')}`);
    // Every proof read: record each reading not yet on the item, bound as loopObservation reads it. A pass is recorded
    // once per release; a fail re-read on the backoff, on this release or a later one, stands as recorded while the
    // proof's newest loop reading is already a fail — the escalation below names the values measured now.
    try {
      for (const entry of readings) {
        const reading = entry.reading as { result: 'pass' | 'fail'; detail: string };
        if (reading.detail === 'already recorded' || (reading.result === 'fail' && newestLoopReading(item, entry.proof)?.result === 'fail')) continue;
        await effects.recordReading(item, { proof: entry.proof, sha: release, baseSha, policyRevision: item.policyRevision, result: reading.result, detail: reading.detail.slice(0, 2000) });
      }
    } catch (error) { return note('failed', `Could not record ${item.key}'s reading on release ${short(release)}: ${message(error)}`); }
    const failed = readings.filter(entry => (entry.reading as { result: string }).result === 'fail');
    if (failed.length) {
      const measured = failed.map(entry => `${entry.proof}: ${detailOf(entry)}`).join('; ');
      const escalationKey = readingEscalationKey(item), escalation = `${item.key}'s reading of ${failed.map(entry => entry.proof).join(', ')} failed on the serving release ${short(release)}: ${measured}. The failed reading is recorded on the item; the loop reads it again on its backoff, and a later passing reading closes the item`;
      if (detailChanged(state.actions[escalationKey], escalation)) performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: escalation.slice(0, 2000), attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      return note('waiting', `Recorded ${item.key}'s failed reading on release ${short(release)}: ${measured}`);
    }
    const summary = readings.map(entry => `${entry.proof}: ${detailOf(entry) === 'already recorded' ? loopReadingOn(item, entry.proof, release)!.reading!.detail : detailOf(entry)}`).join('; ');
    return close(item, release, summary, note);
  });
  return deferred;
}
