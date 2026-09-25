import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { masterConfigSchema, mergeBindingChanges, mergeExecutor, mergeRace, type MasterConfig, type MergeExecutor } from '../src/master.js';
import { emptyDaemonState, mergeRaceRetries, readyToRetry, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import { Refusal, type Observation, type Principal, type Work } from '../src/model.js';

/**
 * GY-192: a mergeable item lost the guarded merge to its own background revision bumps — an
 * observation refresh, queue and action bookkeeping — and each loss doubled its wait. The merge is
 * bound to what it merges, a racing write is retried at once, an entry behind another in the queue
 * is not attempted, and the loop merges from a read taken immediately before the merge. Each test
 * is named for the proof it produces.
 */
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['integration:claim-safety'] };
const head = 'a'.repeat(40), base = 'b'.repeat(40), mergeSha = 'c'.repeat(40), otherSha = 'd'.repeat(40);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const validProtection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true });

// ---- integration: the real engine on a disposable Postgres, GitHub a stub --------------------------
let pg: EmbeddedPostgres | undefined, store: Store | undefined, engine: Engine;
let serial = 0;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 192;
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-merge-binding-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('merge_binding_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/merge_binding_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const id = () => randomUUID();
const reload = async (workId: string) => (await store!.list()).find(item => item.id === workId)!;
const events = async (workId: string, kind: string) => (await store!.pool.query('SELECT payload FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq', [workId, kind])).rows;
const dbNow = async () => ((await store!.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString();
const observation = (work: Work, extra: Partial<Observation> = {}): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
  protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString(), ...extra });
/** A candidate at the merge stage with every gate passed and its queue tip published. */
async function candidate() {
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Merge binding ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/merge-binding-${n}`, branch: `graphyard/gy-192-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 1900 + n }, id());
  await store!.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [w.id]);
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, id());
  const speculation: QueueSpeculation = { ref: queueRef(w.key), tip: head, base, baseTree: '7e'.repeat(20), predecessors: [], policyRevision: w.policyRevision, publishedAt: new Date().toISOString() };
  await store!.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [w.id, JSON.stringify(speculation)]);
  w = await engine.observe(w.id, (await reload(w.id)).revision, observation(w));
  assert.equal(w.stage, 'merge'); assert.ok(w.gates.every(gate => gate.passed), w.gates.flatMap(gate => gate.reasons).join('; '));
  return w;
}
/** A background write that moves the revision and nothing the merge is bound to: GitHub observed again. */
async function refreshObservation(workId: string) {
  const before = await reload(workId);
  const after = await engine.observe(workId, before.revision, observation(before));
  assert.ok(after.revision > before.revision, 'the observation refresh bumped the document revision');
  assert.deepEqual(mergeBindingChanges(before, after), [], 'the refresh changed nothing the merge is bound to');
  return after;
}
/** The broker's transport in process; `beforeAcquire` runs between the executor's read and the engine's grant. */
const transport = (actor: Principal, beforeAcquire: (workId: string) => Promise<unknown> = async () => {}) => async (path: string, data: any, key: string = randomUUID()) => {
  const match = /^work\/([^/]+)\/merge-(acquire|cancel|verify|commit)$/.exec(path);
  if (!match) throw new Error(`Unexpected mutation ${path}`);
  const [, workId, step] = match;
  try {
    if (step === 'acquire') { await beforeAcquire(workId); return await engine.acquireMerge(actor, workId, data, key); }
    if (step === 'cancel') return await engine.cancelMerge(actor, workId, data, key);
    if (step === 'commit') return await engine.commitMerge(actor, workId, data, key);
    const replay = await engine.replayMergeVerification(actor, workId, data, key); if (replay) return replay;
    return await engine.verifyMerge(actor, workId, data, { ...observation(await reload(workId)), prState: 'open', draft: false, clockOffset: { min: -1000, max: 0 } }, key);
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
const snapshot = async () => ({ work: await store!.list(), now: await dbNow() });
const executor = (): MergeExecutor => ({ principal: coordinator.id, instance: `daemon-${randomUUID()}` });

test('integration:merge-binding-not-revision — an observation refresh between read and merge bumps the revision and the merge proceeds; a moved head, base or policy revision is still refused', async () => {
  // The master's own checks: the item is read, a background observation refresh bumps its revision,
  // and the guarded merge from that read proceeds — it compares the binding, not the revision.
  const work = await candidate();
  const read = await reload(work.id);
  const refreshed = await refreshObservation(work.id);
  assert.notEqual(read.revision, refreshed.revision);
  const calls: string[][] = [];
  const merged = await mergeExecutor(config, snapshot, transport(coordinator), executor(), randomUUID(), github(calls))(read) as { result: string };
  assert.match(merged.result, /merge requested/);
  assert.equal((await events(work.id, 'merge.execution.acquired')).length, 1, 'the merge acquired its execution despite the revision bump');
  assert.equal((await events(work.id, 'merge.execution.committed')).length, 1);
  assert.equal(calls.filter(args => args[1] === '--method').length, 1, 'the provider merge was called');

  // The engine's check: the revision moves between the executor's final read and the grant it asks for.
  const second = await candidate();
  let bumped = 0;
  const raced = await mergeExecutor(config, snapshot, transport(coordinator, async workId => { await refreshObservation(workId); bumped++; }), executor(), randomUUID(), github())(await reload(second.id)) as { result: string };
  assert.equal(bumped, 1); assert.match(raced.result, /merge requested/);
  const acquired = await events(second.id, 'merge.execution.acquired');
  assert.equal(acquired.length, 1, 'the engine granted the execution on the unchanged binding');
  // The engine directly, with a revision two writes stale: granted on the binding, refused on any moved field.
  const third = await candidate();
  const stale = third.revision; await refreshObservation(third.id); await refreshObservation(third.id);
  const binding = { expectedRevision: stale, sha: head, baseSha: base, policyRevision: third.policyRevision, queueTip: head, executor: 'engine-direct' };
  await assert.rejects(engine.acquireMerge(coordinator, third.id, { ...binding, sha: otherSha }, id()), /Merge binding changed before merge execution; retry/, 'a moved head SHA is refused');
  await assert.rejects(engine.acquireMerge(coordinator, third.id, { ...binding, baseSha: otherSha }, id()), /Merge binding changed before merge execution; retry/, 'a moved base is refused');
  await assert.rejects(engine.acquireMerge(coordinator, third.id, { ...binding, policyRevision: third.policyRevision + 1 }, id()), /Merge binding changed before merge execution; retry/, 'a moved policy revision is refused');
  await assert.rejects(engine.acquireMerge(coordinator, third.id, { ...binding, queueTip: otherSha }, id()), /Merge binding changed before merge execution; retry/, 'a moved queue tip is refused');
  const granted = await engine.acquireMerge(coordinator, third.id, binding, id());
  assert.equal(granted.execution.sha, head); assert.equal(granted.execution.authorizationRevision, (await reload(third.id)).revision - 1, 'the execution records the revision it was granted at');
  await engine.cancelMerge(coordinator, third.id, { executionId: granted.execution.id, reason: 'engine-direct check done', executor: 'engine-direct' }, id());

  // The master's checks refuse, as a race, a read whose head, base or policy revision has since moved.
  for (const [field, path, value] of [['sha', '{candidate,sha}', JSON.stringify(otherSha)], ['baseSha', '{candidate,baseSha}', JSON.stringify(otherSha)], ['policyRevision', '{policyRevision}', String(third.policyRevision + 1)]] as const) {
    const item = await candidate();
    const before = await reload(item.id);
    await store!.pool.query('UPDATE work_items SET document=jsonb_set(document,$2::text[],$3::jsonb) WHERE id=$1', [item.id, path, value]);
    const providerCalls: string[][] = [];
    const refusal = await mergeExecutor(config, snapshot, transport(coordinator), executor(), randomUUID(), github(providerCalls))(before).then(() => null, (error: Error) => error);
    assert.ok(refusal, `a moved ${field} is refused`);
    assert.match(refusal!.message, new RegExp(`changed before GitHub verification \\(.*${field}.*\\); retry`), refusal!.message);
    assert.ok(mergeRace(refusal), 'the refusal is a race the loop re-reads and retries');
    assert.equal((await events(item.id, 'merge.execution.acquired')).length, 0, `no execution is acquired when ${field} moved`);
    assert.equal(providerCalls.length, 0, 'GitHub is not asked');
  }
});

// ---- unit: the loop's merge step with fabricated items and a stubbed guarded merge -----------------
const at = '2026-09-24T23:30:00.000Z';
function item(key: string, overrides: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 168, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  return { id: `id-${key}`, key, title: key, description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'], criteria: [],
    policy: { checks: ['test'], review: true }, stage: 'merge', revision: 40, policyRevision: 2, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 168 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], at },
    blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'merge', passed: true, reasons: [] }], violations: [], ...overrides } as Work;
}
const raceError = (key: string) => new Error(`${key} changed before GitHub verification (authorization); retry`);
function effects(read: () => Work[], merge: (work: Work) => Promise<unknown>, extra: Partial<DaemonEffects> = {}): DaemonEffects & { merges: Work[] } {
  const merges: Work[] = [];
  return { merges, agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: read(), now: at }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async work => { merges.push(work); return merge(work); },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at, reason: 'none', deployed: [], pending: [] }), recordDeployment: async () => ({}), requestSmoke: () => {}, persist: async () => {}, ...extra };
}
const mergeAction = (state: DaemonState, work: Work) => Object.entries(state.actions).find(([key]) => key.startsWith(`merge:${work.id}:`))?.[1];

test('unit:merge-race-retried-immediately — two racing refusals are re-read and retried in the same cycle and the third call merges; a persistent non-race refusal still backs off', async () => {
  const work = item('GY-168');
  let calls = 0, reads = 0;
  const racing = effects(() => [work], async target => { if (++calls <= 2) throw raceError(target.key); return { result: 'merge requested' }; },
    { readItem: async () => { reads++; return { ...work, revision: work.revision + reads }; } });
  const state = emptyDaemonState(config);
  const cycle = await runCycle(config, state, racing);
  assert.equal(racing.merges.length, 3, 'the guarded merge was asked three times in one cycle');
  assert.deepEqual(racing.merges.map(entry => entry.revision), [41, 42, 43], 'each retry is asked from a fresh read, not the cycle snapshot');
  const done = cycle.actions.find(action => action.kind === 'merge')!;
  assert.equal(done.state, 'done', done.detail); assert.match(done.detail, /after 2 immediate retries of a racing write/);
  assert.equal(done.attempts, 1, 'the races were not counted as attempts');
  assert.ok(mergeRaceRetries >= 2);

  // A race that outlasts the immediate retries is retried next cycle, without widening the backoff.
  const endless = effects(() => [work], async target => { throw raceError(target.key); }, { readItem: async () => work });
  const racedState = emptyDaemonState(config);
  await runCycle(config, racedState, endless);
  assert.equal(endless.merges.length, 1 + mergeRaceRetries, 'the retries are bounded within the cycle');
  const raced = mergeAction(racedState, work)!;
  assert.equal(raced.state, 'failed'); assert.equal(raced.attempts, 0, 'a race never counts toward the exponential backoff');
  assert.ok(readyToRetry(raced, racedState.cycle + 1), 'the item is attempted again on the very next cycle');

  // A refusal that is not a race backs off exponentially as before.
  const refusing = effects(() => [work], async target => { throw new Error(`${target.key} does not have a current all-gates-passing merge authorization`); }, { readItem: async () => work });
  const refusedState = emptyDaemonState(config);
  await runCycle(config, refusedState, refusing);
  assert.equal(refusing.merges.length, 1, 'a non-race refusal is not retried within the cycle');
  assert.equal(mergeAction(refusedState, work)!.attempts, 1);
  await runCycle(config, refusedState, refusing);
  assert.equal(refusing.merges.length, 2, 'the first retry waits one cycle');
  assert.equal(mergeAction(refusedState, work)!.attempts, 2);
  await runCycle(config, refusedState, refusing);
  assert.equal(refusing.merges.length, 2, 'after the second refusal the retry waits two cycles: backed off');
  await runCycle(config, refusedState, refusing);
  assert.equal(refusing.merges.length, 3);
});

test('unit:queue-position-not-attempted — with two queued candidates only position 1 is asked to merge; the entry behind neither fails nor accrues backoff', async () => {
  const first = item('GY-168');
  const second = item('GY-186', { gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'merge', passed: false, reasons: ['Merge queue position 2 of 2: GY-168 is ahead'] }] });
  const loop = effects(() => [first, second], async () => ({ result: 'merge requested' }), { readItem: async work => work.id === first.id ? first : second });
  const state = emptyDaemonState(config);
  for (let cycle = 0; cycle < 3; cycle++) await runCycle(config, state, loop);
  assert.ok(loop.merges.length >= 1);
  assert.deepEqual([...new Set(loop.merges.map(work => work.key))], ['GY-168'], 'only position 1 is attempted');
  assert.equal(mergeAction(state, second), undefined, 'the entry behind records no merge action: no failure, no backoff');
  assert.equal(Object.values(state.actions).filter(action => action.work === 'GY-186' && action.state === 'failed').length, 0);

  // The same holds when the cycle snapshot showed it mergeable but the fresh read finds it queued behind.
  const late = item('GY-187');
  const queuedNow = { ...late, gates: [{ name: 'merge', passed: false, reasons: ['Waiting for GY-168 to publish its speculative tip'] }] } as Work;
  const behind = effects(() => [late], async () => ({ result: 'merge requested' }), { readItem: async () => queuedNow });
  const behindState = emptyDaemonState(config);
  await runCycle(config, behindState, behind);
  assert.equal(behind.merges.length, 0, 'the fresh read shows its queue position, so it is not attempted');
  assert.equal(mergeAction(behindState, late), undefined);
});

test('unit:merge-uses-fresh-read — a write to a mergeable item after the cycle snapshot and before the merge step does not cost the attempt: the merge proceeds in that cycle from a fresh read', async () => {
  // The store the loop reads: the cycle snapshot is taken, then the item is written to (an
  // observation refresh bumps its revision) before the merge step runs.
  let stored = item('GY-168');
  const snapshotRevision = stored.revision;
  let snapshots = 0;
  // The guarded merge as it stood before GY-192 would refuse anything but the item as it is now.
  const strict = async (target: Work) => { if (target.revision !== stored.revision) throw raceError(target.key); return { result: 'merge requested' }; };
  const loop = effects(() => [stored], strict, {
    snapshot: async () => {
      snapshots++;
      const cycleRead = { work: [stored], now: at };
      // The write lands after the cycle has read its snapshot.
      stored = { ...stored, revision: stored.revision + 1, observation: { ...stored.observation!, at: new Date(Date.parse(at) + 5_000).toISOString() } };
      return cycleRead;
    },
    readItem: async work => work.id === stored.id ? stored : null,
  });
  const state = emptyDaemonState(config);
  const cycle = await runCycle(config, state, loop);
  assert.equal(snapshots, 1, 'one cycle snapshot was taken');
  assert.equal(loop.merges.length, 1, 'the merge was asked once, and did not race');
  assert.equal(loop.merges[0].revision, snapshotRevision + 1, 'the merge was asked from the item as written after the snapshot');
  const action = cycle.actions.find(entry => entry.kind === 'merge')!;
  assert.equal(action.state, 'done', action.detail); assert.doesNotMatch(action.detail, /retr/);
});
