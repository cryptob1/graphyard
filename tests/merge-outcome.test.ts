import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { candidateKey, emptyDaemonState, readyToRetry, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, mergeExecutor, type MasterConfig, type MergeExecutor } from '../src/master.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import { Refusal, type Observation, type Principal, type Work } from '../src/model.js';

/**
 * GY-195: a guarded merge whose provider call ended with an unknown outcome retains its execution.
 * The loop must wait on it — never record it as a merge — until GitHub shows the pull request
 * merged (delivered from the observation, no second provider call) or the execution is cleared
 * (merged again by the guarded path within one cycle). The engine is real, on a disposable
 * Postgres; GitHub is a stub that answers the broker's `gh` calls and counts provider merges.
 */
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['unit:merge-outcome'] };
const head = 'a'.repeat(40), base = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const validProtection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true });
let pg: EmbeddedPostgres, store: Store, engine: Engine;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 195;
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-merge-outcome-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('merge_outcome_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/merge_outcome_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const id = () => randomUUID();
const reload = async (workId: string) => (await store.list()).find(item => item.id === workId)!;
const events = async (workId: string, kind: string) => (await store.pool.query('SELECT payload FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq', [workId, kind])).rows;
const dbNow = async () => ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString();
const observation = (work: Work, extra: Partial<Observation> = {}): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
  protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString(), ...extra });

/** A candidate at the merge stage with every gate passed and its queue tip published. */
async function candidate() {
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Merge outcome ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:merge-outcome'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/merge-outcome-${n}`, branch: `graphyard/gy-195-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 1950 + n }, id());
  // One item at a time is under test; the rest never occupy the queue ahead of it.
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [w.id]);
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, { proof: 'unit:merge-outcome', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, id());
  const speculation: QueueSpeculation = { ref: queueRef(w.key), tip: head, base, baseTree: '7e'.repeat(20), predecessors: [], policyRevision: w.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [w.id, JSON.stringify(speculation)]);
  w = await engine.observe(w.id, (await reload(w.id)).revision, observation(w));
  assert.equal(w.stage, 'merge'); assert.ok(w.gates.every(gate => gate.passed), w.gates.flatMap(gate => gate.reasons).join('; '));
  return w;
}

/** The broker's transport, in process, reporting refusals the way the CLI transport does. */
const transport = (actor: Principal) => async (path: string, data: any, key: string = randomUUID()) => {
  const match = /^work\/([^/]+)\/(merge-(acquire|cancel|verify|commit)|resync)$/.exec(path);
  if (!match) throw new Error(`Unexpected mutation ${path}`);
  const [, workId, , step] = match;
  try {
    // A resync is GitHub read again: a fresh, unmerged observation of the same pull request.
    if (!step) { const current = await reload(workId); return await engine.observe(workId, current.revision, observation(current)); }
    if (step === 'acquire') return await engine.acquireMerge(actor, workId, data, key);
    if (step === 'cancel') return await engine.cancelMerge(actor, workId, data, key);
    if (step === 'commit') return await engine.commitMerge(actor, workId, data, key);
    const replay = await engine.replayMergeVerification(actor, workId, data, key); if (replay) return replay;
    return await engine.verifyMerge(actor, workId, data, { ...observation(await reload(workId)), prState: 'open', draft: false, clockOffset: { min: -1000, max: 0 } }, key);
  } catch (error) {
    if (error instanceof Refusal) throw Object.assign(new Error(JSON.stringify({ error: error.message })), { confirmedRefusal: error.status >= 400 && error.status < 500 });
    throw error;
  }
};

/**
 * GitHub as the broker sees it. `provider` decides each provider merge call: `lost` is the call
 * whose answer never arrives (the connection dropped), `merged` is GitHub merging it.
 */
function github(provider: () => 'lost' | 'merged') {
  const merges: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: head, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args[1]?.includes('/git/ref/heads/')) return JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: base } });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    if (args[1]?.includes('/check-runs')) return JSON.stringify([{ check_runs: [{ name: 'Graphyard / merge', status: 'completed', conclusion: 'success', app: { id: 1234 } }] }]);
    if (args[1] === '--method') {
      merges.push(args);
      if (provider() === 'lost') throw new Error('gh: Post "https://api.github.com/repos/owner/project/pulls/1/merge": read: connection reset by peer');
      return JSON.stringify({ merged: true, sha: mergeSha });
    }
    return JSON.stringify(validProtection);
  };
  return { run, merges };
}

/** The durable loop's effects, with the guarded merge wired to one executor instance exactly as `master run` wires it. */
function daemon(work: Work, executor: MergeExecutor, run: ReturnType<typeof github>['run']): DaemonEffects & { invoked: string[] } {
  const invoked: string[] = [];
  // The loop sees only the item under test; the items earlier tests left at the merge stage are not its concern.
  const snapshot = async () => ({ work: (await store.list()).filter(item => item.id === work.id), now: await dbNow() });
  return { invoked, agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot, closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    // As `master run` wires it: one executor instance, a fresh outer request for every attempt.
    merge: async item => { invoked.push(item.key); return mergeExecutor(config, snapshot, transport(coordinator), executor, randomUUID(), run)(item); },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'none', deployed: [], pending: [] }), recordDeployment: async () => ({}), requestSmoke: () => {}, persist: async () => {} };
}
const loopExecutor = (): MergeExecutor => ({ principal: coordinator.id, instance: `daemon-${randomUUID()}` });
/** One loop cycle, answering the merge action it left for this item. */
async function cycle(state: DaemonState, effects: DaemonEffects, work: Work) {
  await runCycle(config, state, effects);
  return state.actions[candidateKey('merge', work)];
}

test('unit:unknown-outcome-not-done — a retained execution with an unknown provider outcome is waiting, never done, and the loop re-evaluates it every cycle without a second provider call', async () => {
  const work = await candidate();
  const provider = github(() => 'lost');
  const effects = daemon(work, loopExecutor(), provider.run);
  const state = emptyDaemonState(config);
  // Cycle 1: the provider call ends with no answer. The execution is committed and retained.
  let action = await cycle(state, effects, work);
  assert.equal(provider.merges.length, 1, 'the provider merge was called once');
  const retained = (await reload(work.id)).mergeExecution;
  assert.ok(retained?.committingAt, 'the committed execution is retained until observation or expiry');
  assert.equal(action.state, 'waiting', action.detail);
  assert.notEqual(action.state, 'done');
  assert.match(action.detail, /outcome is unknown/);
  assert.equal(readyToRetry(action, state.cycle), true, 'a waiting merge is re-evaluated on the very next cycle');
  // Cycles 2 and 3: mergeWork finds the retained execution and answers pending, not merged.
  for (let pass = 0; pass < 2; pass++) {
    action = await cycle(state, effects, work);
    assert.equal(action.state, 'waiting', action.detail);
    assert.match(action.detail, new RegExp(`provider commit was already recorded for execution ${retained!.id} and its outcome is unknown`));
    assert.doesNotMatch(action.detail, /Guarded merge accepted/);
  }
  assert.deepEqual(effects.invoked, [work.key, work.key, work.key], 'the loop invoked the guarded merge on every cycle');
  assert.equal(provider.merges.length, 1, 'a retained execution is never merged a second time');
  assert.equal(action.attempts, 1, 'one wait is one attempt, whatever the cycles it spans');
  assert.equal((await reload(work.id)).stage, 'merge', 'the item is still at the merge stage, not stranded behind a done action');
});

test('unit:cleared-execution-retried — once the retained execution lapses and is cleared while the pull request is open and every gate passes, the loop merges again within one cycle', async () => {
  const work = await candidate();
  let answer: 'lost' | 'merged' = 'lost';
  const provider = github(() => answer);
  const effects = daemon(work, loopExecutor(), provider.run);
  const state = emptyDaemonState(config);
  let action = await cycle(state, effects, work);
  assert.equal(action.state, 'waiting', action.detail);
  const retained = (await reload(work.id)).mergeExecution!;
  assert.ok(retained.committingAt);
  // The execution's authority lapses with GitHub still showing the pull request open. Only an
  // observation taken after expiry can rule the provider merge out, so the waiting loop asks for
  // one; that observation clears the execution (engine reconciliation).
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{mergeExecution,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [work.id, new Date(Date.now() - 1000).toISOString()]);
  action = await cycle(state, effects, work);
  assert.equal(action.state, 'waiting', action.detail);
  assert.match(action.detail, /authority lapsed, so a fresh observation was requested/);
  const cleared = await reload(work.id);
  assert.equal(cleared.mergeExecution, null, 'the post-expiry observation cleared the retained execution');
  assert.equal(cleared.stage, 'merge'); assert.ok(cleared.gates.every(gate => gate.passed), cleared.gates.flatMap(gate => gate.reasons).join('; '));
  assert.equal(provider.merges.length, 1, 'nothing was merged while the execution was retained');
  // The very next cycle attempts the guarded merge again, and it succeeds.
  answer = 'merged';
  action = await cycle(state, effects, work);
  assert.equal(action.state, 'done', action.detail);
  assert.match(action.detail, /Guarded merge accepted .*merge requested/);
  assert.equal(provider.merges.length, 2, 'a new provider merge was attempted');
  const acquired = await events(work.id, 'merge.execution.acquired');
  assert.equal(acquired.length, 2, 'the retry acquired a new execution');
  const fresh = (await reload(work.id)).mergeExecution!;
  assert.notEqual(fresh.id, retained.id); assert.ok(fresh.committingAt);
  // GitHub's merge, observed, delivers the item on the new execution.
  await delay(5);
  const delivered = await engine.observe(work.id, (await reload(work.id)).revision, observation(work, { merged: true, mergeSha, mergedAt: await dbNow() }));
  assert.equal(delivered.stage, 'done'); assert.equal(delivered.violations.length, 0);
  assert.equal(delivered.delivery?.authorizationRevision, fresh.authorizationRevision);
});

test('unit:unknown-outcome-merged-delivered — an unknown outcome followed by a merged observation is delivered from the observation with no second provider call', async () => {
  const work = await candidate();
  // GitHub merged it, but the answer never reached the broker.
  const provider = github(() => 'lost');
  const effects = daemon(work, loopExecutor(), provider.run);
  const state = emptyDaemonState(config);
  let action = await cycle(state, effects, work);
  assert.equal(action.state, 'waiting', action.detail);
  const retained = (await reload(work.id)).mergeExecution!;
  assert.ok(retained.committingAt);
  // A cycle before GitHub is read again still waits and still does not call the provider.
  action = await cycle(state, effects, work);
  assert.equal(action.state, 'waiting', action.detail);
  // GitHub is observed merged: the item is delivered on the retained execution.
  await delay(5);
  const delivered = await engine.observe(work.id, (await reload(work.id)).revision, observation(work, { merged: true, mergeSha, mergedAt: await dbNow() }));
  assert.equal(delivered.stage, 'done'); assert.equal(delivered.mergeExecution, null); assert.equal(delivered.violations.length, 0);
  assert.equal(delivered.delivery?.mergeSha, mergeSha);
  assert.equal(delivered.delivery?.authorizationRevision, retained.authorizationRevision, 'delivered on the execution whose outcome was unknown');
  // The loop no longer has a merge to make: no further guarded merge and no second provider call.
  await cycle(state, effects, work);
  assert.equal(provider.merges.length, 1, 'no second provider merge call');
  assert.deepEqual(effects.invoked, [work.key, work.key], 'the delivered item is no longer a merge candidate');
  assert.equal((await events(work.id, 'merge.execution.acquired')).length, 1, 'no new execution was acquired');
});
