import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { fileFollowUpThreads, followUpItem, type AppendFollowUpFindings, type CreateFollowUpItem } from '../src/review-threads.js';
import { shipHeldFollowUps, type ShipFollowUps, type ShipRuns } from '../src/reviewer.js';
import { repeatedClientErrorLimit } from '../src/retry-stop.js';
import { followUpEntries, followUpParent, openFollowUpItem, overdueTriage, type TriageJudgement } from '../src/model/machine-backlog.js';
import { foldUnshippedFollowUps, followUpShipReceiptKey, pendingFollowUpsReport } from '../src/model/followups-held.js';
import { buildMasterStatus } from '../src/master/status.js';
import { clearTriageRuns, triageSettled, triageStep, triageTool } from '../src/triage.js';
import { researchSettings } from '../src/research.js';
import { isClosed, type Principal, type Work } from '../src/model.js';
import type { Run, RunOptions, RunResult, Runner } from '../src/runner/types.js';

// GY-845: an approval's follow-ups on an item still in review were filed at once as an item that
// depended on it, so triage judged work nobody could start, and each re-approval during rework could
// file another (2026-09-26: 48 duplicates across 29 parents; GY-430 got GY-730, GY-734 and GY-753 in
// 80 minutes). The findings are now held on the parent until it ships, and only then become its one
// follow-up item; a parent never has more than one open follow-up item in any stage.
// One case per proof: unit:followups-wait-on-parent, unit:followups-migrate-to-parent,
// unit:triage-skips-unshipped-parent, unit:one-open-followup-any-stage.
const repository = 'owner/followups-after-ship';
const reviewer = 'graphyard-reviewer[bot]';
const operator: Principal = { id: 'ship-operator', role: 'admin', sessionKind: 'ai' };
const coordinator: Principal = { id: 'ship-master', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `ship-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (principal: Principal, path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, path: string, body?: unknown, key?: string) => {
  const result = await call(principal, path, body, key);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (key: string) => (await store.list()).find(item => item.key === key)!;
const followUpsOf = async (parent: string) => (await store.list()).filter(item => followUpParent(item) === parent);
const events = async (work: Work) => (await store.pool.query('SELECT kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows as { kind: string; payload: any }[];
const parentItem = async (title: string) => ok(operator, 'work', { title, plannedFiles: ['src/parent.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:parent'] }] }) as Promise<Work>;
/** Delivered as the observation path records it: terminal, not closed, with its merge. */
async function deliver(work: Work, postMerge?: 'pending' | 'pass') {
  const current = await reload(work.key), mergedAt = new Date().toISOString();
  // An optimistic merge (GY-500) carries main's required suite on its merge commit, as the guard reads it.
  const optimistic = postMerge ? { optimisticMerges: [{ lane: { files: ['src/parent.ts'] }, pr: 845, mergeSha: 'd'.repeat(40), mergedAt, postMerge: { verdict: postMerge, observedAt: mergedAt }, revert: null }] } : {};
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify({ ...current, stage: 'done', closure: null, candidate: { pr: 845, sha: 'c'.repeat(40), baseSha: 'b'.repeat(40) }, delivery: { mergedAt, mergeSha: 'd'.repeat(40), authorizationRevision: current.revision }, ...optimistic })]);
}

/** The loop's three control-plane calls as the dispatcher makes them (src/reviewer.ts), over the real routes. */
const append: AppendFollowUpFindings = async (item, findings, reason, key, parent) => {
  const result = await call(operator, `work/${item}/followups`, { findings, reason, ...(parent ? { parent: true } : {}) }, key);
  if (result.status !== 200) throw Object.assign(new Error(`refused (${result.status}): ${result.body.error}`), { notOpen: result.status === 409 && /not an open follow-up item/.test(result.body.error) });
  return result.body;
};
const create: CreateFollowUpItem = async (item, key) => ok(operator, 'work', { ...item, policy: { checks: ['test'], review: true } }, key);
const ship: ShipFollowUps = async (parent, key) => ok(operator, `work/${parent}/followups`, { ship: true, reason: `${parent} shipped` }, key);

/** GitHub as the loop's gh sees it: each review is the approval of `sha` with its body. */
const reviews = new Map<number, { sha: string; body: string }>();
const gh = (_command: string, args: string[]) => {
  const id = Number(/reviews\/(\d+)$/.exec(args[1] ?? '')?.[1]);
  const review = reviews.get(id);
  if (!review) throw new Error(`unexpected gh ${args.join(' ')}`);
  return JSON.stringify({ id, state: 'APPROVED', commit_id: review.sha, user: { login: reviewer }, submitted_at: '2026-09-30T10:00:00Z', body: review.body });
};
/** One approval of `parent` naming `findings` beyond its criteria, filed as the loop files it: sent to the parent. */
async function approve(parent: Work, reviewId: number, findings: string[]) {
  const sha = String(reviewId).padEnd(40, 'a');
  reviews.set(reviewId, { sha, body: `AC-1 met.\n${findings.map(text => `Follow-up finding: ${text}`).join('\n')}\nFollow-up threads: none` });
  return fileFollowUpThreads({ repository, key: parent.key, workId: parent.id, pr: 845, sha, reviewId, reviewer, existing: parent.key, append }, gh, create, new Date());
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 845;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('followups-ship-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('followups_ship_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/followups_ship_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:followups-wait-on-parent — an approval of an unshipped parent files no item: its findings are held on the parent and listed in master status; delivering the parent files one follow-up item with them, depending on nothing', async () => {
  const parent = await parentItem('Parent waiting');
  const outcome = await approve(parent, 101, ['src/a.ts:10 — the retry is unbounded', 'docs/x.md — stale wording']);
  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.item, parent.key, 'the parent itself took the findings');
  assert.deepEqual(await followUpsOf(parent.key), [], 'no follow-up item exists while the parent has not shipped');
  const held = await reload(parent.key);
  assert.deepEqual(held.pendingFollowUps?.findings.map(finding => finding.text), ['src/a.ts:10 — the retry is unbounded', 'docs/x.md — stale wording']);
  assert.ok((await events(held)).some(event => event.kind === 'followups.recorded'), 'recorded on the parent (GY-896)');
  // Listed on the parent (its document, which its page and `graphyard status` show) and in master status.
  const status = buildMasterStatus({ work: await store.list(), now: new Date().toISOString() }, [], []);
  const listed = status.pendingFollowUps.find(entry => entry.parent === parent.key)!;
  assert.deepEqual({ findings: listed.findings, shipped: listed.shipped }, { findings: 2, shipped: false });
  assert.match(listed.next, /held on GY-\d+ until it ships/);
  // A later approval before it ships adds only what is new.
  await approve(parent, 102, ['src/a.ts:14 — the retry is unbounded', 'src/b.ts — the cache never expires']);
  assert.equal((await reload(parent.key)).pendingFollowUps?.findings.length, 3);
  assert.deepEqual(await followUpsOf(parent.key), []);
  // Nothing is filed for it before it ships, however often the loop passes.
  assert.deepEqual(await shipHeldFollowUps(await store.list(), ship), []);

  // Merged optimistically, it has not shipped while main's required suite is still out on the merge:
  // a failing suite reverts it and reopens the parent, so nothing is filed yet.
  await deliver(parent, 'pending');
  assert.deepEqual(await shipHeldFollowUps(await store.list(), ship), [], 'an optimistic merge awaiting its post-merge suite has not shipped');
  assert.equal((await call(operator, `work/${parent.key}/followups`, { ship: true, reason: 'too early' })).status, 409, 'and the control plane refuses to file for it');
  assert.equal(pendingFollowUpsReport(await store.list()).find(entry => entry.parent === parent.key)?.shipped, false);
  await deliver(parent, 'pass');
  // A ship the control plane keeps refusing with one unchanged client error is stopped after
  // repeatedClientErrorLimit attempts (retry-stop.ts), not asked again every pass for good.
  const runs: ShipRuns = {};
  let refusals = 0;
  const refused: ShipFollowUps = async target => { refusals++; throw new Error(`Graphyard refused to file the held follow-ups of ${target} (403): not permitted`); };
  const passes: string[][] = [];
  for (let pass = 0; pass < repeatedClientErrorLimit + 5; pass++) passes.push(await shipHeldFollowUps(await store.list(), refused, runs));
  assert.equal(refusals, repeatedClientErrorLimit, 'the refused ship is attempted exactly up to the stop');
  assert.match(passes[repeatedClientErrorLimit - 1]!.join('\n'), /stopped retrying after 10 consecutive attempts/);
  assert.deepEqual(passes.slice(repeatedClientErrorLimit).flat(), [], 'a stopped ship adds no request and no event line');
  assert.ok(runs[parent.key]?.stoppedAt);
  assert.deepEqual(await followUpsOf(parent.key), []);
  const shipped = await shipHeldFollowUps(await store.list(), ship);
  assert.equal(shipped.length, 1, shipped.join('\n'));
  const items = await followUpsOf(parent.key);
  assert.equal(items.length, 1, 'one follow-up item, created once the parent is delivered');
  const [item] = items;
  assert.deepEqual(item!.dependencies, [], 'it depends on nothing: the parent has landed');
  assert.equal(item!.stage, 'backlog');
  assert.deepEqual(followUpEntries(item!).map(finding => finding.text), ['src/a.ts:10 — the retry is unbounded', 'docs/x.md — stale wording', 'src/b.ts — the cache never expires']);
  for (const text of ['the retry is unbounded', 'stale wording', 'the cache never expires']) assert.ok(item!.description.includes(text), text);
  const filed = await reload(parent.key);
  assert.equal(filed.pendingFollowUps?.filed?.item, item!.key);
  assert.equal(pendingFollowUpsReport(await store.list()).some(entry => entry.parent === parent.key), false, 'no longer pending once filed');
  // The next pass files nothing more, and a retried ship is answered with the same item.
  assert.deepEqual(await shipHeldFollowUps(await store.list(), ship), []);
  assert.equal((await ship(parent.key, `followups-after-ship:${parent.key}`)).key, item!.key);
  assert.equal((await followUpsOf(parent.key)).length, 1);

  // GY-1136 (findings 1, 5): findings held again once that item is closed start a new hold, answered
  // under its own receipt, so the dispatcher's fixed key files them as a new item rather than replaying the first.
  await ok(operator, `work/${item!.key}/close`, { kind: 'obsolete', reason: 'Handled elsewhere' });
  await approve(await reload(parent.key), 103, ['src/c.ts — held after the first filing closed']);
  assert.deepEqual((await reload(parent.key)).pendingFollowUps?.findings.map(finding => finding.text), ['src/c.ts — held after the first filing closed']);
  const reshipped = await shipHeldFollowUps(await store.list(), ship);
  const second = (await followUpsOf(parent.key)).filter(entry => !isClosed(entry));
  assert.equal(second.length, 1, reshipped.join('\n'));
  assert.notEqual(second[0]!.key, item!.key);
  assert.match(reshipped.join('\n'), new RegExp(`as ${second[0]!.key}$`));
  assert.deepEqual(followUpEntries(second[0]!).map(finding => finding.text), ['src/c.ts — held after the first filing closed']);
});

test('unit:followups-migrate-to-parent — the one-time migration folds each open follow-up item of an unshipped parent back onto it, closed as superseded by the parent, deleting nothing; a parent closed without shipping drops what it holds with a recorded reason', async () => {
  // Items filed before GY-845: follow-up items depending on their parents.
  const legacy = async (parent: Work, reviewId: number, findings: string[]) => ok(operator, 'work', { ...followUpItem({ key: parent.key, workId: parent.id, pr: 7, sha: String(reviewId).padEnd(40, 'b'), reviewId }, [], findings.map(text => ({ path: text.split(' ')[0]!, line: null, text }))), policy: { checks: ['test'], review: true } }) as Promise<Work>;
  const unshipped = await parentItem('Unshipped parent'), shipped = await parentItem('Shipped parent'), closed = await parentItem('Closed parent');
  const folded = await legacy(unshipped, 201, ['src/u.ts — unshipped finding']);
  const kept = await legacy(shipped, 202, ['src/s.ts — shipped finding']);
  const orphan = await legacy(closed, 203, ['src/c.ts — closed finding']);
  // GY-1136 (findings 2, 3, 7): an item under a live lease defers the fold and leaves the migration unfinished.
  const leasedParent = await parentItem('Unshipped parent of a leased follow-up');
  const leased = await legacy(leasedParent, 206, ['src/l.ts — leased finding']);
  const setLease = async (expiresAt: string) => {
    const current = await reload(leased.key);
    await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [leased.id, JSON.stringify({ ...current, lease: { owner: 'ship-worker', epoch: 1, expiresAt } })]);
  };
  await setLease(new Date(Date.now() + 3_600_000).toISOString());
  await deliver(shipped);
  await ok(operator, `work/${closed.key}/close`, { kind: 'obsolete', reason: 'Nobody wants it' });
  const before = (await store.list()).length;
  // The loop asks once per process under one key; GY-402's merge runs first, the fold on the next ask.
  const first = await ok(operator, 'followups/migrate', {}, 'graphyard-followups-migration');
  assert.equal(first.parents ?? null, null);
  const deferring = await ok(operator, 'followups/migrate', {}, 'graphyard-followups-migration');
  assert.ok(deferring.parents.folded >= 2, JSON.stringify(deferring.parents));
  assert.deepEqual(deferring.parents.deferred, [leased.key]);
  assert.equal((await reload(leased.key)).stage, 'backlog', 'the leased item is left alone');
  assert.equal((await store.pool.query("SELECT 1 FROM events WHERE kind='followups.parent-migrated'")).rowCount, 0, 'no one-time record while an item is deferred');
  // Once its lease has lapsed, the next ask folds it and records the migration.
  await setLease(new Date(Date.now() - 1_000).toISOString());
  const second = await ok(operator, 'followups/migrate', {}, 'graphyard-followups-migration');
  assert.equal(second.parents.deferred, undefined, JSON.stringify(second.parents));
  assert.equal(second.parents.folded, 1);
  const lapsed = await reload(leased.key);
  assert.deepEqual({ kind: lapsed.closure?.kind, ref: lapsed.closure?.ref, lease: lapsed.lease }, { kind: 'superseded', ref: leasedParent.key, lease: null });
  assert.deepEqual((await reload(leasedParent.key)).pendingFollowUps?.findings.map(finding => finding.text), ['src/l.ts — leased finding']);

  const closedItem = await reload(folded.key);
  assert.ok(isClosed(closedItem));
  assert.deepEqual({ kind: closedItem.closure?.kind, ref: closedItem.closure?.ref }, { kind: 'superseded', ref: unshipped.key });
  assert.match(closedItem.closure!.reason, /has not shipped/);
  assert.ok((await events(closedItem)).some(event => event.kind === 'work.closed'));
  assert.deepEqual((await reload(unshipped.key)).pendingFollowUps?.findings.map(finding => finding.text), ['src/u.ts — unshipped finding']);
  assert.deepEqual(pendingFollowUpsReport(await store.list()).find(entry => entry.parent === unshipped.key)?.findings, 1);
  // A delivered parent's follow-up item stays open.
  assert.equal((await reload(kept.key)).stage, 'backlog');
  // A parent closed without shipping takes the findings and drops them, saying why.
  assert.ok(isClosed(await reload(orphan.key)));
  const dropped = (await reload(closed.key)).pendingFollowUps?.dropped;
  assert.match(dropped?.reason ?? '', /closed as obsolete without shipping .*1 pending follow-up finding\(s\) are dropped/);
  assert.equal(deferring.parents.dropped.find((entry: any) => entry.key === closed.key)?.findings, 1);
  assert.equal((await store.list()).length, before, 'nothing was deleted');
  // One-time: a later ask changes nothing and returns the record.
  const third = await ok(operator, 'followups/migrate', {}, 'graphyard-followups-migration');
  assert.equal(third.parents.already, true);
  assert.equal(third.parents.folded, second.parents.folded);

  // Closing a parent that holds findings drops them with the reason, on the record and in the closing event.
  const closing = await parentItem('Parent closed while holding');
  await approve(closing, 204, ['src/d.ts — held then dropped']);
  const closedParent = await ok(operator, `work/${closing.key}/close`, { kind: 'obsolete', reason: 'Superseded by a redesign' }) as Work;
  assert.match(closedParent.pendingFollowUps?.dropped?.reason ?? '', /closed as obsolete without shipping \(Superseded by a redesign\)/);
  const closedEvent = (await events(closedParent)).find(event => event.kind === 'work.closed')!;
  assert.equal(closedEvent.payload.details?.droppedFollowUps ?? closedEvent.payload.droppedFollowUps, 1);
  // A later approval of the closed parent files nothing.
  const late = await approve(closedParent, 205, ['src/e.ts — after closing']);
  assert.equal(late.failure, undefined);
  assert.deepEqual(await followUpsOf(closing.key), []);
});

/** A triage runner that releases every item it is asked about, recording which. */
function releasingRunner() {
  const asked: string[] = [];
  const runner: Runner = {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>): Run<T> {
      const key = /The master loop filed (GY-\d+)/.exec(prompt)![1]!;
      asked.push(key);
      const judgement: TriageJudgement = { outcome: 'release', priority: 2, reason: 'real work' };
      const result: RunResult<T> = { ok: true, tool: triageTool, payload: options.validate(judgement), payloads: [] };
      return { id: key, events: [], onEvent: () => () => {}, cancel: () => {}, result: () => Promise.resolve(result) };
    },
  };
  return { runner, asked };
}

test('unit:triage-skips-unshipped-parent — triage never judges a follow-up whose parent has not shipped, nor raises it as overdue; once the parent ships it is judged', async t => {
  t.after(clearTriageRuns);
  const day = 30 * 3_600_000, now = Date.parse('2026-09-30T12:00:00Z'), old = new Date(now - day).toISOString();
  const base = { type: 'chore', priority: 2, plannedFiles: [], criteria: [], policy: { checks: ['test'], review: true }, ready: false, revision: 1, policyRevision: 1, createdAt: old, updatedAt: old, stageEnteredAt: old, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], description: '' };
  const item = (key: string, title: string, overrides: Partial<Work> = {}) => ({ ...base, id: `id-${key}`, key, title, stage: 'backlog', dependencies: [], ...overrides }) as unknown as Work;
  const review = item('GY-900', 'Still in review', { stage: 'review' });
  const landed = item('GY-901', 'Landed', { stage: 'done', closure: null });
  const waiting = item('GY-910', 'Follow-ups from the approved review of GY-900 (PR #9)', { origin: { reviewFollowUps: { parent: 'GY-900', findings: [{ path: 'src/a.ts', text: 'src/a.ts — waits' }] } }, dependencies: ['id-GY-900'] });
  const due = item('GY-911', 'Follow-ups from the approved review of GY-901 (PR #9)', { origin: { reviewFollowUps: { parent: 'GY-901', findings: [{ path: 'src/b.ts', text: 'src/b.ts — due' }] } } });
  const work = [review, landed, waiting, due];
  const recorded: string[] = [];
  const { runner, asked } = releasingRunner();
  const actions = triageStep({ work, clock: now, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner, record: async entry => { recorded.push(entry.key); } });
  await triageSettled();
  assert.deepEqual(actions.map(action => action.work), ['GY-911']);
  assert.deepEqual(asked, ['GY-911'], 'no triage session is started for the follow-up of the unshipped parent');
  assert.deepEqual(recorded, ['GY-911']);
  assert.deepEqual(overdueTriage(work, now).map(entry => entry.key), ['GY-911'], 'a follow-up waiting on its parent is not overdue');
  clearTriageRuns();
  // Once the parent ships, its follow-up is judged like any other.
  const shippedWork = [{ ...review, stage: 'done', closure: null } as Work, landed, waiting];
  const later = triageStep({ work: shippedWork, clock: now, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner, record: async () => {} });
  await triageSettled();
  assert.deepEqual(later.map(action => action.work), ['GY-910']);
});

test('unit:one-open-followup-any-stage — three approvals of a parent whose follow-up item is released and then in build between them leave one open follow-up item holding the union of their findings', async () => {
  const parent = await parentItem('Parent in rework');
  // Its follow-up item, filed before GY-845 held follow-ups on the parent, and already open.
  const existing = await ok(operator, 'work', { ...followUpItem({ key: parent.key, workId: parent.id, pr: 845, sha: 'e'.repeat(40), reviewId: 300 }, [], [{ path: 'src/a.ts', line: null, text: 'src/a.ts — the retry is unbounded' }]), policy: { checks: ['test'], review: true } }) as Work;
  const first = await approve(parent, 301, ['src/a.ts:12 — the retry is unbounded', 'src/b.ts — the cache never expires']);
  assert.equal(first.item, existing.key);
  // Released between approvals.
  await ok(operator, `work/${existing.key}/ready`, { expectedRevision: (await reload(existing.key)).revision, reason: 'triaged: real work' });
  assert.equal((await reload(existing.key)).stage, 'ready');
  const second = await approve(parent, 302, ['src/b.ts — the cache never expires', 'src/c.ts — the name hides what it counts']);
  assert.equal(second.item, existing.key);
  // In build between approvals: a worker holds it.
  const building = await reload(existing.key);
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [existing.id, JSON.stringify({ ...building, stage: 'build', epoch: 1, lease: { owner: 'some-worker', epoch: 1, expiresAt: new Date(Date.now() + 600_000).toISOString() } })]);
  const third = await approve(parent, 303, ['docs/x.md — stale wording', 'src/c.ts — The name hides what it counts.']);
  assert.equal(third.item, existing.key);

  const open = (await followUpsOf(parent.key)).filter(item => item.stage !== 'done');
  assert.deepEqual(open.map(item => item.key), [existing.key], 'one open follow-up item, never another');
  assert.equal(openFollowUpItem(await store.list(), parent.key)?.stage, 'build');
  assert.deepEqual(followUpEntries(open[0]!).map(finding => finding.text), ['src/a.ts — the retry is unbounded', 'src/b.ts — the cache never expires', 'src/c.ts — the name hides what it counts', 'docs/x.md — stale wording']);
  assert.equal(open[0]!.description.match(/the cache never expires/g)?.length, 1, 'a finding named twice is listed once');
  assert.equal((await reload(parent.key)).pendingFollowUps ?? null, null, 'the open item took them: nothing is held on the parent');
  // Findings recorded on the parent itself (GY-896's direct record, no `parent` flag) while that item is
  // open are held on it; once it ships they join the open item rather than filing a second one.
  await ok(operator, `work/${parent.key}/followups`, { findings: [{ path: 'src/d.ts', text: 'src/d.ts — recorded on the parent' }], reason: 'direct record' });
  await deliver(parent);
  assert.equal((await shipHeldFollowUps(await store.list(), ship)).length, 1);
  const after = (await followUpsOf(parent.key)).filter(item => item.stage !== 'done');
  assert.deepEqual(after.map(item => item.key), [existing.key], 'still one open follow-up item');
  assert.equal(followUpEntries(after[0]!).at(-1)?.text, 'src/d.ts — recorded on the parent');
  assert.equal((await reload(parent.key)).pendingFollowUps?.filed?.item, existing.key);
});

test('manual:review-followups-triaged GY-1047.1: foldUnshippedFollowUps skips items with an active lease so worker attempts are not ended without notice (findings 4 & 13)', () => {
  const at = '2026-10-02T12:00:00.000Z', now = new Date(at);
  const unshippedParent: Work = {
    id: 'parent-1', key: 'GY-100', title: 'Parent', stage: 'build', type: 'task', priority: 2,
    dependencies: [], criteria: [], plannedFiles: ['src/a.ts'], policy: { checks: ['test'], review: true },
    ready: true, revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    epoch: 1, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], description: '',
  } as unknown as Work;
  const leasedFollowUp: Work = {
    id: 'followup-1', key: 'GY-101', title: 'Follow-up under lease', stage: 'build', type: 'chore', priority: 2,
    dependencies: ['parent-1'], criteria: [], plannedFiles: ['src/a.ts'], policy: { checks: ['test'], review: true },
    ready: true, revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    epoch: 1, lease: { owner: 'worker-1', epoch: 1, expiresAt: '2026-10-02T12:05:00.000Z' },
    workspaces: [{ host: 'host-1', path: '/tmp/w', branch: 'b', epoch: 1, at, createdBy: 'worker-1' }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [], description: '1. Finding with no thread: src/a.ts — fix needed',
    origin: { reviewFollowUps: { parent: 'GY-100', findings: [{ path: 'src/a.ts', text: 'src/a.ts — fix needed' }] } },
  } as unknown as Work;
  const unleasedFollowUp: Work = {
    id: 'followup-2', key: 'GY-102', title: 'Follow-up not leased', stage: 'backlog', type: 'chore', priority: 2,
    dependencies: ['parent-1'], criteria: [], plannedFiles: ['src/a.ts'], policy: { checks: ['test'], review: true },
    ready: false, revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], description: '1. Finding with no thread: src/b.ts — fix needed',
    origin: { reviewFollowUps: { parent: 'GY-100', findings: [{ path: 'src/b.ts', text: 'src/b.ts — fix needed' }] } },
  } as unknown as Work;

  const result = foldUnshippedFollowUps([unshippedParent, leasedFollowUp, unleasedFollowUp], 'migration-actor', now);
  // Leased follow-up is skipped:
  assert.equal(leasedFollowUp.stage, 'build');
  assert.equal(leasedFollowUp.closure, undefined);
  // Unleased follow-up is folded:
  assert.equal(unleasedFollowUp.stage, 'done');
  assert.equal(unleasedFollowUp.closure?.kind, 'superseded');
  assert.equal(result.folded.length, 1);
  assert.equal(result.folded[0]!.work.key, 'GY-102');
  // Leased follow-up is recorded as deferred so callers can defer finalizing migration:
  assert.equal(result.deferred.length, 1);
  assert.equal(result.deferred[0]!.key, 'GY-101');
});

test('manual:review-followups-triaged GY-1136.1: foldUnshippedFollowUps folds an item whose lease has lapsed and ignores leases on closed items (findings 4, 6)', () => {
  const at = '2026-10-02T12:00:00.000Z', now = new Date(at);
  const base = { type: 'chore', priority: 2, criteria: [], plannedFiles: ['src/a.ts'], policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [], description: '' };
  const parent = { ...base, id: 'parent-1', key: 'GY-300', title: 'Parent', stage: 'build', dependencies: [], ready: true, epoch: 1, lease: null } as unknown as Work;
  const followUp = (key: string, stage: string, expiresAt: string) => ({ ...base, id: key, key, title: key, stage, dependencies: ['parent-1'], ready: true, epoch: 1,
    lease: { owner: 'worker-1', epoch: 1, expiresAt }, origin: { reviewFollowUps: { parent: 'GY-300', findings: [{ path: 'src/a.ts', text: `${key} finding` }] } } }) as unknown as Work;
  const lapsed = followUp('GY-301', 'build', '2026-10-02T11:59:59.000Z'), live = followUp('GY-302', 'build', '2026-10-02T12:00:01.000Z');
  const done = { ...followUp('GY-303', 'done', '2026-10-02T13:00:00.000Z'), closure: { kind: 'obsolete', ref: null, by: 'x', at, from: 'build', reason: 'closed' } } as unknown as Work;
  const result = foldUnshippedFollowUps([parent, lapsed, live, done], 'actor', now);
  assert.deepEqual(result.folded.map(entry => entry.work.key), ['GY-301']);
  assert.equal(lapsed.closure?.kind, 'superseded');
  assert.deepEqual(result.deferred.map(item => item.key), ['GY-302'], 'only the open item under a live lease defers; a closed one is neither folded nor deferred');
  assert.equal(live.closure, undefined);
});

test('manual:review-followups-triaged GY-1047.2: foldUnshippedFollowUps resolves parents via key map in O(n) time (finding 22)', () => {
  const at = '2026-10-02T12:00:00.000Z', now = new Date(at);
  const parents = Array.from({ length: 10 }, (_, i) => ({
    id: `parent-${i}`, key: `GY-${100 + i}`, title: `Parent ${i}`, stage: 'review', type: 'task', priority: 2,
    dependencies: [], criteria: [], plannedFiles: ['src/a.ts'], policy: { checks: ['test'], review: true },
    ready: true, revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], description: '',
  } as unknown as Work));
  const followUps = Array.from({ length: 10 }, (_, i) => ({
    id: `followup-${i}`, key: `GY-${200 + i}`, title: `Follow-up ${i}`, stage: 'backlog', type: 'chore', priority: 2,
    dependencies: [`parent-${i}`], criteria: [], plannedFiles: ['src/a.ts'], policy: { checks: ['test'], review: true },
    ready: false, revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], description: `1. Finding: src/${i}.ts`,
    origin: { reviewFollowUps: { parent: `GY-${100 + i}`, findings: [{ path: `src/${i}.ts`, text: `src/${i}.ts — fix` }] } },
  } as unknown as Work));

  const all = [...parents, ...followUps];
  const result = foldUnshippedFollowUps(all, 'migration-actor', now);
  assert.equal(result.folded.length, 10);
  assert.equal(result.parents.length, 10);
  assert.equal(result.deferred.length, 0);
  for (const parent of parents) {
    assert.equal(parent.pendingFollowUps?.findings.length, 1);
  }
});

test('manual:review-followups-triaged GY-1047.3: the ship receipt is scoped to the hold timestamp so re-held findings after ship are not answered with the earlier receipt (GY-1047 findings 1, 9, 16, 18, 23, 25; GY-1136 findings 1, 5)', () => {
  const key = 'followups-after-ship:GY-500';
  assert.equal(followUpShipReceiptKey(key, { pendingFollowUps: null }), key);
  const t1 = '2026-10-02T10:00:00.000Z', t2 = '2026-10-02T14:30:00.000Z';
  const first = { pendingFollowUps: { at: t1, findings: [{ path: 'src/a.ts', text: 'finding 1' }] } } as any;
  const second = { pendingFollowUps: { at: t2, findings: [{ path: 'src/b.ts', text: 'finding 2' }] } } as any;
  assert.equal(followUpShipReceiptKey(key, first), `${key}@${t1}`);
  assert.equal(followUpShipReceiptKey(key, first), followUpShipReceiptKey(key, { ...first }), 'a retry within one hold replays');
  assert.notEqual(followUpShipReceiptKey(key, first), followUpShipReceiptKey(key, second));
});

test('manual:review-followups-triaged GY-1047.4: foldUnshippedFollowUps reports deferred leased items so callers can defer finalizing migration', () => {
  const at = '2026-10-02T12:00:00.000Z', now = new Date(at);
  const parent: Work = {
    id: 'parent-1', key: 'GY-200', title: 'Parent', stage: 'build', type: 'task', priority: 2,
    dependencies: [], criteria: [], plannedFiles: ['src/a.ts'], policy: { checks: ['test'], review: true },
    ready: true, revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    epoch: 1, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], description: '',
  } as unknown as Work;
  const leasedFollowUp1: Work = {
    id: 'followup-1', key: 'GY-201', title: 'Follow-up 1 under lease', stage: 'build', type: 'chore', priority: 2,
    dependencies: ['parent-1'], criteria: [], plannedFiles: ['src/a.ts'], policy: { checks: ['test'], review: true },
    ready: true, revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    epoch: 1, lease: { owner: 'worker-1', epoch: 1, expiresAt: '2026-10-02T12:05:00.000Z' },
    workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], description: '',
    origin: { reviewFollowUps: { parent: 'GY-200', findings: [{ path: 'src/a.ts', text: 'finding 1' }] } },
  } as unknown as Work;
  const leasedFollowUp2: Work = {
    id: 'followup-2', key: 'GY-202', title: 'Follow-up 2 under lease', stage: 'build', type: 'chore', priority: 2,
    dependencies: ['parent-1'], criteria: [], plannedFiles: ['src/a.ts'], policy: { checks: ['test'], review: true },
    ready: true, revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    epoch: 1, lease: { owner: 'worker-2', epoch: 1, expiresAt: '2026-10-02T12:05:00.000Z' },
    workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], description: '',
    origin: { reviewFollowUps: { parent: 'GY-200', findings: [{ path: 'src/b.ts', text: 'finding 2' }] } },
  } as unknown as Work;

  const result = foldUnshippedFollowUps([parent, leasedFollowUp1, leasedFollowUp2], 'actor', now);
  assert.equal(result.folded.length, 0);
  assert.equal(result.deferred.length, 2);
  assert.deepEqual(result.deferred.map(item => item.key), ['GY-201', 'GY-202']);
});
