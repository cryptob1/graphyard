import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import type { NextAction } from '../src/model/action-kinds.js';
import { actionId, actionStallMaxMs, claimAction, reconcileActions, settleAction, settleDelivered } from '../src/model/actions.js';
import { nextAction } from '../src/model/next-action.js';
import { livenessCarry, livenessOf, livenessRetryLimit, livenessViolations, livenessWaitBoundMs, type ViolationClass } from '../src/model/liveness.js';
import { livenessStatus } from '../src/cli/liveness-report.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { emptyDaemonState, writeDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): t0 (2026-09-20) drives a virtual clock (now = () => new Date(clock)) handed to settleDelivered and the retry rows; the Postgres half stamps and judges everything with the real clock.

/**
 * GY-201: every open item always has exactly one owned next step with a deadline, and the server
 * keeps it that way. Each test is named for the proof it produces and runs the real engine on a
 * disposable Postgres; the stranded states are the record as the incidents left it — the owed row
 * gone — rather than states this test invents.
 */
const repository = 'owner/project';
const PROOF = 'integration:liveness-proof';
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: [PROOF] };
const base = 'b'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
let pg: EmbeddedPostgres, store: Store, engine: Engine;
let serial = 0;

before(async () => {
  // An offset no other test file takes: two files sharing a port fail in their `before` hook.
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 201;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('liveness'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('liveness_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/liveness_test`); await store.init();
  engine = new Engine(store, 120, repository); engine.submissionObserver = null;
  engine.principals = [operator, worker, coordinator, producer];
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const id = () => randomUUID();
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.pool.query('SELECT payload FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq', [work.id, kind])).rows.map(row => row.payload.details);
const setDocument = (work: Work, path: string, value: unknown) => store.pool.query('UPDATE work_items SET document=jsonb_set(document,$2::text[],$3::jsonb) WHERE id=$1', [work.id, `{${path}}`, JSON.stringify(value)]);
/** The record as a stranded item was found: whatever row owned its next step is gone. */
const strand = (work: Work) => setDocument(work, 'actionQueue', { actions: [], history: [] });
const judge = async (work: Work) => { const all = await store.list(); return livenessOf(all.find(item => item.id === work.id)!, all, new Date()); };
const rows = (work: Work) => work.actionQueue?.actions ?? [];
const head = (work: Work) => work.candidate?.sha ?? sha(work.key);
const observation = (work: Work, extra: Partial<Observation> = {}): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head(work), baseSha: base, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head(work), state: 'APPROVED' }],
  protected: true, mergeable: true, merged: false, mergeSha: null, baseTip: base, baseTree: '7e'.repeat(20), files: [], scopeFiles: [], at: new Date().toISOString(), ...extra });

const released = async () => {
  const n = ++serial;
  const created = await engine.execute(operator, 'create', null, { title: `Liveness ${n}`, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: [PROOF] }] }, id());
  return engine.execute(operator, 'ready', created.id, {}, id());
};
const claimed = async () => engine.execute(worker, 'claim', (await released()).id, {}, id());
/** A submitted, observed candidate; `evidence` decides what its proof says. */
async function candidate(evidence: 'pass' | 'fail' | null, extra: Partial<Observation> = {}) {
  let w = await claimed();
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/liveness-${w.key}`, branch: `graphyard/${w.key.toLowerCase()}-1` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 900 + serial }, id());
  w = await engine.observe(w.id, w.revision, observation(w, extra));
  if (evidence) w = await engine.execute(producer, 'evidence', w.id, { proof: PROOF, sha: head(w), baseSha: base, policyRevision: w.policyRevision, result: evidence, executed: 3, skipped: 0,
    ...(evidence === 'pass' ? { exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } } : {}) }, id());
  return engine.observe(w.id, (await reload(w)).revision, observation(w, extra));
}
async function staleWait() {
  // A draft pull request: no producer request may stand for its head, so the item waits on an
  // event outside it. Entered an hour ago, the wait is past its bound.
  const w = await candidate(null, { draft: true });
  assert.equal(nextAction(w, await store.list(), new Date()), null, `the draft waits: ${JSON.stringify(w.nextAction)}`);
  await setDocument(w, 'stageEnteredAt', new Date(Date.now() - 2 * livenessWaitBoundMs).toISOString());
  return reload(w);
}
// ---- AC-1 ---------------------------------------------------------------------------------------

test('unit:liveness-violations-detected — every open item holds exactly one obligation (a live leased session, an open action row, or a named wait with a dueAt) and an item holding none is a violation, classified by its state: a failed proof with no rework and a wait past its dueAt', async () => {
  const now = () => new Date();
  // Healthy items each hold one obligation, with a due time.
  const ready = await released();
  const healthy = await judge(ready);
  assert.equal(healthy.violation, null);
  assert.equal(healthy.obligation!.kind, 'action');
  assert.equal(healthy.obligation!.action!.kind, 'dispatch');
  assert.ok(Date.parse(healthy.obligation!.dueAt) > Date.now(), 'an open row is due by its idle bound');
  const building = await judge(await claimed());
  assert.equal(building.violation, null);
  assert.equal(building.obligation!.kind, 'session', 'the leased worker owns the build');
  const backlog = await engine.execute(operator, 'create', null, { title: 'Backlog', criteria: [{ id: 'AC-1', text: 'Behaves', proofs: [PROOF] }] }, id());
  assert.deepEqual(await judge(backlog), { work: backlog.id, key: backlog.key, obligation: null, violation: null }, 'backlog is not open work');

  // A candidate passing every gate but the merge writer's owes nobody a step (GY-2010): the writer
  // trials and pushes it, so it is a named wait on the writer with a due time, even with no row left on its record.
  const merging = await candidate('pass');
  assert.deepEqual(merging.gates.filter(gate => !gate.passed).map(gate => gate.name), ['test', 'merge'], 'every gate but the merge writer\'s passes');
  assert.ok(merging.gates.filter(gate => !gate.passed).every(gate => gate.reasons.every(reason => reason.startsWith('merge writer has not'))), JSON.stringify(merging.gates));
  assert.equal(nextAction(merging, await store.list(), now()), null, 'no merge is owed by anybody here');
  await strand(merging);
  const awaited = await judge(merging);
  assert.equal(awaited.violation, null);
  assert.deepEqual([awaited.obligation!.kind, awaited.obligation!.owner], ['wait', 'merge-writer'], JSON.stringify(awaited.obligation));
  assert.ok(Date.parse(awaited.obligation!.dueAt) > Date.now(), 'the wait on the merge writer is due by its bound');

  // The stranded states, each as the incident left the record.
  const failed = await candidate('fail');
  const stale = await staleWait();
  await strand(failed);

  const expected: [Work, ViolationClass, string][] = [[failed, 'failed-proof', 'request-rework'], [stale, 'stale-wait', 'attention']];
  const found = livenessViolations(await store.list(), now());
  for (const [item, kind, successor] of expected) {
    const verdict = await judge(item);
    assert.equal(verdict.obligation, null, `${item.key} holds nothing`);
    assert.equal(verdict.violation?.class, kind, `${item.key}: ${JSON.stringify(verdict.violation)}`);
    assert.equal(verdict.violation!.successor?.kind, successor, `${item.key} is owed ${successor}`);
    assert.ok(verdict.violation!.ageMs >= 0 && Date.parse(verdict.violation!.since) <= Date.now(), 'with an age');
    assert.ok(found.some(entry => entry.key === item.key), `${item.key} is listed among the violations`);
  }
  assert.deepEqual(found.map(entry => entry.key).sort(), expected.map(([item]) => item.key).sort(), 'and nothing healthy is');
  // What the stale wait is owed, precisely: an escalation.
  const escalation = (await judge(stale)).violation!.successor!;
  assert.ok(escalation.inputs.kind === 'attention' && escalation.inputs.trigger === 'stale-wait', JSON.stringify(escalation));

  // Two states no rule answers at all are violations too, never silence: a gate refusing with no
  // reason, and a wait on an item that does not exist.
  const at = new Date().toISOString();
  const shell = (key: string, overrides: Partial<Work>) => ({ id: `id-${key}`, key, title: key, type: 'feature', priority: 1, epoch: 1, revision: 1, policyRevision: 1, stage: 'review', ready: true,
    createdAt: at, updatedAt: at, stageEnteredAt: at, criteria: [], dependencies: [], evidence: [], workspaces: [], violations: [], blocker: null, lease: null,
    submission: { epoch: 1, pr: 1 }, candidate: null, observation: null, policy: { checks: [], review: true }, gates: [], ...overrides } as unknown as Work);
  const mute = shell('GY-MUTE', { gates: [{ name: 'review', passed: false, reasons: [] }] });
  const orphan = shell('GY-ORPHAN', { stage: 'build', gates: [{ name: 'ready', passed: false, reasons: ['Dependency GY-GONE is unfinished'] }] });
  assert.equal(livenessOf(mute, [mute], now()).violation?.class, 'unaccounted');
  assert.equal(livenessOf(orphan, [orphan], now()).violation?.class, 'stale-wait');
});

// ---- AC-2 ---------------------------------------------------------------------------------------

test('unit:violations-get-successor-actions — one reconciliation tick opens exactly one successor for each violation (request-rework, escalate), deduplicated by reason across ticks, and an action failing N times for one unchanged reason is converted to escalate instead of retried', async () => {
  const failed = await candidate('fail'), stale = await staleWait();
  await strand(failed);
  const cases: [Work, ViolationClass, string, string | null][] = [[failed, 'failed-proof', 'request-rework', null], [stale, 'stale-wait', 'attention', 'stale-wait']];
  for (const [item, kind] of cases) assert.equal((await judge(item)).violation?.class, kind, `${item.key} starts in violation`);

  await engine.reconcile();
  for (const [item, kind, successor, tag] of cases) {
    const after = await reload(item);
    const verdict = await judge(item);
    assert.equal(verdict.violation, null, `${item.key} is repaired within one tick: ${JSON.stringify(verdict.violation)}`);
    assert.equal(verdict.obligation!.kind, 'action');
    const owed = rows(after).filter(row => row.kind === successor);
    assert.equal(owed.length, 1, `${item.key}: exactly one ${successor} row`);
    if (tag) assert.ok(owed[0].inputs.kind === 'attention' && owed[0].inputs.trigger === tag, JSON.stringify(owed[0].inputs));
    const repaired = await events(item, 'liveness.repaired');
    assert.equal(repaired.length, 1, `${item.key}: the repair is on the ledger`);
    assert.equal(repaired[0].class, kind);
    assert.equal(repaired[0].successor.id, owed[0].id, 'naming the row it opened');
  }

  // A second tick finds nothing to repair and queues nothing twice: every successor's id is
  // derived from its reason.
  const before = Object.fromEntries(await Promise.all(cases.map(async ([item]) => [item.id, rows(await reload(item)).map(row => row.id)] as const)));
  await engine.reconcile();
  for (const [item] of cases) {
    const ids = rows(await reload(item)).map(row => row.id);
    assert.deepEqual(ids, before[item.id], `${item.key}: no duplicate after a second tick`);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal((await events(item, 'liveness.repaired')).length, 1, `${item.key}: nothing further to repair`);
  }

  // N failures for one unchanged reason: retried below the limit, escalated at it.
  const item = await released();
  const reason = 'every worker profile is busy or unavailable (claude-a: busy)';
  const dispatchId = rows(item).find(row => row.kind === 'dispatch')!.id;
  const fail = async () => {
    await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{actionQueue,actions}',(SELECT jsonb_agg(row - 'retryAt') FROM jsonb_array_elements(document->'actionQueue'->'actions') row)) WHERE id=$1", [item.id]);
    const taken = await engine.claimNextAction(coordinator, { host: 'host-1', kinds: ['dispatch'], work: item.key }, id());
    assert.equal(taken.action?.id, dispatchId, 'the dispatch row is offered');
    await engine.settleClaimedAction(coordinator, dispatchId, { result: 'failed', reason }, id());
  };
  for (let failure = 1; failure < livenessRetryLimit; failure++) await fail();
  await engine.reconcile();
  let current = await reload(item);
  assert.equal(current.nextAction?.kind, 'dispatch', `${livenessRetryLimit - 1} identical failures are still retried`);
  await fail();
  await engine.reconcile();
  current = await reload(item);
  assert.equal(current.nextAction?.kind, 'attention', `the ${livenessRetryLimit}th identical failure converts it`);
  assert.ok(current.nextAction!.inputs.kind === 'attention' && current.nextAction!.inputs.trigger === 'stalled-action' && current.nextAction!.inputs.detail.includes(reason));
  assert.deepEqual(rows(current).map(row => row.kind), ['attention'], 'the dispatch is retired, not retried');
  const escalationId = rows(current)[0].id;
  await engine.reconcile();
  current = await reload(item);
  assert.deepEqual(rows(current).map(row => row.id), [escalationId], 'and it stays converted: one escalation, no dispatch reopened');
  assert.equal((await engine.claimNextAction(coordinator, { host: 'host-1', kinds: ['dispatch'], work: item.key }, id())).action, null, 'no executor is offered the dispatch again');
  assert.equal((await judge(item)).violation, null, 'the escalation owns the item');
  assert.equal(actionId('attention', item.id, rows(current)[0].binding), escalationId);
});

test('unit:violations-get-successor-actions — resync and request-review rows refused for one stable reason keep being retried on the widest backoff after they escalate', () => {
  for (const kind of ['resync', 'request-review'] as const) {
    const t0 = Date.parse('2026-09-20T10:00:00.000Z');
    let clock = t0;
    const now = () => new Date(clock);
    const at = new Date(t0).toISOString();
    const work = { id: `id-${kind}`, key: `GY-${kind.toUpperCase()}`, title: kind, type: 'feature', priority: 1, epoch: 1, revision: 1, policyRevision: 1, stage: 'review', ready: true,
      createdAt: at, updatedAt: at, stageEnteredAt: at, criteria: [], dependencies: [], evidence: [], workspaces: [], violations: [], blocker: null, lease: null,
      submission: { epoch: 1, pr: 1 }, candidate: null, observation: null, policy: { checks: [], review: true }, gates: [] } as unknown as Work;
    const inputs = kind === 'resync' ? { kind, pr: 1, sha: null, baseSha: null, baseTip: null, observedAt: null }
      : { kind, provider: 'reviewer', requestId: 'request-1', pr: 1, sha: 'a'.repeat(40), baseSha: base, policyRevision: 1 };
    const base_: NextAction = { kind, work: work.id, key: work.key, gate: 'review', refusal: 'refused', reason: `${kind} is owed`, inputs: inputs as NextAction['inputs'], llmRole: null, binding: `${kind}:1` };
    const next = () => livenessCarry(work, { gate: 'review', refusal: 'refused', action: base_, wait: null, defect: null }, [work], now()).action!;
    const tick = () => reconcileActions(work, [work], now(), { next: next() });
    const executor = { id: 'executor-1', host: 'host-1', principal: 'coordinator' };
    const rowId = actionId(kind, work.id, base_.binding);
    const reason = `${kind} refused: the provider says the pull request is locked`;
    const fail = () => {
      const taken = claimAction([work], executor, now(), { kinds: [kind] });
      assert.equal(taken?.row.id, rowId, `${kind} is offered at ${now().toISOString()}`);
      clock += 1000;
      const settled = settleAction(work, rowId, { executor: executor.id, principal: executor.principal }, 'failed', reason, now());
      tick();
      return Date.parse(settled.action.retryAt!);
    };
    tick();
    for (let failure = 1; failure < livenessRetryLimit; failure++) { clock = fail(); assert.equal(next().kind, kind, `${kind}: failure ${failure} is retried`); }
    fail();
    assert.equal(next().kind, 'attention', `${kind}: escalated after ${livenessRetryLimit} identical refusals`);
    for (let round = 1; round <= 3; round++) {
      clock += actionStallMaxMs;
      tick();
      assert.equal(next().kind, kind, `${kind}: round ${round} retries it on the widest backoff`);
      fail();
      assert.equal(next().kind, 'attention', `${kind}: round ${round} re-escalates on the unchanged refusal`);
    }
  }
});

test('unit:liveness-violations-detected — a pending producer request or a running proof session owns the wait on its own clock: a producer running 45 minutes inside its 120-minute timeout is not a violation, one past it is', async () => {
  const stale = await staleWait();
  assert.equal((await judge(stale)).violation?.class, 'stale-wait', 'with nothing running, an hour past stage entry is stale');
  const started = Date.now() - 45 * 60_000;
  const handle = { id: `proof-${stale.key}`, kind: 'proof', principal: 'proof-runner', epoch: null, runtime: 'claude', host: 'test', workspace: null, tab: null, pane: null, agentName: null,
    role: 'proof:integration', head: head(stale), attach: null, transcript: null, subject: 'integration proofs', startedAt: new Date(started).toISOString(), updatedAt: new Date().toISOString(), endedAt: null, state: 'running', outcome: null };
  await setDocument(stale, 'sessions', [handle]);
  const all = await store.list(), item = all.find(entry => entry.id === stale.id)!;
  const running = livenessOf(item, all, new Date());
  assert.equal(running.violation, null, `the producer inside its timeout owns the wait: ${JSON.stringify(running.violation)}`);
  assert.equal(running.obligation!.dueAt, new Date(started + 120 * 60_000).toISOString(), 'due at the end of the producer timeout, dated from the session start');
  assert.equal(livenessOf(item, all, new Date(started + 121 * 60_000)).violation?.class, 'stale-wait', 'and past it, the wait is stale');
  // A producer request pending for the head is the same obligation, dated from when it was requested.
  const requestedAt = new Date(Date.now() - 45 * 60_000).toISOString();
  await setDocument(stale, 'sessions', []);
  await setDocument(stale, 'autoDispatch', { review: null, history: [], producers: [{ id: 'request-1', kind: 'producer', group: 'integration', proofs: [PROOF], sha: head(stale), baseSha: base, policyRevision: stale.policyRevision, pr: stale.submission!.pr, requestedAt, reason: 'unproven', state: 'requested' }] });
  const requested = await judge(stale);
  assert.equal(requested.violation, null, `the pending request owns the wait: ${JSON.stringify(requested.violation)}`);
  assert.equal(requested.obligation!.dueAt, new Date(Date.parse(requestedAt) + 120 * 60_000).toISOString());
});

// ---- AC-3 ---------------------------------------------------------------------------------------

test('unit:liveness-count-reported — master status reports the count of liveness violations and each one\'s age, and the count is zero once the fixture board settles', async () => {
  // A board with a stranded item among healthy ones.
  await released(); await claimed(); await candidate('pass');
  const stranded = await candidate('fail');
  await strand(stranded);
  const board = { work: await store.list(), now: new Date(Date.now() + 1000).toISOString() };
  const reported = livenessStatus(board);
  assert.ok(reported.violations >= 1, 'the stranded item is counted');
  assert.equal(reported.violations, reported.items.length);
  const entry = reported.items.find(item => item.key === stranded.key)!;
  assert.equal(entry.class, 'failed-proof');
  assert.ok(entry.ageMs >= 1000 && Date.parse(entry.since) <= Date.parse(board.now), `with its age: ${JSON.stringify(entry)}`);
  assert.equal(reported.oldestMs, Math.max(...reported.items.map(item => item.ageMs)));

  // One reconciliation tick settles the board, and `master status` reports zero.
  await engine.reconcile();
  const settled = { work: await store.list(), now: new Date().toISOString() };
  assert.deepEqual(livenessStatus(settled), { violations: 0, oldestMs: null, items: [] }, 'every open item holds an obligation');

  const directory = await temporaryDirectory('liveness-status'), root = await temporaryDirectory('liveness-root');
  try {
    const credentialFile = join(directory, 'coordinator.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    execFileSync('git', ['init', '-q', root]);
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), repository,
      baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
    await writeDaemonState(master, emptyDaemonState(master));
    const masterApi = async (path: string) => path === 'work-snapshot' ? settled : { decisions: [] };
    const report = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null }) as { liveness: ReturnType<typeof livenessStatus>; counts: Record<string, number> };
    assert.equal(report.liveness.violations, 0, 'master status reports the count');
    assert.deepEqual(report.liveness.items, []);
    assert.equal(report.counts.livenessViolations, 0, 'and counts it');
    const strandedStatus = await masterStatusReport(root, master, async (path: string) => path === 'work-snapshot' ? board : { decisions: [] }, { actor: { id: 'coordinator-1' } }, { commit: null }) as typeof report;
    assert.equal(strandedStatus.liveness.violations, reported.violations, 'a board with a violation reads non-zero');
    assert.ok(strandedStatus.liveness.items.every(item => typeof item.ageMs === 'number' && item.since), 'each with its age');
  } finally { await rm(directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});
