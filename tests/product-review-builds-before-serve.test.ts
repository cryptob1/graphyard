import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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

// GY-3581: a head whose dashboard is built by the repository's build step (dist/ is untracked) runs
// that build in its review checkout before the serve command, so GET / answers 200, never 500.

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const servePort = 4397;
let store: Store, http: ReturnType<typeof server>, url: string;
let root: string, credentials: string, base: string, built: string, broken: string;

before(async () => {
  store = await withDatabase('product-review-builds-before-serve'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  root = await temporaryDirectory('product-review-build-root'); credentials = await temporaryDirectory('product-review-build-credentials');
  const browserBin = await temporaryDirectory('product-review-build-browser');
  await writeFile(join(browserBin, 'agent-browser'), '#!/bin/sh\necho browser\n', { mode: 0o755 });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (message: string) => { git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '--initial-branch=main');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  // The build's output is untracked, as the repository's dist/ is.
  await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'project', version: '1.0.0', scripts: { build: 'node build.mjs' } }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'project', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'project', version: '1.0.0' } } }));
  // The served app answers its dashboard from dist/, and 500 when dist/ was never built.
  await writeFile(join(root, 'serve-it.mjs'), `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
createServer((request, response) => {
  if (request.url?.startsWith('/healthz')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true })); return; }
  try { const page = readFileSync('dist/index.html', 'utf8'); response.writeHead(200, { 'content-type': 'text/html' }); response.end(page); }
  catch { response.writeHead(500); response.end('dist/index.html is missing'); }
}).listen(${servePort}, '127.0.0.1');
`);
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: { command: 'node serve-it.mjs', url: `http://127.0.0.1:${servePort}/healthz`, readySeconds: 30 } } }, null, 2));
  await writeFile(join(root, 'build.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<h1>dashboard-marker: built</h1>');
`);
  base = commit('base');
  git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'build.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<h1>dashboard-marker: built by the head</h1>');
`);
  built = commit('a UI change');
  await writeFile(join(root, 'build.mjs'), `console.error('build-marker: the dashboard does not compile'); process.exit(1);\n`);
  broken = commit('a broken build');
  git('checkout', '-q', base);
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  // The repository's install is current (nothing to install); the managed checkouts live outside it.
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('product-review-build-checkouts'), reviewerProfile: 'product-claude' } });
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

function productItem(key: string, head: string): Work {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The dashboard answers', proofs: ['integration:product-review-builds-before-serve'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['build.mjs'], scopeFiles: [{ path: 'build.mjs', status: 'modified', sha: head, additions: 1, deletions: 1, binary: false }], baseTip: base, baseTipContained: true } } as unknown as Work;
}
// The launch's commands run as themselves: git, and the repository's build.
const run = async (command: string, args: string[], options?: { cwd?: string }) => {
  if (command === 'git' || command === 'node') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  if (command === 'npm' && args[0] === 'run') return await promisify(execFile)('npm', args, { cwd: options!.cwd, encoding: 'utf8' }).then(result => result.stdout);
  throw new Error(`no ${command} ${args.join(' ')} here`);
};
const until = async (what: string, check: () => Promise<boolean> | boolean) => {
  for (let tries = 0; tries < 400; tries++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(`timed out waiting for ${what}`);
};

test('integration:product-review-builds-before-serve — a head whose dashboard the build step makes is built before it is served, and GET / answers 200', async () => {
  const work = productItem('GY-9590', built);
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  let status = 0, page = '', sessions = 0;
  const exec: HeadlessExec = async () => {
    sessions += 1;
    ({ status, page } = await fetch(`http://127.0.0.1:${servePort}/`).then(async response => ({ status: response.status, page: await response.text() }), () => ({ status: 0, page: '' })));
    return `Walked it.\n{"verdict": "APPROVE", "body": "Product reviewed head ${built} against base ${base}.", "findings": []}`;
  };
  const launched = await launchReview(root, work, 'product-claude', [], now(), { run, headless: exec, product: true });
  await until('the review run to end', async () => (await readReviewLedger(root)).reviews.some(record => record.id === launched.review && !liveRun(record.agentName) && !!record.verdict));
  await until('the served head to stop', async () => !(await fetch(`http://127.0.0.1:${servePort}/healthz`).then(() => true, () => false)));
  assert.equal(sessions, 1, 'the reviewer session started');
  assert.equal(status, 200, `GET / answered ${status}: ${page}`);
  assert.match(page, /dashboard-marker: built by the head/, 'the served dashboard is the head\'s own build');
});

test('a failing build ends the launch naming its output tail', async () => {
  const work = productItem('GY-9591', broken);
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  await assert.rejects(launchReview(root, work, 'product-claude', [], now(), { run, headless: async () => '', product: true }),
    /npm run build failed in the review checkout of [0-9a-f]{12}: [^]*build-marker: the dashboard does not compile/);
});
