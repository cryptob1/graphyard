// Concern: the shadow merge gate's cycle step (GY-1522) — trial-merge one submitted head per cycle beside GitHub's gate and record the verdict; it writes nothing.
import { z } from 'zod';
import type { ChildRun } from '../child-runner.js';
import { readCredentialFile, type MasterConfig } from '../master.js';
import { defaultChildRun } from '../child-runner.js';
import { worktreeRoot } from '../install/worktree-root.js';
import type { Work } from '../model.js';
import { classifyRisk } from '../model/risk-class.js';
import { shadowGateSettings } from '../master/merge-writer-settings.js';
import { runTrial, trialMerge, type TrialRun } from '../merge-writer/trial.js';
import { judgedVerdicts, shadowOutcomes, shadowDue, shadowReport, type ShadowVerdict } from '../merge-writer/shadow.js';
import { storeAction, type DaemonState } from './state.js';
import type { Cycle } from './cycle.js';

/** How many verdicts `state.shadow` keeps, newest last. */
export const shadowKeptVerdicts = 200;
export const shadowVerdictSchema = z.object({
  key: z.string().max(100), id: z.string().max(100), head: z.string().max(64), baseTip: z.string().max(64), mergeSha: z.string().max(64).nullable(),
  risk: z.enum(['sensitive', 'normal']), build: z.enum(['pass', 'fail']),
  tests: z.object({ passed: z.number().int().min(0), failed: z.array(z.string().max(300)).max(100), files: z.number().int().min(0) }).strict(),
  conflict: z.array(z.string().max(500)).max(100), durationMs: z.number().int().min(0), at: z.string().max(64), outcome: z.enum(shadowOutcomes).default('pending'),
}).strict();
export const shadowStateSchema = z.array(shadowVerdictSchema).max(shadowKeptVerdicts);

/** The step's reads and its one record; every git call it makes goes through the injected runner. */
export interface ShadowReads {
  enabled: boolean;
  /** The base branch tip the promotion ledger last fetched; null when the checkout holds none. */
  mainTip(): Promise<string | null>;
  /** Fetches the head's branch (and the base) into the coordinator checkout; moves no local branch. */
  fetch(branch: string): Promise<void>;
  /** The trial of `head` on `baseTip`: its merge commit, the files the merge changes, and the build and test run. */
  trial(head: string, baseTip: string, key: string): Promise<{ mergeSha: string | null; conflict: string[]; files: string[]; run: TrialRun | null }>;
  /** Posts the verdict to the coordinator (`POST /api/work/:id/shadow-verdict`). */
  record(work: Work, verdict: Omit<ShadowVerdict, 'outcome'>): Promise<void>;
}

/** The shadow reads over the coordinator checkout. Git writes are limited to the trial ref; a trial checkout is the only worktree made. */
export function shadowReads(config: Pick<MasterConfig, 'baseBranch' | 'run'>, root: string, run: ChildRun, options: { base: string; record: ShadowReads['record']; trial?: typeof runTrial }): ShadowReads {
  const git = async (...args: string[]) => String(await run('git', ['-C', root, ...args]));
  const gitAs = async (args: string[], env?: Record<string, string>) => String(await run('git', ['-C', root, ...args], env ? { env: { ...process.env, ...env } } : undefined));
  const settings = shadowGateSettings(config.run);
  return {
    enabled: settings.enabled, record: options.record,
    mainTip: async () => {
      for (const ref of [`refs/remotes/origin/${config.baseBranch}`, `refs/heads/${config.baseBranch}`]) {
        try { const tip = (await git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)).trim().toLowerCase(); if (tip) return tip; } catch { /* the next ref */ }
      }
      return null;
    },
    fetch: async branch => { await git('fetch', '--no-tags', 'origin', config.baseBranch, branch); },
    trial: async (head, baseTip, key) => {
      const merged = await trialMerge(gitAs, { head, baseTip });
      if ('conflict' in merged) return { mergeSha: null, conflict: merged.conflict, files: [], run: null };
      const files = (await git('diff', '--name-only', baseTip, merged.mergeSha)).split('\n').map(line => line.trim()).filter(Boolean);
      return { mergeSha: merged.mergeSha, conflict: [], files, run: await (options.trial ?? runTrial)({ root, base: options.base, mergeSha: merged.mergeSha, changedFiles: files, timeoutMs: settings.timeoutMinutes * 60_000, key, run }) };
    },
  };
}

/**
 * The loop's own reads when the effects carry none: the coordinator checkout is the loop's working
 * directory, and the verdict is posted with the loop's coordinator credential. A test hands its own
 * through `effects.shadow`; a loop with `run.shadowGate.enabled` false never builds them.
 */
export function defaultShadowReads(config: MasterConfig, run: ChildRun = defaultChildRun, root: string = process.cwd()): ShadowReads {
  return shadowReads(config, root, run, { base: worktreeRoot(root, config), record: async (work, verdict) => {
    const response = await fetch(`${config.url}/api/work/${work.id}/shadow-verdict`, { method: 'POST',
      headers: { Authorization: `Bearer ${await readCredentialFile(config.credentialFile)}`, 'Content-Type': 'application/json', 'Idempotency-Key': `shadow:${work.id}:${verdict.head}:${verdict.baseTip}` },
      body: JSON.stringify({ head: verdict.head, baseTip: verdict.baseTip, mergeSha: verdict.mergeSha, risk: verdict.risk, build: verdict.build, tests: verdict.tests, conflict: verdict.conflict, durationMs: verdict.durationMs }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Graphyard refused shadow-verdict (${response.status}): ${(await response.json().catch(() => null))?.error ?? 'no reason given'}`);
  } });
}
const loopReads = new WeakMap<DaemonState, ShadowReads>();

interface Flight { key: string; head: string; baseTip: string; settled: { error: unknown } | { verdict: Omit<ShadowVerdict, 'outcome'>; work: Work } | null }
const flights = new WeakMap<DaemonState, Flight>();
/** A settled trial whose verdict the coordinator has not yet recorded; at most one per loop, since one trial runs at a time. */
const unrecorded = new WeakMap<DaemonState, { verdict: Omit<ShadowVerdict, 'outcome'>; work: Work }>();
/** Resolves once the trial in flight for `state` has settled; for the step's tests. */
export const shadowIdle = async (state: DaemonState) => { for (let waited = 0; flights.get(state) && !flights.get(state)!.settled && waited < 600_000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5)); };

/**
 * The cursor keeps the newest `shadowKeptVerdicts`. When over, verdicts of items no longer open at
 * that head go first, so a still-open (head, tip) pair is never evicted and tried again while
 * anything else can make room.
 */
export function keepVerdicts<T extends Pick<ShadowVerdict, 'id' | 'head'>>(verdicts: T[], work: readonly Work[]): T[] {
  let excess = verdicts.length - shadowKeptVerdicts;
  if (excess <= 0) return verdicts;
  const open = (verdict: Pick<ShadowVerdict, 'id' | 'head'>) => work.some(item => item.id === verdict.id && item.stage !== 'done' && item.candidate?.sha.toLowerCase() === verdict.head);
  const evicted = new Set<T>();
  for (const verdict of verdicts) if (excess > 0 && !open(verdict)) { evicted.add(verdict); excess -= 1; }
  for (const verdict of verdicts) if (excess > 0 && !evicted.has(verdict)) { evicted.add(verdict); excess -= 1; }
  return verdicts.filter(verdict => !evicted.has(verdict));
}

const shadowAttentionKey = (key: string) => `shadow:${key}`;
const disagreement = (outcome: string) => outcome === 'shadow-only-fail' || outcome === 'shadow-missed';

/**
 * Cycle step 6b' (after the merge step). One trial runs at a time, beside the cycle: the step
 * starts the oldest submitted head owed one, and the cycle after it settles records the verdict.
 * It makes no GitHub call, pushes nothing and moves no `refs/heads/*`. Outcomes are re-judged
 * against the snapshot every cycle, and a disagreement raises one escalation line per item, once.
 */
export async function shadowStep(cycle: Cycle) {
  const { config, state, effects, now, snapshot, performed } = cycle;
  // The effects may carry their own reads (a test's); otherwise the loop builds the default once.
  let reads = (effects as { shadow?: ShadowReads | null }).shadow;
  if (reads === undefined && shadowGateSettings(config.run).enabled) { reads = loopReads.get(state); if (!reads) loopReads.set(state, reads = defaultShadowReads(config)); }
  if (!reads?.enabled) return;
  let changed = false;
  const flight = flights.get(state);
  if (flight?.settled) {
    flights.delete(state);
    if ('error' in flight.settled) {
      const reason = flight.settled.error instanceof Error ? flight.settled.error.message : String(flight.settled.error);
      performed.push(storeAction(state, `shadow-error:${flight.head}:${flight.baseTip}`, { kind: 'merge', work: flight.key, principal: null, state: 'failed', detail: `Shadow trial of ${flight.key} head ${flight.head} on ${flight.baseTip} could not run, so no verdict was recorded: ${reason}`.slice(0, 1900), attempts: 1, epoch: null, cycle: state.cycle, at: new Date(now()).toISOString() }, null));
    } else unrecorded.set(state, flight.settled);
  }
  // A settled verdict joins the cursor only once the coordinator has recorded it: a refused or
  // dropped post is retried next cycle under the same idempotency key, and no new trial starts meanwhile.
  const owed = unrecorded.get(state);
  if (owed) {
    try {
      await reads.record(owed.work, owed.verdict);
      unrecorded.delete(state);
      state.shadow = keepVerdicts([...state.shadow, { ...owed.verdict, outcome: 'pending' as const }], snapshot.work);
      changed = true;
    } catch (error) {
      performed.push(storeAction(state, `shadow-record:${owed.verdict.head}:${owed.verdict.baseTip}`, { kind: 'merge', work: owed.verdict.key, principal: null, state: 'failed', detail: `The shadow verdict for ${owed.verdict.key} is not yet recorded by the coordinator and is retried next cycle: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1900), attempts: 1, epoch: null, cycle: state.cycle, at: new Date(now()).toISOString() }, null));
    }
  }
  // Outcomes follow GitHub's gate as the snapshot shows it; a disagreement is raised once per item.
  const judged = judgedVerdicts(state.shadow, snapshot.work);
  for (const [index, verdict] of judged.entries()) {
    if (verdict.outcome === state.shadow[index]!.outcome) continue;
    state.shadow[index] = { ...state.shadow[index]!, outcome: verdict.outcome };
    changed = true;
    const key = shadowAttentionKey(verdict.key);
    if (disagreement(verdict.outcome) && !state.actions[key]) performed.push(storeAction(state, key, { kind: 'escalation', work: verdict.key, principal: null, state: 'done', detail: shadowDisagreementDetail(verdict), attempts: 1, epoch: null, cycle: state.cycle, at: new Date(now()).toISOString() }, null));
  }
  if (!flights.has(state) && !unrecorded.has(state)) {
    const tip = await reads.mainTip();
    // A head whose trial could not run against this tip is not tried again against it.
    const open = snapshot.work.filter(item => !item.candidate || !state.actions[`shadow-error:${item.candidate.sha.toLowerCase()}:${tip}`]);
    const due = tip ? shadowDue(open, state.shadow, tip) : null;
    if (tip && due?.candidate) {
      const head = due.candidate.sha.toLowerCase(), branch = due.candidate.branch, started = now();
      const entry: Flight = { key: due.key, head, baseTip: tip, settled: null };
      flights.set(state, entry);
      void (async () => {
        await reads.fetch(branch);
        const trial = await reads.trial(head, tip, due.key);
        const risk = classifyRisk(trial.files.map(path => ({ path }))).risk;
        const build = trial.run?.build ?? 'fail';
        return { key: due.key, id: due.id, head, baseTip: tip, mergeSha: trial.mergeSha, risk, build, tests: trial.run?.tests ?? { passed: 0, failed: [], files: 0 }, conflict: trial.conflict, durationMs: trial.run?.durationMs ?? Math.max(0, now() - started), at: new Date(now()).toISOString() };
      })().then(verdict => { entry.settled = { verdict, work: due }; }, error => { entry.settled = { error }; });
    }
  }
  if (changed) await effects.persist(state);
}

/** The `shadowGate` section of `master status`: the report over the cursor's recorded outcomes (the step re-judges them every cycle). */
export const shadowGateSummary = (shadow: readonly ShadowVerdict[]) => shadowReport(shadow, []);

export function shadowDisagreementDetail(verdict: Pick<ShadowVerdict, 'key' | 'head' | 'mergeSha' | 'outcome'>) {
  return `Shadow merge gate: ${verdict.key} head ${verdict.head} is ${verdict.outcome} (trial merge ${verdict.mergeSha ?? 'none: it conflicts'}); `
    + `${verdict.outcome === 'shadow-missed' ? 'the shadow trial passed it but the main guard reverted it' : 'the shadow trial failed it but GitHub merged it'}. Report only: nothing is changed`;
}
