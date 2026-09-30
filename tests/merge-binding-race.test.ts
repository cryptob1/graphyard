import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { masterConfigSchema, mergeExecutor, transientMergeRace, type MasterConfig, type MergeExecutor } from '../src/master.js';
import { candidateKey, emptyDaemonState, mergeRaceRetries, runCycle, waitingInMergeQueue, type DaemonEffects } from '../src/master-daemon.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import { Refusal, type Observation, type Principal, type Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-192: the guarded merge is bound to what it merges — head, base, policy revision, queue tip and
 * the all-gates authorization — not to the whole-document revision that background observations
 * and bookkeeping bump constantly. A race with such a write is retried at once, a candidate waiting
 * its queue turn is not attempted, and the loop merges from a fresh read, not its cycle snapshot.
 * The integration tests run the real engine on a disposable Postgres; GitHub is a stub.
 */
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['integration:claim-safety'] };
const head = 'a'.repeat(40), base = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const validProtection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true });
let pg: EmbeddedPostgres, store: Store, engine: Engine;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 192;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('merge-binding'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('merge_binding_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/merge_binding_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const id = () => randomUUID();
const reload = async (workId: string) => (await store.list()).find(item => item.id === workId)!;
const dbNow = async () => ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString();
const observation = (work: Work, extra: Partial<Observation> = {}): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
  protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString(), ...extra });
/** An unrelated write: a fresh GitHub observation of the same candidate, which bumps the revision. */
const refreshObservation = async (workId: string) => { const current = await reload(workId); return engine.observe(workId, current.revision, observation(current)); };

/** A candidate at the merge stage with every gate passed and its queue tip published. */
async function candidate() {
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Merge binding ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/merge-binding-${n}`, branch: `graphyard/gy-192-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 900 + n }, id());
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [w.id]);
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, id());
  const speculation: QueueSpeculation = { ref: queueRef(w.key), tip: head, base, baseTree: '7e'.repeat(20), predecessors: [], policyRevision: w.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [w.id, JSON.stringify(speculation)]);
  w = await engine.observe(w.id, (await reload(w.id)).revision, observation(w));
  assert.equal(w.stage, 'merge'); assert.ok(w.gates.every(gate => gate.passed), w.gates.flatMap(gate => gate.reasons).join('; '));
  return w;
}
/** The broker's transport, in process, with refusals reported the way the CLI transport reports them. */
const transport = (actor: Principal, beforeStep: (step: string, workId: string) => Promise<unknown> = async () => {}) => async (path: string, data: any, key: string = randomUUID()) => {
  const match = /^work\/([^/]+)\/merge-(acquire)$/.exec(path);
  if (!match) throw new Error(`Unexpected mutation ${path}`);
  const [, workId, step] = match;
  await beforeStep(step, workId);
  try {
    return await engine.requestEnqueue(actor, workId, data, key);
  } catch (error) {
    if (error instanceof Refusal) throw Object.assign(new Error(JSON.stringify({ error: error.message })), { confirmedRefusal: error.status >= 400 && error.status < 500 });
    throw error;
  }
};
const github = (calls: string[][] = []) => (_command: string, args: string[]) => {
  calls.push(args);
  if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: head, baseRefName: 'main', state: 'OPEN', isDraft: false });
  if (args[1]?.includes('/git/ref/heads/')) return JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: base } });
  if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
  if (args[1]?.includes('/check-runs')) return JSON.stringify([{ check_runs: [{ name: 'Graphyard / merge', status: 'completed', conclusion: 'success', app: { id: 1234 } }] }]);
  if (args[1] === '--method') return JSON.stringify({ merged: true, sha: mergeSha });
  return JSON.stringify(validProtection);
};
const snapshot = async () => ({ work: await store.list(), now: await dbNow() });
const executor = (): MergeExecutor => ({ principal: coordinator.id, instance: `daemon-${randomUUID()}` });

test('integration:merge-binding-not-revision — observation refreshes before the read, after GitHub verification and inside acquire do not refuse the merge; a changed head, base, policy revision or queue tip still does', async () => {
  const work = await candidate();
  // Read at revision R; an observation refresh lands before the merge reads the record again.
  const stale = await reload(work.id);
  await refreshObservation(work.id);
  let reads = 0;
  const racingSnapshot = async () => {
    // The second read is the one after GitHub verification: another refresh lands just before it.
    if (++reads === 2) await refreshObservation(work.id);
    return snapshot();
  };
  // And one more lands inside acquire, after the broker chose the revision it read, so the engine
  // sees an expectedRevision behind its own.
  let acquireBumped = false;
  const mutate = transport(coordinator, async (step, workId) => { if (step === 'acquire' && !acquireBumped) { acquireBumped = true; await refreshObservation(workId); } });
  const calls: string[][] = [];
  const result = await mergeExecutor(config, racingSnapshot, mutate, executor(), randomUUID(), github(calls))(stale);
  assert.match(result.result, /merge requested/, 'three unrelated revision bumps did not refuse the merge');
  const requested = await reload(work.id);
  assert.ok(requested.revision > stale.revision + 2, `the record moved on from ${stale.revision} to ${requested.revision} during the attempt`);
  // GitHub executes the merge (GY-258): the step records the request, and nothing else.
  assert.equal((await engine.enqueueRequest(work.id))?.sha, head, 'the merge request was recorded for the head');
  assert.equal(requested.mergeExecution ?? null, null, 'no merge execution is acquired');
  assert.equal(calls.filter(args => args[1] === '--method').length, 0, 'no provider merge call is made');

  // What is merged changing still refuses, at the merge step and at the engine.
  const second = await candidate();
  const current = await reload(second.id);
  const guarded = mergeExecutor(config, snapshot, transport(coordinator), executor(), randomUUID(), github());
  for (const [what, read] of [
    ['head', { ...current, candidate: { ...current.candidate!, sha: 'd'.repeat(40) } }],
    ['base', { ...current, candidate: { ...current.candidate!, baseSha: 'e'.repeat(40) } }],
    ['policy revision', { ...current, policyRevision: current.policyRevision + 1 }],
    ['queue tip', { ...current, queue: { ...current.queue!, speculation: { ...current.queue!.speculation!, tip: 'f'.repeat(40) } } }],
  ] as [string, Work][]) await assert.rejects(guarded(read), /changed before GitHub verification; retry/, `a read whose ${what} differs from the record is refused even at the same revision`);
  assert.equal(await engine.enqueueRequest(second.id), null, 'no merge was requested on a changed binding');
  await refreshObservation(second.id);
  const bound = { enqueue: true as const, expectedRevision: current.revision, sha: head, baseSha: base, policyRevision: current.policyRevision, queueTip: head };
  await assert.rejects(engine.requestEnqueue(coordinator, second.id, { ...bound, sha: 'd'.repeat(40) }, id()), /Merge authorization is no longer current/);
  await assert.rejects(engine.requestEnqueue(coordinator, second.id, { ...bound, baseSha: 'e'.repeat(40), queueTip: undefined }, id()), /Merge authorization is no longer current/);
  await assert.rejects(engine.requestEnqueue(coordinator, second.id, { ...bound, policyRevision: current.policyRevision + 1 }, id()), /Merge authorization is no longer current/);
  await assert.rejects(engine.requestEnqueue(coordinator, second.id, { ...bound, queueTip: 'f'.repeat(40) }, id()), /Task changed before the merge was requested; retry/);
  await assert.rejects(engine.requestEnqueue(coordinator, second.id, { ...bound, expectedRevision: current.revision + 50 }, id()), /Task changed before the merge was requested; retry/, 'a revision the caller cannot have read is refused');
  // The same binding at a stale revision is recorded: the engine re-validated it in the transaction.
  const granted = await engine.requestEnqueue(coordinator, second.id, bound, id());
  assert.equal(granted.enqueue.sha, head);
  assert.equal((await reload(second.id)).mergeExecution ?? null, null);
});

// ---- The loop, with fakes --------------------------------------------------------------------
const iso = (offsetMs = 0) => new Date(Date.parse('2030-01-01T00:00:00Z') + offsetMs).toISOString();
const clock = Date.parse('2030-01-01T00:00:00Z');
function mergeable(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-1', key: 'GY-42', title: 'Merge me', description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:loop'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'merge', revision: 3, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(), stageEnteredAt: iso(-60_000), ready: true, epoch: 1,
    lease: null, workspaces: [], submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    candidate: { sha: head, baseSha: base, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' },
    gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
function effects(overrides: Partial<DaemonEffects>): DaemonEffects {
  return { agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: iso() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    merge: async () => ({ result: 'merged', merged: true }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {}, ...overrides };
}
const race = (key: string) => Object.assign(new Error(JSON.stringify({ error: `${key} changed before GitHub verification; retry` })), { confirmedRefusal: false });

test('unit:merge-race-retried-immediately — two races then a success merge in one cycle and count nothing toward the backoff; a persistent non-race refusal still backs off', async () => {
  assert.equal(transientMergeRace(new Error('GY-1 changed after GitHub verification; retry')), true);
  assert.equal(transientMergeRace(new Error('{"error":"Task changed before merge execution; retry"}')), true, 'the engine refusal, as the CLI transport reports it');
  assert.equal(transientMergeRace(new Error('GY-1 merge deferred: GitHub does not yet show Graphyard / merge as passed on abc (in_progress); retry once it is')), false);
  assert.equal(transientMergeRace(new Error('GY-1 does not have a current all-gates-passing merge authorization')), false);

  const item = mergeable();
  let calls = 0;
  const state = emptyDaemonState(config);
  const performed = await runCycle(config, state, effects({ snapshot: async () => ({ work: [item], now: iso() }),
    merge: async target => { calls++; if (calls <= 2) throw race(target.key); return { result: 'merged', merged: true }; } }), () => clock);
  assert.equal(calls, 3, 'the third call, in the same cycle, merged');
  const action = state.actions[candidateKey('merge', item)];
  assert.equal(action.state, 'done', action.detail);
  assert.equal(action.attempts, 1, 'the races were retried inside one attempt');
  assert.equal(performed.actions.filter(entry => entry.kind === 'merge' && entry.state === 'failed').length, 0, 'no failed merge action was recorded');

  // Races that outlast the retries are recorded, but not counted: the next cycle tries again.
  const always = mergeable({ id: 'work-2', key: 'GY-43' });
  let raced = 0;
  const racing = effects({ snapshot: async () => ({ work: [always], now: iso() }), merge: async target => { raced++; throw race(target.key); } });
  const raceState = emptyDaemonState(config);
  await runCycle(config, raceState, racing, () => clock);
  assert.equal(raced, 1 + mergeRaceRetries, `the first call and ${mergeRaceRetries} retries ran in the one cycle`);
  assert.equal(raceState.actions[candidateKey('merge', always)].state, 'failed');
  assert.equal(raceState.actions[candidateKey('merge', always)].attempts, 0, 'a lost race is not counted toward the exponential backoff');
  await runCycle(config, raceState, racing, () => clock + 20_000);
  assert.equal(raced, 2 * (1 + mergeRaceRetries), 'the next cycle attempted again at once');

  // A refusal that judged the candidate is not retried in the cycle and backs off as before.
  const refused = mergeable({ id: 'work-3', key: 'GY-44' });
  let refusals = 0;
  const refusing = effects({ snapshot: async () => ({ work: [refused], now: iso() }), merge: async () => { refusals++; throw new Error('GY-44 base branch main advanced outside the merge queue'); } });
  const refusedState = emptyDaemonState(config);
  for (let cycle = 0; cycle < 4; cycle++) await runCycle(config, refusedState, refusing, () => clock + cycle * 20_000);
  assert.equal(refusals, 3, 'cycles 1 and 2 attempted, cycle 3 backed off, cycle 4 attempted: no in-cycle retry');
  assert.equal(refusedState.actions[candidateKey('merge', refused)].attempts, 3);
});

test('unit:queue-position-not-attempted — of two queued candidates only the one at position 1 is attempted; the one behind neither fails nor accrues backoff', async () => {
  const first = mergeable({ id: 'work-1', key: 'GY-1' });
  const second = mergeable({ id: 'work-2', key: 'GY-2', candidate: { sha: 'd'.repeat(40), baseSha: base, pr: 43, branch: 'graphyard/gy-2-1', author: 'worker' },
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'merge', passed: false, reasons: ['Merge queue position 2 of 2: GY-1 is ahead'] }] });
  assert.equal(waitingInMergeQueue(second), true); assert.equal(waitingInMergeQueue(first), false);
  assert.equal(waitingInMergeQueue(mergeable({ gates: [{ name: 'merge', passed: false, reasons: ['Merge queue position 2 of 2: GY-1 is ahead', 'Pull request is not mergeable against the current base'] }] })), false, 'a real refusal beside the position is still attempted and recorded');
  const attempted: string[] = [];
  const state = emptyDaemonState(config);
  const deps = effects({ snapshot: async () => ({ work: [first, second], now: iso() }), merge: async target => { attempted.push(target.key); return { result: 'merged', merged: true }; } });
  for (let cycle = 0; cycle < 3; cycle++) await runCycle(config, state, deps, () => clock + cycle * 20_000);
  assert.deepEqual(attempted, ['GY-1'], 'only the candidate at position 1 was attempted');
  assert.equal(state.actions[candidateKey('merge', second)], undefined, 'the candidate behind has no failed merge action and no backoff');
});

test('unit:merge-uses-fresh-read — a write after the cycle snapshot and before the merge step does not stop the merge in that cycle, which runs on the item as it stands', async () => {
  const snapshotItem = mergeable({ revision: 3 });
  const written = mergeable({ revision: 5, observation: { at: iso(30_000) } as Work['observation'] });
  let reads = 0;
  const merged: Work[] = [];
  // The cycle's own snapshot is read first; everything after it sees the write.
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects({ snapshot: async () => ({ work: [reads++ ? written : snapshotItem], now: iso() }),
    // The guarded merge refuses a read older than the record, as it does for any read it cannot trust.
    merge: async target => { merged.push(target); if (target.revision !== 5) throw new Error(`${target.key} was invoked on a stale snapshot`); return { result: 'merged', merged: true }; } }), () => clock);
  assert.ok(reads >= 2, 'the merge step read the item again');
  assert.equal(merged.length, 1, 'one guarded merge, in this cycle');
  assert.equal(merged[0].revision, 5, 'the guarded merge ran on the item as it stood, not the cycle-start snapshot');
  assert.equal(state.actions[candidateKey('merge', written)].state, 'done');
});

test('unit:merge-done-only-when-merged — an outcome that reports neither a pending request nor a merge GitHub performed is not recorded done, and is asked again (GY-246)', async () => {
  const item = mergeable();
  const outcomes: unknown[] = [{ result: 'merge requested' }, undefined, { result: 'merge requested', pending: true }, { result: 'merged', merged: true }];
  let calls = 0;
  const state = emptyDaemonState(config);
  const deps = effects({ snapshot: async () => ({ work: [item], now: iso() }), merge: async () => outcomes[calls++] });
  const seen: string[] = [];
  for (let cycle = 0; cycle < outcomes.length; cycle++) {
    await runCycle(config, state, deps, () => clock + cycle * 20_000);
    seen.push(state.actions[candidateKey('merge', item)].state);
  }
  assert.equal(calls, outcomes.length, 'every outcome short of a merge was asked again the next cycle');
  assert.deepEqual(seen, ['waiting', 'waiting', 'waiting', 'done']);
});

test('unit:interrupted-merge-retried — a merge left started by a daemon that died mid-merge is resolved at the next cycle start and asked again (GY-246)', async () => {
  const item = mergeable();
  let calls = 0;
  const state = emptyDaemonState(config);
  const key = candidateKey('merge', item);
  state.actions[key] = { kind: 'merge', work: item.key, principal: null, state: 'started', detail: `Invoking the guarded merge for ${item.key}`, attempts: 1, epoch: null, cycle: 0, at: iso() };
  await runCycle(config, state, effects({ snapshot: async () => ({ work: [item], now: iso() }), merge: async () => { calls++; return { result: 'merge requested', pending: true }; } }), () => clock + 20_000);
  assert.equal(calls, 1, 'the interrupted merge was asked again, not stranded at started');
  assert.equal(state.actions[key].state, 'waiting');
});
