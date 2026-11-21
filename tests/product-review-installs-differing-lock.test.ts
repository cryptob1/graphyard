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
import { npmCiEnvironment } from '../src/cli/test-isolation.js';
import type { HeadlessExec } from '../src/headless-session.js';

// GY-3579: a head whose package-lock.json differs from the repository checkout's cannot share that
// install, so the review installs the head's own dependencies in its checkout before serving it.

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const servePort = 4396;
let store: Store, http: ReturnType<typeof server>, url: string;
let root: string, credentials: string, base: string, matching: string, differing: string, broken: string;

before(async () => {
  store = await withDatabase('product-review-installs-differing-lock'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  root = await temporaryDirectory('product-review-differing-lock-root'); credentials = await temporaryDirectory('product-review-differing-lock-credentials');
  const browserBin = await temporaryDirectory('product-review-differing-lock-browser');
  await writeFile(join(browserBin, 'agent-browser'), '#!/bin/sh\necho browser\n', { mode: 0o755 });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (message: string) => { git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '--initial-branch=main');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  // The repository declares one dependency; its install lives at the repository root, untracked.
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'project', version: '1.0.0', dependencies: { greeting: '1.0.0' } }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'project', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'project', version: '1.0.0', dependencies: { greeting: '1.0.0' } }, 'node_modules/greeting': { version: '1.0.0' } } }));
  base = commit('base');
  git('update-ref', 'refs/remotes/origin/main', base);
  await mkdir(join(root, 'node_modules', 'greeting'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'greeting', 'package.json'), JSON.stringify({ name: 'greeting', version: '1.0.0', type: 'module', exports: './index.js' }));
  await writeFile(join(root, 'node_modules', 'greeting', 'index.js'), 'export const greeting = "hello from the dependency";\n');
  // Three candidates, each served by a command that imports one dependency.
  const serveIt = (name: string) => `import { createServer } from 'node:http';
import { ${name} } from '${name}';
createServer((request, response) => {
  if (request.url?.startsWith('/healthz')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true })); return; }
  response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>candidate-marker: ' + ${name} + '</h1>');
}).listen(${servePort}, '127.0.0.1');
`;
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: { command: 'node serve-it.mjs', url: `http://127.0.0.1:${servePort}/healthz`, readySeconds: 30 } } }, null, 2));
  // The lockfile the repository's install answers for: shared, never installed.
  await writeFile(join(root, 'serve-it.mjs'), serveIt('greeting'));
  matching = commit('matching lockfile');
  // A changed lockfile: the dependency lives in the head and only `npm ci` links it.
  await mkdir(join(root, 'vendor', 'farewell'), { recursive: true });
  await writeFile(join(root, 'vendor', 'farewell', 'package.json'), JSON.stringify({ name: 'farewell', version: '1.0.0', type: 'module', exports: './index.js' }));
  await writeFile(join(root, 'vendor', 'farewell', 'index.js'), 'export const farewell = "goodbye from the installed dependency";\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'project', version: '1.0.0', dependencies: { farewell: 'file:vendor/farewell' } }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'project', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'project', version: '1.0.0', dependencies: { farewell: 'file:vendor/farewell' } }, 'node_modules/farewell': { resolved: 'vendor/farewell', link: true }, 'vendor/farewell': { version: '1.0.0' } } }));
  await writeFile(join(root, 'serve-it.mjs'), serveIt('farewell'));
  differing = commit('differing lockfile');
  // A lockfile its own package.json has outgrown: the install refuses it.
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'project', version: '1.0.0', dependencies: { farewell: 'file:vendor/farewell', absent: 'file:vendor/absent' } }));
  broken = commit('broken lockfile');
  git('checkout', '-q', base);
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  // The managed checkouts live outside the repository, so no upward lookup reaches its install.
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('product-review-differing-lock-checkouts'), reviewerProfile: 'product-claude' } });
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
    criteria: [{ id: 'AC-1', text: 'The feature works for the person using it', proofs: ['integration:product-review-installs-differing-lock'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['serve-it.mjs'], scopeFiles: [{ path: 'serve-it.mjs', status: 'added', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } } as unknown as Work;
}
// The install is the launch's real `npm ci`, run here without its bubblewrap containment (a test host may refuse namespaces).
const installs: string[] = [];
const run = async (command: string, args: string[], options?: { cwd?: string }) => {
  if (command === 'git' || command === 'node') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  const npm = args.indexOf('npm');
  if (npm < 0 || args[npm + 1] !== 'ci') throw new Error(`no ${command} here`);
  installs.push(options!.cwd!);
  return await promisify(execFile)('npm', args.slice(npm + 1), { cwd: options!.cwd, env: npmCiEnvironment(), encoding: 'utf8' }).then(result => result.stdout);
};
const until = async (what: string, check: () => Promise<boolean> | boolean) => {
  for (let tries = 0; tries < 400; tries++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(`timed out waiting for ${what}`);
};
/** One product review of `head`: the page its served command answered the reviewer session with, and how many installs ran. */
async function review(key: string, head: string) {
  const work = productItem(key, head);
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  let page = '', sessions = 0;
  const before = installs.length;
  const exec: HeadlessExec = async () => {
    sessions += 1;
    page = await fetch(`http://127.0.0.1:${servePort}/`).then(response => response.text(), () => '');
    return `Walked it.\n{"verdict": "APPROVE", "body": "Product reviewed head ${head} against base ${base}.", "findings": []}`;
  };
  const launched = await launchReview(root, work, 'product-claude', [], now(), { run, headless: exec, product: true });
  await until('the review run to end', async () => (await readReviewLedger(root)).reviews.some(record => record.id === launched.review && !liveRun(record.agentName) && !!record.verdict));
  await until('the served head to stop', async () => !(await fetch(`http://127.0.0.1:${servePort}/healthz`).then(() => true, () => false)));
  return { page, sessions, installed: installs.length - before };
}

test('integration:product-review-installs-differing-lock — a head whose lockfile differs installs its own dependencies, then serves and reaches the reviewer', async () => {
  const served = await review('GY-9579', differing);
  assert.equal(served.installed, 1, 'the head installed its own dependencies, once');
  assert.equal(served.sessions, 1, 'the reviewer session started');
  assert.match(served.page, /candidate-marker: goodbye from the installed dependency/, 'the served candidate resolved the dependency its own lockfile names');
});

test('a head whose lockfile matches the repository install shares it and installs nothing', async () => {
  const served = await review('GY-9580', matching);
  assert.equal(served.installed, 0);
  assert.match(served.page, /candidate-marker: hello from the dependency/);
});

test('a failing install names its output tail in the launch outcome', async () => {
  const work = productItem('GY-9581', broken);
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  await assert.rejects(launchReview(root, work, 'product-claude', [], now(), { run, headless: async () => '', product: true }),
    /npm ci .* failed in the review checkout of [0-9a-f]{12}: [^]*npm error/);
});
