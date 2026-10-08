// Concern: the shadow merge gate's cycle step (GY-1522) — trial-merge one submitted head per cycle beside GitHub's gate and record the verdict; it writes nothing.
import { z } from 'zod';
import type { ChildRun } from '../child-runner.js';
import type { MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import { classifyRisk } from '../model/risk-class.js';
import { shadowGateSettings } from '../master/merge-writer-settings.js';
import { runTrial, trialMerge, trialNeedsLog, TrialCleanupError, TrialRunnerError, TrialTimeoutError, type TrialRun } from '../merge-writer/trial.js';
import { judgedVerdicts, shadowDisagreement, shadowDisagreementDetail, shadowOutcomes, shadowDue, shadowReport, trialLogTailLength, type ShadowVerdict } from '../merge-writer/shadow.js';
import { storeAction, type DaemonState } from './state.js';
import type { Cycle } from './cycle.js';

/** How many verdicts `state.shadow` keeps, newest last. */
export const shadowKeptVerdicts = 200;
export const shadowVerdictSchema = z.object({
  key: z.string().max(100), id: z.string().max(100), head: z.string().max(64), baseTip: z.string().max(64), mergeSha: z.string().max(64).nullable(),
  risk: z.enum(['sensitive', 'normal']), build: z.enum(['pass', 'fail']),
  tests: z.object({ passed: z.number().int().min(0), failed: z.array(z.string().max(300)).max(100), files: z.number().int().min(0) }).strict(),
  conflict: z.array(z.string().max(500)).max(100), durationMs: z.number().int().min(0), at: z.string().max(64), outcome: z.enum(shadowOutcomes).default('pending'),
  delivered: z.object({ mergeSha: z.string().max(64) }).strict().optional(),
}).strict();
export const shadowStateSchema = z.array(shadowVerdictSchema).max(shadowKeptVerdicts);

/** The step's reads and its one record; every git call it makes goes through the injected runner. */
export interface ShadowReads {
  enabled: boolean;
  /** The base branch tip the promotion ledger last fetched; null when the checkout holds none. */
  mainTip(): Promise<string | null>;
  /** Fetches the head's branch (and the base) into the coordinator checkout; moves no local branch. */
  fetch(branch: string): Promise<void>;
  /** The trial of `head` on `baseTip`: its merge commit, the files the merge changes, the build and test run, and the checkout left behind when its removal failed. Rejects with TrialTimeoutError past the time budget. */
  trial(head: string, baseTip: string, key: string): Promise<{ mergeSha: string | null; conflict: string[]; files: string[]; run: TrialRun | null; leftover?: string }>;
  /** Posts the verdict to the coordinator (`POST /api/work/:id/shadow-verdict`). */
  record(work: Work, verdict: Omit<ShadowVerdict, 'outcome'>): Promise<void>;
}

/** The body `POST /api/work/:id/shadow-verdict` takes (with the log tail when the verdict carries one), and the idempotency key one (head, baseTip) pair keeps across retries. */
export const shadowVerdictBody = (verdict: Omit<ShadowVerdict, 'outcome'>) => ({ head: verdict.head, baseTip: verdict.baseTip, mergeSha: verdict.mergeSha, risk: verdict.risk, build: verdict.build, tests: verdict.tests, conflict: verdict.conflict, durationMs: verdict.durationMs, ...(verdict.logTail === undefined ? {} : { logTail: verdict.logTail }) });
export const shadowVerdictKey = (work: Pick<Work, 'id'>, verdict: Pick<ShadowVerdict, 'head' | 'baseTip'>) => `shadow:${work.id}:${verdict.head}:${verdict.baseTip}`;

/**
 * The shadow reads over the coordinator checkout `root` (its object store holds the trial
 * commit). Git writes are limited to the trial ref; a trial checkout under `base` is the only
 * worktree made. The loop wires them in effects.ts; a test hands its own through `effects.shadow`.
 */
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
      try { return { mergeSha: merged.mergeSha, conflict: [], files, run: await (options.trial ?? runTrial)({ root, base: options.base, mergeSha: merged.mergeSha, changedFiles: files, timeoutMs: settings.timeoutMinutes * 60_000, key, run }) }; }
      catch (error) {
        // A checkout that would not go is reported beside the verdict it reached, not in place of it.
        if (error instanceof TrialCleanupError && error.verdict) return { mergeSha: merged.mergeSha, conflict: [], files, run: error.verdict, leftover: error.message };
        throw error;
      }
    },
  };
}

interface Flight { key: string; head: string; baseTip: string; settled: { error: unknown } | { verdict: Omit<ShadowVerdict, 'outcome'>; work: Work; leftover?: string } | null }
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
/** The action key under which a trial that could not run against one tip is remembered, so it is not retried against that tip. */
export const shadowErrorKey = (head: string, baseTip: string) => `shadow-error:${head}:${baseTip}`;
/** The action key counting a head's timed-out trials against one tip; the pair stays owed until `shadowTimeoutRetries` of them. */
export const shadowTimeoutKey = (head: string, baseTip: string) => `shadow-timeout:${head}:${baseTip}`;
/** How many trials of one (head, tip) pair may time out before the pair is given up against that tip and one attention line names it. */
export const shadowTimeoutRetries = 3;
/** The action key of a leftover trial checkout, recorded beside the verdict its trial reached. */
export const shadowLeftoverKey = (head: string, baseTip: string) => `shadow-leftover:${head}:${baseTip}`;
/**
 * The action key of a head's runner failures against one tip (GY-1548): the diagnostic record of a
 * trial whose runner exited naming no failing test, counting them; the pair stays owed until
 * `shadowRunnerRetries` of them.
 */
export const shadowRunnerKey = (head: string, baseTip: string) => `shadow-runner:${head}:${baseTip}`;
/** How many trials of one (head, tip) pair may end in a runner failure before the pair is given up against that tip and one attention line names it. */
export const shadowRunnerRetries = 2;
const failures = (state: DaemonState, key: string) => { const action = state.actions[key]; return action?.state === 'failed' ? action.attempts : 0; };
const timeouts = (state: DaemonState, head: string, baseTip: string) => failures(state, shadowTimeoutKey(head, baseTip));
const runnerFailures = (state: DaemonState, head: string, baseTip: string) => failures(state, shadowRunnerKey(head, baseTip));
/**
 * The diagnostic record of a runner failure: the pair and its trial merge, the phase, the exit
 * status or signal, the failing group's size and how many of its files finished, then the child's
 * bounded output tail, within one action's detail. The trial withheld every credential-bearing
 * variable (`credentialTrialVariable`), so the tail is credential-free.
 */
export function shadowRunnerDetail(flight: { key: string; head: string; baseTip: string }, error: TrialRunnerError, attempts: number, given: boolean) {
  const exit = error.signal ? `signal ${error.signal}` : `status ${error.status ?? 'unknown'}`;
  const group = error.files.length ? `, ${error.finished} of the group's ${error.files.length} file(s) finished (${error.files.slice(0, 5).join(', ')}${error.files.length > 5 ? ', …' : ''})` : '';
  const prose = `Shadow trial of ${flight.key} head ${flight.head} on ${flight.baseTip} (trial merge ${error.mergeSha}) met a runner failure (${attempts} of ${shadowRunnerRetries}): its ${error.phase} runner exited (${exit}) naming no failing test${group}; a runner exit naming no test measures the host, not the merge, so it is no verdict and ${given ? 'the pair is given up against this tip' : 'the pair is tried again once no other head is due'}. Output tail: `;
  return `${prose}${error.outputTail.slice(-Math.max(0, 1900 - prose.length))}`;
}

/**
 * Cycle step 6b' (after the merge step). One trial runs at a time, beside the cycle: the step
 * starts the oldest submitted head owed one, and the cycle after it settles records the verdict.
 * It makes no GitHub call, pushes nothing and moves no `refs/heads/*`. Outcomes are re-judged
 * against the snapshot every cycle, and a disagreement raises one escalation line per item, once.
 * Without `effects.shadow` (a loop wired without the reads, or a test) or with the gate off, the
 * step does nothing. A trial that errs records no verdict and is not retried against the same tip.
 * A timeout measures the host, not the merge: it records no verdict either, and the pair stays
 * owed, tried again once no other head is due, until `shadowTimeoutRetries` timeouts give it up
 * against that tip under one attention line. A runner that exits naming no failing test is the
 * same kind of thing (GY-1548): its diagnostic record is kept under `shadowRunnerKey`, no verdict
 * and so no `shadow-only-fail` follows, and `shadowRunnerRetries` such exits give the pair up
 * under one attention line. A named failing test is the merge's and stays a failing verdict.
 */
export async function shadowStep(cycle: Cycle) {
  const { state, effects, now, snapshot, performed } = cycle;
  const reads = effects.shadow;
  if (!reads?.enabled) return;
  let changed = false;
  const flight = flights.get(state);
  if (flight?.settled) {
    flights.delete(state);
    const at = new Date(now()).toISOString();
    if ('error' in flight.settled) {
      const error = flight.settled.error;
      if (error instanceof TrialTimeoutError) {
        const attempts = timeouts(state, flight.head, flight.baseTip) + 1, given = attempts >= shadowTimeoutRetries;
        performed.push(storeAction(state, shadowTimeoutKey(flight.head, flight.baseTip), { kind: 'merge', work: flight.key, principal: null, state: 'failed', detail: `Shadow trial of ${flight.key} head ${flight.head} on ${flight.baseTip} timed out (${attempts} of ${shadowTimeoutRetries}): ${error.message}; a timeout measures the host, not the merge, so it is no verdict and ${given ? 'the pair is given up against this tip' : 'the pair is tried again once no other head is due'}`.slice(0, 1900), attempts, epoch: null, cycle: state.cycle, at }, null));
        if (given) performed.push(storeAction(state, `shadow-timeouts:${flight.key}:${flight.baseTip}`, { kind: 'escalation', work: flight.key, principal: null, state: 'done', detail: `Shadow merge gate timeouts: ${flight.key} head ${flight.head} timed out ${attempts} times on ${flight.baseTip}, so it has no verdict against this tip; a slow host or a slow merge, nothing is changed`.slice(0, 1900), attempts, epoch: null, cycle: state.cycle, at }, null));
      } else if (error instanceof TrialRunnerError) {
        const attempts = runnerFailures(state, flight.head, flight.baseTip) + 1, given = attempts >= shadowRunnerRetries;
        performed.push(storeAction(state, shadowRunnerKey(flight.head, flight.baseTip), { kind: 'merge', work: flight.key, principal: null, state: 'failed', detail: shadowRunnerDetail(flight, error, attempts, given), attempts, epoch: null, cycle: state.cycle, at }, null));
        if (given) performed.push(storeAction(state, `shadow-runner-failures:${flight.key}:${flight.baseTip}`, { kind: 'escalation', work: flight.key, principal: null, state: 'done', detail: `Shadow merge gate runner failure: ${flight.key} head ${flight.head} on ${flight.baseTip} ended ${attempts} trials with its ${error.phase} runner exiting (${error.signal ? `signal ${error.signal}` : `status ${error.status ?? 'unknown'}`}) and no failing test named, so it has no verdict against this tip; read the record under ${shadowRunnerKey(flight.head, flight.baseTip)}, nothing is changed`.slice(0, 1900), attempts, epoch: null, cycle: state.cycle, at }, null));
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        performed.push(storeAction(state, shadowErrorKey(flight.head, flight.baseTip), { kind: 'merge', work: flight.key, principal: null, state: 'failed', detail: `Shadow trial of ${flight.key} head ${flight.head} on ${flight.baseTip} could not run, so no verdict was recorded: ${reason}`.slice(0, 1900), attempts: 1, epoch: null, cycle: state.cycle, at }, null));
      }
    } else {
      if (flight.settled.leftover) performed.push(storeAction(state, shadowLeftoverKey(flight.head, flight.baseTip), { kind: 'merge', work: flight.key, principal: null, state: 'failed', detail: `Shadow trial of ${flight.key} head ${flight.head} on ${flight.baseTip} left its checkout behind; the verdict is recorded and the orphan reclaim removes the directory: ${flight.settled.leftover}`.slice(0, 1900), attempts: 1, epoch: null, cycle: state.cycle, at }, null));
      unrecorded.set(state, flight.settled);
    }
  }
  // A settled verdict joins the cursor only once the coordinator has recorded it: a refused or
  // dropped post is retried next cycle under the same idempotency key, and no new trial starts meanwhile.
  const owed = unrecorded.get(state);
  if (owed) {
    try {
      await reads.record(owed.work, owed.verdict);
      unrecorded.delete(state);
      // The cursor keeps the verdict without its log: the recorded event holds the log, and the cursor stays small.
      const { logTail: _recorded, ...kept } = owed.verdict;
      state.shadow = keepVerdicts([...state.shadow, { ...kept, outcome: 'pending' as const }], snapshot.work);
      changed = true;
    } catch (error) {
      performed.push(storeAction(state, `shadow-record:${owed.verdict.head}:${owed.verdict.baseTip}`, { kind: 'merge', work: owed.verdict.key, principal: null, state: 'failed', detail: `The shadow verdict for ${owed.verdict.key} is not yet recorded by the coordinator and is retried next cycle: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1900), attempts: 1, epoch: null, cycle: state.cycle, at: new Date(now()).toISOString() }, null));
    }
  }
  // Outcomes follow GitHub's gate as the snapshot shows it, and a verdict keeps the merge GitHub
  // made of its head (the revert of a reopened item is matched by it); a disagreement is raised once per item.
  const judged = judgedVerdicts(state.shadow, snapshot.work);
  for (const [index, verdict] of judged.entries()) {
    const current = state.shadow[index]!;
    if (verdict.outcome === current.outcome && verdict.delivered?.mergeSha === current.delivered?.mergeSha) continue;
    state.shadow[index] = verdict;
    changed = true;
    if (verdict.outcome === current.outcome) continue;
    const key = shadowAttentionKey(verdict.key);
    if (shadowDisagreement(verdict.outcome) && !state.actions[key]) performed.push(storeAction(state, key, { kind: 'escalation', work: verdict.key, principal: null, state: 'done', detail: shadowDisagreementDetail(verdict), attempts: 1, epoch: null, cycle: state.cycle, at: new Date(now()).toISOString() }, null));
  }
  if (!flights.has(state) && !unrecorded.has(state)) {
    const tip = await reads.mainTip();
    // A head whose trial could not run against this tip is not tried again against it; one that timed
    // out or met a runner failure waits its turn behind every head not yet tried, and is given up
    // after `shadowTimeoutRetries` timeouts or `shadowRunnerRetries` runner failures.
    const open = snapshot.work.filter(item => !item.candidate || !state.actions[shadowErrorKey(item.candidate.sha.toLowerCase(), tip ?? '')]);
    const deferred = (item: Work) => timeouts(state, item.candidate!.sha.toLowerCase(), tip ?? '') + runnerFailures(state, item.candidate!.sha.toLowerCase(), tip ?? '');
    const givenUp = (item: Work) => timeouts(state, item.candidate!.sha.toLowerCase(), tip ?? '') >= shadowTimeoutRetries || runnerFailures(state, item.candidate!.sha.toLowerCase(), tip ?? '') >= shadowRunnerRetries;
    const fresh = open.filter(item => !item.candidate || !deferred(item)), retryable = open.filter(item => item.candidate && deferred(item) && !givenUp(item));
    const due = tip ? shadowDue(fresh, state.shadow, tip) ?? shadowDue(retryable, state.shadow, tip) : null;
    if (tip && due?.candidate) {
      const head = due.candidate.sha.toLowerCase(), branch = due.candidate.branch, started = now();
      const entry: Flight = { key: due.key, head, baseTip: tip, settled: null };
      flights.set(state, entry);
      void (async () => {
        await reads.fetch(branch);
        const trial = await reads.trial(head, tip, due.key);
        const risk = classifyRisk(trial.files.map(path => ({ path }))).risk;
        const build = trial.run?.build ?? 'fail';
        // A trial that did not pass records the last `trialLogTailLength` characters of its output, so the verdict says why (GY-1549).
        const logTail = trial.run && trialNeedsLog(trial.run) ? { logTail: trial.run.logTail.slice(-trialLogTailLength) } : {};
        return { key: due.key, id: due.id, head, baseTip: tip, mergeSha: trial.mergeSha, risk, build, tests: trial.run?.tests ?? { passed: 0, failed: [], files: 0 }, conflict: trial.conflict, durationMs: trial.run?.durationMs ?? Math.max(0, now() - started), at: new Date(now()).toISOString(), leftover: trial.leftover, ...logTail };
      })().then(({ leftover, ...verdict }) => { entry.settled = { verdict, work: due, ...(leftover ? { leftover } : {}) }; }, error => { entry.settled = { error }; });
    }
  }
  if (changed) await effects.persist(state);
}

/** The `shadowGate` section of `master status`: the report over the cursor's recorded outcomes (the step re-judges them every cycle). */
export const shadowGateSummary = (shadow: readonly ShadowVerdict[]) => shadowReport(shadow, []);
