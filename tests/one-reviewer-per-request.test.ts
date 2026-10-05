import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { openReviewConflict, reconcileReviewConflict, reviewConflictAttention } from '../src/model/review-conflict.js';
import { loadMasterConfig, setupMaster, sessionAgentName, type HerdrAgent } from '../src/master.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, reviewCommand, saveReviewerProfile, updateReviewLedger, type ReviewRecord } from '../src/reviewer.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { controlPlaneHandlers } from '../src/executor.js';
import { routineDecision, standingVerdict } from '../src/master-daemon.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-124: one review request yields one reviewer session and one verdict. Each test is named for
// the proof it produces: unit:one-reviewer-per-request and integration:conflicting-verdicts-surfaced.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('c1'), B = sha40('b1');
const reviewer = 'graphyard-reviewer[bot]';

function observation(candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { candidate: { ...candidate, pr: 119, branch: 'graphyard/gy-114-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true, ...extra };
}
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 119, branch: 'graphyard/gy-114-1', author: 'implementer' };
  return { id: 'work-114', key: 'GY-114', title: 'Supervisor install', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:x'] }], policy: { checks: [], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 3,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w/gy-114', branch: 'graphyard/gy-114-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 119 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: observation(candidate), blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}

/** A master with a bound reviewer App and two reviewer profiles — the two runtimes the incident launched. */
async function reviewerMaster() {
  const root = await temporaryDirectory('gy124'), credentials = await temporaryDirectory('gy124-cred');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinator = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinator as typeof fetch);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  await saveReviewerProfile(root, { name: 'second-reviewer', agentName: 'review-second-1', kind: 'claude' });
  // Herdr, stubbed: every tab created and every runtime started is logged, and at the moment a
  // runtime starts the ledger on disk is read, so the test sees what a reconciler would see then.
  const log = { tabs: [] as string[], started: [] as { pane: string; recorded: ReviewRecord[] }[] };
  let panes = 0;
  const run = (_command: string, args: string[]) => {
    if (args[0] === 'pane' && args[1] === 'run') {
      const ledger = JSON.parse(readFileSync(join(root, '.graphyard/reviews.json'), 'utf8'));
      log.started.push({ pane: args[2], recorded: ledger.reviews });
    }
    if (args[0] === 'tab' && args[1] === 'create') { const pane = `pane-${++panes}`; log.tabs.push(pane); return JSON.stringify({ result: { root_pane: { pane_id: pane, tab_id: `tab-${panes}` } } }); }
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
  const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
  return { root, credentials, run, mint, log, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

type Launcher = 'cycle' | 'dispatcher';
/**
 * The orders the two launchers can reach the ledger lock in, each driven explicitly rather than by
 * wall-clock (GY-1111): one launcher reserves first and the other arrives while it is still
 * launching (its record `launching`), or once its runtime has started; or both are released at once
 * and the lock alone picks. Whichever wins, exactly one session and one record result.
 */
const interleavings: { name: string; first: Launcher | null; at?: 'launching' | 'started' }[] = [
  { name: 'cycle reserves, dispatcher arrives while it launches', first: 'cycle', at: 'launching' },
  { name: 'cycle starts its runtime, then the dispatcher arrives', first: 'cycle', at: 'started' },
  { name: 'dispatcher reserves, cycle arrives while it launches', first: 'dispatcher', at: 'launching' },
  { name: 'dispatcher starts its runtime, then the cycle arrives', first: 'dispatcher', at: 'started' },
  { name: 'both released at once, the ledger lock picks', first: null },
];
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

/**
 * The loop's dispatch tick and the stateless executor's request-review handler launch for one
 * request, each held at the door of launchReview until the interleaving lets it in. Every launcher's
 * own outcome is recorded where it calls launchReview: the executor settles a refusal for a session
 * already answering the head as its result (GY-1090), so its handler's return alone cannot say
 * whether it launched or stood down.
 */
async function race(master: Awaited<ReturnType<typeof reviewerMaster>>, order: (typeof interleavings)[number]) {
  await updateReviewLedger(master.root, current => { current.reviews = []; });
  master.log.tabs.length = 0; master.log.started.length = 0;
  // The loop and the executor both launch the configured reviewer profile; the executor here is
  // wired to the second one, as the incident's two sessions ran two runtimes.
  const loaded = await loadMasterConfig(master.root);
  const config = { ...loaded, run: { ...loaded.run, reviewerProfile: 'claude-reviewer' } };
  // A review is requested only once the head's mechanical proofs pass (GY-115): prove it first.
  const item = work({ evidence: [{ id: 'evidence-1', proof: 'unit:x', sha: H, baseSha: B, policyRevision: 3, producer: 'ci-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at: new Date().toISOString() }] } as Partial<Work>);
  reconcileAutoDispatch(item, [item], new Date());
  const request = item.autoDispatch!.review!;
  const agents: HerdrAgent[] = [];
  const other = (who: Launcher): Launcher => who === 'cycle' ? 'dispatcher' : 'cycle';
  const door = { cycle: deferred(), dispatcher: deferred() }, minting = { cycle: deferred(), dispatcher: deferred() }, settled = { cycle: deferred(), dispatcher: deferred() };
  const outcomes: Partial<Record<Launcher, { launched: boolean; error?: string }>> = {};
  // A token is minted after the reservation is written and before any tab exists: holding the first
  // launcher there keeps its record `launching` while the second one is let in.
  const mint = (who: Launcher) => async () => { minting[who].resolve(); if (order.at === 'launching' && order.first === who) await settled[other(who)].promise; return master.mint(); };
  const launch = (who: Launcher, profile: string) => (work: Work, dispatch: { id: string }, herdr: { name?: string }[], observedAt: string) => door[who].promise
    .then(() => launchReview(master.root, work, profile, herdr, observedAt, { run: master.run, mint: mint(who), requestId: dispatch.id }))
    .then(result => { outcomes[who] = { launched: true }; settled[who].resolve(); return result; }, error => { outcomes[who] = { launched: false, error: error.message }; settled[who].resolve(); throw error; });
  // The loop's dispatch tick, launching through the real launcher with the first profile.
  const cycle: DispatchEffects = {
    snapshot: async () => ({ work: [item], now: new Date().toISOString() }), agents: () => agents,
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: (await readReviewLedger(master.root)).reviews }), reconcileProducers: async () => ({ producers: [] }),
    launchReview: (work, dispatch, profile, herdr, observedAt) => launch('cycle', profile.name)(work, dispatch, herdr, observedAt),
    launchProducer: async () => { throw new Error('no producer is under test'); }, persist: async () => {},
  };
  // The stateless executor's request-review handler, launching the other profile for the same request.
  const handlers = controlPlaneHandlers(() => config, {
    snapshot: async () => ({ work: [item], now: new Date().toISOString() }), mutate: async () => ({}), agents: () => agents,
    workerCredentials: async () => ({}), producerCredentials: async () => ({}), dispatchWorker: async () => ({}), launchProducer: async () => ({}), observeDeployment: async () => ({}) as any,
    launchReview: (work, dispatch, herdr, observedAt) => launch('dispatcher', 'second-reviewer')(work, dispatch, herdr, observedAt),
  });
  const action = { id: 'action-1', work: item.id, key: item.key, gate: 'review', kind: 'request-review', inputs: { kind: 'request-review', provider: 'github', requestId: request.id, pr: 119, sha: H, baseSha: B, policyRevision: 3 } } as unknown as ActionRow;
  const both = Promise.allSettled([runDispatchTick(config, emptyDispatchCursor(config), cycle), handlers['request-review']!(action, { id: 'exec-1', host: 'h' })]);
  if (!order.first) { door.cycle.resolve(); door.dispatcher.resolve(); }
  else {
    door[order.first].resolve();
    await (order.at === 'launching' ? minting : settled)[order.first].promise;
    door[other(order.first)].resolve();
  }
  const [tick, dispatched] = await both;
  return { config, item, request, agents, outcomes, tick, dispatched };
}

/** One race's verdict: one session, one record reserved before its runtime started, and the other launcher stood down. */
async function assertOneSession(master: Awaited<ReturnType<typeof reviewerMaster>>, order: (typeof interleavings)[number], result: Awaited<ReturnType<typeof race>>) {
  const { outcomes, tick, dispatched, request } = result;
  const seen = `${order.name}: ${JSON.stringify(outcomes)}`;
  assert.equal(tick.status, 'fulfilled', seen);
  // The executor's row never fails for the race: it launched, or it settled on the session that did.
  assert.equal(dispatched.status, 'fulfilled', `${seen} ${dispatched.status === 'rejected' ? (dispatched.reason as Error).message : ''}`);
  assert.equal(master.log.tabs.length, 1, `one Herdr tab for one request, got ${master.log.tabs.length} — ${seen}`);
  assert.equal(master.log.started.length, 1, `one runtime started — ${seen}`);
  const launched = (['cycle', 'dispatcher'] as const).filter(who => outcomes[who]?.launched);
  assert.equal(launched.length, 1, `one launcher launched — ${seen}`);
  const [winner] = launched, loser = winner === 'cycle' ? 'dispatcher' : 'cycle';
  if (order.first) assert.equal(winner, order.first, seen);
  // The other launcher reached launchReview and was refused there: neither launcher stood down without the other launching.
  assert.equal(outcomes[loser]?.launched, false, `the other launcher stood down — ${seen}`);
  assert.match(outcomes[loser]!.error!, /one review request is answered by one session/, seen);
  if (order.at) assert.match(outcomes[loser]!.error!, order.at === 'launching' ? /is already being launched/ : /is already pending/, seen);
  const ledger = await readReviewLedger(master.root);
  assert.equal(ledger.reviews.length, 1, `one record for one session — ${seen}`);
  const [record] = ledger.reviews;
  assert.deepEqual([record.requestId, record.state, record.pane, record.launching, record.attempt], [request.id, 'pending', master.log.tabs[0], undefined, 1], seen);
  assert.equal(record.profile, winner === 'cycle' ? 'claude-reviewer' : 'second-reviewer', seen);
  // The executor reports what it did: its launch, or the session already answering the head.
  const reported = (dispatched as PromiseFulfilledResult<unknown>).value as string;
  if (winner === 'dispatcher') assert.match(reported, /^launched reviewer /, seen);
  else assert.match(reported, new RegExp(`is left to reviewer session ${record.agentName} already answering that head`), seen);
  // The record existed, as a reservation for this very session, before its runtime was started.
  const atStart = master.log.started[0].recorded;
  assert.equal(atStart.length, 1); assert.equal(atStart[0].id, record.id); assert.equal(atStart[0].launching, true); assert.equal(atStart[0].requestId, request.id);
  return record;
}

test('unit:one-reviewer-per-request — the cycle step and the dispatcher launching for the same request in one tick start one session with one record, recorded before its runtime starts', async () => {
  const master = await reviewerMaster();
  try {
    // GY-1111: the dispatcher losing used to read as "both stood down" — its refusal is settled as its
    // result (GY-1090), not thrown — so each launcher's outcome is now read where it launches, and
    // every order the two can reach the ledger in is driven explicitly.
    let last!: Awaited<ReturnType<typeof race>>, record!: ReviewRecord;
    for (const order of interleavings) { last = await race(master, order); record = await assertOneSession(master, order, last); }
    const { item, request, agents } = last;

    // `master review`, the third launcher, is refused for the same request while the session is pending.
    await assert.rejects(reviewCommand(master.root, ['GY-114', 'second-reviewer'], { work: [item], now: new Date().toISOString() }, agents, { run: master.run, mint: master.mint }), /already pending on c1fffff/);
    assert.equal(master.log.tabs.length, 1);

    // A Herdr session serving the request refuses a launch even when the ledger has no pending
    // record for it — here the settled record whose pane Herdr could not close.
    await updateReviewLedger(master.root, current => { current.reviews = current.reviews.map(entry => ({ ...entry, state: 'failed' as const, closeFailure: 'Herdr could not close pane' })); });
    await assert.rejects(launchReview(master.root, item, 'second-reviewer', [{ name: record.agentName }], new Date().toISOString(), { run: master.run, mint: master.mint, requestId: request.id }),
      new RegExp(`Reviewer session ${record.agentName} is already visible in Herdr for GY-114 review request ${request.id}`));
    // So does a session a multi-session profile named for the request, with no record at all.
    await updateReviewLedger(master.root, current => { current.reviews = []; });
    await saveReviewerProfile(master.root, { name: 'many-reviewer', agentName: 'review-many', kind: 'claude', concurrency: 3 });
    const derived = sessionAgentName({ agentName: 'review-many', concurrency: 3 }, { id: request.id, requestId: request.id, attempt: 2 });
    await assert.rejects(launchReview(master.root, item, 'second-reviewer', [{ name: derived }], new Date().toISOString(), { run: master.run, mint: master.mint, requestId: request.id }),
      new RegExp(`Reviewer session ${derived} is already visible in Herdr`));
    assert.equal(master.log.tabs.length, 1, 'no refused launch created a tab');

    // A reservation whose launcher died mid-launch is failed by reconciliation once it is stale,
    // and a reconciliation never drops a record a launcher reserved while it was running.
    const stale: ReviewRecord = { ...record, id: randomUUID(), state: 'pending', launching: true, pane: null, requestedAt: new Date(Date.now() - 11 * 60_000).toISOString() };
    const running: ReviewRecord = { ...record, id: randomUUID(), state: 'pending', pane: 'pane-running', agentName: 'review-claude-1' };
    await updateReviewLedger(master.root, current => { current.reviews = [stale, running]; });
    let concurrent: ReviewRecord | null = null;
    const reconciled = await reconcileReviews(master.root, await loadMasterConfig(master.root), { run: master.run, work: [item], agents: [], observe: () => {
      // While the pass is reading GitHub, another launcher reserves a record.
      if (!concurrent) { concurrent = { ...record, id: randomUUID(), state: 'pending', launching: true, pane: null, requestedAt: new Date().toISOString() }; void updateReviewLedger(master.root, current => { current.reviews.push(concurrent!); }); }
      return null;
    } });
    await new Promise(done => setTimeout(done, 200));
    const after = await readReviewLedger(master.root);
    assert.equal(after.reviews.find(entry => entry.id === stale.id)?.state, 'failed');
    assert.match(after.reviews.find(entry => entry.id === stale.id)!.resolution!, /never confirmed its runtime started/);
    assert.ok(reconciled.changed >= 1);
    assert.ok(concurrent, 'the pass read GitHub for the running session');
    assert.equal(after.reviews.find(entry => entry.id === concurrent!.id)?.launching, true, 'the reservation made during the pass survives its save');
    assert.ok(after.reviews.find(entry => entry.id === running.id)?.idleSince, 'and the pass still records what it changed');
  } finally { await master.cleanup(); }
});

/** Rounds of every interleaving the repeatable proof runs; the PR records the consecutive whole-file runs. */
const repeatRounds = 10;
test('unit:one-reviewer-per-request-repeatable — every interleaving of the cycle step and the dispatcher, repeated, starts one session with one record each time', async () => {
  const master = await reviewerMaster();
  try {
    for (let round = 1; round <= repeatRounds; round++)
      for (const order of interleavings) await assertOneSession(master, { ...order, name: `round ${round}, ${order.name}` }, await race(master, order));
  } finally { await master.cleanup(); }
});

// ---- Conflicting verdicts on one head: a real Postgres, the observation stubbed ----------------

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:x'] };
/** The mechanical proof passing on the observed head: a review is requested only after it (GY-115). */
const proven = (item: Work) => engine.execute(producer, 'evidence', item.id, { proof: 'unit:x', sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/a.ts'] }, randomUUID());
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_ONE_REVIEWER_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 81);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('gy124-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.principals = [operator, implementer, producer];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('integration:conflicting-verdicts-surfaced — APPROVED then CHANGES_REQUESTED on one head for one request is a conflict: both recorded, attention raised, neither acted on, and a fresh review resolves it', async () => {
  let item = await engine.execute(operator, 'create', null, { title: 'Two verdicts on one head', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:x'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'workspace', item.id, { epoch: 1, host: 'machine-a', path: `/tmp/gy124/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-1` }, randomUUID());
  item = await engine.execute(implementer, 'submit', item.id, { epoch: 1, pr: 119 }, randomUUID());
  const observed = (reviews: Observation['reviews']): Observation => ({ ...observation({ sha: H, baseSha: B }, { reviews }), candidate: { sha: H, baseSha: B, pr: 119, branch: item.workspaces[0].branch, author: 'implementer' } });
  item = await proven(await engine.observe(item.id, item.revision, observed([])));
  const request = item.autoDispatch!.review!;
  assert.equal(request.state, 'requested');

  // The first session approves: the request is satisfied and the review gate passes.
  item = await engine.observe(item.id, item.revision, observed([{ id: 501, reviewer, sha: H, state: 'APPROVED', submittedAt: '2026-09-22T08:00:16Z' }]));
  assert.ok(item.gates.find(gate => gate.name === 'review')!.passed);
  assert.equal(item.autoDispatch!.review, null);
  assert.equal(openReviewConflict(item), null);

  // A second session of the same identity requests changes on the same head a minute later.
  // GitHub now reports that one as the identity's latest; it does not silently replace the first.
  item = await engine.observe(item.id, item.revision, observed([{ id: 502, reviewer, sha: H, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-22T08:01:23Z' }]));
  const conflict = openReviewConflict(item)!;
  assert.ok(conflict, 'the request is marked conflicted');
  assert.deepEqual([conflict.state, conflict.sha, conflict.reviewer, conflict.requestId], ['conflicted', H, reviewer, request.id]);
  assert.deepEqual(conflict.verdicts.map(verdict => [verdict.id, verdict.state, verdict.reviewer]), [[501, 'APPROVED', reviewer], [502, 'CHANGES_REQUESTED', reviewer]], 'both verdicts and reviewers are recorded');
  const raised = (await store.events(item.id)).filter(event => event.kind === 'review.conflicted');
  assert.equal(raised.length, 1); assert.deepEqual(raised[0].payload.details.verdicts.map((verdict: { id: number }) => verdict.id), [501, 502]);
  // Neither verdict is acted on: no approval passes the gate, no change request stands, no rework is requested.
  const review = item.gates.find(gate => gate.name === 'review')!;
  assert.equal(review.passed, false);
  assert.ok(!review.reasons.some(reason => /Outstanding change requests/.test(reason)), 'the change request is not acted on');
  assert.equal(item.reworkRequested, false);
  assert.equal(standingVerdict(item), null, 'no standing verdict asks for rework');
  assert.equal(routineDecision(item, { autoMerge: true }, Date.now()), null, 'the loop requests no rework decision');
  assert.notEqual(item.nextAction?.kind, 'request-rework');
  assert.ok(!item.observation!.reviews.some(entry => entry.id === 501 || entry.id === 502), 'both verdicts are withheld from what the gates read');
  // A fresh review of the head is requested in its place.
  const fresh = (item as Work).autoDispatch!.review as typeof request | null;
  assert.equal(fresh?.state, 'requested'); assert.notEqual(fresh!.id, request.id);
  // Re-reading the same provider state changes nothing.
  const again = await engine.observe(item.id, item.revision, observed([{ id: 502, reviewer, sha: H, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-22T08:01:23Z' }]));
  assert.equal(openReviewConflict(again)?.at, conflict.at); assert.equal((await store.events(item.id)).filter(event => event.kind === 'review.conflicted').length, 1);
  item = again;

  // master status names the item, the head and both sessions — the recorded one and the one the ledger never had.
  const records = [{ id: randomUUID(), agentName: 'review-opencode-1', profile: 'opencode-reviewer', requestId: request.id, verdict: { reviewId: 501 } }];
  const [attention] = reviewConflictAttention([item], records);
  assert.equal(attention.subject, item.key);
  assert.match(attention.text, new RegExp(`Review of ${item.key} head ${H.slice(0, 12)} \\(PR #119\\) is conflicted`));
  assert.match(attention.text, /APPROVED \(review 501 at 2026-09-22T08:00:16Z\) from session review-opencode-1 \(opencode-reviewer/);
  assert.match(attention.text, /CHANGES_REQUESTED \(review 502 at 2026-09-22T08:01:23Z\) from a session the reviewer ledger has no record of/);
  assert.match(attention.text, /Neither verdict is acted on/);

  // The fresh review resolves it, and only that verdict is acted on.
  item = await engine.observe(item.id, item.revision, observed([{ id: 503, reviewer, sha: H, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-22T08:30:00Z' }]));
  assert.equal(openReviewConflict(item), null);
  assert.equal(item.reviewConflict!.state, 'resolved'); assert.equal(item.reviewConflict!.resolvedBy!.id, 503);
  assert.equal((await store.events(item.id)).filter(event => event.kind === 'review.conflict-resolved').length, 1);
  assert.match(standingVerdict(item)!.reason, /requested changes/, 'the fresh verdict is the one the loop acts on');
  assert.deepEqual(reviewConflictAttention([item], records), []);

  // A person is not the reviewer identity: approving and then requesting changes on one head is
  // their latest word, and that change request still blocks — no conflict, nothing withheld.
  let human = await engine.execute(operator, 'create', null, { title: 'A person changes their mind', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:x'] }] }, randomUUID());
  human = await engine.execute(operator, 'ready', human.id, {}, randomUUID());
  human = await engine.execute(implementer, 'claim', human.id, {}, randomUUID());
  human = await engine.execute(implementer, 'workspace', human.id, { epoch: 1, host: 'machine-a', path: `/tmp/gy124/${human.id}`, branch: `graphyard/${human.key.toLowerCase()}-1` }, randomUUID());
  human = await engine.execute(implementer, 'submit', human.id, { epoch: 1, pr: 120 }, randomUUID());
  const byHuman = (reviews: Observation['reviews']): Observation => ({ ...observation({ sha: H, baseSha: B }, { reviews }), candidate: { sha: H, baseSha: B, pr: 120, branch: human.workspaces[0].branch, author: 'implementer' } });
  human = await proven(await engine.observe(human.id, human.revision, byHuman([])));
  assert.equal(human.autoDispatch!.review!.state, 'requested');
  human = await engine.observe(human.id, human.revision, byHuman([{ id: 601, reviewer: 'maintainer', sha: H, state: 'APPROVED', submittedAt: '2026-09-22T09:00:00Z' }]));
  assert.ok(human.gates.find(gate => gate.name === 'review')!.passed);
  human = await engine.observe(human.id, human.revision, byHuman([{ id: 602, reviewer: 'maintainer', sha: H, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-22T09:02:00Z' }]));
  assert.equal(openReviewConflict(human), null, "a person's second verdict is no conflict");
  assert.equal((await store.events(human.id)).filter(event => event.kind === 'review.conflicted').length, 0);
  assert.ok(human.observation!.reviews.some(entry => entry.id === 602), 'the change request reaches the gates');
  const blocked = human.gates.find(gate => gate.name === 'review')!;
  assert.equal(blocked.passed, false);
  assert.ok(blocked.reasons.some(reason => /Outstanding change requests/.test(reason)), 'the change request still blocks');
  // A reviewer-identity approval afterwards does not override it.
  human = await engine.observe(human.id, human.revision, byHuman([{ id: 602, reviewer: 'maintainer', sha: H, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-22T09:02:00Z' }, { id: 603, reviewer, sha: H, state: 'APPROVED', submittedAt: '2026-09-22T09:10:00Z' }]));
  assert.equal(human.gates.find(gate => gate.name === 'review')!.passed, false);
  assert.ok(human.observation!.reviews.some(entry => entry.id === 602));

  // Two reviewer-identity verdicts that answered no recorded request are not grouped as one request's answers.
  const unrequested = work();
  reconcileReviewConflict(unrequested, new Date());
  unrequested.observation = { ...unrequested.observation!, reviews: [{ id: 701, reviewer, sha: H, state: 'APPROVED', submittedAt: '2026-09-22T10:00:00Z' }] };
  reconcileReviewConflict(unrequested, new Date());
  unrequested.observation = { ...unrequested.observation!, reviews: [{ id: 702, reviewer, sha: H, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-22T10:01:00Z' }] };
  assert.deepEqual(reconcileReviewConflict(unrequested, new Date()), []);
  assert.equal(openReviewConflict(unrequested), null);
  assert.ok(unrequested.observation.reviews.some(entry => entry.id === 702));
});
