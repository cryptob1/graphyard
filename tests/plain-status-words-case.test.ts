import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { parseCase } from '../src/e2e/case.js';
import { projectCaseSuite } from '../src/release-project.js';
import type { E2eReport } from '../src/e2e/runner.js';
import { serveRecordPath } from '../src/serve-app.js';

// GY-2988 AC-2 on this head: the Work page shows an item in review as 'In review' and a merged,
// served, verified item as 'Live and verified'. The case itself is e2e/cases/plain-status-words.json,
// run here the way the merge trial runs it: against a control plane seeded with those two items
// and a serve record whose check is verified.

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

const sha = '1234567890abcdef1234567890abcdef12345678';
const at = '2026-01-01T00:00:00.000Z';

test('unit:plain-status-words-case — the Work page shows In review and Live and verified for the seeded items', { timeout: 300_000 }, async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2988;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('plain-status-words'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  const operator: Principal = { id: 'e2e-operator', role: 'admin' }, token = `trial-${randomUUID()}`;
  const root = await temporaryDirectory('plain-status-words-root');
  git(['init', '-q', '-b', 'main'], root);
  await writeFile(join(root, 'README.md'), 'plain status words\n');
  git(['add', '.'], root); git(['commit', '-q', '-m', 'fixture'], root);
  let http: ReturnType<typeof server> | null = null, store: Store | null = null;
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  try {
    await database.initialise(); await database.start(); await database.createDatabase('plain_status_words');
    store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/plain_status_words`); await store.init();
    const engine = new Engine(store, 120, '');
    http = server(engine, [{ ...operator, token }], null, {});
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(http!.address() as { port: number }).port}`;

    // Seed: one item in review (Moving, StepsBar reads In review) and one merged item the release
    // serves, with GY-2983's verified check on the serve record (Work footer's Latest reads Live and verified).
    const reviewId = randomUUID(), liveId = randomUUID();
    const review = {
      id: reviewId, key: 'GY-REVIEW', title: 'A change in review', description: 'No user-facing change: seeded for plain status words.',
      type: 'chore', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
      policy: { checks: ['test'], review: true }, policyRevision: 1, revision: 1, stage: 'review', stageEnteredAt: at,
      ready: true, epoch: 1, lease: null, workspaces: [], candidate: { sha, baseSha: sha, pr: 7, branch: 'graphyard/gy-review', author: 'w', createdAt: at },
      submission: { epoch: 1, pr: 7 }, observation: null, gates: [
        { name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] },
        { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] },
        { name: 'test', passed: true, reasons: [] }, { name: 'acceptance', passed: true, reasons: [] },
        { name: 'merge', passed: false, reasons: ['The merge writer has not observed the current candidate'] },
      ], evidence: [], violations: [], createdAt: at, updatedAt: at,
    };
    const live = {
      id: liveId, key: 'GY-LIVE', title: 'A change that is live and verified', description: 'No user-facing change: seeded for plain status words.',
      type: 'chore', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
      policy: { checks: ['test'], review: true }, policyRevision: 1, revision: 1, stage: 'done', stageEnteredAt: at,
      ready: true, epoch: 1, lease: null, workspaces: [], candidate: { sha, baseSha: sha, pr: 8, branch: 'graphyard/gy-live', author: 'w', createdAt: at },
      submission: { epoch: 1, pr: 8 }, observation: { candidate: { sha, baseSha: sha, pr: 8, branch: 'graphyard/gy-live', author: 'w', createdAt: at }, checks: [], reviews: [], protected: true, mergeable: true, merged: true, mergeSha: sha, mergedAt: at, files: [], scopeFiles: [], at },
      delivery: { mergeSha: sha, mergedAt: at, pr: 8, deployment: { sha, mergeSha: sha, source: 'endpoint', covers: 'exact', observedAt: at, at, observer: 'master' } },
      gates: ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] })),
      evidence: [], violations: [], createdAt: at, updatedAt: at,
    };
    await store.pool.query('INSERT INTO work_items(id, document) VALUES($1, $2), ($3, $4)', [reviewId, JSON.stringify(review), liveId, JSON.stringify(live)]);
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await writeFile(serveRecordPath(root), JSON.stringify({
      commit: sha, url: 'http://127.0.0.1:4399', failed: null, reason: null, pid: null,
      check: { verified: true, case: null, step: null, reason: null }, at,
    }) + '\n');

    const file = 'e2e/cases/plain-status-words.json';
    let report: E2eReport | null = null;
    await projectCaseSuite(root, token, {
      cases: [{ file, definition: parseCase(file, await readFile(join(process.cwd(), file), 'utf8')) }],
      select: () => true, withholdSecrets: true,
      artifactsDirectory: await temporaryDirectory('plain-status-words-artifacts'),
      signal: AbortSignal.timeout(240_000), report: value => { report = value; },
    }).run(origin, null);
    const outcome = (report as E2eReport | null)?.cases.find(entry => entry.id === 'plain-status-words');
    assert.equal(outcome?.verdict, 'passed', JSON.stringify(outcome?.failingStep ?? outcome));
  } finally {
    delete process.env.GRAPHYARD_REPOSITORY_ROOT;
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
    await database.stop();
  }
});
