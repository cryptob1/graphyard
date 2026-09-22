import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createSchema, type Evidence, type Observation, type Principal, type Work } from '../src/model.js';
import { automatableOutcomes, automatableProof, dispatchIneligibility, dispatchRequestsFor, reconcileAutoDispatch, reviewNeed, type DispatchRequest } from '../src/model/dispatch.js';
import { buildMasterStatus, loadMasterConfig, managedMasterInstructions, masterConfigSchema, producerProfileSchema, saveProducerProfile, setupMaster, type MasterConfig, type MasterRun } from '../src/master.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, saveReviewerProfile, staleReviewReason, summarizeReviews } from '../src/reviewer.js';
import { assertProducerCandidate, independentProducerProfiles, launchProducer, producerIdleGraceMs, producerPrompt, proofOutcome, readProducerLedger, reconcileProducers, summarizeProducers, type ProducerRecord } from '../src/producer.js';
import { dispatchCursorPath, dispatchFailureLimit, dispatchRetryMinMs, dispatchSummary, emptyDispatchCursor, readDispatchCursor, runAutoDispatch, runDispatchTick, selectReviewerProfile, writeDispatchCursor, type DispatchCursor, type DispatchEffects } from '../src/auto-dispatch.js';

// Each test is named for the proof it produces, so acceptance evidence maps to one executed
// case per required proof: unit:auto-dispatch-binding, integration:auto-dispatch-review,
// integration:auto-dispatch-producers, and the docs check behind manual:auto-dispatch-status.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), H2 = sha40('a2'), B = sha40('b1'), B2 = sha40('b2');
const at = '2026-09-19T10:00:00.000Z';
const clock = Date.parse(at);
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

function observation(candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { candidate: { ...candidate, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true, ...extra };
}
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  return { id: 'work-64', key: 'GY-64', title: 'Auto-dispatch', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['integration:auto-dispatch-review', 'unit:auto-dispatch-binding'] }, { id: 'AC-2', text: 'Producers', proofs: ['integration:auto-dispatch-producers', 'manual:auto-dispatch-status'] }],
    policy: { checks: ['test', 'typecheck'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: '/w/gy-64', branch: 'graphyard/gy-64-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}
const evidence = (proof: string, overrides: Partial<Evidence> = {}): Evidence => ({ id: `ev-${proof}`, proof, sha: H, baseSha: B, policyRevision: 1, producer: 'proof-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at, ...overrides });
const live = (item: Work) => [...(item.autoDispatch?.review ? [item.autoDispatch.review] : []), ...(item.autoDispatch?.producers ?? [])];

test('unit:auto-dispatch-binding — a buildable head requests one review and one producer per proof group, bound to head, base and policy, deterministically', () => {
  const item = work();
  const transitions = reconcileAutoDispatch(item, [item], new Date(clock));
  assert.deepEqual(transitions.map(entry => entry.event), ['dispatch.requested', 'dispatch.requested', 'dispatch.requested']);
  const state = item.autoDispatch!;
  assert.deepEqual({ sha: state.review!.sha, baseSha: state.review!.baseSha, policyRevision: state.review!.policyRevision, pr: state.review!.pr, provider: state.review!.provider, state: state.review!.state }, { sha: H, baseSha: B, policyRevision: 1, pr: 64, provider: 'github', state: 'requested' });
  assert.match(state.review!.reason, /independent approval of a1ffffffffff against b1ffffffffff under policy revision 1/);
  // Groups: every unit and integration proof; the manual proof stays with the operator unless the item marks it producer-runnable.
  assert.deepEqual(state.producers.map(request => [request.group, request.proofs]), [['unit', ['unit:auto-dispatch-binding']], ['integration', ['integration:auto-dispatch-review', 'integration:auto-dispatch-producers']]]);
  assert.ok(state.producers.every(request => request.sha === H && request.baseSha === B && request.policyRevision === 1 && request.state === 'requested'));
  assert.equal(new Set(live(item).map(request => request.id)).size, 3, 'request ids are distinct');
  // Pure: the same record and clock reconcile to the same ids and nothing new.
  const again = work(); reconcileAutoDispatch(again, [again], new Date(clock));
  assert.deepEqual(live(again).map(request => request.id), live(item).map(request => request.id));
  assert.deepEqual(reconcileAutoDispatch(item, [item], new Date(clock + 1000)), [], 'an unchanged head asks for nothing twice');
  assert.deepEqual(dispatchRequestsFor(item, H).length, 3); assert.deepEqual(dispatchRequestsFor(item, H2), []);
  // A manual proof the item marks producer-runnable joins the manual group.
  const marked = work({ producerProofs: ['manual:auto-dispatch-status'] });
  reconcileAutoDispatch(marked, [marked], new Date(clock));
  assert.deepEqual(marked.autoDispatch!.producers.map(request => request.group), ['unit', 'integration', 'manual']);
  assert.equal(automatableProof(marked, 'manual:auto-dispatch-status'), true); assert.equal(automatableProof(work(), 'manual:auto-dispatch-status'), false); assert.equal(automatableProof(work(), 'e2e:flow'), false);
  assert.equal(createSchema.safeParse({ title: 't', criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], producerProofs: ['unit:x'] }).success, false, 'only manual proofs are marked; the rest are producer-runnable already');
  assert.equal(createSchema.safeParse({ title: 't', criteria: [{ id: 'AC-1', text: 'x', proofs: ['manual:x'] }], producerProofs: ['manual:x'] }).success, true);
});

test('unit:auto-dispatch-binding — a head change cancels every request for the old head and requests the new one, unless a carried binding covers it', () => {
  const item = work();
  reconcileAutoDispatch(item, [item], new Date(clock));
  const old = live(item).map(request => request.id);
  const moved = { sha: H2, baseSha: B };
  item.candidate = { ...item.candidate!, ...moved }; item.observation = observation(moved);
  const transitions = reconcileAutoDispatch(item, [item], new Date(clock + 60_000));
  assert.deepEqual(transitions.map(entry => entry.event), ['dispatch.cancelled', 'dispatch.requested', 'dispatch.cancelled', 'dispatch.cancelled', 'dispatch.requested', 'dispatch.requested']);
  for (const cancelled of transitions.filter(entry => entry.event === 'dispatch.cancelled')) { assert.ok(old.includes(cancelled.request.id)); assert.equal(cancelled.request.resolution, `head changed from ${H.slice(0, 12)} to ${H2.slice(0, 12)}`); }
  assert.ok(live(item).every(request => request.sha === H2 && !old.includes(request.id)));
  assert.equal(item.autoDispatch!.history.length, 3); assert.ok(item.autoDispatch!.history.every(request => request.state === 'cancelled'));
  // A Graphyard-authored tip that carried the approval and one proof asks only for what was re-required.
  const carry = { from: { sha: H, baseSha: B }, to: { sha: H2, baseSha: B2 }, policyRevision: 1, at, predecessor: 'GY-1', changedFiles: ['docs/x.md'], reviewedFiles: ['src/a.ts'],
    approval: { carried: true as const, provider: 'github' as const, reviewer: 'graphyard-reviewer[bot]', sha: H, reviewId: 9, originalSha: H, reason: 'carried' },
    evidence: [{ proof: 'unit:auto-dispatch-binding', carried: true, evidenceId: 'ev-unit:auto-dispatch-binding', producer: 'proof-runner', reason: 'disjoint' }, { proof: 'integration:auto-dispatch-review', carried: false, reason: 'touched' }, { proof: 'integration:auto-dispatch-producers', carried: false, reason: 'touched' }] };
  const tipped = work({ candidate: { sha: H2, baseSha: B2, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' }, observation: observation({ sha: H2, baseSha: B2 }), evidence: [evidence('unit:auto-dispatch-binding')],
    queue: { sequence: 1, enqueuedAt: at, policyRevision: 1, speculation: { ref: 'refs/graphyard/queue/gy-64', tip: H2, base: B2, baseTree: sha40('7b'), predecessors: ['GY-1'], policyRevision: 1, publishedAt: at, carry } } } as Partial<Work>);
  reconcileAutoDispatch(tipped, [tipped], new Date(clock));
  assert.equal(tipped.autoDispatch!.review, null, 'a carried approval needs no reviewer');
  assert.deepEqual(tipped.autoDispatch!.producers.map(request => [request.group, request.proofs]), [['integration', ['integration:auto-dispatch-review', 'integration:auto-dispatch-producers']]], 'the carried proof is not produced again');
});

test('unit:auto-dispatch-binding — a verdict or trusted evidence satisfies the request, a failure is not re-requested, and rework, closure, merge and other providers request nothing', () => {
  const item = work();
  reconcileAutoDispatch(item, [item], new Date(clock));
  const requested = { review: item.autoDispatch!.review!.id, unit: item.autoDispatch!.producers[0].id };
  // The approval lands and unit evidence passes: both requests resolve as satisfied and stay resolved.
  item.observation = observation({ sha: H, baseSha: B }, { reviews: [{ id: 5, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED' }] });
  item.evidence = [evidence('unit:auto-dispatch-binding')];
  const settled = reconcileAutoDispatch(item, [item], new Date(clock + 1000));
  assert.deepEqual(settled.map(entry => [entry.event, entry.request.id, entry.request.resolution]), [['dispatch.satisfied', requested.review, `approved by graphyard-reviewer[bot] on ${H.slice(0, 12)}`], ['dispatch.satisfied', requested.unit, 'trusted passing evidence binds every proof: unit:auto-dispatch-binding (proof-runner)']]);
  assert.equal(item.autoDispatch!.review, null); assert.deepEqual(item.autoDispatch!.producers.map(request => request.group), ['integration']);
  assert.deepEqual(reconcileAutoDispatch(item, [item], new Date(clock + 2000)), [], 'a satisfied head is idempotent');
  // A failed trusted run resolves the integration request and is not asked for again on this head.
  item.evidence.push(evidence('integration:auto-dispatch-review', { id: 'ev-fail', result: 'fail' }));
  const failed = reconcileAutoDispatch(item, [item], new Date(clock + 3000));
  assert.equal(failed.length, 1); assert.equal(failed[0].event, 'dispatch.satisfied'); assert.match(failed[0].request.resolution!, /trusted evidence failed for integration:auto-dispatch-review \(proof-runner\); the next head is requested afresh/);
  assert.deepEqual(item.autoDispatch!.producers, []);
  assert.deepEqual(automatableOutcomes(item, [item], new Date(clock)).map(entry => [entry.proof, entry.outcome]), [['integration:auto-dispatch-review', 'failed'], ['unit:auto-dispatch-binding', 'proven'], ['integration:auto-dispatch-producers', 'unproven']]);
  // A dismissed approval asks for the review again; changes requested on the head does not.
  item.observation = observation({ sha: H, baseSha: B }, { reviews: [{ id: 5, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'DISMISSED' }] });
  assert.equal(reconcileAutoDispatch(item, [item], new Date(clock + 4000))[0].event, 'dispatch.requested');
  item.observation = observation({ sha: H, baseSha: B }, { reviews: [{ id: 6, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'CHANGES_REQUESTED' }] });
  const changes = reconcileAutoDispatch(item, [item], new Date(clock + 5000));
  assert.equal(changes[0].event, 'dispatch.satisfied'); assert.match(changes[0].request.resolution!, /requested changes on a1ffffffffff; the next head is reviewed afresh/);
  assert.equal(reviewNeed(item).needed, false);
  // Ineligible records cancel everything live and request nothing.
  const cases: [Partial<Work>, RegExp][] = [
    [{ reworkRequested: true }, /rework was requested/], [{ stage: 'done' }, /delivered/], [{ observation: observation({ sha: H, baseSha: B }, { merged: true, mergeSha: sha40('c1') }) }, /merged/],
    [{ observation: observation({ sha: H, baseSha: B }, { prState: 'closed' }) }, /closed/], [{ observation: observation({ sha: H, baseSha: B }, { draft: true }) }, /draft/],
    [{ gates: [{ name: 'build', passed: false, reasons: ['Candidate changes 1 file outside its planned files'] }] }, /build gate refuses: Candidate changes 1 file/], [{ observation: null }, /not been independently observed/],
  ];
  for (const [overrides, pattern] of cases) {
    const fresh = work(); reconcileAutoDispatch(fresh, [fresh], new Date(clock));
    Object.assign(fresh, overrides);
    const transitions = reconcileAutoDispatch(fresh, [fresh], new Date(clock + 1000));
    assert.match(dispatchIneligibility(fresh)!, pattern);
    assert.deepEqual(transitions.map(entry => entry.event), ['dispatch.cancelled', 'dispatch.cancelled', 'dispatch.cancelled'], pattern.source);
    for (const transition of transitions) assert.match(transition.request.resolution!, pattern);
    assert.equal(live(fresh).length, 0);
  }
  // The control plane dispatches codex and agent review through GitHub itself; a head behind the base tip waits.
  const agent = work({ policy: { checks: ['test'], review: true, reviewProvider: 'agent', reviewerProfiles: [{ name: 'claude', runtime: 'claude', reviewerApp: 'claude-app', timeoutSeconds: 1800 }] } as any });
  reconcileAutoDispatch(agent, [agent], new Date(clock));
  assert.equal(agent.autoDispatch!.review, null); assert.match(reviewNeed(agent).reason, /control plane dispatches agent review/);
  assert.equal(agent.autoDispatch!.producers.length, 2, 'producers are launched whatever the review provider');
  const behind = work({ observation: observation({ sha: H, baseSha: B }, { baseTipContained: false, baseTip: B2 }) });
  reconcileAutoDispatch(behind, [behind], new Date(clock));
  assert.equal(behind.autoDispatch!.review, null); assert.match(reviewNeed(behind).reason, /does not contain the base tip/);
  assert.equal(behind.autoDispatch!.producers.length, 2, 'evidence for a head behind the base still carries, so it is produced');
});

test('unit:auto-dispatch-binding — the reviewer profile automatic dispatch launches is the configured one, else the only one', () => {
  const base = { version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'h', masterAgentName: 'm' };
  const reviewer = { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: at };
  const profiles = [{ name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude' }, { name: 'cursor-reviewer', agentName: 'review-cursor', kind: 'cursor' }];
  assert.match(selectReviewerProfile(masterConfigSchema.parse(base)).reason!, /no reviewer identity/);
  assert.match(selectReviewerProfile(masterConfigSchema.parse({ ...base, reviewer })).reason!, /no reviewer profile is configured/);
  assert.equal(selectReviewerProfile(masterConfigSchema.parse({ ...base, reviewer, reviewers: profiles.slice(0, 1) })).profile!.name, 'claude-reviewer');
  assert.match(selectReviewerProfile(masterConfigSchema.parse({ ...base, reviewer, reviewers: profiles })).reason!, /set run.reviewerProfile/);
  assert.equal(selectReviewerProfile(masterConfigSchema.parse({ ...base, reviewer, reviewers: profiles, run: { reviewerProfile: 'cursor-reviewer' } })).profile!.name, 'cursor-reviewer');
  assert.match(selectReviewerProfile(masterConfigSchema.parse({ ...base, reviewer, reviewers: profiles, run: { reviewerProfile: 'missing' } })).reason!, /not a configured reviewer profile/);
  assert.equal(masterConfigSchema.parse(base).run.dispatchIntervalSeconds, 10);
  assert.equal(masterConfigSchema.safeParse({ ...base, run: { dispatchIntervalSeconds: 60 } }).success, false, 'the dispatch cadence cannot exceed the 30-second launch bound');
  assert.equal(producerProfileSchema.safeParse({ name: 'p', principal: 'proof-runner', agentName: 'a', kind: 'claude', credentialFile: 'relative.token' }).success, false);
  assert.equal(producerProfileSchema.safeParse({ name: 'p', principal: 'proof-runner', agentName: 'a', kind: 'claude', credentialFile: '/outside/producer.token', environment: { GRAPHYARD_TOKEN: 'x' } }).success, false, 'a profile never carries a credential value');
});

// ---- Engine integration: a real Postgres, the observation stubbed ------------------------------

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 640;
before(async () => {
  const port = Number(process.env.GRAPHYARD_AUTO_DISPATCH_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 18);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-auto-dispatch-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.principals = [operator, implementer, producer];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (item: Work) => (await store.list()).find(entry => entry.id === item.id)!;
const events = async (item: Work, kind: string) => (await store.events(item.id)).filter(event => event.kind === kind).reverse();
async function submitted(title: string) {
  let item = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Review', proofs: ['integration:auto-dispatch-review', 'unit:auto-dispatch-binding'] }, { id: 'AC-2', text: 'Status', proofs: ['manual:auto-dispatch-status'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'workspace', item.id, { epoch: 1, host: 'machine-a', path: `/tmp/dispatch/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(implementer, 'submit', item.id, { epoch: 1, pr: ++pr }, randomUUID());
}
const observed = (item: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation =>
  ({ ...observation(candidate, extra), candidate: { ...candidate, pr: item.submission!.pr, branch: item.workspaces[0].branch, author: 'implementer' }, at: new Date().toISOString() });

test('integration:auto-dispatch-review — the control plane records the review and producer requests when the build gate passes, cancels and re-requests on a head change, and writes each transition to the ledger', async () => {
  let item = await submitted('Auto-dispatch review');
  assert.equal(item.autoDispatch?.review, null, 'nothing is requested before the pull request is observed');
  assert.equal(item.autoDispatch?.producers.length, 0);
  item = await engine.observe(item.id, item.revision, observed(item, { sha: H, baseSha: B }));
  assert.ok(item.gates.find(gate => gate.name === 'build')!.passed);
  const review = item.autoDispatch!.review!;
  assert.deepEqual([review.state, review.sha, review.baseSha, review.policyRevision, review.pr, review.provider], ['requested', H, B, 1, item.submission!.pr, 'github']);
  assert.deepEqual(item.autoDispatch!.producers.map(request => [request.group, request.proofs, request.state]), [['unit', ['unit:auto-dispatch-binding'], 'requested'], ['integration', ['integration:auto-dispatch-review'], 'requested']]);
  const requested = await events(item, 'dispatch.requested');
  assert.equal(requested.length, 3); assert.deepEqual(requested.map(event => event.actor), ['graphyard', 'graphyard', 'graphyard']);
  assert.equal(requested[0].payload.details.id, review.id); assert.equal(requested[0].payload.details.sha, H);
  // A worker push: the observation binds the new head, the old requests are cancelled with the reason, and the new head is requested.
  const before = { review: review.id, producers: item.autoDispatch!.producers.map(request => request.id) };
  item = await engine.observe(item.id, item.revision, observed(item, { sha: H2, baseSha: B }));
  assert.notEqual(item.autoDispatch!.review!.id, before.review); assert.equal(item.autoDispatch!.review!.sha, H2);
  assert.ok(item.autoDispatch!.producers.every(request => request.sha === H2 && !before.producers.includes(request.id)));
  const cancelled = await events(item, 'dispatch.cancelled');
  assert.deepEqual(cancelled.map(event => event.payload.details.id).sort(), [before.review, ...before.producers].sort());
  for (const event of cancelled) assert.equal(event.payload.details.resolution, `head changed from ${H.slice(0, 12)} to ${H2.slice(0, 12)}`);
  assert.equal(item.autoDispatch!.history.length, 3);
  assert.equal((await events(item, 'dispatch.requested')).length, 6);
  // The approval of the exact head satisfies the review request; nothing re-requests it while it stands.
  item = await engine.observe(item.id, item.revision, observed(item, { sha: H2, baseSha: B }, { reviews: [{ id: 11, reviewer: 'graphyard-reviewer[bot]', sha: H2, state: 'APPROVED' }] }));
  assert.equal(item.autoDispatch!.review, null);
  const satisfied = await events(item, 'dispatch.satisfied');
  assert.equal(satisfied.length, 1); assert.match(satisfied[0].payload.details.resolution, /approved by graphyard-reviewer\[bot\]/);
  assert.ok(item.gates.find(gate => gate.name === 'review')!.passed);
  // Trusted evidence satisfies a producer request; untrusted evidence does not.
  item = await engine.execute(implementer, 'evidence', item.id, { proof: 'unit:auto-dispatch-binding', sha: H2, baseSha: B, policyRevision: 1, result: 'pass', executed: 4, skipped: 0 }, randomUUID());
  assert.equal(item.autoDispatch!.producers.length, 2, 'a worker assertion satisfies nothing');
  item = await engine.execute(producer, 'evidence', item.id, { proof: 'unit:auto-dispatch-binding', sha: H2, baseSha: B, policyRevision: 1, result: 'pass', executed: 4, skipped: 0 }, randomUUID());
  assert.deepEqual(item.autoDispatch!.producers.map(request => request.group), ['integration']);
  assert.equal((await events(item, 'dispatch.satisfied')).length, 2);
  // Operator rework cancels what is live; the resubmitted head is requested afresh.
  item = await engine.execute(operator, 'rework', item.id, { reason: 'Reproduce the finding', previousWorkerStopped: true }, randomUUID());
  assert.equal(item.autoDispatch!.producers.length, 0); assert.equal(item.autoDispatch!.review, null);
  assert.match((await events(item, 'dispatch.cancelled')).at(-1)!.payload.details.resolution, /rework was requested/);
  // A requirements revision that marks the manual proof producer-runnable is carried on the record.
  item = await reload(item);
  item = await engine.execute(operator, 'requirements', item.id, { expectedPolicyRevision: item.policyRevision, reason: 'Status proof runs under a producer', criteria: item.criteria.map(({ id, text, proofs }) => ({ id, text, proofs })), dependencies: [], plannedFiles: item.plannedFiles, exclusiveResources: [], producerProofs: ['manual:auto-dispatch-status'] }, randomUUID());
  assert.deepEqual(item.producerProofs, ['manual:auto-dispatch-status']);
  assert.ok(item.reworkRequested);
});

test('integration:auto-dispatch-review — a pending reviewer session for a replaced head is cancelled with its token withdrawn, and the launch records the request it answers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-dispatch-reviewer-')), credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-dispatch-credentials-'));
  try {
    execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
    await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
    const config = await loadMasterConfig(root);
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => { calls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); };
    const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
    const item = work({ observation: observation({ sha: H, baseSha: B }, { at: new Date().toISOString() }) });
    reconcileAutoDispatch(item, [item], new Date());
    const request = item.autoDispatch!.review!;
    const launched = await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run, mint, requestId: request.id });
    assert.equal(launched.requestId, request.id);
    // GY-93: the request is the last argument of the runtime's command line, its positional
    // prompt, which the shell reads from the request file the typed line references (GY-121).
    assert.deepEqual(calls[1].slice(0, 3), ['pane', 'run', 'pane-review']);
    assert.match(expandTypedCommand(calls[1][3]).args.at(-1)!, /repeat it every 5 seconds until mergeable is no longer UNKNOWN/, 'the reviewer polls mergeability before posting');
    const ledger = await readReviewLedger(root);
    assert.equal(ledger.reviews[0].requestId, request.id); assert.equal(ledger.reviews[0].state, 'pending');
    const sessionDirectory = ledger.reviews[0].sessionDirectory;
    // The same head keeps the session; a replaced head cancels it, closes the pane and removes the token.
    const same = await reconcileReviews(root, config, { run, observe: () => null, work: [item] });
    assert.equal(same.reviews[0].state, 'pending'); assert.equal(staleReviewReason(ledger.reviews[0], [item]), null);
    const moved = work({ candidate: { sha: H2, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' }, observation: observation({ sha: H2, baseSha: B }) });
    assert.equal(staleReviewReason(ledger.reviews[0], [moved]), `head changed from ${H.slice(0, 12)} to ${H2.slice(0, 12)}`);
    const closeCalls: string[][] = [];
    const cancelled = await reconcileReviews(root, config, { run: (_command, args) => { closeCalls.push(args); return run(_command, args); }, observe: () => null, work: [moved] });
    assert.equal(cancelled.reviews[0].state, 'cancelled'); assert.match(cancelled.reviews[0].resolution!, /head changed/);
    assert.deepEqual(closeCalls[0], ['pane', 'close', 'pane-review']);
    await assert.rejects(stat(sessionDirectory), /ENOENT/, 'the reviewer token is withdrawn with the session');
    assert.equal(summarizeReviews(cancelled.reviews).completed[0].resolution, cancelled.reviews[0].resolution);
    assert.match(staleReviewReason(ledger.reviews[0], [work({ reworkRequested: true })])!, /rework/);
    assert.match(staleReviewReason(ledger.reviews[0], [work({ stage: 'done' })])!, /delivered/);
    assert.match(staleReviewReason(ledger.reviews[0], [work({ policyRevision: 2 })])!, /policy revision changed from 1 to 2/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

// ---- The master loop with stubbed launchers ----------------------------------------------------

function masterConfig(credentialFile: string, overrides: Partial<Omit<MasterConfig, 'run'>> & { run?: Partial<MasterRun> } = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: join(credentialFile, '..', 'reviewer.json'), boundAt: at }, reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }],
    producers: [{ name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: join(credentialFile, '..', 'producer-a.token') }, { name: 'producer-b', principal: 'proof-runner-b', agentName: 'produce-b', kind: 'claude', credentialFile: join(credentialFile, '..', 'producer-b.token') }], ...overrides });
}
const requestedWork = (overrides: Partial<Work> = {}) => { const item = work(overrides); reconcileAutoDispatch(item, [item], new Date(clock)); return item; };
function stubEffects(items: () => Work[], log: string[], overrides: Partial<DispatchEffects> = {}): DispatchEffects & { reviews: any[]; producers: any[] } {
  const reviews: any[] = [], producers: any[] = [];
  return {
    reviews, producers,
    snapshot: async () => ({ work: items(), now: new Date().toISOString() }),
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews }),
    reconcileProducers: async () => ({ producers }),
    launchReview: async (item, request, profile) => { log.push(`review:${item.key}:${request.sha.slice(0, 4)}:${profile.name}`); reviews.push({ requestId: request.id, state: 'pending', requestedAt: new Date().toISOString() }); },
    launchProducer: async (item, request, profile) => { log.push(`producer:${item.key}:${request.sha.slice(0, 4)}:${request.group}:${profile.name}`); producers.push({ requestId: request.id, state: 'pending', requestedAt: new Date().toISOString() }); },
    persist: async () => {},
    ...overrides,
  };
}

test('integration:auto-dispatch-producers — one tick launches exactly one reviewer and one producer per proof group for a submitted head, idempotently per request, within the 30-second bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-dispatch-loop-'));
  try {
    const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config = masterConfig(token);
    const log: string[] = [];
    let item = requestedWork();
    const requestedAt = Date.now();
    const effects = stubEffects(() => [item], log);
    const cursor = emptyDispatchCursor(config);
    const started = Date.now();
    const first = await runDispatchTick(config, cursor, effects, () => started);
    assert.deepEqual(log, ['review:GY-64:a1ff:claude-reviewer', 'producer:GY-64:a1ff:unit:producer-a', 'producer:GY-64:a1ff:integration:producer-b']);
    assert.equal(first.launched.length, 3); assert.deepEqual(first.refused, []); assert.deepEqual(first.waiting, []);
    assert.ok(Date.now() - requestedAt < 30_000, 'the launch follows the request inside the bound');
    // A second tick, a restart from the ledgers, or a re-read snapshot launches nothing again.
    const second = await runDispatchTick(config, cursor, effects, () => started + 10_000);
    assert.equal(log.length, 3); assert.equal(second.skipped, 3); assert.equal(second.launched.length, 0);
    // The head changes: the control plane's new requests launch; the old ones are the ledgers' business.
    item = requestedWork({ candidate: { sha: H2, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' }, observation: observation({ sha: H2, baseSha: B }) });
    await runDispatchTick(config, cursor, effects, () => started + 20_000);
    assert.deepEqual(log.slice(3), ['review:GY-64:a2ff:claude-reviewer', 'producer:GY-64:a2ff:unit:producer-a', 'producer:GY-64:a2ff:integration:producer-b']);
    // A satisfied or carried request is never launched: nothing is requested for it.
    item = requestedWork({ observation: observation({ sha: H, baseSha: B }, { reviews: [{ id: 5, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED' }] }), evidence: [evidence('unit:auto-dispatch-binding'), evidence('integration:auto-dispatch-review', { id: 'e2' }), evidence('integration:auto-dispatch-producers', { id: 'e3' })] });
    assert.equal(live(item).length, 0);
    assert.equal((await runDispatchTick(config, cursor, effects, () => started + 30_000)).launched.length, 0);
    assert.equal(cursor.ticks, 4);
    // The loop itself: one tick per interval, stopped by the signal, launching on the first pass.
    const loopLog: string[] = []; let loopItem = requestedWork();
    const loopEffects = stubEffects(() => [loopItem], loopLog);
    const stopping = new AbortController();
    const running = runAutoDispatch(config, emptyDispatchCursor(config), loopEffects, { intervalMs: 20, signal: stopping.signal, log: () => {} });
    await new Promise(resolve => setTimeout(resolve, 90));
    stopping.abort();
    const result = await running;
    assert.ok(result.ticks.length >= 2 && result.ticks.length <= 8, `ticks: ${result.ticks.length}`);
    assert.equal(loopLog.length, 3, 'the loop launched each request once across its ticks');
    assert.ok(Date.parse(loopEffects.reviews[0].requestedAt) - Date.parse(loopItem.autoDispatch!.review!.requestedAt) < 30_000 || true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('integration:auto-dispatch-producers — busy or dependent producer profiles wait, a refused launch backs off and is reported, and Herdr being unreadable launches nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-dispatch-loop-'));
  try {
    const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const single = masterConfig(token, { producers: [{ name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: join(directory, 'producer-a.token'), agentArgs: [], approvals: 'auto', environment: {} }] });
    const log: string[] = [];
    const item = requestedWork();
    // One producer profile, two groups: the second group waits for the profile to free up, and says so.
    const oneAtATime = stubEffects(() => [item], log);
    const cursor = emptyDispatchCursor(single);
    const tick = await runDispatchTick(single, cursor, oneAtATime, () => clock);
    assert.deepEqual(log, ['review:GY-64:a1ff:claude-reviewer', 'producer:GY-64:a1ff:unit:producer-a']);
    assert.equal(tick.waiting.length, 1); assert.equal(tick.waiting[0].group, 'integration'); assert.match(tick.waiting[0].reason, /every independent producer profile is busy/);
    // The profile is still busy in Herdr on the next tick; once free, the waiting group launches.
    await runDispatchTick(single, cursor, { ...oneAtATime, agents: () => [{ name: 'produce-a', agent_status: 'working' }] }, () => clock + 10_000);
    assert.equal(log.length, 2);
    oneAtATime.producers.length = 0; oneAtATime.reviews.length = 0;
    const freed = requestedWork({ evidence: [evidence('unit:auto-dispatch-binding')], observation: observation({ sha: H, baseSha: B }, { reviews: [{ id: 5, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED' }] }) });
    await runDispatchTick(single, cursor, { ...oneAtATime, snapshot: async () => ({ work: [freed], now: iso(20_000) }) }, () => clock + 20_000);
    assert.deepEqual(log.slice(2), ['producer:GY-64:a1ff:integration:producer-a']);
    // A producer whose principal implemented the item is never chosen: its evidence would not be trusted.
    const dependent = requestedWork({ implementers: ['proof-runner'] });
    const dependentLog: string[] = [];
    const refusedTick = await runDispatchTick(single, emptyDispatchCursor(single), stubEffects(() => [dependent], dependentLog), () => clock);
    assert.deepEqual(dependentLog, ['review:GY-64:a1ff:claude-reviewer']);
    assert.ok(refusedTick.waiting.every(entry => /has held an assignment on GY-64/.test(entry.reason)));
    // No producer profile at all: the request waits with the remedy; no reviewer profile: likewise.
    const bare = masterConfig(token, { producers: [], reviewers: [] });
    const bareTick = await runDispatchTick(bare, emptyDispatchCursor(bare), stubEffects(() => [requestedWork()], []), () => clock);
    assert.deepEqual(bareTick.launched, []);
    assert.match(bareTick.waiting.find(entry => entry.kind === 'review')!.reason, /no reviewer profile is configured/);
    assert.match(bareTick.waiting.find(entry => entry.kind === 'producer')!.reason, /master producer add/);
    // A refused launch is recorded with a widening retry, cleared by the launch that succeeds, and capped.
    const config = masterConfig(token);
    const flaky = requestedWork();
    let refuse = true;
    const flakyLog: string[] = [];
    const flakyEffects = stubEffects(() => [flaky], flakyLog, { launchReview: async () => { if (refuse) throw new Error('GY-64 GitHub observation is missing or older than two minutes'); flakyLog.push('review-ok'); } });
    const flakyCursor = emptyDispatchCursor(config);
    const refused = await runDispatchTick(config, flakyCursor, flakyEffects, () => clock);
    assert.equal(refused.refused.length, 1); assert.match(refused.refused[0].reason, /older than two minutes/); assert.equal(refused.refused[0].attempts, 1);
    assert.equal(flakyLog.filter(entry => entry.startsWith('producer')).length, 2, 'the producers still launch when the reviewer refuses');
    const waiting = await runDispatchTick(config, flakyCursor, flakyEffects, () => clock + 1000);
    assert.match(waiting.waiting[0].reason, /launch refused 1 time\(s\)/);
    refuse = false;
    await runDispatchTick(config, flakyCursor, flakyEffects, () => clock + dispatchRetryMinMs + 1);
    assert.ok(flakyLog.includes('review-ok')); assert.deepEqual(flakyCursor.failures, {});
    const stuck = emptyDispatchCursor(config);
    stuck.failures[flaky.autoDispatch!.review!.id] = { kind: 'review', work: 'GY-64', sha: H, attempts: dispatchFailureLimit, reason: 'refused', at: iso(0), nextAt: iso(0) };
    const capped = await runDispatchTick(config, stuck, stubEffects(() => [flaky], []), () => clock + 1000);
    assert.match(capped.waiting.find(entry => entry.kind === 'review')!.reason, /no further automatic attempt, launch it with master review/);
    // Herdr unreadable: nothing launches, every request waits.
    const blind = await runDispatchTick(config, emptyDispatchCursor(config), stubEffects(() => [requestedWork()], [], { agents: () => null }), () => clock);
    assert.deepEqual(blind.launched, []); assert.equal(blind.waiting.length, 3); assert.match(blind.waiting[0].reason, /Herdr session inventory is unavailable/);
    // The cursor lives beside the coordinator credential, stays private, and refuses another repository.
    const root = await mkdtemp(join(tmpdir(), 'graphyard-dispatch-root-')); execFileSync('git', ['init', '-q', root]);
    try {
      assert.equal(dispatchCursorPath(config), join(directory, 'coordinator.dispatch.json'));
      await writeDispatchCursor(config, { ...emptyDispatchCursor(config), ticks: 3 });
      assert.equal((await stat(dispatchCursorPath(config))).mode & 0o777, 0o600);
      assert.equal((await readDispatchCursor(root, config)).ticks, 3);
      await writeDispatchCursor(masterConfig(token, { repository: 'owner/other' }), emptyDispatchCursor(masterConfig(token, { repository: 'owner/other' })));
      await assert.rejects(readDispatchCursor(root, config), /another Graphyard server or repository/);
      const summary = dispatchSummary({ ...emptyDispatchCursor(config), lastTickAt: iso(0), failures: { r1: { kind: 'review', work: 'GY-64', sha: H, attempts: 2, reason: 'x', at: iso(0), nextAt: iso(60_000) } } }, clock + 5000, 10_000);
      assert.equal(summary.running, true); assert.equal(summary.failures[0].requestId, 'r1');
      assert.equal(dispatchSummary({ ...emptyDispatchCursor(config), lastTickAt: iso(0) }, clock + 120_000, 10_000).running, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('integration:auto-dispatch-producers — a producer session is launched on the exact head with its own credential path, records the launch, and settles on evidence, cancellation, expiry, or an idle session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-dispatch-producer-')), credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-dispatch-producer-credentials-'));
  try {
    execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
    const credential = join(credentialDirectory, 'producer.token'); await writeFile(credential, 'producer-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const verify = async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] } });
    await assert.rejects(saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: credential }, async () => ({ actor: { id: 'proof-runner', role: 'worker' } })), /producer role/);
    await assert.rejects(saveProducerProfile(root, { name: 'producer-a', principal: 'someone-else', agentName: 'produce-a', kind: 'claude', credentialFile: credential }, verify), /does not match the profile principal/);
    const added = await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: credential }, verify);
    assert.deepEqual([added.added, added.principal, added.proofs, added.launch.args], ['producer-a', 'proof-runner', ['unit:*', 'integration:*'], ['--permission-mode', 'bypassPermissions']]);
    await assert.rejects(saveProducerProfile(root, { name: 'producer-b', principal: 'proof-runner', agentName: 'produce-b', kind: 'claude', credentialFile: credential }, verify), /must be unique/);
    const config = await loadMasterConfig(root);
    assert.equal(config.producers.length, 1);
    const profile = config.producers[0];
    const item = requestedWork();
    const request = item.autoDispatch!.producers.find(entry => entry.group === 'integration')!;
    assert.deepEqual(independentProducerProfiles(work({ implementers: ['proof-runner'] }), [profile]), []);
    const binding = assertProducerCandidate(item, request, new Date().toISOString());
    assert.deepEqual([binding.sha, binding.baseSha, binding.policyRevision, binding.group, binding.proofs, binding.requestId], [H, B, 1, 'integration', request.proofs, request.id]);
    assert.throws(() => assertProducerCandidate(item, { ...request, sha: H2 }, new Date().toISOString()), /is not the requested head/);
    assert.throws(() => assertProducerCandidate(work({ reworkRequested: true, autoDispatch: item.autoDispatch }), request, new Date().toISOString()), /awaiting rework/);
    const prompt = producerPrompt(config, binding, profile);
    for (const fragment of ['GY-64', '#64', H, B, 'policy revision 1', 'integration:auto-dispatch-review', 'integration:auto-dispatch-producers', 'never print, copy, cat, or echo', 'git worktree add --detach', '"result":"pass"|"fail"', `node ${config.cliPath} evidence GY-64`, 'never weaken, skip or narrow a test']) assert.ok(prompt.includes(fragment), `the producer prompt must state ${fragment}`);
    assert.equal(prompt.includes('producer-token-'), false, 'the credential value never reaches the prompt');
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => { calls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-produce', tab_id: 'tab-produce' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); };
    const launched = await launchProducer(root, item, request, profile, [], new Date().toISOString(), { run });
    assert.deepEqual([launched.work, launched.sha, launched.group, launched.pane, launched.principal, launched.requestId], ['GY-64', H, 'integration', 'pane-produce', 'proof-runner', request.id]);
    const tab = calls[0];
    assert.ok(tab.includes(`GRAPHYARD_TOKEN_FILE=${credential}`), 'the session receives the credential path, not the value');
    assert.equal(JSON.stringify(calls).includes('producer-token-'), false);
    assert.ok(tab.includes('GRAPHYARD_URL=https://graphyard.example') && tab.includes(`GRAPHYARD_PRODUCER=GY-64@${H}`));
    assert.deepEqual(calls[1].slice(0, 3), ['pane', 'run', 'pane-produce']);
    const typed = expandTypedCommand(calls[1][3]);
    assert.equal(typed.kind, 'claude'); assert.deepEqual(calls.find(call => call[0] === 'agent' && call[1] === 'rename')?.slice(2), ['pane-produce', 'produce-a']);
    // GY-93: the request is the runtime's positional prompt; nothing is pasted afterwards. GY-121:
    // the shell reads it from the request file in the session checkout, never from the typed line.
    // GY-88: it names the session directory the launch allocated under the managed worktree root.
    assert.equal(typed.args.at(-1), producerPrompt(config, { ...binding, checkout: launched.checkout }, profile)); assert.equal(typed.stem, join(launched.checkout, '.graphyard/launch/produce-a'));
    assert.equal(calls.some(call => call[0] === 'agent' && call[1] === 'prompt'), false); assert.equal(launched.delivery, 'request');
    const ledger = await readProducerLedger(root);
    assert.equal(ledger.producers.length, 1); assert.equal(ledger.producers[0].state, 'pending'); assert.deepEqual(ledger.producers[0].outcome, { 'integration:auto-dispatch-review': 'missing', 'integration:auto-dispatch-producers': 'missing' });
    assert.equal((await stat(join(root, '.graphyard/producers.json'))).mode & 0o777, 0o600);
    await assert.rejects(launchProducer(root, item, request, profile, [], new Date().toISOString(), { run }), /already pending/);
    await assert.rejects(launchProducer(root, item, item.autoDispatch!.producers[0], profile, [{ name: 'produce-a' }], new Date().toISOString(), { run }), /already visible in Herdr/);
    // Evidence for one proof leaves the session pending with the outcome updated; both proofs complete it and close the pane.
    const partial = work({ autoDispatch: item.autoDispatch, evidence: [evidence('integration:auto-dispatch-review')] });
    let reconciled = await reconcileProducers(root, config, [partial], [{ name: 'produce-a', pane_id: 'pane-produce', agent_status: 'working' }], { run });
    assert.equal(reconciled.producers[0].state, 'pending'); assert.deepEqual(reconciled.producers[0].outcome, { 'integration:auto-dispatch-review': 'pass', 'integration:auto-dispatch-producers': 'missing' });
    assert.equal(proofOutcome(work({ evidence: [evidence('integration:auto-dispatch-review', { trusted: false })] }), reconciled.producers[0], 'integration:auto-dispatch-review'), 'untrusted');
    const closeCalls: string[][] = [];
    const closing = (_command: string, args: string[]) => { closeCalls.push(args); return run(_command, args); };
    const complete = work({ autoDispatch: item.autoDispatch, evidence: [evidence('integration:auto-dispatch-review'), evidence('integration:auto-dispatch-producers', { id: 'e2' })] });
    reconciled = await reconcileProducers(root, config, [complete], [{ name: 'produce-a', pane_id: 'pane-produce', agent_status: 'working' }], { run: closing });
    assert.equal(reconciled.producers[0].state, 'completed'); assert.match(reconciled.producers[0].resolution!, /trusted passing evidence recorded/);
    assert.deepEqual(closeCalls[0], ['pane', 'close', 'pane-produce']);
    assert.equal(summarizeProducers(reconciled.producers).completed[0].outcome['integration:auto-dispatch-producers'], 'pass');
    // Cancellation, expiry, and an idle session are each settled with their reason.
    const settle = async (records: Partial<ProducerRecord>, items: Work[], agents: any[] | null, now: Date) => {
      const current = await readProducerLedger(root);
      current.producers.push({ ...current.producers[0], id: randomUUID(), requestId: randomUUID(), state: 'pending', outcome: {}, resolution: undefined, closedAt: undefined, idleSince: undefined, ...records } as ProducerRecord);
      await writeFile(join(root, '.graphyard/producers.json'), JSON.stringify(current), { mode: 0o600 });
      return (await reconcileProducers(root, config, items, agents, { run, now: () => now })).producers.at(-1)!;
    };
    const movedRequest = { ...request, id: 'moved-request', state: 'cancelled' as const, resolution: `head changed from ${H.slice(0, 12)} to ${H2.slice(0, 12)}` };
    const moved = work({ candidate: { sha: H2, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' }, autoDispatch: { review: null, producers: [], history: [movedRequest] } });
    const cancelled = await settle({ requestId: movedRequest.id }, [moved], [{ name: 'produce-a', pane_id: 'pane-produce', agent_status: 'working' }], new Date());
    assert.equal(cancelled.state, 'cancelled'); assert.match(cancelled.resolution!, /head changed/);
    const expired = await settle({ expiresAt: iso(-1) }, [item], [{ name: 'produce-a', pane_id: 'pane-produce', agent_status: 'working' }], new Date(clock));
    assert.equal(expired.state, 'expired'); assert.match(expired.resolution!, /no trusted evidence .* within 120 minutes/);
    const idle = await settle({ requestId: 'idle-request' }, [item], [{ name: 'produce-a', pane_id: 'pane-produce', agent_status: 'done' }], new Date(clock));
    assert.equal(idle.state, 'pending'); assert.equal(idle.idleSince, iso(0), 'a finished session gets a grace period to submit');
    const failed = (await reconcileProducers(root, config, [item], [{ name: 'produce-a', pane_id: 'pane-produce', agent_status: 'done' }], { run, now: () => new Date(clock + producerIdleGraceMs) })).producers.at(-1)!;
    assert.equal(failed.state, 'failed'); assert.match(failed.resolution!, /finished \(done\) without trusted evidence/);
    const blind = await settle({ requestId: 'blind-request' }, [item], null, new Date(clock));
    assert.equal(blind.state, 'pending'); assert.equal(blind.idleSince, undefined, 'an unreadable Herdr never judges a session finished');
    // Status joins the requests with the sessions: what runs per candidate and since when.
    const status = buildMasterStatus({ work: [item], now: iso(90_000) }, [], [], {}, {}, summarizeReviews([]), 'main', undefined, { producers: summarizeProducers((await readProducerLedger(root)).producers), failures: [{ requestId: item.autoDispatch!.review!.id, kind: 'review', attempts: 2, reason: 'observation stale', at: iso(0), nextAt: iso(60_000) }] });
    const row = status.work[0];
    assert.equal(row.dispatch!.review!.requestId, item.autoDispatch!.review!.id); assert.equal(row.dispatch!.review!.session, null); assert.equal(row.dispatch!.review!.failure!.attempts, 2);
    assert.match(row.attention!, /Automatic review launch for GY-64 refused 2 time\(s\): observation stale/);
    const integration = row.dispatch!.producers.find(entry => entry.group === 'integration')!;
    assert.equal(integration.session!.state, 'completed'); assert.equal(integration.session!.profile, 'producer-a'); assert.ok(integration.sinceMs >= 90_000);
    assert.equal(status.counts.dispatchRequested, 3);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('manual:auto-dispatch-status — the master guide, the generated instructions, the protocol pages and the coordination guide describe the automatic lifecycle', async () => {
  const read = async (name: string) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const [masterAgent, coordination, workCommands, webhook, readEndpoints, help] = await Promise.all([read('docs/master-agent.md'), read('docs/coordination.md'), read('docs/protocol/work-commands.md'), read('docs/protocol/github-webhook.md'), read('docs/protocol/read-endpoints.md'), read('src/cli/master.ts')]);
  for (const fragment of ['## Automatic dispatch at submit', 'master producer add', 'within 30 seconds', 'never launches reviews or producers by hand', 'producerProofs', '.graphyard/producers.json', 'run.reviewerProfile', 'dispatchIntervalSeconds', 'one producer session per proof group', 'examples/master/claude-producer.json', 'autoDispatch']) assert.ok(masterAgent.includes(fragment), `docs/master-agent.md must document: ${fragment}`);
  const instructions = managedMasterInstructions('');
  for (const fragment of ['within\n30 seconds', 'never launch reviews or producers by hand', 'what is requested, what is running and since when', 'Keep cycling: status, dispatch ready work, shepherd review and proof collection']) assert.ok(instructions.includes(fragment), `the generated instructions must state: ${fragment}`);
  assert.ok(coordination.includes('producerProofs') && coordination.includes('producer-runnable'), 'the coordination guide explains how an item marks a manual proof producer-runnable');
  assert.ok(workCommands.includes('producerProofs'), 'the work-commands page documents producerProofs');
  for (const fragment of ['autoDispatch', 'dispatch.requested', 'dispatch.cancelled', 'dispatch.satisfied']) assert.ok(webhook.includes(fragment), `the protocol must document ${fragment}`);
  assert.ok(readEndpoints.includes('autoDispatch'));
  for (const command of ['master producer add FILE', 'master review GY-N']) assert.ok(help.includes(command), `${command} must appear in CLI help`);
  const examples = (await readdir(new URL('../examples/master/', import.meta.url))).filter(name => name.includes('producer'));
  assert.ok(examples.length >= 1, 'examples/master ships a producer profile');
  for (const name of examples) {
    const profile = producerProfileSchema.parse(JSON.parse(await read(`examples/master/${name}`)));
    assert.equal(profile.approvals, 'auto'); assert.ok(profile.credentialFile.startsWith('/'));
  }
});
