import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { assertOutsideWorktrees, autonomousSession, buildMasterStatus, dispatchWork, herdrWorkspaceHealth, liveMasterConfig, loadMasterConfig, masterConfigChanges, masterConfigSchema, masterHarness, prepareSessionHarness, removeProducerProfile, replaceProducerProfile, saveProducerProfile, sessionHarnessFile, sessionHarnessPlan, setupMaster, sustainedActivityMs, workerHarnessPlan, workerPrompt, type MasterConfig, type MasterRun, type WorkerProfile } from '../src/master.js';
import { launchAuthorization } from '../src/repository-setup.js';
import { expandTypedCommand, roleOf, startedAtOnce } from './helpers/launch-shell.js';
import { writeHarnessPermissions } from '../src/harness.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, removeReviewerProfile, reviewerBindingHealth, reviewerRegistrationFile, reviewIdleGraceMs, reviewPrompt, saveReviewerProfile, summarizeReviews, type ReviewRecord } from '../src/reviewer.js';
import { launchProducer, producerIdleGraceMs, producerPrompt, readProducerLedger, reconcileProducers, sessionRetries, sessionRetry, sessionRetryBaseMs, sessionRetryLimit, summarizeProducers, unstartedRetryLimit, type ProducerRecord } from '../src/producer.js';
import { emptyDispatchCursor, readDispatchCursor, runAutoDispatch, runDispatchTick, tickReadTimeout, type DispatchEffects } from '../src/auto-dispatch.js';
import { emptyDaemonState, noteConfigReload, readDaemonState, runCycle, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
// @ts-expect-error Dependency-free operator script.
import { assertRosterSafe, awaitServedTokens, generatedProducer, mergeRoster, parseOptions, pendingSecretSyncs, rosterPreview, secretsDue, secretSyncRecord, secretsToSync } from '../scripts/configure-integrations.mjs';
import { readMasterGuide } from './helpers/master-guide.js';

// Each test is named for the proof it produces (GY-69): integration:producer-session-retry,
// integration:master-config-reload, integration:master-profile-management,
// integration:loop-missing-worktree, integration:role-scoped-harness-rules,
// integration:principal-rotation-safety and unit:autonomous-session-prompts.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-09-19T10:00:00.000Z';
const clock = Date.parse(at);
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

function observation(candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { candidate: { ...candidate, pr: 69, branch: 'graphyard/gy-69-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true, ...extra };
}
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 69, branch: 'graphyard/gy-69-1', author: 'implementer' };
  return { id: 'work-69', key: 'GY-69', title: 'Master loop resilience', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Retry', proofs: ['integration:producer-session-retry', 'unit:autonomous-session-prompts'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: '/w/gy-69', branch: 'graphyard/gy-69-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 69 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}
/**
 * Since GY-115 a review request is raised only once the head's mechanical proofs pass, so it no
 * longer stands beside producer requests from reconciliation alone. The retry schedule is the
 * launcher's, whatever raised the request: this fixture holds the review request a proven twin of
 * the head raises beside the producers the unproven head raises, so one tick exercises both.
 */
const requested = (overrides: Partial<Work> = {}) => {
  const item = work(overrides); reconcileAutoDispatch(item, [item], new Date());
  const proven = ['integration:producer-session-retry', 'unit:autonomous-session-prompts'].map((proof, index) => ({ id: `twin-${index}`, proof, sha: H, baseSha: B, policyRevision: 1, producer: 'independent-runner', trusted: true, result: 'pass' as const, executed: 1, skipped: 0, at }));
  const twin = work({ ...overrides, evidence: proven }); reconcileAutoDispatch(twin, [twin], new Date());
  item.autoDispatch!.review = twin.autoDispatch!.review;
  return item;
};

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-resilience-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}
/** A master installed in a throwaway repository, its credentials outside it. */
async function installed(options: { reviewer?: boolean; herdrWorkspace?: string } = {}) {
  const root = await repository(), credentials = await mkdtemp(join(tmpdir(), 'graphyard-resilience-credentials-'));
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: options.herdrWorkspace ?? 'wE' }, coordinatorStatus as typeof fetch);
  if (options.reviewer) await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  const token = async (name: string) => { const file = join(credentials, `${name}.token`); await writeFile(file, `${name}-token-`.padEnd(40, 'x'), { mode: 0o600 }); return file; };
  return { root, credentials, token, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}
const herdr = (calls: string[][], extra: (args: string[]) => unknown = () => undefined) => (_command: string, args: string[]) => {
  calls.push(args);
  const special = extra(args);
  if (special !== undefined) return JSON.stringify({ result: special });
  // The typed launch is accepted and its runtime seen ready at once (GY-121 startedAtOnce).
  return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
};
const producerVerify = (principal: string) => async () => ({ actor: { id: principal, role: 'producer', proofs: ['unit:*', 'integration:*'] } });
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
function masterConfig(credentialFile: string, overrides: Partial<Omit<MasterConfig, 'run'>> & { run?: Partial<MasterRun> } = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    producers: [{ name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: join(credentialFile, '..', 'producer-a.token') }], ...overrides });
}
function stubDispatch(items: () => Work[], log: string[], overrides: Partial<DispatchEffects> = {}): DispatchEffects & { reviews: any[]; producers: any[] } {
  const reviews: any[] = [], producers: any[] = [];
  return { reviews, producers, snapshot: async () => ({ work: items(), now: new Date().toISOString() }), agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews }), reconcileProducers: async () => ({ producers }),
    launchReview: async (item, request, profile) => { log.push(`review:${item.key}:${profile.name}`); reviews.push({ requestId: request.id, state: 'pending', requestedAt: new Date().toISOString() }); },
    launchProducer: async (item, request, profile) => { log.push(`producer:${request.group}:${profile.name}`); producers.push({ requestId: request.id, state: 'pending', requestedAt: new Date().toISOString() }); },
    persist: async () => {}, ...overrides };
}
function daemonEffects(overrides: Partial<DaemonEffects> = {}, log: string[] = []): DaemonEffects {
  return { agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: iso(0) }), closeSession: pane => { log.push(`close:${pane}`); }, dispatch: async item => { log.push(`dispatch:${item.key}`); },
    requestProof: item => { log.push(`proof:${item.key}`); }, merge: async item => { log.push(`merge:${item.key}`); return { result: 'merge requested' }; },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'none', deployed: [], pending: [] }), recordDeployment: async () => ({}), requestSmoke: () => {},
    persist: async () => {}, ...overrides };
}

test('integration:producer-session-retry — a failed or expired producer session is relaunched for the same request on a widening, bounded schedule, and master status shows the attempts and the next retry', async () => {
  // The schedule: one session per request at a time; a failed or expired one waits 1, 4 then 16 minutes; four sessions in all.
  const failedAt = (minutes: number, state = 'failed') => ({ requestId: 'r1', state, requestedAt: iso(minutes * 60_000 - 30_000), closedAt: iso(minutes * 60_000), resolution: 'the session finished (done) without trusted evidence' });
  assert.deepEqual(sessionRetry([], 'r1', clock), { requestId: 'r1', attempts: 0, started: 0, neverStarted: 0, limit: sessionRetryLimit, unstartedLimit: unstartedRetryLimit, last: null, launch: true, settled: false, nextAt: null, exhausted: false });
  assert.equal(sessionRetry([{ requestId: 'r1', state: 'pending', requestedAt: iso(0) }], 'r1', clock + 3_600_000).settled, true, 'a live session is never doubled');
  for (const state of ['completed', 'cancelled']) assert.equal(sessionRetry([{ requestId: 'r1', state, requestedAt: iso(0) }], 'r1', clock).settled, true, `a ${state} session settles the request`);
  const once = [failedAt(0)];
  assert.equal(sessionRetry(once, 'r1', clock + sessionRetryBaseMs - 1).launch, false);
  assert.equal(sessionRetry(once, 'r1', clock + sessionRetryBaseMs).launch, true);
  assert.equal(sessionRetry(once, 'r1', clock).nextAt, iso(sessionRetryBaseMs));
  const twice = [failedAt(0), failedAt(10, 'expired')];
  assert.equal(sessionRetry(twice, 'r1', clock).nextAt, iso(10 * 60_000 + 4 * sessionRetryBaseMs), 'an expired session retries like a failed one, on a wider interval');
  const thrice = [...twice, failedAt(40)];
  assert.equal(sessionRetry(thrice, 'r1', clock).nextAt, iso(40 * 60_000 + 16 * sessionRetryBaseMs));
  const exhausted = sessionRetry([...thrice, failedAt(80)], 'r1', clock + 86_400_000);
  assert.deepEqual([exhausted.attempts, exhausted.launch, exhausted.exhausted], [4, false, true]);

  const { root, credentials, token, cleanup } = await installed();
  try {
    const credential = await token('producer');
    await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: credential }, producerVerify('proof-runner'));
    const config = await loadMasterConfig(root);
    const item = requested();
    const request = item.autoDispatch!.producers.find(entry => entry.group === 'integration')!;
    const calls: string[][] = [];
    const first = await launchProducer(root, item, request, config.producers[0], [], new Date().toISOString(), { run: herdr(calls) });
    assert.equal(first.attempt, 1);
    // The session takes up its request (GY-93: acknowledged after sustained activity), then
    // finishes without submitting; after the grace period it is recorded failed, not left pending.
    const working = [{ name: 'produce-a', pane_id: 'pane-1', agent_status: 'working' }];
    const idle = [{ name: 'produce-a', pane_id: 'pane-1', agent_status: 'done' }];
    const start = Date.parse((await readProducerLedger(root)).producers[0].requestedAt);
    await reconcileProducers(root, config, [item], working, { run: herdr([]), now: () => new Date(start + 1000) });
    const acknowledged = await reconcileProducers(root, config, [item], working, { run: herdr([]), now: () => new Date(start + 1000 + sustainedActivityMs) });
    assert.equal(acknowledged.producers[0].acknowledgedAt, new Date(start + 1000 + sustainedActivityMs).toISOString());
    const finishedAt = start + 2000 + sustainedActivityMs;
    await reconcileProducers(root, config, [item], idle, { run: herdr([]), now: () => new Date(finishedAt) });
    const settled = await reconcileProducers(root, config, [item], idle, { run: herdr([]), now: () => new Date(finishedAt + producerIdleGraceMs) });
    assert.equal(settled.producers[0].state, 'failed');
    assert.match(settled.producers[0].resolution!, /^the session finished \(done\) without trusted evidence/);
    // The same request is launched again: the next attempt, not a refusal.
    await assert.rejects(launchProducer(root, item, request, config.producers[0], idle, new Date().toISOString(), { run: herdr([]) }), /already visible in Herdr/, 'the old pane still holds the agent name');
    const second = await launchProducer(root, item, request, config.producers[0], [], new Date().toISOString(), { run: herdr([]) });
    assert.equal(second.attempt, 2); assert.equal(second.requestId, request.id);
    await assert.rejects(launchProducer(root, item, request, config.producers[0], [], new Date().toISOString(), { run: herdr([]) }), /already pending/);
    const ledger = await readProducerLedger(root);
    assert.deepEqual(ledger.producers.map(record => [record.requestId, record.attempt, record.state]), [[request.id, 1, 'failed'], [request.id, 2, 'pending']]);
    // At the limit the launcher refuses the request itself, whatever the loop asks.
    ledger.producers = [1, 2, 3, 4].map(attempt => ({ ...ledger.producers[0], id: randomUUID(), attempt, state: 'expired' as const }));
    await writeFile(join(root, '.graphyard/producers.json'), JSON.stringify(ledger), { mode: 0o600 });
    await assert.rejects(launchProducer(root, item, request, config.producers[0], [], new Date().toISOString(), { run: herdr([]) }), /no further automatic attempt/);
    void credentials;
  } finally { await cleanup(); }

  // The loop: a failed session waits for its retry time, then is relaunched for the same request; a reviewer session likewise.
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-resilience-loop-'));
  try {
    const coordinator = join(directory, 'coordinator.token'); await writeFile(coordinator, coordinatorToken, { mode: 0o600 });
    const config = masterConfig(coordinator, { reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: join(directory, 'reviewer.json'), boundAt: at }, reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude', agentArgs: [], approvals: 'auto', environment: {} }] });
    const item = requested();
    const log: string[] = [];
    const effects = stubDispatch(() => [item], log);
    const cursor = emptyDispatchCursor(config);
    const t0 = Date.now();
    await runDispatchTick(config, cursor, effects, () => t0);
    assert.deepEqual(log, ['review:GY-69:claude-reviewer', 'producer:unit:producer-a'], 'one producer profile takes the first group; the second waits for it');
    const unit = effects.producers[0];
    Object.assign(unit, { state: 'failed', closedAt: new Date(t0).toISOString(), resolution: 'the session finished (done) without trusted evidence for unit:autonomous-session-prompts (missing)' });
    Object.assign(effects.reviews[0], { state: 'expired', closedAt: new Date(t0).toISOString(), resolution: 'the reviewer token expired without a verdict' });
    const waiting = await runDispatchTick(config, cursor, effects, () => t0 + 1000);
    const unitWait = waiting.waiting.find(entry => entry.requestId === unit.requestId)!;
    assert.match(unitWait.reason, /producer session attempt 1 failed: the session finished \(done\) without trusted evidence .*; attempt 2 of 4 at /);
    assert.match(waiting.waiting.find(entry => entry.kind === 'review')!.reason, /reviewer session attempt 1 expired: .*attempt 2 of 4 at/);
    assert.deepEqual(log.slice(2), ['producer:integration:producer-a'], 'nothing relaunches before its retry time; the freed profile takes the group that waited');
    await runDispatchTick(config, cursor, effects, () => t0 + sessionRetryBaseMs + 1);
    assert.deepEqual(log.slice(3), ['review:GY-69:claude-reviewer', 'producer:unit:producer-a'], 'the same requests are launched again once due');
    assert.deepEqual(effects.producers.filter(record => record.requestId === unit.requestId).map(record => record.state), ['failed', 'pending']);
    // Master status: the attempts and the next retry per request, and the attention line naming them.
    const records = [{ requestId: unit.requestId, state: 'failed', requestedAt: new Date(t0 - 1000).toISOString(), closedAt: new Date(t0).toISOString(), resolution: 'the session finished (done) without trusted evidence' }];
    const producerRecords = records.map(record => ({ ...record, producer: randomUUID(), attempt: 1, profile: 'producer-a', agentName: 'produce-a', outcome: {} }));
    const status = buildMasterStatus({ work: [item], now: new Date(t0 + 1000).toISOString() }, [], [], {}, {}, summarizeReviews([]), 'main', undefined, { producers: { pending: [], completed: producerRecords }, failures: [], retries: sessionRetries(records, t0 + 1000) });
    const row = status.work[0];
    const retried = row.dispatch!.producers.find(entry => entry.requestId === unit.requestId)!;
    assert.deepEqual([retried.retry!.attempts, retried.retry!.limit, retried.retry!.nextAt, retried.retry!.exhausted], [1, sessionRetryLimit, new Date(t0 + sessionRetryBaseMs).toISOString(), false]);
    assert.equal(retried.session!.attempt, 1);
    assert.match(row.attention!, /Producer session for unit proofs of GY-69 failed after attempt 1 of 4: .*; next attempt at /);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('integration:master-config-reload — a running loop adopts master.json changes to profiles, workspace, run settings and autoMerge without a restart, and refuses a change to what it is bound to by name', async () => {
  const { root, token, cleanup } = await installed();
  try {
    const initial = await loadMasterConfig(root);
    const live = liveMasterConfig(root, initial);
    const file = join(root, '.graphyard/master.json');
    const write = async (change: (config: any) => void) => { const config = JSON.parse(await readFile(file, 'utf8')); change(config); await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 }); await chmod(file, 0o600); };
    assert.deepEqual((await live.reload()).changed, [], 'an unchanged file changes nothing');
    const credential = await token('producer-b');
    await write(config => { config.producers = [{ name: 'producer-b', principal: 'proof-runner-b', agentName: 'produce-b', kind: 'claude', credentialFile: credential }]; config.herdrWorkspace = 'wF'; config.autoMerge = false; config.run.dispatchIntervalSeconds = 20; config.run.reviewerProfile = 'claude-reviewer'; });
    const adopted = await live.reload();
    assert.equal(adopted.refused, null);
    assert.deepEqual(adopted.changed, ['autoMerge', 'herdrWorkspace', 'producers', 'run.dispatchIntervalSeconds', 'run.reviewerProfile']);
    assert.deepEqual([live.current.producers.map(profile => profile.name), live.current.herdrWorkspace, live.current.autoMerge, live.current.run.dispatchIntervalSeconds], [['producer-b'], 'wF', false, 20]);
    // A change to what the loop is bound to is refused by name; every other change in the same write waits with it.
    await write(config => { config.url = 'https://elsewhere.example'; config.baseBranch = 'release'; config.autoMerge = true; });
    const refused = await live.reload();
    assert.match(refused.refused!, /master\.json changes baseBranch, url, which a running master loop is bound to; restart master run to adopt them/);
    assert.equal(live.current.autoMerge, false); assert.equal(live.current.url, 'https://graphyard.example');
    await writeFile(file, '{ not json', { mode: 0o600 });
    assert.match((await live.reload()).refused!, /could not be reloaded .*keeps the settings it last loaded/);
    assert.deepEqual(masterConfigChanges(initial, { ...initial, run: { ...initial.run, intervalSeconds: 30 } }), { changed: ['run.intervalSeconds'], bound: [] });
  } finally { await cleanup(); }

  // The coordination loop adopts autoMerge between cycles and records a refusal once, as an escalation naming the setting.
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-resilience-daemon-'));
  try {
    const coordinator = join(directory, 'coordinator.token'); await writeFile(coordinator, coordinatorToken, { mode: 0o600 });
    const manual = masterConfig(coordinator, { autoMerge: false }), automatic = masterConfig(coordinator, { autoMerge: true });
    const mergeable = work({ stage: 'merge', gates: [{ name: 'merge', passed: true, reasons: [] }] });
    const log: string[] = [];
    let cycles = 0;
    const reloads = [
      { config: manual, changed: [], refused: null, at: iso(0) },
      { config: automatic, changed: ['autoMerge'], refused: null, at: iso(1000) },
      { config: automatic, changed: [], refused: '.graphyard/master.json changes url, which a running master loop is bound to; restart master run to adopt it', at: iso(2000) },
      { config: automatic, changed: [], refused: '.graphyard/master.json changes url, which a running master loop is bound to; restart master run to adopt it', at: iso(3000) },
    ];
    const state = emptyDaemonState(manual);
    const effects = daemonEffects({ snapshot: async () => { if (++cycles >= 4) process.emit('SIGUSR2' as NodeJS.Signals); return { work: [mergeable], now: iso(0) }; } }, log);
    const result = await runDaemon(manual, state, effects, { intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], log: () => {}, reload: async () => reloads[Math.min(cycles, reloads.length - 1)] });
    assert.equal(result.cycles.length, 4);
    const actions = Object.values(state.actions);
    assert.ok(actions.some(action => action.kind === 'escalation' && /Automatic merging is disabled/.test(action.detail)), 'the first cycle ran with autoMerge off');
    assert.ok(log.includes('merge:GY-69'), 'a later cycle merged under the reloaded autoMerge, without a restart');
    assert.ok(actions.some(action => action.kind === 'config' && /Adopted .*autoMerge/.test(action.detail)));
    assert.equal(actions.filter(action => action.kind === 'escalation' && /bound to; restart master run/.test(action.detail)).length, 1, 'a standing refusal is recorded once');
    assert.equal(state.config!.refused, reloads[3].refused);
    const noted = await noteConfigReload(emptyDaemonState(manual), reloads[2], async () => {});
    assert.equal(noted[0].state, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }

  // The dispatcher picks up a producer profile added to master.json: the request that waited for one launches.
  const dispatchDirectory = await mkdtemp(join(tmpdir(), 'graphyard-resilience-dispatch-'));
  try {
    const coordinator = join(dispatchDirectory, 'coordinator.token'); await writeFile(coordinator, coordinatorToken, { mode: 0o600 });
    const bare = masterConfig(coordinator, { producers: [] }), equipped = masterConfig(coordinator);
    const item = requested();
    const log: string[] = [];
    let tick = 0;
    const stopping = new AbortController();
    const effects = stubDispatch(() => [item], log, { persist: async () => { if (log.length) stopping.abort(); } });
    const result = await runAutoDispatch(bare, emptyDispatchCursor(bare), effects, { intervalMs: () => 5, signal: stopping.signal, log: () => {}, reload: async () => ({ config: tick++ < 1 ? bare : equipped, changed: tick > 1 ? ['producers'] : [], refused: null, at: iso(0) }) });
    assert.match(result.ticks[0].waiting.find(entry => entry.kind === 'producer')!.reason, /no producer profile is configured/);
    assert.ok(log.includes('producer:unit:producer-a'), 'the reloaded profile launched without a restart');
  } finally { await rm(dispatchDirectory, { recursive: true, force: true }); }
});

test('integration:loop-read-bound-widens — a snapshot read slower than the dispatcher bound is not retried at that bound forever: each failure doubles it, capped at the interval', async () => {
  const config = masterConfig('/nonexistent/coordinator.token');
  const stopping = new AbortController(), log: string[] = [];
  let reads = 0;
  // A server that always needs 60ms, against a 20ms bound: a fixed bound would never read it.
  const effects = stubDispatch(() => [], [], {
    snapshot: async () => { reads++; await new Promise(resolve => setTimeout(resolve, 60)); return { work: [], now: new Date().toISOString() }; },
    persist: async state => { if (state.lastSuccessAt) stopping.abort(); },
  });
  const guard = setTimeout(() => stopping.abort(), 10_000);
  try {
    const run = await runAutoDispatch(config, emptyDispatchCursor(config), effects, { intervalMs: 60_000, signal: stopping.signal, log: line => log.push(line), readTimeoutMs: 20, retryMinMs: 1 });
    assert.equal(run.ticks.length, 1, `recovered after ${reads} reads: ${log.join(' | ')}`);
    assert.deepEqual(log.map(line => line.match(/timed out after (\d+)ms/)?.[1]), ['20', '40']);
  } finally { clearTimeout(guard); }
  assert.deepEqual([0, 1, 2, 3, 10].map(failures => tickReadTimeout(failures, 30_000)), [8_000, 16_000, 30_000, 30_000, 30_000]);
  assert.equal(tickReadTimeout(4, 1_000), 8_000, 'a short interval never shrinks the base bound');
});

test('integration:master-profile-management — producer profiles can be replaced and removed, reviewer profiles removed, and status flags an unbound reviewer App and a Herdr workspace that no longer exists', async () => {
  const { root, credentials, token, cleanup } = await installed({ herdrWorkspace: 'w1V' });
  try {
    const a = await token('producer-a'), b = await token('producer-b'), c = await token('producer-c');
    await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: a }, producerVerify('proof-runner'));
    await saveProducerProfile(root, { name: 'producer-b', principal: 'proof-runner-b', agentName: 'produce-b', kind: 'claude', credentialFile: b }, producerVerify('proof-runner-b'));
    // Replace keeps the name and re-verifies the credential against the new principal.
    await assert.rejects(replaceProducerProfile(root, { name: 'producer-a', principal: 'proof-runner-c', agentName: 'produce-c', kind: 'codex', credentialFile: c }, producerVerify('someone-else')), /does not match the profile principal/);
    await assert.rejects(replaceProducerProfile(root, { name: 'producer-a', principal: 'proof-runner-b', agentName: 'produce-c', kind: 'codex', credentialFile: c }, producerVerify('proof-runner-b')), /must be unique/);
    await assert.rejects(replaceProducerProfile(root, { name: 'missing', principal: 'proof-runner-c', agentName: 'produce-c', kind: 'codex', credentialFile: c }, producerVerify('proof-runner-c')), /Unknown producer profile missing; add it with master producer add/);
    const replaced = await replaceProducerProfile(root, { name: 'producer-a', principal: 'proof-runner-c', agentName: 'produce-c', kind: 'codex', credentialFile: c }, producerVerify('proof-runner-c'));
    assert.deepEqual([replaced.replaced, replaced.principal, replaced.agentName], ['producer-a', { from: 'proof-runner', to: 'proof-runner-c' }, { from: 'produce-a', to: 'produce-c' }]);
    assert.deepEqual((await loadMasterConfig(root)).producers.map(profile => [profile.name, profile.principal, profile.kind]), [['producer-a', 'proof-runner-c', 'codex'], ['producer-b', 'proof-runner-b', 'claude']]);
    const removed = await removeProducerProfile(root, 'producer-b');
    assert.deepEqual([removed.removed, removed.producers], ['producer-b', 1]);
    await assert.rejects(removeProducerProfile(root, 'producer-b'), /Unknown producer profile producer-b/);
    assert.match((await removeProducerProfile(root, 'producer-a')).next, /No producer profile remains/);

    // Reviewer profiles: removing the automatic one clears the setting that named it.
    await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
    await saveReviewerProfile(root, { name: 'cursor-reviewer', agentName: 'review-cursor-1', kind: 'cursor' });
    const file = join(root, '.graphyard/master.json'); const config = JSON.parse(await readFile(file, 'utf8')); config.run.reviewerProfile = 'claude-reviewer'; await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const reviewer = await removeReviewerProfile(root, 'claude-reviewer');
    assert.deepEqual([reviewer.removed, reviewer.clearedAutomatic, reviewer.automatic], ['claude-reviewer', true, 'cursor-reviewer']);
    assert.equal((await loadMasterConfig(root)).run.reviewerProfile, undefined);
    await assert.rejects(removeReviewerProfile(root, 'claude-reviewer'), /Unknown reviewer profile/);

    // A reviewer App registered by master reviewer setup but never bound is flagged; binding it clears the flag.
    let master = await loadMasterConfig(root);
    assert.deepEqual((await reviewerBindingHealth(master)).attention, []);
    await mkdir(join(credentials, 'reviewers'), { recursive: true });
    const registration = reviewerRegistrationFile(master);
    assert.equal(registration, join(credentials, 'reviewers', 'owner-project-registration.json'));
    await writeFile(registration, JSON.stringify({ appId: 5678, slug: 'graphyard-reviewer', installationId: 91011, privateKey, repository: 'owner/project', reviewer: 'reviewer' }), { mode: 0o600 });
    const unbound = await reviewerBindingHealth(master);
    assert.equal(unbound.attention.length, 1);
    assert.match(unbound.attention[0], /Reviewer App graphyard-reviewer \(App 5678\) is registered for owner\/project but not bound\. Its installation is recorded: rerun master reviewer setup to bind it/);
    assert.equal(unbound.attention[0].includes('PRIVATE KEY'), false, 'only the public facts of the registration are read');
    await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
    master = await loadMasterConfig(root);
    assert.deepEqual((await reviewerBindingHealth(master)).attention, []);
    await rm(master.reviewer!.credentialFile);
    assert.match((await reviewerBindingHealth(master)).attention[0], /bound reviewer App graphyard-reviewer has no usable credential .*rerun master reviewer bind/);

    // The configured Herdr workspace is checked against Herdr's own inventory.
    const workspaces = (ids: string[]) => (_command: string, args: string[]) => { assert.deepEqual(args, ['workspace', 'list']); return JSON.stringify({ result: { workspaces: ids.map(id => ({ workspace_id: id })) } }); };
    assert.deepEqual(await herdrWorkspaceHealth(master, workspaces(['w1V', 'w3'])), { workspace: 'w1V', exists: true, reason: null });
    const gone = await herdrWorkspaceHealth(master, workspaces(['w3', 'w5']));
    assert.equal(gone.exists, false); assert.match(gone.reason!, /Herdr workspace w1V configured in \.graphyard\/master\.json no longer exists \(Herdr lists w3, w5\)/);
    assert.equal((await herdrWorkspaceHealth(master, () => { throw new Error('no socket'); })).exists, null, 'an unreadable Herdr leaves the workspace unverified, not missing');
    assert.equal((await herdrWorkspaceHealth({ herdrWorkspace: undefined })).exists, null);
    // The commands are part of the CLI and the guide.
    const help = await readFile(new URL('../src/cli/master.ts', import.meta.url), 'utf8');
    for (const command of ['master producer add FILE | replace FILE | remove NAME', 'master reviewer add FILE | remove NAME']) assert.ok(help.includes(command), `${command} is in CLI help`);
    const guide = await readMasterGuide();
    for (const fragment of ['master producer replace', 'master producer remove', 'master reviewer remove', 'setup.attention']) assert.ok(guide.includes(fragment), `docs/master-agent.md documents ${fragment}`);
  } finally { await cleanup(); }
});

test('integration:loop-missing-worktree — the loop survives a registered worktree whose path is missing or hidden, and the example unit does not hide proof worktrees', async () => {
  const { root, credentials, cleanup } = await installed();
  const outside = await mkdtemp(join(tmpdir(), 'graphyard-resilience-proof-'));
  try {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
    const missing = join(outside, 'graphyard-proof-gy-69-missing'), hiddenParent = join(outside, 'private'), hidden = join(hiddenParent, 'graphyard-proof-gy-69-hidden');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', missing], { cwd: root });
    await mkdir(hiddenParent);
    execFileSync('git', ['worktree', 'add', '-q', '--detach', hidden], { cwd: root });
    await rm(missing, { recursive: true, force: true });
    await chmod(hiddenParent, 0o000);
    try {
      assert.match(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' }), /graphyard-proof-gy-69-missing/, 'git still registers the removed worktree');
      // Everything the loop reads at start and on every cycle resolves the worktree inventory.
      const config = await loadMasterConfig(root);
      assert.equal((await readDaemonState(root, config)).cycle, 0);
      assert.equal((await readDispatchCursor(root, config)).ticks, 0);
      await assertOutsideWorktrees(root, credentials, 'Credential directory');
      // A target inside an existing worktree is still refused.
      await assert.rejects(assertOutsideWorktrees(root, join(root, '.graphyard'), 'Credential directory'), /must be outside every worktree/);
    } finally { await chmod(hiddenParent, 0o700); }
  } finally { await cleanup(); await rm(outside, { recursive: true, force: true }); }
  const unit = await readFile(new URL('../examples/master/graphyard-master.service', import.meta.url), 'utf8');
  assert.doesNotMatch(unit, /^PrivateTmp=yes/m, 'a private /tmp would hide every proof worktree from the loop');
  assert.match(unit, /^PrivateTmp=no$/m);
});

test('integration:role-scoped-harness-rules — worker, reviewer and producer sessions launch with their own role rules and never load the master\'s: a worker may push its branch, the master may not', async () => {
  // The plans: the master denies every push; a worker may push exactly its assigned branch.
  const input = { cliPath: launcher, repository: 'owner/project', baseBranch: 'main', credentialHome: '/home/x/.config/graphyard', credentialDirectories: ['/home/x/.config/graphyard/masters'] };
  const worker = sessionHarnessPlan({ ...input, role: 'worker', kind: 'claude', branch: 'graphyard/gy-69-4' });
  const reviewer = sessionHarnessPlan({ ...input, role: 'reviewer', kind: 'claude', pr: 69 });
  const producer = sessionHarnessPlan({ ...input, role: 'producer', kind: 'claude' });
  const rules = (plan: { allow: { rule: string }[]; deny: { rule: string }[] }, list: 'allow' | 'deny') => plan[list].map(entry => entry.rule);
  // Claude Code's Bash rule forms used here: `Bash(prefix:*)`, a `*` glob, or an exact command.
  const matches = (rule: string, command: string) => {
    const body = rule.match(/^Bash\((.*)\)$/)?.[1]; if (!body) return false;
    if (body.endsWith(':*')) return command === body.slice(0, -2) || command.startsWith(`${body.slice(0, -2)} `);
    return new RegExp(`^${body.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(command);
  };
  const denied = (deny: string[], command: string) => deny.some(rule => matches(rule, command));
  assert.ok(rules(worker, 'allow').includes('Bash(git push origin graphyard/gy-69-4)'));
  assert.equal(denied(rules(worker, 'deny'), 'git push origin graphyard/gy-69-4'), false, 'nothing in the worker rules blocks its own push');
  assert.equal(denied(rules(worker, 'deny'), 'git push origin main'), true);
  assert.equal(denied(rules(worker, 'deny'), 'git push --force origin graphyard/gy-69-4'), true);
  assert.equal(denied(rules(reviewer, 'deny'), 'git push origin graphyard/gy-69-4'), true);
  assert.equal(denied(rules(producer, 'deny'), 'git push origin graphyard/gy-69-4'), true);
  assert.ok(rules(reviewer, 'allow').includes('Bash(gh api --method POST repos/owner/project/pulls/69/reviews*)'));
  // The merge deny names merge endpoints, so a verdict body that mentions merging is not refused.
  assert.equal(denied(rules(reviewer, 'deny'), 'gh api --method POST repos/owner/project/pulls/69/reviews -f event=APPROVE -f body=safe to merge'), false);
  for (const command of ['gh api --method PUT repos/owner/project/pulls/69/merge', 'gh api --method POST repos/owner/project/merges -f base=main', 'gh api graphql -f query=mutation{mergePullRequest}']) {
    for (const plan of [worker, reviewer, producer]) assert.equal(denied(rules(plan, 'deny'), command), true, `${command} stays denied`);
  }
  assert.equal(sessionHarnessPlan({ ...input, role: 'worker', kind: 'codex', branch: 'b' }).allow.length, 0, 'runtimes that do not read Claude settings get no generated rules');
  assert.throws(() => sessionHarnessPlan({ ...input, role: 'worker', kind: 'claude' }), /names the assigned branch/);

  const { root, credentials, token, cleanup } = await installed({ reviewer: true });
  try {
    const config = await loadMasterConfig(root);
    const master = masterHarness(root, config, 'claude');
    const masterDeny = rules(master, 'deny');
    assert.equal(denied(masterDeny, 'git push origin graphyard/gy-69-4'), true, 'the master cannot push');
    assert.equal(denied(masterDeny, `gh api --method POST repos/owner/project/pulls/69/reviews -f commit_id=${H} -f event=APPROVE`), true, 'the master cannot post a verdict');
    // Without repository Claude settings there is nothing to inherit, and the profile arguments are unchanged.
    assert.deepEqual((await prepareSessionHarness(root, config, { role: 'producer', kind: 'claude', profile: 'p' })).args, []);
    // Install the master's rules where Claude Code loads them for every session under the repository.
    await writeHarnessPermissions(root, master, true);

    // Worker: launched under watch with only user settings plus its own file.
    const credential = await token('worker');
    const profile: WorkerProfile = { name: 'claude-worker', principal: 'graphyard-claude-1', agentName: 'engineering-claude-1', mode: 'launch', kind: 'claude', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
    const calls: string[][] = [];
    await dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, observation: null, gates: [{ name: 'ready', passed: true, reasons: [] }] }), profile, [], herdr(calls), undefined,
      async () => ({ epoch: 4, path: join(root, 'assigned'), base: 'c'.repeat(40), branch: 'graphyard/gy-69-4' }), async () => {}, 5_000);
    const workerFile = sessionHarnessFile(root, 'worker', 'claude-worker');
    const run = calls.find(call => call[0] === 'pane' && call[1] === 'run')!;
    // GY-93: the role file is followed by the launch authorization it leaves out, then the request;
    // GY-121: both are read from the files in the worktree that the short typed line references.
    assert.match(run[3], new RegExp(` -- claude --permission-mode bypassPermissions --setting-sources user --settings ${workerFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --append-system-prompt-file "\\$GY\\.role" "\\$\\(cat "\\$GY\\.request"\\)"$`));
    const typedWorker = expandTypedCommand(run[3]);
    assert.equal(roleOf(typedWorker.args), launchAuthorization.replace(/\s+/g, ' ')); assert.match(typedWorker.args.at(-1)!, /^Implement GY-69: /);
    const workerSettings = JSON.parse(await readFile(workerFile, 'utf8'));
    assert.ok(workerSettings.permissions.allow.includes('Bash(git push origin graphyard/gy-69-4)'));
    assert.equal(denied(workerSettings.permissions.deny, 'git push origin graphyard/gy-69-4'), false, 'the only deny rules the worker loads cannot block its push');
    const blocking = masterDeny.filter(rule => matches(rule, 'git push origin graphyard/gy-69-4'));
    assert.deepEqual(blocking, ['Bash(git push:*)']);
    for (const rule of blocking) assert.equal(workerSettings.permissions.deny.includes(rule), false, `the master's ${rule} never reaches the worker`);
    assert.ok(workerSettings.permissions.deny.some((rule: string) => rule.startsWith('Read(') && rule.includes(credentials)), 'credentials stay unreadable');
    assert.deepEqual(workerSettings.permissions.allow, workerHarnessPlan({ cliPath: launcher, branch: 'graphyard/gy-69-4', baseBranch: 'main', credentialHome: credentials }).allow.map(entry => entry.rule), 'the worker role file carries the worker rules the worktree gets');

    // Reviewer: its own file allows exactly the verdict the master's rules deny.
    await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
    const reviewCalls: string[][] = [];
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdr(reviewCalls), mint });
    const reviewerFile = sessionHarnessFile(root, 'reviewer', 'claude-reviewer');
    const typedReview = expandTypedCommand(reviewCalls[1][3]);
    assert.deepEqual(reviewCalls[1].slice(0, 2), ['pane', 'run']); assert.equal(typedReview.kind, 'claude');
    assert.deepEqual(typedReview.args.slice(-9, -3), ['--permission-mode', 'bypassPermissions', '--setting-sources', 'user', '--settings', reviewerFile]);
    assert.equal(typedReview.args.at(-3), '--append-system-prompt-file'); assert.equal(roleOf(typedReview.args), launchAuthorization.replace(/\s+/g, ' '));
    assert.match(typedReview.args.at(-1)!, /^You are the independent Graphyard reviewer/, 'the request is the positional prompt (GY-93)');
    const reviewerSettings = JSON.parse(await readFile(reviewerFile, 'utf8'));
    assert.ok(reviewerSettings.permissions.allow.includes('Bash(gh api --method POST repos/owner/project/pulls/69/reviews*)'));
    assert.equal(denied(reviewerSettings.permissions.deny, `gh api --method POST repos/owner/project/pulls/69/reviews -f commit_id=${H} -f event=APPROVE`), false, 'the master deny on review calls cannot block the reviewer');
    assert.equal(denied(reviewerSettings.permissions.deny, 'git push origin main'), true);

    // Producer: likewise, with its own evidence command.
    const producerCredential = await token('producer');
    await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: producerCredential }, producerVerify('proof-runner'));
    const item = requested();
    const produceCalls: string[][] = [];
    await launchProducer(root, item, item.autoDispatch!.producers[0], (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(produceCalls) });
    const producerFile = sessionHarnessFile(root, 'producer', 'producer-a');
    const typedProduce = expandTypedCommand(produceCalls[1][3]);
    assert.deepEqual(typedProduce.args.slice(-7, -3), ['--setting-sources', 'user', '--settings', producerFile]);
    assert.match(typedProduce.args.at(-1)!, /^You are an independent Graphyard proof producer/, 'the request is the positional prompt (GY-93)');
    const producerSettings = JSON.parse(await readFile(producerFile, 'utf8'));
    assert.ok(producerSettings.permissions.allow.includes(`Bash(node ${launcher} evidence:*)`));
    assert.ok(producerSettings.permissions.deny.includes('Bash(git push:*)'));
    // Each file lives under the ignored .graphyard directory, never in a worktree it is launched for.
    for (const file of [workerFile, reviewerFile, producerFile]) assert.ok(file.startsWith(join(root, '.graphyard/harness/')));
    // A runtime that does not read Claude settings is launched with its profile arguments unchanged.
    await saveReviewerProfile(root, { name: 'cursor-reviewer', agentName: 'review-cursor-1', kind: 'cursor' });
    const ledger = await readReviewLedger(root); ledger.reviews = []; await writeFile(join(root, '.graphyard/reviews.json'), JSON.stringify(ledger), { mode: 0o600 });
    const cursorCalls: string[][] = [];
    await launchReview(root, work(), 'cursor-reviewer', [], new Date().toISOString(), { run: herdr(cursorCalls), mint });
    const typedCursor = expandTypedCommand(cursorCalls[1][3]);
    assert.deepEqual([typedCursor.kind, ...typedCursor.args.slice(0, -1)], ['cursor', '--force', '--trust']); assert.match(typedCursor.args.at(-1)!, /^You are the independent Graphyard reviewer/, 'plus the request (GY-93)');
  } finally { await cleanup(); }
});

test('integration:principal-rotation-safety — rotation merges into the live roster, previews without secrets, refuses dropping the coordinator, an admin or a live principal, and keeps GitHub secrets in step with the deployment', async () => {
  const secret = (label: string) => `${label}-`.padEnd(64, '0');
  const live = [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: secret('admin') },
    { id: 'master', role: 'coordinator', token: secret('coordinator') },
    { id: 'graphyard-claude-1', role: 'worker', token: secret('worker1') },
    { id: 'graphyard-codex-1', role: 'worker', token: secret('worker2') },
    { id: 'trusted-acceptance', role: 'producer', proofs: ['integration:claim-safety'], token: secret('acceptance') },
    { id: 'ci-proofs', role: 'producer', runtime: 'github-actions', proofs: ['unit:*', 'integration:*'], token: secret('ci') },
  ];
  // The incident: a partial local file. Merging keeps every live principal the file does not mention.
  const local = [{ id: 'operator', role: 'admin', sessionKind: 'human', token: secret('admin') }, { id: 'graphyard-claude-1', role: 'worker', token: secret('worker1-new') }, { id: 'graphyard-cursor-1', role: 'worker', token: secret('worker3') }];
  const merged = mergeRoster(live, local);
  assert.deepEqual(merged.map((entry: any) => entry.id), ['operator', 'master', 'graphyard-claude-1', 'graphyard-codex-1', 'trusted-acceptance', 'ci-proofs', 'graphyard-cursor-1']);
  assert.equal(merged.find((entry: any) => entry.id === 'graphyard-claude-1')!.token, secret('worker1-new'), 'a local entry updates its live principal');
  assert.doesNotThrow(() => assertRosterSafe(live, merged));
  // What the old script deployed — the local file alone — is refused, naming every principal it drops.
  assert.throws(() => assertRosterSafe(live, local), (error: Error) => /master \(coordinator\) is live and would be dropped; name it with --remove master/.test(error.message) && /graphyard-codex-1 \(worker\) is live and would be dropped/.test(error.message) && !error.message.includes(secret('coordinator')));
  assert.throws(() => assertRosterSafe(live, mergeRoster(live, [], ['operator'])), /operator \(admin\) is live and would be dropped/, 'an admin leaves only when named');
  assert.doesNotThrow(() => assertRosterSafe(live, mergeRoster(live, [], ['graphyard-codex-1']), { remove: ['graphyard-codex-1'] }), 'a live principal named with --remove may leave');
  assert.doesNotThrow(() => assertRosterSafe(live, mergeRoster(live, [], ['master']), { remove: ['master'] }), 'even the coordinator, when named explicitly');
  assert.throws(() => assertRosterSafe(live, mergeRoster(live, [{ id: 'master', role: 'worker', token: secret('coordinator') }])), /master would change role from coordinator to worker/);
  assert.throws(() => assertRosterSafe(live, merged, { remove: ['nobody'] }), /nobody is not in the live roster/);
  assert.deepEqual(parseOptions(['--apply', '--rotate', 'ci-proofs', '--remove=graphyard-codex-1', '--deploy']), { apply: true, deploy: true, rotate: ['ci-proofs'], remove: ['graphyard-codex-1'] });

  // Generated producers keep their live token unless named for rotation.
  const kept = generatedProducer(live, 'trusted-acceptance', { role: 'producer', proofs: ['integration:claim-safety'] }, [], () => secret('fresh'));
  assert.equal(kept.token, secret('acceptance'));
  const rotated = generatedProducer(live, 'trusted-acceptance', { role: 'producer', proofs: ['integration:claim-safety'] }, ['trusted-acceptance'], () => secret('fresh'));
  assert.equal(rotated.token, secret('fresh'));
  assert.equal(generatedProducer([], 'trusted-acceptance', { role: 'producer', proofs: [] }, [], () => secret('first')).token, secret('first'), 'a producer with no live token gets one');
  const next = mergeRoster(live, [...local, rotated]);
  // The preview names ids, roles and token changes; no token value appears in it.
  const preview = rosterPreview(live, next);
  assert.deepEqual(preview.map((row: any) => [row.id, row.change, row.token]), [['operator', 'kept', 'unchanged'], ['master', 'kept', 'unchanged'], ['graphyard-claude-1', 'updated', 'rotated'], ['graphyard-codex-1', 'kept', 'unchanged'], ['trusted-acceptance', 'updated', 'rotated'], ['ci-proofs', 'kept', 'unchanged'], ['graphyard-cursor-1', 'added', 'new']]);
  assert.deepEqual(rosterPreview(live, mergeRoster(live, [], ['graphyard-codex-1'])).at(-1), { id: 'graphyard-codex-1', role: 'worker', change: 'removed', token: 'removed' });
  const printed = JSON.stringify(preview);
  for (const entry of [...live, ...next]) assert.equal(printed.includes(entry.token), false, `the preview never prints ${entry.id}'s token`);
  // Only a changed producer token touches a GitHub secret, and only once the deployment serves it.
  assert.deepEqual(secretsToSync(live, merged), [], 'an unchanged producer token leaves every secret alone');
  assert.deepEqual(secretsToSync(live, next).map((entry: any) => [entry.id, entry.secret]), [['trusted-acceptance', 'GRAPHYARD_PRODUCER_TOKEN']]);
  let deployedAfter = 2;
  const fetcher = async (_url: string, init: any) => {
    const bearer = init.headers.Authorization.slice('Bearer '.length);
    const serving = deployedAfter-- <= 0 ? next : live;
    const actor = serving.find((entry: any) => entry.token === bearer);
    return new Response(JSON.stringify(actor ? { actor: { id: actor.id, role: actor.role } } : { error: 'unauthorized' }), { status: actor ? 200 : 401 });
  };
  const waits: number[] = [];
  const served = await awaitServedTokens('https://graphyard.example', [{ id: 'trusted-acceptance', token: rotated.token }], { fetcher: fetcher as typeof fetch, intervalMs: 7, wait: async (ms: number) => { waits.push(ms); } });
  assert.deepEqual(served, { served: ['trusted-acceptance'], pending: [] });
  assert.deepEqual(waits, [7, 7], 'the secret waits until the deployment authenticates the rotated token');
  let now = 0;
  const never = await awaitServedTokens('https://graphyard.example', [{ id: 'trusted-acceptance', token: rotated.token }], { fetcher: (async () => new Response('{}', { status: 401 })) as typeof fetch, timeoutMs: 30, intervalMs: 10, wait: async (ms: number) => { now += ms; }, clock: () => now });
  assert.deepEqual(never, { served: [], pending: ['trusted-acceptance'] }, 'an undeployed token is reported pending and its secret is left unchanged');
  // Timeout, then rerun: the first run records the owed sync (by digest, never the token) before it
  // stages. On the rerun the live roster already holds the staged token, so no token "changes" —
  // yet the record keeps the secret due until it is set.
  const rotation = secretsDue(live, next, []);
  const record = secretSyncRecord(rotation);
  assert.deepEqual(record.map((entry: any) => [entry.id, entry.secret]), [['trusted-acceptance', 'GRAPHYARD_PRODUCER_TOKEN']]);
  assert.equal(JSON.stringify(record).includes(rotated.token), false, 'the record never holds a token');
  const staged = next; // what `railway variable list` returns once the first run staged its roster
  const rerunRoster = mergeRoster(staged, [...local, generatedProducer(staged, 'trusted-acceptance', { role: 'producer', proofs: ['integration:claim-safety'] }, [], () => secret('other'))]);
  assert.deepEqual(secretsToSync(staged, rerunRoster), [], 'the staged token reads as live on the rerun');
  assert.deepEqual(secretsDue(staged, rerunRoster, record).map((entry: any) => [entry.id, entry.secret, entry.token]), [['trusted-acceptance', 'GRAPHYARD_PRODUCER_TOKEN', rotated.token]], 'the rerun still owes the secret the staged token');
  // Once set, the record is emptied and nothing is owed; a record whose token never reached the roster is stale.
  assert.deepEqual(secretsDue(staged, rerunRoster, secretSyncRecord([])), []);
  assert.deepEqual(pendingSecretSyncs(record, live), [], 'a token that was never staged owes nothing: the secret still matches the live roster');
  // Rotating again on the rerun supersedes the owed token rather than setting both.
  const again = mergeRoster(staged, [generatedProducer(staged, 'trusted-acceptance', { role: 'producer', proofs: ['integration:claim-safety'] }, ['trusted-acceptance'], () => secret('third'))]);
  assert.deepEqual(secretsDue(staged, again, record).map((entry: any) => entry.token), [secret('third')]);
  // The script wires these together: it reads the live roster, refuses before any write, and deploys before any secret.
  const script = await readFile(new URL('../scripts/configure-integrations.mjs', import.meta.url), 'utf8');
  const order = ['variable\', \'list\'', 'assertRosterSafe(live, roster, options)', 'rerun with --deploy', 'variable\', \'set\'', '\'redeploy\'', 'await awaitServedTokens(url', '\'secret\', \'set\''].map(fragment => script.indexOf(fragment));
  assert.ok(order.every(index => index > 0), 'every step is present'); assert.deepEqual([...order].sort((x, y) => x - y), order, 'live read, safety check, staging, deploy, serve check, then secret');
  assert.doesNotMatch(script, /--skip-deploys[^\n]*\n[^\n]*gh\(\['secret'/, 'no secret is set straight after a skip-deploys stage');
  const recorded = ['secretsDue(live, roster, record)', 'await saveRecord(secrets)', 'variable\', \'set\'', '\'secret\', \'set\'', 'await saveRecord(secrets.filter'].map(fragment => script.indexOf(fragment));
  assert.ok(recorded.every(index => index > 0)); assert.deepEqual([...recorded].sort((x, y) => x - y), recorded, 'the owed sync is recorded before staging and cleared only after its secret is set');
  const docs = await readFile(new URL('../docs/deployment.md', import.meta.url), 'utf8');
  for (const fragment of ['--rotate', '--remove', '--deploy', 'live roster']) assert.ok(docs.includes(fragment), `docs/deployment.md documents ${fragment}`);
});

test('unit:autonomous-session-prompts — reviewer, producer and worker sessions are told to decide and act on their own, and one that ends waiting on input is recorded as failed with the reason', async () => {
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/masters/c.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'h', masterAgentName: 'm' });
  const binding = { key: 'GY-69', id: 'work-69', pr: 69, sha: H, baseSha: B, policyRevision: 1, author: 'implementer', branch: 'graphyard/gy-69-1', group: 'unit' as const, proofs: ['unit:autonomous-session-prompts'], requestId: 'r' };
  const prompts = { reviewer: reviewPrompt(config, binding), producer: producerPrompt(config, binding, { principal: 'proof-runner' }), worker: workerPrompt(config, { key: 'GY-69', title: 'Resilience' }, { principal: 'graphyard-claude-1' }, 4) };
  for (const [role, prompt] of Object.entries(prompts)) {
    for (const fragment of ['Decide and act on your own', 'Never stop to ask a human for confirmation', 'never end your turn with a question', 'never offer a menu of options', 'naming the exact command that was blocked and its error', 'A session that ends waiting on input is recorded as failed']) assert.ok(prompt.includes(fragment), `the ${role} prompt states: ${fragment}`);
  }
  assert.match(prompts.reviewer, /post the verdict yourself, APPROVE or REQUEST_CHANGES/); assert.match(prompts.reviewer, new RegExp(`record a blocker as one review with event=COMMENT on commit ${H}`));
  assert.match(prompts.producer, /submit pass or fail evidence for every proof of the group/); assert.match(prompts.producer, /submit that proof as result fail/);
  assert.match(prompts.worker, new RegExp(`record a blocker with node ${launcher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} blocked GY-69 4 REASON`));
  assert.equal(autonomousSession('x', 'y').startsWith('Decide and act on your own: x.'), true);

  // A producer or reviewer session Herdr reports blocked is recorded failed with that reason.
  const { root, token, cleanup } = await installed({ reviewer: true });
  try {
    const credential = await token('producer');
    await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: credential }, producerVerify('proof-runner'));
    const master = await loadMasterConfig(root);
    const item = requested();
    await launchProducer(root, item, item.autoDispatch!.producers[0], master.producers[0], [], new Date().toISOString(), { run: herdr([]) });
    const started = Date.parse((await readProducerLedger(root)).producers[0].requestedAt);
    const blocked = [{ name: 'produce-a', pane_id: 'pane-1', agent_status: 'blocked' }];
    await reconcileProducers(root, master, [item], blocked, { run: herdr([]), now: () => new Date(started + 1000) });
    const producer: ProducerRecord = (await reconcileProducers(root, master, [item], blocked, { run: herdr([]), now: () => new Date(started + 1000 + producerIdleGraceMs) })).producers[0];
    assert.equal(producer.state, 'failed');
    assert.match(producer.resolution!, /ended waiting on input \(Herdr reports it blocked\) instead of deciding on its own/);
    assert.equal(summarizeProducers([producer]).completed[0].resolution, producer.resolution);

    await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdr([]), mint, requestId: 'review-request' });
    const reviewStart = Date.parse((await readReviewLedger(root)).reviews[0].requestedAt);
    const reviewAgents = [{ name: 'review-claude-1', pane_id: 'pane-1', agent_status: 'blocked' }];
    const pending = await reconcileReviews(root, master, { run: herdr([]), observe: () => null, work: [work()], agents: reviewAgents, now: () => new Date(reviewStart + 1000) });
    assert.equal(pending.reviews[0].state, 'pending', 'a grace period first');
    const review: ReviewRecord = (await reconcileReviews(root, master, { run: herdr([]), observe: () => null, work: [work()], agents: reviewAgents, now: () => new Date(reviewStart + 1000 + reviewIdleGraceMs) })).reviews[0];
    assert.equal(review.state, 'failed'); assert.equal(review.attempt, 1);
    assert.match(review.resolution!, /the reviewer session ended waiting on input \(Herdr reports it blocked\) instead of deciding on its own, without a verdict/);
    assert.equal(summarizeReviews([review]).completed[0].resolution, review.resolution);
    // A session Herdr cannot read is never judged finished.
    const reviewLedger = await readReviewLedger(root); reviewLedger.reviews[0] = { ...reviewLedger.reviews[0], state: 'pending', idleSince: undefined, closedAt: undefined, resolution: undefined };
    await writeFile(join(root, '.graphyard/reviews.json'), JSON.stringify(reviewLedger), { mode: 0o600 });
    const blind = await reconcileReviews(root, master, { run: herdr([]), observe: () => null, work: [work()], agents: null, now: () => new Date(reviewStart + 10 * 60_000) });
    assert.equal(blind.reviews[0].state, 'pending'); assert.equal(blind.reviews[0].idleSince, undefined);
  } finally { await cleanup(); }

  // A worker blocked on a prompt while it holds its assignment is recorded as a failed session, once.
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-resilience-worker-'));
  try {
    const coordinator = join(directory, 'coordinator.token'); await writeFile(coordinator, coordinatorToken, { mode: 0o600 });
    const workerCredential = join(directory, 'worker.token'); await writeFile(workerCredential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const profile = { name: 'claude-worker', principal: 'graphyard-claude-1', agentName: 'engineering-claude-1', mode: 'launch', kind: 'claude', credentialFile: workerCredential } as WorkerProfile;
    const master = masterConfig(coordinator, { workers: [profile], producers: [] });
    const held = work({ stage: 'build', submission: null, candidate: null, epoch: 4, lease: { owner: 'graphyard-claude-1', epoch: 4, expiresAt: iso(60_000) } as any });
    const state = emptyDaemonState(master);
    const effects = daemonEffects({ snapshot: async () => ({ work: [held], now: iso(0) }), agents: () => [{ name: 'engineering-claude-1', pane_id: 'pane-w', agent_status: 'blocked' }] });
    const first = await runCycle(master, state, effects, () => clock);
    const failed = first.actions.find(action => action.kind === 'session')!;
    assert.equal(failed.state, 'failed'); assert.equal(failed.work, 'GY-69');
    assert.match(failed.detail, /Worker session engineering-claude-1 on GY-69 \(epoch 4\) is waiting on input \(Herdr reports it blocked\) instead of deciding on its own/);
    assert.equal((await runCycle(master, state, effects, () => clock + 1000)).actions.filter(action => action.kind === 'session').length, 0, 'recorded once per pane and epoch');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
