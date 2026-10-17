import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { recordLegacyMerger } from './helpers/legacy-merger.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import * as githubModule from '../src/github.js';
import { CHECK_NAME, GitHub } from '../src/github.js';
import * as mergerMode from '../src/merger-mode.js';
import { mergeOne, mergeQueue, mergeRecordKinds, type MergePorts } from '../src/merge-writer/executor.js';
import { recordMergeEvent } from '../src/server/merge-record.js';
import * as mergeSettings from '../src/server/routes/merge-settings.js';
import { emptyDaemonState, daemonStateSchema, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { mergeWriterIdle } from '../src/daemon/cycle-merge-writer.js';
import { masterConfigSchema } from '../src/master.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-1927: automatic merging off (`master init --no-auto-merge`) holds every gate-passing candidate
// until an applied, independently approved merge decision binds its exact head, base and policy
// revision. Checks keep publishing as they would. Each test is named for the proof it produces.
// The new exports are read through their namespaces, so the file still loads (and each case fails) against a base without them.
const { observeMerge, AutoMergeSettings, autoMergeEventKind = 'policy.auto-merge.set', autoMergeStatus, mergeHold, mergeHolds, recordedAutoMerge, mergeSettingsRoutes } = { ...githubModule, ...mergerMode, ...mergeSettings } as any;

const admin: Principal = { id: 'operator', role: 'admin' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const head = 'a'.repeat(40), base = 'b'.repeat(40), other = 'c'.repeat(40), pushed = 'd'.repeat(40);
const pullRequestId = 'PR_kwDOgraphyard1927';
let database: EmbeddedPostgres, store: Store, engine: Engine, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1927;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('merge-hold'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  url = `postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`;
  store = new Store(url); await store.init(); await recordLegacyMerger(store);
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.principals = [admin, coordinator];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

/** A control-plane restart: a new store and engine over the same database. */
async function restart() {
  await store.close();
  store = new Store(url); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.principals = [admin, coordinator];
}
const setAutoMerge = (autoMerge: boolean, actor: Principal = admin) => new AutoMergeSettings(store).change(actor, { autoMerge, reason: `test sets automatic merging ${autoMerge ? 'on' : 'off'}` }, randomUUID());

/** A real item on the store, its document every gate passing for `sha` (the observation job's view of a mergeable head). */
async function mergeable(sha = head, overrides: Partial<Work> = {}): Promise<Work> {
  const created = await engine.execute(admin, 'create', null, { title: 'Held merge', plannedFiles: ['src/held.ts'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, randomUUID());
  const candidate = { sha, baseSha: base, pr: 42, branch: `graphyard/${created.key.toLowerCase()}-1`, author: 'worker' };
  const work = { ...created, stage: 'merge', ready: true, epoch: 1, policyRevision: 2, candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false,
    observation: { at: new Date().toISOString(), candidate, reviews: [], checks: [], protected: true, mergeable: true, merged: false, prState: 'open', draft: false, baseTip: base } as unknown as Observation,
    blocker: null, gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: true, reasons: [] })), violations: [], ...overrides } as Work;
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify(work)]);
  return work;
}
const withCandidate = (work: Work, sha: string): Work => ({ ...work, candidate: { ...work.candidate!, sha }, observation: { ...work.observation!, candidate: { ...work.candidate!, sha } } as Observation });

type Mode = 'queue' | 'clean' | 'blocked';
/**
 * GitHub that would accept every merge call: a merge queue (`queue`), or none with the pull request
 * CLEAN (a head-bound merge) or BLOCKED (auto-merge). Every write is counted; `armed` starts the
 * pull request queued or auto-merge armed, as a hold that took effect late finds it.
 */
function fakeGitHub(mode: Mode, armed: 'queued' | 'auto-merge' | 'none' = 'none', onQueueRead?: () => Promise<void>) {
  const runs: any[] = [], writes: string[] = [];
  let state = armed, currentHead = head;
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used' });
  github.request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'POST' && path === '/check-runs') { writes.push(`check ${body.conclusion}`); const run = { ...body, id: 77 + runs.length, app: { id: 1234 } }; runs.push(run); return run; }
    if (method === 'PATCH' && path.startsWith('/check-runs/')) { writes.push(`check ${body.conclusion}`); const run = runs.find(entry => entry.id === Number(path.slice('/check-runs/'.length))); if (run) Object.assign(run, body); return run ?? { id: 77 }; }
    if (method !== 'GET') { writes.push(`${method} ${path}`); return { id: 77 }; }
    if (path === '/pulls/42') return { number: 42, state: 'open', draft: false, head: { sha: currentHead }, base: { ref: 'main', sha: base } };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: 'e'.repeat(40) } } };
    const listing = /^\/commits\/([a-f0-9]{40})\/check-runs\?check_name=([^&]+)&.*page=1$/.exec(path);
    if (listing) return { check_runs: runs.filter(run => run.head_sha === listing[1] && run.name === decodeURIComponent(listing[2])) };
    if (path.includes('/check-runs')) return { check_runs: [] };
    throw new Error(`Unexpected GitHub request ${method} ${path}`);
  };
  github.graphql = async (query: string, variables: Record<string, unknown>) => {
    const operation = /(enqueuePullRequest|dequeuePullRequest|enablePullRequestAutoMerge|disablePullRequestAutoMerge|mergePullRequest|mergeQueue\(branch)/.exec(query)?.[1] ?? 'unknown';
    if (operation === 'mergeQueue(branch' && onQueueRead) { const hook = onQueueRead; onQueueRead = undefined; await hook(); }
    if (operation === 'mergeQueue(branch') return { repository: { mergeQueue: mode === 'queue' ? { id: 'MQ_1' } : null,
      pullRequest: { id: pullRequestId, headRefOid: currentHead, mergeStateStatus: mode === 'clean' ? 'CLEAN' : 'BLOCKED', isInMergeQueue: state === 'queued',
        autoMergeRequest: state === 'auto-merge' ? { enabledAt: new Date().toISOString() } : null, mergeQueueEntry: state === 'queued' ? { state: 'AWAITING_CHECKS', position: 1, headCommit: null } : null } } };
    writes.push(operation);
    if (operation === 'enqueuePullRequest') state = 'queued';
    if (operation === 'enablePullRequestAutoMerge') state = 'auto-merge';
    if (operation === 'dequeuePullRequest' || operation === 'disablePullRequestAutoMerge') state = 'none';
    return {};
  };
  const merges = () => writes.filter(write => ['enqueuePullRequest', 'enablePullRequestAutoMerge', 'mergePullRequest'].includes(write) || /\/merge/.test(write));
  const checks = () => runs.filter(run => run.name === CHECK_NAME).map(run => ({ head: run.head_sha, conclusion: run.conclusion, title: run.output?.title, summary: run.output?.summary }));
  return { github, writes, merges, checks, at: (sha: string) => { currentHead = sha; } };
}
const requests = async (work: Work) => Number((await store.pool.query("SELECT count(*) FROM events WHERE work_id=$1 AND kind='merge.enqueue.requested'", [work.id])).rows[0].count);
const ledger = async (work: Work, kind: string) => Number((await store.pool.query('SELECT count(*) FROM events WHERE work_id=$1 AND kind=$2', [work.id, kind])).rows[0].count);
/** One observation's merge step, as processJob runs it, its queue state recorded as the job records it. */
async function observe(fake: ReturnType<typeof fakeGitHub>, work: Work) {
  const gated = await observeMerge(engine, fake.github, work);
  if (gated.state) await engine.recordGitHubQueue(work.id, gated.state, gated.action);
  return gated;
}
/** The control-plane merge writer's queue over the coordination view's documents, holds annotated as the route serves them. */
async function writerQueue(work: Work[]) {
  const holds = await mergeHolds(store.pool, work);
  const served = work.map(item => ({ ...item, observation: { ...item.observation!, source: 'control-plane' }, ...(holds.get(item.id) ? { mergeHold: holds.get(item.id) } : {}) }) as Work);
  return mergeQueue(served, {}, Date.now());
}
/**
 * The control-plane merge writer's ports over this store: every git and landing call counted, each
 * record posted to the plane's merge-record route, and the hold read from the plane as
 * `GET /api/auto-merge?work=ID` answers it. `during` runs inside the trial.
 */
function writerPorts(options: { hold?: boolean; during?: () => Promise<void> } = {}) {
  const calls = { fetch: 0, merge: 0, trial: 0, push: 0, hold: 0, records: [] as string[] };
  const route = mergeSettingsRoutes?.routes.find((entry: any) => entry.method === 'GET' && entry.path === '/api/auto-merge');
  const ports: MergePorts = {
    baseBranch: 'main', retrials: 1, now: Date.now,
    fetch: async () => { calls.fetch += 1; return base; },
    merge: async () => { calls.merge += 1; return { mergeSha: pushed, files: ['src/held.ts'] }; },
    trial: async () => { calls.trial += 1; await options.during?.(); return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['tests/held.test.ts'], proofs: {} }; },
    push: async () => { calls.push += 1; return 'pushed'; },
    holds: async () => false,
    record: async (item, event) => { calls.records.push(event.kind); return recordMergeEvent({ engine } as any, coordinator, item.id, event, randomUUID()); },
    ...(options.hold === false ? {} : { hold: async (item: Pick<Work, 'id'>) => { calls.hold += 1; return (await route.handle({ actor: coordinator, url: new URL(`http://plane/api/auto-merge?work=${item.id}`), services: { engine }, operatorVisible: (work: Work[]) => work })).hold; } }),
  };
  return { ports, calls };
}
const loopConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 1 } } });
/** One cycle of the real loop over this store's items as the coordination view serves them, the writer's GitHub double refusing every call. */
async function loopCycle(state: ReturnType<typeof emptyDaemonState>, ports: MergePorts, work: Work[]) {
  const github = new Proxy({}, { get: (_, name) => { throw new Error(`the loop called GitHub (${String(name)})`); } });
  const served = async () => {
    const documents = (await store.pool.query('SELECT document FROM work_items WHERE id=ANY($1::uuid[])', [work.map(item => item.id)])).rows.map(row => ({ ...row.document, observation: { ...row.document.observation, source: 'control-plane' } }) as Work);
    const holds = await mergeHolds(store.pool, documents);
    return documents.map(item => holds.get(item.id) ? { ...item, mergeHold: holds.get(item.id) } : item);
  };
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: await served(), now: new Date().toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github, merge: github, shadow: null, mergeWriter: { ...ports, merger: async () => 'control-plane' }, decide: async () => ({ id: randomUUID() }) } as unknown as DaemonEffects;
  await runCycle(loopConfig, state, effects, () => Date.now());
  await mergeWriterIdle(state);
}
/** A merge decision's ledger entries, as the decision routes write them. */
async function decision(work: Work, input: { sha: string; baseSha: string; policyRevision: number }, parties: { requester: string; approver: string | null; applied?: boolean }) {
  const id = randomUUID(), insert = (actor: string, kind: string, payload: object) => store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor, kind, JSON.stringify(payload)]);
  await insert(parties.requester, 'decision.requested', { id, action: 'merge', input, reason: 'merge this candidate' });
  if (parties.approver) await insert(parties.approver, 'decision.approved', { id, action: 'merge', reason: 'approved', requestedBy: parties.requester, approver: { id: parties.approver, role: 'operator-agent' } });
  if (parties.approver && parties.applied !== false) await insert(parties.approver, 'decision.applied', { id, outcome: 'Merge approved' });
  return id;
}

test('unit:auto-merge-default-unchanged — a plane that never recorded the setting merges on gates alone, its status says so, and the merge path is as before', async () => {
  // First in the file: this store has never recorded the setting.
  assert.equal((await store.pool.query('SELECT count(*) FROM events WHERE kind=$1', [autoMergeEventKind])).rows[0].count, '0');
  const status = await autoMergeStatus(store.pool);
  assert.deepEqual({ autoMerge: status.autoMerge, setBy: status.setBy, line: status.line }, { autoMerge: true, setBy: null, line: 'routine merges permitted after gates pass' });
  for (const [mode, write] of [['queue', 'enqueuePullRequest'], ['clean', 'mergePullRequest'], ['blocked', 'enablePullRequestAutoMerge']] as const) {
    const work = await mergeable(), fake = fakeGitHub(mode);
    const gated = await observe(fake, work);
    assert.equal(gated.action.kind, 'enqueue'); assert.equal(gated.hold, null);
    assert.deepEqual(fake.merges(), [write]);
    assert.equal(await requests(work), 1, 'the merge request is recorded once per head');
    await observe(fake, work);
    assert.equal(await requests(work), 1);
    assert.ok(await ledger(work, 'merge.enqueued') >= 1, 'each enqueue is recorded as before');
    assert.deepEqual([...(await mergeHolds(store.pool, [work])).values()], [null]);
    assert.equal((await writerQueue([work])).next?.id, work.id, 'the merge writer merges it as before');
  }
});

test('unit:no-auto-merge-holds-gate-passing-candidate — with automatic merging off a gate-passing head publishes the same success and gets no merge request, enqueue, auto-merge, head-bound merge or merge-writer start, however often it is observed', async () => {
  // The control: automatic merging on, one fresh item per GitHub mode, each merged by GitHub's own path.
  const published: Record<Mode, unknown> = { queue: null, clean: null, blocked: null };
  for (const mode of ['queue', 'clean', 'blocked'] as const) {
    const work = await mergeable(), fake = fakeGitHub(mode);
    await observe(fake, work);
    assert.equal(fake.merges().length, 1, `${mode}: automatic merging hands the head to GitHub`);
    assert.equal(await requests(work), 1);
    published[mode] = fake.checks().map(check => ({ ...check, summary: check.summary?.replace(work.key, 'KEY') }));
  }
  await setAutoMerge(false);
  for (const mode of ['queue', 'clean', 'blocked'] as const) {
    const work = await mergeable(), fake = fakeGitHub(mode);
    for (let run = 0; run < 3; run++) {
      const gated = await observe(fake, work);
      assert.equal(gated.action.kind, 'hold');
      assert.match(gated.action.reason, /automatic merging is off/);
    }
    assert.equal(await requests(work), 0, `${mode}: no merge.enqueue.requested is recorded`);
    assert.deepEqual(fake.merges(), [], `${mode}: no enqueue, auto-merge or head-bound merge`);
    assert.deepEqual(fake.writes.filter(write => !write.startsWith('check')), [], `${mode}: GitHub receives no write but the check`);
    assert.deepEqual(fake.checks().slice(0, 1).map(check => ({ ...check, summary: check.summary?.replace(work.key, 'KEY') })), published[mode], `${mode}: the published conclusion and summary are those automatic merging publishes`);
    assert.ok(fake.checks().every(check => check.conclusion === 'success' && check.head === head));
    const writer = await writerQueue([work]);
    assert.equal(writer.next, null, `${mode}: the control-plane merge writer starts no merge`);
    assert.deepEqual(writer.queue, []);
  }
  await setAutoMerge(true);
  // Authorization read before the hold was recorded lands nothing. A hold recorded between the
  // observation's first read and its merge request: no request, and GitHub is asked for nothing.
  {
    const work = await mergeable(), fake = fakeGitHub('blocked');
    const enqueueRequest = engine.enqueueRequest.bind(engine);
    let once = true;
    (engine as any).enqueueRequest = async (...args: any[]) => { if (once) { once = false; await setAutoMerge(false); } return (enqueueRequest as any)(...args); };
    try { await observe(fake, work); } finally { (engine as any).enqueueRequest = enqueueRequest; }
    assert.equal(await requests(work), 0, 'the request transaction reads the hold again and records nothing');
    assert.deepEqual(fake.merges(), []);
    await setAutoMerge(true);
  }
  // A hold recorded while the observation awaits GitHub, after the merge request: no enqueue, auto-merge or head-bound merge follows, then or after.
  for (const mode of ['queue', 'clean', 'blocked'] as const) {
    const work = await mergeable(), fake = fakeGitHub(mode, 'none', async () => { await setAutoMerge(false); });
    const gated = await observe(fake, work);
    assert.equal(gated.action.kind, 'hold', `${mode}: the write is refused at its boundary`);
    assert.match(gated.action.reason, /automatic merging is off/);
    const requested = await requests(work);
    for (let run = 0; run < 3; run++) await observe(fake, work);
    assert.deepEqual(fake.merges(), [], `${mode}: GitHub is asked to merge nothing`);
    assert.equal(await requests(work), requested, `${mode}: no merge request follows the hold`);
    await setAutoMerge(true);
  }
  // The control-plane writer, a head selected from a snapshot served before the hold: it asks the
  // plane before it opens the merge, and makes no git, trial, push or record call.
  const intents = async (work: Work) => ledger(work, mergeRecordKinds.intent);
  {
    const work = await mergeable(), selected = (await writerQueue([work])).next!;
    assert.equal(selected.id, work.id, 'automatic merging on, the writer selects the head');
    await setAutoMerge(false);
    const asked = writerPorts();
    const outcome = await mergeOne(asked.ports, selected);
    assert.equal(outcome.outcome, 'requeued');
    assert.match((outcome as { reason: string }).reason, /automatic merging is off/);
    assert.deepEqual(asked.calls, { fetch: 0, merge: 0, trial: 0, push: 0, hold: 1, records: [] }, 'the merge-writer makes no landing call');
    // A writer that does not ask (an older loop) is refused its intent by the plane, before any trial or push.
    const blind = writerPorts({ hold: false });
    await assert.rejects(mergeOne(blind.ports, selected), (error: any) => error.status === 409 && /automatic merging is off/.test(error.message));
    assert.deepEqual([blind.calls.trial, blind.calls.push, blind.calls.records], [0, 0, ['intent']]);
    assert.equal(await intents(work), 0, 'the plane records no intent under the hold');
    await setAutoMerge(true);
  }
  // A hold recorded while the trial runs: the push is refused at the landing boundary and the refusal recorded once.
  {
    const work = await mergeable(), late = writerPorts({ during: async () => { await setAutoMerge(false); } });
    const outcome = await mergeOne(late.ports, work);
    assert.equal(outcome.outcome, 'requeued');
    assert.deepEqual([late.calls.trial, late.calls.push, late.calls.hold, late.calls.records], [1, 0, 2, ['intent', 'trial', 'refused']], 'nothing is pushed under the hold');
    assert.equal(await ledger(work, mergeRecordKinds.refused), 1);
    await setAutoMerge(true);
  }
});

test('unit:no-auto-merge-hold-survives-restart — the hold is an attributed, append-only setting only an admin or coordinator writes, read in status, and it still holds the same head after a restart', async () => {
  for (const role of ['worker', 'producer', 'reader', 'operator-agent', 'slice-lead'] as const) {
    await assert.rejects(setAutoMerge(false, { id: `${role}-1`, role } as Principal), (error: any) => error.status === 403 && /admin or coordinator credential/.test(error.message), `${role} cannot set it`);
  }
  assert.equal((await recordedAutoMerge(store.pool)).autoMerge, true, 'a refused write changes nothing');
  const set = await setAutoMerge(false, coordinator);
  assert.equal(set.autoMerge, false); assert.equal(set.setBy, coordinator.id); assert.match(set.reason!, /automatic merging off/);
  assert.match(set.line, /each merge needs an approved merge decision/);
  const again = await setAutoMerge(false, admin);
  assert.equal(again.event, set.event, 'an unchanged value writes nothing');
  const work = await mergeable(), fake = fakeGitHub('blocked');
  await observe(fake, work);
  await restart();
  const status = await new AutoMergeSettings(store).status({ id: 'reader-1', role: 'reader' });
  assert.equal(status.autoMerge, false, 'the setting is read back after a restart');
  assert.equal((await autoMergeStatus(store.pool)).setBy, coordinator.id);
  for (let run = 0; run < 3; run++) await observe(fake, work);
  assert.equal(await requests(work), 0);
  assert.deepEqual(fake.merges(), [], 'after a restart with the same store the head is still held');
  assert.equal((await writerQueue([work])).next, null);
  // The plane's route answers the hold for the item after the restart, as the writer reads it.
  const route = mergeSettingsRoutes.routes.find((entry: any) => entry.method === 'GET' && entry.path === '/api/auto-merge');
  const answered = await route.handle({ actor: coordinator, url: new URL(`http://plane/api/auto-merge?work=${work.id}`), services: { engine }, operatorVisible: (items: Work[]) => items });
  assert.equal(answered.autoMerge, false); assert.match(answered.hold, /automatic merging is off/);
  // A loop restart: the real loop's cycles run the writer over the held head, the loop's state
  // persisted and read back between them, and the writer makes no git, trial, push or record call.
  const writer = writerPorts();
  let state = emptyDaemonState(loopConfig);
  for (let cycle = 0; cycle < 6; cycle++) {
    if (cycle === 3) state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state)));
    await loopCycle(state, writer.ports, [work]);
  }
  assert.deepEqual(writer.calls, { fetch: 0, merge: 0, trial: 0, push: 0, hold: 0, records: [] }, 'across loop restarts the writer lands nothing');
  assert.equal(await requests(work), 0);
  // The control: the same loop over an item no hold stands over (its decision releases it) opens the merge and pushes.
  const control = await mergeable();
  await decision(control, { sha: head, baseSha: base, policyRevision: 2 }, { requester: 'master-agent', approver: 'approver-agent' });
  const released = writerPorts();
  await loopCycle(state, released.ports, [control]);
  assert.deepEqual([released.calls.hold, released.calls.trial, released.calls.push], [2, 1, 1], 'the loop reaches the writer, which asks twice and pushes the released head');
  await setAutoMerge(true);
  const history = (await store.pool.query('SELECT actor, payload FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq', [autoMergeEventKind])).rows;
  assert.deepEqual(history.slice(-2).map(row => [row.actor, row.payload.autoMerge, row.payload.previous]), [[coordinator.id, false, true], [admin.id, true, false]], 'every change is appended, attributed, with what it replaced');
});

test('unit:no-auto-merge-hold-withdraws-armed-pr — a pull request armed for auto-merge or queued when the hold takes effect is withdrawn once', async () => {
  for (const [mode, armed, take] of [['blocked', 'auto-merge', 'disablePullRequestAutoMerge'], ['queue', 'queued', 'dequeuePullRequest']] as const) {
    const work = await mergeable(), fake = fakeGitHub(mode, armed);
    await setAutoMerge(false);
    for (let run = 0; run < 3; run++) await observe(fake, work);
    assert.deepEqual(fake.writes.filter(write => !write.startsWith('check')), [take], `${armed}: GitHub is asked once to take the merge back`);
    assert.equal(await ledger(work, 'merge.dequeued'), 1, `${armed}: the withdrawal is recorded once`);
    assert.deepEqual(fake.merges(), []);
    await setAutoMerge(true);
  }
});

test('unit:merge-decision-releases-exact-candidate-only — only an applied, independently approved merge decision bound to the current head, base and policy revision releases the candidate, and a new head is held again', async () => {
  await setAutoMerge(false);
  const work = await mergeable(), bound = { sha: head, baseSha: base, policyRevision: 2 };
  await decision(work, { ...bound, sha: other }, { requester: 'master-agent', approver: 'approver-agent' });
  await decision(work, { ...bound, baseSha: other }, { requester: 'master-agent', approver: 'approver-agent' });
  await decision(work, { ...bound, policyRevision: 3 }, { requester: 'master-agent', approver: 'approver-agent' });
  await decision(work, bound, { requester: 'master-agent', approver: null });
  await decision(work, bound, { requester: 'master-agent', approver: 'approver-agent', applied: false });
  await decision(work, bound, { requester: 'master-agent', approver: 'master-agent' });
  const fake = fakeGitHub('blocked');
  await observe(fake, work);
  assert.deepEqual(fake.merges(), [], 'another head, base or policy revision, an unapproved, unapplied or self-approved decision releases nothing');
  assert.equal((await writerQueue([work])).next, null);
  // A bystander gate-passing item with no decision stays held while the released one proceeds.
  const bystander = await mergeable();
  await decision(work, bound, { requester: 'master-agent', approver: 'approver-agent' });
  const gated = await observe(fake, work);
  assert.equal(gated.action.kind, 'enqueue', 'the released candidate proceeds through its ordinary merge path');
  assert.deepEqual(fake.merges(), ['enablePullRequestAutoMerge']);
  assert.equal(await requests(work), 1);
  const writer = await writerQueue([work, bystander]);
  assert.deepEqual(writer.queue.map(entry => entry.key), [work.key], 'the merge writer queues the released candidate alone');
  const bystanderFake = fakeGitHub('blocked');
  await observe(bystanderFake, bystander);
  assert.deepEqual(bystanderFake.merges(), [], 'the decision releases no other item');
  // A new head after the decision is held again, and what GitHub armed for the old one is withdrawn.
  const moved = withCandidate(work, pushed);
  fake.at(pushed);
  const next = await observe(fake, moved);
  assert.equal(next.action.kind, 'dequeue');
  assert.match(next.action.reason, /automatic merging is off/);
  assert.equal((await writerQueue([moved])).next, null);
  // Automatic merging on restores today's behaviour for every item.
  await setAutoMerge(true);
  const restored = fakeGitHub('blocked');
  await observe(restored, bystander);
  assert.deepEqual(restored.merges(), ['enablePullRequestAutoMerge']);
  assert.equal((await writerQueue([moved, bystander])).queue.length, 2);
});
