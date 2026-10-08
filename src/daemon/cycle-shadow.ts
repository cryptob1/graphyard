// Concern: the shadow merge gate's cycle step (GY-1522) — trial-merge one submitted head per cycle beside GitHub's gate and record the verdict; it writes nothing.
import { z } from 'zod';
import type { ChildRun } from '../child-runner.js';
import type { MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import { classifyRisk } from '../model/risk-class.js';
import { shadowGateSettings } from '../master/merge-writer-settings.js';
import type { AttentionItem } from '../master/attention.js';
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

interface Flight { key: string; head: string; baseTip: string; settled: { error: unknown } | { verdict: Omit<ShadowVerdict, 'outcome'>; work: Work } | null }
const flights = new WeakMap<DaemonState, Flight>();
/** Resolves once the trial in flight for `state` has settled; for the step's tests. */
export const shadowIdle = async (state: DaemonState) => { for (let waited = 0; flights.get(state) && !flights.get(state)!.settled && waited < 600_000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5)); };

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
  const reads = effects.shadow;
  if (!reads?.enabled) return;
  let changed = false;
  const flight = flights.get(state);
  if (flight?.settled) {
    flights.delete(state);
    if ('error' in flight.settled) {
      const reason = flight.settled.error instanceof Error ? flight.settled.error.message : String(flight.settled.error);
      performed.push(storeAction(state, `shadow-error:${flight.head}:${flight.baseTip}`, { kind: 'merge', work: flight.key, principal: null, state: 'failed', detail: `Shadow trial of ${flight.key} head ${flight.head} on ${flight.baseTip} could not run, so no verdict was recorded: ${reason}`.slice(0, 1900), attempts: 1, epoch: null, cycle: state.cycle, at: new Date(now()).toISOString() }, null));
    } else {
      const { verdict, work } = flight.settled;
      state.shadow = [...state.shadow, { ...verdict, outcome: 'pending' as const }].slice(-shadowKeptVerdicts);
      changed = true;
      await reads.record(work, verdict).catch(error => { performed.push(storeAction(state, `shadow-record:${verdict.head}`, { kind: 'merge', work: verdict.key, principal: null, state: 'failed', detail: `The shadow verdict for ${verdict.key} was kept in the cursor but the coordinator did not record it: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1900), attempts: 1, epoch: null, cycle: state.cycle, at: new Date(now()).toISOString() }, null)); });
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
  if (!flights.has(state)) {
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

export function shadowDisagreementDetail(verdict: Pick<ShadowVerdict, 'key' | 'head' | 'mergeSha' | 'outcome'>) {
  return `Shadow merge gate: ${verdict.key} head ${verdict.head} is ${verdict.outcome} (trial merge ${verdict.mergeSha ?? 'none: it conflicts'}); `
    + `${verdict.outcome === 'shadow-missed' ? 'the shadow trial passed it but the main guard reverted it' : 'the shadow trial failed it but GitHub merged it'}. Report only: nothing is changed`;
}

/** What `master status` shows: the report over the verdicts the cursor keeps, outcomes as the step last judged them. */
export const shadowGateSummary = (shadow: DaemonState['shadow']) => shadowReport(shadow, []);

/** One attention line per item that has a disagreement, naming its newest. */
export function shadowAttention(shadow: DaemonState['shadow']): AttentionItem[] {
  const newest = new Map<string, ShadowVerdict>();
  for (const verdict of shadow) if (disagreement(verdict.outcome)) newest.set(verdict.key, verdict);
  return [...newest.values()].map(verdict => ({ subject: verdict.key, text: shadowDisagreementDetail(verdict), role: 'master' as const, approvedBy: null, human: false, humanOnly: null, next: `Explain the disagreement for ${verdict.key} before the switch criterion in docs/delivery-redesign.md is judged` }));
}
