import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import type { Principal, Work } from '../src/model.js';
import { readReviewLedger, reviewCommand, saveReviewerProfile } from '../src/reviewer.js';
import { reviewLaunchAttention } from '../src/cli/master-status.js';
import { liveRun } from '../src/runner/registry.js';
import { spawnHeadless } from '../src/headless-session.js';
import { headlessInventory } from '../src/session-inventory.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { dispatchEffects } from '../src/dispatch/effects.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * GY-3421: a sensitive delta (a dependency manifest) implemented on a claude account owes one
 * independent review. The loop's one reviewer selection serves it like any other review: within
 * one dispatch tick a logged-in cursor reviewer launches and posts a verdict. With no eligible
 * reviewer, master status names the item, the reason and the remedy.
 */
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
let store: Store, http: ReturnType<typeof server>, registry: AgentRegistry;
let root: string, scratch: string, bin: string, base: string, head: string, url: string, hostId: string;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

before(async () => {
  store = await withDatabase('sensitive-review-executor'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  scratch = await temporaryDirectory('sensitive-review', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  bin = await temporaryDirectory('bin', scratch);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'go.mod'), 'module example.com/lumina\n\ngo 1.22\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'go.mod'), 'module example.com/lumina\n\ngo 1.22\n\nrequire example.com/dep v1.2.3\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'head');
  head = git('rev-parse', 'HEAD'); git('checkout', '-q', base);
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: await temporaryDirectory('credentials', scratch), herdrWorkspace: 'w', run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  hostId = (await loadMasterConfig(root)).hostId;
  registry = new AgentRegistry(store);
  // As `master environments --apply` writes them: one reviewer profile per runtime kind.
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'graphyard-claude-reviewer', kind: 'claude', agentArgs: [] });
  await saveReviewerProfile(root, { name: 'cursor-reviewer', agentName: 'graphyard-cursor-reviewer', kind: 'cursor', agentArgs: [] });
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
});

const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
function sensitiveItem(key: string): Work {
  const candidate = { sha: head, baseSha: base, pr: 14, branch: 'graphyard/gy-14-1', author: 'graphyard-claude-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The dependency is pinned', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
    lastAssignment: { owner: 'graphyard-claude-1', epoch: 1, runtime: 'claude' },
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 14 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'],
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['go.mod'], scopeFiles: [{ path: 'go.mod', status: 'modified', sha: head, additions: 2, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } } as unknown as Work;
}

/** claude-a and cursor-a, both logged in; each runtime's executable records that it ran and answers APPROVE. */
async function configure(loggedIn: { claude: boolean; cursor: boolean }) {
  const entries = [{ name: 'claude-a', kind: 'claude' }, { name: 'cursor-a', kind: 'cursor' }];
  const runtimes = [], accounts = [];
  for (const entry of entries) {
    const home = await temporaryDirectory(entry.name, scratch);
    if (loggedIn[entry.kind as 'claude' | 'cursor']) {
      await writeFile(join(home, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-key' } }));
      await writeFile(join(home, 'cli-config.json'), JSON.stringify({ authInfo: { userId: entry.name } }));
      await mkdir(join(home, 'cursor'));
      await writeFile(join(home, 'cursor', 'auth.json'), JSON.stringify({ accessToken: 'fixture-sign-in' }));
    }
    const executable = entry.kind === 'cursor' ? 'cursor-agent' : entry.kind;
    await writeFile(join(bin, executable), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.RUNTIME_HOME + '/starts', '1');
console.log(JSON.stringify({ verdict: 'APPROVE', body: 'Reviewed head ${head} against base ${base}. AC-1 met.', findings: [] }));
`, { mode: 0o755 });
    runtimes.push({ name: entry.kind, launch: { kind: entry.kind, args: [], headlessArgs: ['one-task', '--prompt', '{request}'],
      environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, homeVariable: 'RUNTIME_HOME', modelFlag: '--model' } });
    accounts.push({ enabled: true, maxSessions: null, name: entry.name, runtime: entry.kind, model: 'fixture', credential: { host: hostId, home } });
  }
  await registry.mutate(coordinator, 'apply', { runtimes, accounts, models: [{ name: 'fixture', id: 'fixture-model' }],
    roles: [{ name: 'reviewer', accounts: ['claude-a', 'cursor-a'], concurrency: 4 }], reason: 'lumina reviewer rotation' }, randomUUID());
  await registry.observe(coordinator, { host: hostId, observations: [
    { account: 'claude-a', quota: { loggedIn: loggedIn.claude, state: 'available' } },
    { account: 'cursor-a', quota: { loggedIn: loggedIn.cursor, state: 'available' } }] }, randomUUID());
}

async function tick(work: Work) {
  const config = await loadMasterConfig(root);
  const mutate = async (path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${coordinatorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const run = (command: string, args: string[], options?: { cwd?: string }) => execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  const effects = dispatchEffects(root, config, { snapshot: async () => ({ work: [await stored(work.id)], now: now() }), mutate, run, headless: spawnHeadless });
  effects.inventory = async () => headlessInventory();
  const cursor = emptyDispatchCursor(config);
  return { result: await runDispatchTick(config, cursor, effects), cursor };
}

async function insert(work: Work) {
  const request = { id: randomUUID(), kind: 'review' as const, provider: 'github' as const, reason: 'independent approval of the current commit is required: the merge delta is sensitive (go.mod: dependencies)', pr: 14, sha: head, baseSha: base, policyRevision: 1, state: 'requested' as const, requestedAt: now(), requestedBy: 'graphyard', attempts: 0 };
  work.autoDispatch = { review: request, producers: [], history: [] };
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  return work;
}

async function settled(key: string) {
  for (let tries = 0; tries < 400; tries++) {
    const record = (await readReviewLedger(root)).reviews.findLast(entry => entry.key === key);
    if (record && !liveRun(record.agentName) && (record.verdict || record.state !== 'pending')) return record;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`the review of ${key} did not settle`);
}
const reviewerAccount = async (key: string) => (await registry.snapshot(hostId)).sessions.filter(session => session.role === 'reviewer' && session.work === key).at(-1)?.account;

test('integration:sensitive-review-executor — a sensitive claude-implemented head launches a cursor reviewer within one tick', async () => {
  await configure({ claude: true, cursor: true });
  const work = await insert(sensitiveItem('GY-14'));
  const { result } = await tick(work);
  assert.equal(result.launched.length, 1, JSON.stringify(result));
  assert.equal(await reviewerAccount(work.key), 'cursor-a', 'the reviewer runs on a provider other than the implementer\'s claude');
  const record = await settled(work.key);
  assert.equal(record.verdict?.state, 'APPROVED', record.resolution);
  assert.equal((await stored(work.id)).reviewLaunch?.verdict?.state, 'APPROVED', 'the control plane recorded the verdict');
});

test('integration:sensitive-review-executor — with no eligible reviewer master status names the item, the reason and the remedy; master review relaunches it', async () => {
  await configure({ claude: false, cursor: false });
  const work = await insert(sensitiveItem('GY-15'));
  const { result, cursor } = await tick(work);
  assert.equal(result.launched.length, 0, JSON.stringify(result));
  const [line, ...rest] = reviewLaunchAttention([await stored(work.id)], cursor, Date.now());
  assert.equal(rest.length, 0);
  assert.equal(line?.subject, 'GY-15', JSON.stringify(result));
  assert.match(line.text, /GY-15's review of [0-9a-f]{12} has no reviewer: .*(claude-a|cursor-a)/);
  assert.match(line.next, /log it in.*master registry role set reviewer.*graphyard master review GY-15/);

  // The account logs in: master review GY-15 launches the request on the independent provider.
  await configure({ claude: true, cursor: true });
  const snapshot = { work: [await stored(work.id)], now: now() };
  await reviewCommand(root, ['GY-15'], snapshot, [], { headless: spawnHeadless });
  assert.equal(await reviewerAccount(work.key), 'cursor-a');
  assert.equal((await settled(work.key)).verdict?.state, 'APPROVED');
});
