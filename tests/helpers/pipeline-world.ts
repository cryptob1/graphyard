// GY-3152: the pipeline scenario harness. A real temporary Postgres control plane behind its HTTP
// server, a scratch bare Git remote and the coordinator checkout cloned from it, and the loop's own
// cycle (runCycle: the merge writer step, then the batch gate step) over the production merge-writer
// reads — real trials, real pushes, every ledger step recorded through the plane's merge-record
// route. Agent work is scripted commits submitted as items; no AI runtime is launched.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapGate, gateRecordPath, readGateRecord, writeGateRecord, type GateRecord } from '../../src/batch-gate.js';
import { defaultChildRun, type ChildRun } from '../../src/child-runner.js';
import { runCycle } from '../../src/daemon/cycle.js';
import { mergeWriterReads, type MergeWriterReads } from '../../src/daemon/cycle-merge-writer.js';
import type { DaemonEffects } from '../../src/daemon/effects.js';
import { emptyDaemonState, type DaemonState } from '../../src/daemon/state.js';
import { deployOnce, deployRecordPath, type DeployWatchPorts } from '../../src/deploy-watch.js';
import { Engine } from '../../src/engine.js';
import { mergeCandidateHold, mergeOpeningHold, runMergeTrial, trialAheadOfReviewPrefix } from '../../src/merge-writer/executor.js';
import { gitRunnerFor } from '../../src/merge-writer/local-observation.js';
import { masterConfigSchema, type MasterConfig } from '../../src/master.js';
import type { Principal, Work } from '../../src/model.js';
import { server } from '../../src/server.js';
import { Store } from '../../src/store.js';
import { databaseUrl } from './postgres.js';
import { temporaryDirectory } from './temp-dirs.js';

export const repository = 'owner/pipeline';
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker' };
const coordinatorToken = `pipeline-coordinator-${'x'.repeat(32)}`, adminToken = `pipeline-admin-${'y'.repeat(32)}`;
const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
export const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the loop called GitHub (${String(name)})`); } });

/** A command E2E case: `run` exits 0 to pass. */
export const commandCase = (id: string, run: string) => JSON.stringify({ id, title: id, target: 'any', required: false, steps: [{ kind: 'command', name: id, run }] });

/**
 * The scratch repository: a static application the trial serves on its own port (so concurrent
 * trials never contend for one), a TAP proof file, the bound `fixture` case and the `smoke` case
 * (gate.core), which fails once a commit holds the file `broken`; `extra` adds files.
 */
function fixtureFiles(extra: Record<string, string>): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'pipeline-fixture', scripts: { build: 'node --eval 0', test: 'node --test --test-reporter=tap proof.cjs' } }),
    'proof.cjs': `const { test } = require('node:test');\ntest('unit:declared', () => {});\n`,
    'graphyard.json': JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking' }, gate: { core: ['smoke'] }, delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'site', build: null }] } }),
    'site/index.html': '<!doctype html><title>fixture</title>\n',
    'e2e/cases/fixture.json': commandCase('fixture', 'node --eval 0'),
    'e2e/cases/smoke.json': commandCase('smoke', `node --eval "process.exit(require('fs').existsSync('broken') ? 1 : 0)"`),
    ...extra,
  };
}

export interface World {
  root: string; origin: string; checkout: string; trials: string; url: string; database: string; config: MasterConfig;
  store: Store; engine: Engine; base: string;
  /** Every trial the loops in this process ran, by item key (`batch-gate` for the gate's). */
  trialLog: { key: string; mergeSha: string; startedAt: number; endedAt?: number }[];
  /** Every item the loops in this process filed, with main-gate.json as it stood on disk at that moment. */
  filings: { key: string; gate: GateRecord | null }[];
  /** Commits a branch from main's tip writing `files` (null deletes) and submits it as a reviewed item (`unreviewed`: a sensitive delta whose review gate holds). */
  submit(title: string, files: Record<string, string | null>, options?: { unreviewed?: boolean }): Promise<Work>;
  /** Every item's current document. */
  work(): Promise<Work[]>;
  /** main's tip on the remote. */
  main(): string;
  close(): Promise<void>;
}

async function writeFiles(root: string, files: Record<string, string | null>) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) { git(root, 'rm', '-q', path); continue; }
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** The plane, the remote and the checkout, with `extra` fixture files in the base commit. */
export async function pipelineWorld(label: string, extra: Record<string, string> = {}): Promise<World> {
  const root = await temporaryDirectory(label);
  const origin = join(root, 'origin.git'), checkout = join(root, 'checkout'), trials = join(root, 'trials');
  const database = await databaseUrl(label);
  const store = new Store(database); await store.init();
  const engine = new Engine(store, 120, repository);
  const http: Server = server(engine, [{ id: 'coordinator', role: 'coordinator', token: coordinatorToken }, { ...operator, token: adminToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.com');
  await writeFile(join(checkout, '.gitignore'), '.graphyard/\n');
  await writeFiles(checkout, fixtureFiles(extra));
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'base'); git(checkout, 'push', '-q', 'origin', 'main');
  const base = git(origin, 'rev-parse', 'main');
  git(checkout, 'checkout', '-q', '--detach');
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  const config = masterConfigSchema.parse({ version: 1, repository, baseBranch: 'main', url, credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'fixture',
    masterAgentName: 'fixture', workers: [], run: { mergeWriter: { deployKeyFile: join(root, 'unused-key'), parallel: 2 } } });
  let branches = 0;
  const work = async () => (await Promise.all((await store.list()).map(async item => (await store.workDocument(item.id))!)));
  return {
    root, origin, checkout, trials, url, database, config, store, engine, base, trialLog: [], filings: [],
    work,
    main: () => git(origin, 'rev-parse', 'main'),
    submit: async (title, files, options: { unreviewed?: boolean } = {}) => {
      const branch = `graphyard/pipeline-${++branches}-1`;
      git(checkout, 'fetch', '-q', 'origin', 'main');
      git(checkout, 'checkout', '-qb', branch, 'origin/main');
      await writeFiles(checkout, files);
      git(checkout, 'add', '-A'); git(checkout, 'commit', '-qm', title);
      const head = git(checkout, 'rev-parse', 'HEAD');
      git(checkout, 'checkout', '-q', '--detach');
      let item = await engine.execute(operator, 'create', null, { type: 'chore', title, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:declared', 'e2e:fixture'] }, { id: 'AC-2', text: 'Observe after deployment', proofs: ['manual:post-deploy/observed'] }] }, randomUUID());
      item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
      item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
      await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'fixture', path: join(root, branch), branch }, randomUUID());
      item = await engine.execute(worker, 'submit', item.id, { epoch: item.epoch, head }, randomUUID());
      // GY-3164: an unreviewed submission (a sensitive delta, whose review gate holds until an exact
      // approval) still owes its build-passed head a trial; every other gate but test and merge passes.
      const review = item.gates.find(gate => gate.name === 'review')!;
      if (options.unreviewed ? review.passed || !item.gates.filter(gate => gate.name !== 'review' && gate.name !== 'test' && gate.name !== 'merge').every(gate => gate.passed)
        : !item.gates.every(gate => ['test', 'merge'].includes(gate.name) || gate.passed))
        throw new Error(`${item.key} is not ready to merge: ${JSON.stringify(item.gates)}`);
      return item;
    },
    close: async () => {
      http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
      await store.close();
    },
  };
}

/**
 * The nested trial's children run directly, never under its private-root wrapper: the trial that
 * runs this test already confines them, and a nested bubblewrap is not available everywhere this
 * test runs (a worker sandbox, the trial container). The trusted harness the confined runner names
 * resolves to this checkout.
 */
const harnessLoader = '/graphyard-harness/node_modules/tsx/dist/loader.mjs';
const fixtureRun: ChildRun = async (command, args, options) => {
  if (args.includes(harnessLoader)) {
    const script = args.at(-1)!;
    const harness = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
    await writeFile(script, (await readFile(script, 'utf8')).replaceAll('/graphyard-harness', harness));
    args = args.map(arg => arg === harnessLoader ? fileURLToPath(new URL(import.meta.resolve('tsx'))) : arg);
  }
  if (command === 'git') return defaultChildRun(command, args, { ...options, env: { ...process.env, ...identity, ...options?.env } });
  return defaultChildRun(command, args, { ...options, wrapper: [] });
};

type Where = Pick<World, 'checkout' | 'trials' | 'url' | 'config'> & { snapshot(): Promise<Work[]>; trialLog?: World['trialLog']; filings?: World['filings'] };

const post = async (url: string, token: string, path: string, body: unknown, key: string) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${text}`);
  return JSON.parse(text);
};

/** The production merge-writer reads (effects-production.ts) over this world: trials in the checkout, records and filings through the plane. */
export function loopReads(where: Where, options: { gate: boolean }): MergeWriterReads {
  const reads = mergeWriterReads(where.config, where.checkout, fixtureRun, {
    base: where.trials,
    // GY-3164: the build gate alone opens a flight (the trial runs beside review); both gates land it.
    hold: async work => mergeCandidateHold((await where.snapshot()).find(item => item.id === work.id), work),
    holdOpening: async work => mergeOpeningHold((await where.snapshot()).find(item => item.id === work.id), work),
    // The trial reports a verdict at once: a failure is not re-run or attributed on the base.
    trial: input => runMergeTrial({ ...input, retries: 0, attribute: false }),
    record: (work, event) => post(where.url, coordinatorToken, `work/${work.id}/merge-record`, event, randomUUID()),
  });
  const trial: MergeWriterReads['trial'] = async (mergeSha, ...rest) => {
    const entry = { key: rest[1].key, mergeSha, startedAt: Date.now() } as World['trialLog'][number];
    where.trialLog?.push(entry);
    try { return await reads.trial(mergeSha, ...rest); } finally { entry.endedAt = Date.now(); }
  };
  return { ...reads, trial,
    createWork: (input, key) => {
      where.filings?.push({ key, gate: readGateRecord(gateRecordPath(where.checkout)) });
      return post(where.url, adminToken, 'work', input, key);
    },
    ...(options.gate ? { gate: { root: where.checkout, repository } } : {}) };
}

/** One loop process: its own daemon state and effects over the world; `cycle()` runs one coordination cycle. */
export function pipelineLoop(where: Where, options: { gate: boolean }) {
  const state: DaemonState = emptyDaemonState(where.config);
  const lines: string[] = [];
  let gate = options.gate, lastSnapshot: Work[] = [];
  const effects = () => ({ agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: lastSnapshot = await where.snapshot(), now: new Date().toISOString() }), closeSession: () => {}, dispatch: async () => {},
    decisions: async () => ({ decisions: [] }), persist: async () => {}, github: githubDouble, merge: githubDouble,
    mergeWriter: loopReads(where, { gate }), rework: async () => {} }) as unknown as DaemonEffects;
  return {
    state, lines,
    get lastSnapshot() { return lastSnapshot; },
    gating: (on: boolean) => { gate = on; },
    cycle: () => runCycle(where.config, state, effects(), Date.now, undefined, line => { lines.push(line); }),
  };
}

/** Runs `loop`'s cycles until `done` answers true, or fails naming `what` and the loop's journal. */
export async function cycleUntil(loop: ReturnType<typeof pipelineLoop>, what: string, done: () => boolean | Promise<boolean>, deadlineMs = 90_000) {
  for (const start = Date.now(); ;) {
    await loop.cycle();
    if (await done()) return;
    // A head the merge writer refused never lands: fail now, naming why. GY-3164: the settle that
    // keeps a passing trial for its head's review (`trial passed ahead of review`) is a head waiting
    // for approval, not a failed landing — its head lands once the same head is approved.
    const refused = loop.lastSnapshot.find(item => item.mergeLedger?.state === 'refused' && !item.mergeLedger.refusal?.reason.startsWith(trialAheadOfReviewPrefix));
    if (refused) throw new Error(`${what}: ${refused.key} was refused: ${refused.mergeLedger!.refusal?.reason}`);
    if (Date.now() - start > deadlineMs) {
      const actions = Object.entries(loop.state.actions).slice(-15).map(([key, action]) => `${key} ${action.state}: ${action.detail ?? ''}`);
      throw new Error(`${what} did not happen within ${deadlineMs} ms\n${[...loop.lines.slice(-30), ...actions].join('\n')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

/**
 * The deploy watch's ports over the checkout: fetch and ancestry are real git, and the base commit
 * served before the watch kept a record; the provider's
 * build, restart, health, publish and pin steps succeed and record the commit, as the compose
 * provider would once the image runs.
 */
export function watchPorts(world: Pick<World, 'checkout' | 'base'>, built: string[]): DeployWatchPorts {
  return {
    fetch: async () => { git(world.checkout, 'fetch', '-q', 'origin', 'main'); return git(world.checkout, 'rev-parse', 'refs/remotes/origin/main'); },
    head: async () => world.base,
    contains: async (ancestor, commit) => { try { git(world.checkout, 'merge-base', '--is-ancestor', ancestor, commit); return true; } catch { return false; } },
    build: async commit => { built.push(commit); },
    restart: async () => {}, health: async () => {}, checkout: async () => {}, pin: async () => {}, prune: async () => {},
    schema: async () => null, database: async () => null,
  };
}

/** One deploy-watch pass over the checkout: what it did and the commit its record serves. */
export const deployPass = (world: Pick<World, 'checkout' | 'base'>, built: string[] = []) => deployOnce(deployRecordPath(world.checkout), watchPorts(world, built), () => {}, repository);

/** The rollout the loop's first gate step makes, with the daily diagnostics already run: the base commit serves and is the first verified one. */
export const rollout = (world: Pick<World, 'checkout' | 'base'>) =>
  writeGateRecord(gateRecordPath(world.checkout), { ...bootstrapGate(repository, world.base), diagnosticsAt: new Date().toISOString() });

/** A loop in this process over `world`. */
export const worldLoop = (world: World, options: { gate: boolean }) => pipelineLoop({ ...world, snapshot: world.work }, options);

/** The snapshot a loop in another process reads: the same plane's database. */
export function storeSnapshot(database: string) {
  const store = new Store(database);
  return { snapshot: async () => (await Promise.all((await store.list()).map(async item => (await store.workDocument(item.id))!))), close: () => store.close() };
}

export { adminToken, coordinatorToken };
