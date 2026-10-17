import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
// or records a failure. The retained receipt's stamps are the executed runs' own records, ordered among themselves and never against a clock; Date.now() and new Date() stamp each run and the receipt as the execution runs.

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
  /** Where the runs' full TAP output and this receipt are retained. */
  artifact: string;
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
  if (typeof receipt.artifact !== 'string' || !receipt.artifact.trim()) fault('the receipt names no durable artifact reference for its run logs');
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
export async function executeSlowTickReceiptRuns(options: { runs?: number; root?: string; artifactDirectory?: string; onRun?: (run: SlowTickReceiptRun) => void } = {}): Promise<{ receipt: SlowTickReceipt; release: () => Promise<void> }> {
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
  const release = () => rm(scratchParent, { recursive: true, force: true });
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
        await writeFile(join(artifactDirectory, `run-${String(index).padStart(2, '0')}.log`), tap);
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
    const receipt = buildSlowTickReceipt({ runs: records, artifact: artifactDirectory, at: new Date(records.at(-1)!.endedAt) });
    await writeFile(join(artifactDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return { receipt, release };
  } catch (error) { await release(); throw error; }
}

/**
 * The retained receipt: executed by this module against the pinned source, its runs' full TAP
 * output retained at the artifact reference, verified before it was kept. GY-1886's record stays
 * immutable; this receipt is the execution its AC-1 asked for, kept beside the code that judges it.
 */
export const retainedSlowTickReceipt: SlowTickReceipt = {
    "schema": 1,
    "proof": "unit:slow-tick-names-cause",
    "pinnedSource": "6d2aabbb31952557c2772935b2f18ba52fb38322",
    "pinnedTree": "18677ba6b73eb275c9dc6118697536b0c1945144",
    "command": [
      "node",
      "--import",
      "tsx",
      "--test",
      "--test-reporter=tap",
      "tests/reconcile-tick-cause.test.ts"
    ],
    "recordedAt": "2026-10-17T11:59:31.860Z",
    "environment": {
      "node": "v24.5.0",
      "platform": "linux",
      "arch": "x64",
      "cpus": 24,
      "ci": false
    },
    "runs": [
      {
        "run": 1,
        "startedAt": "2026-10-17T11:57:36.914Z",
        "endedAt": "2026-10-17T11:57:43.227Z",
        "exitCode": 0,
        "durationMs": 6313,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "6d7a9f8d086cad9e89c5faec95e6503b5076df415d6f14ba69a3bbf038adf125"
      },
      {
        "run": 2,
        "startedAt": "2026-10-17T11:57:43.230Z",
        "endedAt": "2026-10-17T11:57:48.340Z",
        "exitCode": 0,
        "durationMs": 5110,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "8f9e34e90da1a6cc42121b639f8d4e99efe522c1be4e8081d51113590ec6aded"
      },
      {
        "run": 3,
        "startedAt": "2026-10-17T11:57:48.341Z",
        "endedAt": "2026-10-17T11:57:54.311Z",
        "exitCode": 0,
        "durationMs": 5970,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "1a4506c2de1440cf89fcc98ab5b51fbf6a3da88651558097321c2d1496a41a54"
      },
      {
        "run": 4,
        "startedAt": "2026-10-17T11:57:54.312Z",
        "endedAt": "2026-10-17T11:57:59.131Z",
        "exitCode": 0,
        "durationMs": 4819,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "ab6da5b162caeb0bddc4b601ae1a63d8486bd8cb24a93392b7ce9f459a920d20"
      },
      {
        "run": 5,
        "startedAt": "2026-10-17T11:57:59.132Z",
        "endedAt": "2026-10-17T11:58:05.047Z",
        "exitCode": 0,
        "durationMs": 5915,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "bc4c1ebe24fa5f260fa3af0cc77eed8b4b7e04277e600670975aea4d4ebd16e2"
      },
      {
        "run": 6,
        "startedAt": "2026-10-17T11:58:05.048Z",
        "endedAt": "2026-10-17T11:58:10.494Z",
        "exitCode": 0,
        "durationMs": 5446,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "5825f5295eda019a8c2db7f671e3969ed4f424c856ae62677920be176dba4873"
      },
      {
        "run": 7,
        "startedAt": "2026-10-17T11:58:10.495Z",
        "endedAt": "2026-10-17T11:58:16.434Z",
        "exitCode": 0,
        "durationMs": 5939,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "dfece16522427183a143293ecba4b0af0fb7810334c24f08142f0ec4595c9974"
      },
      {
        "run": 8,
        "startedAt": "2026-10-17T11:58:16.434Z",
        "endedAt": "2026-10-17T11:58:22.170Z",
        "exitCode": 0,
        "durationMs": 5736,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "803d212e69b856a5c6bdfdbd5e6f86fd3e7d5812983b9238be9685491dabf637"
      },
      {
        "run": 9,
        "startedAt": "2026-10-17T11:58:22.172Z",
        "endedAt": "2026-10-17T11:58:27.923Z",
        "exitCode": 0,
        "durationMs": 5751,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "4dbf07008c9b10b5011321c8ea8260f39cbf1220953e3e65b8de071fb14aa85e"
      },
      {
        "run": 10,
        "startedAt": "2026-10-17T11:58:27.924Z",
        "endedAt": "2026-10-17T11:58:33.591Z",
        "exitCode": 0,
        "durationMs": 5667,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "37f30b3493de39f8232f7d3f16b8005c857f53dde38a658bd9e82bd2f3a82f40"
      },
      {
        "run": 11,
        "startedAt": "2026-10-17T11:58:33.593Z",
        "endedAt": "2026-10-17T11:58:39.162Z",
        "exitCode": 0,
        "durationMs": 5569,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "8c80ea7933a29963780ebd62d62d7877521c55a3a0dffa6ea87cd325ced6e3cb"
      },
      {
        "run": 12,
        "startedAt": "2026-10-17T11:58:39.162Z",
        "endedAt": "2026-10-17T11:58:47.535Z",
        "exitCode": 0,
        "durationMs": 8373,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "d030d5e2483f4f72228c1a60736daf3874f02e94f5272760c59e4244b8c0f295"
      },
      {
        "run": 13,
        "startedAt": "2026-10-17T11:58:47.535Z",
        "endedAt": "2026-10-17T11:58:53.457Z",
        "exitCode": 0,
        "durationMs": 5922,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "25fc1c51983569842ea0faf042a9ff6f696b81d01a65464d7210daf28e0231f2"
      },
      {
        "run": 14,
        "startedAt": "2026-10-17T11:58:53.458Z",
        "endedAt": "2026-10-17T11:58:59.194Z",
        "exitCode": 0,
        "durationMs": 5736,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "08ded707846971d7441992ab668520683c5612825a4ef4992e7c274cb9fff5ea"
      },
      {
        "run": 15,
        "startedAt": "2026-10-17T11:58:59.195Z",
        "endedAt": "2026-10-17T11:59:04.738Z",
        "exitCode": 0,
        "durationMs": 5543,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "4f1bc3b3206270acbd21eae6f92c3b63b8f74f63ecb00f5cb561d693b798fb57"
      },
      {
        "run": 16,
        "startedAt": "2026-10-17T11:59:04.738Z",
        "endedAt": "2026-10-17T11:59:10.234Z",
        "exitCode": 0,
        "durationMs": 5496,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "1addd05485826723fae6a3a0999858055119d6c906b61c7a9cb2ed6858d91307"
      },
      {
        "run": 17,
        "startedAt": "2026-10-17T11:59:10.234Z",
        "endedAt": "2026-10-17T11:59:15.744Z",
        "exitCode": 0,
        "durationMs": 5510,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "14ce04d437f6581a6fcfad6703138107178d9a2fd15e65229a256158db5da30e"
      },
      {
        "run": 18,
        "startedAt": "2026-10-17T11:59:15.745Z",
        "endedAt": "2026-10-17T11:59:21.246Z",
        "exitCode": 0,
        "durationMs": 5501,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "9af346320e90cdf2fe7bb07243f4d17c10fdcf177a022112525f7c21be2b1113"
      },
      {
        "run": 19,
        "startedAt": "2026-10-17T11:59:21.246Z",
        "endedAt": "2026-10-17T11:59:26.592Z",
        "exitCode": 0,
        "durationMs": 5346,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "8b56b5495878720225f295fb93fd77a7f8aeab38b874d31753888bf6b277f3c3"
      },
      {
        "run": 20,
        "startedAt": "2026-10-17T11:59:26.596Z",
        "endedAt": "2026-10-17T11:59:31.860Z",
        "exitCode": 0,
        "durationMs": 5264,
        "executed": 1,
        "failed": 0,
        "skipped": 0,
        "passed": true,
        "logDigest": "6e57a9efb29463da8af36727b0ba94acb2fdc7a698e54d3eae3e23a44d846f36"
      }
    ],
    "passed": 20,
    "consecutivePasses": 20,
    "artifact": "/home/vish/code/graphyard/.graphyard/worktrees/GY-1907-2/.graphyard/receipts/slow-tick-repeat-6d2aabbb3195"
  };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // The default test runner that temp-dirs' hook starts prints its own summary on stdout, so this
  // command keeps stdout clear: the receipt is read from the artifact directory it names.
  const execution = await executeSlowTickReceiptRuns({ onRun: run => console.error(`run ${run.run}: exit ${run.exitCode}, ${run.executed} executed, ${run.failed} failed, ${run.durationMs} ms${run.passed ? '' : ' FAILED'}`) });
  try {
    const verdict = verifySlowTickReceipt(execution.receipt);
    console.error(`receipt: ${join(execution.receipt.artifact, 'receipt.json')}`);
    if (!verdict.ok) { console.error(`the executed receipt does not verify:\n${verdict.faults.map(fault => `  - ${fault}`).join('\n')}`); process.exitCode = 1; }
    else console.error(`the executed receipt verifies: ${execution.receipt.passed} consecutive passed runs of ${pinnedSourceSha}`);
  } finally { await execution.release(); }
}
