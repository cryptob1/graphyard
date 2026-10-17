import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from './temp-dirs.js';
import { abnormalTestExit, isolatedTestEnvironment, reserveTestPorts, testPortEnvironment } from '../../src/cli/test-isolation.js';
import { countProofCases } from '../../src/cli/verify.js';

// GY-1907: a delivered criterion that demanded twenty consecutive passes of one test (GY-1886's
// unit:slow-tick-names-cause) kept only a claim and one CI pass. This module is the receipt those
// passes leave behind: it executes the proof against the exact pinned source, records every run's
// outcome, and judges a receipt by what it binds — the source, the sequence, the artifact — never
// by what it claims. The retained receipt below was executed by this module against
// 6d2aabbb31952557c2772935b2f18ba52fb38322 (GY-1886's reviewed head, whose tree is pinned beside
// it); integration:slow-tick-exact-head-twenty-consecutive independently re-executes the same
// twenty passes and refuses a receipt that binds another head, holds fewer runs, loses its order
// or records a failure. The retained receipt, its run logs and the failed first attempt are
// committed under tests/fixtures/gy-1907-slow-tick-receipt, so every checkout can resolve them.

/** The proof the receipt is about, and the source it must have run against. */
export const slowTickProof = 'unit:slow-tick-names-cause';
export const pinnedSourceSha = '6d2aabbb31952557c2772935b2f18ba52fb38322';
/** The tree of the pinned commit: the source identity a receipt must bind, not just its name. */
export const pinnedSourceTree = '18677ba6b73eb275c9dc6118697536b0c1945144';
export const pinnedProofFile = 'tests/reconcile-tick-cause.test.ts';
/** GY-1886's AC-1 bound: twenty consecutive executed passes, or the receipt is not one. */
export const requiredPasses = 20;

export interface SlowTickReceiptRun {
  /** The run's position in the sequence, from 1: the order it executed in. */
  run: number;
  startedAt: string;
  endedAt: string;
  /** The test process's exit status, null when it was killed or could not run. */
  exitCode: number | null;
  durationMs: number;
  executed: number;
  failed: number;
  skipped: number;
  passed: boolean;
  /** sha256 of the run's TAP output, which the artifact reference retains in full. */
  logDigest: string;
}

export interface SlowTickReceipt {
  schema: 1;
  proof: string;
  /** The exact commit the runs executed, and its tree: the receipt's source binding. */
  pinnedSource: string;
  pinnedTree: string;
  /** The command of one run, relative to the extracted pinned source. */
  command: string[];
  recordedAt: string;
  environment: { node: string; platform: string; arch: string; cpus: number; ci: boolean };
  runs: SlowTickReceiptRun[];
  passed: number;
  /** The leading runs that passed before the first failure: a failure breaks the sequence here. */
  consecutivePasses: number;
  /** Where the runs' full TAP output and this receipt are retained: a directory relative to the repository root. */
  artifact: string;
}

/** A run's retained TAP output, named by its position in the sequence. */
export const runLogName = (run: number) => `run-${String(run).padStart(2, '0')}.tap`;

/** A reference only this host can resolve is no durable reference: it must be repository-relative and stay inside the repository. */
function artifactReferenceFault(artifact: unknown): string | null {
  if (typeof artifact !== 'string' || !artifact.trim()) return 'the receipt names no durable artifact reference for its run logs';
  if (isAbsolute(artifact) || /^[A-Za-z]:[\\/]/.test(artifact)) return `the receipt's artifact ${JSON.stringify(artifact)} is an absolute host path, not a durable repository-relative reference`;
  if (normalize(artifact).split(/[\\/]/)[0] === '..') return `the receipt's artifact ${JSON.stringify(artifact)} leaves the repository`;
  return null;
}

/**
 * Assemble a receipt from executed runs. The runs are recorded as they ran, failures included:
 * a receipt that records a failure is a valid record of a broken sequence, and
 * verifySlowTickReceipt refuses it as a twenty-pass claim.
 */
export function buildSlowTickReceipt(input: { runs: SlowTickReceiptRun[]; artifact: string; at?: Date; environment?: SlowTickReceipt['environment'] }): SlowTickReceipt {
  let consecutivePasses = 0;
  for (const run of input.runs) { if (!run.passed) break; consecutivePasses++; }
  return {
    schema: 1, proof: slowTickProof, pinnedSource: pinnedSourceSha, pinnedTree: pinnedSourceTree,
    command: ['node', '--import', 'tsx', '--test', '--test-reporter=tap', pinnedProofFile],
    recordedAt: (input.at ?? new Date()).toISOString(),
    environment: input.environment ?? { node: process.version, platform: process.platform, arch: process.arch, cpus: cpus().length, ci: !!process.env.CI },
    runs: input.runs, passed: input.runs.filter(run => run.passed).length, consecutivePasses,
    artifact: input.artifact,
  };
}

/**
 * Judge a receipt by what it binds. Every fault names the requirement it breaks: the source
 * binding (the exact pinned commit and its tree), the sequence (the required runs, numbered in
 * execution order, none missing), each run's execution (a non-zero exit, a failed, skipped or
 * unexecuted case, or a lost log digest refuses the receipt), the command that ran the proof
 * file, the runner it ran under, and the artifact the run logs are retained at.
 */
export function verifySlowTickReceipt(receipt: SlowTickReceipt, options: { sha?: string; tree?: string; passes?: number } = {}): { ok: boolean; faults: string[] } {
  const sha = options.sha ?? pinnedSourceSha, tree = options.tree ?? pinnedSourceTree, passes = options.passes ?? requiredPasses;
  const faults: string[] = [];
  const fault = (line: string) => faults.push(line);
  if (receipt.schema !== 1) fault(`the receipt's schema is ${JSON.stringify(receipt.schema)}, not 1`);
  if (receipt.proof !== slowTickProof) fault(`the receipt names ${JSON.stringify(receipt.proof)}, not ${slowTickProof}`);
  if (receipt.pinnedSource !== sha) fault(`the receipt binds source ${JSON.stringify(receipt.pinnedSource)}, not the exact ${sha}`);
  if (receipt.pinnedTree !== tree) fault(`the receipt's tree ${JSON.stringify(receipt.pinnedTree)} is not the pinned source's ${tree}`);
  if (!Array.isArray(receipt.command) || receipt.command.length < 2 || !receipt.command.includes(pinnedProofFile)) fault(`the receipt's command ${JSON.stringify(receipt.command)} does not run ${pinnedProofFile}`);
  for (const field of ['node', 'platform', 'arch'] as const) if (typeof receipt.environment?.[field] !== 'string' || !receipt.environment[field]) fault(`the receipt's runner environment names no ${field}`);
  if (!(receipt.environment?.cpus > 0)) fault(`the receipt's runner environment names no processors: ${JSON.stringify(receipt.environment?.cpus)}`);
  const reference = artifactReferenceFault(receipt.artifact);
  if (reference) fault(reference);
  const runs = receipt.runs;
  if (!Array.isArray(runs) || runs.length !== passes) fault(`the receipt holds ${runs?.length ?? 0} run(s), not the required ${passes} in sequence`);
  else {
    let previousEndedAt: string | null = null;
    runs.forEach((run, index) => {
      if (run.run !== index + 1) fault(`run ${index + 1} is numbered ${JSON.stringify(run.run)}: the runs must be ${passes}, numbered 1..${passes} in execution order`);
      if (run.exitCode !== 0) fault(`run ${run.run} exited ${JSON.stringify(run.exitCode)}, not 0`);
      if (run.executed < 1) fault(`run ${run.run} executed no case of the proof`);
      if (run.failed !== 0) fault(`run ${run.run} records ${run.failed} failed case(s): a failure breaks the sequence`);
      if (run.skipped !== 0) fault(`run ${run.run} skipped ${run.skipped} case(s)`);
      if (run.passed !== true) fault(`run ${run.run} is not a passed run`);
      if (!(run.durationMs >= 0)) fault(`run ${run.run} records no duration`);
      if (!/^[0-9a-f]{64}$/.test(run.logDigest ?? '')) fault(`run ${run.run} carries no sha256 log digest`);
      const startedAt = Date.parse(run.startedAt ?? ''), endedAt = Date.parse(run.endedAt ?? '');
      if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) fault(`run ${run.run} records no ordered start and end`);
      else if (previousEndedAt !== null && startedAt < Date.parse(previousEndedAt)) fault(`run ${run.run} started before run ${run.run - 1} ended: the sequence is not ordered`);
      previousEndedAt = run.endedAt ?? null;
    });
    if (receipt.passed !== runs.length) fault(`the receipt records ${receipt.passed} passed run(s) of ${runs.length}`);
    if (receipt.consecutivePasses !== passes) fault(`the receipt's consecutive passes are ${receipt.consecutivePasses}, not ${passes}: a failure breaks the sequence`);
  }
  return { ok: faults.length === 0, faults };
}

const git = (root: string, args: string[], timeout?: number) =>
  spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(timeout ? { timeout } : {}) });

/** The install the working tree resolves its dependencies from: the nearest node_modules above it (a worktree without its own uses the coordinator checkout's). */
async function nearestNodeModules(from: string): Promise<string> {
  for (let directory = from; ; directory = join(directory, '..')) {
    try { return await realpath(join(directory, 'node_modules')); } catch { if (directory === join(directory, '..')) break; }
  }
  throw new Error(`no node_modules resolves above ${from}; install the dependencies first`);
}

/**
 * Execute the pinned proof `runs` times, consecutively, against the exact pinned source, and
 * build its receipt. The source is extracted from git (an archive, so no worktree is written
 * beside it), guarded to be the pinned commit and to hold the proof, and given the current
 * install's node_modules and the suite's isolated environment and port window. Every run's TAP
 * output is retained in the artifact directory beside the receipt, with its sha256 digest in the
 * receipt. A shallow checkout that lacks the pinned commit fetches it once, bounded. An execution
 * that names no artifact directory of its own retains its runs beside the retained receipt's, under
 * its own `runs-<pid>`, so a later execution never overwrites an earlier receipt's logs.
 */
export async function executeSlowTickReceiptRuns(options: { runs?: number; root?: string; artifactDirectory?: string; onRun?: (run: SlowTickReceiptRun) => void } = {}): Promise<{ receipt: SlowTickReceipt; release: (drop?: { logs?: boolean }) => Promise<void> }> {
  const runs = options.runs ?? requiredPasses;
  const root = options.root ?? process.cwd();
  // The scratch lives beside the artifact, under the worktree's own .graphyard state, not the host's
  // tmpdir: a host reclaim pass reads an owner marker's pid outside this session's PID namespace and
  // reads a live run as gone (the failure this module's first execution died of), while nothing
  // scans the worktree — the same reason verify's base tree lives under .graphyard/verify (GY-1240).
  const stateRoot = options.artifactDirectory ? options.artifactDirectory : join(root, '.graphyard', 'receipts', `slow-tick-repeat-${pinnedSourceSha.slice(0, 12)}`, `runs-${process.pid}`);
  await mkdir(stateRoot, { recursive: true });
  const scratchParent = join(stateRoot, 'scratch');
  await mkdir(scratchParent, { recursive: true });
  const scratch = await temporaryDirectory('execution', scratchParent);
  const childTmp = await temporaryDirectory('child-tmp', scratchParent);
  // An execution that is not retained (the integration proof) also drops its run logs; the
  // command-line execution keeps them for committing beside the retained receipt.
  const release = (drop: { logs?: boolean } = {}) => rm(drop.logs && !options.artifactDirectory ? stateRoot : scratchParent, { recursive: true, force: true });
  try {
    if (git(root, ['cat-file', '-e', `${pinnedSourceSha}^{commit}`]).status !== 0) {
      const fetched = git(root, ['fetch', '--no-tags', '--depth=1', 'origin', pinnedSourceSha], 120_000);
      if (fetched.status !== 0 || git(root, ['cat-file', '-e', `${pinnedSourceSha}^{commit}`]).status !== 0)
        throw new Error(`the pinned source ${pinnedSourceSha} is neither present nor fetchable: ${String(fetched.stderr).trim() || `exit ${fetched.status}`}`);
    }
    const tree = join(scratch, 'tree');
    await mkdir(tree);
    const extract = spawnSync('sh', ['-c', 'git archive --format=tar "$1" | tar -x -C "$2"', 'sh', pinnedSourceSha, tree], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    if (extract.status !== 0 || extract.error) throw new Error(`the pinned source ${pinnedSourceSha} could not be extracted: ${(extract.error?.message ?? String(extract.stderr ?? '').trim()) || `exit ${extract.status}`}`);
    const archived = git(root, ['rev-parse', `${pinnedSourceSha}^{tree}`]);
    if (archived.stdout.trim() !== pinnedSourceTree) throw new Error(`the pinned source's tree is ${archived.stdout.trim() || `unresolvable (${archived.status})`}, not the recorded ${pinnedSourceTree}`);
    // Source binding, checked where it would break: the tree holds the proof, and only the proof file this receipt is about.
    const proofSource = await readFile(join(tree, pinnedProofFile), 'utf8');
    if (!proofSource.includes(slowTickProof)) throw new Error(`the pinned source's ${pinnedProofFile} does not hold ${slowTickProof}`);
    try { await symlink(await nearestNodeModules(root), join(tree, 'node_modules')); } catch (error: any) { throw new Error(`the pinned source could not use this install's node_modules: ${error.message}`); }
    const artifactDirectory = stateRoot;
    const reservation = await reserveTestPorts();
    const records: SlowTickReceiptRun[] = [];
    try {
      for (let index = 1; index <= runs; index++) {
        const startedMs = Date.now();
        const run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', pinnedProofFile],
          { cwd: tree, encoding: 'utf8', env: isolatedTestEnvironment({ ...process.env, TMPDIR: childTmp }, testPortEnvironment(reservation.base)), maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
        const endedMs = Date.now();
        const tap = String(run.stdout ?? '');
        await writeFile(join(artifactDirectory, runLogName(index)), tap);
        const counted = countProofCases(tap, slowTickProof);
        const abnormal = run.error ? `the test process could not run: ${run.error.message}` : abnormalTestExit(tap, run.status, run.signal);
        const record: SlowTickReceiptRun = {
          run: index,
          startedAt: new Date(startedMs).toISOString(),
          endedAt: new Date(endedMs).toISOString(),
          exitCode: run.status,
          durationMs: endedMs - startedMs,
          executed: counted.executed, failed: counted.failed, skipped: counted.skipped,
          passed: !abnormal && counted.executed > 0 && counted.failed === 0 && counted.skipped === 0,
          logDigest: createHash('sha256').update(tap).digest('hex'),
        };
        records.push(record);
        options.onRun?.(record);
      }
    } finally { reservation.release(); }
    const receipt = buildSlowTickReceipt({ runs: records, artifact: relative(root, artifactDirectory), at: new Date(records.at(-1)!.endedAt) });
    await writeFile(join(artifactDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return { receipt, release };
  } catch (error) { await release(); throw error; }
}

/** Where the retained receipts live, relative to the repository root: committed, so every checkout and CI runner resolves them. */
export const retainedReceiptDirectory = 'tests/fixtures/gy-1907-slow-tick-receipt';
const readRetained = (directory: string): SlowTickReceipt =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../${directory}/receipt.json`, import.meta.url)), 'utf8'));

/**
 * The retained receipt: executed by this module against the pinned source, its runs' full TAP
 * output committed beside it at its artifact reference, verified before it was kept. GY-1886's
 * record stays immutable; this receipt is the execution its AC-1 asked for.
 */
export const retainedSlowTickReceipt: SlowTickReceipt = readRetained(retainedReceiptDirectory);

/**
 * The executions that broke the sequence, retained because a failure must be: the first execution
 * died of a host reclaim pass deleting its tmpdir scratch (run 1 failed, runs 2-20 never ran),
 * which is why executions now keep their scratch under the worktree's .graphyard state.
 */
export const retainedFailedSlowTickAttempts: SlowTickReceipt[] = [readRetained(`${retainedReceiptDirectory}/failed-attempt-1`)];

/**
 * The independently produced execution that verified the retained receipt: a GitHub-hosted CI
 * runner (not the worker's host) ran integration:slow-tick-exact-head-twenty-consecutive on PR
 * #1297's head 4ef958c53c80, which carries this receipt unchanged. Its output lines are kept
 * verbatim from the job log, so the record names the pinned source, the receipt (by digest) and
 * the execution's own twenty runs without relying on the log's retention (their timestamp prefix, 12:55:09Z, dropped).
 */
export const independentSlowTickExecution = {
  job: 'https://github.com/cryptob1/graphyard/actions/runs/39033870261/job/117399733697',
  runAttempt: 1,
  head: '4ef958c53c80a42d94b777ef3dfd4540efe11bb5',
  runner: 'GitHub Actions 1000112460',
  output: [
    '✔ integration:slow-tick-exact-head-twenty-consecutive — an independent execution re-runs the pinned source twenty consecutive times and its receipt verifies beside the retained one (113445.867319ms)',
    'ℹ verified tests/fixtures/gy-1907-slow-tick-receipt/receipt.json sha256 58bf0d5f04588da5b59a2d699ff8d00cc2540bba70dc5d6aef1e4e0d4bf43548 for unit:slow-tick-names-cause at 6d2aabbb31952557c2772935b2f18ba52fb38322 (tree 18677ba6b73eb275c9dc6118697536b0c1945144)',
    'ℹ independent execution: 20 consecutive passes on node v24.21.0 linux/x64, 4 cpus, ci true; exit statuses 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0; log sha256 4df331ee06bb,805ca9c4a62d,e4edac328f40,72e3a4952c7d,da0a484b2b10,375636e78fcc,abe406709923,6a4996d4dfb5,5f3634f7c833,de93683f0341,189acfd588d6,3e48b3614967,0b969e57c26b,87c67dcb5c26,a37305e06167,bfde5e11fdfd,4094873db7e8,f5d2ec333a2e,e3a84221388a,3da57af18b3f',
  ],
} as const;

/** What an independent execution's retained output shows, or the faults that keep it from verifying `receiptDigest` at the pinned source. */
export function verifyIndependentExecution(execution: { job: string; output: readonly string[] }, receiptDigest: string): { ok: boolean; faults: string[] } {
  const faults: string[] = [];
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+$/.test(execution.job)) faults.push(`${execution.job} is not a hosted CI job reference`);
  const proof = 'integration:slow-tick-exact-head-twenty-consecutive';
  if (!execution.output.some(line => line.includes(`✔ ${proof} `))) faults.push(`the output does not show ${proof} passing`);
  const verified = execution.output.find(line => line.includes('ℹ verified '));
  if (!verified?.includes(`${retainedReceiptDirectory}/receipt.json sha256 ${receiptDigest} for ${slowTickProof} at ${pinnedSourceSha} (tree ${pinnedSourceTree})`))
    faults.push(`the output does not verify ${retainedReceiptDirectory}/receipt.json sha256 ${receiptDigest} at ${pinnedSourceSha}`);
  const ran = execution.output.find(line => line.includes('ℹ independent execution: '))?.match(/(\d+) consecutive passes on .*, ci (true|false); exit statuses ([\d,]+); log sha256 ([0-9a-f,]+)$/);
  if (!ran) faults.push('the output does not name the execution\'s runs');
  else {
    const statuses = ran[3].split(','), logs = new Set(ran[4].split(','));
    if (ran[2] !== 'true') faults.push('the execution did not run on a CI runner');
    if (Number(ran[1]) !== requiredPasses || statuses.length !== requiredPasses || logs.size !== requiredPasses) faults.push(`the execution names ${ran[1]} passes, ${statuses.length} exit statuses and ${logs.size} distinct logs, not ${requiredPasses}`);
    const failed = statuses.flatMap((status, index) => status === '0' ? [] : [`run ${index + 1} exited ${status}`]);
    if (failed.length) faults.push(`a failure breaks the sequence: ${failed.join(', ')}`);
  }
  return { ok: faults.length === 0, faults };
}

/**
 * Resolve a receipt's artifact reference against the repository root and check that it retains
 * what the receipt claims: each run's TAP output, whose sha256 must match its logDigest, and the
 * receipt itself. `tracked` also requires every file to be committed, so the reference outlives
 * the checkout that executed it.
 */
export function verifyRetainedArtifact(receipt: SlowTickReceipt, options: { root?: string; tracked?: boolean } = {}): { ok: boolean; faults: string[] } {
  const root = options.root ?? fileURLToPath(new URL('../..', import.meta.url));
  const faults: string[] = [];
  const reference = artifactReferenceFault(receipt.artifact);
  if (reference) return { ok: false, faults: [reference] };
  const directory = join(root, receipt.artifact);
  const files = [...receipt.runs.map(run => runLogName(run.run)), 'receipt.json'];
  for (const run of receipt.runs) {
    let log: Buffer;
    try { log = readFileSync(join(directory, runLogName(run.run))); } catch { faults.push(`run ${run.run}'s log is not retained at ${receipt.artifact}/${runLogName(run.run)}`); continue; }
    const digest = createHash('sha256').update(log).digest('hex');
    if (digest !== run.logDigest) faults.push(`run ${run.run}'s retained log digests to ${digest}, not the receipt's ${run.logDigest}`);
  }
  try {
    if (!isDeepStrictEqual(JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8')), receipt)) faults.push(`the receipt retained at ${receipt.artifact}/receipt.json is not this receipt`);
  } catch { faults.push(`no receipt is retained at ${receipt.artifact}/receipt.json`); }
  if (options.tracked) {
    const listed = new Set(git(root, ['ls-files', '--', receipt.artifact]).stdout.split('\n').filter(Boolean));
    for (const file of files) if (!listed.has(`${receipt.artifact}/${file}`)) faults.push(`${receipt.artifact}/${file} is not committed: the reference does not outlive this checkout`);
  }
  return { ok: faults.length === 0, faults };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // The default test runner that temp-dirs' hook starts prints its own summary on stdout, so this
  // command keeps stdout clear: the receipt is read from the artifact directory it names.
  const execution = await executeSlowTickReceiptRuns({ onRun: run => console.error(`run ${run.run}: exit ${run.exitCode}, ${run.executed} executed, ${run.failed} failed, ${run.durationMs} ms${run.passed ? '' : ' FAILED'}`) });
  try {
    const verdict = verifySlowTickReceipt(execution.receipt);
    console.error(`receipt: ${join(execution.receipt.artifact, 'receipt.json')} (copy the directory under ${retainedReceiptDirectory} to retain it)`);
    if (!verdict.ok) { console.error(`the executed receipt does not verify:\n${verdict.faults.map(fault => `  - ${fault}`).join('\n')}`); process.exitCode = 1; }
    else console.error(`the executed receipt verifies: ${execution.receipt.passed} consecutive passed runs of ${pinnedSourceSha}`);
  } finally { await execution.release(); }
}
