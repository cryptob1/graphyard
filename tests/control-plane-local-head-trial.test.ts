import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { mergeWriterIdle, mergeWriterReads, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { runMergeTrial, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { masterConfigSchema } from '../src/master.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { completionBody } from '../src/cli/complete.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2010 AC-3: in control-plane mode a submitted head present in the shared object store
 * progresses through the merge writer when origin holds only the base branch. The pull-request-era
 * shadow gate fetched the worker assignment branch, which fails with missing-remote-ref; it is gone
 * (AC-5), so nothing in the cycle fetches a worker ref or arms a stall that holds merge-writer
 * admission, and the writer still launches its exact-candidate trial.
 */

const start = Date.parse('2030-05-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const repository = 'owner/project';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const config = masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [],
  run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } },
});
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`called GitHub (${String(name)})`); } });

let pg: EmbeddedPostgres, store: Store, engine: Engine;
let fixtureRoot: string, origin: string, checkout: string, worktreeBase: string, baseTip: string, head: string, branch: string;

async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('control-plane-local-head'));
  origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout'); worktreeBase = join(fixtureRoot, 'managed');
  branch = 'graphyard/gy-2010-1';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'README.md', '# Fixture\n', 'base');
  await commit(checkout, 'src/app.ts', 'export const app = 1;\n', 'app');
  await commit(checkout, 'tests/app.test.ts', "import { test } from 'node:test';\ntest('unit:app-works — the app answers', () => {});\n", 'test');
  git(checkout, 'push', '-q', 'origin', 'main');
  baseTip = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  // Worker head in the shared object store only: linked worktree, never pushed to origin.
  const worktree = join(checkout, '.graphyard', 'worktrees', 'GY-2010-1');
  git(checkout, 'worktree', 'add', '-q', '-b', branch, worktree, baseTip);
  git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
  head = await commit(worktree, 'src/app.ts', 'export const app = 2;\n', 'change');
  assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads').trim(), 'refs/heads/main', 'origin holds only the base branch');

  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3010;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('control-plane-local-head-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('local_head_trial');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/local_head_trial`); await store.init();
  engine = new Engine(store, 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

async function submittedItem(): Promise<Work> {
  let w = await engine.execute(admin, 'create', null, { title: 'Local head trial', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:app-works'] }] }, randomUUID());
  w = await engine.execute(admin, 'ready', w.id, {}, randomUUID());
  const pulled = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  assert.equal(pulled.assigned?.id, w.id, JSON.stringify(pulled.refused)); w = pulled.assigned!;
  await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/local-head`, branch }, randomUUID());
  return engine.execute(worker, 'submit', w.id, completionBody(['1', '--head', head], () => head), randomUUID());
}

function effectsFor(world: { work: () => Work[] | Promise<Work[]>; now: () => number; mergeWriter: MergeWriterReads | null }) {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: await world.work(), now: iso(world.now()) }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(world.now()), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, mergeWriter: world.mergeWriter,
  } as unknown as DaemonEffects;
}

test('integration:control-plane-local-head-trial — a head present only in the shared object store progresses through the merge writer when origin has no worker assignment branch; the pull-request-era shadow fetch of that branch fails with missing-remote-ref, the loop runs no such fetch and no stall holds admission, and the writer launches its exact-candidate trial', async () => {
  // Regression: the pull-request-era shadow probe fetched the worker assignment branch from origin.
  assert.throws(() => execFileSync('git', ['-C', checkout, 'fetch', '--no-tags', 'origin', 'main', branch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    (error: Error & { stderr?: string }) => /couldn'?t find remote ref|fatal:/.test(`${error.message}\n${error.stderr ?? ''}`),
    'the observed missing-remote-ref failure when origin has no worker assignment branch');

  const w = await submittedItem();
  assert.equal(w.observation?.source, 'control-plane');
  assert.equal(w.candidate?.sha, head);
  assert.ok(git(checkout, 'cat-file', '-t', head) === 'commit', 'the head is in the shared object store');

  const fetches: string[][] = [];
  const trials: Parameters<typeof runMergeTrial>[0][] = [];
  const writerRun: ChildRun = (command, args, options) => {
    if (command === 'git' && args.includes('fetch')) fetches.push([...args]);
    return defaultChildRun(command, args, options);
  };
  const trial = async (given: Parameters<typeof runMergeTrial>[0]): Promise<MergeTrialRun> => {
    const input = { ...given, proofFiles: [...given.proofFiles, ...(await given.discoverProofFiles?.({}) ?? [])] };
    trials.push(input);
    return { build: 'pass', tests: { passed: input.proofFiles.length, failed: [], files: input.proofFiles.length }, durationMs: 5, logTail: 'ok', files: [...input.proofFiles], proofs: Object.fromEntries(input.proofs.map(proof => [proof, { executed: 1, failed: 0 }])) };
  };
  const fixtureConfig = masterConfigSchema.parse({ ...config, run: { mergeWriter: { deployKeyFile: join(fixtureRoot, 'deploy-key'), retrials: 3 } } });
  const records: { kind: string }[] = [];
  const reads = mergeWriterReads(fixtureConfig, checkout, writerRun, {
    base: worktreeBase, merger: async () => 'control-plane', trial,
    record: async (_work, event) => { records.push({ kind: event.kind }); return {}; },
  });

  // The real writer step launches its trial of the local head while origin still holds no worker ref.
  const state: DaemonState = emptyDaemonState(config);
  const now = () => start;
  const document = async () => (await store.workDocument(w.id))!;
  const effects = effectsFor({ work: async () => [await document()], now, mergeWriter: reads });
  await runCycle(config, state, effects, now);
  assert.equal(state.mergeWriter.inFlight?.head, head, 'the merge writer admitted the local head and started its merge');
  assert.equal(state.mergeWriter.inFlight?.key, w.key);
  await mergeWriterIdle(state);
  await runCycle(config, state, effects, now);
  assert.ok(trials.length >= 1, 'the writer launched its exact-candidate trial');
  assert.equal(trials[0]!.key, w.key);
  assert.ok(trials[0]!.proofs.includes('unit:app-works'), 'the trial retains the candidate\'s proof gates');
  assert.ok(records.some(entry => entry.kind === 'intent' || entry.kind === 'trial'), `the writer recorded trial progress: ${JSON.stringify(records)}`);
  // No step of either cycle fetched the unpublished worker ref, and no stall stands to hold the writer's admission.
  assert.ok(fetches.every(args => !args.some(arg => arg.includes(branch))), `no fetch names the worker assignment branch: ${JSON.stringify(fetches)}`);
  assert.deepEqual(Object.values(state.stepStalls).filter(run => run.stalledAt), [], 'no stall holds merge-writer admission');
  const steps = state.metrics.flatMap(metric => metric.timings?.steps.map(entry => entry.step) ?? []);
  assert.ok(steps.includes('merge writer') && !steps.includes('shadow gate'), `the loop runs the writer's trial and no shadow trial: ${steps.join(', ')}`);
  assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads').trim(), 'refs/heads/main', 'origin still holds only the base branch');
});
