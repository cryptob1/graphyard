import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { buildMasterStatus, concurrencyAttention, concurrencyStarvedMs, isProfileSession, liveMasterConfig, loadMasterConfig, masterConfigChanges, masterConfigSchema, profileAtLimit, profileConcurrency, profileSessions, reviewerProfileSchema, roleConcurrency, sessionAgentName, sessionNameLimit, setupMaster, saveProducerProfile, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, saveReviewerProfile, summarizeReviews } from '../src/reviewer.js';
import { independentProducerProfiles, launchProducer, readProducerLedger, reconcileProducers, summarizeProducers } from '../src/producer.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-107: one review and one proof run at a time fleet-wide, because each role had a single fixed
// session name. Each test is named for the proof it produces: integration:concurrent-reviews,
// integration:concurrent-producers, integration:role-concurrency-configured,
// unit:role-capacity-visible, and the docs check behind manual:capacity-sizing-onboarding-review.
// GY-122 adds unit:profile-session-name-round-trip and unit:role-concurrency-deterministic-tags.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const B = sha40('b1');
const at = '2026-09-21T10:00:00.000Z';
const clock = Date.parse(at);
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

function observation(candidate: { sha: string; baseSha: string; pr: number; branch: string }, extra: Partial<Observation> = {}): Observation {
  return { candidate: { ...candidate, author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true, ...extra };
}
/**
 * The first eight characters of a request id: the tag a session derived for it is named with. The
 * control plane mints a request id from the head, base, policy and the clock, so a suite that
 * kept those ids drew a fresh tag on every run, and the one tag in fifty that is all digits
 * (12345678, 00000000) exposed the misread this file guards against only when the draw fell on
 * it (GY-122). The tags are fixed here instead, per item and per request slot (the review, or a
 * proof group): the reviews of the first three items carry the two all-digit tags and a plain hex
 * one, the first item's unit and integration groups carry all-digit tags of their own, and every
 * other slot's tag is a fixed hex digest of its item and slot, so every run exercises the shape
 * that failed and no two requests of one item share a tag.
 */
const fixedTags: Record<string, string[]> = { review: ['12345678', '00000000', 'a1b2c3d4'], unit: ['00000000'], integration: ['87654321'] };
const fixedTag = (n: number, slot: string) => fixedTags[slot]?.[n - 1] ?? createHash('sha256').update(`tag-${slot}-${n}`).digest('hex').slice(0, 8);
/** A fixed 32-hex request id for one of item N's requests: the slot's tag, then a digest of the item and slot. */
const fixedRequestId = (n: number, slot: string) => `${fixedTag(n, slot)}${createHash('sha256').update(['request', n, slot].join('\0')).digest('hex').slice(0, 24)}`;
/** A submitted, observed candidate for item N, with its review and producer requests recorded under fixed ids. */
function requested(n: number, overrides: Partial<Work> = {}, now = new Date()): Work {
  const candidate = { sha: sha40(`a${n}`), baseSha: B, pr: 200 + n, branch: `graphyard/gy-${200 + n}-1`, author: 'implementer' };
  const item = { id: `work-${200 + n}`, key: `GY-${200 + n}`, title: `Item ${n}`, description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Unit', proofs: ['unit:concurrency'] }, { id: 'AC-2', text: 'Integration', proofs: ['integration:concurrency'] }, { id: 'AC-3', text: 'Manual', proofs: ['manual:concurrency'] }],
    policy: { checks: ['test', 'typecheck'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: `/w/gy-${200 + n}`, branch: candidate.branch, epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
  reconcileAutoDispatch(item, [item], now);
  // Since GY-115 the review request follows the head's mechanical proofs, so reconciliation alone no
  // longer raises it beside the producer requests. The dispatcher's slots do not care why a request
  // stands: the review request is the one a proven twin of this head raises.
  const twin = structuredClone(item);
  twin.evidence = ['unit:concurrency', 'integration:concurrency'].map(proof => ({ id: `twin-${proof}`, proof, sha: candidate.sha, baseSha: B, policyRevision: 1, producer: 'independent-runner', trusted: true, result: 'pass' as const, executed: 1, skipped: 0, at }));
  twin.autoDispatch = undefined; reconcileAutoDispatch(twin, [twin], now);
  item.autoDispatch!.review = twin.autoDispatch!.review;
  if (item.autoDispatch?.review) item.autoDispatch.review = { ...item.autoDispatch.review, id: fixedRequestId(n, 'review') };
  if (item.autoDispatch) item.autoDispatch.producers = item.autoDispatch.producers.map(request => ({ ...request, id: fixedRequestId(n, request.group ?? 'producer') }));
  return item;
}

/**
 * A master bound to a reviewer App with a stubbed Herdr: every typed launch becomes a visible
 * agent, every `pane close` removes one, and each tab gets its own pane, so what the launchers
 * count against a profile's limit is exactly what they started.
 */
async function fleet(profiles: { reviewers: unknown[]; producers: { name: string; principal: string; agentName: string; concurrency?: number }[] }) {
  const root = await temporaryDirectory('concurrency'), credentialDirectory = await temporaryDirectory('concurrency-credentials');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wC' }, coordinatorStatus as typeof fetch);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  for (const profile of profiles.reviewers) await saveReviewerProfile(root, profile);
  for (const profile of profiles.producers) {
    const credentialFile = join(credentialDirectory, `${profile.name}.token`); await writeFile(credentialFile, `${profile.principal}-token-`.padEnd(40, 'x'), { mode: 0o600 });
    await saveProducerProfile(root, { ...profile, kind: 'claude', credentialFile }, async () => ({ actor: { id: profile.principal, role: 'producer', proofs: ['unit:*', 'integration:*', 'manual:*'] } }));
  }
  const agents: HerdrAgent[] = [];
  const calls: string[][] = [];
  /** The Herdr inventory each launch saw at the moment it started its session. */
  const seen: Record<string, string[]> = {};
  let panes = 0;
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'tab' && args[1] === 'create') { panes++; return JSON.stringify({ result: { root_pane: { pane_id: `pane-${panes}`, tab_id: `tab-${panes}` } } }); }
    // The typed launch starts its runtime at once; the session is named when Herdr sees it started (GY-121).
    if (args[0] === 'pane' && args[1] === 'run') return '';
    if (args[0] === 'pane' && args[1] === 'read') return '';
    if (args[0] === 'agent' && args[1] === 'get') return JSON.stringify({ result: { agent: { agent: 'claude', agent_status: 'working', pane_id: args[2] } } });
    if (args[0] === 'agent' && args[1] === 'rename') { seen[args[3]] = agents.map(agent => agent.name!); agents.push({ name: args[3], pane_id: args[2], agent_status: 'working' }); return JSON.stringify({ result: {} }); }
    if (args[0] === 'pane' && args[1] === 'close') { const index = agents.findIndex(agent => agent.pane_id === args[2]); if (index >= 0) agents.splice(index, 1); return JSON.stringify({ result: {} }); }
    if (args[0] === 'pane' && args[1] === 'list') return JSON.stringify({ result: { panes: [] } });
    return JSON.stringify({ result: {} });
  };
  const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
  /** The dispatcher wired to the real launchers, the stubbed Herdr, and a live configuration. */
  const effects = (items: () => Work[], config: () => MasterConfig): DispatchEffects => ({
    snapshot: async () => ({ work: items(), now: new Date().toISOString() }),
    agents: () => [...agents],
    credentials: async list => Object.fromEntries(list.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: (work, herdr) => reconcileReviews(root, config(), { run, work, agents: herdr, observe: () => null }),
    reconcileProducers: (work, herdr) => reconcileProducers(root, config(), work, herdr, { run }),
    launchReview: (work, request, profile, herdr, observedAt) => launchReview(root, work, profile.name, herdr, observedAt, { run, mint, requestId: request.id }),
    launchProducer: (work, request, profile, herdr, observedAt) => launchProducer(root, work, request, profile, herdr, observedAt, { run }),
    persist: async () => {},
  });
  const cleanup = async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); };
  return { root, credentialDirectory, agents, calls, seen, run, mint, effects, cleanup };
}
const starts = (calls: string[][]) => calls.filter(call => call[0] === 'agent' && call[1] === 'rename').map(call => call[3]);
const tag = (requestId: string) => requestId.slice(0, 8);

test('integration:concurrent-reviews — a reviewer profile with concurrency 3 runs three reviews at once, each session named for its request, and the second launches while the first runs', async () => {
  const host = await fleet({ reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude', concurrency: 3 }], producers: [] });
  try {
    const config = await loadMasterConfig(host.root);
    assert.equal(config.reviewers[0].concurrency, 3); assert.equal(profileConcurrency(config.reviewers[0]), 3);
    const items = [requested(1), requested(2), requested(3)];
    const requests = items.map(item => item.autoDispatch!.review!);
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => items, () => config), Date.now);
    // Three sessions run concurrently under the limit: one per item, launched in the same tick.
    assert.deepEqual(tick.launched.filter(entry => entry.kind === 'review').map(entry => [entry.work, entry.profile]), [['GY-201', 'claude-reviewer'], ['GY-202', 'claude-reviewer'], ['GY-203', 'claude-reviewer']]);
    assert.deepEqual(tick.waiting.filter(entry => entry.kind === 'review'), []);
    const pending = (await readReviewLedger(host.root)).reviews.filter(record => record.state === 'pending');
    assert.equal(pending.length, 3);
    assert.deepEqual(pending.map(record => record.agentName), requests.map(request => `review-claude-${tag(request.id)}`), 'each session is named for the request it answers');
    assert.equal(new Set(pending.map(record => record.agentName)).size, 3);
    assert.deepEqual(pending.map(record => [record.key, record.sha, record.requestId]), items.map((item, index) => [item.key, item.candidate!.sha, requests[index].id]));
    assert.deepEqual(host.agents.map(agent => agent.name), pending.map(record => record.agentName), 'all three are visible in Herdr at once');
    // The second review launched while the first was running, and the third while both were.
    assert.deepEqual(host.seen[pending[1].agentName], [pending[0].agentName]);
    assert.deepEqual(host.seen[pending[2].agentName], [pending[0].agentName, pending[1].agentName]);
    assert.deepEqual(profileSessions(config.reviewers[0], host.agents, pending), { running: pending.map(record => record.agentName), limit: 3, free: 0 });
    for (const call of host.calls.filter(entry => entry[0] === 'tab')) assert.ok(call.some(argument => /review · review-claude-[0-9a-f]{8}$/.test(argument)), 'the tab label carries the session name');
    // A fourth request waits on the limit, by name, rather than being refused as a failure.
    const fourth = requested(4);
    const full = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [...items, fourth], () => config), Date.now);
    assert.deepEqual(full.launched.filter(entry => entry.kind === 'review'), []); assert.deepEqual(full.refused, []);
    const held = full.waiting.find(entry => entry.kind === 'review')!;
    assert.equal(held.work, 'GY-204'); assert.match(held.reason, /every reviewer profile is busy: claude-reviewer: at its concurrency limit \(3 running, limit 3\)/);
    await assert.rejects(launchReview(host.root, fourth, 'claude-reviewer', host.agents, new Date().toISOString(), { run: host.run, mint: host.mint, requestId: fourth.autoDispatch!.review!.id }), /Reviewer profile claude-reviewer is at its concurrency limit \(3 running, limit 3: review-claude-[0-9a-f]{8}, review-claude-[0-9a-f]{8}, review-claude-[0-9a-f]{8}\)/);
    // A verdict settles one session; its slot goes to the waiting request on the next tick.
    const verdict = { state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 77, submittedAt: new Date().toISOString() };
    await reconcileReviews(host.root, config, { run: host.run, work: items, agents: host.agents, observe: record => record.key === 'GY-201' ? verdict : null });
    assert.equal(host.agents.length, 2);
    const freed = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [...items.slice(1), fourth], () => config), Date.now);
    assert.deepEqual(freed.launched.filter(entry => entry.kind === 'review').map(entry => entry.work), ['GY-204']);
    assert.equal(starts(host.calls).at(-1), `review-claude-${tag(fourth.autoDispatch!.review!.id)}`);
    // A relaunch for the same request takes the attempt into its name, so it never collides with the pane it replaces.
    const settled = (await readReviewLedger(host.root)).reviews;
    assert.equal(sessionAgentName(config.reviewers[0], { id: randomUUID(), requestId: requests[1].id, attempt: 2 }), `review-claude-${tag(requests[1].id)}-2`);
    assert.equal(summarizeReviews(settled).pending.length, 3);
  } finally { await host.cleanup(); }
});

test('integration:concurrent-producers — three proof groups run at once across producer profiles up to their concurrency, each binding its own request, and a producer that held an assignment on an item is refused that item however many slots it has', async () => {
  const host = await fleet({ reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude' }], producers: [{ name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', concurrency: 2 }, { name: 'producer-b', principal: 'proof-runner-b', agentName: 'produce-b' }] });
  try {
    const config = await loadMasterConfig(host.root);
    assert.deepEqual(config.producers.map(profile => profileConcurrency(profile)), [2, 1]);
    // Three groups on one head: unit, integration, and the manual proof the item marks producer-runnable.
    const item = requested(1, { producerProofs: ['manual:concurrency'] });
    const groups = item.autoDispatch!.producers;
    assert.deepEqual(groups.map(request => request.group), ['unit', 'integration', 'manual']);
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [item], () => config), Date.now);
    assert.deepEqual(tick.launched.filter(entry => entry.kind === 'producer').map(entry => [entry.group, entry.profile]), [['unit', 'producer-a'], ['integration', 'producer-a'], ['manual', 'producer-b']]);
    assert.deepEqual(tick.waiting.filter(entry => entry.kind === 'producer'), []);
    const pending = (await readProducerLedger(host.root)).producers.filter(record => record.state === 'pending');
    assert.equal(pending.length, 3);
    // Each binding is independent: its own request, group, proofs and session name, on the exact head.
    assert.deepEqual(pending.map(record => [record.requestId, record.group, record.proofs, record.principal, record.agentName]),
      [[groups[0].id, 'unit', ['unit:concurrency'], 'proof-runner', `produce-a-${tag(groups[0].id)}`], [groups[1].id, 'integration', ['integration:concurrency'], 'proof-runner', `produce-a-${tag(groups[1].id)}`], [groups[2].id, 'manual', ['manual:concurrency'], 'proof-runner-b', 'produce-b']]);
    assert.equal(new Set(pending.map(record => record.requestId)).size, 3); assert.equal(new Set(pending.map(record => record.agentName)).size, 3);
    assert.ok(pending.every(record => record.sha === item.candidate!.sha && record.baseSha === B && record.policyRevision === 1));
    assert.equal(new Set(pending.map(record => record.checkout)).size, 3, 'each session builds in its own checkout');
    const producing = (name: string) => host.seen[name].filter(seen => seen.startsWith('produce-'));
    assert.deepEqual(producing(pending[1].agentName), [pending[0].agentName], 'the second group launched while the first ran');
    assert.deepEqual(producing(pending[2].agentName), [pending[0].agentName, pending[1].agentName]);
    // The producer session receives its own credential path and its own head binding.
    const tabs = host.calls.filter(entry => entry[0] === 'tab' && entry.some(argument => / proofs · produce-/.test(argument)));
    assert.equal(tabs.length, 3);
    for (const call of tabs) assert.ok(call.some(argument => argument === `GRAPHYARD_PRODUCER=${item.key}@${item.candidate!.sha}`), 'every producer tab binds the exact head');
    assert.equal(JSON.stringify(host.calls).includes('-token-'), false, 'no credential value reaches a command line');
    // Independence is per item, not per process: proof-runner held an assignment on GY-202, so
    // producer-a is refused for it while producer-b answers, and producer-a keeps serving GY-203.
    const dependent = requested(2, { implementers: ['proof-runner'] });
    const free = requested(3);
    assert.deepEqual(independentProducerProfiles(dependent, config.producers).map(profile => profile.name), ['producer-b']);
    await assert.rejects(launchProducer(host.root, dependent, dependent.autoDispatch!.producers[0], config.producers[0], host.agents, new Date().toISOString(), { run: host.run }), /Producer principal proof-runner has held an assignment on GY-202; its evidence would not be trusted/);
    // Free the first head's sessions, then dispatch both items together.
    const done = { ...item, evidence: item.autoDispatch!.producers.flatMap(request => (request.proofs ?? []).map(proof => ({ id: `ev-${proof}`, proof, sha: item.candidate!.sha, baseSha: B, policyRevision: 1, producer: 'proof-runner-b', trusted: true, result: 'pass' as const, executed: 2, skipped: 0, at }))) } as Work;
    await reconcileProducers(host.root, config, [done], host.agents, { run: host.run });
    assert.deepEqual(host.agents.map(agent => agent.name), ['review-claude'], 'every producer session closed on its evidence; the reviewer runs on');
    const second = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [dependent, free], () => config), Date.now);
    const launched = second.launched.filter(entry => entry.kind === 'producer').map(entry => [entry.work, entry.group, entry.profile]);
    assert.deepEqual(launched, [['GY-202', 'unit', 'producer-b'], ['GY-203', 'unit', 'producer-a'], ['GY-203', 'integration', 'producer-a']]);
    const waiting = second.waiting.filter(entry => entry.kind === 'producer');
    assert.deepEqual(waiting.map(entry => [entry.work, entry.group]), [['GY-202', 'integration']]);
    assert.match(waiting[0].reason, /every independent producer profile is busy or unavailable \(producer-b: at its concurrency limit \(1 running, limit 1\)\)/);
    assert.equal(waiting[0].reason.includes('producer-a'), false, 'a dependent profile is not offered as capacity for the item');
  } finally { await host.cleanup(); }
});

// The control plane's side of the same independence rule, on a real database: the principal that
// held an assignment on an item is refused that item's evidence and stays trusted on every other.
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const runnerAsWorker: Principal = { id: 'proof-runner', role: 'worker' };
const runner: Principal = { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] };
const runnerB: Principal = { id: 'proof-runner-b', role: 'producer', proofs: ['unit:*', 'integration:*'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_ROLE_CONCURRENCY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 29);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('role-concurrency'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.principals = [operator, runner, runnerB];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('integration:concurrent-producers — the control plane refuses evidence for an item from the principal that held an assignment on it, and trusts the same principal on an item it never touched', async () => {
  const H = sha40('c1');
  const submitted = async (title: string, claimant: Principal, pr: number) => {
    let item = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Unit', proofs: ['unit:concurrency'] }] }, randomUUID());
    item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
    item = await engine.execute(claimant, 'claim', item.id, {}, randomUUID());
    item = await engine.execute(claimant, 'workspace', item.id, { epoch: 1, host: 'machine-a', path: `/tmp/concurrency/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-1` }, randomUUID());
    item = await engine.execute(claimant, 'submit', item.id, { epoch: 1, pr }, randomUUID());
    return engine.observe(item.id, item.revision, { ...observation({ sha: H, baseSha: B, pr, branch: item.workspaces[0].branch }), candidate: { sha: H, baseSha: B, pr, branch: item.workspaces[0].branch, author: claimant.id } });
  };
  const worker: Principal = { id: 'builder', role: 'worker' };
  const touched = await submitted('Implemented by the runner principal', runnerAsWorker, 301);
  const untouched = await submitted('Implemented by a worker', worker, 302);
  assert.ok(touched.implementers?.includes('proof-runner'));
  await assert.rejects(engine.execute(runner, 'evidence', touched.id, { proof: 'unit:concurrency', sha: H, baseSha: B, policyRevision: 1, result: 'pass', executed: 2, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID()), /requires a producer identity distinct from its implementers; proof-runner has held an assignment on it/);
  const other = await engine.execute(runnerB, 'evidence', touched.id, { proof: 'unit:concurrency', sha: H, baseSha: B, policyRevision: 1, result: 'pass', executed: 2, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());
  assert.equal(other.evidence.at(-1)!.trusted, true, 'an independent producer still proves the item');
  const own = await engine.execute(runner, 'evidence', untouched.id, { proof: 'unit:concurrency', sha: H, baseSha: B, policyRevision: 1, result: 'pass', executed: 2, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());
  assert.equal(own.evidence.at(-1)!.trusted, true, 'the same principal is trusted on an item it never implemented');
  assert.ok(own.autoDispatch!.producers.every(request => request.group !== 'unit'), 'trusted evidence satisfies the unit request');
});

test('integration:role-concurrency-configured — concurrency is declared per role in master.json and honoured by the dispatcher: raising it starts more sessions on the next tick without a restart, lowering it drains without stopping a running one', async () => {
  const host = await fleet({ reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude' }], producers: [] });
  try {
    const initial = await loadMasterConfig(host.root);
    assert.equal(initial.reviewers[0].concurrency, undefined); assert.equal(profileConcurrency(initial.reviewers[0]), 1, 'absent means one session at a time');
    // The loop's live configuration: re-read before each tick, adopted without a restart.
    const live = liveMasterConfig(host.root, initial);
    const write = async (concurrency: number) => {
      const current = JSON.parse(await readFile(join(host.root, '.graphyard/master.json'), 'utf8'));
      current.reviewers[0].concurrency = concurrency;
      await writeFile(join(host.root, '.graphyard/master.json'), JSON.stringify(current, null, 2), { mode: 0o600 });
      const reload = await live.reload();
      assert.equal(reload.refused, null, 'a concurrency change is not a bound setting'); assert.deepEqual(reload.changed, ['reviewers']);
      return reload.config;
    };
    const items = [requested(1), requested(2), requested(3)];
    const effects = host.effects(() => items, () => live.current);
    const cursor = emptyDispatchCursor(initial);
    // Concurrency 1: one review runs, two wait on the limit — nothing is refused, nothing fails.
    const one = await runDispatchTick(live.current, cursor, effects, Date.now);
    assert.deepEqual(one.launched.map(entry => entry.work), ['GY-201']);
    assert.deepEqual(one.waiting.filter(entry => entry.kind === 'review').map(entry => [entry.work, entry.reason]), [['GY-202', 'every reviewer profile is busy: claude-reviewer: at its concurrency limit (1 running, limit 1); raise concurrency in .graphyard/master.json or add a reviewer profile'], ['GY-203', 'every reviewer profile is busy: claude-reviewer: at its concurrency limit (1 running, limit 1); raise concurrency in .graphyard/master.json or add a reviewer profile']]);
    assert.deepEqual(starts(host.calls), ['review-claude'], 'a profile that runs one session keeps its fixed name');
    // Raised to 3 mid-run: the next tick launches the two that waited, on the same loop.
    const three = await write(3);
    assert.deepEqual(masterConfigChanges(initial, three), { changed: ['reviewers'], bound: [] });
    const more = await runDispatchTick(live.current, cursor, effects, Date.now);
    assert.deepEqual(more.launched.map(entry => entry.work), ['GY-202', 'GY-203']); assert.deepEqual(more.waiting.filter(entry => entry.kind === 'review'), []);
    assert.equal(host.agents.length, 3);
    assert.deepEqual(starts(host.calls).slice(1), items.slice(1).map(item => `review-claude-${tag(item.autoDispatch!.review!.id)}`), 'sessions beyond the first slot are named for their request');
    // The second and third items carry the all-digit tag 00000000 and the hex tag a1b2c3d4 (fixedTags), so this counts a name that used to be misread on every run.
    assert.ok(isProfileSession(three.reviewers[0], 'review-claude') && starts(host.calls).slice(1).every(name => isProfileSession(three.reviewers[0], name)));
    assert.equal(isProfileSession(three.reviewers[0], 'review-claude-10'), false, 'another profile whose name extends this one is not counted as its session');
    // A profile name near the runtime's 32-character limit still gets a distinct, launchable name per request, recognised as its own.
    const long = { name: 'long', agentName: 'review-claude-on-the-second-acct', concurrency: 2 };
    const derived = sessionAgentName(long, { id: randomUUID(), requestId: items[1].autoDispatch!.review!.id });
    assert.ok(derived.length <= sessionNameLimit && derived.endsWith(`-${tag(items[1].autoDispatch!.review!.id)}`) && derived !== long.agentName, derived);
    assert.ok(isProfileSession(long, derived) && !isProfileSession(three.reviewers[0], derived));
    assert.equal(sessionAgentName(long, { id: randomUUID(), requestId: items[1].autoDispatch!.review!.id, attempt: 3 }).length <= sessionNameLimit, true);
    // Lowered to 1 while three run: nothing is stopped, nothing new launches until the sessions drain.
    await write(1);
    const fourth = requested(4);
    const closesBefore = host.calls.filter(call => call[0] === 'pane' && call[1] === 'close').length;
    const drain = await runDispatchTick(live.current, cursor, host.effects(() => [...items, fourth], () => live.current), Date.now);
    assert.deepEqual(drain.launched, []); assert.deepEqual(drain.refused, []);
    assert.equal(host.calls.filter(call => call[0] === 'pane' && call[1] === 'close').length, closesBefore, 'lowering the limit kills no running session');
    assert.equal(host.agents.length, 3); assert.equal((await readReviewLedger(host.root)).reviews.filter(record => record.state === 'pending').length, 3);
    assert.match(drain.waiting.find(entry => entry.kind === 'review' && entry.work === 'GY-204')!.reason, /at its concurrency limit \(3 running, limit 1\)/);
    assert.deepEqual(profileSessions(live.current.reviewers[0], host.agents, []), { running: host.agents.map(agent => agent.name), limit: 1, free: 0 });
    // Two verdicts drain to one running session: still at the limit of one; a third frees the slot.
    const verdict = (key: string) => ({ state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: Number(key.slice(3)), submittedAt: new Date().toISOString() });
    await reconcileReviews(host.root, live.current, { run: host.run, work: items, agents: host.agents, observe: record => ['GY-201', 'GY-202'].includes(record.key) ? verdict(record.key) : null });
    assert.equal(host.agents.length, 1);
    const still = await runDispatchTick(live.current, cursor, host.effects(() => [items[2], fourth], () => live.current), Date.now);
    assert.deepEqual(still.launched, []); assert.match(still.waiting.find(entry => entry.kind === 'review')!.reason, /\(1 running, limit 1\)/);
    await reconcileReviews(host.root, live.current, { run: host.run, work: items, agents: host.agents, observe: record => record.key === 'GY-203' ? verdict(record.key) : null });
    const drained = await runDispatchTick(live.current, cursor, host.effects(() => [fourth], () => live.current), Date.now);
    assert.deepEqual(drained.launched.map(entry => entry.work), ['GY-204']);
    assert.equal(starts(host.calls).at(-1), 'review-claude', 'back at concurrency 1 the fixed name returns');
    // The schema bounds the declaration and the launch refusal names the limit for the one-session case as before.
    assert.equal(reviewerProfileSchema.safeParse({ name: 'r', agentName: 'review-r', kind: 'claude', concurrency: 0 }).success, false);
    assert.equal(reviewerProfileSchema.safeParse({ name: 'r', agentName: 'review-r', kind: 'claude', concurrency: 21 }).success, false);
    assert.equal(reviewerProfileSchema.safeParse({ name: 'r', agentName: 'review-r', kind: 'claude', concurrency: 2.5 }).success, false);
    assert.match(profileAtLimit('Reviewer', { name: 'r', agentName: 'review-r' }, { running: ['review-r'], limit: 1 }), /Reviewer agent review-r is already visible in Herdr; profile r runs one session at a time/);
  } finally { await host.cleanup(); }
});

test('unit:profile-session-name-round-trip — isProfileSession recognises every name derivedSessionName produces, for hex and all-digit tags with and without an attempt suffix, and rejects the names of other profiles', () => {
  const short = { name: 'claude-reviewer', agentName: 'review-claude', concurrency: 3 };
  const long = { name: 'long', agentName: 'review-claude-on-the-second-acct', concurrency: 2 };
  const other = { name: 'cursor-reviewer', agentName: 'review-cursor', concurrency: 3 };
  const tags = ['a1b2c3d4', '12345678', '00000000'];
  const attempts: (number | undefined)[] = [undefined, 1, 12];
  let checked = 0;
  for (const profile of [short, long]) for (const requestTag of tags) for (const attempt of attempts) {
    const name = sessionAgentName(profile, { id: randomUUID(), requestId: `${requestTag}-${randomUUID()}`, ...(attempt === undefined ? {} : { attempt }) });
    assert.ok(name.length <= sessionNameLimit && name.endsWith(attempt !== undefined && attempt > 1 ? `-${requestTag}-${attempt}` : `-${requestTag}`), name);
    assert.equal(isProfileSession(profile, name), true, `${profile.agentName} owns ${name}`);
    assert.equal(isProfileSession(other, name), false, `${other.agentName} does not own ${name}`);
    assert.equal(isProfileSession(profile === short ? long : short, name), false, `${name} is not the other claude profile's session`);
    checked++;
  }
  assert.equal(checked, 2 * tags.length * attempts.length);
  // The shape that was misread: a digest-shortened name whose all-digit tag follows the eight-hex digest, with no attempt suffix.
  const shortened = sessionAgentName(long, { id: randomUUID(), requestId: '12345678-0000-4000-8000-000000000000' });
  assert.match(shortened, /^review-claude-[0-9a-f]{8}-12345678$/, shortened);
  assert.equal(isProfileSession(long, shortened), true, 'the tag is read from the end of the name, never as an attempt of the digest before it');
  // Anchored: a tag is never read as an attempt, and an attempt is never read as a tag.
  assert.equal(isProfileSession(short, 'review-claude-12345678'), true);
  assert.equal(isProfileSession(short, 'review-claude-12345678-1'), false, 'the first attempt carries no suffix, so this is not a name the launcher produces');
  assert.equal(isProfileSession(short, 'review-claude-10'), false, 'a profile whose name extends this one');
  assert.equal(isProfileSession(short, 'review-claude-a1b2c3d4-0'), false);
  assert.equal(isProfileSession(short, 'review-claude-a1b2c3d4-01'), false);
  assert.equal(isProfileSession(short, `review-claude-a1b2c3d4-${'9'.repeat(18)}`), false, 'an attempt the limit cannot hold is nobody\'s session, not an error');
  assert.equal(isProfileSession(short, undefined), false);
  assert.equal(isProfileSession(short, 'review-claude'), true, 'the fixed name is the profile\'s own');
});

test('unit:role-concurrency-deterministic-tags — this suite\'s request ids are fixed rather than drawn from the clock, and include the all-digit tags that once made integration:role-concurrency-configured fail one run in fifty', () => {
  const items = [requested(1), requested(2), requested(3), requested(4)];
  assert.deepEqual(items.slice(0, 3).map(item => tag(item.autoDispatch!.review!.id)), ['12345678', '00000000', 'a1b2c3d4']);
  assert.ok(items.slice(0, 2).every(item => /^\d{8}$/.test(tag(item.autoDispatch!.review!.id))), 'the first two items carry all-digit tags');
  assert.deepEqual(items.map(item => item.autoDispatch!.review!.id), [requested(1), requested(2), requested(3), requested(4)].map(item => item.autoDispatch!.review!.id), 'the same item gets the same id on every run');
  assert.deepEqual(items.map(item => item.autoDispatch!.review!.id), [requested(1, {}, new Date(0)), requested(2, {}, new Date(0)), requested(3, {}, new Date(0)), requested(4, {}, new Date(0))].map(item => item.autoDispatch!.review!.id), 'the clock has no say in the id');
  const ids = items.flatMap(item => [item.autoDispatch!.review!.id, ...item.autoDispatch!.producers.map(request => request.id)]);
  assert.equal(new Set(ids).size, ids.length, 'every request of every item is its own id');
  assert.ok(ids.every(id => /^[0-9a-f]{32}$/.test(id)), ids.join(', '));
  for (const item of items) {
    const tags = [item.autoDispatch!.review!.id, ...item.autoDispatch!.producers.map(request => request.id)].map(tag);
    assert.equal(new Set(tags).size, tags.length, `${item.key}: no two requests of one item share a tag, so two sessions of one profile never share a name`);
  }
  const groups = requested(1, { producerProofs: ['manual:concurrency'] }).autoDispatch!.producers;
  assert.deepEqual(groups.map(request => [request.group, tag(request.id)]).slice(0, 2), [['unit', '00000000'], ['integration', '87654321']], 'the first item\'s proof groups carry all-digit tags too, so integration:concurrent-producers counts a producer session named with one on every run');
  // The names the configured test derives from these ids, on both the plain and the digest-shortened profile, round-trip on every run.
  const short = { name: 'claude-reviewer', agentName: 'review-claude', concurrency: 3 }, long = { name: 'long', agentName: 'review-claude-on-the-second-acct', concurrency: 2 };
  for (const item of items) for (const profile of [short, long]) {
    const name = sessionAgentName(profile, { id: randomUUID(), requestId: item.autoDispatch!.review!.id });
    assert.ok(name.endsWith(`-${tag(item.autoDispatch!.review!.id)}`) && isProfileSession(profile, name), `${profile.agentName} counts ${name}`);
  }
});

test('unit:role-capacity-visible — master status reports, per role, the sessions running against the limit and how long the longest request has waited for a slot', () => {
  const base = { version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'h', masterAgentName: 'm' };
  const config = masterConfigSchema.parse({ ...base, reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: at },
    reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude', concurrency: 2 }, { name: 'cursor-reviewer', agentName: 'review-cursor', kind: 'cursor' }],
    producers: [{ name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: '/outside/producer-a.token', concurrency: 2 }] });
  const when = new Date(clock);
  // Five items: two with reviews running, three whose reviews wait for a slot for 2, 12 and 30 minutes.
  const running = [requested(1, {}, when), requested(2, {}, when)];
  const waiting = [requested(3, {}, new Date(clock - 2 * 60_000)), requested(4, {}, new Date(clock - 12 * 60_000)), requested(5, {}, new Date(clock - 30 * 60_000))];
  const review = (item: Work, index: number, state = 'pending') => ({ review: `r-${index}`, requestId: item.autoDispatch!.review!.id, attempt: 1, work: item.key, pr: item.candidate!.pr, sha: item.candidate!.sha, policyRevision: 1, profile: index === 0 ? 'claude-reviewer' : 'cursor-reviewer', agentName: index === 0 ? `review-claude-${tag(item.autoDispatch!.review!.id)}` : 'review-cursor', state, verdict: null, requestedAt: iso(-60_000), tokenExpiresAt: iso(3_600_000), closedAt: state === 'pending' ? null : iso(-1000), resolution: null, attention: null, delivery: 'request', activity: 'running', acknowledgedAt: iso(-30_000), repromptedAt: null, neverStarted: false });
  const reviews = { pending: running.map((item, index) => review(item, index)), completed: [] as any[] };
  const agents: HerdrAgent[] = reviews.pending.map(record => ({ name: record.agentName, agent_status: 'working' }));
  const roles = { reviewers: config.reviewers, producers: config.producers };
  const status = buildMasterStatus({ work: [...running, ...waiting], now: at }, [], agents, {}, {}, reviews, 'main', undefined, { producers: { pending: [], completed: [] }, failures: [], retries: [] }, undefined, roles);
  const reviewer = status.concurrency.find(report => report.role === 'reviewer')!;
  assert.deepEqual({ limit: reviewer.limit, running: reviewer.running, free: reviewer.free, waiting: reviewer.waiting, longestWaitMs: reviewer.longestWaitMs, starved: reviewer.starved }, { limit: 3, running: 2, free: 1, waiting: 3, longestWaitMs: 30 * 60_000, starved: false });
  assert.deepEqual(reviewer.profiles, [{ profile: 'claude-reviewer', agentName: 'review-claude', limit: 2, running: 1, sessions: [reviews.pending[0].agentName] }, { profile: 'cursor-reviewer', agentName: 'review-cursor', limit: 1, running: 1, sessions: ['review-cursor'] }]);
  assert.deepEqual(reviewer.longest, { work: 'GY-205', requestId: waiting[2].autoDispatch!.review!.id, group: null, waitedMs: 30 * 60_000 });
  // Saturated: a second session on the Claude profile fills the role, and the wait becomes attention.
  const saturating = { ...reviews, pending: [...reviews.pending, { ...review(waiting[0], 0), review: 'r-2' }] };
  const full = buildMasterStatus({ work: [...running, ...waiting], now: at }, [], [...agents, { name: saturating.pending[2].agentName, agent_status: 'working' }], {}, {}, saturating, 'main', undefined, { producers: { pending: [], completed: [] }, failures: [], retries: [] }, undefined, roles);
  const saturated = full.concurrency.find(report => report.role === 'reviewer')!;
  assert.deepEqual({ limit: saturated.limit, running: saturated.running, waiting: saturated.waiting, longestWaitMs: saturated.longestWaitMs, starved: saturated.starved }, { limit: 3, running: 3, waiting: 2, longestWaitMs: 30 * 60_000, starved: true });
  assert.equal(full.counts.concurrencyStarved, 1);
  const item = full.attentionItems.find(entry => entry.subject === 'reviewer concurrency')!;
  assert.match(item.text, /reviewer capacity is saturated: 3 sessions running against a limit of 3 \(claude-reviewer 2\/2, cursor-reviewer 1\/1\), 2 requests waiting for a slot, the longest \(GY-205\) for 30 minutes/);
  assert.match(item.next!, /Raise concurrency on a reviewer profile in .graphyard\/master.json, or add a reviewer profile/);
  assert.equal(full.counts.attention, status.counts.attention + 1, 'the starved role counts as one attention item');
  assert.deepEqual(concurrencyAttention([{ ...saturated, longestWaitMs: concurrencyStarvedMs - 1 }]), [], 'a young queue at the limit is not yet attention');
  // What is not a wait for a slot: a running session, a refused launch, a retry not yet due, an exhausted retry, and a settled session no attempt follows.
  const held = [requested(6, {}, new Date(clock - 60 * 60_000)), requested(7, {}, new Date(clock - 60 * 60_000)), requested(8, {}, new Date(clock - 60 * 60_000)), requested(9, {}, new Date(clock - 60 * 60_000))];
  const ids = held.map(item => item.autoDispatch!.review!.id);
  const excluded = roleConcurrency('reviewer', config.reviewers, [...running, ...held], agents, { pending: reviews.pending, completed: [review(held[2], 0, 'failed'), review(held[3], 1, 'cancelled')] },
    { failures: [{ requestId: ids[0], kind: 'review', attempts: 2, reason: 'observation stale', at: iso(-1000), nextAt: iso(60_000) }], retries: [{ requestId: ids[1], attempts: 1, started: 1, neverStarted: 0, limit: 4, unstartedLimit: 3, nextAt: iso(240_000), exhausted: false, last: { state: 'failed', resolution: 'x' } }, { requestId: ids[2], attempts: 4, started: 4, neverStarted: 0, limit: 4, unstartedLimit: 3, nextAt: null, exhausted: true, last: { state: 'failed', resolution: 'x' } }] }, clock);
  assert.deepEqual({ running: excluded.running, waiting: excluded.waiting, longestWaitMs: excluded.longestWaitMs }, { running: 2, waiting: 0, longestWaitMs: null });
  // A retry that is due waits from the moment it became due, not from the original request.
  const due = roleConcurrency('reviewer', config.reviewers, [held[1]], [], { pending: [], completed: [review(held[1], 0, 'failed')] }, { failures: [], retries: [{ requestId: ids[1], attempts: 1, started: 1, neverStarted: 0, limit: 4, unstartedLimit: 3, nextAt: iso(-5 * 60_000), exhausted: false, last: { state: 'failed', resolution: 'x' } }] }, clock);
  assert.deepEqual({ waiting: due.waiting, longestWaitMs: due.longestWaitMs }, { waiting: 1, longestWaitMs: 5 * 60_000 });
  // Producers: a request no independent profile could ever take is not a wait for a slot.
  const dependent = requested(10, { implementers: ['proof-runner'] }, new Date(clock - 20 * 60_000));
  const producer = roleConcurrency('producer', config.producers, [dependent, waiting[0]], [], { pending: [], completed: [] }, { failures: [], retries: [] }, clock);
  assert.deepEqual({ limit: producer.limit, running: producer.running, waiting: producer.waiting, longestWaitMs: producer.longestWaitMs, starved: producer.starved }, { limit: 2, running: 0, waiting: 2, longestWaitMs: 2 * 60_000, starved: false });
  assert.deepEqual(producer.longest, { work: 'GY-203', requestId: waiting[0].autoDispatch!.producers[0].id, group: 'unit', waitedMs: 2 * 60_000 });
  // Without the role profiles the report is empty and nothing else changes; a role with no profile has a limit of zero and is never starved.
  assert.deepEqual(buildMasterStatus({ work: running, now: at }, [], agents).concurrency, []);
  assert.equal(roleConcurrency('producer', [], [waiting[0]], [], { pending: [], completed: [] }, { failures: [], retries: [] }, clock).starved, false);
  assert.deepEqual(summarizeProducers([]).pending, []);
});

test('manual:capacity-sizing-onboarding-review — docs/ states how an installation sizes review and proof capacity against its worker count, and the master guide describes per-profile concurrency', async () => {
  const read = async (name: string) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const [onboarding, masterAgent] = await Promise.all([read('docs/onboarding.md'), read('docs/master-agent.md')]);
  for (const fragment of ['### Size review and proof capacity', '"concurrency"', 'worker count', 'concurrency', 'longestWaitMs', 'without a restart', 'proof groups']) assert.ok(onboarding.includes(fragment), `docs/onboarding.md must state: ${fragment}`);
  assert.match(onboarding, /adding workers/i, 'an operator adding workers is told what else to add');
  for (const fragment of ['`concurrency`', 'a name unique to its request', 'lowering it', 'without a restart', 'longestWaitMs', 'counts.concurrencyStarved', 'per role']) assert.ok(masterAgent.includes(fragment), `docs/master-agent.md must document: ${fragment}`);
});
