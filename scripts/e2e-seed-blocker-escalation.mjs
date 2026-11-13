// Seeds the blocker-escalates case's items into the fixture install e2e-serve serves (GY-3280):
// one item whose worker blocker has waited 40 minutes (the clock advanced past the 30-minute
// escalation bound) and one whose blocker landed 2 minutes ago (under it).
//
//   node --import tsx scripts/e2e-seed-blocker-escalation.mjs
//
// Run from the checkout scripts/e2e-serve.mjs serves: it reads the database URL that serve wrote
// to .graphyard/e2e-serve.json. Re-running refreshes both stamps.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { databaseUrl } = JSON.parse(await readFile('.graphyard/e2e-serve.json', 'utf8'));
const minute = 60_000, now = Date.now();
const filed = new Date(now - 3 * 60 * minute).toISOString();
const item = (n, key, title, minutesWaiting, blocker) => ({
  id: `3280a000-0000-4000-8000-${String(n).padStart(12, '0')}`, key, title, description: 'Seeded for the blocker-escalates case.',
  type: 'bug', priority: 2, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'The export works', proofs: ['unit:export', 'e2e:blocker-escalates'] }],
  policy: { checks: ['test'], review: true }, policyRevision: 1, revision: 1, stage: 'ready', stageEnteredAt: filed,
  scenarioRequirements: [], submission: null, candidate: null, lastAssignment: null, observation: null, humanRequest: null,
  ready: true, epoch: 1, lease: null, workspaces: [], sessions: [], evidence: [], violations: [], blocker, blockedAt: new Date(now - minutesWaiting * minute).toISOString(),
  reworkRequested: false, nextAction: null, createdAt: filed, updatedAt: filed,
  gates: [{ name: 'ready', passed: false, reasons: [blocker] }],
  pipeline: { attempts: [{ epoch: 1, owner: 'e2e-worker', claimedAt: filed, endedAt: new Date(now - minutesWaiting * minute).toISOString(), end: 'released' }],
    submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 1, requirements: 0 } },
});
const work = [
  item(1, 'GY-EBLOCKED', 'Escalated worker blocker', 40, 'the staging database is unreachable: psql: error: connection refused (fix: grant the worker sandbox 127.0.0.1:5432)'),
  item(2, 'GY-EFRESH', 'Fresh worker blocker', 2, 'the export test needs a fixture file the worker cannot write yet'),
];
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  for (const entry of work) await pool.query('INSERT INTO work_items(id, document) VALUES($1, $2) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document', [entry.id, JSON.stringify(entry)]);
  console.log(`Seeded ${work.map(entry => entry.key).join(', ')} for blocker-escalates`);
} finally { await pool.end(); }
