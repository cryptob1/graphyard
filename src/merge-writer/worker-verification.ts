// Worker self-checks use the merge trial's private root, never the worker namespace.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { defaultChildRun } from '../child-runner.js';
import { trialContainerDependencies, trialContainerWords, trialHarness } from './trial-container.js';
import { trialLoad } from './trial-load.js';
import { trialEnvironment, trialHomeVariables, trialTemporaryVariables } from './trial.js';
import { tempOwnerMarker, writeTempOwner } from '../tmp-reclaim.js';
import { npmCiEnvironment } from '../cli/test-isolation.js';
import { installArgv, packageManager } from '../package-manager.js';
import { pinnedNodePath } from '../node-pin.js';
import type { WorkerVerificationResult } from '../cli/worker-verification.js';
import type { Work } from '../model.js';

export interface WorkerVerificationInput { head: string; epoch: number; mode: 'verify' | 'complete'; preserves?: string[] }
export const workerVerificationTimeoutMs = 55 * 60_000;
/** Where worker verifications make their `verify-` allocations, each marked with its owner so the loop's sweep takes back a crashed one's (GY-3188). */
export const workerVerificationRoot = () => join(homedir(), '.gy', 'trials');
export const workerVerificationPrefix = 'verify-';

export async function runWorkerVerification(root: string, work: Work, input: WorkerVerificationInput, baseBranch: string, parent = workerVerificationRoot()): Promise<WorkerVerificationResult> {
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
    env.PATH = (await pinnedNodePath(tree, env.PATH, (command, args) => defaultChildRun(command, args, { cwd: tree, env: npmCiEnvironment(env), wrapper, timeoutMs: remaining() })))!;
    const lock = (path: string) => readFile(join(path, 'package-lock.json'), 'utf8').catch(() => null);
    const [own, candidate] = await Promise.all([lock(root), lock(tree)]);
    if (own !== null && own === candidate && existsSync(join(root, 'node_modules'))) await symlink(join(root, 'node_modules'), join(tree, 'node_modules'));
    else if (candidate !== null || packageManager(tree).name === 'pnpm') {
      const [command, ...args] = installArgv(packageManager(tree));
      await defaultChildRun(command!, args, { cwd: tree, env: npmCiEnvironment(env), wrapper, timeoutMs: remaining() });
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
    await defaultChildRun('node', ['--import', `${trialHarness}/node_modules/tsx/dist/loader.mjs`, script], { cwd: tree, env, wrapper, timeoutMs: remaining(), group: true });
    return JSON.parse(await readFile(result, 'utf8'));
  } finally { await rm(allocation, { recursive: true, force: true }); await rm(tempOwnerMarker(allocation), { force: true }); }
}
