import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWork } from '../src/cli/context.js';
import { acknowledgeContainment, establishContainment } from '../src/quarantine.js';
import { restartTolerantApi, supervise, throughRestart, transientControlPlaneFailure } from '../src/supervisor.js';
import { checkInvariants, emptyInvariantRecord } from '../src/model/invariants.js';
import type { Work } from '../src/model.js';
import type { SessionHandle } from '../src/model/sessions.js';
import { awaitRuntimeStart, buildMasterStatus, SessionStartError, type WorkerProfile } from '../src/master.js';
// A namespace import, so the proof producer's run of this file at the base, which has no screenDialog,
// fails only the case that reads it.
import * as consent from '../src/consent-prompt.js';
const { detectConsentPrompt } = consent;
const screenDialog = (screen: string) => consent.screenDialog?.(screen);
import { trackFaults, type FaultRecord } from '../src/model/fault-classes.js';
// A namespace import, so the base run of this file, which has no unclaimedLaunch, fails only the GY-1571 case.
import * as sessionState from '../src/model/session-state.js';
const { observeSessions, reportedHandle, sessionLaunchGraceMs } = sessionState;
const unclaimedLaunch = (...args: Parameters<typeof sessionState.unclaimedLaunch>) => sessionState.unclaimedLaunch?.(...args) ?? false;
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureWork } from '../scripts/dashboard-fixture.mjs';
import { live } from '../browser-tests/ui-board.js';

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

// GY-1561 names this file for its proof too: the loop filed 3 session-liveness faults in 24 hours, all
// on GY-1525, and all one incident. Epochs 14 and 16 of GY-1525 launched into a dialog Herdr reported
// blocked; the pane last showed "Enter to confirm · Esc to cancel", and the launch was refused naming
// Herdr's state rather than the dialog (the action:dispatch instance, 22:32:24Z). Each launch ended its
// session record "the launch failed before the session started" with no pane, and for the minute its
// attempt's lease outlived that record master status raised "Assigned worker session is ended" — the
// two session instances (22:31:07Z for epoch 14, 22:34:54Z for epoch 16) counting the same failed
// launches again. The dialog is Claude Code 2.1.292's folder-trust dialog as it draws today (captured
// from the runtime in a tmux pane, below at two widths): it asks "Is this a project you created or one
// you trust?", which no consent kind read as a trust question, and at 60 columns that question wraps
// above the five lines read for it. At the base, detectConsentPrompt reads neither as a prompt and the
// launch is refused as "Herdr reports it blocked"; the candidate names it a workspace-trust prompt,
// names any other unrecognised dialog by its text, and counts the failed launch only as its dispatch's.

/** Claude Code 2.1.292's folder-trust dialog in a pane `width` columns wide, as the runtime drew it. */
const folderTrust = (width: 60 | 100) => (width === 60 ? [
  '────────────────────────────────────────────────────────────',
  ' Accessing workspace:', '',
  ' /home/vish/code/graphyard/.graphyard/worktrees/GY-1525-14', '',
  ' Quick safety check: Is this a project you created or one',
  ' you trust? (Like your own code, a well-known open source',
  ' project, or work from your team). If not, take a moment to',
  " review what's in this folder first.", '',
  " Claude Code'll be able to read, edit, and execute files",
  ' here.', '',
  ' Security guide', '',
  ' ❯ No, exit',
  '   Yes, I trust this folder', '',
  ' Enter to confirm · Esc to cancel', '',
] : [
  '────────────────────────────────────────────────────────────────────────────────────────────────────',
  ' Accessing workspace:', '',
  ' /home/vish/code/graphyard/.graphyard/worktrees/GY-1525-14', '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a',
  " well-known open source project, or work from your team). If not, take a moment to review what's in",
  ' this folder first.', '',
  " Claude Code'll be able to read, edit, and execute files here.", '',
  ' Security guide', '',
  ' ❯ No, exit',
  '   Yes, I trust this folder', '',
  ' Enter to confirm · Esc to cancel', '',
]).join('\n');

/** A Herdr pane on a virtual clock whose claude runtime shows `screen` and reports `status`. */
function blockedPane(screen: string, status = 'blocked') {
  let now = Date.parse('2026-10-08T22:30:17.082Z');
  const sent: string[][] = [];
  const run = (_command: string, args: string[]) => {
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'send-keys') sent.push(args);
    if (args[0] === 'pane' && args[1] === 'read') return screen;
    if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: 'claude', agent_status: status, pane_id: args[2] } });
    return json({});
  };
  return { run, sent, bounds: { clock: () => now, wait: (ms: number) => { now += ms; } } };
}

test('unit:fault-class-session-liveness GY-1525 action:dispatch — a launch blocked on Claude Code\'s folder-trust dialog is refused naming it, never as only "Herdr reports it blocked"', async () => {
  for (const width of [60, 100] as const) {
    const screen = folderTrust(width);
    const prompt = detectConsentPrompt(screen);
    assert.equal(prompt?.kind, 'folder', `${width} columns: the dialog is a workspace-trust prompt (the base read no prompt here)`);
    assert.equal(prompt?.rule, null, 'and no rule answers it: trusting a folder is never the launcher\'s answer');
    assert.match(prompt!.text, /Yes, I trust this folder/);
    const pane = blockedPane(screen);
    await assert.rejects(awaitRuntimeStart('w1V:pMHS', 'claude', 'GY=/w/t; claude', pane.run, pane.bounds),
      (error: unknown) => error instanceof SessionStartError && error.startCase === 'awaiting consent' && /workspace-trust prompt/.test(error.message)
        && /Yes, I trust this folder/.test(error.message) && !/Herdr reports it blocked/.test(error.message), `${width} columns`);
    assert.deepEqual(pane.sent, [], 'no key is sent into the dialog');
  }
});

test('unit:fault-class-session-liveness — any other dialog a launch is blocked on is named by what it asks, not by its key hint', async () => {
  const other = [' Use the new default model for this account?', '', ' ❯ 1. Yes, switch', '   2. No, keep the current model', '', ' Enter to confirm · Esc to cancel'].join('\n');
  assert.equal(detectConsentPrompt(other), null, 'not a consent kind the launcher knows');
  assert.equal(screenDialog(other), 'Use the new default model for this account? / ❯ 1. Yes, switch / 2. No, keep the current model');
  const pane = blockedPane(other);
  await assert.rejects(awaitRuntimeStart('w1V:pMHV', 'claude', 'GY=/w/t; claude', pane.run, pane.bounds),
    (error: unknown) => error instanceof SessionStartError && error.startCase === 'blocked'
      && error.message.includes('Herdr reports it blocked on a dialog the launcher does not recognise: "Use the new default model for this account? / ❯ 1. Yes, switch / 2. No, keep the current model"'));
  assert.equal(screenDialog('● Done.\n❯ \n'), null, 'a screen not ending on a menu names no dialog');
});

test('unit:fault-class-session-liveness GY-1525 session — a launch that failed before its session started is its dispatch\'s one fault, not also an ended session while its lease runs out', () => {
  const NOW = Date.parse('2026-10-08T22:31:07.080Z'), at = (ms: number) => new Date(NOW + ms).toISOString();
  const worker = { name: 'claude-primary', principal: 'graphyard-claude-1', agentName: 'graphyard-claude-1', mode: 'launch', kind: 'claude', credentialFile: '/outside/c1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const item = (fixtureWork() as unknown as Work[]).map(live)[0];
  const session = (fields: Partial<SessionHandle>): SessionHandle => ({ id: 'graphyard-claude-1:14', kind: 'implementation', principal: 'graphyard-claude-1', epoch: null, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null,
    pane: null, agentName: 'graphyard-claude-1', role: null, head: null, attach: null, transcript: null, subject: 'GY-1525', startedAt: at(-50_000), updatedAt: at(-28_000), endedAt: at(-28_000), state: 'finished', outcome: null, ...fields } as SessionHandle);
  const held = (handle: SessionHandle): Work => ({ ...item, key: 'GY-1525', stage: 'build', lease: { owner: 'graphyard-claude-1', epoch: 14, expiresAt: at(90_000) }, sessions: [handle] } as Work);
  const status = (handle: SessionHandle) => buildMasterStatus({ work: [held(handle)], now: at(0) }, [worker], []);
  const failed = session({ outcome: 'the launch failed before the session started: the claude runtime is blocked before it is ready in pane w1V:pMHS (Herdr reports it blocked); the pane last showed: "Enter to confirm · Esc to cancel"' });

  const report = status(failed);
  assert.doesNotMatch(report.work[0].attention ?? '', /Assigned worker session/, 'the base raised "Assigned worker session is ended" here');
  assert.ok(!report.attentionItems.some(entry => entry.kind === 'session'), 'no session fault for the failed launch');

  // The loop's record across the incident: the launch fails (its dispatch action fails: one instance)
  // while the epoch's lease still runs, for two cycles. The base recorded the session line as a second
  // instance; the candidate records only the dispatch's.
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  for (const offset of [0, 60_000]) trackFaults(record, status(failed).attentionItems.map(entry => ({ kind: entry.kind!, faultClass: entry.faultClass!, subject: entry.subject, text: entry.text })), at(offset));
  assert.equal(record.instances.filter(entry => entry.faultClass === 'session-liveness').length, 0);

  // A session that did start and then ended under a live lease is still the fault it was.
  const started = status(session({ pane: 'w1V:pMHS', observed: 'ended', observedAt: at(-28_000), outcome: 'the agent process exited (code 0) while its lease was live' }));
  assert.equal(started.work[0].attention, 'Assigned worker session is ended');
  assert.ok(started.attentionItems.some(entry => entry.kind === 'session' && entry.faultClass === 'session-liveness'));
});

// GY-1571 names this file for its proof too: 3 session-liveness faults in 24 hours on 9 October 2026,
// all "Assigned worker session is ended", on GY-1528 (01:29:00Z), GY-1566 (03:24:22Z) and GY-1565
// (05:17:47Z). Each item's ledger shows one shape: the worker launcher registered its handle
// PRINCIPAL:EPOCH for the next epoch, then claimed; between the two the loop's session report read a
// snapshot whose item held no lease and ended the fresh handle at once ("attempt N of GY-… ended
// (released, blocked, parked or lapsed) and GY-… holds no lease"), launch grace or not. The claim then
// landed and the next fault observation read the live lease's handle as ended. Every one of those
// launches went on to start its runtime and submit. The candidate leaves a handle registered for an
// epoch the item has not claimed alone through the launch grace, as it does any unobserved launch.

/** Each instance as its item's ledger records it: handle registered, report (on the pre-claim snapshot), claim, fault observation. */
const unclaimedInstances = [
  { key: 'GY-1528', principal: 'graphyard-claude-1', epoch: 13, registered: '2026-10-09T01:28:24.129Z', report: '2026-10-09T01:28:29.526Z', claimed: '2026-10-09T01:28:29.908Z', fault: '2026-10-09T01:29:00.532Z' },
  { key: 'GY-1566', principal: 'graphyard-claude-2', epoch: 1, registered: '2026-10-09T03:24:07.422Z', report: '2026-10-09T03:24:11.270Z', claimed: '2026-10-09T03:24:10.621Z', fault: '2026-10-09T03:24:22.392Z' },
  { key: 'GY-1565', principal: 'graphyard-claude-2', epoch: 5, registered: '2026-10-09T05:17:38.148Z', report: '2026-10-09T05:17:43.039Z', claimed: '2026-10-09T05:17:41.479Z', fault: '2026-10-09T05:17:47.698Z' },
];

test('unit:fault-class-session-liveness GY-1528, GY-1566 and GY-1565 session — a worker handle registered before its claim is not ended by a report on the pre-claim snapshot, so the claimed lease never reads it as ended', () => {
  const base = (fixtureWork() as unknown as Work[]).map(live)[0];
  for (const instance of unclaimedInstances) {
    const worker = { name: instance.principal, principal: instance.principal, agentName: instance.principal, mode: 'launch', kind: 'claude', credentialFile: '/outside/c.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
    const handle = { id: `${instance.principal}:${instance.epoch}`, kind: 'implementation', principal: instance.principal, epoch: null, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null,
      pane: null, agentName: null, role: null, head: null, attach: null, transcript: null, subject: instance.key, startedAt: instance.registered, updatedAt: instance.registered, endedAt: null, state: 'running', outcome: null } as unknown as SessionHandle;
    const item = (epoch: number, lease: Work['lease'], sessions: SessionHandle[]) => ({ ...base, id: `work-${instance.key}`, key: instance.key, stage: 'build', epoch, lease, sessions, pipeline: { attempts: [] } } as unknown as Work);
    // The snapshot the report read: the attempt before the claim, holding no lease.
    const before = item(instance.epoch - 1, null, [handle]);
    const report = observeSessions([before], [], new Date(instance.report), { hostId: 'vishrog' });
    assert.ok(!report.entries.some(entry => entry.closed), `${instance.key}: the base ended ${handle.id} here as "attempt ${instance.epoch} … holds no lease"`);
    assert.equal(unclaimedLaunch(before, handle), true);

    // The claim lands, and the fault step reads the attempt's live lease.
    const entry = report.entries.find(row => row.id === handle.id);
    const written = entry ? { ...handle, ...reportedHandle(entry), endedAt: entry.closed ? instance.report : null } as SessionHandle : handle;
    const claimed = item(instance.epoch, { owner: instance.principal, epoch: instance.epoch, expiresAt: new Date(Date.parse(instance.claimed) + 120_000).toISOString() }, [written]);
    const status = buildMasterStatus({ work: [claimed], now: instance.fault }, [worker], []);
    assert.doesNotMatch(status.work[0].attention ?? '', /Assigned worker session/, `${instance.key}: the base raised "Assigned worker session is ended" at ${instance.fault}`);
    const record: FaultRecord = { instances: [], open: {}, failing: {} };
    trackFaults(record, status.attentionItems.map(item => ({ kind: item.kind!, faultClass: item.faultClass!, subject: item.subject, text: item.text })), instance.fault);
    assert.equal(record.instances.filter(fault => fault.faultClass === 'session-liveness').length, 0, `${instance.key}: no session-liveness instance`);

    // Once claimed the lease holds the handle; a registration whose claim never comes is still ended past the launch grace.
    assert.deepEqual(observeSessions([claimed], [], new Date(instance.fault), { hostId: 'vishrog' }).entries, []);
    const abandoned = observeSessions([before], [], new Date(Date.parse(instance.registered) + sessionLaunchGraceMs), { hostId: 'vishrog' }).entries[0];
    assert.equal(abandoned?.closed, 'ended', `${instance.key}: an unclaimed registration past the grace is over`);
  }
  // Only a later epoch than the item's is unclaimed: the attempt the item is on, or one before it, is not.
  const handle = { id: 'graphyard-claude-1:4', kind: 'implementation', epoch: null } as unknown as SessionHandle;
  assert.equal(unclaimedLaunch({ epoch: 4, lease: null }, handle), false);
  assert.equal(unclaimedLaunch({ epoch: 3, lease: { owner: 'x', epoch: 4, expiresAt: '2026-10-09T00:00:00Z' } }, handle), false);
  assert.equal(unclaimedLaunch({ epoch: 3, lease: null }, { ...handle, kind: 'review' } as SessionHandle), false);
});
