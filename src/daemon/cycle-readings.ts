// Concern: step 7c — the loop's own due readings of loop-owned observation items on the serving release (GY-1779): taken, recorded as trusted evidence, closed on a pass, escalated on a fail.
import { followUpRequest, patternOfProof, type PatternProjection, type PatternReader } from '../model/observation-window.js';
import { loopObservation, loopObservationProofs, postDeployProofs, type Work } from '../model.js';
// Types only: master-verification.ts imports the daemon, so the filer itself arrives through the effects.
import type { PostDeployFiler } from '../master-verification.js';
import type { PostDeployReader, PostDeployReading } from '../master/post-deploy-readings.js';
import { type DaemonAction, type DaemonState, message } from './state.js';
import { readyToRetry } from './sessions.js';
import { detailChanged } from './decisions.js';
import { record } from './effects.js';
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

export const readingKey = (item: Pick<Work, 'id'>, release: string) => `reading:${item.id}:${release}`;
export const readingEscalationKey = (item: Pick<Work, 'id'>, release: string) => `escalation:reading:${item.id}:${release}`;
const short = (sha: string) => sha.slice(0, 12);

/**
 * Whether the item's reading is asked this cycle: never again once recorded and closed (`done`),
 * a failed reading or one this host could not take (`waiting`) on the failure backoff, so a report
 * read costs one ask per backoff step rather than one per cycle, and a loop failure on its own.
 */
export const readingDue = (previous: DaemonAction | undefined, cycle: number) => readyToRetry(previous?.state === 'waiting' ? { ...previous, state: 'failed' } : previous, cycle);

/** The report's projections for the parent's pattern proofs, as filePostDeployFollowUps reads them: a reader that fails leaves the proof without one. */
async function projections(parent: Pick<Work, 'criteria'>, patterns?: PatternReader): Promise<Record<string, PatternProjection | null>> {
  const read: Record<string, PatternProjection | null> = {};
  if (!patterns) return read;
  for (const proof of new Set(parent.criteria.flatMap(postDeployProofs))) {
    const pattern = patternOfProof(proof);
    if (pattern) try { read[proof] = await patterns(pattern); } catch { read[proof] = null; }
  }
  return read;
}

/** The loop's newest own reading of `proof` on the item for this release, or undefined: a close that failed is retried without a second record, and a reading whose result stands is not recorded twice. */
const recordedReading = (item: Work, proof: string, release: string) => item.evidence.filter(entry => entry.proof === proof && entry.trusted && !entry.revocation && !!entry.reading && entry.sha === release && entry.policyRevision === item.policyRevision)
  .reduce<Work['evidence'][number] | undefined>((latest, entry) => !latest || Date.parse(entry.at) >= Date.parse(latest.at) ? entry : latest, undefined);
const recordedPass = (item: Work, proof: string, release: string) => { const latest = recordedReading(item, proof, release); return latest?.result === 'pass' ? latest : undefined; };

/**
 * Step 7c. Every loop-owned observation item whose reading is due (`loopObservation(...).due`) is read
 * on the release the control plane serves, as verified this cycle: the parent's post-deploy check for
 * its proof runs through the filer verify-deployment uses — observed there, the reading passes on the
 * parent's own trusted record — and otherwise through the proof's reader. The result is recorded as
 * trusted evidence bound as loopObservation reads it (the serving release, the parent delivery's
 * merge, the item's policy revision, at or after its window); a pass closes the item as
 * delivered-observation in the same pass, a fail records the reading and raises the item's escalation
 * naming the measured values, and a reading this host cannot take records why. Returns how many
 * readings the step's budget deferred.
 */
export async function readingsStep(cycle: Cycle, served: DaemonState['deployment'], deadline: number): Promise<number> {
  const { state, effects, now, snapshot, performed, isolate, open } = cycle;
  let deferred = 0;
  const due = open.filter(item => !item.blocker && !(item.lease && Date.parse(item.lease.expiresAt) > now()) && loopObservation(item, new Date(now()), snapshot.work)?.due);
  for (const item of due) await isolate('deployment', item, item.key, async () => {
    if (now() >= deadline) { deferred++; return; }
    const release = served && served.source !== 'unavailable' && served.sha ? served.sha : null;
    const key = readingKey(item, release ?? 'none'), previous = state.actions[key];
    if (!readingDue(previous, state.cycle)) return;
    const attempts = (previous?.attempts ?? 0) + 1;
    const note = async (outcome: DaemonAction['state'], detail: string) => {
      const entry = await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: outcome, detail: detail.slice(0, 2000), attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist);
      if (outcome !== 'waiting' || detailChanged(previous, entry.detail)) performed.push(entry);
    };
    if (!release) return note('waiting', `${item.key}'s reading is due, and the release the control plane serves could not be observed this cycle${served?.reason ? `: ${served.reason}` : ''}; the loop reads it once a release is observed`);
    if (!effects.recordReading) return note('waiting', `${item.key}'s reading is due on release ${short(release)}, and this loop records no readings: it runs without the coordinator's reading effect`);
    const request = followUpRequest(item), parent = request ? snapshot.work.find(entry => entry.id === request.work) : item;
    if (!parent || (request && !parent.delivery)) return note('waiting', `${item.key}'s reading is due on release ${short(release)}, and its follow-up request names ${request?.work ?? 'no item'}, which is not a delivered item; the reading has no merge to bind to`);
    if (request && !served!.deployed.includes(parent.key)) return note('waiting', `${item.key}'s reading is due, and the release the control plane serves (${short(release)}) is not observed carrying ${parent.key}'s merge ${short(parent.delivery!.mergeSha)}; the loop reads it on a release that does`);
    const baseSha = request ? parent.delivery!.mergeSha : release;
    const proofs = loopObservationProofs(item) ?? [];
    const readings: { proof: string; reading: PostDeployReading }[] = [];
    for (const proof of proofs) {
      if (recordedPass(item, proof, release)) { readings.push({ proof, reading: { result: 'pass', detail: 'already recorded' } }); continue; }
      const parentProof = request ? request.proof : proof, criterion = parent.criteria.find(entry => entry.proofs.includes(parentProof)) ?? null;
      // The parent's own check first: the filer verify-deployment uses reads whether the parent already carries a trusted passing observation of the proof on this release.
      const checks = effects.postDeployFiler ? await effects.postDeployFiler({ work: parent, release, now: new Date(now()).toISOString(), projections: await projections(parent, effects.readPattern), ...(served!.at ? { servedAt: served!.at } : {}) }) : [];
      const check = checks.find(entry => entry.proof === parentProof);
      if (check?.result === 'observed') { readings.push({ proof, reading: { result: 'pass', detail: `the post-deploy-checks filer reads ${parent.key} ${check.criterion}'s ${parentProof} observed on release ${short(release)}: a trusted passing record is bound there` } }); continue; }
      const reading = effects.readPostDeploy ? await effects.readPostDeploy({ proof: parentProof, parent, item, criterion, release, now: new Date(now()) })
        : { unavailable: `no reader of ${parentProof} is configured on this loop` };
      readings.push({ proof, reading });
    }
    const unavailable = readings.filter(entry => 'unavailable' in entry.reading);
    if (unavailable.length) return note('waiting', `${item.key}'s reading is due on release ${short(release)} and cannot be taken from this host: ${unavailable.map(entry => `${entry.proof}: ${(entry.reading as { unavailable: string }).unavailable}`).join('; ')}`);
    // Every proof read: record each reading not yet on the item, bound as loopObservation reads it. A result the newest
    // recorded reading of this release already gives is not recorded again: a fail re-read on the backoff stands as recorded.
    try {
      for (const entry of readings) {
        const reading = entry.reading as { result: 'pass' | 'fail'; detail: string };
        if (reading.detail === 'already recorded' || recordedReading(item, entry.proof, release)?.result === reading.result) continue;
        await effects.recordReading(item, { proof: entry.proof, sha: release, baseSha, policyRevision: item.policyRevision, result: reading.result, detail: reading.detail.slice(0, 2000) });
      }
    } catch (error) { return note('failed', `Could not record ${item.key}'s reading on release ${short(release)}: ${message(error)}`); }
    const failed = readings.filter(entry => (entry.reading as { result: string }).result === 'fail');
    if (failed.length) {
      const measured = failed.map(entry => `${entry.proof}: ${(entry.reading as { detail: string }).detail}`).join('; ');
      const escalationKey = readingEscalationKey(item, release), escalation = `${item.key}'s reading of ${failed.map(entry => entry.proof).join(', ')} failed on the serving release ${short(release)}: ${measured}. The failed reading is recorded on the item; the loop reads it again on its backoff, and a later passing reading closes the item`;
      if (detailChanged(state.actions[escalationKey], escalation)) performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: escalation.slice(0, 2000), attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      return note('waiting', `Recorded ${item.key}'s failed reading on release ${short(release)}: ${measured}`);
    }
    const summary = readings.map(entry => `${entry.proof}: ${(entry.reading as { detail: string }).detail === 'already recorded' ? recordedPass(item, entry.proof, release)!.reading!.detail : (entry.reading as { detail: string }).detail}`).join('; ');
    if (!effects.closeObservation) return note('failed', `Recorded ${item.key}'s passing reading on release ${short(release)}, and this loop cannot close it: it runs without the coordinator's close effect`);
    try {
      await effects.closeObservation(item, release, `${item.key}'s reading passed on the serving release ${short(release)}: ${summary}`.slice(0, 2000), `reading:close:${item.id}:${release}`);
      return note('done', `Recorded ${item.key}'s passing reading on release ${short(release)} and closed it as delivered-observation: ${summary}`);
    } catch (error) { return note('failed', `Recorded ${item.key}'s passing reading on release ${short(release)}, and could not close it as delivered-observation: ${message(error)}`); }
  });
  return deferred;
}
