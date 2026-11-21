// Worker self-checks use the merge trial's private root, never the worker namespace.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { defaultChildRun, type ChildProcessError, type ChildRunOptions } from '../child-runner.js';
import { trialContainerDependencies, trialContainerWords, trialHarness } from './trial-container.js';
import { launcherLines, trialContainerFault, trialLoad } from './trial-load.js';
import { trialEnvironment, trialHomeVariables, trialTemporaryVariables } from './trial.js';
import { tempOwnerMarker, writeTempOwner } from '../tmp-reclaim.js';
import { npmCiEnvironment } from '../cli/test-isolation.js';
import { installArgv, packageManager } from '../package-manager.js';
import { pinnedNodePath } from '../node-pin.js';
import { withHeavyJob } from '../master/verification-slots.js';
import { maskSecrets } from '../redaction.js';
import type { WorkerVerificationResult } from '../cli/worker-verification.js';
import type { Work } from '../model.js';

export interface WorkerVerificationInput { head: string; epoch: number; mode: 'verify' | 'complete' | 'check'; preserves?: string[]; check?: string }
export const workerVerificationTimeoutMs = 55 * 60_000;
/** Where worker verifications make their `verify-` allocations, each marked with its owner so the loop's sweep takes back a crashed one's (GY-3188). */
export const workerVerificationRoot = () => join(homedir(), '.gy', 'trials');
export const workerVerificationPrefix = 'verify-';

/**
 * One child of a verification in its trial container (GY-3332): the launcher's lines reach `progress` as
 * they happen, and a start that gave up waiting fails in the launcher's own words, never as a bare failed command.
 * GY-3506: any other failure keeps its exit status/signal and masked stdout/stderr before cleanup removes the allocation.
 */
export async function verificationStep(command: string, args: string[], options: ChildRunOptions, progress: (line: string) => void): Promise<string> {
  try { return await defaultChildRun(command, args, { ...options, onStderr: launcherLines(progress) }); }
  catch (error) {
    const failed = error as Partial<ChildProcessError>;
    const fault = trialContainerFault(String(failed.stderr ?? ''));
    if (fault) throw new Error(`The verification could not start: ${fault}`);
    if (failed.status == null && !failed.signal && !failed.timedOut) throw error;
    const ended = failed.status === 124 ? 'exit status 124: the trial container reached its deadline and was stopped'
      : failed.status != null ? `exit status ${failed.status}`
        : failed.signal ? `stopped by ${failed.signal}`
          : 'timed out';
    const header = maskSecrets(String(failed.message ?? `Command failed: ${command}`)).split('\n')[0];
    const stderr = maskSecrets(String(failed.stderr ?? '')).trim().slice(-4000);
    const stdout = maskSecrets(String(failed.stdout ?? '')).trim().slice(-4000);
    const streams = [stderr ? `stderr:\n${stderr}` : '', stdout ? `stdout:\n${stdout}` : ''].filter(Boolean).join('\n');
    throw new Error(`${header} (${ended})${streams ? `\n${streams}` : ''}`);
  }
}

/**
 * `progress` receives each launcher line (waiting, starting) as it happens, for the worker's `complete` to show (GY-3332).
 * GY-3447: a worker's own verification takes no host heavy-job slot; the trial load cap bounds it. GY-3446: under a host strict cap it does.
 */
export const runWorkerVerification = (root: string, work: Work, input: WorkerVerificationInput, baseBranch: string, parent = workerVerificationRoot(),
  progress: (line: string) => void = () => {}): Promise<WorkerVerificationResult> =>
  withHeavyJob(`worker verification ${work.key}`, () => verifyOnHost(root, work, input, baseBranch, parent, progress), { onWait: progress, strictOnly: true });

async function verifyOnHost(root: string, work: Work, input: WorkerVerificationInput, baseBranch: string, parent: string,
  progress: (line: string) => void): Promise<WorkerVerificationResult> {
  await mkdir(parent, { recursive: true });
  const allocation = await mkdtemp(join(parent, workerVerificationPrefix));
  await writeTempOwner(allocation);
  const tree = join(allocation, 'checkout'), home = join(allocation, 'home'), temporary = join(allocation, 'tmp');
  const deadline = Date.now() + workerVerificationTimeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    await mkdir(home); await mkdir(temporary);
    // Objects borrowed through alternates: candidate tests cannot write the shared repository.
    await defaultChildRun('git', ['init', '-q', tree], { timeoutMs: remaining() });
    const objects = (await defaultChildRun('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() + '/objects';
    await writeFile(join(tree, '.git', 'objects', 'info', 'alternates'), objects + '\n');
    await defaultChildRun('git', ['checkout', '-q', '--detach', input.head], { cwd: tree, timeoutMs: remaining() });
    const base = await defaultChildRun('git', ['-C', root, 'rev-parse', `refs/remotes/origin/${baseBranch}`]).catch(() => '');
    if (base.trim()) await defaultChildRun('git', ['update-ref', `refs/remotes/origin/${baseBranch}`, base.trim()], { cwd: tree });
    const env: Record<string, string> = { ...trialEnvironment(), ...trialHomeVariables(home, process.env, true), ...trialTemporaryVariables(temporary), PATH: '/usr/local/bin:/usr/bin:/bin' };
    delete env.NODE_TEST_CONTEXT;
    const wrapper = trialContainerWords([allocation], trialContainerDependencies(root), undefined, undefined, deadline, await trialLoad(root, 'verification'));
    // GY-3207: the candidate's install and checks run under the Node major it declares.
    env.PATH = (await pinnedNodePath(tree, env.PATH, (command, args) => verificationStep(command, args, { cwd: tree, env: npmCiEnvironment(env), wrapper, timeoutMs: remaining() }, progress)))!;
    const lock = (path: string) => readFile(join(path, 'package-lock.json'), 'utf8').catch(() => null);
    const [own, candidate] = await Promise.all([lock(root), lock(tree)]);
    if (own !== null && own === candidate && existsSync(join(root, 'node_modules'))) await symlink(join(root, 'node_modules'), join(tree, 'node_modules'));
    else if (candidate !== null || packageManager(tree).name === 'pnpm') {
      const [command, ...args] = installArgv(packageManager(tree));
      await verificationStep(command!, args, { cwd: tree, env: npmCiEnvironment(env), wrapper, timeoutMs: remaining() }, progress);
    }
    const result = join(allocation, 'result.json'), script = join(allocation, 'verify.mjs');
    await writeFile(script, `
import { verifyWorkingTree } from '${trialHarness}/src/cli/verify.ts';
import { completionRerun } from '${trialHarness}/src/cli/complete.ts';
import { writeFileSync } from 'node:fs';
const work = ${JSON.stringify({ key: work.key, criteria: work.criteria, mergeLedger: work.mergeLedger })};
const record = await verifyWorkingTree(work, ${JSON.stringify(tree)}, undefined, ${JSON.stringify({ baseBranch, preserves: input.preserves })});
const rerun = ${input.mode === 'complete' ? `await completionRerun(${JSON.stringify(tree)}, work)` : '{ flaked: [], baseFailures: [] }'};
writeFileSync(${JSON.stringify(result)}, JSON.stringify({ record, rerun }));
`);
    await verificationStep('node', ['--import', `${trialHarness}/node_modules/tsx/dist/loader.mjs`, script], { cwd: tree, env, wrapper, timeoutMs: remaining(), group: true }, progress);
    return JSON.parse(await readFile(result, 'utf8'));
  } finally { await rm(allocation, { recursive: true, force: true }); await rm(tempOwnerMarker(allocation), { force: true }); }
}
