// Seeds the needs-you-three-decisions case's items into the fixture install e2e-serve serves
// (GY-3394): an ordinary worker blocker and a stuck review's escalation, both 40 minutes old (the
// age GY-3280 once raised on Needs you), beside an account login request (money-or-accounts) and a
// goal question (goals-and-priorities) parked on the human. Needs you carries only the two parks;
// the blocker and the review escalation are the Master's, on the Master page.
//
//   node --import tsx scripts/e2e-seed-needs-you-three-decisions.mjs
//
// Run from the checkout scripts/e2e-serve.mjs serves: it reads the database URL that serve wrote
// to .graphyard/e2e-serve.json. Re-running refreshes all four stamps.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { databaseUrl } = JSON.parse(await readFile('.graphyard/e2e-serve.json', 'utf8'));
const minute = 60_000, now = Date.now();
const filed = new Date(now - 3 * 60 * minute).toISOString();
const blocker = 'the export test cannot reach the staging database: psql: error: connection refused (fix: grant the worker sandbox 127.0.0.1:5432)';
const review = 'the review of the export change will not start: every reviewer profile is out of quota on this provider (fix: add a reviewer profile on another provider, then master review GY-EREVIEW)';
const park = (n, kind, label, needed, ask, why, recommendation, minutes) => ({
  humanRequest: { id: `3394b000-0000-4000-8000-${String(n).padStart(12, '0')}`, kind, reason: `Recorded by the item's worker; ${why}`, needed, ask, why, recommendation,
    requestedBy: 'e2e-worker', epoch: 1, at: new Date(now - minutes * minute).toISOString() },
  blocker: `Waiting on a human-only decision (${label}): ${needed}`,
  blockedAt: new Date(now - minutes * minute).toISOString(),
});
const item = (n, key, title, minutesWaiting, extra = {}) => ({
  id: `3394a000-0000-4000-8000-${String(n).padStart(12, '0')}`, key, title, description: 'Seeded for the needs-you-three-decisions case.',
  type: 'feature', priority: 2, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'The export works', proofs: ['unit:export', 'e2e:needs-you-three-decisions'] }],
  policy: { checks: ['test'], review: true }, policyRevision: 1, revision: 1, stage: 'ready', stageEnteredAt: filed,
  scenarioRequirements: [], submission: null, candidate: null, lastAssignment: null, observation: null, humanRequest: null,
  ready: true, epoch: 1, lease: null, workspaces: [], sessions: [], evidence: [], violations: [], blocker: null, blockedAt: null,
  reworkRequested: false, nextAction: null, createdAt: filed, updatedAt: filed,
  gates: [{ name: 'ready', passed: false, reasons: [] }],
  pipeline: { attempts: [{ epoch: 1, owner: 'e2e-worker', claimedAt: filed, endedAt: new Date(now - minutesWaiting * minute).toISOString(), end: 'released' }],
    submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 1, requirements: 0 } },
  ...extra,
});
const withBlocker = (text) => ({ blocker: text, blockedAt: new Date(now - 40 * minute).toISOString(), gates: [{ name: 'ready', passed: false, reasons: [text] }] });
const work = [
  item(1, 'GY-EOBLOCK', 'Export fails on the staging database', 40, withBlocker(blocker)),
  item(2, 'GY-EREVIEW', 'Review of the export change will not start', 40, withBlocker(review)),
  item(3, 'GY-ELOGIN', 'Provider account for the export', 15,
    park(3, 'money-or-accounts', 'spending money or opening third-party accounts',
      'The export runs on the provider\'s paid tier: finish the account login in the provider console and approve its $10 monthly cap, so the worker\'s API key works.',
      'Log into the provider console and approve its $10 monthly cap', 'Only the owner may open the account or approve its spending.', 'Approve, saying what you approved or set up…', 15)),
  item(4, 'GY-EGOAL', 'Choose the next goal for the export', 10,
    park(4, 'goals-and-priorities', 'goals and priorities',
      'Two goals compete for the next worker: finishing the export overhaul, or starting the mobile app. The master will not sequence them without the owner\'s word.',
      'Should the export overhaul land before the mobile app?', 'Which goal comes first is the owner\'s decision, not the master\'s guess.', 'Go ahead as asked', 10)),
];
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  for (const entry of work) await pool.query('INSERT INTO work_items(id, document) VALUES($1, $2) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document', [entry.id, JSON.stringify(entry)]);
  console.log(`Seeded ${work.map(entry => entry.key).join(', ')} for needs-you-three-decisions`);
} finally { await pool.end(); }
