import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { MERGE_PROTOCOL } from '../src/protocol-version.js';
import { actionClaimMs, actionId, type ActionRow } from '../src/model/actions.js';
import { createSchema, systemDrivenDefault, type Work } from '../src/model/work.js';
import { controlPlaneHandlers } from '../src/executor.js';
import { dispatchWork, masterConfigSchema, managedMasterInstructions, prepareWorkerLaunch, runAutonomyCommand, unauthorizedMergeViolation, workAttentionOwner, type WorkerProfile } from '../src/master.js';
import { assertHandDispatch, dispatchRaceRefusal, handDecision, mergeDecisionRecovery, handDispatchClaimMarginMs, handDispatchClaimTimeoutMs, handDispatchFenceMs, loopOwned, producerRecovery, releaseEventKinds, reviewRecovery, systemDriven, systemDrivenRefusal } from '../src/cli/hand-actions.js';
import { dispatchFailureLimit } from '../src/auto-dispatch.js';

// GY-175: the master-side rules the loop depends on are enforced by the master CLI itself, not
// remembered by one agent. A hand dispatch never races the executor's, and a system-driven item is
// never pushed through its gates by hand. Every command runs through the shipped launcher against
// a stub control plane that answers only the reads the master CLI makes.

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const workId = '2b8f3f0e-6a52-4c1c-9d8e-6f6d2f2b1a01';
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function item(overrides: Partial<Work> = {}): Work {
  const at = iso(-3_600_000);
  return {
    id: workId, key: 'GY-7', title: 'Guarded item', description: '', type: 'feature', stage: 'ready', ready: true, blocker: null, priority: 1, epoch: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:guard'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], workspaces: [], evidence: [],
    gates: [], violations: [], createdAt: at, updatedAt: at, stageEnteredAt: at, lease: null, candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], observation: null, revision: 1, policyRevision: 1, ...overrides,
  } as Work;
}

function dispatchRow(overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    id: actionId('dispatch', workId, 'dispatch:0'), kind: 'dispatch', work: workId, key: 'GY-7',
    inputs: { kind: 'dispatch', target: 'implementation', epoch: 0, priority: 1, plannedFiles: [] },
    gate: 'build', refusal: 'Worker has not submitted implementation for this attempt', reason: 'GY-7 is ready and unassigned: Worker has not submitted implementation for this attempt',
    binding: 'dispatch:0', requestedBy: 'graphyard', requestedAt: iso(-60_000), state: 'pending', claim: null, attempts: 0,
    history: [{ at: iso(-60_000), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: 'GY-7 is ready and unassigned' }], ...overrides,
  };
}

const claimed = (): Partial<ActionRow> => ({ state: 'claimed', attempts: 1, claim: { executor: 'executor-host-1', host: 'host-1', principal: 'master', claimedAt: iso(-5_000), expiresAt: iso(actionClaimMs - 5_000), attempt: 1 } });

/** A master checkout bound to a stub control plane; `run` executes one master command through the launcher. */
async function masterHarness(state: { work: Work[]; releasedAt?: string | null }, options: { operatorAgent?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gy-hand-'));
  const credentials = await mkdtemp(join(tmpdir(), 'gy-hand-cred-'));
  const credentialFile = join(credentials, 'coordinator.token');
  const reads: string[] = [];
  const http = createServer((req, res) => {
    reads.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') return res.end(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, build: { commit: null, protocol: MERGE_PROTOCOL } }));
    if (req.url?.startsWith('/api/work-snapshot')) return res.end(JSON.stringify({ now: iso(), work: state.work, jobs: [] }));
    if (req.url?.startsWith('/api/events?')) return res.end(JSON.stringify(state.releasedAt ? [{ seq: '9', work_id: workId, actor: 'operator', kind: 'ready', created_at: state.releasedAt }] : []));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  await exec('git', ['init', '-q'], { cwd: root });
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(join(root, '.graphyard'));
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ version: 1, url, credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
    ...(options.operatorAgent ? { operatorAgent: { id: 'master-operator', credentialFile: join(credentials, 'operator.token') } } : {}), run: { intervalSeconds: 5, dispatchIntervalSeconds: 10, deploymentShaField: 'commit' } }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: url };
  for (const name of Object.keys(env)) if (name.startsWith('GRAPHYARD_') && name !== 'GRAPHYARD_URL') delete env[name];
  const run = (args: string[]) => exec(process.execPath, [launcher, 'master', ...args], { cwd: root, env, timeout: 120_000 });
  /** The command's refusal on stderr; the command must fail. */
  const refusal = async (args: string[]) => {
    const failed = await run(args).then(() => null, (error: any) => String(error.stderr));
    assert.ok(failed !== null, `master ${args.join(' ')} must be refused`);
    return failed;
  };
  const close = async () => {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true });
  };
  /** Records a launch of the item's review (or producer) request the loop's cursor saw refused `attempts` times. */
  const refusedLaunches = (requestId: string, attempts: number, kind: 'review' | 'producer' = 'review') => writeFile(join(credentials, 'coordinator.dispatch.json'), JSON.stringify({ version: 1, url, repository: 'owner/project',
    failures: { [requestId]: { kind, work: 'GY-7', sha: headSha, attempts, reason: `${kind} profile refused the launch`, at: iso(-60_000), nextAt: iso(60_000) } } }), { mode: 0o600 });
  /** Writes the loop's producer ledger with these sessions. */
  const producerSessions = (records: object[]) => writeFile(join(root, '.graphyard/producers.json'), JSON.stringify({ version: 1, producers: records }), { mode: 0o600 });
  return { run, refusal, reads, close, refusedLaunches, producerSessions, root, credentials };
}

const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40), reviewRequestId = 'c'.repeat(32);
/** A system-driven item whose submitted head holds a live review request. */
function underReview(overrides: Partial<Work> = {}): Work {
  return item({ systemDriven: true, stage: 'review', submission: { pr: 12, epoch: 1 } as any,
    candidate: { pr: 12, sha: headSha, baseSha, branch: 'graphyard/gy-7-1', author: 'worker', createdAt: iso(-600_000) } as any,
    autoDispatch: { review: { id: reviewRequestId, kind: 'review', pr: 12, sha: headSha, baseSha, policyRevision: 1, provider: 'github', state: 'requested', reason: 'independent approval is required', requestedAt: iso(-600_000) }, producers: [], history: [] } as any, ...overrides });
}
const session = (state: string, at: number) => ({ requestId: reviewRequestId, state, requestedAt: iso(at), closedAt: iso(at + 60_000), resolution: `${state} session` });
const producerRequestId = 'd'.repeat(32);
/** A system-driven item whose submitted head holds a live producer request for `manual:produced-review`. */
function underProof(): Work {
  return underReview({ producerProofs: ['manual:produced-review'], autoDispatch: { review: null, history: [],
    producers: [{ id: producerRequestId, kind: 'producer', group: 'manual', proofs: ['manual:produced-review'], pr: 12, sha: headSha, baseSha, policyRevision: 1, state: 'requested', reason: 'unproven', requestedAt: iso(-7_200_000) }] } as any });
}
/** One producer ledger record for the live producer request, as the loop writes it. */
const producerSession = (state: string, at: number, attempt = 1) => ({ id: randomUUID(), requestId: producerRequestId, attempt, key: 'GY-7', pr: 12, sha: headSha, baseSha, policyRevision: 1, group: 'manual', proofs: ['manual:produced-review'],
  profile: 'producer', principal: 'producer-principal', agentName: 'produce-1', pane: null, requestedAt: iso(at), expiresAt: iso(at + 3_600_000), state, outcome: {}, closedAt: iso(at + 60_000), resolution: `${state} session`, acknowledgedAt: iso(at + 1_000) });

/** The executor's durable launch rows for the live review and producer requests. */
const reviewRow = (overrides: Partial<ActionRow> = {}): ActionRow => dispatchRow({ id: actionId('request-review', workId, 'review'), kind: 'request-review', binding: 'review', gate: 'review',
  inputs: { kind: 'request-review', provider: 'github', requestId: reviewRequestId, pr: 12, sha: headSha, baseSha, policyRevision: 1 } as any, ...overrides });
const producerRow = (overrides: Partial<ActionRow> = {}): ActionRow => dispatchRow({ id: actionId('dispatch', workId, 'acceptance'), binding: 'acceptance', gate: 'acceptance',
  inputs: { kind: 'dispatch', target: 'proof', group: 'manual', proofs: ['manual:produced-review'], requestId: producerRequestId, pr: 12, sha: headSha, baseSha, policyRevision: 1 } as any, ...overrides });
/** Every state in which an executor still runs a row. */
const launchRows = (make: (overrides?: Partial<ActionRow>) => ActionRow) => ({
  pending: make(), claimed: make(claimed()), 'backing-off': make({ attempts: 1, retryAt: iso(600_000) }),
  settling: make({ state: 'done', resolvedAt: iso(-30_000), result: 'launched' } as any), reopening: make({ state: 'done', resolvedAt: iso(-3_600_000), result: 'launched' } as any),
  'stalled but claimable': stalledRow(make, iso(-1_000)), 'stalled but claimed': stalledRow(make, iso(60_000), claimed()), 'stalled and rechecking': stalledRow(make),
});
/** A row whose last attempts were each refused for one unchanged reason, rechecking at `retryAt`. */
const stalledRow = (make: (overrides?: Partial<ActionRow>) => ActionRow, retryAt = iso(60_000), overrides: Partial<ActionRow> = {}) => {
  const refused = (n: number) => [{ at: iso(-n * 60_000), event: 'claimed', requester: 'graphyard', executor: `executor-${n}`, result: null, reason: 'claimed' },
    { at: iso(-n * 60_000 + 1_000), event: 'failed', requester: 'graphyard', executor: `executor-${n}`, result: null, reason: 'no further automatic attempt' }];
  return make({ attempts: 3, retryAt, history: [...make().history, ...[3, 2, 1].flatMap(refused)] as any, ...overrides });
};

// ---- AC-1: no hand dispatch while the executor's dispatch is pending, claimed or just released ----

test('unit:dispatch-race-guard the refusal names the pending dispatch action while it is claimable, claimed or settling, and inside the dispatch interval after release', () => {
  const now = new Date(), window = { intervalMs: 10_000, releasedAt: null };
  const pending = dispatchRaceRefusal(item({ actionQueue: { actions: [dispatchRow()], history: [] } }), now, window);
  assert.match(pending!, new RegExp(`dispatch action ${dispatchRow().id} \\(GY-7 is ready and unassigned.*\\) is pending and claimable`));
  const held = dispatchRaceRefusal(item({ actionQueue: { actions: [dispatchRow(claimed())], history: [] } }), now, window);
  assert.match(held!, new RegExp(`dispatch action ${dispatchRow().id} .* is claimed by executor executor-host-1 on host-1`));
  // An expired claim is claimable again: the dispatcher's next claim takes it.
  const lapsed = dispatchRaceRefusal(item({ actionQueue: { actions: [dispatchRow({ ...claimed(), claim: { ...claimed().claim!, expiresAt: iso(-1_000) } })], history: [] } }), now, window);
  assert.match(lapsed!, /is pending and claimable/);
  const settled = dispatchRaceRefusal(item({ actionQueue: { actions: [dispatchRow({ state: 'done', resolvedAt: iso(-30_000), result: 'done' })], history: [] } }), now, window);
  assert.match(settled!, /was completed at .* and is settling/);
  const released = dispatchRaceRefusal(item(), now, { intervalMs: 10_000, releasedAt: iso(-3_000) });
  assert.match(released!, /GY-7 was released at .*, within the loop's 10s dispatch interval/);
  // A backoff that ends before a hand launch could reach its lease claim is the executor's next claim: refused.
  const backingOff = dispatchRaceRefusal(item({ actionQueue: { actions: [dispatchRow({ attempts: 1, retryAt: new Date(now.getTime() + 20_000).toISOString() })], history: [] } }), now, window);
  assert.match(backingOff!, new RegExp(`dispatch action ${dispatchRow().id} .* is in a failure backoff that ends at .*, inside the ${handDispatchFenceMs / 1000}s a hand dispatch has to reach its lease claim`));
  assert.match(dispatchRaceRefusal(item({ actionQueue: { actions: [dispatchRow({ attempts: 1, retryAt: new Date(now.getTime() + handDispatchFenceMs - 1).toISOString() })], history: [] } }), now, window)!, /failure backoff/);
  // Past the interval, with nothing queued, and a row whose backoff outlasts the fence: a hand dispatch is the recovery.
  assert.equal(dispatchRaceRefusal(item(), now, { intervalMs: 10_000, releasedAt: iso(-11_000) }), null);
  assert.equal(dispatchRaceRefusal(item({ actionQueue: { actions: [dispatchRow({ attempts: 1, retryAt: new Date(now.getTime() + handDispatchFenceMs + 60_000).toISOString() })], history: [] } }), now, window), null);
  assert.deepEqual([...releaseEventKinds], ['ready', 'unblock', 'release', 'lease.expired']);
});

test('unit:dispatch-race-guard master dispatch is refused naming the pending action, the executor\'s claim, or the release inside the dispatch interval', async () => {
  const state: { work: Work[]; releasedAt?: string | null } = { work: [item({ systemDriven: false, actionQueue: { actions: [dispatchRow()], history: [] } })] };
  const master = await masterHarness(state);
  try {
    assert.match(await master.refusal(['dispatch', 'GY-7', 'claude-worker']), new RegExp(`GY-7: dispatch action ${dispatchRow().id} \\(GY-7 is ready and unassigned[^)]*\\) is pending and claimable; the loop's dispatcher claims it on its next tick, so master dispatch is refused`));
    state.work = [item({ systemDriven: false, actionQueue: { actions: [dispatchRow(claimed())], history: [] } })];
    assert.match(await master.refusal(['dispatch', 'GY-7', 'claude-worker']), new RegExp(`GY-7: dispatch action ${dispatchRow().id} .* is claimed by executor executor-host-1 on host-1 until .*; the executor's dispatch is in progress`));
    // Released three seconds ago and not yet queued: the dispatcher's next tick is ten seconds away at most.
    state.work = [item({ systemDriven: false })]; state.releasedAt = iso(-3_000);
    assert.match(await master.refusal(['dispatch', 'GY-7', 'claude-worker']), /GY-7 was released at .*, within the loop's 10s dispatch interval; the dispatcher's next tick claims its dispatch action, so master dispatch is refused/);
    assert.ok(master.reads.some(url => url.startsWith(`/api/events?work=${workId}&kind=ready,unblock,release,lease.expired&limit=1`)), 'the release is read from the item\'s ledger');
    // Past the interval the guard lets the hand dispatch through, to the checks that follow it.
    state.releasedAt = iso(-60_000);
    const through = await master.refusal(['dispatch', 'GY-7', 'claude-worker']);
    assert.match(through, /Unknown worker profile claude-worker/); assert.doesNotMatch(through, /dispatch interval|claimable|claimed by/);
    // A row whose failure backoff ends within the fence is the executor's next claim, and master dispatch says so.
    state.work = [item({ systemDriven: false, actionQueue: { actions: [dispatchRow({ attempts: 1, retryAt: iso(30_000) })], history: [] } })];
    assert.match(await master.refusal(['dispatch', 'GY-7', 'claude-worker']), new RegExp(`GY-7: dispatch action ${dispatchRow().id} .* is in a failure backoff that ends at .*; the dispatcher claims it then, so master dispatch is refused`));
  } finally { await master.close(); }
});

test('unit:dispatch-race-guard the executor\'s dispatch proceeds on the row the hand dispatch was refused for', async () => {
  const row = dispatchRow(claimed());
  const work = item({ systemDriven: true, actionQueue: { actions: [row], history: [] } });
  assert.match(dispatchRaceRefusal(work, new Date(), { intervalMs: 10_000, releasedAt: iso(-1_000) })!, /claimed by executor executor-host-1/);
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: '/outside/graphyard.mjs', repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-1', masterAgentName: 'm',
    workers: [{ name: 'claude-worker', principal: 'worker-a', agentName: 'work-claude', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' }] });
  const launched: string[] = [];
  const unusable = async () => { throw new Error('not part of a dispatch'); };
  const handlers = controlPlaneHandlers(() => config, {
    snapshot: async () => ({ work: [work], now: iso() }), mutate: unusable, agents: () => [],
    workerCredentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])), producerCredentials: async () => ({}),
    dispatchWorker: async (target, profile) => { launched.push(`${target.key}:${profile.name}`); return { pane: 'pane-w' }; },
    launchReview: unusable, launchProducer: unusable, merge: unusable, observeDeployment: unusable,
  });
  // A system-driven item inside the release interval, with its row claimed: exactly what the hand path refuses.
  assert.match(await handlers.dispatch!(row, { id: 'executor-host-1', host: 'host-1' }), /dispatched GY-7 to claude-worker/);
  assert.deepEqual(launched, ['GY-7:claude-worker']);
});

// ---- AC-2: a system-driven item refuses the hand actions the loop owns ----

test('unit:system-driven-items new items are system-driven by the shipped default; existing items and an explicit opt-out are not', () => {
  assert.equal(systemDrivenDefault, true);
  const intent = { title: 'New', criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:new'] }] };
  assert.equal(createSchema.parse(intent).systemDriven, true);
  assert.equal(createSchema.parse({ ...intent, systemDriven: false }).systemDriven, false);
  assert.equal(systemDriven(item()), false, 'an item created before the field existed carries none');
  assert.equal(systemDriven(item({ systemDriven: true })), true);
  assert.equal(systemDrivenRefusal(item({ systemDriven: false }), 'merge'), null);
});

test('unit:system-driven-items the master CLI refuses dispatch, merge, review launch and evidence on a system-driven item, naming the loop step', async () => {
  const state = { work: [item({ systemDriven: true })] };
  // With an operator-agent identity the loop requests merge decisions itself, so a hand one is refused too.
  const master = await masterHarness(state, { operatorAgent: true });
  try {
    const refused: [string[], keyof typeof loopOwned, RegExp][] = [
      [['dispatch', 'GY-7', 'claude-worker'], 'dispatch', /the loop's dispatch step: master run's dispatcher claims the item's dispatch action/],
      [['merge', 'GY-7'], 'merge', /the loop's merge step: master run performs the guarded merge/],
      [['review', 'GY-7'], 'review', /the loop's dispatch step: master run launches the bound reviewer/],
      [['decide', 'GY-7', 'attest', '{"proof":"unit:guard"}', 'hand', 'evidence'], 'evidence', /the loop's dispatch step: master run launches an independent proof producer/],
      [['decide', 'GY-7', 'merge', 'hand', 'merge'], 'merge-decision', /the loop's decisions step: master run requests the merge decision/],
    ];
    for (const [args, action, step] of refused) {
      const stderr = await master.refusal(args);
      assert.match(stderr, new RegExp(`GY-7 is system-driven: ${loopOwned[action].command} is a hand action the loop owns`), `master ${args.join(' ')}`);
      assert.match(stderr, step, `master ${args.join(' ')} names the loop step`);
    }
    // The system-driven refusal comes before any release read: nothing about the race is consulted.
    assert.ok(!master.reads.some(url => url.startsWith('/api/events')));
  } finally { await master.close(); }
});

test('unit:system-driven-items monitoring and the loop itself are unaffected on a system-driven item', async () => {
  const master = await masterHarness({ work: [item({ systemDriven: true, actionQueue: { actions: [dispatchRow()], history: [] } })] });
  try {
    const status = JSON.parse((await master.run(['status'])).stdout);
    assert.ok(status.daemon, 'master status reports on a system-driven item');
    const loop = JSON.parse((await master.run(['run', '--once'])).stdout);
    assert.equal(loop.cycles, 1); assert.equal(loop.failedCycles, 0);
  } finally { await master.close(); }
});

test('unit:system-driven-items master decide attest stays open for a manual proof no producer runs, and closed for one a producer runs', async () => {
  const work = item({ systemDriven: true, producerProofs: ['manual:produced-review'] });
  assert.equal(handDecision(work, 'attest', { proof: 'manual:docs-review' }), null, 'only an attestation satisfies a manual proof no producer runs');
  assert.equal(handDecision(work, 'attest', { proof: 'manual:produced-review' }), 'evidence');
  assert.equal(handDecision(work, 'attest', { proof: 'unit:guard' }), 'evidence');
  assert.equal(handDecision(work, 'attest', null), 'evidence');
  assert.equal(handDecision(work, 'merge', null), 'merge-decision');
  assert.equal(handDecision(work, 'rework', null), null);
  const master = await masterHarness({ work: [work] });
  try {
    const open = await master.refusal(['decide', 'GY-7', 'attest', '{"proof":"manual:docs-review"}', 'reviewed', 'by', 'hand']);
    assert.doesNotMatch(open, /is system-driven/, 'the attestation reaches the decision request');
    assert.match(await master.refusal(['decide', 'GY-7', 'attest', '{"proof":"manual:produced-review"}', 'hand']), /GY-7 is system-driven: master decide attest is a hand action the loop owns/);
  } finally { await master.close(); }
});

test('unit:system-driven-items master review stays open only as the recovery of a review request the loop stopped relaunching', async () => {
  const now = Date.now();
  // The loop still launches it: nothing launched yet, a session running, a failed session awaiting its retry.
  assert.equal(reviewRecovery(underReview(), [], undefined, now), null);
  assert.equal(reviewRecovery(underReview(), [{ ...session('pending', -60_000), closedAt: undefined }], undefined, now), null);
  assert.equal(reviewRecovery(underReview(), [session('failed', -120_000)], undefined, now), null);
  assert.equal(reviewRecovery(underReview(), [], { attempts: dispatchFailureLimit - 1 }, now), null);
  assert.equal(reviewRecovery(item({ systemDriven: true }), [session('completed', -120_000)], { attempts: dispatchFailureLimit }, now), null, 'no live request: nothing to recover');
  // The loop stopped: a settled session, exhausted sessions, exhausted launch refusals.
  assert.match(reviewRecovery(underReview(), [session('completed', -120_000)], undefined, now)!, /session attempt 1 completed without satisfying it/);
  // A session closed on the verdict it posted answered the request; until the control plane ingests that review a second session would only post a conflicting verdict.
  const verdict = (state: string) => ({ ...session('completed', -120_000), verdict: { state, reviewer: 'graphyard-reviewer[bot]', reviewId: 7, submittedAt: new Date(now - 60_000).toISOString() } });
  assert.equal(reviewRecovery(underReview(), [verdict('APPROVED')], undefined, now), null);
  assert.equal(reviewRecovery(underReview(), [verdict('CHANGES_REQUESTED')], undefined, now), null);
  assert.match(reviewRecovery(underReview(), [verdict('DISMISSED')], undefined, now)!, /completed without satisfying it/, 'a dismissed verdict answers nothing');
  assert.match(reviewRecovery(underReview(), [1, 2, 3, 4].map(n => session('failed', -n * 3_600_000)), undefined, now)!, /exhausted its 4 automatic sessions/);
  assert.match(reviewRecovery(underReview(), [], { attempts: dispatchFailureLimit }, now)!, /refused 12 time\(s\)/);
  // The durable row is the executor's, on any host: while it is pending, claimed, backing off, settling or about to reopen, the loop still launches the request whatever this host's ledgers say.
  const stopped = [session('completed', -120_000)];
  for (const [label, row] of Object.entries(launchRows(reviewRow)))
    assert.equal(reviewRecovery(underReview({ actionQueue: { actions: [row], history: [] } }), stopped, undefined, now), null, `a ${label} request-review row`);
  // A row stalled on one unchanged refusal still rechecks, and is claimed a minute after its cause clears: a hand launch in that wait would be a second launch.
  assert.equal(reviewRecovery(underReview({ actionQueue: { actions: [stalledRow(reviewRow)], history: [] } }), stopped, undefined, now), null, 'a stalled row waiting to recheck');
  // Once the item no longer needs the action its row is retired, and the recovery is the master's again.
  assert.match(reviewRecovery(underReview({ actionQueue: { actions: [], history: [{ ...stalledRow(reviewRow), resolvedAt: iso(-1_000), resolution: 'retired' }] } }), stopped, undefined, now)!, /completed without satisfying it/);
  const master = await masterHarness({ work: [underReview()] });
  try {
    assert.match(await master.refusal(['review', 'GY-7']), /GY-7 is system-driven: master review is a hand action the loop owns/);
    await master.refusedLaunches(reviewRequestId, dispatchFailureLimit);
    const before = master.reads.filter(url => url.startsWith('/api/work-snapshot')).length;
    assert.doesNotMatch(await master.refusal(['review', 'GY-7']), /is system-driven/, 'the recovery the loop names reaches the launch');
    // The launch reads its review request from the snapshot the guard judged, never from a later one a new head could change.
    assert.equal(master.reads.filter(url => url.startsWith('/api/work-snapshot')).length - before, 1, 'master review reads one work snapshot');
  } finally { await master.close(); }
});

test('unit:system-driven-items master decide attest reopens for a produced manual proof once the loop stops relaunching its producer request', async () => {
  const now = Date.now(), attest = { proof: 'manual:produced-review' };
  const loop = (sessions: object[], failures: Record<string, { attempts: number }> = {}) => ({ sessions: sessions as any, failures, now });
  // The loop still launches it: nothing launched yet, a session running, a failed session awaiting its retry, launch refusals under the limit.
  assert.equal(handDecision(underProof(), 'attest', attest, loop([])), 'evidence');
  assert.equal(handDecision(underProof(), 'attest', attest, loop([{ ...producerSession('pending', -60_000), closedAt: undefined }])), 'evidence');
  assert.equal(handDecision(underProof(), 'attest', attest, loop([producerSession('failed', -120_000)])), 'evidence');
  assert.equal(handDecision(underProof(), 'attest', attest, loop([], { [producerRequestId]: { attempts: dispatchFailureLimit - 1 } })), 'evidence');
  assert.equal(producerRecovery(underProof(), 'manual:other', loop([producerSession('completed', -120_000)])), null, 'no live request for that proof: nothing to recover');
  // The loop stopped: a settled session, exhausted sessions, exhausted launch refusals. Nothing launches a producer by hand, so only the attestation is left.
  assert.match(producerRecovery(underProof(), 'manual:produced-review', loop([producerSession('completed', -120_000)]))!, /producer request d+'s session attempt 1 completed without satisfying it/);
  assert.match(producerRecovery(underProof(), 'manual:produced-review', loop([1, 2, 3, 4].map(n => producerSession('failed', -n * 3_600_000, 5 - n))))!, /exhausted its 4 automatic sessions/);
  assert.match(producerRecovery(underProof(), 'manual:produced-review', loop([], { [producerRequestId]: { attempts: dispatchFailureLimit } }))!, /refused 12 time\(s\)/);
  assert.equal(handDecision(underProof(), 'attest', attest, loop([producerSession('completed', -120_000)])), null);
  assert.equal(handDecision(underProof(), 'attest', { proof: 'unit:guard' }, loop([producerSession('completed', -120_000)])), 'evidence', 'only a manual proof is ever attested');
  // The executor launches producers from the durable dispatch row bound to the request; while it runs, the attestation stays the loop's.
  const stopped = loop([producerSession('completed', -120_000)]);
  for (const [label, row] of Object.entries(launchRows(producerRow)))
    assert.equal(handDecision({ ...underProof(), actionQueue: { actions: [row], history: [] } }, 'attest', attest, stopped), 'evidence', `a ${label} producer dispatch row`);
  assert.equal(handDecision({ ...underProof(), actionQueue: { actions: [producerRow({ inputs: { ...producerRow().inputs, requestId: null } as any })], history: [] } }, 'attest', attest, stopped), 'evidence', 'a row naming the request only by its group');
  assert.equal(handDecision({ ...underProof(), actionQueue: { actions: [producerRow({ inputs: { ...producerRow().inputs, requestId: 'e'.repeat(32), group: 'unit' } as any })], history: [] } }, 'attest', attest, stopped), null, "another request's row does not hold this one");
  assert.equal(handDecision({ ...underProof(), actionQueue: { actions: [stalledRow(producerRow)], history: [] } }, 'attest', attest, stopped), 'evidence', 'a stalled row waiting to recheck still launches the producer once its cause clears');
  assert.equal(handDecision({ ...underProof(), actionQueue: { actions: [], history: [stalledRow(producerRow)] } }, 'attest', attest, stopped), null, 'a retired row launches nothing');
  const master = await masterHarness({ work: [underProof()] });
  try {
    const decide = ['decide', 'GY-7', 'attest', '{"proof":"manual:produced-review"}', 'reviewed', 'by', 'hand'];
    assert.match(await master.refusal(decide), /GY-7 is system-driven: master decide attest is a hand action the loop owns/);
    await master.producerSessions([1, 2, 3, 4].map(n => producerSession('failed', -n * 3_600_000, 5 - n)));
    // Past the guard the command asks for the two-party decision, which this checkout has no operator-agent identity for.
    assert.match(await master.refusal(decide), /No master operator-agent identity is provisioned/, 'an exhausted producer request leaves the attestation to the two-party decision');
    await master.producerSessions([]);
    await master.refusedLaunches(producerRequestId, dispatchFailureLimit, 'producer');
    assert.match(await master.refusal(decide), /No master operator-agent identity is provisioned/, 'so does a producer launch the loop gave up on');
  } finally { await master.close(); }
});

test('unit:dispatch-race-guard a hand launch through a long backoff claims nothing once the backoff is about to end', async () => {
  const now = iso(), retryAt = Date.parse(now) + handDispatchFenceMs + 60_000;
  const backedOff = item({ systemDriven: false, actionQueue: { actions: [dispatchRow({ attempts: 2, retryAt: new Date(retryAt).toISOString() })], history: [] } });
  const requestedAt = Date.now() - 5_000;
  const { claimBy } = await assertHandDispatch(backedOff, now, 10, async () => [], requestedAt);
  // The deadline is the row's retryAt carried onto this host's clock from before the snapshot was read, less the claim's headroom.
  assert.equal(claimBy, requestedAt + (retryAt - Date.parse(now)) - handDispatchClaimMarginMs);
  // The headroom outlasts the lease claim itself: the claim child's two CLI requests (the work read, then the claim), each bounded by its 30s timeout, plus its startup; and the fence outlasts the headroom.
  assert.ok(handDispatchClaimMarginMs > 2 * handDispatchClaimTimeoutMs && handDispatchClaimTimeoutMs >= 30_000 && handDispatchFenceMs > handDispatchClaimMarginMs);
  // Time spent reading after the snapshot is counted against the backoff: 61s gone brings its end inside the fence, and the hand dispatch is refused.
  await assert.rejects(assertHandDispatch(backedOff, now, 10, async () => [], Date.now() - 61_000), /is in a failure backoff that ends at .*master dispatch is refused/);
  assert.deepEqual(await assertHandDispatch(item({ systemDriven: false }), now, 10, async () => []), {}, 'no backoff, no deadline');
  const master = await masterHarness({ work: [backedOff] });
  try {
    const credential = join(master.credentials, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
    const prepared: string[] = [];
    const prepare = async (_root: string, key: string) => { prepared.push(key); return { epoch: 1, path: join(master.root, 'assigned'), base: 'c'.repeat(40) }; };
    // Past its deadline the launch stops before the lease claim, so the executor's attempt is the only one.
    await assert.rejects(dispatchWork(master.root, backedOff, profile, [], undefined, [backedOff], prepare, async () => {}, 1, now, { claimBy: Date.now() - 1 }),
      /GY-7: the hand launch did not reach its lease claim before the item's backed-off dispatch action is offered to the executor again, so it claims nothing/);
    assert.deepEqual(prepared, [], 'nothing was claimed');
  } finally { await master.close(); }
});

test('unit:dispatch-race-guard the hand launch checks its deadline again immediately before the lease claim, after the slow steps that precede it', async () => {
  const master = await masterHarness({ work: [item({ systemDriven: false })] });
  try {
    const credential = join(master.credentials, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const configFile = join(master.root, '.graphyard/master.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    await writeFile(configFile, JSON.stringify({ ...config, workers: [{ name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, approvals: 'auto' }] }), { mode: 0o600 });
    const commands: string[] = [];
    // The base fetch is the slow step between the dispatch-time check and the claim.
    const run = async (command: string, args: string[]) => {
      commands.push(command === 'git' ? `git ${args[0]}` : args[1]);
      if (command === 'git' && args[0] === 'fetch') await new Promise(resolve => setTimeout(resolve, 200));
      if (command === 'git') return args[0] === 'rev-parse' ? `${'c'.repeat(40)}\n` : '';
      return args[1] === 'claim' ? JSON.stringify({ epoch: 3, lease: { owner: 'worker-a' } }) : JSON.stringify({ path: join(master.root, 'assigned') });
    };
    // Inside its deadline when the launch began, past it once the fetch returned: the claim is never made.
    await assert.rejects(prepareWorkerLaunch(master.root, 'GY-7', 'launch', run, Date.now() + 100), /GY-7: the hand launch did not reach its lease claim before the item's backed-off dispatch action is offered to the executor again, so it claims nothing/);
    assert.deepEqual(commands, ['git fetch', 'git rev-parse'], 'nothing was claimed, so nothing is released either');
    commands.length = 0;
    const prepared = await prepareWorkerLaunch(master.root, 'GY-7', 'launch', run, Date.now() + 60_000);
    assert.equal(prepared.epoch, 3); assert.deepEqual(commands.slice(0, 4), ['git fetch', 'git rev-parse', 'claim', 'worktree'], 'inside the deadline the claim proceeds');
    // dispatchWork hands its deadline to the preparer, which is where the claim happens.
    const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
    const deadlines: (number | undefined)[] = [], claimBy = Date.now() + 60_000;
    const prepare = async (_root: string, _key: string, _profile: string, _run?: unknown, deadline?: number): Promise<never> => { deadlines.push(deadline); throw new Error('stop at the claim'); };
    await assert.rejects(dispatchWork(master.root, item({ systemDriven: false }), profile, [], undefined, [item({ systemDriven: false })], prepare, async () => {}, 1, iso(), { claimBy }), /stop at the claim/);
    assert.deepEqual(deadlines, [claimBy]);
  } finally { await master.close(); }
});

test('unit:system-driven-items master decide merge stays open where the loop sends the master to it: an unauthorized merge, or a loop that cannot request decisions', async () => {
  const merged = item({ systemDriven: true, stage: 'merge', violations: [unauthorizedMergeViolation], observation: { merged: true, mergeSha: 'e'.repeat(40), mergedAt: iso(-60_000) } as any });
  const loop = (requestsDecisions?: boolean) => ({ sessions: [], failures: {}, now: Date.now(), requestsDecisions });
  assert.equal(handDecision(item({ systemDriven: true }), 'merge', null, loop(true)), 'merge-decision');
  assert.equal(handDecision(merged, 'merge', null, loop(true)), null);
  assert.match(mergeDecisionRecovery(merged, loop(true))!, /merged on GitHub without a valid merge execution/);
  assert.equal(handDecision(item({ systemDriven: true }), 'merge', null, loop(false)), null);
  assert.match(mergeDecisionRecovery(item({ systemDriven: true }), loop(false))!, /no master operator-agent identity/);
  const master = await masterHarness({ work: [merged] }, { operatorAgent: true });
  try {
    assert.doesNotMatch(await master.refusal(['decide', 'GY-7', 'merge', 'reconcile', 'the', 'merge']), /is system-driven/, 'the reconciliation reaches the decision request');
  } finally { await master.close(); }
  const unprovisioned = await masterHarness({ work: [item({ systemDriven: true })] });
  try {
    assert.match(await unprovisioned.refusal(['decide', 'GY-7', 'merge', 'hand', 'merge']), /No master operator-agent identity is provisioned/, 'without an operator-agent identity the hand decision is the only one');
  } finally { await unprovisioned.close(); }
});

test('unit:system-driven-items the master\'s own next steps name the loop step for a system-driven item, never a hand command it refuses', () => {
  const atMerge = (systemDriven: boolean) => item({ systemDriven, stage: 'merge', gates: [{ name: 'merge', passed: false, reasons: ['Merge authorization is not current'] }] as any });
  assert.match(workAttentionOwner(atMerge(true), 'gate').next, /the loop's merge step performs the guarded merge of GY-7/);
  assert.doesNotMatch(workAttentionOwner(atMerge(true), 'gate').next, /master merge/);
  assert.equal(workAttentionOwner(atMerge(false), 'gate').next, 'graphyard master merge GY-7');
  assert.doesNotMatch(workAttentionOwner(item({ systemDriven: true }), 'hold-overdue').next, /master dispatch/);
  assert.match(workAttentionOwner(item({ systemDriven: false }), 'hold-overdue').next, /graphyard master dispatch GY-7 PROFILE does it now/);
  assert.match(workAttentionOwner(item({ systemDriven: true }), 'session').next, /the loop's dispatcher launches GY-7 again/);
  const produced = item({ systemDriven: true, producerProofs: ['manual:produced-review'], gates: [{ name: 'acceptance', passed: false, reasons: ['AC-1: manual:produced-review needs trusted passing evidence'] }] as any });
  assert.match(workAttentionOwner(produced, 'gate').next, /The loop's producer session produces manual:produced-review/);
  // The AGENTS.md master block routes merges of system-driven items to the loop and keeps the hand commands for the opt-out.
  const block = managedMasterInstructions('').replace(/\s+/g, ' ');
  assert.match(block, /Items are system-driven unless created with `"systemDriven": false`: for them `graphyard master run` dispatches, launches review and proof producers, requests merge decisions and performs the guarded merge/);
  // An opted-out item is still driven by the loop: the instructions allow the hand commands in addition, never instead.
  assert.match(block, /The loop drives an item created `"systemDriven": false` the same way; opting out only also allows the hand actions/);
  assert.match(block, /a hand `graphyard master decide GY-N merge` is only for an opted-out item the loop has not requested it for/);
  assert.doesNotMatch(workAttentionOwner(item({ systemDriven: true }), 'launch-review').next, /then graphyard master review GY-7$/);
  assert.equal(workAttentionOwner(item({ systemDriven: false }), 'launch-review').next, 'Fix the refusal reason, then graphyard master review GY-7');
  // An ordinary pending review names the loop's relaunch too, not a `master review` the CLI refuses.
  const atReview = (systemDriven: boolean) => item({ systemDriven, stage: 'review', gates: [{ name: 'review', passed: false, reasons: ['A new independent GitHub approval is required'] }] as any });
  assert.match(workAttentionOwner(atReview(true), 'gate').next, /the loop relaunches the review on its own; graphyard master review GY-7 only once the loop has stopped relaunching its request/);
  assert.doesNotMatch(workAttentionOwner(atReview(true), 'gate').next, /relaunches a refused review/);
  assert.match(workAttentionOwner(atReview(false), 'gate').next, /graphyard master review GY-7 relaunches a refused review/);
});

test('unit:system-driven-items master decide judges the exact work document the decision is built from', async () => {
  // The guard runs on the one snapshot the decision is built from: a newer read never replaces the document it judged.
  const exhausted = underProof(), live = { ...underProof(), revision: 2 };
  const snapshots = [exhausted, live]; const judged: Work[] = []; const posted: string[] = [];
  const deps = { coordinator: async (path: string) => { assert.equal(path, 'work-snapshot'); return { now: iso(), work: [snapshots.shift() ?? live] }; }, readSecret: async () => '', agents: () => [], daemonLock: async () => null,
    fetcher: (async (url: string) => { posted.push(url); return new Response('{}'); }) as unknown as typeof fetch,
    assertDecision: (work: Work) => { judged.push(work); throw new Error(`${work.key} is system-driven: refused at revision ${work.revision}`); } };
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: '/nonexistent', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  await assert.rejects(runAutonomyCommand('/nonexistent', config, 'decide', ['GY-7', 'attest', '{"proof":"manual:produced-review"}', 'hand'], deps), /refused at revision 1/);
  assert.deepEqual(judged.map(work => work.revision), [1]); assert.equal(snapshots.length, 1, 'decide reads one work snapshot'); assert.deepEqual(posted, []);
  // Through the shipped CLI, on a decision the guard lets through: one work-snapshot read, so the guard and the decision share it.
  const master = await masterHarness({ work: [underReview()] });
  try {
    await master.refusal(['decide', 'GY-7', 'attest', '{"proof":"manual:docs-review"}', 'hand']);
    assert.equal(master.reads.filter(url => url.startsWith('/api/work-snapshot')).length, 1, 'master decide reads one work snapshot');
  } finally { await master.close(); }
});
