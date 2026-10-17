import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { gitBranchName } from '../src/model/pr-adoption.js';
import { saveDocument, Store } from '../src/store.js';
import { MergerSettings, mergerEventKind } from '../src/merger-mode.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { recordLegacyMerger } from './helpers/legacy-merger.js';
import { FakeGitHub } from './helpers/fake-github.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1849: one existing pull request adopted into one Graphyard item on its same branch and head.
 *
 * The engine is driven directly, with the fake GitHub standing in as the provider an adoption reads
 * the live head from, exactly as the deployment's GitHub App would. Huck's migration pull request
 * already exists outside Graphyard; `adopt` binds it to a held item without creating a pull request,
 * a dispatch or a second binding of any kind, and writes nothing to GitHub at all.
 */

const repository = 'acme/shop';
const operator: Principal = { id: 'adopt-operator', role: 'admin', sessionKind: 'human' };
const master: Principal = { id: 'adopt-master', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'adopt-worker', role: 'worker', sessionKind: 'ai' };

let database: EmbeddedPostgres, store: Store, engine: Engine, github: FakeGitHub;

before(async () => {
  // An offset no other file takes, inside the port window a run reserves (the gap above the
  // per-file offsets is 1000): two files that share a port fail whichever starts its Postgres
  // second, in its `before` hook, with no reason given.
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 700;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('pr-adoption-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('pr_adoption');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/pr_adoption`); await store.init();
  await recordLegacyMerger(store);
  engine = new Engine(store, [15368], 300, repository);
  engine.submissionObserver = null;
  github = new FakeGitHub(repository, { autoApprove: true });
  // The live read an adoption is judged against: the fake, as the deployment's GitHub App reads a pull request.
  engine.adoptionObserver = async pr => livePull(pr);
});
after(async () => { await store.close(); await database.stop(); });

const reload = async (item: Work | string) => (await store.list()).find(entry => entry.id === (typeof item === 'string' ? item : item.id))!;
const eventsOf = async (item: Work, kind: string) => (await store.events(item.id)).filter(event => event.kind === kind);
/** Refusal messages are the contract: each rejection asserts the holder or head it names. */
const refused = (run: Promise<unknown>, named: string | RegExp) => assert.rejects(run, (error: Error) => {
  const message = String((error as Error).message);
  return typeof named === 'string' ? message.includes(named) : named.test(message);
});

let sequence = 0;
/** A released item the master may adopt into. */
const released = async (): Promise<Work> => {
  const item = await engine.execute(operator, 'create', null, { title: `Adopted work ${++sequence}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:pr-adoption-binds-once'] }] }, randomUUID());
  return engine.execute(operator, 'ready', item.id, {}, randomUUID());
};
/** Huck's own pull request, open on its branch at the head it was pushed at. */
const externalPull = (branch: string) => {
  const head = github.push(branch, { 'src/basket.ts': 'export const basket = [];\n' }, 'Add the basket', 'person:huck');
  const pull = github.openPull({ head: branch, title: 'Add the basket', body: 'Huck-123' }, 'person:huck');
  return { head, pull };
};
/** The live read an adoption is judged against: the fake, as the deployment's GitHub App reads a pull request. */
const livePull = (pr: number) => {
  const view = github.view(pr);
  return { head: view.head.sha, branch: view.head.ref, state: view.state as 'open' | 'closed', draft: false, headRepository: repository, baseRepository: repository, baseRef: 'main' };
};
/** The observation complete is judged against, read from the fake as the control plane reads the pull request. */
const observeFromFake = async (probe: Work): Promise<Observation> => {
  const view = github.view(probe.submission!.pr);
  return {
    prState: view.state as 'open' | 'closed', draft: false,
    candidate: { sha: view.head.sha, baseSha: view.base.sha, pr: probe.submission!.pr, branch: view.head.ref, author: 'person:huck' },
    checks: [], reviews: [], merged: view.merged, mergeSha: view.merge_commit_sha, mergeable: true, protected: false, files: [], scopeFiles: [], at: new Date().toISOString(),
  } as Observation;
};
/** The master's adoption intent, each call under its own idempotency key like a real client. */
const adopt = (item: Work, pr: number, head: string) =>
  engine.execute(master, 'adopt', item.id, { pr, head, sourceKey: 'Huck-123', sourceUrl: 'https://huck.example/issues/123', reason: 'Resume the Huck migration pull request' }, randomUUID());
/** Another item holds PR N as its submission: the fixture for a pull request that is already taken. */
const heldAsSubmission = async (item: Work, pr: number) => {
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{submission}',$2) WHERE id=$1", [item.id, JSON.stringify({ epoch: 1, pr })]);
  return reload(item);
};

test('unit:pr-adoption-binds-once — adopting a pull request at its live head binds it once with its source key and URL; a repeat is a no-op; a moved head and a second owner are refused naming what they hit', async () => {
  assert.ok(existsSync(fileURLToPath(new URL('../src/model/pr-adoption.ts', import.meta.url))), 'the adoption model exists');
  const { head, pull } = externalPull('feature/huck-basket');
  const item = await adopt(await released(), pull.number, head);
  // The binding: this repository, the pull request number, the exact head, its own branch, and the source kept beside it.
  assert.deepEqual({ ...item.prAdoption, adoptedAt: undefined, adoptedBy: undefined },
    { pr: pull.number, head, branch: 'feature/huck-basket', repository, sourceKey: 'Huck-123', sourceUrl: 'https://huck.example/issues/123', adoptedAt: undefined, adoptedBy: undefined });
  assert.equal(item.prAdoption!.adoptedBy, master.id);
  assert.ok(item.prAdoption!.adoptedAt, 'the binding is stamped');
  // One appended fact, once.
  assert.equal((await eventsOf(item, 'adopt')).length, 1);
  // Repeating the same adoption is the no-op: no second binding, no second fact, no write at all.
  const again = await adopt(item, pull.number, head);
  assert.deepEqual(again.prAdoption, item.prAdoption);
  assert.equal((await eventsOf(again, 'adopt')).length, 1, 'the repeat records no second binding');
  assert.equal(again.revision, item.revision, 'the repeat writes nothing');

  // A moved head is refused naming the head the provider reports now.
  const moved = github.push('feature/huck-basket', { 'src/basket.ts': 'export const basket = [1];\n' }, 'Move the basket', 'person:huck');
  assert.notEqual(moved, head);
  await refused(adopt(item, pull.number, head), `its live head is ${moved}`);

  // A second owner is refused naming that holder: another item's adoption of the same pull request.
  const rival = await released();
  await refused(adopt(rival, pull.number, moved), `${item.key} already adopted pull request #${pull.number}`);
  // Another item's submission of a pull request names that holder too.
  const { head: secondHead, pull: secondPull } = externalPull('feature/huck-catalogue');
  const holder = await heldAsSubmission(await released(), secondPull.number);
  await refused(adopt(rival, secondPull.number, secondHead), `${holder.key} already holds pull request #${secondPull.number} as its submission (epoch 1)`);
  // Another item's open attempt holding the adopted branch names that holder.
  const { head: thirdHead, pull: thirdPull } = externalPull('graphyard/huck-notes');
  const reserving = await released();
  const claim = await engine.execute(worker, 'claim', reserving.id, {}, randomUUID());
  await engine.execute(worker, 'workspace', reserving.id, { epoch: claim.epoch, host: 'machine-a', path: `/tmp/adopted/${reserving.id}`, branch: 'graphyard/huck-notes' }, randomUUID());
  await refused(adopt(rival, thirdPull.number, thirdHead), `${reserving.key} reserves graphyard/huck-notes (epoch ${claim.epoch})`);
  // An ended attempt holds nothing: with the attempt released, the same branch takes an adoption.
  await engine.execute(worker, 'release', reserving.id, { epoch: claim.epoch, cause: 'stood down' }, randomUUID());
  const afterEnd = await adopt(await released(), thirdPull.number, thirdHead);
  assert.equal(afterEnd.prAdoption!.branch, 'graphyard/huck-notes');
  // The ended attempt's record no more holds the branch at the workspace than at adoption: the adopting item's attempt reserves it.
  const afterEndClaim = await engine.execute(worker, 'claim', afterEnd.id, {}, randomUUID());
  const afterEndSpace = await engine.execute(worker, 'workspace', afterEnd.id, { epoch: afterEndClaim.epoch, host: 'machine-a', path: `/tmp/adopted-after/${afterEnd.id}`, branch: 'graphyard/huck-notes' }, randomUUID());
  assert.equal(afterEndSpace.workspaces.at(-1)!.branch, 'graphyard/huck-notes');
  await engine.execute(worker, 'release', afterEnd.id, { epoch: afterEndClaim.epoch, cause: 'stood down' }, randomUUID());
  // A fork's head lives outside the managed origin, and a pull request against another base never
  // lands on the managed one: either could never be worked or completed, so both are refused.
  const { head: sixthHead, pull: sixthPull } = externalPull('feature/huck-fork');
  engine.adoptionObserver = async () => ({ head: sixthHead, branch: 'feature/huck-fork', state: 'open', draft: false, headRepository: 'person/huck-fork', baseRepository: repository, baseRef: 'main' });
  try {
    await refused(adopt(rival, sixthPull.number, sixthHead), new RegExp(`Pull request #${sixthPull.number} lives on person/huck-fork against ${repository}, not ${repository}`));
  } finally {
    engine.adoptionObserver = async pr => livePull(pr);
  }
  const { head: seventhHead, pull: seventhPull } = externalPull('feature/huck-elsewhere');
  engine.adoptionObserver = async () => ({ head: seventhHead, branch: 'feature/huck-elsewhere', state: 'open', draft: false, headRepository: repository, baseRepository: repository, baseRef: 'release/2.0' });
  try {
    await refused(adopt(rival, seventhPull.number, seventhHead), `Pull request #${seventhPull.number} targets base release/2.0, not main`);
  } finally {
    engine.adoptionObserver = async pr => livePull(pr);
  }
  // And an item already past adoption takes no second pull request: one binding stands per item.
  await refused(adopt(item, thirdPull.number, thirdHead), `${item.key} already adopted pull request #${pull.number}; one binding stands per item`);
});

test('unit:pr-adoption-refuses-unadoptable — a draft, a control-plane merge writer and an item with work in flight are each refused at adoption; a re-adopt at a new live head rebinds once the attempt is over', async () => {
  const { head, pull } = externalPull('feature/huck-draft');
  const item = await released();
  // A draft: the binding waits for the pull request to be marked ready for review.
  engine.adoptionObserver = async () => ({ head, branch: 'feature/huck-draft', state: 'open', draft: true, headRepository: repository, baseRepository: repository, baseRef: 'main' });
  try {
    await refused(adopt(item, pull.number, head), `Pull request #${pull.number} is a draft`);
  } finally {
    engine.adoptionObserver = async pr => livePull(pr);
  }
  // The control plane as merge writer: no GitHub pull request could ever complete, so none is adopted.
  const setMerger = (merger: string, reason: string) => store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['test-fixture', mergerEventKind, JSON.stringify({ merger, reason, previous: merger === 'github' ? 'control-plane' : 'github' })]);
  await setMerger('control-plane', 'this case exercises the control-plane writer');
  try {
    await refused(adopt(item, pull.number, head), /merge writer is the control plane.*graphyard master merger/);
  } finally {
    await setMerger('github', 'this test exercises the legacy github merger');
  }
  // An attempt holding a live lease: adoption waits for the attempt to end, then binds.
  const claim = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  await refused(adopt(item, pull.number, head), `${item.key}'s attempt (epoch ${claim.epoch}) holds a live lease`);
  await engine.execute(worker, 'release', item.id, { epoch: claim.epoch, cause: 'stood down' }, randomUUID());
  const bound = await adopt(item, pull.number, head);
  assert.equal(bound.prAdoption!.head, head);
  // The head moved after adoption: a re-adopt at the new live head rebinds, as its own recorded fact.
  const moved = github.push('feature/huck-draft', { 'src/basket.ts': 'export const basket = [2];\n' }, 'Move on', 'person:huck');
  const rebound = await adopt(item, pull.number, moved);
  assert.equal(rebound.prAdoption!.head, moved);
  assert.equal((await eventsOf(item, 'adopt')).length, 2, 'the rebind is its own recorded fact');
  // A recorded candidate is the same hold in head form: a first adoption is refused while it stands.
  const inFlight = await released();
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{candidate}',$2) WHERE id=$1", [inFlight.id, JSON.stringify({ sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: pull.number + 7, branch: 'feature/huck-draft', author: 'person:huck' })]);
  const { head: fifthHead, pull: fifthPull } = externalPull('feature/huck-second');
  await refused(adopt(inFlight, fifthPull.number, fifthHead), `${inFlight.key} already holds a candidate head`);
});

test('unit:pr-adoption-same-pr-no-double-dispatch — an attempt on the adopted item is assigned the pull request branch, complete accepts only that pull request, two dispatch requests yield one assignment, and GitHub is left untouched', async () => {
  // A branch git accepts but no narrower whitelist would: `+`, `@` and Unicode are its author's to choose.
  const adoptedBranch = 'feature/huck+reviews@ü';
  const { head, pull } = externalPull(adoptedBranch);
  // The rule is git's own (`check-ref-format --branch`): names git refuses, or one reading as an option, stay refused.
  for (const name of ['-option', 'feature/.hidden', 'feature/a..b', 'feature/a.lock', 'feature/a b', 'feature/a~1', 'feature/a@{1}', 'feature/', 'feature//a', '@'])
    assert.equal(gitBranchName(name), false, `${name} is refused`);
  const item = await adopt(await released(), pull.number, head);
  const humanSteps = github.humanSteps.length, reviews = github.reviews.length;

  // Two dispatch requests, each persisted before the next, yield one assignment: the queue binds
  // one row to the attempt, so the second pass over the stored item adds no second row.
  const dispatched = await reload(item);
  engine.evaluate(dispatched, [dispatched], new Date());
  await store.transaction(async db => { await saveDocument(db, dispatched, new Date()); });
  const redispatched = await reload(item);
  engine.evaluate(redispatched, [redispatched], new Date());
  const rows = redispatched.actionQueue!.actions.filter(row => row.kind === 'dispatch');
  assert.equal(rows.length, 1, `one dispatch row stands: ${JSON.stringify(redispatched.actionQueue!.actions.map(row => [row.kind, row.binding]))}`);
  assert.equal(rows[0]!.binding, `dispatch:${item.epoch}`);

  // A second dispatch reaching claim while the first attempt holds the item is refused: one assignment.
  const first = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  await assert.rejects(engine.execute(worker, 'claim', item.id, {}, randomUUID()));
  // The first attempt works on the adopted branch and ends without submitting; its record stays as history.
  await engine.execute(worker, 'workspace', item.id, { epoch: first.epoch, host: 'machine-a', path: `/tmp/adopted-1/${item.id}`, branch: adoptedBranch }, randomUUID());
  await engine.execute(worker, 'heartbeat', item.id, { epoch: first.epoch }, randomUUID());
  const ended = await engine.execute(worker, 'release', item.id, { epoch: first.epoch, cause: 'stood down' }, randomUUID());
  assert.ok(ended.workspaces.some(space => space.epoch === first.epoch && space.branch === adoptedBranch), 'the ended attempt keeps its workspace record');

  // The next attempt is assigned the same adopted branch: a fresh branch name is refused naming the adopted one.
  const attempt = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  assert.notEqual(attempt.epoch, first.epoch);
  await refused(engine.execute(worker, 'workspace', item.id, { epoch: attempt.epoch, host: 'machine-a', path: `/tmp/adopted-2/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${attempt.epoch}` }, randomUUID()),
    `its attempt works on the adopted branch ${adoptedBranch}`);
  const worked = await engine.execute(worker, 'workspace', item.id, { epoch: attempt.epoch, host: 'machine-a', path: `/tmp/adopted-2/${item.id}`, branch: adoptedBranch }, randomUUID());
  assert.equal(worked.workspaces.at(-1)!.branch, adoptedBranch);

  // Complete naming any other pull request is refused; the adopted one is accepted once its live head is observed.
  await refused(engine.execute(worker, 'submit', item.id, { epoch: attempt.epoch, pr: pull.number + 50 }, randomUUID()), 'complete accepts only that pull request');
  engine.submissionObserver = observeFromFake;
  const completed = await engine.execute(worker, 'submit', item.id, { epoch: attempt.epoch, pr: pull.number }, randomUUID()).finally(() => { engine.submissionObserver = null; });
  assert.deepEqual(completed.submission, { epoch: attempt.epoch, pr: pull.number });
  assert.equal(completed.prAdoption!.pr, completed.submission.pr, 'the submission binds the adopted pull request, creating no replacement');

  // The adopted pull request was never touched: still open at the adopted head, unmerged, unreviewed,
  // and no human step anywhere in the flow but Huck's own pushes.
  const view = github.view(pull.number);
  assert.equal(view.state, 'open');
  assert.equal(view.head.sha, head, 'the head never moved');
  assert.equal(view.head.ref, adoptedBranch, 'the branch was never retargeted');
  assert.equal(view.title, 'Add the basket', 'the pull request was never renamed');
  assert.equal(view.merged, false, 'the pull request was never closed or merged');
  assert.equal(github.reviews.length, reviews, 'nothing commented or reviewed the pull request');
  assert.equal(github.humanSteps.length, humanSteps, 'nothing at all was written by hand');
});

test('unit:pr-adoption-exact-head-complete — complete on an adopted item is refused while the pull request lives at another head, naming both shas; the re-adopt at the live head rebinds and completes', async () => {
  const { head, pull } = externalPull('feature/huck-head');
  const item = await adopt(await released(), pull.number, head);
  const attempt = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  await engine.execute(worker, 'workspace', item.id, { epoch: attempt.epoch, host: 'machine-c', path: `/tmp/adopted-3/${item.id}`, branch: 'feature/huck-head' }, randomUUID());
  // With no observation of the live head, complete on the adopted item is refused rather than recorded unverified.
  await refused(engine.execute(worker, 'submit', item.id, { epoch: attempt.epoch, pr: pull.number }, randomUUID()), 'whose live head could not be observed');
  assert.equal((await reload(item)).submission ?? null, null, 'the unobserved completion recorded nothing');
  engine.submissionObserver = observeFromFake;
  try {
    // The author pushes while the attempt runs: complete is refused naming the adopted and the live head.
    const moved = github.push('feature/huck-head', { 'src/basket.ts': 'export const basket = [3];\n' }, 'Move the head', 'person:huck');
    await refused(engine.execute(worker, 'submit', item.id, { epoch: attempt.epoch, pr: pull.number }, randomUUID()),
      new RegExp(`adopted pull request #${pull.number} at head ${head.slice(0, 12)}, but its live head is ${moved.slice(0, 12)}`));
    // The master re-adopts at the live head without repeating the source flags: a recorded rebind
    // that keeps the source the first binding recorded, and complete then accepts it.
    const rebound = await engine.execute(master, 'adopt', item.id, { pr: pull.number, head: moved, reason: 'Follow the moved head' }, randomUUID());
    assert.equal(rebound.prAdoption!.head, moved);
    assert.equal(rebound.prAdoption!.sourceKey, 'Huck-123', 'the rebind keeps the source key');
    assert.equal(rebound.prAdoption!.sourceUrl, 'https://huck.example/issues/123', 'the rebind keeps the source URL');
    assert.equal((await eventsOf(item, 'adopt')).length, 2, 'the rebind is its own recorded fact');
    const completed = await engine.execute(worker, 'submit', item.id, { epoch: attempt.epoch, pr: pull.number }, randomUUID());
    assert.deepEqual(completed.submission, { epoch: attempt.epoch, pr: pull.number });
  } finally {
    engine.submissionObserver = null;
  }
});

test('unit:pr-adoption-merger-switch-keeps-pr — an adoption made under the github writer still completes only as its pull request after a real switch to the control-plane writer: a head is refused, and nothing is recorded until the writer is github again', async () => {
  const { head, pull } = externalPull('feature/huck-switch');
  const item = await adopt(await released(), pull.number, head);
  const attempt = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  await engine.execute(worker, 'workspace', item.id, { epoch: attempt.epoch, host: 'machine-d', path: `/tmp/adopted-4/${item.id}`, branch: 'feature/huck-switch' }, randomUUID());
  const settings = new MergerSettings(store);
  await settings.change(operator, { merger: 'control-plane', reason: 'this test switches the writer after an adoption' }, randomUUID());
  try {
    // The adopted head itself, submitted as a head, would be a newly allocated change: refused naming the adopted pull request.
    await refused(engine.execute(worker, 'submit', item.id, { epoch: attempt.epoch, head }, randomUUID()),
      new RegExp(`adopted pull request #${pull.number} and completes only as that pull request, never as a head`));
    await refused(engine.execute(worker, 'submit', item.id, { epoch: attempt.epoch, pr: pull.number }, randomUUID()), 'A pull request is submitted only while GitHub is the merge writer');
    const held = await reload(item);
    assert.equal(held.submission ?? null, null, 'no submission was recorded under the control-plane writer');
    assert.equal(held.candidate ?? null, null, 'no synthetic change was bound');
    assert.equal(held.prAdoption!.pr, pull.number, 'the adoption still binds its pull request');
  } finally {
    await settings.change(operator, { merger: 'github', reason: 'this test exercises the legacy github merger' }, randomUUID());
  }
  engine.submissionObserver = observeFromFake;
  try {
    const completed = await engine.execute(worker, 'submit', item.id, { epoch: attempt.epoch, pr: pull.number }, randomUUID());
    assert.deepEqual(completed.submission, { epoch: attempt.epoch, pr: pull.number }, 'it completes as the adopted pull request once github writes again');
  } finally {
    engine.submissionObserver = null;
  }
});
