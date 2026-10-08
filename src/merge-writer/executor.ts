// Concern: the control-plane merge executor (GY-1524) — the serial queue, one merge's steps against the ledger, the leased deploy-key push and the reconcile of intents a crash left open.
import type { Work } from '../model.js';
import { riskOf } from '../model/risk-class.js';
import { mergeLedgerKinds, type MergeLedgerState } from '../model/merge-ledger.js';
import { trialFailurePrefix } from '../model/rework-ground.js';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { submittedAtOf } from './shadow.js';
import { runTrial, TrialCleanupError, type RunTrialInput, type TrialRun } from './trial.js';

/**
 * A proof's cases in a TAP stream, attributed by title prefix, as `graphyard verify` counts them
 * (cli/verify.ts `countProofCases`, which this mirrors: the CLI module is not imported into the loop).
 */
export function countProofCases(tap: string, proof: string) {
  const title = new RegExp(`^${proof.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  let executed = 0, failed = 0, skipped = 0;
  for (const line of tap.split('\n')) {
    const match = line.match(/^\s*(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/);
    if (!match || !title.test(match[2]!)) continue;
    if (match[3]) skipped++; else { executed++; if (match[1] === 'not ok') failed++; }
  }
  return { executed, failed, skipped };
}

// ---- The queue -----------------------------------------------------------------------------------

/** One queued control-plane candidate, oldest submission first. */
export interface QueuedMerge { key: string; id: string; head: string; submittedAt: string; waitingMs: number }
export interface MergeQueue {
  /** The candidate the writer merges next, or null: nothing is due, or an open intent blocks the queue. */
  next: Work | null;
  queue: QueuedMerge[];
  /** The item whose open intent (or unreconciled push) holds the queue until it is reconciled; null when none does. */
  blockedBy: string | null;
}
const open = (state: MergeLedgerState) => state.state === 'intent' || state.state === 'pushed';
const gate = (item: Work, name: string) => item.gates.find(entry => entry.name === name)?.passed === true;

/**
 * The control-plane candidates owed a merge, oldest submission first: submitted (a candidate the
 * control plane observed itself, GY-1523), not done, not returned to a worker, with the `build`
 * gate passed and, for a sensitive delta (`riskOf`), the `review` gate too. A head the writer's own
 * trial already refused (`trial failed`, GY-1524 AC-3) waits for its rework rather than a second
 * trial; one refused `base moved N times` is queued again. An item whose ledger holds an open intent
 * or an unreconciled push blocks the whole queue: `reconcileIntents` settles it before any new merge,
 * so never more than one merge is in flight.
 */
export function mergeQueue(work: readonly Work[], ledger: Readonly<Record<string, MergeLedgerState>>, now: number): MergeQueue {
  const blocking = Object.values(ledger).find(open);
  const owed = work.filter(item => {
    const candidate = item.candidate;
    if (item.stage === 'done' || !item.submission || !candidate || item.observation?.source !== 'control-plane' || item.reworkRequested || item.observation?.merged) return false;
    if (!gate(item, 'build')) return false;
    if (riskOf(item).risk === 'sensitive' && !gate(item, 'review')) return false;
    const state = ledger[item.key];
    if (state && state.head === candidate.sha.toLowerCase() && state.state === 'refused' && state.refusal?.kind === 'merge' && state.refusal.reason.startsWith(trialFailurePrefix)) return false;
    if (state && state.head === candidate.sha.toLowerCase() && state.state === 'reconciled') return false;
    return true;
  }).sort((a, b) => submittedAtOf(a) - submittedAtOf(b) || a.key.localeCompare(b.key));
  const queue = owed.map(item => { const at = submittedAtOf(item); return { key: item.key, id: item.id, head: item.candidate!.sha.toLowerCase(), submittedAt: new Date(at).toISOString(), waitingMs: Math.max(0, now - at) }; });
  return { next: blocking ? null : owed[0] ?? null, queue, blockedBy: blocking?.key ?? null };
}
/** The oldest-submitted candidate due a merge, or null while nothing is due or an open intent blocks the queue (AC-1). */
export const nextToMerge = (work: readonly Work[], ledger: Readonly<Record<string, MergeLedgerState>>, now: number) => mergeQueue(work, ledger, now).next;

// ---- The ledger events the executor records --------------------------------------------------------

/** The per-proof outcome of a trial: how many of the proof's cases ran on the merge commit, and how many failed. */
export type ProofCounts = Record<string, { executed: number; failed: number }>;
/** The trial's verdict with the files it ran and the counts of every proof the item's criteria name. */
export interface MergeTrialRun extends TrialRun { files: string[]; proofs: ProofCounts; /** The trial checkout left behind when its removal failed (trial.ts TrialCleanupError); the verdict stands. */ leftover?: string }
/** What `POST /api/work/:id/merge-record` takes: one of the five steps, with its ledger payload. */
export type MergeRecordEvent =
  | { kind: 'intent'; head: string; baseTip: string; mergeSha: string; risk: string; at: string }
  | { kind: 'trial'; head: string; baseTip: string; mergeSha: string; build: 'pass' | 'fail'; tests: TrialRun['tests']; files: string[]; proofs: ProofCounts; durationMs: number }
  | { kind: 'pushed'; mergeSha: string; pushedAt: string }
  | { kind: 'reconciled'; mergeSha: string; observedTip: string }
  | { kind: 'refused'; head: string; reason: string };
/** The ledger kind each recorded step writes; `trial` is the executor's own record beside the ledger, which the fold ignores. */
export const mergeRecordKinds = { ...mergeLedgerKinds, trial: 'merge.trial' } as const;
/** The idempotency key one step keeps across retries: the item, the step and the commits it names. */
export const mergeRecordKey = (work: Pick<Work, 'id'>, event: MergeRecordEvent) =>
  `merge-record:${work.id}:${event.kind}:${event.kind === 'pushed' || event.kind === 'reconciled' ? event.mergeSha : `${event.head}:${'baseTip' in event ? event.baseTip : 'refused'}`}`;

/** The refusal a failed trial records: the conflicting paths, the failing build step, or the failing test files (AC-3). */
export function trialFailureReason(trial: { conflict?: readonly string[]; run?: Pick<TrialRun, 'build' | 'tests'> | null }): string | null {
  if (trial.conflict?.length) return `${trialFailurePrefix}: the merge conflicts in ${trial.conflict.slice(0, 20).join(', ')}`;
  const run = trial.run;
  if (!run) return `${trialFailurePrefix}: the trial reached no verdict`;
  if (run.build === 'fail') return `${trialFailurePrefix}: build step npm run build`;
  if (run.tests.failed.length) return `${trialFailurePrefix}: tests ${run.tests.failed.slice(0, 20).join(', ')}`;
  return null;
}
/** The refusal of a head whose push the base tip moved under `times` times (AC-3); it leaves the head queued. */
export const baseMovedReason = (times: number) => `base moved ${times} times`;
/** The refusal of a push the remote rejected while the base tip stood still: not a moved tip, so no re-trial; the head stays queued for a later cycle. */
export const unmovedTipReason = (base: string, baseTip: string) => `push rejected though ${base} still stood at ${baseTip.slice(0, 12)}`;
/** The refusal of an intent a crash left open whose merge commit the base does not hold: the head is queued again (AC-5). */
export const unpushedIntentReason = (mergeSha: string, base: string) => `intent ${mergeSha.slice(0, 12)} was never pushed: ${base} does not hold it, so the head is queued again`;

// ---- The push --------------------------------------------------------------------------------------

/** The SSH command the push child runs: the deploy key alone, no agent identities, new hosts accepted on first contact. */
export const deployKeySshCommand = (deployKeyFile: string) => `ssh -i ${deployKeyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
/**
 * The variables the push child inherits, and nothing else (AC-2): what `git` and `ssh` need to find
 * their binaries, the known-hosts file and a locale. An allowlist, not a denylist: a credential
 * under any other name (GIT_ASKPASS, AWS_SECRET_ACCESS_KEY, GH_ENTERPRISE_TOKEN, …) never reaches it.
 */
export const pushInheritedVariables = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'] as const;
/**
 * The push child's environment (AC-2): the allowlisted variables above, git's global and system
 * configuration off, no terminal prompt, and the one credential, the deploy key, as GIT_SSH_COMMAND.
 */
export function pushEnvironment(deployKeyFile: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept = Object.fromEntries(pushInheritedVariables.flatMap(name => typeof environment[name] === 'string' ? [[name, environment[name]!] as const] : []));
  return { ...kept, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: deployKeySshCommand(deployKeyFile) };
}
/** `git push origin --force-with-lease=refs/heads/BASE:<baseTip> <mergeSha>:refs/heads/BASE`: the merge commit lands only on the tip it was tested on. */
export const pushArgs = (base: string, baseTip: string, mergeSha: string) => ['push', 'origin', `--force-with-lease=refs/heads/${base}:${baseTip}`, `${mergeSha}:refs/heads/${base}`];
/**
 * Whether a failed push was rejected because the tip moved under its lease: git words exactly that
 * `! [rejected] … (stale info)`. A remote's own refusal (`! [remote rejected] … (protected branch
 * hook declined)`), a non-fast-forward without a lease or a transport failure is no stale lease,
 * and never enters the re-trial path (AC-3).
 */
export const staleLeaseRejection = (output: string) => /\bstale info\b/i.test(output);

/**
 * Whether the base branch's first-parent history holds `sha`, exactly and unbounded (AC-5): the
 * first-parent walk from `ref` down to the first ancestor of `sha` (`git rev-list --first-parent
 * REF ^SHA`) ends right above `sha` when, and only when, `sha` is on that chain — then the oldest
 * commit listed has `sha` as its first parent, or nothing is listed because the tip is `sha`
 * itself. A commit merged in as a second parent, or unknown to the checkout, is not held.
 */
export async function firstParentHolds(git: (args: string[]) => Promise<string>, ref: string, sha: string): Promise<boolean> {
  const wanted = sha.toLowerCase();
  let listed: string[];
  try { listed = (await git(['rev-list', '--first-parent', ref, `^${wanted}`])).split('\n').map(line => line.trim().toLowerCase()).filter(Boolean); }
  catch { return false; }
  if (!listed.length) return (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim().toLowerCase() === wanted;
  try { return (await git(['rev-parse', '--verify', '--quiet', `${listed[listed.length - 1]}^1`])).trim().toLowerCase() === wanted; }
  catch { return false; }
}

// ---- The trial on the merged tree ------------------------------------------------------------------

/** The unit and integration proofs the item's criteria name: the ones whose cases a test file can carry. */
export const criterionProofs = (work: Pick<Work, 'criteria'>) => [...new Set(work.criteria.flatMap(criterion => criterion.proofs.filter(proof => /^(unit|integration):/.test(proof))))];

/**
 * Every test file in the merge commit whose source names one of `proofs`, read from the object store
 * (`git grep` at the commit), so the trial runs the criterion→test bindings whatever the affected
 * selection says. No match is no file, never an error.
 */
export async function proofTestFiles(run: ChildRun, root: string, mergeSha: string, proofs: readonly string[]): Promise<string[]> {
  if (!proofs.length) return [];
  let out: string;
  try { out = String(await run('git', ['-C', root, 'grep', '-l', '-F', ...proofs.flatMap(proof => ['-e', proof]), mergeSha, '--', 'tests/*.test.ts'])); }
  catch (error) {
    // Exit 1 is no match; anything else is a read the trial cannot do without.
    if ((error as { status?: number | null }).status === 1) return [];
    throw error;
  }
  return [...new Set(out.split('\n').map(line => line.trim()).filter(Boolean).map(line => line.slice(line.indexOf(':') + 1)).filter(path => /^tests\/[\w./-]+\.test\.ts$/.test(path)))].sort();
}

export interface MergeTrialInput extends RunTrialInput {
  /** The item's `unit:`/`integration:` proof ids, counted per proof from the TAP stream. */
  proofs: readonly string[];
  /** The test files those proofs' cases live in (`proofTestFiles`), run beside the affected selection. */
  proofFiles: readonly string[];
}
const runner = 'tests/helpers/run-tests.ts';
const listed = (out: string) => out.split('\n').map(line => line.trim()).filter(line => /^tests\/[\w./-]+\.test\.ts$/.test(line));
const childOutput = (error: unknown) => { const failed = error as { stdout?: unknown; stderr?: unknown }; return `${typeof failed.stdout === 'string' ? failed.stdout : ''}${typeof failed.stderr === 'string' ? failed.stderr : ''}`; };

/**
 * The shadow gate's trial (trial.ts `runTrial`) on the merge commit, with the test selection
 * widened to the files carrying the item's proofs and the run reported as TAP, so the verdict counts
 * each proof's executed and failed cases (AC-2). The child runner is decorated, never the trial:
 * the affected selection (`scripts/ci-tests.mjs affected`, or the `select` fallback an older merge
 * needs) gains the proof files it lacks, and the test run gets the TAP reporter on stdout, which
 * `runTrial` still reads its failing files from.
 */
export async function runMergeTrial(input: MergeTrialInput): Promise<MergeTrialRun> {
  const inner = input.run ?? defaultChildRun;
  let tap = '', files: string[] = [];
  const widened = (out: string) => {
    const have = listed(out);
    // A `full:` selection that lists nothing hands over to `select`; the files are added to that run instead.
    if (!have.length && /^full:/.test(out.trimStart())) return out;
    const extra = input.proofFiles.filter(path => !have.includes(path));
    files = [...have, ...extra];
    return extra.length ? `${out.replace(/\s+$/, '')}\n${extra.join('\n')}\n` : out;
  };
  const run: ChildRun = async (command, args, options) => {
    if (command === 'node' && args[0] === 'scripts/ci-tests.mjs' && (args[1] === 'affected' || args[1] === 'select')) return widened(String(await inner(command, args, options)));
    const at = command === 'node' ? args.indexOf(runner) : -1;
    if (at < 0) return inner(command, args, options);
    try { const out = String(await inner(command, [...args.slice(0, at + 1), '--test-reporter=tap', '--test-reporter-destination=stdout', ...args.slice(at + 1)], options)); tap = out; return out; }
    catch (error) { tap = childOutput(error); throw error; }
  };
  const counted = (): ProofCounts => Object.fromEntries(input.proofs.map(proof => { const { executed, failed } = countProofCases(tap, proof); return [proof, { executed, failed }]; }));
  let verdict: TrialRun;
  try { verdict = await runTrial({ ...input, run }); }
  catch (error) {
    // A checkout that would not go is reported beside the verdict it reached, not in place of it.
    if (error instanceof TrialCleanupError && error.verdict) return { ...error.verdict, files, proofs: counted(), leftover: error.message };
    throw error;
  }
  return { ...verdict, files, proofs: counted() };
}

// ---- One merge, step by step against the ledger ------------------------------------------------------

/** The trial merge of one head onto one tip: the merge commit and the files it changes against the tip, or the conflicting paths. */
export type MergeOutcomeOfTrial = { mergeSha: string; files: string[] } | { conflict: string[] };
/** Everything `mergeOne` and `reconcileIntents` touch outside the process: git in the coordinator checkout, the deploy-key push, and the coordinator's ledger. */
export interface MergePorts {
  baseBranch: string;
  /** How many times a rejected push is re-trialled on the new tip (`run.mergeWriter.retrials`). */
  retrials: number;
  now(): number;
  /** Fetches the base branch into the checkout (the head is already in its object store, GY-1523); answers the base tip. */
  fetch(): Promise<string>;
  /** The trial merge of `head` onto `baseTip` in the object store (trial.ts `trialMerge`): a commit, or the conflict. */
  merge(head: string, baseTip: string): Promise<MergeOutcomeOfTrial>;
  /** The build and tests on `mergeSha` (`runMergeTrial`), `files` being what the merge changes, with the item's proofs counted. */
  trial(mergeSha: string, files: readonly string[], item: Pick<Work, 'key' | 'criteria'>): Promise<MergeTrialRun>;
  /** The leased push of `mergeSha` onto `baseTip`; `rejected` when the remote reported a stale lease (`staleLeaseRejection`), any other failure thrown. */
  push(mergeSha: string, baseTip: string): Promise<'pushed' | 'rejected'>;
  /** Whether the base branch's first-parent history holds `sha`, as last fetched. */
  holds(sha: string): Promise<boolean>;
  /** Records one step on the coordinator (`POST /api/work/:id/merge-record`), idempotent under `mergeRecordKey`. */
  record(item: Pick<Work, 'id' | 'key'>, event: MergeRecordEvent): Promise<unknown>;
}
export type MergeOutcome =
  | { outcome: 'merged'; mergeSha: string; baseTip: string; observedTip: string; pushes: number }
  | { outcome: 'refused'; reason: string; trial: MergeTrialRun | null; conflict: string[] }
  | { outcome: 'requeued'; reason: string; pushes: number }
  | { outcome: 'reconciled'; mergeSha: string; observedTip: string };

/**
 * One merge (AC-2): intent → trial → push → pushed → fetch → reconciled, each step recorded on
 * the ledger and so idempotent against it. The item's ledger state is read first: a head already
 * pushed, or an open intent whose merge commit the base holds, is only fetched and reconciled,
 * never pushed again. Otherwise the head is trial-merged onto the fetched tip, the intent is
 * recorded before anything runs, the trial runs on the exact merge commit with the proof files
 * included, and the merge commit is pushed with a lease on the tip it was tested on. A rejected push
 * re-reads the tip: one that moved is re-trialled on the new tip, at most `retrials` times (AC-3);
 * one that stood still was rejected for another cause and is refused `unmovedTipReason`, queued
 * for a later cycle rather than re-trialled. A failed trial or a conflict is refused naming what
 * failed, and the rework that refusal grounds is the loop's to request.
 */
export async function mergeOne(ports: MergePorts, item: Work): Promise<MergeOutcome> {
  const candidate = item.candidate;
  if (!candidate || !item.submission) throw new Error(`${item.key} has no submitted candidate to merge`);
  const head = candidate.sha.toLowerCase(), state = item.mergeLedger;
  const at = () => new Date(ports.now()).toISOString();
  const settle = async (mergeSha: string): Promise<MergeOutcome> => {
    const observedTip = await ports.fetch();
    await ports.record(item, { kind: 'reconciled', mergeSha, observedTip });
    return { outcome: 'reconciled', mergeSha, observedTip };
  };
  // Idempotency against the ledger: what an earlier process recorded is finished, not repeated.
  if (state && state.head === head && state.mergeSha && (state.state === 'pushed' || state.state === 'intent')) {
    await ports.fetch();
    if (await ports.holds(state.mergeSha)) {
      if (state.state === 'intent') await ports.record(item, { kind: 'pushed', mergeSha: state.mergeSha, pushedAt: at() });
      return settle(state.mergeSha);
    }
    if (state.state === 'pushed') throw new Error(`${item.key}: ${state.mergeSha.slice(0, 12)} is recorded pushed but ${ports.baseBranch} does not hold it`);
  }
  let pushes = 0, baseTip = await ports.fetch();
  for (let attempt = 0; attempt <= ports.retrials; attempt++) {
    const merged = await ports.merge(head, baseTip);
    if ('conflict' in merged) {
      const reason = trialFailureReason({ conflict: merged.conflict })!;
      await ports.record(item, { kind: 'refused', head, reason });
      return { outcome: 'refused', reason, trial: null, conflict: merged.conflict };
    }
    const { mergeSha } = merged;
    // The intent first (AC-2): a crash from here on is reconciled against the base, never repeated blindly.
    await ports.record(item, { kind: 'intent', head, baseTip, mergeSha, risk: riskOf(item).risk, at: at() });
    const run = await ports.trial(mergeSha, merged.files, item);
    await ports.record(item, { kind: 'trial', head, baseTip, mergeSha, build: run.build, tests: run.tests, files: run.files, proofs: run.proofs, durationMs: run.durationMs });
    const failure = trialFailureReason({ run });
    if (failure) {
      await ports.record(item, { kind: 'refused', head, reason: failure });
      return { outcome: 'refused', reason: failure, trial: run, conflict: [] };
    }
    pushes += 1;
    const pushed = await ports.push(mergeSha, baseTip);
    if (pushed === 'pushed') {
      await ports.record(item, { kind: 'pushed', mergeSha, pushedAt: at() });
      const observedTip = await ports.fetch();
      await ports.record(item, { kind: 'reconciled', mergeSha, observedTip });
      return { outcome: 'merged', mergeSha, baseTip, observedTip, pushes };
    }
    // Rejected: the re-trial path is only for a tip that moved (AC-3), confirmed by re-reading it, never for a remote's refusal of the same tip.
    const movedTo = await ports.fetch();
    if (movedTo === baseTip) {
      const reason = unmovedTipReason(ports.baseBranch, baseTip);
      await ports.record(item, { kind: 'refused', head, reason });
      return { outcome: 'requeued', reason, pushes };
    }
    baseTip = movedTo;
  }
  const reason = baseMovedReason(pushes);
  await ports.record(item, { kind: 'refused', head, reason });
  return { outcome: 'requeued', reason, pushes };
}

export type ReconcileOutcome = { key: string; mergeSha: string; outcome: 'reconciled' | 'requeued' };
/**
 * Before any new merge (AC-5): every intent with no `pushed` record, and every push no
 * reconciliation followed, is settled against the base branch as fetched now. A merge commit the
 * base's first-parent history holds was pushed: it is recorded pushed (when it was not) and
 * reconciled, delivering the item without a second push. One the base does not hold was never
 * pushed: it is refused `unpushedIntentReason`, which leaves the head queued for a fresh merge.
 */
export async function reconcileIntents(ports: MergePorts, work: readonly Work[], ledger: Readonly<Record<string, MergeLedgerState>>): Promise<ReconcileOutcome[]> {
  const pending = Object.values(ledger).filter(state => open(state) && state.mergeSha && state.head);
  if (!pending.length) return [];
  const observedTip = await ports.fetch();
  const outcomes: ReconcileOutcome[] = [];
  for (const state of pending) {
    const item = work.find(entry => entry.key === state.key);
    if (!item) continue;
    const mergeSha = state.mergeSha!;
    if (await ports.holds(mergeSha)) {
      if (state.state === 'intent') await ports.record(item, { kind: 'pushed', mergeSha, pushedAt: new Date(ports.now()).toISOString() });
      await ports.record(item, { kind: 'reconciled', mergeSha, observedTip });
      outcomes.push({ key: state.key, mergeSha, outcome: 'reconciled' });
    } else {
      await ports.record(item, { kind: 'refused', head: state.head!, reason: unpushedIntentReason(mergeSha, ports.baseBranch) });
      outcomes.push({ key: state.key, mergeSha, outcome: 'requeued' });
    }
  }
  return outcomes;
}
