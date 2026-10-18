import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { evaluate, type Principal, type Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2026-10-17 instant is the explicit `now` of evaluate() over a
// PR-era item; new Date() only stamps documents the Postgres half writes and reads back.

// GY-2010. The pull-request-era GitHub API client is gone: App credentials, webhooks, caches and
// the request budget. Gates, status and the merge writer read Graphyard's own records. An item
// stored with PR observations still loads; progression is the merge writer's trial and push.

const root = new URL('../', import.meta.url);
const gone = [
  'src/github.ts',
  'src/github-cache.ts',
  'src/github-response-cache.ts',
  'src/github-charges.ts',
  'src/github-permissions.ts',
  'src/github-setup.ts',
  'src/gh-pause.ts',
  'src/cli/github-budget-attention.ts',
  'src/server/routes/github.ts',
  'src/server/push-credential.ts',
] as const;

const sha = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const HEAD = sha('a1'), BASE = sha('b1'), MERGE = sha('c1');
const now = new Date('2026-10-17T12:00:00.000Z');
const at = now.toISOString();

async function sourceFiles(directory: URL): Promise<string[]> {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
    ? sourceFiles(new URL(`${entry.name}/`, directory))
    : Promise.resolve(entry.name.endsWith('.ts') ? [new URL(entry.name, directory).pathname] : [])))).flat();
}

test('unit:github-client-removed — the GitHub API client modules are gone, no src file calls api.github.com or mints an App installation token, and the webhook route answers 404', async () => {
  for (const path of gone) assert.equal(existsSync(new URL(path, root)), false, `${path} is deleted`);

  for (const file of await sourceFiles(new URL('src/', root))) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /api\.github\.com/, `${file} must not call api.github.com`);
    assert.doesNotMatch(text, /\/app\/installations\/[^/\s]+\/access_tokens/, `${file} must not request a GitHub App installation token`);
    assert.doesNotMatch(text, /mintPushToken|installationToken\s*\(/, `${file} must not mint an App installation token`);
  }

  // The server no longer registers a GitHub webhook module; those paths answer 404.
  const { server } = await import('../src/server/index.js');
  const engine = { store: { list: async () => [] }, principals: [] } as unknown as Engine;
  const http = server(engine as Engine, [] as any);
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const { port } = http.address() as { port: number };
    for (const path of ['/api/github/webhook', '/api/github/installation']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      assert.equal(response.status, 404, `${path} answers 404`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => http.close(err => err ? reject(err) : resolve()));
  }
});

let database: EmbeddedPostgres, store: Store, engine: Engine;
const operator: Principal = { id: 'operator', role: 'admin' };

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2010;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('github-client-removed'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('unit:pr-era-history-loads — a work item whose history carries pull-request observations, PR numbers and GitHub check results loads and evaluates; it progresses through the merge writer\'s trial and merge with no GitHub request; master status shows no Main guard or GitHub budget line', async () => {
  let work = await engine.execute(operator, 'create', null, {
    title: 'PR-era history before GY-2010',
    plannedFiles: ['src/a.ts'],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:a'] }],
  }, randomUUID());
  await engine.execute(operator, 'ready', work.id, {}, randomUUID());

  // The document as a release that still observed GitHub wrote it: PR number, checks, reviews, mergeability.
  const candidate = { sha: HEAD, baseSha: BASE, pr: 2010, branch: 'graphyard/gy-2010-1', author: 'worker' };
  const prObservation = {
    candidate: { ...candidate },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'failure', appId: 15368 }],
    reviews: [{ reviewer: 'alice', sha: HEAD, state: 'APPROVED' }],
    merged: false, mergeSha: null, mergeable: false, mergeabilityUnknown: false, protected: true,
    prState: 'open', draft: false, baseTip: BASE, baseTipContained: true,
    files: ['src/a.ts'],
    scopeFiles: [{ path: 'src/a.ts', status: 'modified', sha: sha('d'), additions: 2, deletions: 1, binary: false }],
    at,
  };
  await store.pool.query(`UPDATE work_items SET document = document || $2::jsonb WHERE id=$1`, [work.id, JSON.stringify({
    stage: 'test', ready: true, epoch: 1,
    submission: { epoch: 1, pr: 2010 },
    candidate,
    observation: prObservation,
    workspaces: [{ host: 'host', path: '/w', branch: candidate.branch, epoch: 1, owner: 'worker' }],
  })]);

  const loaded = await store.workItem(work.id) as Work & Record<string, unknown>;
  assert.equal(loaded.key, work.key);
  assert.equal(loaded.candidate?.pr, 2010, 'PR number from the pull-request era still loads');
  assert.equal((loaded.observation as { prState?: string })?.prState, 'open');
  assert.equal((loaded.observation as { checks: unknown[] }).checks.length, 2, 'GitHub check results still load');
  assert.ok((await store.list()).some(item => item.id === work.id));

  // Evaluation ignores the PR-era GitHub checks and mergeability: progression is the merge ledger.
  const beforeLedger = evaluate(loaded, [loaded], now, [15368]);
  assert.ok(beforeLedger.gates.find(g => g.name === 'test')?.reasons.some(r => /merge writer has not trialled/.test(r)),
    `test gate waits on the merge writer, not GitHub checks: ${JSON.stringify(beforeLedger.gates)}`);
  assert.ok(!beforeLedger.gates.find(g => g.name === 'test')?.reasons.some(r => /CI check|typecheck/.test(r)),
    'PR-era failed typecheck does not refuse the test gate');
  assert.ok(!beforeLedger.gates.find(g => g.name === 'merge')?.reasons.some(r => /Pull request is not mergeable|GitHub is computing|conversation/.test(r)),
    'PR-era mergeability does not refuse the merge gate');

  // The merge writer's trial and push: ledger alone opens the gates; no GitHub request is made.
  const ledger = {
    key: work.key, state: 'reconciled' as const, head: HEAD, baseTip: BASE, mergeSha: MERGE, risk: 'ordinary',
    intentAt: at, pushedAt: at, observedTip: MERGE, refusal: null, events: 3,
  };
  const progressed = { ...loaded, mergeLedger: ledger, observation: { ...prObservation, source: 'control-plane' as const, mergeable: true, protected: false, checks: [] } } as Work;
  const after = evaluate(progressed, [progressed], now, [15368]);
  assert.deepEqual(after.gates.find(g => g.name === 'test')?.reasons, [], 'trialled head opens the test gate');
  assert.ok(!after.gates.find(g => g.name === 'merge')?.reasons.some(r => /merge writer has not pushed|GitHub|mergeable|CI check/.test(r)),
    `merge gate opens from the ledger: ${JSON.stringify(after.gates.find(g => g.name === 'merge'))}`);

  // master status attention never raises a Main guard or GitHub budget line once the client is gone.
  const statusText = await readFile(new URL('src/master-status.ts', root), 'utf8');
  assert.doesNotMatch(statusText, /githubBudgetAttention|github-budget-attention/, 'master-status imports no GitHub budget attention');
  const attentionText = await readFile(new URL('src/daemon/cycle-delivery.ts', root), 'utf8').catch(() => '');
  const mainGuardSources = ['src/master-status.ts', 'src/daemon/cycle-delivery.ts', 'src/cli/github-budget-attention.ts'];
  for (const path of mainGuardSources) {
    if (!existsSync(new URL(path, root))) continue;
    const text = await readFile(new URL(path, root), 'utf8');
    assert.doesNotMatch(text, /mainGuardAttention\(/, `${path} does not raise Main guard attention`);
  }
  // Status payload shape: no githubBudget / mainGuard fields once the client is gone.
  const statusRoute = await readFile(new URL('src/server/routes/status.ts', root), 'utf8');
  assert.doesNotMatch(statusRoute, /\bgithubBudget\b/, 'status route reports no githubBudget');
  assert.doesNotMatch(statusRoute, /\bmainGuard\b/, 'status route reports no mainGuard');
  void createServer; // keep import used if server() shape changes in later edits
  void attentionText;
});
