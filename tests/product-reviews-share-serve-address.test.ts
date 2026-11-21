import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import type { Principal, Work } from '../src/model.js';
import { launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { liveRun } from '../src/runner/registry.js';
import type { HeadlessExec } from '../src/headless-session.js';

// GY-3580: product reviews whose heads declare the same serve URL take turns on it; an address
// another application holds still fails the launch with the existing message.

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const servePort = 4411, serveUrl = `http://127.0.0.1:${servePort}/healthz`;
let store: Store, http: ReturnType<typeof server>, url: string;
let root: string, credentials: string, base: string, first: string, second: string;

before(async () => {
  store = await withDatabase('product-reviews-share-serve-address'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  root = await temporaryDirectory('product-reviews-share-root'); credentials = await temporaryDirectory('product-reviews-share-credentials');
  const browserBin = await temporaryDirectory('product-reviews-share-browser');
  await writeFile(join(browserBin, 'agent-browser'), '#!/bin/sh\necho browser\n', { mode: 0o755 });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (message: string) => { git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '--initial-branch=main');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'project\n');
  base = commit('base');
  git('update-ref', 'refs/remotes/origin/main', base);
  // Two heads, each served by its own command on the one address both declare.
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: { command: 'node serve-it.mjs', url: serveUrl, readySeconds: 30 } } }, null, 2));
  const serveIt = (marker: string) => `import { createServer } from 'node:http';
createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>candidate-marker: ${marker}</h1>'); }).listen(${servePort}, '127.0.0.1');
`;
  await writeFile(join(root, 'serve-it.mjs'), serveIt('first'));
  first = commit('first head');
  await writeFile(join(root, 'serve-it.mjs'), serveIt('second'));
  second = commit('second head');
  git('checkout', '-q', base);
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('product-reviews-share-checkouts'), reviewerProfile: 'product-claude' } });
  const config = await loadMasterConfig(root);
  await new AgentRegistry(store).mutate(coordinator, 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'opus', id: 'opus' }],
    accounts: [{ name: 'product-claude-account', runtime: 'claude', model: 'opus', credential: { host: config.hostId, home: null } }],
    roles: [{ name: 'reviewer', accounts: ['product-claude-account'], concurrency: 8, policy: {} }], reason: 'fixture' }, randomUUID());
  await saveReviewerProfile(root, { name: 'product-claude', agentName: 'product-claude-1', kind: 'claude', agentArgs: [], accounts: ['product-claude-account'] });
  process.env.PATH = `${browserBin}:${process.env.PATH ?? ''}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (root) await rm(root, { recursive: true, force: true });
  if (credentials) await rm(credentials, { recursive: true, force: true });
});

async function productItem(key: string, head: string): Promise<Work> {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'graphyard-claude-1' };
  const work = { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The feature works for the person using it', proofs: ['integration:product-reviews-share-serve-address'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['serve-it.mjs'], scopeFiles: [{ path: 'serve-it.mjs', status: 'modified', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } } as unknown as Work;
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  return work;
}
const run = async (command: string, args: string[], options?: { cwd?: string }) => {
  if (command === 'git' || command === 'node') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  throw new Error(`no ${command} here`);
};
const until = async (what: string, check: () => Promise<boolean> | boolean) => {
  for (let tries = 0; tries < 800; tries++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(`timed out waiting for ${what}`);
};
const answers = () => fetch(serveUrl).then(() => true, () => false);

test('integration:product-reviews-share-serve-address — two product reviews on one serve URL serve and start their sessions one after the other', async () => {
  const events: string[] = [], pages: Record<string, string> = {};
  const exec = (name: string): HeadlessExec => async () => {
    events.push(`${name} started`);
    pages[name] = await fetch(serveUrl).then(response => response.text(), () => '');
    // The session walks its head a while; the other review waits for the address meanwhile.
    await new Promise(resolve => setTimeout(resolve, 500));
    events.push(`${name} ended`);
    return `Walked it.\n{"verdict": "APPROVE", "body": "Product reviewed.", "findings": []}`;
  };
  const [one, two] = [await productItem('GY-9590', first), await productItem('GY-9591', second)];
  const launched = await Promise.all([
    launchReview(root, one, 'product-claude', [], now(), { run, headless: exec('first'), product: true }),
    launchReview(root, two, 'product-claude', [], now(), { run, headless: exec('second'), product: true }),
  ]);
  await until('both review runs to end', async () => { const ledger = await readReviewLedger(root); return launched.every(entry => ledger.reviews.some(record => record.id === entry.review && !liveRun(record.agentName) && !!record.verdict)); });
  await until('the served head to stop', async () => !(await answers()));
  assert.deepEqual(events, ['first started', 'first ended', 'second started', 'second ended'], 'the sessions ran one after the other');
  assert.match(pages.first, /candidate-marker: first/, 'the first session walked its own head');
  assert.match(pages.second, /candidate-marker: second/, 'the second session walked its own head');
});

test('a serve URL another application holds still fails the launch with the existing message', async () => {
  const other = createServer((_request, response) => { response.end('someone else'); });
  await new Promise<void>(resolve => other.listen(servePort, '127.0.0.1', resolve));
  try {
    const work = await productItem('GY-9592', first);
    await assert.rejects(launchReview(root, work, 'product-claude', [], now(), { run, headless: async () => '', product: true }),
      /already answers before the serve command starts; another application holds it/);
  } finally { await new Promise<void>(resolve => other.close(() => resolve())); }
});
