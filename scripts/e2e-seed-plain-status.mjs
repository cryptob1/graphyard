// Seeds the plain-status-words E2E case (GY-2988) into the head's control plane the trial serves:
// one item in review and one merged item the serve record names as its own served commit, verified.
//
//   node scripts/e2e-seed-plain-status.mjs
//
// Run from the checkout scripts/e2e-serve.mjs serves: it reads the database URL that serve wrote to
// .graphyard/e2e-serve.json and writes .graphyard/served.json beside it. Re-running is a no-op.
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

const { databaseUrl } = JSON.parse(await readFile('.graphyard/e2e-serve.json', 'utf8'));
const sha = '1234567890abcdef1234567890abcdef12345678', at = '2026-01-01T00:00:00.000Z';
const candidate = (pr, branch) => ({ sha, baseSha: sha, pr, branch, author: 'w', createdAt: at });
const item = (id, key, title, fields) => ({
  id, key, title, description: 'No user-facing change: seeded for plain status words.',
  type: 'chore', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
  policy: { checks: ['test'], review: true }, policyRevision: 1, revision: 1, stageEnteredAt: at,
  ready: true, epoch: 1, lease: null, workspaces: [], evidence: [], violations: [], createdAt: at, updatedAt: at, ...fields,
});
const review = item('2988a000-0000-4000-8000-000000000001', 'GY-REVIEW', 'A change in review', {
  stage: 'review', candidate: candidate(7, 'graphyard/gy-review'), submission: { epoch: 1, pr: 7 }, observation: null,
  gates: [
    { name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] },
    { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] },
    { name: 'test', passed: true, reasons: [] }, { name: 'acceptance', passed: true, reasons: [] },
    { name: 'merge', passed: false, reasons: ['The merge writer has not observed the current candidate'] },
  ],
});
const live = item('2988a000-0000-4000-8000-000000000002', 'GY-LIVE', 'A change that is live and verified', {
  stage: 'done', candidate: candidate(8, 'graphyard/gy-live'), submission: { epoch: 1, pr: 8 },
  observation: { candidate: candidate(8, 'graphyard/gy-live'), checks: [], reviews: [], protected: true, mergeable: true, merged: true, mergeSha: sha, mergedAt: at, files: [], scopeFiles: [], at },
  delivery: { mergeSha: sha, mergedAt: at, authorizationRevision: 1, pr: 8, deployment: { sha, mergeSha: sha, source: 'endpoint', covers: 'exact', observedAt: at, at, observer: 'master' } },
  gates: ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] })),
});

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  for (const work of [review, live]) await pool.query('INSERT INTO work_items(id, document) VALUES($1, $2) ON CONFLICT (id) DO NOTHING', [work.id, JSON.stringify(work)]);
} finally { await pool.end(); }
// The record the serve pass writes once the served commit's required cases pass (GY-2983): the live item's own merge.
await writeFile('.graphyard/served.json', JSON.stringify({ commit: sha, url: 'http://127.0.0.1:4399', failed: null, reason: null, pid: null, check: { verified: true, case: null, step: null, reason: null }, at }) + '\n');
