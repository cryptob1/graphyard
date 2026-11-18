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
import { loggedOutAttention } from '../src/cli/master-status.js';
import { Store } from '../src/store.js';

// GY-3441: a reviewer account whose sessions fail on missing credentials is used once, then skipped,
// though it is on another provider than the implementer. Real child processes: a stub `muse` that
// exits 1 with muse's missing-credentials error, as muse does with no auth.json, and a stub `claude`
// that answers.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const reviewer = 'review-mixed-1';
const now = () => new Date().toISOString();
let store: Store, http: ReturnType<typeof server>, registry: AgentRegistry, hostId: string;
let root: string, scratch: string, base: string, head: string, working: string, previousPath: string | undefined;

before(async () => {
  store = await withDatabase('review-skips-broken'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  root = await temporaryDirectory('review-skips-root'); scratch = await temporaryDirectory('review-skips-scratch');
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
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: join(scratch, 'credentials'), herdrWorkspace: 'w', run: { worktreeRoot: await temporaryDirectory('review-skips-checkouts', join(process.cwd(), '.graphyard')) } });
  hostId = (await loadMasterConfig(root)).hostId;
  working = join(scratch, 'claude-home');
  await mkdir(working); await writeFile(join(working, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'stub' } }));
  const bin = join(scratch, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'muse'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
if (!process.argv.includes('Reply with the single word OK.')) appendFileSync(${JSON.stringify(join(scratch, 'muse-runs'))}, 'run\\n');
console.error('missing meta credentials: run \`muse login\` or set META_API_KEY, or save credentials at ' + process.env.HOME + '/.config/muse/auth.json');
process.exit(1);
`, { mode: 0o755 });
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(join(scratch, 'answered'))}, (process.env.CLAUDE_CONFIG_DIR ?? '') + '\\n');
console.log('{"verdict": "APPROVE", "body": "Reviewed head ${head} against base ${base}. AC-1 met: feature.ts sets the flag.", "findings": []}');
`, { mode: 0o755 });
  previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath}`;
  registry = new AgentRegistry(store);
  await registry.mutate(coordinator, 'apply', { runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude' || runtime.name === 'muse'),
    models: [{ name: 'opus', id: 'opus' }, { name: 'meta', id: 'meta-default' }],
    accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: hostId, home: working } }, { name: 'muse', runtime: 'muse', model: 'meta', credential: { host: hostId, home: null } }],
    roles: [{ name: 'reviewer', accounts: ['claude-a', 'muse'], concurrency: 4, policy: { args: ['--setting-sources', 'user'] } }], reason: 'a claude and a muse reviewer, muse without credentials' }, randomUUID());
  await saveReviewerProfile(root, { name: 'reviewer-mixed', agentName: reviewer, kind: 'claude', agentArgs: ['--setting-sources', 'user'] });
});
after(async () => {
  process.env.PATH = previousPath;
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  for (const directory of [root, scratch]) if (directory) await rm(directory, { recursive: true, force: true });
});

const insert = async (work: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]); return work; };
function reviewItem(key: string): Work {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The flag reads held', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    lastAssignment: { runtime: 'claude' }, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'],
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['feature.ts'], scopeFiles: [{ path: 'feature.ts', status: 'added', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } } as unknown as Work;
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

const museRuns = async () => (await readFile(join(scratch, 'muse-runs'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

test('e2e:review-skips-broken-account — a reviewer account whose sessions fail on missing credentials is used once, then skipped, the review completes on another account, and master status names the held account and reason', async () => {
  // The implementer ran on claude, so muse, on another provider, is chosen first; its session fails on missing credentials.
  const first = await insert(reviewItem('GY-9401'));
  const check = await launchReview(root, first, 'reviewer-mixed', [], now(), { run, headless: spawnHeadless, requestId: 'broken-request-0' });
  assert.equal((await reviewed(check.review)).verdict?.state, 'APPROVED', 'the review completed on another account');
  assert.equal(await museRuns(), 1, 'muse ran once');
  assert.deepEqual(await answered(), [working], 'claude-a answered');
  const held = await account('muse');
  assert.equal(held.eligible, false);
  assert.match(held.ineligible!, /^muse is not logged in: .*missing meta credentials: run `muse login`/);

  // The next review skips muse entirely.
  const second = await insert(reviewItem('GY-9402'));
  const next = await launchReview(root, second, 'reviewer-mixed', [], now(), { run, headless: spawnHeadless, requestId: 'broken-request-1' });
  assert.equal((await reviewed(next.review)).verdict?.state, 'APPROVED');
  assert.equal(await museRuns(), 1, 'muse is not picked again');
  assert.deepEqual(await answered(), [working, working]);

  // master status names the held account and why.
  const attention = loggedOutAttention(await registry.snapshot(hostId));
  assert.equal(attention.length, 1, JSON.stringify(attention));
  assert.equal(attention[0]!.subject, 'account muse');
  assert.match(attention[0]!.text, /muse is not logged in: .*missing meta credentials.* — skipped for reviewer$/);
});
