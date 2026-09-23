import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server, type Credential } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { capacityRoles } from '../src/model/capacity.js';
import { claimAction, reconcileActions, settleAction, type ActionRow } from '../src/model/actions.js';
import { actionStallThreshold } from '../src/model/action-progress.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { readReviewLedger, saveReviewLedger, type ReviewRecord } from '../src/reviewer.js';
import { controlPlaneHandlers } from '../src/executor.js';
import { runExecutorTick } from '../src/auto-dispatch.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { stalledActionAttention } from '../src/cli/master-status.js';
import { attributeAttention, resourceStatus } from '../src/master-status.js';
import { dispatchRefusal, finishedSessionGraceMs, ledgerRetentionMs, readReclaimReports, readResources, reclaimResources, registryGaps, resourceIds, resourceRegistry, reviewLedgerBound, type ResourceInputs } from '../src/master-resources.js';

/**
 * GY-132: Graphyard observes its own resources.
 *
 * On 23 September 2026 the review ledger sat at its 200-record cap and every review launch was
 * refused by its schema, while `master status` reported "reviewer agent … is busy in Herdr";
 * finished panes held the agent names the next launch needed and read the same way. One case per
 * proof: unit:resource-registry-complete, integration:headroom-warned-before-exhaustion,
 * integration:refusal-names-exhausted-resource, integration:resources-reclaimed-within-bound and
 * integration:health-reflects-write-capability; manual:resource-observation-docs-review reads
 * docs/master-agent.md and docs/operations-reference.md against the registry.
 */

const root = new URL('..', import.meta.url).pathname;
const iso = (ms: number) => new Date(ms).toISOString();
const reviewerProfile = { name: 'reviewer-a', agentName: 'reviewer-a', kind: 'claude', agentArgs: [], approvals: 'never', environment: {} };
const master = (url: string, overrides: Record<string, unknown> = {}) => ({
  ...masterConfigSchema.parse({ version: 1, url, credentialFile: '/nonexistent/coordinator.json', cliPath: '/nonexistent/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] }),
  reviewer: { slug: 'graphyard-reviewer', appId: 1 }, reviewers: [reviewerProfile], producers: [], ...overrides,
}) as unknown as MasterConfig;
const record = (index: number, overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
  id: randomUUID(), key: `GY-${index + 1}`, pr: index + 1, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1,
  profile: 'reviewer-a', agentName: 'reviewer-a', pane: null, sessionDirectory: '/nonexistent/session', requestedAt: iso(Date.now()), tokenExpiresAt: iso(Date.now() + 3_600_000),
  state: 'completed', closedAt: iso(Date.now()), ...overrides,
});
async function scratchRoot() {
  const directory = await mkdtemp(join(tmpdir(), 'gy-res-'));
  await mkdir(join(directory, '.graphyard'), { recursive: true, mode: 0o700 });
  return directory;
}
const blank = (overrides: Partial<ResourceInputs> = {}): ResourceInputs => ({ now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null,
  profiles: { workers: [], reviewers: [reviewerProfile], producers: [] }, ...overrides });

// ---- AC-1 --------------------------------------------------------------------------------------

test('unit:resource-registry-complete — every entry states its bound, usage, owner and reclaim, and a resource the loop consumes but the registry omits fails', async () => {
  const required = ['review-ledger', 'producer-ledger', 'agent-names', 'session-slots', 'github-budget', 'executor-liveness', 'loaded-revision', 'database-capacity', 'worktree-disk'];
  assert.deepEqual([...resourceIds].sort(), [...required].sort(), 'the registry covers at least the resources GY-132 names');
  assert.deepEqual(resourceRegistry.map(entry => entry.id).sort(), [...resourceIds].sort(), 'one entry per resource id, none twice');
  for (const entry of resourceRegistry) {
    for (const field of ['bound', 'usage', 'owner', 'reclaim', 'remedy'] as const) assert.ok(typeof entry[field] === 'string' && entry[field].trim().length > 10, `${entry.id} states its ${field}`);
    assert.equal(typeof entry.read, 'function', `${entry.id} reads its usage`);
    for (const reading of readResources(blank(), [entry])) assert.equal(reading.resource, entry.id, `${entry.id} yields its own readings`);
  }

  // What the loop consumes, derived from the code it runs: every capped ledger schema in a module
  // the executor process and the loop load, every session role, and the resources the plane and
  // the coordinator host provide it.
  const executor = await readFile(join(root, 'scripts/graphyard-executor.mjs'), 'utf8');
  const modules = [...new Set([...executor.matchAll(/tsImport\('\.\.\/(src\/[^']+\.ts)'/g)].map(match => match[1]).concat('src/master-daemon.ts'))];
  assert.ok(modules.includes('src/reviewer.ts') && modules.includes('src/producer.ts'), 'the loop loads the launchers whose ledgers it writes');
  const ledgers: string[] = [];
  for (const module of modules) {
    const source = await readFile(join(root, module), 'utf8');
    for (const match of source.matchAll(/export const (\w+LedgerSchema) = z\.object\(([^\n]*)\)/g)) if (/z\.array\([^\n]*\)\.max\(/.test(match[2])) ledgers.push(match[1]);
  }
  assert.ok(ledgers.includes('reviewLedgerSchema') && ledgers.includes('producerLedgerSchema'), `found the capped ledgers (${ledgers.join(', ')})`);
  const consumed = { ledgers, resources: ['session-slots', 'agent-names', 'github-budget', 'executor-liveness', 'loaded-revision', 'database-capacity', 'worktree-disk'] };
  assert.deepEqual(registryGaps(consumed), [], 'every resource the loop consumes is registered');
  // Every session role has a slot reading, and every launch profile a namespace reading.
  const profiles = { workers: [{ name: 'worker-a', agentName: 'worker-a', principal: 'agent-a', mode: 'launch' }], reviewers: [reviewerProfile], producers: [{ name: 'producer-a', agentName: 'producer-a' }] };
  const readings = readResources(blank({ profiles }));
  for (const role of capacityRoles) assert.ok(readings.some(reading => reading.id === `session-slots:${role}`), `session slots of the ${role} role are read`);
  for (const name of ['worker-a', 'reviewer-a', 'producer-a']) assert.ok(readings.some(reading => reading.id === `agent-names:${name}`), `the namespace of ${name} is read`);

  // The check is the test: a registry that drops a consumed resource is reported, by name.
  assert.deepEqual(registryGaps(consumed, resourceRegistry.filter(entry => entry.id !== 'review-ledger')), ['ledger reviewLedgerSchema']);
  assert.deepEqual(registryGaps(consumed, resourceRegistry.filter(entry => entry.id !== 'agent-names')), ['resource agent-names']);
  assert.deepEqual(registryGaps({ ...consumed, ledgers: [...consumed.ledgers, 'dispatchLedgerSchema'] }), ['ledger dispatchLedgerSchema'], 'a new capped ledger the registry does not name fails');
});

// ---- The plane (AC-2 and AC-5 read it) ---------------------------------------------------------

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const credential = (principal: Principal): Credential => ({ ...principal, token: `${principal.id}-${'t'.repeat(32)}` });
let database: EmbeddedPostgres, store: Store, databaseUrl: string;
before(async () => {
  const port = Number(process.env.GRAPHYARD_RESOURCE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 81);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-resources-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('resources_test');
  databaseUrl = `postgres://graphyard:testing-only@127.0.0.1:${port}/resources_test`;
  store = new Store(databaseUrl); await store.init();
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

async function plane(onto: Store, run: (url: string) => Promise<void>) {
  const engine = new Engine(onto, [15368], 120, 'owner/project');
  const http = server(engine, [credential(operator)], null, undefined, { env: {} });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(http.address() as any).port}`); }
  finally { await new Promise<void>(resolve => http.close(() => resolve())); }
}

// ---- AC-2 --------------------------------------------------------------------------------------

test('integration:headroom-warned-before-exhaustion — status reports each resource used of bound and warns at the threshold, naming the resource, before exhaustion; no symptom stands in its place', async () => {
  const directory = await scratchRoot();
  await plane(store, async url => {
    const config = master(url);
    const warnBelow = Math.ceil(reviewLedgerBound / 10);
    const status = async (count: number, agents: HerdrAgent[] = []) => {
      await saveReviewLedger(directory, { version: 1, reviews: Array.from({ length: count }, (_, index) => record(index)) });
      return resourceStatus(directory, config, { reviews: (await readReviewLedger(directory)).reviews, producers: [], agents, work: [], loop: null });
    };

    // Every registered resource is reported, as used of bound with its headroom; the plane's own
    // readings come from its /healthz.
    const below = await status(reviewLedgerBound - warnBelow);
    for (const id of resourceIds) assert.ok(below.report.readings.some(reading => reading.id === id || reading.id.startsWith(`${id}:`)), `${id} is reported`);
    const database = below.report.readings.find(reading => reading.id === 'database-capacity')!;
    assert.ok(database.used! > 0 && database.bound! > database.used!, 'the database size is read from the plane against its bound');
    const ledger = () => below.report.readings.find(reading => reading.id === 'review-ledger')!;
    assert.deepEqual({ used: ledger().used, bound: ledger().bound, headroom: ledger().headroom, state: ledger().state }, { used: reviewLedgerBound - warnBelow, bound: reviewLedgerBound, headroom: warnBelow, state: 'ok' });
    assert.ok(!below.attention.some(item => item.subject === 'resource:review-ledger'), 'at the warning line itself nothing is raised');

    // One record past the line: attention, naming the resource, its bound, its usage and its remedy — with headroom left.
    const at = await status(reviewLedgerBound - warnBelow + 1);
    const item = at.attention.find(entry => entry.subject === 'resource:review-ledger');
    assert.ok(item, 'the review ledger raises attention once its headroom falls below the threshold');
    assert.match(item!.text, new RegExp(`Review ledger is low: ${reviewLedgerBound - warnBelow + 1} records used of ${reviewLedgerBound} records, ${warnBelow - 1} records left`));
    assert.match(item!.next, /reclaim pass/, 'the item carries the remedy');
    assert.equal(at.report.readings.find(reading => reading.id === 'review-ledger')!.state, 'low', 'warned before exhaustion, not after');

    // At the bound, with the downstream symptoms the loop used to report in its place: a reviewer
    // "busy in Herdr" on a name a finished pane holds, and a stalled launch refused by the schema.
    // Each is reported as the resource, never as the symptom.
    const finished: HerdrAgent[] = [{ name: 'reviewer-a', pane_id: 'pane-9', agent_status: 'done' }];
    const full = await status(reviewLedgerBound, finished);
    const symptoms = [
      { subject: 'GY-7', text: 'GY-7\'s request-review action is stalled, not retrying: 3 attempts in a row failed for one unchanged reason — reviewer agent reviewer-a is busy in Herdr', role: 'master' as const, approvedBy: null, human: false, humanOnly: null, next: 'Clear what that reason names' },
      { subject: 'GY-8', text: `GY-8's request-review action is stalled — ${JSON.stringify([{ origin: 'array', code: 'too_big', maximum: 200, path: ['reviews'], message: 'Too big: expected array to have <=200 items' }])}`, role: 'master' as const, approvedBy: null, human: false, humanOnly: null, next: 'Clear what that reason names' },
    ];
    const reported = attributeAttention([...full.attention, ...symptoms], full.readings);
    assert.ok(reported.some(entry => entry.subject === 'resource:review-ledger' && /Review ledger is at its bound: 200 records used of 200 records/.test(entry.text)));
    assert.ok(reported.some(entry => entry.subject === 'resource:agent-names:reviewer-a' && /Herdr agent-name namespace \(reviewer-a\) is at its bound: 1 names used of 1 names/.test(entry.text)), 'the finished pane holding the name is named');
    for (const entry of reported) assert.doesNotMatch(entry.text, /busy in Herdr|Too big: expected array/, `no symptom is reported in place of the resource: ${entry.text}`);
    assert.match(reported.find(entry => entry.subject === 'GY-7')!.text, /Herdr agent-name namespace/);
    assert.match(reported.find(entry => entry.subject === 'GY-8')!.text, /Review ledger is at its bound/);
  });
});

// ---- AC-3 --------------------------------------------------------------------------------------

const requested = (id: string) => ({ id, kind: 'review' as const, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, pr: 42, provider: 'github' as const, requestedAt: iso(Date.now()), reason: 'build gate passed', state: 'requested' as const });
const reviewItem = { id: 'work-review', key: 'GY-42', stage: 'review', autoDispatch: { review: requested(randomUUID()), producers: [], history: [] } } as unknown as Work;
const reviewRow = { id: randomUUID(), work: reviewItem.id, key: reviewItem.key, kind: 'request-review', inputs: { kind: 'request-review' } } as unknown as ActionRow;

/** One claim-run-settle step of the real executor against one review row; returns the reason it recorded. */
async function refusal(effects: { agents: HerdrAgent[]; launchReview: () => Promise<unknown> }) {
  const recorded: string[] = [];
  const handlers = controlPlaneHandlers(() => master('https://graphyard.example'), {
    snapshot: async () => ({ work: [reviewItem], now: iso(Date.now()) }), mutate: async () => ({}), agents: () => effects.agents,
    workerCredentials: async () => ({}), producerCredentials: async () => ({}), dispatchWorker: async () => ({}),
    launchReview: effects.launchReview, launchProducer: async () => ({}), merge: async () => ({}), observeDeployment: async () => ({}) as any,
  });
  const step = await runExecutorTick({ id: 'executor-a', host: 'machine-a' }, { claim: async () => ({ action: reviewRow }), settle: async (_action, result, reason) => { recorded.push(`${result}: ${reason}`); }, handlers: { 'request-review': handlers['request-review'] } });
  assert.equal(step.result, 'failed');
  assert.equal(recorded.length, 1);
  return recorded[0].replace(/^failed: /, '');
}

/** The reason carried into the stalled-action entry once the row fails for it at the stall threshold. */
function stalledEntry(reason: string) {
  const at = Date.parse('2026-09-23T05:00:00.000Z');
  const item = { id: 'work-stall', key: 'GY-43', title: 'Stall', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['integration:x'] }], policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1,
    createdAt: iso(at), updatedAt: iso(at), stageEnteredAt: iso(at), ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] } as unknown as Work;
  reconcileActions(item, [item], new Date(at));
  let now = at;
  for (let failure = 0; failure < actionStallThreshold; failure++) {
    const claimed = claimAction([item], { id: 'executor-a', host: 'machine-a', principal: 'executor-a' }, new Date(now))!;
    const settled = settleAction(item, claimed.row.id, { executor: 'executor-a', principal: 'executor-a' }, 'failed', reason, new Date(now += 1000));
    now = Date.parse(settled.action.retryAt!);
  }
  const entries = stalledActionAttention({ work: [item], now: iso(now) });
  assert.equal(entries.length, 1, 'the row is classified stalled');
  return entries[0].text;
}

test('integration:refusal-names-exhausted-resource — an exhausted agent-name namespace and a full review ledger are each named in the recorded refusal and the stalled-action entry, not as reviewer capacity', async () => {
  // The namespace: a finished pane still holds the only name the reviewer profile may take.
  const named = await refusal({ agents: [{ name: 'reviewer-a', pane_id: 'pane-3', agent_status: 'done' }], launchReview: async () => { throw new Error('unreachable: the launch is refused before the runtime is asked'); } });
  assert.match(named, /^Herdr agent-name namespace \(reviewer-a\) is at its bound: 1 names used of 1 names, 0 names left — reviewer profile reviewer-a: reviewer-a \(done/);
  assert.doesNotMatch(named, /busy|capacity|concurrency/i, 'the refusal is not read as reviewer capacity');
  const namedStall = stalledEntry(named);
  assert.match(namedStall, /stalled, not retrying: \d+ attempts in a row failed for one unchanged reason — Herdr agent-name namespace \(reviewer-a\) is at its bound: 1 names used of 1 names/);

  // The review ledger: the launch reaches the ledger write, which its own cap refuses.
  const directory = await scratchRoot();
  await saveReviewLedger(directory, { version: 1, reviews: Array.from({ length: reviewLedgerBound }, (_, index) => record(index)) });
  const full = await refusal({ agents: [], launchReview: async () => { const ledger = await readReviewLedger(directory); await saveReviewLedger(directory, { ...ledger, reviews: [...ledger.reviews, record(reviewLedgerBound, { state: 'pending' })] }); } });
  assert.match(full, new RegExp(`^Review ledger is at its bound: ${reviewLedgerBound} records used of ${reviewLedgerBound} records, 0 records left — a write of a further record was refused by reviewLedgerSchema`));
  assert.doesNotMatch(full, /busy|capacity|concurrency|Too big/i, 'the refusal names the ledger, not the schema error or a busy reviewer');
  assert.match(stalledEntry(full), /unchanged reason — Review ledger is at its bound: 200 records used of 200 records/);
  assert.equal((await readReviewLedger(directory)).reviews.length, reviewLedgerBound, 'nothing was written past the bound');
});

// ---- AC-4 --------------------------------------------------------------------------------------

test('integration:resources-reclaimed-within-bound — a finished session and a terminal ledger record are reclaimed and recorded within the documented bound', async () => {
  const directory = await scratchRoot();
  const settled = Date.parse('2026-09-23T05:00:00.000Z');
  const liveRequest = randomUUID();
  const terminal = record(0, { agentName: 'reviewer-a', state: 'completed', requestedAt: iso(settled - 600_000), closedAt: iso(settled) });
  const answersLive = record(1, { agentName: 'reviewer-a', state: 'failed', requestId: liveRequest, requestedAt: iso(settled - 600_000), closedAt: iso(settled) });
  const stuck = record(2, { profile: 'reviewer-b', agentName: 'reviewer-b', state: 'pending', requestId: randomUUID(), requestedAt: iso(settled - 30 * 60_000), idleSince: iso(settled - 20 * 60_000) });
  await saveReviewLedger(directory, { version: 1, reviews: [terminal, answersLive, stuck] });
  const config = { reviewers: [reviewerProfile, { ...reviewerProfile, name: 'reviewer-b', agentName: 'reviewer-b' }], producers: [] };
  const agents: HerdrAgent[] = [{ name: 'reviewer-a', pane_id: 'pane-1', agent_status: 'done' }, { name: 'reviewer-b', pane_id: 'pane-2', agent_status: 'blocked' }];
  // The live request keeps the record the relaunch rule counts.
  const work = [{ id: 'w', key: 'GY-5', stage: 'review', autoDispatch: { review: requested(liveRequest), producers: [], history: [] } } as unknown as Work];
  const closed: string[] = [];

  // First pass: the consent-blocked session is past its bound, so its record is failed, its slot
  // released and its pane closed at once. The finished pane is only noted: a pane launched a moment
  // ago holds its name before its record is written, so nothing is closed on a single sighting.
  const t0 = settled + 2 * finishedSessionGraceMs;
  const first = await reclaimResources(directory, config, { work, agents }, { now: t0, closePane: pane => { closed.push(pane); } });
  assert.deepEqual(first.released.map(entry => entry.name), ['reviewer-b'], 'the session blocked on a prompt past its bound releases its slot');
  assert.match(first.released[0].reason, /blocked on a prompt in Herdr for over 10 minutes/);
  assert.deepEqual(first.closed.map(entry => entry.name), ['reviewer-b']);
  assert.deepEqual(first.reaped, { review: 0, producer: 0 }, 'a terminal record is kept until its retention elapses');

  // One grace later the finished session, still unowned, is closed and its name released.
  const second = await reclaimResources(directory, config, { work, agents: agents.slice(0, 1) }, { now: t0 + finishedSessionGraceMs, closePane: pane => { closed.push(pane); } });
  assert.deepEqual(second.closed.map(entry => [entry.name, entry.pane]), [['reviewer-a', 'pane-1']]);
  assert.match(second.closed[0].reason, /its review session failed/);
  assert.ok(t0 + finishedSessionGraceMs < settled + ledgerRetentionMs, 'the session is reclaimed well inside the ledger bound');

  // At the documented ledger bound the terminal record is reaped; the live one is kept.
  const bound = await reclaimResources(directory, config, { work, agents: [] }, { now: settled + ledgerRetentionMs, closePane: pane => { closed.push(pane); } });
  assert.deepEqual(bound.reaped, { review: 1, producer: 0 }, 'the terminal record is reaped once its retention elapses');
  const remaining = (await readReviewLedger(directory)).reviews;
  assert.deepEqual(remaining.map(entry => [entry.id, entry.state]), [[answersLive.id, 'failed'], [stuck.id, 'failed']], 'a record answering a live request is kept, and the released one waits out its own retention');
  assert.deepEqual(closed, ['pane-2', 'pane-1']);

  // The pass records what it reclaimed.
  const reports = await readReclaimReports(directory);
  assert.deepEqual(reports.map(report => report.at), [iso(t0), iso(t0 + finishedSessionGraceMs), iso(settled + ledgerRetentionMs)]);
  assert.deepEqual(reports.map(report => report.closed.map(entry => entry.pane)), [['pane-2'], ['pane-1'], []]);
  assert.equal(reports[2].reaped.review, 1);

  // The loop runs the pass every cycle and records what it took back.
  const state = emptyDaemonState(master('https://graphyard.example'));
  await runCycle(master('https://graphyard.example'), state, { ...loopEffects([]), reclaimResources: async () => bound } as DaemonEffects, () => Date.parse(iso(settled)));
  const recorded = Object.values(state.actions).find(action => action.kind === 'reclaim');
  assert.match(recorded!.detail, /^Resource reclaim: reaped 1 review and 0 producer ledger record\(s\)/);
});

// ---- AC-5 --------------------------------------------------------------------------------------

function loopEffects(log: string[], overrides: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: iso(Date.now()) }), closeSession: () => {}, dispatch: async item => { log.push(`dispatch:${item.key}`); },
    requestProof: () => {}, merge: async () => ({ result: 'merge requested' }), recordDeployment: async () => {}, requestSmoke: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(Date.now()), reason: 'not configured', deployed: [], pending: [] }) as any,
    persist: async () => {}, ...overrides,
  } as DaemonEffects;
}

test('integration:health-reflects-write-capability — /healthz is unhealthy naming the cause while writes are refused or a resource is exhausted, and the loop dispatches nothing', async () => {
  await plane(store, async url => {
    const response = await fetch(`${url}/healthz`);
    const health = await response.json() as any;
    assert.equal(response.status, 200);
    assert.deepEqual({ ok: health.ok, healthy: health.healthy, writable: health.writable, causes: health.causes }, { ok: true, healthy: true, writable: true, causes: [] });
    assert.equal(await dispatchRefusal(url), null, 'a healthy plane is dispatched into');

    // A resource the plane owns at its bound fails health, naming it.
    const previous = process.env.GRAPHYARD_DATABASE_MAX_BYTES;
    process.env.GRAPHYARD_DATABASE_MAX_BYTES = '1024';
    try {
      const exhausted = await fetch(`${url}/healthz`);
      const body = await exhausted.json() as any;
      assert.equal(exhausted.status, 503);
      assert.equal(body.healthy, false); assert.equal(body.writable, true);
      assert.match(body.causes[0], /^Control-plane database is at its bound: \d+ of 1024 bytes/);
    } finally { if (previous === undefined) delete process.env.GRAPHYARD_DATABASE_MAX_BYTES; else process.env.GRAPHYARD_DATABASE_MAX_BYTES = previous; }
  });

  // Refuse writes: every new session of the plane's database is read-only.
  await store.pool.query('ALTER DATABASE resources_test SET default_transaction_read_only = on');
  const readOnly = new Store(databaseUrl);
  try {
    await plane(readOnly, async url => {
      const response = await fetch(`${url}/healthz`);
      const health = await response.json() as any;
      assert.equal(response.status, 503, 'the plane fails its own health check');
      assert.equal(health.healthy, false); assert.equal(health.ok, false); assert.equal(health.writable, false);
      assert.match(health.causes[0], /^Writes are refused: cannot execute UPDATE in a read-only transaction/);
      assert.ok(health.commit !== undefined && health.schema, 'health still names the build it serves');

      // The loop reads that verdict and dispatches nothing into a plane that cannot record it.
      const reason = await dispatchRefusal(url);
      assert.match(reason!, /control plane reports itself unhealthy \(Writes are refused: cannot execute UPDATE in a read-only transaction\)/);
      const worker = { name: 'worker-a', principal: 'agent-a', agentName: 'agent-worker-a', mode: 'launch', kind: 'codex', credentialFile: '/nonexistent', agentArgs: [], environment: {} } as unknown as WorkerProfile;
      const config = master(url, { workers: [worker] });
      const at = Date.now();
      const ready = { id: 'work-ready', key: 'GY-44', title: 'Ready', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
        policy: { checks: ['test'], review: true }, plannedFiles: ['src/ready.ts'], stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(at), updatedAt: iso(at), stageEnteredAt: iso(at), ready: true, epoch: 0,
        lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
        gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] } as unknown as Work;
      const log: string[] = [];
      const snapshot = async () => ({ work: [ready], now: iso(at) });
      // Healthy, the same cycle would dispatch the item: the refusal is what holds it.
      await runCycle(config, emptyDaemonState(config), loopEffects(log, { snapshot, planeHealth: async () => null }));
      assert.deepEqual(log, ['dispatch:GY-44']);
      log.length = 0;
      const state = emptyDaemonState(config);
      await runCycle(config, state, loopEffects(log, { snapshot, planeHealth: () => dispatchRefusal(url) }));
      assert.deepEqual(log, [], 'no dispatch is attempted');
      assert.match(state.actions['escalation:dispatch:plane'].detail, /^Dispatch held: the control plane reports itself unhealthy \(Writes are refused: cannot execute UPDATE in a read-only transaction\)/);
    });
  } finally {
    await readOnly.close();
    await store.pool.query('ALTER DATABASE resources_test RESET default_transaction_read_only');
  }
});
