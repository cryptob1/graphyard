import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
import { launchReview, readReviewLedger } from '../src/reviewer.js';
import { saveReviewerProfile } from '../src/reviewer.js';
import { productReviewNeed } from '../src/model-boundary/dispatch.js';
import { productReviewRefusal } from '../src/model-boundary/product-review.js';
import { standingVerdict } from '../src/daemon/rework.js';
import { headlessInventory } from '../src/session-inventory.js';
import { liveRun } from '../src/runner/registry.js';
import type { HeadlessExec } from '../src/headless-session.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { dispatchEffects } from '../src/dispatch/effects.js';
import { reconcileAutoDispatch } from '../src/model-boundary/dispatch.js';
import { masterStatusReport } from '../src/cli/master-status.js';

// GY-3331: a product reviewer that cannot reach the app records could not run — never changes
// requested. The launch hands the session the connection a worker's gets plus a browser tool; a
// preflight that finds one missing starts no reviewer and records the could-not-run review naming
// it; a COULD_NOT_RUN answer keeps the item in review on the same head with no rework while
// another eligible reviewer is tried and master status raises one attention line; an install that
// serves nothing hands the reviewer the head served by its own e2e.serve command, and one that can
// serve nothing at all owes no walkthrough.

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const servePort = 4397;
let store: Store, http: ReturnType<typeof server>, url: string;
let root: string, credentials: string, browserBin: string, toolPath: string;
let base: string, headA: string, headB: string;

before(async () => {
  store = await withDatabase('product-review-environment'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  // A master over a real repository: a base, a head with no app to serve, and one whose own
  // graphyard.json declares the e2e.serve command that serves it.
  root = await temporaryDirectory('product-review-environment-root'); credentials = await temporaryDirectory('product-review-environment-credentials');
  browserBin = await temporaryDirectory('product-review-environment-browser');
  toolPath = join(browserBin, 'agent-browser');
  await writeFile(toolPath, '#!/bin/sh\necho browser\n', { mode: 0o755 });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '--initial-branch=main');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Named spec file.\n');
  await writeFile(join(root, 'feature-a.ts'), 'export const flag = "no-app-marker";\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  // Head A: nothing served and nothing declared — no walkthrough is owed.
  await writeFile(join(root, 'feature-a-head.ts'), 'export const a = 1;\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'head A');
  headA = git('rev-parse', 'HEAD');
  // Head B: the install's own e2e.serve command, serving this exact head on a fixed port.
  await writeFile(join(root, 'serve-it.mjs'), `import { createServer } from 'node:http';
createServer((request, response) => {
  if (request.url?.startsWith('/healthz')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true })); return; }
  response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html><body><h1>Feature B served</h1></body></html>');
}).listen(${servePort}, '127.0.0.1');
`);
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: { command: 'node serve-it.mjs', url: `http://127.0.0.1:${servePort}/healthz`, readySeconds: 30 } } }, null, 2));
  await writeFile(join(root, 'feature-b.ts'), 'export const b = 2;\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'head B');
  headB = git('rev-parse', 'HEAD');
  git('checkout', '-q', base);
  // A fresh checkout (the private trial's) has no .graphyard directory yet.
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('product-review-environment-checkouts', join(process.cwd(), '.graphyard')), reviewerProfile: 'product-claude' } });
  const config = await loadMasterConfig(root);
  const registry = new AgentRegistry(store);
  await registry.mutate(coordinator, 'apply', {
    runtimes: proposedRuntimes.filter(runtime => ['claude', 'codex'].includes(runtime.name)),
    models: [{ name: 'opus', id: 'opus' }],
    accounts: [
      { name: 'product-claude-account', runtime: 'claude', model: 'opus', credential: { host: config.hostId, home: null } },
      { name: 'product-codex-account', runtime: 'codex', model: 'opus', credential: { host: config.hostId, home: null } },
    ],
    roles: [{ name: 'reviewer', accounts: ['product-claude-account', 'product-codex-account'], concurrency: 8, policy: {} }], reason: 'product review environment fixture' }, randomUUID());
  await saveReviewerProfile(root, { name: 'product-claude', agentName: 'product-claude-1', kind: 'claude', agentArgs: [], accounts: ['product-claude-account'] });
  await saveReviewerProfile(root, { name: 'product-codex', agentName: 'product-codex-1', kind: 'codex', agentArgs: [], accounts: ['product-codex-account'] });
  // The browser tool every product review walks with, on this process's PATH: the launch's own
  // preflight resolves it there, the same way the host's would.
  process.env.PATH = `${browserBin}:${process.env.PATH ?? ''}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (root) await rm(root, { recursive: true, force: true });
  if (credentials) await rm(credentials, { recursive: true, force: true });
});

const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
const insert = async (work: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]); return work; };
function productItem(key: string, head: string): Work {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The feature works for the person using it', proofs: ['e2e:product-review-environment'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['feature-a-head.ts'], scopeFiles: [{ path: 'feature-a-head.ts', status: 'added', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } } as unknown as Work;
}
/** Every child command this launcher ran: git really runs; nothing else may. */
const run = (command: string, args: string[], options?: { cwd?: string }) => {
  if (command === 'git' || command === 'node') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  throw new Error(`no ${command} here`);
};
/** A stub runtime: it records what it was started with and answers the given JSON. */
function runtime(answer: string | ((run: { args: string[]; env: Record<string, string> }) => Promise<string>), gate?: Promise<void>) {
  const runs: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
  const exec: HeadlessExec = async (command, args, options) => {
    runs.push({ command, args, cwd: options.cwd, env: options.env });
    await gate;
    return typeof answer === 'function' ? await answer(runs.at(-1)!) : answer;
  };
  return { exec, runs };
}
const approve = (head: string) => `Judged it.\n{"verdict": "APPROVE", "body": "Product reviewed head ${head} against base ${base}. AC-1 met.", "findings": []}`;
const couldNotRun = 'I could not walk a served app: the app at its recorded address did not answer, so no browser session could reach it.';
const until = async (what: string, check: () => Promise<boolean> | boolean) => {
  for (let tries = 0; tries < 400; tries++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(`timed out waiting for ${what}`);
};
const settledRecord = async (id: string) => {
  await until('the review run to end', async () => (await readReviewLedger(root)).reviews.some(record => record.id === id && !liveRun(record.agentName) && (record.verdict || record.state !== 'pending')));
  return (await readReviewLedger(root)).reviews.find(record => record.id === id)!;
};

test('e2e:product-review-environment — the product-review session receives GRAPHYARD_URL, the CLI path and a browser tool on PATH, on codex and on claude', async () => {
  for (const [profile, kind, command] of [['product-claude', 'claude', 'claude'], ['product-codex', 'codex', 'codex']] as const) {
    const work = await insert(productItem(`GY-${kind === 'claude' ? 9501 : 9502}`, headA));
    const fake = runtime(approve(headA));
    const launched = await launchReview(root, work, profile, [], now(), { run, headless: fake.exec, product: true, probe: { exclude: [kind === 'claude' ? 'product-codex-account' : 'product-claude-account'] } });
    await until('the run to start', () => fake.runs.length === 1);
    const [child] = fake.runs;
    assert.equal(child!.command, command, `${kind} launches its own runtime program`);
    assert.equal(child!.env.GRAPHYARD_URL, url, `${kind} session reaches the control plane its prompt names`);
    assert.equal(child!.env.GRAPHYARD_CLI, launcher, `${kind} session holds the CLI path, as a worker's session does`);
    assert.ok(child!.env.PATH!.split(':').includes(browserBin), `${kind} session PATH carries the browser tool's directory`);
    const record = await settledRecord(launched.review);
    assert.equal(record.verdict?.state, 'APPROVED');
    assert.equal((await stored(work.id)).productReview?.verdict, 'approved');
  }
});

test('e2e:product-review-environment — a preflight that finds the browser tool missing starts no reviewer and records could not run naming it', async () => {
  const work = await insert(productItem('GY-9503', headA));
  const fake = runtime(approve(headA));
  await assert.rejects(launchReview(root, work, 'product-claude', [], now(), { run, headless: fake.exec, product: true, browserTool: () => null }),
    /could not run: no browser tool on the session's PATH \(agent-browser\)/);
  assert.equal(fake.runs.length, 0, 'no reviewer session started');
  assert.deepEqual((await readReviewLedger(root)).reviews.filter(record => record.key === work.key), [], 'no ledger record is left behind');
  const item = await stored(work.id);
  assert.equal(item.productReview?.verdict, 'could-not-run');
  assert.equal(item.productReview?.reviewer, 'product-claude-1');
  assert.match(item.productReview!.findings, /agent-browser/, 'the missing thing is named');
  assert.equal(item.stage, 'review', 'the item stays in review');
  assert.equal(item.reworkRequested, false, 'no rework');
  assert.equal(item.pipeline?.reworkRounds, 0, 'no rework-cap count');
  assert.equal(standingVerdict(item), null, 'nothing sends the head back to a worker');
  assert.match(productReviewRefusal(item)!, /^Product review could not run/, 'the gate names the could-not-run, never a change request');
  assert.equal(productReviewNeed(item).needed, true, 'the review is still owed: another eligible reviewer is tried');
});

test('e2e:product-review-environment — a reviewer that reports it could not reach the app records could not run, stays in review, and another eligible reviewer is tried', async () => {
  const work = await insert(productItem('GY-9504', headA));
  const fake = runtime(`{"verdict": "COULD_NOT_RUN", "body": "${couldNotRun}", "findings": []}`);
  const launched = await launchReview(root, work, 'product-claude', [], now(), { run, headless: fake.exec, product: true, requestId: 'product-request-1' });
  const record = await settledRecord(launched.review);
  assert.equal(record.verdict?.state, 'COULD_NOT_RUN', 'the ledger reads the could-not-run verdict');
  const item = await stored(work.id);
  assert.equal(item.productReview?.verdict, 'could-not-run');
  assert.equal(item.productReview?.sha, headA, 'the same head');
  assert.match(item.productReview!.findings, /could not walk a served app/);
  assert.equal(item.stage, 'review', 'the item stays in review on the same head');
  assert.equal(item.reworkRequested, false, 'no rework');
  assert.equal(item.pipeline?.reworkRounds, 0, 'no rework-cap count');
  assert.equal(standingVerdict(item), null, 'nothing sends the head back to a worker');
  // The request still stands — the dispatch tick relaunches it on another eligible reviewer.
  reconcileAutoDispatch(item, [item], new Date());
  assert.equal(item.autoDispatch?.product?.state, 'requested', 'the product request stays open');
  const next = runtime(approve(headA));
  const effects = dispatchEffects(root, await loadMasterConfig(root), {
    snapshot: async () => ({ work: [await stored(work.id)], now: now() }),
    mutate: async (path: string, body: unknown) => {
      const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${coordinatorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
      const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
    },
    run, headless: next.exec,
  });
  effects.inventory = async () => headlessInventory();
  const tick = await runDispatchTick(await loadMasterConfig(root), emptyDispatchCursor(await loadMasterConfig(root)), effects);
  assert.equal(tick.launched.filter(entry => entry.reason === 'product review').length, 1, JSON.stringify(tick));
  assert.ok(next.runs.length >= 1, 'another eligible reviewer was launched for the same head');
});

test('e2e:product-review-environment — an unconfigured install with e2e.serve declared hands the reviewer the served head, and it reaches it', async () => {
  const work = await insert(productItem('GY-9505', headB));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fake = runtime(async run => {
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(run.args.at(-1)!)![0];
    const reached = await fetch(url).then(response => response.ok, () => false);
    assert.ok(reached, `the handed URL ${url} answers while the reviewer runs`);
    await gate;
    return approve(headB);
  });
  const launched = await launchReview(root, work, 'product-claude', [], now(), { run, headless: fake.exec, product: true });
  await until('the run to start', () => fake.runs.length === 1);
  const prompt = fake.runs[0]!.args.at(-1)!;
  const served = /http:\/\/127\.0\.0\.1:\d+/.exec(prompt)![0];
  assert.equal(served, `http://127.0.0.1:${servePort}`, 'the prompt hands the URL of the head the serve command runs');
  assert.match(prompt, /e2e\.serve command running this exact head/);
  assert.doesNotMatch(prompt, /no walkthrough is required/);
  release();
  const record = await settledRecord(launched.review);
  assert.equal(record.verdict?.state, 'APPROVED');
  await until('the served head to stop', async () => !(await fetch(`http://127.0.0.1:${servePort}/healthz`).then(() => true, () => false)));
});

test('e2e:product-review-environment — an install with neither serving nor a serve command owes no walkthrough, and the review completes', async () => {
  const work = await insert(productItem('GY-9506', headA));
  const fake = runtime(approve(headA));
  const launched = await launchReview(root, work, 'product-claude', [], now(), { run, headless: fake.exec, product: true });
  await until('the run to start', () => fake.runs.length === 1);
  const prompt = fake.runs[0]!.args.at(-1)!;
  assert.match(prompt, /no walkthrough is required and none is owed/);
  assert.match(prompt, /no app was there to walk/);
  assert.doesNotMatch(prompt, /e2e\.serve command running this exact head/);
  const record = await settledRecord(launched.review);
  assert.equal(record.verdict?.state, 'APPROVED');
  assert.equal((await stored(work.id)).productReview?.verdict, 'approved', 'the absence of an app is not a change request');
});

test('e2e:product-review-environment — a reviewer that walked the served head and reports a fault still requests changes', async () => {
  const work = await insert(productItem('GY-9507', headB));
  const fake = runtime(`Walked it.\n{"verdict": "BLOCKING", "body": "Product reviewed head ${headB} against base ${base}.", "findings": ["Feature B flow — the served page never shows the feature's own title"]}`);
  const launched = await launchReview(root, work, 'product-claude', [], now(), { run, headless: fake.exec, product: true });
  const record = await settledRecord(launched.review);
  assert.equal(record.verdict?.state, 'CHANGES_REQUESTED');
  const item = await stored(work.id);
  assert.equal(item.productReview?.verdict, 'changes-requested', 'a fault found while walking the app still requests changes');
  assert.match(standingVerdict(item)!.reason, /product review requested changes/, 'and the head returns to its worker for it');
  await until('the served head to stop', async () => !(await fetch(`http://127.0.0.1:${servePort}/healthz`).then(() => true, () => false)));
});

test('e2e:product-review-environment — master status shows one attention line for a product review that could not run', async () => {
  const item = await stored((await insert(productItem('GY-9508', headA))).id);
  item.productReview = { sha: headA, baseSha: base, verdict: 'could-not-run', reviewer: 'product-claude-1', findings: 'I could not walk a served app: the app did not answer.', screenshots: [], at: now() };
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [item.id, JSON.stringify(item)]);
  const config = await loadMasterConfig(root);
  const report = await masterStatusReport(root, config, async () => ({ work: [item], now: now() }), async () => `${base}\n`);
  const lines = report.attention.filter((entry: { subject: string }) => entry.subject === item.key);
  assert.equal(lines.length, 1, JSON.stringify(report.attention));
  assert.match(lines[0]!.text, /product review could not run/);
  assert.match(lines[0]!.text, /never returns to its worker/);
});
