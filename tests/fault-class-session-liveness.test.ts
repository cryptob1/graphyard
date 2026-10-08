import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWork } from '../src/cli/context.js';
import { acknowledgeContainment, establishContainment } from '../src/quarantine.js';
import { restartTolerantApi, supervise, throughRestart, transientControlPlaneFailure } from '../src/supervisor.js';
import { checkInvariants, emptyInvariantRecord } from '../src/model/invariants.js';
import type { Work } from '../src/model.js';

// GY-1506 names this file for its proof: manual:fault-class-session-liveness. The master loop
// filed 5 session-liveness faults in 24 hours; the host journal names the two shapes they share.
//
// GY-1493 and GY-1505 (and with them invariant:deploy-lease-loss): both workers were dispatched at
// 01:20Z while the control plane restarted for the deploy of #969/#973. GY-1493's watch printed
// "could not confirm containment quarantine establishment after 3 attempts: Startup validation has
// not completed; retry shortly" (three tries 100 ms apart), GY-1505's printed "terminated" (fetch's
// dropped connection, and the item lookup, status read and first renewal were never retried). The
// worker never launched, nothing renewed the claim, and both leases lapsed as losses within the
// deploy window. The candidate rides every launch call out through a restart window.
//
// GY-1410 and GY-1420: the agent process ended on its own two minutes into the attempt (its pane
// vanished), and the supervisor stopped without releasing — only an orphaned session it noticed
// first was ever surrendered — so the lease ran out and was escalated as lost. The candidate
// releases the lease with the cause whenever the agent ends before its lease does.
//
// The base reproduction of the restart shapes runs the same launch with the base's behaviour (no
// retry window: the bare call and a zero startup window). The proof producer also runs this file at
// the base commit, where the release on exit and the restart window do not exist.

const DOWN_MS = 300, WINDOW_MS = 3_000, LEASE_MS = 1_200;
const retry = { retryMs: 10, retryMaxMs: 40 };
const settlementHash = 'a'.repeat(64);

/** A control plane restarting for a deploy: every call until `downMs` passes fails the way the instance's did. */
function restartingControlPlane(failure: () => Error, downMs = DOWN_MS) {
  const upAt = performance.now() + downMs;
  const calls: string[] = [];
  const api = async (path: string, data?: unknown, requestId?: string): Promise<any> => {
    calls.push(`${path}${requestId ? `#${requestId}` : ''}`);
    if (performance.now() < upAt) throw failure();
    const now = new Date(), updatedAt = now.toISOString(), expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
    if (path === 'work/GY-1') return { id: 'work-1', key: 'GY-1', workspaces: [] };
    if (path === 'status') return { actor: { id: 'worker-1', role: 'worker' } };
    if (path.endsWith('/quarantine')) return { containmentQuarantine: { epoch: 1, settlementHash }, exclusiveResources: [] };
    if (path.endsWith('/launch')) return { updatedAt, lease: { owner: 'worker-1', epoch: 1, expiresAt }, exclusiveResources: [],
      containmentQuarantine: { epoch: 1, settlementHash, launchAcknowledgedAt: updatedAt, launchExpiresAt: expiresAt } };
    if (path.endsWith('/heartbeat')) return { updatedAt, lease: { epoch: 1, expiresAt } };
    throw new Error(`unexpected call ${path} ${JSON.stringify(data)}`);
  };
  return { api, calls };
}
/** The server's own 503 while startup validation runs, as the CLI's api throws it (GY-1493's watch). */
const startupValidation = () => Object.assign(new Error(JSON.stringify({ error: 'Startup validation has not completed; retry shortly', retryable: true })), { status: 503, confirmedRefusal: false });
/** fetch's TypeError for a connection the restarting server dropped mid-response (GY-1505's watch). */
const terminated = () => new TypeError('terminated');

/**
 * One worker launch as `watch` does it: the item lookup, the status read, the quarantine and its
 * launch acknowledgement, then the supervisor's first renewal and the agent. `tolerant` is the
 * candidate (every call through the restart window); without it, the base's calls. Returns how the
 * attempt's lease ended: 'lost' when nothing renewed or released it.
 */
async function launch(failure: () => Error, tolerant: boolean, agent = 'setTimeout(() => {}, 60)') {
  const plane = restartingControlPlane(failure);
  const until = performance.now() + (tolerant ? WINDOW_MS : 0);
  const api = tolerant ? restartTolerantApi(plane.api, () => until, retry) : plane.api;
  const released: string[] = [];
  try {
    await resolveWork(api, 'GY-1');
    await api('status');
    await establishContainment(requestId => api('work/work-1/quarantine', { epoch: 1, settlementHash }, requestId),
      { epoch: 1, settlementHash, exclusiveResources: [], requestId: 'quarantine-1' }, { retryMs: 100 });
    await acknowledgeContainment(requestId => api('work/work-1/launch', { epoch: 1, settlementHash }, requestId),
      { principal: 'worker-1', epoch: 1, settlementHash, exclusiveResources: [], requestId: 'launch-1' }, { retryMs: 100 });
    await supervise(process.execPath, ['-e', agent], 1, () => plane.api('work/work-1/heartbeat', { epoch: 1 }), {
      intervalMs: 20, graceMs: 25, ...retry, startupWindowMs: tolerant ? WINDOW_MS : 0,
      session: { visible: () => null, unconsented: () => null, surrender: async cause => { released.push(cause); } },
    });
  } catch (error) {
    return { lease: 'lost' as const, error: error instanceof Error ? error.message : String(error), calls: plane.calls, released };
  }
  return { lease: released.length ? 'released' as const : 'lost' as const, error: null, calls: plane.calls, released };
}

test('integration:fault-class-session-liveness GY-1493 — a launch during a deploy\'s startup validation lapsed its lease at the base and launches at the candidate', async () => {
  const base = await launch(startupValidation, false);
  assert.equal(base.lease, 'lost');
  assert.match(base.error!, /Startup validation has not completed; retry shortly/, 'the base gave up on the restarting server inside its restart');

  const candidate = await launch(startupValidation, true);
  assert.equal(candidate.error, null, `the launch rides out the restart: ${candidate.error}`);
  assert.equal(candidate.lease, 'released', 'the worker launched, ran and gave its lease back');
  // The quarantine and launch keep one idempotency key across their retries, so a mutation the
  // server applied before the connection dropped is never applied twice.
  for (const path of ['work/work-1/quarantine', 'work/work-1/launch']) {
    const keys = new Set(candidate.calls.filter(call => call.startsWith(`${path}#`)));
    assert.ok(keys.size >= 1 && keys.size <= 3, `${path} kept its own request ids: ${[...keys].join(', ')}`);
  }
});

test('integration:fault-class-session-liveness GY-1505 — a launch whose connections the restarting server dropped lapsed its lease at the base and launches at the candidate', async () => {
  const base = await launch(terminated, false);
  assert.equal(base.lease, 'lost');
  assert.equal(base.error, 'terminated', 'the base\'s item lookup was never retried');

  const candidate = await launch(terminated, true);
  assert.equal(candidate.error, null, `the launch rides out the restart: ${candidate.error}`);
  assert.equal(candidate.lease, 'released');

  // The supervisor's own first renewal, which nothing retried at the base, rides out the restart too.
  const plane = restartingControlPlane(terminated);
  const code = await supervise(process.execPath, ['-e', 'setTimeout(() => {}, 30)'], 1, () => plane.api('work/work-1/heartbeat', { epoch: 1 }), {
    intervalMs: 20, graceMs: 25, ...retry, startupWindowMs: WINDOW_MS, session: { visible: () => null, unconsented: () => null, surrender: async () => {} },
  });
  assert.equal(code, 0, 'the agent launched after the first renewal outlasted the restart');
  assert.ok(plane.calls.length > 1, 'the first renewal was retried');
});

test('integration:fault-class-session-liveness GY-1410 and GY-1420 — an agent that ends on its own releases its lease with the cause rather than leaving it to lapse', async () => {
  // GY-1410: the agent exits by itself while the lease is live.
  const exited = await launch(startupValidation, true, 'process.exit(0)');
  assert.equal(exited.lease, 'released', 'the lease is released, not left to lapse into a lease loss');
  assert.match(exited.released[0], /the agent process exited \(code 0\) while its lease was live/);
  assert.equal(exited.released.length, 1, 'released once');

  // GY-1420: the agent's runtime dies (its pane vanishes) — killed, not exited.
  const killed = await launch(terminated, true, "process.kill(process.pid, 'SIGKILL')");
  assert.equal(killed.lease, 'released');
  assert.match(killed.released[0], /the agent process exited \(SIGKILL\) while its lease was live/);

  // A supervisor that stops on the server's refusal (a `complete` ended the lease) releases nothing.
  let renewals = 0;
  const released: string[] = [];
  const refusal = Object.assign(new Error('lease ended when GY-1 was submitted'), { status: 409, confirmedRefusal: true });
  await supervise(process.execPath, ['-e', 'setInterval(() => {}, 20)'], 1,
    async () => { if (++renewals > 2) throw refusal; return { updatedAt: new Date().toISOString(), lease: { epoch: 1, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() } }; },
    { intervalMs: 20, graceMs: 25, ...retry, session: { visible: () => null, unconsented: () => null, surrender: async cause => { released.push(cause); } } });
  assert.deepEqual(released, [], 'a lease the server already ended is not released again');
});

test('unit:fault-class-session-liveness the restart window retries only what a restart explains, keeps a refusal final, and closes on time', async () => {
  for (const error of [startupValidation(), terminated(), new TypeError('fetch failed'), Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    new SyntaxError('Unexpected token < in JSON'), Object.assign(new Error('{"status":"error","code":502}'), { status: 502 })])
    assert.equal(transientControlPlaneFailure(error), true, `${error.message} is a restart`);
  for (const error of [Object.assign(new Error('lease refused'), { status: 409 }), Object.assign(new Error('{"error":"Unknown work item"}'), { status: 404, confirmedRefusal: true }),
    Object.assign(new Error('Invalid lease renewal'), { definite: true }), new Error('Run watch from the assigned workspace on its registered host')])
    assert.equal(transientControlPlaneFailure(error), false, `${error.message} is final`);

  let calls = 0;
  await assert.rejects(throughRestart(async () => { calls++; throw Object.assign(new Error('lease refused'), { status: 409 }); }, performance.now() + WINDOW_MS, retry), /lease refused/);
  assert.equal(calls, 1, 'a refusal is never retried');
  const started = performance.now();
  await assert.rejects(throughRestart(async () => { throw terminated(); }, started + 150, retry), /terminated/);
  assert.ok(performance.now() - started < 1_000, 'a restart longer than the window ends the retries at the window');
});

test('integration:fault-class-session-liveness invariant:deploy-lease-loss — the leases a deploy lost at the base violate the invariant; the candidate\'s launches lose none', async () => {
  const minute = 60_000, deployedAt = Date.parse('2026-10-08T01:21:00Z');
  const lossesOf = async (tolerant: boolean) => {
    const work: Work[] = [];
    for (const [key, failure] of [['GY-1493', startupValidation], ['GY-1505', terminated]] as const) {
      const { lease } = await launch(failure, tolerant);
      const at = new Date(deployedAt + 2 * minute).toISOString();
      if (lease === 'lost') work.push({ id: `work-${key}`, key, title: key, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [], plannedFiles: [],
        stage: 'build', ready: true, createdAt: at, updatedAt: at, stageEnteredAt: at, epoch: 1, lease: null, workspaces: [], candidate: null, submission: null,
        observation: null, blocker: null, gates: [], violations: [], evidence: [],
        escalations: [{ trigger: 'lease-loss', reason: 'Worker w lost lease epoch 1', at, actor: 'graphyard' }] } as unknown as Work);
    }
    const record = emptyInvariantRecord();
    checkInvariants(record, { work: [], now: deployedAt - minute, build: 'build-before' });
    const checks = checkInvariants(record, { work, now: deployedAt + 3 * minute, build: 'build-after' });
    return checks.find(check => check.invariant === 'deploy-lease-loss')!;
  };
  const base = await lossesOf(false);
  assert.equal(base.holds, false, base.line);
  assert.deepEqual(base.subjects, ['GY-1493', 'GY-1505']);
  const candidate = await lossesOf(true);
  assert.equal(candidate.holds, true, candidate.line);
});
