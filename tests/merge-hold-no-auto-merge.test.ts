import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { recordLegacyMerger } from './helpers/legacy-merger.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { CHECK_NAME, GitHub, observeMerge } from '../src/github.js';
import { AutoMergeSettings, autoMergeEventKind, autoMergeStatus, mergeHolds, recordedAutoMerge } from '../src/merger-mode.js';
import { mergeQueue } from '../src/merge-writer/executor.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-1927: automatic merging off (`master init --no-auto-merge`) holds every gate-passing candidate
// until an applied, independently approved merge decision binds its exact head, base and policy
// revision. Checks keep publishing as they would. Each test is named for the proof it produces.

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
function fakeGitHub(mode: Mode, armed: 'queued' | 'auto-merge' | 'none' = 'none') {
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
