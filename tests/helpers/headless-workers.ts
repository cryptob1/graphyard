import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './postgres.js';
import { temporaryDirectory } from './temp-dirs.js';
import { AgentRegistry } from '../../src/agent-registry.js';
import { Engine } from '../../src/engine.js';
import { loadMasterConfig, saveWorkerProfile, setupMaster } from '../../src/master/config.js';
import { dispatchWork, prepareWorkerLaunch, workerCommand, workerRunHandle } from '../../src/master/dispatch.js';
import { runtimeKinds, type RuntimeKind } from '../../src/master/runtimes.js';
import { gitRunnerFor } from '../../src/merge-writer/local-observation.js';
import { bridgeTerminals } from '../../src/master/terminal-bridge.js';
import { spawnHeadless, workerRunsDirectory } from '../../src/headless-session.js';
import { liveRun } from '../../src/runner/registry.js';
import type { Principal, Work } from '../../src/model.js';
import { server } from '../../src/server.js';
import { Store } from '../../src/store.js';

// GY-3259: workers run through the headless runner. The real control plane, agent registry, CLI
// claim/worktree/watch and dispatch; the only substitute is each runtime's model executable, which
// commits in its worktree and submits its head under its own lease. Herdr is never called.
//
// The kind matrix spans two files (the built-in contracts here, the registry-contract kinds in
// tests/headless-workers-registry-kinds.test.ts): a merge trial bounds one file at five minutes
// (tests/helpers/bounded-tests.mjs), and the whole matrix at the trial host's own pace overruns
// that bound while either half stays well inside it.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const reader: Principal = { id: 'reader', role: 'reader' } as Principal;
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url));

/** Everything one matrix file's tests share: its control plane, fixture directories and helpers. */
export interface HeadlessWorkers {
  /** The coordinator root the dispatch launches from; `workerRunsDirectory(root)` holds each run's record. */
  root: string;
  url: string;
  hostId: string;
  herdrCalls: string;
  homes: Map<string, string>;
  registry: AgentRegistry;
  api: (principal: Principal | null, method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  stored: (id: string) => Promise<Work>;
  readyItem: (key: string) => Promise<Work>;
  /** One registry account per entry, each with a stub model executable for its runtime kind. */
  configure: (entries: { name: string; kind: string; failure?: string; wait?: boolean }[]) => Promise<void>;
  /** One host dispatch invocation: the real launcher, its origin fetch answered from the local base. */
  dispatch: (work: Work) => Promise<Awaited<ReturnType<typeof dispatchWork>>>;
  submitted: (id: string, epoch: number) => Promise<Work>;
  started: (name: string) => Promise<{ args: string[]; cwd: string; tty: boolean }>;
  runLog: (work: Work, run: string) => Promise<{ status: number; body: any }>;
  stop: () => Promise<void>;
}

/** The running fixture behind `started`/`submitted`: one per matrix file, from its `before` hook. */
export type HeadlessWorkersHandle = () => HeadlessWorkers;

/** Builds one file's fixture: its database, served control plane, coordinator root and bridge. */
export async function headlessWorkers(label: string): Promise<HeadlessWorkers> {
  const store: Store = await withDatabase(label); await store.init();
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory(label, join(process.cwd(), '.graphyard'));
  const root = await temporaryDirectory('coordinator', scratch);
  const bin = await temporaryDirectory('bin', scratch);
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  const http = server(engine, [coordinator, worker, reader].map(principal => ({ ...principal, token: token(principal) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Fixture.\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  // Herdr is on PATH and records any call: a worker launch must make none.
  const herdrCalls = join(scratch, 'herdr-calls');
  await writeFile(join(bin, 'herdr'), `#!/bin/sh\necho "$@" >> ${herdrCalls}\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const credentials = await temporaryDirectory('credentials', scratch);
  await setupMaster(root, { url, token: token(coordinator), cliPath: launcher, credentialDirectory: credentials, run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  const hostId = (await loadMasterConfig(root)).hostId;
  const credentialFile = join(credentials, 'worker-a.token');
  await writeFile(credentialFile, token(worker), { mode: 0o600 });
  await saveWorkerProfile(root, { name: 'launch', principal: worker.id, agentName: 'eng-a', mode: 'launch', kind: 'claude', credentialFile }, async () => ({ actor: worker }));
  const registry = new AgentRegistry(store);
  const homes = new Map<string, string>();
  // The loop's host bridge, which serves run logs to the item page.
  const bridge = new AbortController();
  await new Promise<void>(resolve => bridgeTerminals(url, token(coordinator), bridge.signal, resolve, undefined, root));

  const api = async (principal: Principal | null, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method, headers: { ...(principal ? { Authorization: `Bearer ${token(principal)}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
  async function readyItem(key: string): Promise<Work> {
    const at = now();
    const work = { id: randomUUID(), key, title: `Item ${key}`, description: 'Write change.txt.', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'change.txt exists', proofs: ['unit:works'] }],
      policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
      ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
      gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] } as unknown as Work;
    await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
    return work;
  }
  async function configure(entries: { name: string; kind: string; failure?: string; wait?: boolean }[]) {
    const accounts = (await registry.document(coordinator)).accounts.filter(account => !entries.some(entry => entry.name === account.name)).map(({ quota, quotaDecision, smoke, unjudged, ...account }) => ({ ...account, enabled: false }));
    const runtimes = [];
    for (const entry of entries) {
      const home = await temporaryDirectory(entry.name, scratch); homes.set(entry.name, home);
      await writeFile(join(home, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-key' } }));
      await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-key', anthropic: { type: 'api', key: 'fixture-key' } }));
      await writeFile(join(home, 'cli-config.json'), JSON.stringify({ authInfo: { userId: entry.name } }));
      await mkdir(join(home, 'opencode'), { recursive: true });
      await writeFile(join(home, 'opencode/auth.json'), JSON.stringify({ anthropic: { type: 'api', key: 'fixture-key' } }));
      const executable = entry.kind === 'cursor' ? 'cursor-agent' : entry.kind;
      // The model executable: it records its argv, prints on both streams, leaves uncommitted work, and
      // then either stops on its failure or commits and submits its head as the leased worker.
      await writeFile(join(bin, executable), `#!${process.execPath}
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const home = process.env.RUNTIME_HOME, args = process.argv.slice(2);
fs.appendFileSync(home + '/starts', '1');
fs.writeFileSync(home + '/started.json', JSON.stringify({ args, cwd: process.cwd(), tty: !!process.stdout.isTTY }));
const [, key, epoch] = /complete (GY-\\d+) (\\d+) --head/.exec(args.join(' ')) ?? [];
console.log('stub ${entry.kind} working on ' + key + ' epoch ' + epoch);
console.error('stub ${entry.kind} diagnostics token=leaked-secret-value');
fs.writeFileSync('notes-' + epoch + '.txt', 'partial work of epoch ' + epoch + '\\n');
if (${JSON.stringify(entry.failure ?? '')}) { console.error(${JSON.stringify(entry.failure ?? '')}); process.exit(1); }
(async () => {
  while (${!!entry.wait} && !fs.existsSync(home + '/release')) await new Promise(resolve => setTimeout(resolve, 20));
  fs.writeFileSync('change.txt', 'done by ${entry.kind}\\n');
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['-c', 'user.name=w', '-c', 'user.email=w@example.invalid', 'commit', '-qm', 'work']);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const response = await fetch(process.env.GRAPHYARD_URL + '/api/work/' + key + '/submit', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GRAPHYARD_TOKEN, 'Content-Type': 'application/json', 'Idempotency-Key': key + ':' + epoch }, body: JSON.stringify({ epoch: Number(epoch), head }) });
  console.log('submitted ' + head + ' ' + response.status);
})();
`, { mode: 0o755 });
      runtimes.push({ name: entry.name, launch: { kind: entry.kind, args: ['--interactive-must-not-appear'], headlessArgs: ['one-task', '--prompt', '{request}'],
        environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, homeVariable: 'RUNTIME_HOME', modelFlag: '--model' } });
      accounts.push({ enabled: true, maxSessions: null, name: entry.name, runtime: entry.name, model: 'fixture', credential: { host: hostId, home } });
    }
    await registry.mutate(coordinator, 'apply', { runtimes, accounts, models: [{ name: 'fixture', id: 'fixture-model' }],
      roles: [{ name: 'worker', accounts: entries.map(entry => entry.name), concurrency: 4 }], reason: 'fixture runtime matrix' }, randomUUID());
    await registry.observe(coordinator, { host: hostId, observations: entries.map(entry => ({ account: entry.name, quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } })) }, randomUUID());
  }
  async function dispatch(work: Work) {
    const config = await loadMasterConfig(root);
    return dispatchWork(root, work, config.workers[0]!, { allWork: [work], observedAt: now(), headless: spawnHeadless,
      prepare: (at, key, profile, _run, claimBy, keep, cycle) => prepareWorkerLaunch(at, key, profile, (command, args, options) => command === 'git' && args[0] === 'fetch' ? '' : workerCommand(command, args, options), claimBy, keep, cycle),
      capacity: async event => { const result = await api(coordinator, 'POST', `work/${work.id}/capacity`, event); assert.equal(result.status, 200, JSON.stringify(result.body)); },
      // The loop records each run on the item as it starts (daemon/cycle.ts), as the coordinator.
      onRun: async run => { const result = await api(coordinator, 'POST', `work/${work.id}/session`, workerRunHandle(work, config.workers[0]!, hostId, run)); assert.equal(result.status, 200, JSON.stringify(result.body)); } });
  }
  async function submitted(id: string, epoch: number) {
    for (let tries = 0; tries < 600; tries++) {
      const item = await stored(id);
      if (item.submission?.epoch === epoch && !liveRun('eng-a')) return item;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`${id} epoch ${epoch} was never submitted by its worker: ${JSON.stringify((await stored(id)).lease)}`);
  }
  const started = async (name: string) => JSON.parse(await readFile(join(homes.get(name)!, 'started.json'), 'utf8'));
  const runLog = async (work: Work, run: string) => api(reader, 'GET', `work/${work.key}/runs/${run}/log`);
  return { root, url, hostId, herdrCalls, homes, registry, api, stored, readyItem, configure, dispatch, submitted, started, runLog,
    stop: async () => {
      bridge.abort();
      await new Promise<void>(resolve => { http.closeAllConnections?.(); http.close(() => resolve()); });
      await store.close();
    } };
}

/** The kinds with a built-in startup contract (tests/headless-workers.test.ts); `devin` is the first registry-contract kind. */
export const contractKinds = runtimeKinds.slice(0, runtimeKinds.indexOf('devin'));
/** The kinds launched only through an agent-registry contract (tests/headless-workers-registry-kinds.test.ts). */
export const registryKinds = runtimeKinds.slice(runtimeKinds.indexOf('devin'));

/** One per-kind matrix test, as both files declare it: the kind claims, commits and completes as one headless run. */
export function headlessWorkerKindTest(workers: HeadlessWorkersHandle, kind: RuntimeKind) {
  test(`e2e:headless-workers — ${kind} claims, commits and completes as one headless run`, async () => {
    const f = workers();
    await f.configure([{ name: kind, kind }]);
    const work = await f.readyItem(`GY-${9600 + runtimeKinds.indexOf(kind)}`);
    const launched = await f.dispatch(work);
    assert.equal(launched.epoch, 1);
    assert.equal(launched.runtime, kind);
    assert.match(launched.run, /^[0-9a-f-]{36}$/);
    const item = await f.submitted(work.id, 1);
    assert.equal(item.lease, null, 'complete ended the lease');
    assert.equal(item.workspaces[0]?.owner, worker.id, 'the worker claimed under its own identity');
    const argv = (await f.started(kind)).args as string[];
    assert.equal(argv[0], 'one-task');
    assert.ok(!argv.includes('--interactive-must-not-appear'));
    assert.equal(argv.filter(word => word.includes(`complete ${work.key} 1 --head`)).length, 1, 'the brief is the one request on the command line');
    assert.equal((await f.started(kind)).tty, false);
    assert.equal((await f.started(kind)).cwd, item.workspaces[0]!.path);
    // The durable run record names the work, epoch, principal, account and runtime, outside the worktree.
    const record = JSON.parse(await readFile(join(workerRunsDirectory(f.root), launched.run, 'session.json'), 'utf8'));
    assert.deepEqual([record.work, record.epoch, record.principal, record.account, record.kind], [work.key, 1, worker.id, kind, kind]);
    assert.ok(!join(workerRunsDirectory(f.root), launched.run).startsWith(item.workspaces[0]!.path));
    assert.equal(existsSync(f.herdrCalls), false, 'no Herdr call is made for workers');
  });
}
