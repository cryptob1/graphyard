import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { loadMasterConfig, saveWorkerProfile, setupMaster } from '../src/master/config.js';
import { dispatchWork, prepareWorkerLaunch, workerCommand } from '../src/master/dispatch.js';
import { runtimeKinds } from '../src/master/runtimes.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { bridgeTerminals } from '../src/master/terminal-bridge.js';
import { spawnHeadless, workerRunsDirectory } from '../src/headless-session.js';
import { liveRun } from '../src/runner/registry.js';
import { runTranscript } from '../src/model/sessions.js';
import type { Principal, Work } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';

// GY-3259: workers run through the headless runner. The real control plane, agent registry, CLI
// claim/worktree/watch and dispatch; the only substitute is each runtime's model executable, which
// commits in its worktree and submits its head under its own lease. Herdr is never called.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const reader: Principal = { id: 'reader', role: 'reader' } as Principal;
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
let store: Store, http: ReturnType<typeof server>, registry: AgentRegistry;
let root: string, scratch: string, bin: string, url: string, hostId: string, herdrCalls: string;
const homes = new Map<string, string>();
const bridge = new AbortController();

before(async () => {
  store = await withDatabase('headless-workers'); await store.init();
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  scratch = await temporaryDirectory('headless-workers', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  bin = await temporaryDirectory('bin', scratch);
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  http = server(engine, [coordinator, worker, reader].map(principal => ({ ...principal, token: token(principal) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Fixture.\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  // Herdr is on PATH and records any call: a worker launch must make none.
  herdrCalls = join(scratch, 'herdr-calls');
  await writeFile(join(bin, 'herdr'), `#!/bin/sh\necho "$@" >> ${herdrCalls}\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const credentials = await temporaryDirectory('credentials', scratch);
  await setupMaster(root, { url, token: token(coordinator), cliPath: launcher, credentialDirectory: credentials, run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  hostId = (await loadMasterConfig(root)).hostId;
  const credentialFile = join(credentials, 'worker-a.token');
  await writeFile(credentialFile, token(worker), { mode: 0o600 });
  await saveWorkerProfile(root, { name: 'launch', principal: worker.id, agentName: 'eng-a', mode: 'launch', kind: 'claude', credentialFile }, async () => ({ actor: worker }));
  registry = new AgentRegistry(store);
  // The loop's host bridge, which serves run logs to the item page.
  await new Promise<void>(resolve => bridgeTerminals(url, token(coordinator), bridge.signal, resolve, undefined, root));
});
after(async () => {
  bridge.abort();
  if (http) await new Promise<void>(resolve => { http.closeAllConnections?.(); http.close(() => resolve()); });
  if (store) await store.close();
});

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

/** One registry account per entry, each with a stub model executable for its runtime kind. */
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

/** One host dispatch invocation: the real launcher, its origin fetch answered from the local base. */
async function dispatch(work: Work) {
  const config = await loadMasterConfig(root);
  return dispatchWork(root, work, config.workers[0]!, { allWork: [work], observedAt: now(), headless: spawnHeadless,
    prepare: (at, key, profile, _run, claimBy, keep, cycle) => prepareWorkerLaunch(at, key, profile, (command, args, options) => command === 'git' && args[0] === 'fetch' ? '' : workerCommand(command, args, options), claimBy, keep, cycle),
    capacity: async event => { const result = await api(coordinator, 'POST', `work/${work.id}/capacity`, event); assert.equal(result.status, 200, JSON.stringify(result.body)); } });
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
async function recordRun(work: Work, epoch: number, run: string) {
  // The loop records the dispatched session's handle with its run; here, as the coordinator would.
  const recorded = await api(coordinator, 'POST', `work/${work.id}/session`, { id: `${worker.id}:${epoch}`, kind: 'implementation', principal: worker.id, runtime: 'stub', host: hostId, agentName: 'eng-a', transcript: runTranscript(run), subject: work.key, state: 'running' });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
}

for (const [index, kind] of runtimeKinds.entries()) test(`e2e:headless-workers — ${kind} claims, commits and completes as one headless run`, async () => {
  await configure([{ name: kind, kind }]);
  const work = await readyItem(`GY-${9600 + index}`);
  const launched = await dispatch(work);
  assert.equal(launched.epoch, 1);
  assert.equal(launched.runtime, kind);
  assert.match(launched.run, /^[0-9a-f-]{36}$/);
  const item = await submitted(work.id, 1);
  assert.equal(item.lease, null, 'complete ended the lease');
  assert.equal(item.workspaces[0]?.owner, worker.id, 'the worker claimed under its own identity');
  const argv = (await started(kind)).args as string[];
  assert.equal(argv[0], 'one-task');
  assert.ok(!argv.includes('--interactive-must-not-appear'));
  assert.equal(argv.filter(word => word.includes(`complete ${work.key} 1 --head`)).length, 1, 'the brief is the one request on the command line');
  assert.equal((await started(kind)).tty, false);
  assert.equal((await started(kind)).cwd, item.workspaces[0]!.path);
  // The durable run record names the work, epoch, principal, account and runtime, outside the worktree.
  const record = JSON.parse(await readFile(join(workerRunsDirectory(root), launched.run, 'session.json'), 'utf8'));
  assert.deepEqual([record.work, record.epoch, record.principal, record.account, record.kind], [work.key, 1, worker.id, kind, kind]);
  assert.ok(!join(workerRunsDirectory(root), launched.run).startsWith(item.workspaces[0]!.path));
  assert.equal(existsSync(herdrCalls), false, 'no Herdr call is made for workers');
});

test('e2e:headless-workers — a limit exit hands the item to the next account within ONE dispatch invocation; both run logs stay readable', async () => {
  await configure([{ name: 'spent', kind: 'claude', failure: "You've hit your session limit · resets 11pm" }, { name: 'successor', kind: 'muse', wait: true }]);
  const work = await readyItem('GY-9650');
  const launched = await dispatch(work);
  // Before dispatch returned: the first run ended, its work and hold were recorded, and the successor runs under a new epoch.
  assert.equal(await readFile(join(homes.get('spent')!, 'starts'), 'utf8'), '1');
  assert.ok(await started('successor'), 'the successor started before dispatch returned');
  assert.equal(launched.epoch, 2);
  assert.equal(launched.runtime, 'muse');
  assert.ok(liveRun('eng-a'), 'the successor is a live worker session');
  assert.match(launched.fallback?.note ?? '', /spent/);
  const handedOff = await stored(work.id);
  const exhaustion = handedOff.capacity?.exhaustions?.find(entry => entry.epoch === 1);
  assert.equal(exhaustion?.account, 'spent');
  assert.equal(exhaustion?.partialWork?.state, 'committed', 'the uncommitted work of the first run was kept on its branch');
  assert.equal((await registry.snapshot(hostId)).accounts.find(account => account.name === 'spent')?.eligible, false, 'the spent account is held');
  // The successor resumes the preserved work: its brief names the kept commit.
  assert.ok(((await started('successor')).args as string[]).some(word => word.includes(exhaustion!.partialWork!.commit!.slice(0, 12))), 'the successor brief names the preserved commit');
  await writeFile(join(homes.get('successor')!, 'release'), '');
  await submitted(work.id, 2);
  // Both runs' logs — the settled limit run of the prior account and the completed successor — are served, redacted, to a reader of the item.
  const first = readdirSync(workerRunsDirectory(root)).find(id => { const run = JSON.parse(readFileSync(join(workerRunsDirectory(root), id, 'session.json'), 'utf8')); return run.work === work.key && run.epoch === 1; })!;
  await recordRun(work, 1, first);
  await recordRun(work, 2, launched.run);
  const spent = await runLog(work, first);
  assert.equal(spent.status, 200, JSON.stringify(spent.body));
  assert.equal(spent.body.ended, true);
  assert.equal(spent.body.run.account, 'spent');
  assert.ok(spent.body.lines.some((line: any) => line.stream === 'stdout' && /stub claude working on GY-9650 epoch 1/.test(line.text) && line.at));
  assert.ok(spent.body.lines.some((line: any) => line.stream === 'stderr' && /session limit/.test(line.text)));
  assert.ok(spent.body.lines.some((line: any) => line.stream === 'stderr' && line.text.includes('token=[redacted]')));
  assert.ok(!JSON.stringify(spent.body).includes('leaked-secret-value'), 'credentials are redacted before they are stored');
  const done = await runLog(work, launched.run);
  assert.equal(done.status, 200);
  assert.equal(done.body.run.account, 'successor');
  assert.ok(done.body.lines.some((line: any) => line.stream === 'stdout' && /^submitted [0-9a-f]{40} 200$/.test(line.text)));
  // Access is the item's readers': a remote request without a credential is refused, and another item's path never reaches a run it does not name.
  for (const headers of [{ 'X-Forwarded-For': '203.0.113.9' }, { Authorization: `Bearer not-a-token-${'y'.repeat(32)}` }] as Record<string, string>[])
    assert.equal((await fetch(`${url}/api/work/${work.key}/runs/${launched.run}/log`, { headers })).status, 401, 'a remote reader without this repository\'s credential is refused');
  const other = await readyItem('GY-9651');
  assert.equal((await runLog(other, launched.run)).status, 404);
  assert.equal(existsSync(herdrCalls), false);
});

test('e2e:headless-workers — no eligible account left: the item stays queued with the cause recorded', async () => {
  await configure([{ name: 'last-a', kind: 'claude', failure: "You've hit your session limit · resets 11pm" }, { name: 'last-b', kind: 'codex', failure: "You've hit your usage limit. Try again at 11:00 PM." }]);
  const work = await readyItem('GY-9660');
  await assert.rejects(dispatch(work), /no further account|could be launched/);
  const item = await stored(work.id);
  assert.equal(item.lease, null, 'nothing holds the item');
  assert.equal(item.ready, true);
  assert.deepEqual(item.capacity?.exhaustions?.map(entry => entry.account).sort(), ['last-a', 'last-b']);
  for (const name of ['last-a', 'last-b']) assert.equal(await readFile(join(homes.get(name)!, 'starts'), 'utf8'), '1', 'each account starts at most once');
});
