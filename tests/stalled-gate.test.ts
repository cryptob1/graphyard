import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { neededDecision, syncConflict, reworkObservationWait, isSyncConflictBinding } from '../src/daemon/decisions.js';
import { scopeRefusalBlocker } from '../src/model/scope.js';
import { scopeSettledBlocker } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';

/**
 * GY-807: the shared causes of the recurring stalled-gate faults (GY-534, GY-574, GY-531) are
 * removed, not their instances. GY-534 and GY-574 were submitted candidates GitHub reported
 * conflicting with a moved base, whose rework decision sat waiting for a fresher observation
 * nothing was going to take. GY-531 was an item whose worker's own "Blocked on scope: …" report
 * outlived the scope answer that settled it, because only the loop's refusal blocker was ever
 * cleared, and only on the daemon's ephemeral copy at that. Each test is named for the proof it
 * produces: manual:fault-class-stalled-gate.
 */

const base = 'd'.repeat(40);
const makeCandidateWithConflict = (): Work => ({
  id: 'test-conflict',
  key: 'GY-807-test-1',
  type: 'bug',
  epoch: 1,
  stage: 'build',
  submission: { epoch: 1, pr: 999, at: '2026-09-27T00:00:00Z' },
  candidate: { sha: 'c'.repeat(40), baseSha: base, pr: 999, branch: 'test-branch', author: 'test-worker' },
  observation: {
    at: '2026-09-27T00:00:00Z', // Stale: older than the freshness bound reworkObservationWait enforces
    candidate: { sha: 'c'.repeat(40), baseSha: base, pr: 999, branch: 'test-branch', author: 'test-worker' },
    conflicting: true, // GitHub reports the merge conflict against the base tip
    prState: 'open',
    mergeable: false,
    merged: false,
    mergeSha: null,
    protected: true,
    baseTip: base,
    checks: [],
    reviews: [],
    files: ['src/test.ts'],
    scopeFiles: [],
    clockOffset: { min: 0, max: 0 },
    agentReview: null
  },
  reworkRequested: false,
  queue: null, // No queue entry
  blocker: null,
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:test'] }],
  plannedFiles: ['src/test.ts'],
  lease: { epoch: 1, owner: 'test', expiresAt: '2026-09-28T00:00:00Z' },
  gates: [],
  revision: 1,
  policyRevision: 1,
  createdAt: '2026-09-26T00:00:00Z',
  updatedAt: '2026-09-27T00:00:00Z',
  stageEnteredAt: '2026-09-27T00:00:00Z'
} as any);

test('manual:fault-class-stalled-gate — GY-534/574: syncConflict detects the GitHub-reported merge conflict on a submitted candidate', () => {
  const work = makeCandidateWithConflict();
  const conflict = syncConflict(work);
  assert.ok(conflict, 'syncConflict should detect the merge conflict');
  assert.match(conflict!.reason, /conflicts with base branch/, 'the reason names the conflict GitHub reported');
  assert.equal(conflict!.binding, `${'c'.repeat(40)}:sync:${base}`, 'the binding names the head and the base tip');
});

test('manual:fault-class-stalled-gate — GY-534/574: the conflict is the rework decision the loop asks for', () => {
  const work = makeCandidateWithConflict();
  const decision = neededDecision(work, { autoMerge: true });
  assert.ok(decision, 'neededDecision should return a decision');
  assert.equal(decision!.action, 'rework', 'the action is rework');
  assert.match(decision!.reason, /sync/i, 'the reason names the sync that is the only way forward');
  assert.ok(isSyncConflictBinding(decision!.binding), 'the decision\'s binding names the conflict, so the wait can see it');
});

test('manual:fault-class-stalled-gate — GY-534/574: a conflict rework is decided from a stale observation when the decision\'s binding rides along', () => {
  const work = makeCandidateWithConflict();
  const now = Date.now();
  // The decision's own binding is what the caller passes: a conflict GitHub reported binds the
  // exact head and base tip, neither of which moves without a push, so the stale observation
  // still describes the item.
  assert.equal(reworkObservationWait(work, now + 200_000, null, `${'c'.repeat(40)}:sync:${base}`), null, 'a sync-conflict rework does not wait for a fresh observation');
  assert.equal(reworkObservationWait(work, now + 200_000, null, `${'c'.repeat(40)}:queue-conflict:7:${base}`), null, 'a queue-conflict rework does not wait for a fresh observation');

  // Every other rework ground still waits for an observation that still describes the item.
  const held = reworkObservationWait(work, now + 200_000, null, `${'c'.repeat(40)}:verdict:graphyard-reviewer[bot]`);
  assert.match(held ?? '', /stale observation/, 'any other rework still waits');

  // The wait is skipped through the decision's binding alone: the item's next-action binding is
  // the generic gate binding, which never names these grounds — the fallback this replaces.
  assert.ok(!isSyncConflictBinding('build:2:cccc:whatever'), 'the generic gate binding never names a conflict');
});

test('manual:fault-class-stalled-gate — GY-531: a scope answer settles its own blocker, and nothing else', () => {
  // The loop's own refusal blocker, and a worker's report in the known format naming the ask it waits on.
  assert.ok(scopeSettledBlocker(`${scopeRefusalBlocker}: docs/ is outside the widening rule`));
  assert.ok(scopeSettledBlocker("Blocked on scope: 'graphyard complete GY-531 8 312' was refused with 'Out-of-scope regression: tests/stalled-gate.test.ts differs from the base branch tip'"));
  assert.ok(scopeSettledBlocker('  blocked on scope: tests/soak.test.ts is outside the planned files'), 'the known report format settles wherever it opens the report');
  // A blocker no scope answer earned stays standing — including one that merely contains the word.
  assert.ok(!scopeSettledBlocker('Blocked: waiting for the operator to decide whether to open a third-party account'));
  assert.ok(!scopeSettledBlocker('Blocked: the legal scope of the paid vendor account is unresolved'), 'an unrelated blocker that merely mentions scope is not a scope ask');
  assert.ok(!scopeSettledBlocker('Unblocked pending review; see the scope discussion in the ticket'), 'a later mention of the word settles nothing');
  assert.ok(!scopeSettledBlocker(null));
});

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  // An offset no other test file takes: two files sharing a port fail in their `before` hook.
  const port = Number(process.env.GRAPHYARD_STALLED_GATE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 37);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-stalled-gate-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const human: Principal = { id: 'human-operator-807', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'engineer-807', role: 'worker', runtime: 'codex', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop-807', role: 'coordinator', sessionKind: 'ai' };
const id = () => randomUUID();

test('manual:fault-class-stalled-gate — GY-531: an approved scope answer lifts the worker\'s own scope blocker in the autoscope mutation', async () => {
  // The GY-531 shape: the worker's blocked report names the scope ask it waits on; the loop
  // refuses the ask; the rules later approve it; the answer must clear the report in the same
  // transaction — the daemon holding an unblocked copy changes nothing once the snapshot reloads.
  let work = await engine.execute(human, 'create', null, {
    title: 'Stalled gate scope',
    plannedFiles: ['src/stalled-gate/'],
    criteria: [{ id: 'AC-1', text: 'The stalled-gate regression runs in tests/stalled-gate.test.ts', proofs: ['unit:stalled-gate'] }]
  }, id());
  work = await engine.execute(human, 'ready', work.id, {}, id());
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  const epoch = work.epoch;
  work = await engine.execute(worker, 'workspace', work.id, { epoch, host: 'stalled-gate-host', path: `/tmp/stalled-gate/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${epoch}` }, id());
  const report = "Blocked on scope: 'graphyard complete GY-N 1 1' was refused with 'Out-of-scope regression: tests/stalled-gate.test.ts differs from the base branch tip'";
  work = await engine.execute(worker, 'blocked', work.id, { epoch, reason: report }, id());
  assert.equal(work.blocker, report, 'the item carries the worker\'s own scope blocker');
  work = await engine.execute(worker, 'scope', work.id, { epoch, paths: ['tests/stalled-gate.test.ts'], reason: 'The criterion names this regression file' }, id());
  work = await engine.execute(coordinator, 'autoscope', work.id, { epoch }, id());
  assert.equal(work.scopeDecision!.state, 'approved', JSON.stringify(work.scopeDecision));
  assert.equal(work.blocker, null, 'the approved answer lifted the worker\'s scope blocker in the same mutation');
  assert.ok(work.plannedFiles!.some(planned => planned === 'tests/stalled-gate.test.ts'), 'the approved paths are applied to the live item');
  const history = (await store.pool.query('SELECT payload FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq DESC LIMIT 1', [work.id, 'autoscope'])).rows[0];
  assert.equal(history.payload.details.before.blocker, report, 'the history entry records the blocker the answer lifted');
});

test('manual:fault-class-stalled-gate — GY-531: an approved scope answer leaves a blocker no scope ask earned standing', async () => {
  let work = await engine.execute(human, 'create', null, {
    title: 'Stalled gate scope untouched',
    plannedFiles: ['src/stalled-gate-other/'],
    criteria: [{ id: 'AC-1', text: 'The stalled-gate regression runs in tests/stalled-gate.test.ts', proofs: ['unit:stalled-gate'] }]
  }, id());
  work = await engine.execute(human, 'ready', work.id, {}, id());
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  const epoch = work.epoch;
  work = await engine.execute(worker, 'workspace', work.id, { epoch, host: 'stalled-gate-host', path: `/tmp/stalled-gate-other/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${epoch}` }, id());
  work = await engine.execute(worker, 'blocked', work.id, { epoch, reason: 'Blocked: waiting for the operator to decide whether to open a third-party account' }, id());
  work = await engine.execute(worker, 'scope', work.id, { epoch, paths: ['tests/stalled-gate.test.ts'], reason: 'The criterion names this regression file' }, id());
  work = await engine.execute(coordinator, 'autoscope', work.id, { epoch }, id());
  assert.equal(work.scopeDecision!.state, 'approved', JSON.stringify(work.scopeDecision));
  assert.match(work.blocker ?? '', /third-party account/, 'a blocker no scope answer named still holds the item');
});
