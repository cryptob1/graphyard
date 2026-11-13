// Concern: GY-3199, GY-3233, GY-3249 — the control plane's own faults, as the loop sees them. The deploy
// watch keeps .graphyard/control-plane.json; this step reads it each cycle, and the cycle hands it
// the steps that ran past their timeout; the merge writer hands it trial-host faults. A fault belongs to Graphyard, not to the managed
// repository: it is filed once to the configured upstream install (`upstream` in master.json),
// into this install only when it manages Graphyard itself, and otherwise raised as one attention
// line — never filed again per cycle. Once a day it reports the staleness the record shows.
import { controlPlaneRecordPath, controlPlaneStaleLines, readControlPlaneRecord, type ControlPlaneRecord } from '../deploy-watch.js';
import { readCredentialFile } from '../private-file.js';
import { serverOrigin } from '../repository-setup.js';
import { graphyardRepository } from '../scenarios.js';
import type { MasterConfig } from '../master/profiles.js';
import { actionLine, message, storeAction } from './state.js';
import type { Cycle } from './cycle.js';

/** How long a failed upstream filing waits before the loop asks again. */
export const upstreamRetryMs = 3_600_000;

/** The bug item a failed control-plane upgrade files: one item per verified commit and failed step. */
export function controlPlaneUpgradeItem(record: ControlPlaneRecord) {
  const step = record.failedStep ?? 'an unknown step', verified = record.verified ?? 'an unknown commit';
  return {
    title: `Control-plane upgrade stuck at ${step}`.slice(0, 200),
    type: 'bug' as const,
    priority: 1,
    description: `The daily control-plane upgrade to the verified Graphyard commit ${verified.slice(0, 12)} fails at ${step}: ${(record.failedReason ?? 'no reason recorded').slice(0, 500)}. The install keeps running ${record.commit?.slice(0, 12) ?? 'its previous version'} and retries about hourly; .graphyard/control-plane.json carries the record and master status shows it. Fix the upgrade's cause — the failed step and reason above — so the install runs the latest verified commit again.`,
    dependencies: [],
    criteria: [
      { id: 'AC-1', text: `The control-plane upgrade past ${verified.slice(0, 12)} no longer fails at ${step}; a new test pins the cause and fails without the fix`, proofs: ['unit:control-plane-upgrade-pinned'] },
      { id: 'AC-2', text: 'The install again runs the latest verified Graphyard commit within a day of its publishing', proofs: ['manual:control-plane-current'] },
    ],
    reason: 'Filed by the master loop from the control-plane update record (GY-3199)',
  };
}

/** The bug item a loop step that ran past its timeout files upstream. */
export function stepStallItem(step: string, repository: string) {
  return {
    title: `Loop ${step} step stalls past its timeout`.slice(0, 200),
    type: 'bug' as const,
    priority: 1,
    description: `The master loop's ${step} step on the install for ${repository} ran past its cycle timeout. The loop logs the stall each cycle in its journal; find what the step waits on and bound it.`,
    dependencies: [],
    criteria: [{ id: 'AC-1', text: `The loop's ${step} step finishes within its timeout; a new test pins the cause and fails without the fix`, proofs: ['unit:loop-step-bounded'] }],
    reason: 'Filed by the master loop from a stalled cycle step (GY-3233)',
  };
}
/** GY-3249: the bug item a merge trial that cannot fetch from an external host files upstream: one per host. */
export function trialHostFaultItem(host: string, repository: string) {
  return {
    title: `Merge trials cannot fetch from ${host}`.slice(0, 200),
    type: 'bug' as const,
    priority: 1,
    description: `A merge trial on the install for ${repository} failed fetching from ${host}, rerun included, so the trial host's network does not reach a host a normal build needs. The head was neither refused nor reworked and stays queued; the trial record carries the step's output. Find why the trial container cannot reach ${host} and fix it.`,
    dependencies: [],
    criteria: [{ id: 'AC-1', text: `A merge trial's build fetches from ${host}; a new test pins the cause and fails without the fix`, proofs: ['unit:trial-host-reachable'] }],
    reason: 'Filed by the master loop from a trial-host fault (GY-3249)',
  };
}
export type FaultItem = ReturnType<typeof controlPlaneUpgradeItem> | ReturnType<typeof stepStallItem> | ReturnType<typeof trialHostFaultItem> | ReturnType<typeof trialImageFaultItem>;

/** GY-3275: the bug item a merge trial that cannot build a repository's own trial image files upstream: one per repository. */
export function trialImageFaultItem(repository: string) {
  return {
    title: `Merge trials cannot build ${repository}'s trial image`.slice(0, 200),
    type: 'bug' as const,
    priority: 1,
    description: `A merge trial on the install for ${repository} could not build the repository's graphyard.trial.Dockerfile image, so the trial host's Docker cannot build what the repository's base branch declares. The head was neither refused nor reworked and stays queued; the trial record carries the build's output. Fix the Dockerfile on the base branch, or what on the trial host kept Docker from building it, and let the queued head retry.`,
    dependencies: [],
    criteria: [{ id: 'AC-1', text: `A merge trial builds ${repository}'s graphyard.trial.Dockerfile image; a new test pins the cause and fails without the fix`, proofs: ['unit:trial-image-builds'] }],
    reason: 'Filed by the master loop from a trial-host fault (GY-3275)',
  };
}

/** Production upstream filer: POSTs the item to the upstream install as its credential's principal, idempotent on the fault's key. */
export function upstreamFiler(upstream: NonNullable<MasterConfig['upstream']>, fetcher: typeof fetch = fetch) {
  return async (input: FaultItem, key: string): Promise<{ key?: string }> => {
    const token = await readCredentialFile(upstream.credentialFile);
    const response = await fetcher(`${serverOrigin(upstream.url)}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`the upstream install refused it (${response.status}): ${text.slice(0, 200)}`);
    return JSON.parse(text) as { key?: string };
  };
}

/**
 * Reports one fault once: filed upstream when one is configured, into this install only when it
 * manages Graphyard's own repository, otherwise one attention line. A failed upstream filing
 * stands as its attention line and is asked again an hour later; nothing else repeats.
 */
async function reportFault(cycle: Pick<Cycle, 'state' | 'effects' | 'clock' | 'log' | 'config'>, key: string, item: FaultItem, fault: string) {
  const row = cycle.state.actions[key], upstream = cycle.effects.fileUpstream;
  if (row && (row.state === 'done' || !upstream || cycle.clock - Date.parse(row.at) < upstreamRetryMs)) return;
  const note = (state: 'done' | 'failed', detail: string) => {
    const entry = storeAction(cycle.state, key, { kind: 'attention', work: null, principal: null, state, detail: detail.slice(0, 1900), attempts: (row?.attempts ?? 0) + 1, epoch: null, cycle: cycle.state.cycle, at: new Date(cycle.clock).toISOString() });
    cycle.log(actionLine(cycle.state.cycle, entry));
  };
  const local = cycle.config.repository?.toLowerCase() === graphyardRepository ? cycle.effects.mergeWriter?.createWork : undefined;
  const file = upstream ?? local;
  if (!file) return note('failed', `Graphyard fault: ${fault}. No upstream install is configured (upstream in master.json), so it is not filed; report it to Graphyard, never as work in ${cycle.config.repository}`);
  try {
    const filed = await file(item, key);
    note('done', `Filed ${filed?.key ?? 'an item'}${upstream ? ' to the upstream install' : ''}: ${fault}`);
  } catch (error) { note('failed', `Graphyard fault: ${fault}. Could not file it${upstream ? ' to the upstream install' : ''}: ${message(error)}`); }
}

/** GY-3249: a merge trial that could not fetch from `host` is reported once per host, like any Graphyard fault. */
export const reportTrialHostFault = (cycle: Pick<Cycle, 'state' | 'effects' | 'clock' | 'log' | 'config'>, host: string) =>
  reportFault(cycle, `trial-host-fault:${host}`, trialHostFaultItem(host, cycle.config.repository), `merge trials cannot fetch from ${host}, a host a normal build needs`);

/** GY-3275: a merge trial that could not build a repository's own trial image is reported once per repository, like any Graphyard fault. */
export const reportTrialImageFault = (cycle: Pick<Cycle, 'state' | 'effects' | 'clock' | 'log' | 'config'>) =>
  reportFault(cycle, `trial-image-fault:${cycle.config.repository}`, trialImageFaultItem(cycle.config.repository), `merge trials cannot build the repository's graphyard.trial.Dockerfile image on the install for ${cycle.config.repository}`);

/**
 * The control plane's own faults, read beside the cycle: a stuck upgrade from the record, the
 * steps this cycle saw stall, and the daily staleness line. Nothing here writes the record — the
 * deploy watch owns it.
 */
export async function controlPlaneStep(cycle: Pick<Cycle, 'state' | 'effects' | 'clock' | 'log' | 'config'>, stalledSteps: readonly string[] = []) {
  for (const step of stalledSteps) await reportFault(cycle, `loop-step-stall:${step}`, stepStallItem(step, cycle.config.repository), `the loop's ${step} step ran past its timeout`);
  const root = cycle.effects.mergeWriter?.gate?.root;
  if (!root) return;
  const record = readControlPlaneRecord(controlPlaneRecordPath(root));
  // One fault per verified commit and failed step: a retry, or a later pass still failing at the
  // same step of the same commit, reports nothing new.
  if (record?.failedStep && record.verified)
    await reportFault(cycle, `control-plane-upgrade:${record.verified}:${record.failedStep}`, controlPlaneUpgradeItem(record), `the control-plane upgrade to ${record.verified.slice(0, 12)} keeps failing at ${record.failedStep}, so the install still runs ${record.commit?.slice(0, 12) ?? 'its previous version'}`);
  // The daily diagnostics: each staleness line once per UTC day, in the journal the leftovers
  // report writes to. Nothing stale logs nothing.
  const day = new Date(cycle.clock).toISOString().slice(0, 10);
  if (cycle.state.controlPlaneDay !== day) {
    cycle.state.controlPlaneDay = day;
    const stale = controlPlaneStaleLines(readControlPlaneRecord(controlPlaneRecordPath(root)), cycle.clock);
    if (stale.length) cycle.log(`[graphyard-master] control-plane diagnostics: ${stale.join('; ')}`);
  }
}
