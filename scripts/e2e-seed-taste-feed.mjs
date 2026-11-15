// Seeds the taste-feed E2E case (GY-3393) into the head's control plane the trial serves: two
// delivered items, newest first, each with its why sentence and the proof that ran, awaiting a
// taste. Re-running (a retried attempt) resets both tastes, so each attempt tastes afresh.
//
//   node --import tsx scripts/e2e-seed-taste-feed.mjs
//
// Run from the checkout scripts/e2e-serve.mjs serves: it reads the database URL that serve wrote
// to .graphyard/e2e-serve.json.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { databaseUrl } = JSON.parse(await readFile('.graphyard/e2e-serve.json', 'utf8'));
const sha = 'fedcba9876543210fedcba9876543210fedcba98', at = '2026-01-01T00:00:00.000Z';
// The taste target merges just now, so both cards are the feed's newest whichever case ran before.
const mergedAt = new Date().toISOString();
const candidate = (pr, branch) => ({ sha, baseSha: sha, pr, branch, author: 'w', createdAt: at });
const evidence = { id: randomUUID(), proof: 'e2e:taste-feed', sha, baseSha: sha, policyRevision: 1, producer: 'taste-seed', trusted: true, result: 'pass', executed: 1, skipped: 0, at };
const item = (suffix, key, why, merged) => ({
  id: `3393a000-0000-4000-8000-00000000${suffix}`, key, title: `Delivered for taste ${suffix}`, summary: why,
  description: 'Seeded for the taste-feed case.', type: 'feature', priority: 2, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:taste-feed'] }],
  policy: { checks: ['test'], review: true }, policyRevision: 1, revision: 1, stageEnteredAt: at,
  ready: true, epoch: 1, lease: null, workspaces: [], violations: [], createdAt: at, updatedAt: merged,
  stage: 'done', candidate: candidate(41, `graphyard/gy-taste${suffix}`), submission: { epoch: 1, pr: 41 },
  observation: { candidate: candidate(41, `graphyard/gy-taste${suffix}`), checks: [], reviews: [], protected: true, mergeable: true, merged: true, mergeSha: sha, mergedAt: merged, files: [], at },
  delivery: { mergeSha: sha, mergedAt: merged, authorizationRevision: 1, pr: 41 },
  evidence: [evidence], gates: ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] })),
});

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  // The send-back target merged a breath after the look-good one, so it is the newest card.
  const items = [item('0001', 'GY-TASTE', 'A taste card shows the why sentence of what shipped.', mergedAt),
    item('0002', 'GY-SENDBACK', 'A second shipped item waits for its taste.', new Date(Date.parse(mergedAt) + 1000).toISOString())];
  for (const work of items) await pool.query('INSERT INTO work_items(id, document) VALUES($1, $2) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document', [work.id, JSON.stringify(work)]);
} finally { await pool.end(); }
