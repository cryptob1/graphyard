import { after, before } from 'node:test';
import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { spawnHeadless } from '../src/headless-session.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { liveRun } from '../src/runner/registry.js';
import { server } from '../src/server.js';
import { launchSpecCheck } from '../src/spec-check.js';
import { Store } from '../src/store.js';

// GY-3218: an account whose agent reports it is not logged in is held, and the launch moves to
// another account. The agent here is a real child process: a stub `claude` binary that exits 1 with
// Claude Code's not-logged-in message on one account's home and answers on the other's.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const reviewer = 'review-claude-1', message = 'Not logged in · Please run /login';
const now = () => new Date().toISOString();
let store: Store, http: ReturnType<typeof server>, registry: AgentRegistry, hostId: string;
let root: string, scratch: string, base: string, head: string, lapsed: string, working: string, previousPath: string | undefined;

before(async () => {
  store = await withDatabase('unauthenticated-account'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  root = await temporaryDirectory('unauthenticated-root'); scratch = await temporaryDirectory('unauthenticated-scratch');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Named spec file.\n');
  git('add', 'README.md'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'feature.ts'), 'export const flag = "held";\n');
  git('add', 'feature.ts'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'head');
  head = git('rev-parse', 'HEAD');
  git('checkout', '-q', base);
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: join(scratch, 'credentials'), herdrWorkspace: 'w', run: { worktreeRoot: await temporaryDirectory('unauthenticated-checkouts', join(process.cwd(), '.graphyard')) } });
  hostId = (await loadMasterConfig(root)).hostId;
  // Both homes hold what the login probe reads as a login; only the agent knows the first has lapsed.
  lapsed = join(scratch, 'lapsed-home'); working = join(scratch, 'working-home');
  for (const home of [lapsed, working]) { await mkdir(home); await writeFile(join(home, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'stub' } })); }
  await writeFile(join(lapsed, 'lapsed'), '');
  // The stub agent: on a lapsed home it prints the message and exits 1; elsewhere it records the home it ran on and answers its request.
  const bin = join(scratch, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
const { appendFileSync, existsSync } = require('node:fs');
const home = process.env.CLAUDE_CONFIG_DIR ?? '';
if (existsSync(home + '/lapsed')) { console.error(${JSON.stringify(message)}); process.exit(1); }
appendFileSync(${JSON.stringify(join(scratch, 'answered'))}, home + '\\n');
console.log(process.argv.at(-1).includes('Graphyard spec checker')
  ? '{"verdict": "ready", "paraphrase": "Move export to settings; AC-1 proves it.", "gaps": []}'
  : '{"verdict": "APPROVE", "body": "Reviewed head ${head} against base ${base}. AC-1 met: feature.ts sets the flag.", "findings": []}');
`, { mode: 0o755 });
  previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath}`;
  registry = new AgentRegistry(store);
  await registry.mutate(coordinator, 'apply', { runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'opus', id: 'opus' }],
    accounts: [{ name: 'lapsed-account', runtime: 'claude', model: 'opus', credential: { host: hostId, home: lapsed } }, { name: 'working-account', runtime: 'claude', model: 'opus', credential: { host: hostId, home: working } }],
    roles: [{ name: 'reviewer', accounts: ['lapsed-account', 'working-account'], concurrency: 4, policy: { args: ['--setting-sources', 'user'] } }], reason: 'two reviewer accounts, the first lapsed' }, randomUUID());
  await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: reviewer, kind: 'claude', agentArgs: ['--setting-sources', 'user'] });
});
after(async () => {
  process.env.PATH = previousPath;
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  for (const directory of [root, scratch]) if (directory) await rm(directory, { recursive: true, force: true });
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
      files: ['feature.ts'], scopeFiles: [{ path: 'feature.ts', status: 'added', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } } as unknown as Work;
}
function specItem(key: string): Work {
  return { id: randomUUID(), key, title: 'Export from settings', description: 'Read README.md and move export to settings.', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Export works', proofs: ['e2e:export'] }], policy: { checks: ['test'], review: true },
    stage: 'ready', revision: 1, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 0, lease: null,
    workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [] } as unknown as Work;
}
/** git really runs; Herdr is a refusal, so a pane would fail the launch. */
const run = (command: string, args: string[], options?: { cwd?: string }) => {
  if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  throw new Error(`no ${command} here: a headless launch opens no pane`);
};
const answered = async () => (await readFile(join(scratch, 'answered'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
const account = async (name: string) => (await registry.snapshot(hostId)).accounts.find(entry => entry.name === name)!;
const reviewed = async (id: string) => {
  for (let tries = 0; tries < 400; tries++) {
    const record = (await readReviewLedger(root)).reviews.find(entry => entry.id === id);
    if (record && !liveRun(record.agentName) && (record.verdict || record.state !== 'pending')) return record;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return assert.fail('timed out waiting for the review run to end');
};

test('e2e:unauthenticated-account-held — a spec check and a review whose agent exits not logged in hold that account under its message, answer on the next account in the same launch, and stay off the held one until it is cleared', async () => {
  // The spec check starts on the role's first account, whose agent exits 1 not logged in.
  const spec = await insert(specItem('GY-9301'));
  const check = await launchSpecCheck(root, spec, 'reviewer-claude', [], now(), { run, headless: spawnHeadless });
  assert.equal(await check.settled, null, 'the same launch posted its report from the next account');
  assert.equal((await stored(spec.id)).specCheck!.verdict, 'ready');
  assert.deepEqual(await answered(), [working], 'the answer came from the working account');
  const held = await account('lapsed-account');
  assert.equal(held.eligible, false);
  assert.match(held.ineligible!, /^lapsed-account is not logged in: its agent reported "Not logged in · Please run \/login"; held until cleared with master registry account quota lapsed-account available$/);

  // A review launch, like every later selection, never starts on the held account: the probe still reads its login file as a login.
  const first = await insert(reviewItem('GY-9302'));
  const launched = await launchReview(root, first, 'reviewer-claude', [], now(), { run, headless: spawnHeadless, requestId: 'held-request-1' });
  assert.equal((await reviewed(launched.review)).verdict?.state, 'APPROVED');
  assert.deepEqual(await answered(), [working, working]);
  assert.equal((await account('lapsed-account')).eligible, false, 'no probe lifts the hold');

  // Cleared by the operator's quota mark while the login is still lapsed: the review that starts on it holds it again and is answered on the next account.
  await registry.mutate(coordinator, 'account.quota', { name: 'lapsed-account', quota: { state: 'available' }, reason: 'logged in again' }, randomUUID());
  assert.equal((await account('lapsed-account')).eligible, true, 'master registry account quota NAME available clears it');
  const second = await insert(reviewItem('GY-9303'));
  const moved = await launchReview(root, second, 'reviewer-claude', [], now(), { run, headless: spawnHeadless, requestId: 'held-request-2' });
  const record = await reviewed(moved.review);
  assert.equal(record.verdict?.state, 'APPROVED', 'the review moved to the next account and posted its verdict');
  assert.equal(record.verdict?.reviewer, reviewer);
  assert.deepEqual(await answered(), [working, working, working]);
  assert.match((await account('lapsed-account')).ineligible!, /is not logged in: its agent reported "Not logged in · Please run \/login"/);

  // Cleared with the login restored, the account takes sessions again.
  await rm(join(lapsed, 'lapsed'));
  await registry.mutate(coordinator, 'account.quota', { name: 'lapsed-account', quota: { state: 'available' }, reason: 'logged in again' }, randomUUID());
  const third = await insert(reviewItem('GY-9304'));
  const back = await launchReview(root, third, 'reviewer-claude', [], now(), { run, headless: spawnHeadless, requestId: 'held-request-3' });
  assert.equal((await reviewed(back.review)).verdict?.state, 'APPROVED');
  assert.deepEqual(await answered(), [working, working, working, lapsed]);
});
