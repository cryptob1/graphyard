// Seeds the board-queue-not-blocked E2E case into the head's control plane the trial serves: one
// submitted head whose merge trial is in flight and advancing, and two healthy heads queued behind it.
//
//   node scripts/e2e-seed-merge-queue.mjs
//
// Run from the checkout scripts/e2e-serve.mjs serves: it reads the database URL that serve wrote to
// .graphyard/e2e-serve.json. Re-running refreshes the flight's step instant.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { databaseUrl } = JSON.parse(await readFile('.graphyard/e2e-serve.json', 'utf8'));
const now = new Date().toISOString(), filed = '2020-01-01T00:00:00.000Z', base = 'b'.repeat(40);
const head = n => String(n).repeat(40);
const item = (n, key, fields = {}) => ({
  id: `3100a000-0000-4000-8000-00000000000${n}`, key, title: `Merge queue head ${n}`, description: 'Seeded for the merge queue board.',
  type: 'chore', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
  policy: { checks: ['test'], review: true }, policyRevision: 1, revision: 1, stage: 'test', stageEnteredAt: filed,
  ready: true, epoch: 1, lease: null, workspaces: [], evidence: [], violations: [], blocker: null, reworkRequested: false, nextAction: null,
  createdAt: `2020-01-01T00:0${n}:00.000Z`, updatedAt: filed,
  candidate: { sha: head(n), baseSha: base, createdAt: filed }, submission: { epoch: 1, sha: head(n), at: filed }, observation: { source: 'control-plane' },
  gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] },
    { name: 'test', passed: false, reasons: [`merge writer has not trialled ${head(n).slice(0, 12)} on ${base.slice(0, 12)}`] }],
  ...fields,
});
const flight = item(1, 'GY-QFLIGHT', { mergeLedger: { key: 'GY-QFLIGHT', state: 'intent', head: head(1), baseTip: base, mergeSha: 'c'.repeat(40), risk: 'normal',
  intentAt: now, pushedAt: null, observedTip: null, refusal: null, trialStep: { step: 'tests', at: now }, events: 1 } });

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  for (const work of [flight, item(2, 'GY-QUEUED-1'), item(3, 'GY-QUEUED-2')])
    await pool.query('INSERT INTO work_items(id, document) VALUES($1, $2) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document', [work.id, JSON.stringify(work)]);
} finally { await pool.end(); }
