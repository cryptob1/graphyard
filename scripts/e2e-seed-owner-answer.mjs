// Seeds the owner-answers-from-link case (GY-3415): one item parked on an owner decision, then an
// agent's answer refused — the refusal names the item's dashboard link, which the case opens next.
//
//   node --import tsx scripts/e2e-seed-owner-answer.mjs
//
// Run from the checkout scripts/e2e-serve.mjs serves (TARGET_URL is its address): it reads the
// database URL and worker token that serve wrote to .graphyard/e2e-serve.json.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describeHumanRequest } from '../src/model/human-request.ts';

const { databaseUrl, delivery } = JSON.parse(await readFile('.graphyard/e2e-serve.json', 'utf8'));
const target = process.env.TARGET_URL ?? 'http://127.0.0.1:4391', now = new Date(), filed = new Date(now.getTime() - 10 * 60_000).toISOString();
const request = { id: randomUUID(), kind: 'goals-and-priorities', reason: 'Two ways forward change the product', needed: 'Choose whether the export ships before the import',
  requestedBy: 'e2e-worker', epoch: 1, at: filed, ask: 'Ship the export first?', why: 'Users asked for export first.', recommendation: 'Go ahead as asked' };
const work = {
  id: '3415a000-0000-4000-8000-000000000001', key: 'GY-EOWNER', title: 'Owner decision from the master chat', description: 'Seeded for the owner-answers-from-link case.',
  type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'The export works', proofs: ['unit:export', 'e2e:owner-answers-from-link'] }],
  policy: { checks: ['test'], review: true }, policyRevision: 1, revision: 1, stage: 'ready', stageEnteredAt: filed,
  scenarioRequirements: [], submission: null, candidate: null, lastAssignment: null, observation: null, humanRequest: request,
  ready: true, epoch: 1, lease: null, workspaces: [], sessions: [], evidence: [], violations: [], blocker: describeHumanRequest(request), blockedAt: filed,
  reworkRequested: false, nextAction: null, createdAt: filed, updatedAt: filed,
  gates: [{ name: 'ready', passed: false, reasons: ['Waiting on a human-only decision'] }],
  pipeline: { attempts: [{ epoch: 1, owner: 'e2e-worker', claimedAt: filed, endedAt: filed, end: 'released' }], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 1, requirements: 0 } },
};
const pool = new pg.Pool({ connectionString: databaseUrl });
try { await pool.query('INSERT INTO work_items(id, document) VALUES($1, $2) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document', [work.id, JSON.stringify(work)]); }
finally { await pool.end(); }

// An agent relaying the owner's chat approval is refused, and the refusal names the link the owner opens.
const reply = await fetch(`${target}/api/work/${work.key}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${delivery.workerToken}`, 'Idempotency-Key': randomUUID() },
  body: JSON.stringify({ request: request.id, outcome: 'provided', choice: 'agree' }) });
const { error } = await reply.json();
if (reply.status !== 403 || !String(error).includes(`/#${work.key}`)) { console.error(`Expected a 403 naming /#${work.key}; got ${reply.status}: ${error}`); process.exit(1); }
console.log(`Seeded ${work.key}; the agent's answer was refused: ${error}`);
