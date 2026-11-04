import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type CliCommand } from './registry.js';
import { changeBase, selfVerification } from './verify.js';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { leadingProof } from '../model/flake-ledger.js';
import { trialFailurePrefix } from '../model/rework-ground.js';
import { trialTimeoutMinutes } from '../master/merge-writer-settings.js';
import { trialHomeVariables, trialTemporaryMode, trialTemporaryVariables } from '../merge-writer/trial.js';

/**
 * A submission is observed on GitHub before it is accepted, so while the control plane's GitHub
 * client is paused after a rate limit the control plane refuses it with "GitHub requests paused
 * until <reset>". That refusal says nothing about the work: `complete` waits for the named reset
 * and submits again, the same request under the same idempotency key. The wait is bounded — a reset
 * further away than `maxWaitMs` in total, or more than `maxAttempts` refusals, fails as before with
 * the control plane's own message — and any other refusal fails at once.
 */
export const pauseRetry = { maxWaitMs: 20 * 60_000, maxAttempts: 6, marginMs: 2_000, unnamedWaitMs: 60_000 };
/** The reset a GitHub-pause refusal names: a time, `unnamed` when the refusal names none, or null for any other refusal. */
export function githubPauseReset(error: unknown): Date | 'unnamed' | null {
  const text = error instanceof Error ? error.message : String(error);
  if (!/GitHub requests paused|requests paused until/.test(text)) return null;
  const at = text.match(/paused until (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1];
  const parsed = at ? new Date(at) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : 'unnamed';
}
export async function submitThroughPause<T>(submit: () => Promise<T>, options: Partial<typeof pauseRetry> & { now?: () => number; sleep?: (ms: number) => Promise<unknown>; report?: (text: string) => void } = {}): Promise<T> {
  const bounds = { ...pauseRetry, ...options }, now = options.now ?? Date.now, sleep = options.sleep ?? delay, report = options.report ?? (text => console.error(text));
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try { return await submit(); } catch (error) {
      const reset = githubPauseReset(error);
      if (reset === null || attempt >= bounds.maxAttempts) throw error;
      const wait = reset === 'unnamed' ? bounds.unnamedWaitMs : Math.max(0, reset.getTime() - now()) + bounds.marginMs;
      if (now() + wait - started > bounds.maxWaitMs) {
        throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)} (complete waits at most ${Math.round(bounds.maxWaitMs / 60_000)} minutes for a GitHub request pause; submit again after the reset)`), { cause: error });
      }
      report(`GitHub requests are paused${reset === 'unnamed' ? '' : ` until ${reset.toISOString()}`}; complete submits again in ${Math.ceil(wait / 1000)}s (attempt ${attempt + 1} of at most ${bounds.maxAttempts})`);
      await sleep(wait);
    }
  }
}

/** The commit the worktree at `root` has checked out, for `--head` with no SHA. */
export function worktreeHead(root: string): string {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`complete --head could not read the worktree's HEAD: ${result.stderr.trim() || result.error?.message || `git exited ${result.status}`}`);
  return result.stdout.trim();
}
/**
 * What `complete GY-N EPOCH [--head [SHA]]` submits (GY-1523): `{epoch, head}`, the SHA defaulting
 * to the worktree's HEAD. parseArgs has no flag with an optional value, so `--head` and the SHA that
 * follows it (unless the next word is a flag) are taken out before the positionals are parsed.
 */
export function completionBody(args: readonly string[], headOf: () => string): { epoch: number; head: string } {
  const rest: string[] = []; let head: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--head') { const next = args[index + 1]; if (next !== undefined && !next.startsWith('-')) { head = next; index++; } else head = undefined; continue; }
    if (argument.startsWith('--head=')) { head = argument.slice('--head='.length); continue; }
    rest.push(argument);
  }
  const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
  if (positionals[1] !== undefined) throw new Error(`complete submits a commit, never a pull request number: drop ${positionals[1]} and run complete GY-N EPOCH --head [SHA]`);
  const sha = (head ?? headOf()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`--head takes a 40-hex commit, or none for the worktree's HEAD; ${JSON.stringify(sha)} is neither`);
  return { epoch: Number(positionals[0]), head: sha };
}

/**
 * GY-2517: the failing test files the item's latest merge-writer refusal names, or none. The trial
 * refuses `trial failed: tests <file, …>` (merge-writer/executor.ts); a conflict, a failed build
 * step or a trial that reached no verdict, a revert refusal and no refusal at all name no test
 * files, so none is re-run for them.
 * GY-2979: since GY-2960 an entry is a label, `FILE: case title`, and a first failing case rides
 * after the files, its own commas splitting into prose — so an entry names a file only when the
 * text before its ': ' is a path to an existing test file of `root`, the tree the rerun would run;
 * anything else — a title fragment, an entry naming no file — names none.
 */
const testFilePath = /^tests\/[\w./-]+$/;
export function trialFailureTests(refusal: { kind: string; reason: string } | null | undefined, root?: string): string[] {
  const prefix = `${trialFailurePrefix}: tests `;
  if (refusal?.kind !== 'merge' || !refusal.reason.startsWith(prefix)) return [];
  const files = new Set<string>();
  for (const entry of refusal.reason.slice(prefix.length).split(',')) {
    const path = (entry.split(': ')[0] ?? '').trim();
    if (!testFilePath.test(path)) continue;
    if (root && !existsSync(join(root, path))) continue;
    files.add(path);
  }
  return [...files];
}
/** The rerun runs under the trial's own bound: its failing files are a subset of what the trial ran (GY-2517). */
export const rerunBound = { ms: trialTimeoutMinutes * 60_000 };
const boundText = (ms: number) => ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
/**
 * GY-2974: the command that runs exactly `files` in `root`. `npm test -- FILES` ran the whole suite
 * wherever the test script already globs every file (Open City's GY-101 hung 24 minutes on it), so
 * the files go straight to a runner: Graphyard's own suite runner, which runs just the files it is
 * given under the suite's isolation, else node's test runner, through tsx when the tree installs it.
 */
export function rerunCommand(root: string, files: readonly string[]): [string, string[]] {
  if (existsSync(join(root, 'tests', 'helpers', 'run-tests.ts'))) return [process.execPath, ['--import', 'tsx', 'tests/helpers/run-tests.ts', ...files]];
  let tsx = true;
  try { createRequire(join(root, 'package.json')).resolve('tsx'); } catch { tsx = false; }
  return [process.execPath, [...(tsx ? ['--import', 'tsx'] : []), '--test', ...files]];
}
/**
 * GY-2517: re-run `files` in the worktree and answer whether they passed, with the output captured
 * so the caller prints it. The run is its own process group, killed whole at the bound (GY-2974);
 * `timedOut` marks a run the bound ended — GY-2980: a fault of the run, judged beside every other
 * rerun fault, never a refusal by itself.
 */
export async function rerunTrialFiles(root: string, files: readonly string[], run: ChildRun = defaultChildRun): Promise<{ ok: boolean; output: string; timedOut?: true }> {
  const [command, args] = rerunCommand(root, files);
  let scratch: string | undefined;
  try {
    // /var/tmp is durable scratch available to confined workers. Keep it short and outside
    // the checkout: fixture sockets have a pathname bound and upward lookups must stay clean.
    // The operator HOME stays read-only, including for runners that relocate tmpfs beneath HOME.
    scratch = await mkdtemp('/var/tmp/gy-r');
    const home = join(scratch, 'home'), temporary = join(scratch, 'tmp');
    await mkdir(home); await mkdir(temporary); await chmod(temporary, trialTemporaryMode);
    // A NODE_TEST_CONTEXT inherited from an enclosing test run suppresses the child's runner.
    const { NODE_TEST_CONTEXT: _, ...inherited } = process.env;
    const env = { ...inherited, ...trialHomeVariables(home), ...trialTemporaryVariables(temporary),
      PATH: [dirname(process.execPath), inherited.PATH].filter(Boolean).join(delimiter) };
    return { ok: true, output: await run(command, args, { cwd: root, env, timeoutMs: rerunBound.ms, group: true }) };
  }
  catch (error: any) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}` || (error instanceof Error ? error.message : String(error));
    return error?.timedOut ? { ok: false, output, timedOut: true } : { ok: false, output };
  }
  finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}

/** One failing case a rerun's output names: the case, where the run locates it, and the timing the runner reported. */
export interface RerunCase { case: string; file: string | null; line: number | null; durationMs: number | null }

const rerunTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z? ?/;
// eslint-disable-next-line no-control-regex
const rerunAnsi = /\u001b\[[0-9;]*m/g;
const specFailure = /^\s*✖ (.+?) \((\d+(?:\.\d+)?)m?s\)(?:\s+#.*)?$/;
const tapFailure = /^\s*not ok \d+ - (.+?)(\s+#\s+(?:TODO|SKIP)\b.*)?$/i;
const fileLevelFailure = /^tests\/[\w./-]+\.test\.ts$/;
const testAtLine = /^\s*test at (\S+):(\d+):\d+/;
const stackFrame = /\(([^()\s]+):(\d+):\d+\)/;
const failureMarker = (line: string): { name: string; durationMs: number | null } | null => {
  const spec = specFailure.exec(line), tap = spec ? null : tapFailure.exec(line);
  const name = (spec?.[1] ?? (tap && !tap[2] ? tap[1] : null))?.trim() ?? null;
  if (!name || name.length > 500 || fileLevelFailure.test(name)) return null;
  return { name, durationMs: spec ? Math.round(Number(spec[2]!)) : null };
};
/** Where a run located a failing case, as a refusal names it. */
export const locateRerunCase = (found: RerunCase) => `${found.case}${found.file ? ` at ${found.file}:${found.line}` : ''}`;

/**
 * GY-2968: the failing cases a rerun's runner output names, in order, without the file-level
 * `not ok tests/x.test.ts` lines. Each case carries the file and line the run itself reports —
 * node's failing-tests summary pairs a `test at file:line` line with the case printed under it,
 * and a stack frame naming one of the run's files locates a case the summary does not — and the
 * timing the spec marker carries. A case located in none of the rerun's own files stays
 * unlocated; the refusal keeps the run's output beside it, so what this run failed is named
 * either way.
 */
export function rerunFailingCases(output: string, files: readonly string[]): RerunCase[] {
  const lines = output.split('\n').map(raw => raw.replace(rerunTimestamp, '').replace(rerunAnsi, ''));
  const cases: RerunCase[] = [], byName = new Map<string, RerunCase>();
  let current: RerunCase | null = null;
  for (let index = 0; index < lines.length; index++) {
    const marker = failureMarker(lines[index]!);
    if (marker) {
      const known = byName.get(marker.name);
      if (known) { current = known; continue; } // node's failing-tests summary repeats the run's own marker
      current = { case: marker.name, file: null, line: null, durationMs: marker.durationMs };
      cases.push(current); byName.set(marker.name, current);
      continue;
    }
    const target = (): RerunCase | null => {
      // node's failing-tests summary pairs a `test at` with the case printed just below it; any
      // other locator line belongs to the case opened above it.
      const below = failureMarker(lines[index + 1] ?? '');
      return (below ? byName.get(below.name) : null) ?? current;
    };
    const at = testAtLine.exec(lines[index]!);
    if (at && files.includes(at[1]!)) {
      const located = target();
      if (located && located.file === null) { located.file = at[1]!; located.line = Number(at[2]); }
      continue;
    }
    const frame = stackFrame.exec(lines[index]!);
    if (!frame) continue;
    const path = frame[1]!.replace(/^file:\/\//, '');
    const file = files.find(candidate => path === candidate || path.endsWith(`/${candidate}`));
    const located = target();
    if (file && located && located.file === null) { located.file = file; located.line = Number(frame[2]); }
  }
  return cases;
}

/**
 * GY-2968: run `files` on the base commit's own tree — the base extracted to a scratch tree beside
 * the worktree's `.graphyard/` state, this worktree's node_modules linked in — and answer whether
 * they fail, with the output captured. The base's own files answer, never this change's; a tree
 * that cannot be extracted answers null, and the caller refuses rather than accept unverified.
 */
export async function rerunBaseFiles(root: string, base: string, files: readonly string[], run: ChildRun = defaultChildRun): Promise<{ ok: boolean; output: string } | null> {
  let scratch: string;
  try { await mkdir(join(root, '.graphyard', 'verify'), { recursive: true }); scratch = await mkdtemp(join(root, '.graphyard', 'verify', 'rerun-')); } catch { return null; }
  const tree = join(scratch, 'tree');
  try {
    await mkdir(tree);
    const extract = spawnSync('sh', ['-c', 'git archive --format=tar "$1" | tar -x -C "$2"', 'sh', base, tree], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    if (extract.status !== 0 || extract.error) return null;
    try { await symlink(await realpath(join(root, 'node_modules')), join(tree, 'node_modules')); } catch { /* no dependencies installed */ }
    return await rerunTrialFiles(tree, files, run);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

const ownProofs = (work: { criteria?: { proofs?: readonly string[] }[] }) => new Set((work.criteria ?? []).flatMap(criterion => criterion.proofs ?? []));

/**
 * GY-2980: the note a rerun fault puts on the item's history — the reason the rerun could not
 * judge the head, with the run's last 20 lines. The merge trial, which runs the whole suite and
 * names failing cases, judges the head as for any submission. The note is bounded where it is
 * built, so a refusal naming many files can never make the control plane refuse its submission.
 */
export interface RerunNote { note: string; output: string }
const rerunNote = (reason: string, output: string): RerunNote => ({ note: `pre-submit rerun could not judge: ${reason}`.slice(0, 500), output: output.trimEnd().split('\n').slice(-20).join('\n').slice(-20000) });

/**
 * The failing cases a run of `files` names — but only a run that can judge anything (GY-2980): a
 * run the bound killed, or one that failed without naming a case (the runner could not start or
 * find a file), leaves the note the submission records instead.
 */
const judged = (rerun: { ok: boolean; output: string; timedOut?: true }, files: readonly string[], what: string): { cases: RerunCase[]; note?: RerunNote } => {
  if (rerun.timedOut) return { cases: [], note: rerunNote(`${what} exceeded ${boundText(rerunBound.ms)} and was killed`, rerun.output) };
  const cases = rerunFailingCases(rerun.output, files);
  if (!rerun.ok && !cases.length) return { cases: [], note: rerunNote(`${what} failed without naming a failing case`, rerun.output) };
  return { cases };
};

/**
 * What the rerun's failure means for this head, thrown as a refusal or returned as the notes the
 * submission records on the item's history. The one refusal a completed rerun names at once: a
 * failing case of the item's own proofs, the refusal naming what this run failed — never an
 * earlier refusal's text. Failing cases outside the item's proofs retry once, just their files,
 * on the head and then on the base: one that passes on the retry is a flake the history records;
 * one the base fails too is recorded as a base failure; only one that fails the head again and
 * passes on the base refuses.
 * GY-2980: a fault of the rerun itself — the run exceeded its bound, the runner could not start
 * or find a file, the output names no case, the base could not be resolved or run — is no
 * refusal: the submission carries a note (`pre-submit rerun could not judge: <reason>`, with the
 * run's last 20 lines) and the merge trial judges the head as for any submission.
 */
export async function judgeRerun(root: string, work: { key: string; criteria?: { proofs?: readonly string[] }[]; mergeLedger?: { baseTip?: string | null } | null }, failing: readonly string[], rerun: { ok: boolean; output: string; timedOut?: true }, run: ChildRun = defaultChildRun): Promise<{ flaked: RerunCase[]; baseFailures: RerunCase[]; note?: RerunNote }> {
  const first = judged(rerun, failing, `the rerun of ${failing.join(', ')}`);
  if (first.note) return { flaked: [], baseFailures: [], note: first.note };
  const cases = first.cases;
  const proofs = ownProofs(work);
  const own = (found: RerunCase) => { const proof = leadingProof(found.case); return !!proof && proofs.has(proof); };
  const outside = cases.filter(found => !own(found));
  if (outside.length < cases.length)
    throw new Error(`complete refused: the merge trial's failing tests still fail on this head: ${cases.map(locateRerunCase).join(', ')}:\n${rerun.output.trimEnd().slice(-4000)}`);
  // Just the failing cases' files retry; the whole refusal list only when a case's file went unnamed.
  const retryFiles = outside.every(found => found.file) ? [...new Set(outside.map(found => found.file!))] : [...failing];
  const retryRun = await rerunTrialFiles(root, retryFiles, run);
  const retry = judged(retryRun, retryFiles, `the retry of ${retryFiles.join(', ')}`);
  if (retry.note) return { flaked: [], baseFailures: [], note: retry.note };
  const flaked = outside.filter(found => !retry.cases.some(repeated => repeated.case === found.case));
  const still = outside.filter(found => retry.cases.some(repeated => repeated.case === found.case));
  if (!still.length) return { flaked, baseFailures: [] };
  // A case that failed twice on the head is judged against the base: the refused trial's own base
  // tip, else the merge base with the base branch's remote tip.
  const base = typeof work.mergeLedger?.baseTip === 'string' && /^[0-9a-f]{40}$/.test(work.mergeLedger.baseTip) ? work.mergeLedger.baseTip.toLowerCase() : changeBase(root);
  if (!base) return { flaked, baseFailures: [], note: rerunNote('the base to compare the failing cases against could not be resolved here', retryRun.output) };
  const onBase = await rerunBaseFiles(root, base, retryFiles, run);
  if (!onBase) return { flaked, baseFailures: [], note: rerunNote(`the base ${base.slice(0, 12)} could not be run to compare`, retryRun.output) };
  const baseRun = judged(onBase, retryFiles, `the base run of ${retryFiles.join(', ')}`);
  if (baseRun.note) return { flaked, baseFailures: [], note: baseRun.note };
  const headOnly = still.filter(found => !baseRun.cases.some(repeated => repeated.case === found.case));
  if (headOnly.length) throw new Error(`complete refused: ${headOnly.map(locateRerunCase).join(', ')} ${headOnly.length === 1 ? 'fails' : 'fail'} on this head again and ${headOnly.length === 1 ? 'passes' : 'pass'} on the base ${base.slice(0, 12)}:\n${retryRun.output.trimEnd().slice(-4000)}`);
  return { flaked, baseFailures: still };
}

/**
 * `complete GY-N EPOCH [--head [SHA]]` (GY-1523): submit the commit and end the lease; nothing is
 * pushed, since the shared object store already holds it. Beside the control plane's answer it
 * reports the worker's own verification of HEAD (`graphyard verify GY-N`): which
 * mechanical proofs were run and their outcome, which proofs are outstanding, or that none was run.
 * The report never changes what is submitted — the gates decide from trusted evidence alone — but a
 * head whose proof failed here is the head the control plane returns before review.
 */
/** Run the refused trial files inside the caller's private checkout. */
export async function completionRerun(root: string, work: any) {
    const failing = trialFailureTests(work.mergeLedger?.refusal, root);
    let rerun: { flaked: RerunCase[]; baseFailures: RerunCase[]; note?: RerunNote } = { flaked: [], baseFailures: [] };
    if (failing.length) {
      console.error(`complete re-runs the merge trial's failing tests on this head before submitting: ${failing.join(', ')}`);
      const first = await rerunTrialFiles(root, failing);
      // GY-2968: a failing case outside the item's proofs retries once on the head and once on the
      // base before anything is refused — a flake or a base failure is recorded, not a refusal.
      // GY-2980: a fault of the rerun itself is no refusal either — the note travels with the
      // submission and the merge trial judges the head.
      if (!first.ok) rerun = await judgeRerun(root, work, failing, first);
      if (rerun.note) console.error(rerun.note.note);
      if (rerun.flaked.length) console.error(`complete records the flaked ${rerun.flaked.map(locateRerunCase).join(', ')} on ${work.key}'s history`);
      if (rerun.baseFailures.length) console.error(`complete records the base failures ${rerun.baseFailures.map(locateRerunCase).join(', ')} on ${work.key}'s history`);
    }
    return rerun;
}

export const completeCommand: CliCommand = {
  name: 'complete',
  scope: 'work',
  help: [
    '  complete GY-N EPOCH [--head [SHA]]  Submit the commit (the worktree\'s HEAD when no SHA is',
    '                                given) and end the lease; gates decide completion. The shared',
    '                                object store already holds it, so nothing is pushed. Reports',
    '                                what graphyard verify ran on HEAD and its outcome. Refused while',
    '                                GitHub requests are paused, it waits for the named reset and',
    '                                submits again (bounded)',
  ],
  run: async (context, work) => {
    const body = completionBody(context.args, () => worktreeHead(context.repositoryRoot())), requestId = process.env.GRAPHYARD_REQUEST_ID ?? randomUUID();
    // GY-2517: a rework after a failed merge trial re-runs the trial's failing test files here,
    // before anything is submitted, so a head that still fails them no longer costs the
    // serial merge writer another trial slot. Only the item's latest refusal of exactly that shape
    // names files; every other item runs nothing.
    const { requestWorkerVerification } = await import('./worker-verification.js');
    const checked = await requestWorkerVerification(context, work, { mode: 'complete', head: body.head, epoch: body.epoch });
    const rerun = checked.rerun;
    let verification: Awaited<ReturnType<typeof selfVerification>> | { state: 'unavailable'; reason: string };
    try { verification = await selfVerification(context.repositoryRoot(), work.key); } catch (error: any) { verification = { state: 'unavailable', reason: `the worktree could not be read: ${error.message}` }; }
    // GY-2968: what the rerun set aside travels with the submission, for the control plane to
    // record on the item's history beside it.
    const submitted = await submitThroughPause(() => context.api(`work/${work.id}/submit`, {
      ...body,
      ...(rerun.flaked.length ? { flaked: rerun.flaked } : {}),
      ...(rerun.baseFailures.length ? { baseFailures: rerun.baseFailures } : {}),
      ...(rerun.note ? { rerunUnjudged: rerun.note } : {}),
    }, requestId));
    context.print({ ...submitted, selfVerification: verification });
  },
};
