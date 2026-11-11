import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import type { Principal, Work } from '../src/model.js';
import { runtimeKinds } from '../src/master/runtimes.js';
import { registeredReview } from '../src/master/autonomy.js';
import { launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { liveRun } from '../src/runner/registry.js';
import { spawnHeadless } from '../src/headless-session.js';
import { headlessInventory } from '../src/session-inventory.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { dispatchEffects } from '../src/dispatch/effects.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const reviewer = 'independent-reviewer';
const now = () => new Date().toISOString();
let store: Store, http: ReturnType<typeof server>, registry: AgentRegistry;
let root: string, scratch: string, bin: string, base: string, head: string, url: string, hostId: string;
const homes = new Map<string, string>();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

before(async () => {
  store = await withDatabase('headless-reviewers'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  // Visible under confinement (which mounts its own temporary filesystem).
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  scratch = await temporaryDirectory('headless-reviewers', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  bin = await temporaryDirectory('bin', scratch);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Named spec file.');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'Dockerfile'), 'export const flag = "held";');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'head');
  head = git('rev-parse', 'HEAD'); git('checkout', '-q', base);
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: await temporaryDirectory('credentials', scratch), herdrWorkspace: 'w', run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  hostId = (await loadMasterConfig(root)).hostId;
  registry = new AgentRegistry(store);
  await saveReviewerProfile(root, { name: 'reviewer', agentName: reviewer, kind: 'claude', agentArgs: [] });
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
});

const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
const insert = async (work: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]); return work; };
function reviewItem(key: string): Work {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The flag reads held', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'],
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['Dockerfile'], scopeFiles: [{ path: 'Dockerfile', status: 'added', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } } as unknown as Work;
}

async function configure(entries: { name: string; kind: string; failure?: string; contract?: boolean; wait?: boolean }[]) {
  const runtimes = [];
  const accounts = (await registry.document(coordinator)).accounts.filter(account => !entries.some(entry => entry.name === account.name)).map(({ quota, quotaDecision, smoke, unjudged, ...account }) => ({ ...account, enabled: false }));
  for (const entry of entries) {
    const home = await temporaryDirectory(entry.name, scratch); homes.set(entry.name, home);
    await writeFile(join(home, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-key' } }));
    await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-key', anthropic: { type: 'api', key: 'fixture-key' } }));
    await writeFile(join(home, 'cli-config.json'), JSON.stringify({ authInfo: { userId: entry.name } }));
    await mkdir(join(home, 'opencode'));
    await writeFile(join(home, 'opencode/auth.json'), JSON.stringify({ anthropic: { type: 'api', key: 'fixture-key' } }));
    const executable = entry.kind === 'cursor' ? 'cursor-agent' : entry.kind;
    // The only substitute is the model executable. It records its actual argv, home and namespace.
    await writeFile(join(bin, executable), `#!${process.execPath}
import fs from 'node:fs';
const home = process.env.RUNTIME_HOME;
const args = process.argv.slice(2);
fs.appendFileSync(home + '/starts', '1');
fs.writeFileSync(home + '/started.json', JSON.stringify({ args, home, namespace: fs.readlinkSync('/proc/self/ns/mnt'), token: process.env.GRAPHYARD_TOKEN ?? null, credential: fs.existsSync(${JSON.stringify((await loadMasterConfig(root)).credentialFile)}), tty: !!process.stdout.isTTY }));
if (${JSON.stringify(entry.failure ?? '')}) { console.error(${JSON.stringify(entry.failure ?? '')}); process.exit(1); }
(async () => {
while (${!!entry.wait} && !fs.existsSync(home + '/release')) await new Promise(resolve => setTimeout(resolve, 20));
console.log(JSON.stringify({ verdict: 'APPROVE', body: 'Reviewed head ${head} against base ${base}. AC-1 met.', findings: [] }));
})();
`, { mode: 0o755 });
    runtimes.push({ name: entry.name, launch: { kind: entry.kind, args: ['--interactive-must-not-appear'], ...(entry.contract === false ? {} : { headlessArgs: ['one-task', '--prompt', '{request}'] }),
      environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, homeVariable: 'RUNTIME_HOME', modelFlag: '--model', toolsFlag: '--tools' } });
    accounts.push({ enabled: true, maxSessions: null, name: entry.name, runtime: entry.name, model: 'fixture', credential: { host: hostId, home } });
  }
  await registry.mutate(coordinator, 'apply', { runtimes, accounts, models: [{ name: 'fixture', id: 'fixture-model' }],
    roles: [{ name: 'reviewer', accounts: entries.map(entry => entry.name), concurrency: 4, policy: { args: ['--role-policy'], tools: ['read'] } }], reason: 'fixture runtime matrix' }, randomUUID());
  await registry.observe(coordinator, { host: hostId, observations: entries.map(entry => ({ account: entry.name, quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } })) }, randomUUID());
}

async function dispatch(work: Work, confined = false) {
  const config = await loadMasterConfig(root);
  const request = { id: randomUUID(), kind: 'review' as const, provider: 'github' as const, reason: 'fixture needs independent review', pr: 7, sha: head, baseSha: base, policyRevision: 1, state: 'requested' as const, requestedAt: now(), requestedBy: 'graphyard', attempts: 0 };
  work.autoDispatch = { review: request, producers: [], history: [] };
  await insert(work);
  const mutate = async (path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${coordinatorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  if (confined) {
    process.env.GRAPHYARD_CONFINEMENT = 'master';
    try {
      const queued = await registeredReview(config, [work.key, 'reviewer'], { work: [work] }, mutate, async () => assert.fail('confined caller attempted a launch'));
      assert.equal(queued.queued, true);
      assert.equal(queued.requestId, request.id);
    } finally { delete process.env.GRAPHYARD_CONFINEMENT; }
  }
  let calls = 0, dispatchCalls = 0;
  const run = (command: string, args: string[], options?: { cwd?: string }) => {
    assert.notEqual(command, 'herdr', 'reviews must never call Herdr');
    return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  };
  const effects = dispatchEffects(root, config, { snapshot: async () => { dispatchCalls++; return { work: [await stored(work.id)], now: now() }; }, mutate, run, headless: spawnHeadless, ...(confined ? { coordinatorRoot: root } : {}) });
  // There are no interactive agents in this fixture; the real headless inventory is authoritative.
  effects.inventory = async () => headlessInventory();
  const launch = effects.launchReview;
  effects.launchReview = (...args) => { calls++; return launch(...args); };
  const tick = await runDispatchTick(config, emptyDispatchCursor(config), effects);
  assert.equal(dispatchCalls, 1, 'one host dispatch invocation');
  assert.equal(calls, 1, JSON.stringify(tick));
  assert.equal(tick.launched.length, 1, JSON.stringify(tick));
  const record = (await readReviewLedger(root)).reviews.find(record => record.key === work.key)!;
  assert.ok(record, 'the real dispatch recorded the review');
  return record;
}

async function reviewed(id: string) {
  for (let tries = 0; tries < 400; tries++) {
    const record = (await readReviewLedger(root)).reviews.find(entry => entry.id === id)!;
    if (!liveRun(record.agentName) && (record.verdict || record.state !== 'pending')) return record;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('review did not settle');
}
const started = async (name: string) => JSON.parse(await readFile(join(homes.get(name)!, 'started.json'), 'utf8'));

for (const [index, kind] of runtimeKinds.entries()) test(`e2e:headless-reviewers — ${kind} dispatches its explicit one-task argv and posts a bound verdict`, async () => {
  await configure([{ name: kind, kind }]);
  const work = reviewItem(`GY-${9400 + index}`);
  const launched = await dispatch(work);
  const record = await reviewed(launched.id);
  assert.equal(record.verdict?.state, 'APPROVED', record.resolution);
  assert.equal(record.verdict?.reviewer, reviewer);
  assert.equal(record.headless?.kind, kind);
  assert.match(record.headless!.id, /^[0-9a-f-]{36}$/);
  const argv = (await started(kind)).args as string[];
  assert.equal(argv[0], 'one-task');
  assert.equal(argv.filter(word => word.includes('You are the independent Graphyard reviewer')).length, 1);
  assert.ok(argv.includes('--role-policy') && argv.includes('--tools') && argv.includes('read'));
  assert.ok(!argv.includes('--interactive-must-not-appear'));
  assert.equal(argv[argv.indexOf('--prompt') + 1].includes(head), true);
  assert.equal((await started(kind)).home, homes.get(kind));
  assert.equal((await started(kind)).tty, false);
  const observed = await stored(work.id);
  assert.equal(observed.reviewLaunch?.verdict?.reviewId, record.verdict?.reviewId);
  assert.equal(observed.reviewLaunch?.head, head);
  assert.equal(observed.reviewLaunch?.baseTip, base);
  assert.equal(record.policyRevision, 1);
});

for (const [index, failure] of ['Not logged in · Please run /login', "You've hit your session limit"].entries()) test(`e2e:headless-reviewers — ${failure} starts a successor within ONE dispatch invocation`, async () => {
  const failed = `failed-${index}`, successor = `successor-${index}`;
  await configure([{ name: failed, kind: 'claude', failure }, { name: successor, kind: 'muse', wait: true }]);
  const work = reviewItem(`GY-${9450 + index}`);
  const record = await dispatch(work);
  assert.ok(await started(failed));
  assert.ok(await started(successor), 'successor process started before dispatch returned');
  assert.ok(liveRun(record.agentName));
  const snapshot = await registry.snapshot(hostId);
  assert.equal(snapshot.accounts.find(account => account.name === failed)?.eligible, false);
  assert.equal(snapshot.sessions.filter(session => session.account === failed && !session.endedAt).length, 0);
  assert.equal(record.headless?.kind, 'muse');
  const durable = JSON.parse(await readFile(join(liveRun(record.agentName)!.run.directory!, 'session.json'), 'utf8'));
  assert.equal(durable.id, record.headless!.id);
  assert.equal(durable.kind, 'muse'); assert.equal(durable.context.kind, 'muse');
  assert.match(record.headless?.reason ?? '', /login|limit/i);
  await writeFile(join(homes.get(successor)!, 'release'), '');
  assert.equal((await reviewed(record.id)).verdict?.state, 'APPROVED');
});

test('e2e:headless-reviewers — a missing contract refuses that runtime and tries the next eligible account', async () => {
  await configure([{ name: 'missing', kind: 'kilo', contract: false }, { name: 'configured', kind: 'muse' }]);
  const record = await dispatch(reviewItem('GY-9460'));
  assert.equal((await reviewed(record.id)).verdict?.state, 'APPROVED');
  await assert.rejects(started('missing'), /ENOENT/);
  assert.equal(record.headless?.kind, 'muse');
  const sessions = (await registry.snapshot(hostId)).sessions;
  assert.ok(sessions.some(session => session.account === 'missing' && /headlessArgs/.test(session.endReason ?? '')));
});

test('e2e:headless-reviewers — confined request runs on the host with mount isolation and masked credentials', async () => {
  await configure([{ name: 'confined', kind: 'muse' }]);
  const namespace = await readlink('/proc/self/ns/mnt');
  const record = await dispatch(reviewItem('GY-9470'), true);
  assert.equal((await reviewed(record.id)).verdict?.state, 'APPROVED');
  const child = await started('confined');
  assert.notEqual(child.namespace, namespace);
  assert.equal(child.credential, false);
  assert.equal(child.token, null);
});


test('e2e:headless-reviewers — confinement refusal starts no model and never falls back to a pane', async () => {
  await configure([{ name: 'refused', kind: 'muse' }]);
  const work = await insert(reviewItem('GY-9471'));
  await assert.rejects(launchReview(root, work, 'reviewer', [], now(), { headless: spawnHeadless, coordinatorRoot: join(scratch, 'missing-coordinator') }), /cannot be launched|Git directory|not a git repository/i);
  await assert.rejects(started('refused'), /ENOENT/);
});

test('e2e:headless-reviewers — exhausting every account leaves the exact request pending with its diagnosis', async () => {
  await configure([{ name: 'last-login', kind: 'muse', failure: 'Not logged in' }, { name: 'last-limit', kind: 'claude', failure: "You've hit your session limit" }]);
  const work = reviewItem('GY-9480');
  const launched = await dispatch(work);
  const record = await reviewed(launched.id);
  assert.equal(record.state, 'failed');
  assert.match(record.resolution!, /limit/i);
  const pending = (await stored(work.id)).autoDispatch!.review!;
  assert.equal(pending.id, record.requestId);
  assert.equal(pending.state, 'requested');
  assert.equal(pending.sha, head); assert.equal(pending.baseSha, base);
  for (const name of ['last-login', 'last-limit']) assert.equal(await readFile(join(homes.get(name)!, 'starts'), 'utf8'), '1', 'each eligible account starts at most once');
  assert.equal((await registry.snapshot(hostId)).sessions.filter(session => !session.endedAt).length, 0);
});
