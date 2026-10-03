import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mechanicalProof } from '../model/dispatch.js';
import type { CliCommand } from './registry.js';
import { abnormalTestExit, isolatedTestEnvironment, reserveTestPorts, testPortEnvironment, type ReserveOptions } from './test-isolation.js';

/**
 * `graphyard verify GY-N`: the worker's own mechanical check before `complete` (GY-115).
 *
 * It runs exactly the unit and integration proofs the item's criteria name, against the working
 * tree as it stands, and names every other proof — manual, e2e, or deferred by a bootstrap
 * criterion — as outstanding rather than pretending to settle it. A proof is the set of test cases
 * whose title begins with its name, which is how producers find it too.
 *
 * The record is written to `.graphyard/verify/GY-N.json` in the worktree and bound to HEAD, so
 * `complete` can report what was run on the head it submits. It is the worker's own reading and is
 * never evidence: trusted evidence still comes only from an independent producer, and the control
 * plane requests no review until that evidence has passed on the head.
 */
export interface ProofRun { proof: string; criteria: string[]; result: 'pass' | 'fail'; executed: number; failed: number; skipped: number; files: string[]; abnormal?: string; leftToCi?: boolean; exercise?: BaseExercise; unexercised?: string }
/**
 * GY-1174: the run of a passing proof against the base's sources with this change's tests. The
 * producer later removes the criterion's behaviour and runs the proof again (GY-135); a proof that
 * still passes against the base cannot fail there, so verify finds that misbinding before
 * submission instead of a producer finding it after a full validation cycle.
 */
export interface BaseExercise { base: string; result: 'pass' | 'fail'; executed: number; reverted: string[] }
// leftToCi marks a run the proof's own cases did not decide: every case of the proof passed, and
// the run still failed around them — a hook, a crash or a signal from the other suites its files
// carry (GY-853). The item's own criteria are not judged by it; CI, which runs the whole suite,
// settles it. A failed, skipped or unexecuted case of the proof itself is never left to CI.
/** A failed run its proof's own cases did not decide: they executed, none failed or skipped, and the run still ended abnormally. */
export function leftToCiRun(run: Pick<ProofRun, 'result' | 'executed' | 'failed' | 'skipped' | 'abnormal'>) {
  return run.result === 'fail' && Boolean(run.abnormal) && run.executed > 0 && run.failed === 0 && run.skipped === 0;
}
export interface Outstanding { proof: string; criteria: string[]; reason: string }
export interface VerifyRecord { key: string; head: string; clean: boolean; at: string; ran: ProofRun[]; outstanding: Outstanding[] }
type Criterion = { id: string; proofs: string[]; bootstrap?: unknown };

const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A case belongs to a proof when its title is the proof name, or starts with it followed by a space. */
export const proofTitle = (proof: string) => new RegExp(`^${escape(proof)}(\\s|$)`);
export const recordPath = (root: string, key: string) => join(root, '.graphyard', 'verify', `${key}.json`);

/** Which of the item's proofs a worker can run here, and why each of the rest is outstanding. */
export function classifyProofs(criteria: Criterion[]): { runnable: { proof: string; criteria: string[] }[]; outstanding: Outstanding[] } {
  const runnable = new Map<string, string[]>(), outstanding = new Map<string, Outstanding>();
  const owe = (proof: string, criterion: string, reason: string) => {
    const entry = outstanding.get(proof) ?? { proof, criteria: [], reason };
    entry.criteria.push(criterion); outstanding.set(proof, entry);
  };
  for (const criterion of criteria) for (const proof of criterion.proofs) {
    if (criterion.bootstrap) owe(proof, criterion.id, 'deferred by a bootstrap criterion onto the next change to its contract');
    else if (mechanicalProof(proof)) runnable.set(proof, [...(runnable.get(proof) ?? []), criterion.id]);
    else {
      const family = proof.slice(0, proof.indexOf(':'));
      owe(proof, criterion.id, family === 'manual' ? 'a manual proof is judged by an independent producer, not run here' : `${family}:* proofs are not run against a working tree`);
    }
  }
  // A proof one criterion defers and another requires outright is still run.
  for (const proof of runnable.keys()) outstanding.delete(proof);
  return { runnable: [...runnable].map(([proof, ids]) => ({ proof, criteria: ids })), outstanding: [...outstanding.values()] };
}

/** Every test file in the tree — tracked or new — whose source names the proof. */
async function proofFiles(root: string, proof: string) {
  const files = git(root, ['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(file => /\.test\.(ts|mts|js|mjs|cjs)$/.test(file));
  const named: string[] = [];
  for (const file of files) { try { if ((await readFile(join(root, file), 'utf8')).includes(proof)) named.push(file); } catch { /* deleted in the working tree */ } }
  return named;
}

/**
 * Run one proof's cases in `root` and count what the TAP stream says about them. The proof's test
 * files run whole, and its cases are the ones whose title begins with the proof name: narrowing the
 * run with --test-name-pattern would report every other case of the file as skipped, which a
 * producer then has to explain away. The run gets the suite's isolation (test-isolation.ts): this
 * session's credentials withheld and a window of free ports held for it alone.
 */
export async function runProof(root: string, proof: string, files: string[], ports: ReserveOptions = {}): Promise<Pick<ProofRun, 'result' | 'executed' | 'failed' | 'skipped' | 'files' | 'abnormal'>> {
  if (!files.length) return { result: 'fail', executed: 0, failed: 0, skipped: 0, files };
  const reservation = await reserveTestPorts(ports);
  let run: ReturnType<typeof spawnSync>;
  try {
    run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', ...files],
      { cwd: root, encoding: 'utf8', env: isolatedTestEnvironment(process.env, testPortEnvironment(reservation.base)), maxBuffer: 64 * 1024 * 1024 });
  } finally { reservation.release(); }
  const tap = String(run.stdout ?? ''), { executed, failed, skipped } = countProofCases(tap, proof);
  // The file's other cases are the ordinary suite's business: only the proof's own decide its
  // result. A run that did not end normally — a hook, the file or the process failing — passes none.
  const abnormal = run.error ? `the test process could not run: ${run.error.message}` : abnormalTestExit(tap, run.status, run.signal);
  return { result: !abnormal && executed > 0 && failed === 0 && skipped === 0 ? 'pass' : 'fail', executed, failed, skipped, files, ...(abnormal ? { abnormal } : {}) };
}

/** The proof's cases in a TAP stream, attributed by title prefix. */
export function countProofCases(tap: string, proof: string) {
  const title = proofTitle(proof);
  let executed = 0, failed = 0, skipped = 0;
  for (const line of tap.split('\n')) {
    const match = line.match(/^\s*(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/);
    if (!match || !title.test(match[2])) continue;
    if (match[3]) skipped++; else { executed++; if (match[1] === 'not ok') failed++; }
  }
  return { executed, failed, skipped };
}

/** Test-side files: a test file or anything under tests/. They are what a proof is, not what it proves. */
export const testSide = (file: string) => /^tests\//.test(file) || /\.test\.(ts|mts|js|mjs|cjs)$/.test(file);

/** The commit the change is measured from: the merge base of HEAD with the base branch's remote tip, or null when it cannot be resolved here. */
export function changeBase(root: string, baseBranch = 'main') {
  try { return git(root, ['merge-base', 'HEAD', git(root, ['rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`])]); } catch { return null; }
}

/** The files this working tree changes against `base`: tracked differences and untracked files. */
function changedFiles(root: string, base: string) {
  const diff = git(root, ['diff', '--name-status', '--no-renames', base]).split('\n').filter(Boolean)
    .map(line => ({ status: line[0], path: line.slice(line.indexOf('\t') + 1) }));
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).map(path => ({ status: 'A', path }));
  return [...diff, ...untracked];
}

/**
 * Run a passing proof against the base's sources carrying this change's test-side files. It fails
 * there when it checks something the change adds; it passes when what it checks predates the
 * change (GY-1132), when it bypasses the changed path with hand-built inputs (GY-1131), or when it
 * measures an aggregate that one change cannot move (GY-1142). A change with no non-test file has
 * nothing to revert, and neither it nor a base that cannot be extracted here records one.
 */
export async function baseExercise(root: string, base: string, proof: string, files: string[], ports: ReserveOptions = {}): Promise<BaseExercise | null> {
  const changes = changedFiles(root, base);
  const reverted = changes.filter(change => !testSide(change.path)).map(change => change.path);
  if (!reverted.length) return null;
  const scratch = await mkdtemp(join(tmpdir(), 'graphyard-verify-base-'));
  const tree = join(scratch, 'tree');
  try {
    // An archive of the base, not a git worktree: a sandboxed worker's .git may be read-only.
    await mkdir(tree);
    const extract = spawnSync('sh', ['-c', 'git archive --format=tar "$1" | tar -x -C "$2"', 'sh', base, tree], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    if (extract.status !== 0) return null;
    for (const change of changes.filter(change => testSide(change.path))) {
      if (change.status === 'D') { await rm(join(tree, change.path), { force: true }); continue; }
      await mkdir(dirname(join(tree, change.path)), { recursive: true });
      await copyFile(join(root, change.path), join(tree, change.path));
    }
    try { await symlink(await realpath(join(root, 'node_modules')), join(tree, 'node_modules')); } catch { /* no dependencies installed */ }
    const run = await runProof(tree, proof, files, ports);
    return { base, result: run.result, executed: run.executed, reverted };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function verifyWorkingTree(work: { key: string; criteria: Criterion[] }, root: string, now = () => new Date(), options: { baseBranch?: string } = {}): Promise<VerifyRecord> {
  const { runnable, outstanding } = classifyProofs(work.criteria);
  const head = git(root, ['rev-parse', 'HEAD']);
  const clean = git(root, ['status', '--porcelain']) === '';
  const base = changeBase(root, options.baseBranch);
  const ran: ProofRun[] = [];
  for (const entry of runnable) {
    const files = await proofFiles(root, entry.proof);
    const result = await runProof(root, entry.proof, files);
    // The proof's own cases decide its criterion (GY-853): a failed, skipped or unexecuted case is
    // the item's own test failing and blocks, wherever its file sits. When every case of the proof
    // passed but the run still did not complete normally, the failure lies in the rest of the run —
    // the other suites the files carry, which a sandbox may not be able to run — and is left to CI.
    const run: ProofRun = { proof: entry.proof, criteria: entry.criteria, ...result, ...(leftToCiRun(result) ? { leftToCi: true } : {}) };
    // A passing proof must also fail without the change (GY-1174), as its producer will demand.
    const exercise = result.result === 'pass' && base ? await baseExercise(root, base, entry.proof, files) : null;
    if (exercise) run.exercise = exercise;
    if (exercise?.result === 'pass') run.unexercised = `${entry.proof} does not exercise ${entry.criteria.join(', ')}: it also passed against the base ${base!.slice(0, 12)} with this change's tests and ${exercise.reverted.length} changed file(s) reverted (${exercise.reverted.slice(0, 5).join(', ')}${exercise.reverted.length > 5 ? ', …' : ''}), so it checks nothing the change adds; a producer would record it as not exercising its criterion. Bind a proof whose cases fail without the change`;
    ran.push(run);
  }
  const record: VerifyRecord = { key: work.key, head, clean, at: now().toISOString(), ran, outstanding };
  await mkdir(join(root, '.graphyard', 'verify'), { recursive: true });
  await writeFile(recordPath(root, work.key), JSON.stringify(record, null, 2));
  return record;
}

/** What `complete` reports: the worker's own verification of the head it submits, or why there is none. */
export async function selfVerification(root: string, key: string) {
  let record: VerifyRecord;
  try { record = JSON.parse(await readFile(recordPath(root, key), 'utf8')); } catch {
    return { state: 'not-run' as const, reason: `graphyard verify ${key} was not run in this worktree; no proof was checked before submission`, ran: [], outstanding: [] };
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  const summary = { ran: record.ran.map(({ proof, criteria, result, executed, failed, skipped, abnormal, leftToCi, unexercised }) => ({ proof, criteria, result, executed, failed, skipped, ...(abnormal ? { abnormal } : {}), ...(leftToCi ? { leftToCi } : {}), ...(unexercised ? { unexercised } : {}) })),
    outstanding: record.outstanding.map(({ proof, criteria, reason }) => ({ proof, criteria, reason })), verifiedAt: record.at };
  if (record.head !== head) return { state: 'stale' as const, reason: `verified ${record.head.slice(0, 12)}, not HEAD ${head.slice(0, 12)}; run graphyard verify ${key} again`, ...summary };
  const failing = record.ran.filter(entry => entry.result !== 'pass' && !leftToCiRun(entry));
  const unexercised = record.ran.filter(entry => entry.unexercised);
  const deferred = record.ran.filter(entry => entry.result !== 'pass' && leftToCiRun(entry));
  const clean = record.clean ? '' : ' (with uncommitted changes present when it ran)';
  return { state: failing.length || unexercised.length ? 'failing' as const : 'passing' as const,
    reason: failing.length ? `${failing.map(entry => entry.proof).join(', ')} did not pass on HEAD; the control plane returns this head to its worker before review`
      : unexercised.length ? `${unexercised.map(entry => entry.proof).join(', ')} passed on HEAD and against the base without the change; a producer records such a proof as not exercising its criterion and the head returns to its worker`
      : deferred.length ? `the item's own criteria passed on HEAD${clean}; ${deferred.map(entry => entry.proof).join(', ')} did not complete in this sandbox with every case of the proof passing, so its failure is left to CI`
      : `every mechanical proof passed on HEAD${clean}`, ...summary };
}

export const verifyCommand: CliCommand = {
  name: 'verify',
  scope: 'work',
  help: [
    '  verify GY-N                  Run exactly the unit and integration proofs the item\'s',
    '                                criteria name against this working tree, name the rest as',
    '                                outstanding, and record the result complete reports.',
    '                                A passing proof is run again against the base\'s sources',
    '                                with this change\'s tests; one that still passes there is',
    '                                reported unexercised and fails verify',
  ],
  run: async (context, work) => {
    let baseBranch = 'main';
    try { baseBranch = String((await context.api('status')).baseBranch ?? 'main'); } catch { /* the default base branch */ }
    const record = await verifyWorkingTree(work, context.repositoryRoot(), undefined, { baseBranch });
    context.print(record);
    if (record.ran.some(entry => (entry.result !== 'pass' && !leftToCiRun(entry)) || entry.unexercised)) process.exitCode = 1;
  },
};
