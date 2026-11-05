// Concern: GY-3104 — an item whose attempts keep ending with the same failure is not relaunched blind.
//
// Each failure the loop can see on an item — a launch (a failed dispatch or an early worker exit), a
// trial refusal (the merge ledger's refusal starting `trialFailurePrefix`) or a review refusal (the
// loop's rework of a standing verdict) — gets a signature: its kind plus a sha256 of its reason with
// commit SHAs, hex ids, numbers, timestamps and the fleet's account names removed. The loop keeps
// each item's current run of equal signatures in DaemonState (`failureRuns`). On the second, the
// master is woken once with both reasons and the next worker prompt asks for a diagnosis; on the
// third, the loop stops dispatching the item and wakes the master to decide. A success of the same
// kind (a hand-in, a pushed merge, a passed review), a different signature or a master rework
// (`master rework GY-N REASON`, the master's decision) ends the run.
import { createHash } from 'node:crypto';
import type { Work } from '../model.js';
import type { WorkerProfile } from '../master/profiles.js';
import { trialFailurePrefix } from '../model/rework-ground.js';
import type { DaemonState, FailureRun } from './state.js';
import { earlyExitKey } from './worker-launch-health.js';
import { dispatchKey } from './reconcile.js';

export type FailureKind = FailureRun['kind'];
export interface Failure { id: string; kind: FailureKind; reason: string }
const labels: Record<FailureKind, string> = { launch: 'launch failure', trial: 'merge trial refusal', review: 'review refusal' };

/** The names stripped before hashing: every worker profile's name, principal, agent name and accounts. */
export const accountNames = (workers: readonly Pick<WorkerProfile, 'name' | 'principal' | 'agentName' | 'accounts'>[]) =>
  workers.flatMap(profile => [profile.name, profile.principal, profile.agentName, ...(profile.accounts ?? [])]).filter((name): name is string => !!name);

export function normalizeFailureReason(reason: string, accounts: readonly string[] = []): string {
  let text = reason;
  for (const name of [...accounts].sort((a, b) => b.length - a.length)) text = text.split(name).join(' ');
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, ' ')
    .replace(/\b(?:[0-9a-f]{32,}|(?=[0-9a-f-]*\d)[0-9a-f]{7,}(?:-[0-9a-f]{4,})*)\b/gi, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export const failureSignature = (kind: FailureKind, reason: string, accounts: readonly string[] = []) =>
  `${kind}:${createHash('sha256').update(normalizeFailureReason(reason, accounts)).digest('hex')}`;

/** The failures the item's records show now, each under an id that names that one occurrence. */
export function itemFailures(item: Work, actions: DaemonState['actions']): Failure[] {
  const failures: Failure[] = [];
  const dispatch = actions[dispatchKey(item)];
  if (dispatch?.state === 'failed') failures.push({ id: `launch:dispatch:${item.epoch}:${dispatch.attempts}`, kind: 'launch', reason: dispatch.detail });
  const exit = actions[earlyExitKey(item)];
  if (exit?.state === 'failed') failures.push({ id: `launch:exit:${exit.epoch}`, kind: 'launch', reason: exit.detail });
  const ledger = item.mergeLedger;
  if (ledger?.state === 'refused' && ledger.refusal?.kind === 'merge' && ledger.refusal.reason.startsWith(trialFailurePrefix))
    failures.push({ id: `trial:${ledger.head}:${ledger.intentAt}`, kind: 'trial', reason: ledger.refusal.reason });
  const rework = item.lastRework;
  if (rework?.binding?.includes(':verdict:')) failures.push({ id: `review:${rework.at}`, kind: 'review', reason: rework.reason });
  return failures;
}

/** A success of the run's own kind, or the master's rework decision, since the run's last failure. */
function runEnded(item: Work, run: FailureRun): boolean {
  const since = Date.parse(run.at);
  const rework = item.lastRework;
  if (rework && !rework.binding && Date.parse(rework.at) > since) return true;
  if (run.kind === 'launch') { const handedIn = item.pipeline?.resubmittedAt ?? item.pipeline?.submittedAt; return !!handedIn && Date.parse(handedIn) > since; }
  if (run.kind === 'trial') return item.mergeLedger?.state === 'pushed' || item.mergeLedger?.state === 'reconciled';
  return !!item.gates.find(gate => gate.name === 'review')?.passed;
}

/** Folds every item's current failures into its run; a done or vanished item drops its run. */
export function advanceFailureRuns(state: DaemonState, work: readonly Work[], accounts: readonly string[], now: string) {
  const open = new Map(work.filter(item => item.stage !== 'done').map(item => [item.id, item]));
  for (const id of Object.keys(state.failureRuns)) if (!open.has(id)) delete state.failureRuns[id];
  for (const item of open.values()) {
    let run: FailureRun | undefined = state.failureRuns[item.id];
    let seen = run?.seen ?? [];
    if (run && runEnded(item, run)) run = undefined;
    for (const failure of itemFailures(item, state.actions)) {
      if (seen.includes(failure.id)) continue;
      seen = [...seen, failure.id].slice(-20);
      const signature = failureSignature(failure.kind, failure.reason, accounts), reason = failure.reason.slice(0, 1000);
      run = run?.signature === signature ? { ...run, reasons: [...run.reasons, reason].slice(-2), count: run.count + 1, at: now }
        : { key: item.key, kind: failure.kind, signature, reasons: [reason], count: 1, at: now, seen };
    }
    if (run) state.failureRuns[item.id] = { ...run, seen };
    else if (seen.length) state.failureRuns[item.id] = { key: item.key, kind: 'launch', signature: '', reasons: [], count: 0, at: now, seen };
    else delete state.failureRuns[item.id];
  }
}

/** The third equal failure: the loop dispatches the item no more until the run ends. */
export const failureHeld = (run: FailureRun | undefined) => (run?.count ?? 0) >= 3;
const repeating = (run: FailureRun | undefined): run is FailureRun => (run?.count ?? 0) >= 2;
const quoted = (run: FailureRun) => run.reasons.map((reason, index) => `(${index + 1}) ${reason}`).join(' ');

/** The master's one wake for a run: on the second equal failure, and again when the third holds the item. */
export function repeatedFailureCause(run: FailureRun | undefined): { key: string; detail: string } | null {
  if (!repeating(run)) return null;
  const key = `repeat:${createHash('sha1').update(`${run.key}:${run.signature}`).digest('hex')}`;
  const label = labels[run.kind];
  return failureHeld(run)
    ? { key, detail: `${run.key}: the same ${label} a third time; the loop stopped dispatching it. Decide: resume it with node graphyard master rework ${run.key} REASON naming a different approach, or close or park it. The last two: ${quoted(run)}` }
    : { key, detail: `${run.key}: the same ${label} twice; its next worker is asked to state a diagnosis and a different approach before changing code. Both: ${quoted(run)}` };
}

/** Whether the item's per-failure wake causes give way to its run's single cause. */
export const repeatingItems = (runs: DaemonState['failureRuns']) => new Set(Object.values(runs).filter(repeating).map(run => run.key));

/** The worker prompt's section for a run of two equal failures. */
export function diagnosisSection(run: FailureRun | undefined): string {
  if (!repeating(run)) return '';
  return `The last two attempts of ${run.key} ended with the same ${labels[run.kind]}: ${quoted(run)} Retrying the same approach will fail the same way. Before changing any code, state your diagnosis of why it failed twice and the different approach you will take, then carry out that approach. `;
}
