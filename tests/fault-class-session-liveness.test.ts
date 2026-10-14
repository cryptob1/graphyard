import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { resolveWork } from '../src/cli/context.js';
import { acknowledgeContainment, establishContainment } from '../src/quarantine.js';
import { restartTolerantApi, supervise, throughRestart, transientControlPlaneFailure } from '../src/supervisor.js';
import { checkInvariants, emptyInvariantRecord } from '../src/model/invariants.js';
import type { Work } from '../src/model.js';
import { leaseLapseCause, leaseLossReason, settleableLeaseLoss, standingEscalations, type PlaneStall, type Principal } from '../src/model.js';
// A namespace import, so the base run of this file, which has no lapsedLeaseExpiry, fails only the case that reads it.
import * as escalationModel from '../src/model/escalation.js';
import type { SessionHandle, SessionHandleInput } from '../src/model/sessions.js';
import { awaitRuntimeStart, buildMasterStatus, masterConfigSchema, SessionStartError, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { launchWaitAttention } from '../src/auto-dispatch.js';
import { GhPausedError } from '../src/gh-pause.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { record, launchAppearanceMs } from '../src/daemon/effects.js';
import { resumeStep, checkPaneStillBelongs } from '../src/daemon/cycle-resume.js';
import { reclaimLaunchedPanes } from '../src/daemon/cycle-reclaim.js';
// A namespace import, so the base run of this file, which exports neither 1g's closer nor the stall
// grace's window, fails only the GY-1801 case that reads them.
import * as daemonSessions from '../src/daemon/cycle-sessions.js';
import * as engineModule from '../src/engine.js';
import { Store } from '../src/store.js';
import { Engine, readPlaneStalls } from '../src/engine.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonState } from '../src/master-daemon.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
// A namespace import, so the proof producer's run of this file at the base, which has no screenDialog,
// fails only the case that reads it.
import * as consent from '../src/consent-prompt.js';
const { detectConsentPrompt } = consent;
const screenDialog = (screen: string) => consent.screenDialog?.(screen);
import { trackFaults, ghPausedWording, faultClassOf, launchWaitKind, type FaultRecord } from '../src/model/fault-classes.js';
// A namespace import, so the base run of this file, which has no rekeyLaunchedSession, fails only the GY-1788 case that reads it.
import * as cycleDispatch from '../src/daemon/cycle-dispatch.js';
const rekeyLaunchedSession = (...args: Parameters<NonNullable<typeof cycleDispatch.rekeyLaunchedSession>>) =>
  cycleDispatch.rekeyLaunchedSession?.(...args) ?? Promise.resolve(false);
// A namespace import, so the base run of this file, which has no unclaimedLaunch, fails only the GY-1571 case.
import * as sessionState from '../src/model/session-state.js';
const { observeSessions, reportedHandle, sessionLaunchGraceMs } = sessionState;
const unclaimedLaunch = (...args: Parameters<typeof sessionState.unclaimedLaunch>) => sessionState.unclaimedLaunch?.(...args) ?? false;
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureWork } from '../scripts/dashboard-fixture.mjs';
import { live } from '../browser-tests/ui-board.js';
// Time-bomb allowance (GY-1694): the 2026-10-08/09 and 2026-10-14 instants are fixed clocks handed to checkInvariants, observeSessions, buildMasterStatus, resumeStep and the fake planes; new Date()/Date.now() only mint leases for the live supervisor timed by performance.now().

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

// One case per instance, so the base run reports each instance's own failure rather than stopping at the first.
for (const instance of unclaimedInstances) {
  test(`unit:fault-class-session-liveness ${instance.key} session — a worker handle registered before its claim is not ended by a report on the pre-claim snapshot, so the claimed lease never reads it as ended`, () => {
    const base = (fixtureWork() as unknown as Work[]).map(live)[0];
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
  });
}

test('unit:fault-class-session-liveness GY-1571 — only a worker handle for an epoch later than the item\'s claim is an unclaimed launch', () => {
  // Only a later epoch than the item's is unclaimed: the attempt the item is on, or one before it, is not.
  const handle = { id: 'graphyard-claude-1:4', kind: 'implementation', epoch: null } as unknown as SessionHandle;
  assert.equal(unclaimedLaunch({ epoch: 3, lease: null }, handle), true);
  assert.equal(unclaimedLaunch({ epoch: 4, lease: null }, handle), false);
  assert.equal(unclaimedLaunch({ epoch: 3, lease: { owner: 'x', epoch: 4, expiresAt: '2026-10-09T00:00:00Z' } }, handle), false);
  assert.equal(unclaimedLaunch({ epoch: 3, lease: null }, { ...handle, kind: 'review' } as SessionHandle), false);
});

// GY-1791 names this file for its proof too: the loop filed 3 session-liveness faults in 24 hours
// (2026-10-13T10:35Z escalation:lease-loss on GY-1764, 2026-10-14T06:55Z action:session on GY-1788,
// 2026-10-14T07:24Z launch-review on GY-1773), and the ledger shows what they share: in each, the
// record the liveness machinery reads was wrong, or the cause was the plane's or GitHub's own, and
// the product counted the session instead of resolving it.
//
// GY-1764: the control plane stopped reconciling for ~2 minutes (its last tick 10:32:47Z, its
// recovery 10:34:42Z) and the supervisor's renewals went unanswered with it. The old supervisor
// awaits the whole client timeout inside one renewal attempt, so a single black-holed request
// consumed every chance the lease had left: the plane recovered two seconds after the lease ran
// out, the lapse was raised as a lease loss, and the instance counted against the session. The
// candidate bounds each attempt by the window it serves and, when the window closes on a request
// that was never answered at all, rides one further lease period past the deadline — where the
// plane's own stall record (recordPlaneLiveness) keeps the lease live, GY-558's rule for the plane's own
// failures, so a recovery inside the allowance lands a renewal and the attempt survives.
//
// GY-1788: the launcher registered the attempt's session before its claim under the snapshot's
// `principal:epoch+1`, but the launch claimed a later epoch (its first runtime refused the prompt),
// so the live attempt's record sat under the previous attempt's id. The resume fence — which keys
// the attempt by `principal:epoch` — refused the re-prompt against the pane the old id carried,
// and the GY-953 follow-through started a reclaim bound only when the attempt's own handle existed
// without a pane, never when it was absent entirely: the item stood un-promptable. The candidate
// moves the record onto the epoch the launch claimed once it is known, and the fence's follow-
// through reclaims the attempt it cannot address, whichever of the two shapes the record has.
//
// GY-1773: the gh login's rate-limit pause deferred the reviewer launch, and the wait line the
// pause produced was filed as launch-review — a launch that did not start — although its own reason
// names a GitHub read that is paused, which the catalogue owns as github-budget under the
// observation class. The candidate classifies the wait by that wording, shared with the error the
// pause throws, so the paused read counts where paused reads count.

const GY1791_NOW = Date.parse('2026-10-14T06:55:00.000Z'), GY1791_AT = (ms: number) => new Date(GY1791_NOW + ms).toISOString();

test('unit:fault-class-session-liveness GY-1773 launch-review — a launch a gh rate-limit pause defers is the paused GitHub read the catalogue owns, not a launch that did not start', () => {
  // The instance's wait reason, as the pause's own error words it and the dispatcher waits with.
  const reason = new GhPausedError(GY1791_NOW).message;
  assert.match(reason, new RegExp(`${ghPausedWording.paused} until .+: ${ghPausedWording.limit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const base = launchWaitKind(reason);
  assert.equal(base, 'github-budget', `the base filed the paused read as ${base}, a session-liveness launch that did not start`);
  assert.equal(faultClassOf('github-budget'), 'observation');

  // The instance's attention line, and what the loop's record opens for it: no session-liveness
  // instance; the observation one the catalogue assigns a paused read.
  const attention = launchWaitAttention([{ kind: 'review', work: 'GY-1773', requestId: '8a846438f97b93a60c5cc44fe6409c11', sha: 'a6d1c5dcf6406a506db99b152977be102e7dcaa3', group: null,
    requestedAt: GY1791_AT(-16 * 60_000), waitedMs: 16 * 60_000, reason }]);
  assert.equal(attention.length, 1, 'the 15-minute attention still stands — the pause is visible, only classed honestly');
  assert.equal(attention[0].kind, 'github-budget');
  assert.equal(attention[0].faultClass, 'observation');
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  const opened = trackFaults(record, attention.map(entry => ({ kind: entry.kind!, faultClass: entry.faultClass!, subject: entry.subject, text: entry.text })), GY1791_AT(0));
  assert.equal(opened.filter(entry => entry.faultClass === 'session-liveness').length, 0, 'the base opened a session-liveness instance here');
  assert.ok(opened.some(entry => entry.kind === 'github-budget' && entry.faultClass === 'observation'));
});

test('unit:fault-class-session-liveness GY-1788 action:session — a launch that claimed a later epoch moves its record onto the claimed epoch in one verified write, where the resume fence looks', async () => {
  // The dispatch snapshot was at epoch 0, so the pre-claim registration guessed graphyard-codex-2:1;
  // the launch refused its first prompt, claimed again, and held epoch 2 (the ledger's shape).
  const handle: SessionHandleInput = { id: 'graphyard-codex-2:1', kind: 'implementation', principal: 'graphyard-codex-2', runtime: 'claude', host: 'vishrog', workspace: 'w1V',
    subject: 'GY-1788: Recurring scope faults: 3 in 24 hours', state: 'running' };
  const launched = { epoch: 2, pane: 'w1V:pPFN', agentName: 'graphyard-opencode-4' };
  const attach = (pane: string) => `herdr pane attach ${pane} --workspace w1V`;
  // The control plane's answer to the one write: the document with the record moved (engine.ts
  // closes the guessed record in the same transaction).
  const movedDocument = { sessions: [{ id: 'graphyard-codex-2:1', state: 'finished' }, { id: 'graphyard-codex-2:2', state: 'running' }] };
  const writes: SessionHandleInput[] = [];
  const moved = await rekeyLaunchedSession(async input => { writes.push(input); return movedDocument; }, handle, 1, launched, attach, 1);
  assert.deepEqual(moved, { outcome: 'moved', from: 'graphyard-codex-2:1', to: 'graphyard-codex-2:2' }, 'the base moved nothing: the record stayed under the previous attempt\u2019s id');
  assert.equal(writes.length, 1, 'one write moves the record: the destination; the control plane closes the source in the same transaction');
  assert.equal(writes[0].id, 'graphyard-codex-2:2');
  assert.equal(writes[0].state, 'running');
  assert.equal(writes[0].pane, 'w1V:pPFN');
  assert.equal(writes[0].attach, 'herdr pane attach w1V:pPFN --workspace w1V');
  assert.equal(writes[0].agentName, 'graphyard-opencode-4');
  assert.equal(writes[0].principal, 'graphyard-codex-2');
  // No attempt epoch rides the write: only the lease holder may write one (engine.ts), and the
  // coordinator's record keys by id alone, as every pre-claim registration does.
  assert.equal(writes[0].epoch, undefined);
  assert.equal((writes[0] as SessionHandle).pane, 'w1V:pPFN');

  // A write the control plane answers with no document landed too: it refuses rather than half-applies.
  assert.deepEqual(await rekeyLaunchedSession(async () => undefined, handle, 1, launched, attach, 1), { outcome: 'moved', from: 'graphyard-codex-2:1', to: 'graphyard-codex-2:2' });

  // A write that fails is retried as a launch's coordinates are, and a move that never lands is
  // reported as such — never as a dispatch whose session is addressable — with the guessed record
  // untouched: nothing closed the source, because nothing ever writes to it.
  const failing: SessionHandleInput[] = [];
  const failed = await rekeyLaunchedSession(async input => { failing.push(input); throw new Error('503 the control plane is restarting'); }, handle, 1, launched, attach, 1);
  assert.deepEqual(failed, { outcome: 'failed', from: 'graphyard-codex-2:1', to: 'graphyard-codex-2:2', reason: '503 the control plane is restarting' });
  assert.equal(failing.length, 3, 'retried coordinateAttempts times');
  assert.ok(failing.every(write => write.id === 'graphyard-codex-2:2' && write.state === 'running'), 'every attempt wrote the destination; none touched the source');
  // So is a write the control plane applied without moving the source: the answer is read, not assumed.
  const unmoved = await rekeyLaunchedSession(async () => ({ sessions: [{ id: 'graphyard-codex-2:1', state: 'running' }, { id: 'graphyard-codex-2:2', state: 'running' }] }), handle, 1, launched, attach, 1);
  assert.equal(unmoved.outcome, 'failed');
  assert.match((unmoved as { reason: string }).reason, /still runs under graphyard-codex-2:1/);

  // A launch that claimed the expected epoch moves nothing.
  const same: SessionHandleInput[] = [];
  assert.deepEqual(await rekeyLaunchedSession(async input => { same.push(input); }, handle, 1, { epoch: 1, pane: 'w1V:pPFN', agentName: null }), { outcome: 'unchanged' });
  assert.deepEqual(same, []);
  // Nor a launch that failed: there is no claimed epoch to move onto.
  const none: SessionHandleInput[] = [];
  assert.deepEqual(await rekeyLaunchedSession(async input => { none.push(input); }, handle, 1, undefined), { outcome: 'unchanged' });
  assert.deepEqual(none, []);
});

/** The item, profile and cycle the resume step runs against, as GY-1788's epoch 2 stood at 06:55:54Z: its scope request applied, its waits standing, its session recorded under the previous attempt's id. */
function unaddressableAttempt() {
  const item = {
    id: 'work-1788', key: 'GY-1788', title: 'Recurring scope faults: 3 in 24 hours', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [], plannedFiles: [], stage: 'build', ready: true, createdAt: GY1791_AT(-30 * 60_000), updatedAt: GY1791_AT(-60_000), stageEnteredAt: GY1791_AT(-30 * 60_000),
    epoch: 2, lease: { owner: 'graphyard-codex-2', epoch: 2, expiresAt: GY1791_AT(60_000) }, workspaces: [], candidate: null, submission: null, blocker: null,
    scopeRequest: null, scopeDecision: { state: 'approved' as const, reason: 'Additive widening justified by the item\u2019s own triage', at: GY1791_AT(-4_000), decidedBy: 'graphyard-approver',
      waitedMs: 65_000, paths: ['src/daemon/cycle-scope.ts'], requestedBy: 'graphyard-codex-2', requestedAt: GY1791_AT(-69_000) },
    sessions: [{ id: 'graphyard-codex-2:1', kind: 'implementation', principal: 'graphyard-codex-2', epoch: null, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null,
      pane: 'w1V:pPFN', agentName: 'graphyard-opencode-4', role: null, head: null, attach: 'herdr pane attach w1V:pPFN --workspace w1V', transcript: null,
      subject: 'GY-1788: Recurring scope faults: 3 in 24 hours', startedAt: GY1791_AT(-14 * 60_000), updatedAt: GY1791_AT(-60_000), endedAt: null, state: 'running', outcome: null }],
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], evidence: [], observation: null,
  } as unknown as Work;
  const profile = { name: 'claude-senary', principal: 'graphyard-codex-2', agentName: 'graphyard-opencode-4', mode: 'launch', kind: 'claude', credentialFile: '/outside/s6.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
  // The runtime lists the profile's agent name in the pane the old id carries — the address the
  // fence refuses to trust, and the one the loop must be able to move past.
  const agents = [{ name: 'graphyard-opencode-4', pane_id: 'w1V:pPFN', agent_status: 'idle', agent: { name: 'graphyard-opencode-4' } }];
  return { item, profile, agents };
}

async function resumeWorld(item: Work, profile: WorkerProfile, agents: unknown[], shiftMs: { value: number }) {
  const directory = await temporaryDirectory('session-liveness-resume');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: '/usr/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile] });
  const state: DaemonState = emptyDaemonState(config);
  const closed: string[] = [], prompts: string[] = [], sessions: SessionHandleInput[] = [];
  const effects = {
    persist: async () => {},
    closeSession: async (pane: string) => { closed.push(pane); },
    promptSession: async (_agent: unknown, text: string) => { prompts.push(text); },
    recordSession: async (_work: Work, handle: SessionHandleInput) => { sessions.push(handle); },
    reportCapacity: async (work: Work, event: { epoch: number }) => {
      work.capacity = { exhaustions: [...work.capacity?.exhaustions ?? [], { role: 'worker', epoch: event.epoch, cause: 'interrupted', profile: profile.name, account: null, runtime: 'claude', reason: 'ended', resetsAt: null, partialWork: { state: 'clean' as const }, at: GY1791_AT(shiftMs.value), owner: profile.principal, recordedBy: 'coordinator' }], escalations: [] };
      if (work.lease?.epoch === event.epoch) work.lease = null;
      return work;
    },
  } as unknown as DaemonEffects;
  const cycle = (now: number) => ({ config, state, effects, now: () => GY1791_NOW + now, clock: GY1791_NOW + now, performed: [], isolate: async (_k: string, _i: unknown, _n: string, fn: () => Promise<unknown>) => fn(), agents, heldBy: () => item } as unknown as Cycle);
  return { config, state, effects, cycle, closed, prompts, sessions, item, cleanup: () => void directory };
}

test('unit:fault-class-session-liveness GY-1788 action:session — a cleared wait whose attempt\u2019s own handle is not on the record at all is reclaimed on the bound instead of standing un-promptable for ever', async () => {
  const { item, profile, agents } = unaddressableAttempt();
  const world = await resumeWorld(item, profile, agents, { value: 0 });
  const { state } = world;
  try {
    // The wait the loop marked while the scope request stood, and the scope decision that answered it.
    await record(state, `resume:scope:${item.id}:2`, { kind: 'session', work: item.key, principal: profile.principal, epoch: 2, state: 'waiting',
      detail: `${item.key} epoch 2 waits on its scope request of ${GY1791_AT(-69_000)} for src/daemon/cycle-scope.ts, and ${profile.agentName} is re-prompted once it is answered`, attempts: 1, cycle: 0 }, GY1791_NOW, world.effects.persist);
    await resumeStep(world.cycle(0), new Set(), true);

    // The resolution was refused against the pane the old id carries — the instance's own refusal —
    // and the failed paste opened the action:session fault on both base and candidate.
    const promptKey = Object.keys(state.actions).find(key => key.startsWith(`resume:prompt:${item.id}:2:`))!;
    const refusal = state.actions[promptKey];
    assert.match(refusal.detail, /the recorded pane cannot be re-prompted: pane w1V:pPFN is recorded for GY-1788's session graphyard-codex-2:1/);
    assert.ok(state.faults.instances.some(instance => instance.kind === 'action:session'), 'the failed paste counts as the action:session instance it was');
    // The candidate starts the reclaim bound at the first unverifiable observation; the base left
    // the item standing: no bound, no end, every later cycle refusing the same resolution again.
    const bound = state.actions[`idle:${item.id}:2`];
    assert.ok(bound, 'the base started no reclaim bound here: the handle was absent entirely, so GY-953\u2019s guard never fired');
    assert.match(bound!.detail, /its handle graphyard-codex-2:2 is not on the record \(its launch registered this session under another attempt's id\)/);
    assert.deepEqual(world.prompts, [], 'nothing is pasted: the pane is not verifiably this attempt\u2019s');
    assert.equal(world.sessions.length, 0, 'no handle was written by the refusal');

    // A later cycle, past the bound: the attempt is handed to a new one that keeps its branch —
    // the automatic relaunch the base never did.
    state.cycle += 1;
    await resumeStep(world.cycle(150_000), new Set(), true);
    const done = [...Object.values(state.actions)].find(action => action.state === 'done' && /keeping the attempt's branch/.test(action.detail));
    assert.ok(done, `the base never ended the attempt: ${[...Object.values(state.actions)].map(action => `${action.kind}:${action.state}`).join(', ')}`);
    assert.match(done!.detail, /its handle graphyard-codex-2:2 has not been on the record since/);
    assert.deepEqual(world.prompts, [], 'still nothing pasted');
    // The loop's own close of the attempt's handle landed under the id the fence keys.
    assert.ok(world.sessions.some(handle => handle.id === 'graphyard-codex-2:2' && handle.state === 'finished'));
  } finally { world.cleanup(); }
});

// The stall the GY-1764 instance flew into: a request that arrives inside the window is never
// answered — black-holed, the way a proxy holds a connection whose upstream is gone — and the plane
// answers every request that arrives after the recovery, so a renewal sent then renews for real.
const STALL_LEASE_MS = 1_200;
function stallingControlPlane(stallFromMs: number, stallUntilMs: number) {
  const started = performance.now();
  const calls: { path: string; at: number; answered: boolean }[] = [];
  const iso = (elapsed: number) => new Date(Date.parse('2026-10-14T10:00:00.000Z') + elapsed).toISOString();
  const api = async (path: string, data?: unknown): Promise<any> => {
    const arrived = performance.now() - started;
    if (arrived >= stallFromMs && arrived < stallUntilMs) { calls.push({ path, at: arrived, answered: false }); await new Promise<never>(() => {}); }
    calls.push({ path, at: arrived, answered: true });
    if (path.endsWith('/heartbeat')) return { updatedAt: iso(arrived), lease: { epoch: 1, expiresAt: iso(arrived + STALL_LEASE_MS) } };
    throw new Error(`unexpected call ${path} ${JSON.stringify(data)}`);
  };
  return { api, calls, elapsed: () => performance.now() - started };
}

/** One steady-state worker under a control plane that stalls out from under it; `bound` Infinity is the base's wiring, where a request is awaited for as long as the window lasts. */
async function stalledLaunch(bound: number, stallUntilMs: number) {
  const plane = stallingControlPlane(200, stallUntilMs);
  const released: string[] = [];
  const code = await supervise(process.execPath, ['-e', 'setTimeout(() => {}, 2_200)'], 1, () => plane.api('work/work-1/heartbeat', { epoch: 1 }), {
    intervalMs: 20, graceMs: 25, ...retry, startupWindowMs: 0, attemptBoundMs: bound,
    session: { visible: () => null, unconsented: () => null, surrender: async cause => { released.push(cause); } },
  }).then(ended => ended, () => 1);
  return { code, released, calls: plane.calls, endedAt: plane.elapsed() };
}

test('integration:fault-class-session-liveness GY-1764 escalation:lease-loss — a renewal the plane never answers is abandoned and retried, so a plane that recovers inside the lease renews it, while the deadline never moves on an unanswered request', async () => {
  // The base: the one unanswered renewal was awaited for the whole window (the client timeout is
  // the lease itself), no retry ever ran inside the lease, and the worker was stopped at the
  // deadline with the lease lapsed unrenewed although the plane had been back for half a second —
  // the shape the control plane raised as "Worker graphyard-claude-1 lost lease epoch 8".
  const base = await stalledLaunch(Number.POSITIVE_INFINITY, 700);
  assert.equal(base.released.length, 0, 'the base left the lease to lapse unexplained: no release, only the stop at the deadline');
  assert.equal(base.code, 1, 'the worker was stopped at the lease\u2019s deadline');
  assert.ok(base.calls.filter(call => call.path.endsWith('/heartbeat') && call.answered).every(call => call.at < 200), 'the base never renewed after the stall began');

  // The candidate: the attempt is given up on at its bound and a fresh one sent, which the
  // recovered plane answers — the agent runs to its own exit and the lease is released with the
  // cause, never lapsed.
  const candidate = await stalledLaunch(150, 700);
  assert.deepEqual(candidate.released.map(cause => cause.replace(/\s+/g, ' ')), ['the agent process exited (code 0) while its lease was live'], 'the attempt survived the stall and ended on its own');
  assert.equal(candidate.code, 0);
  assert.ok(candidate.calls.some(call => call.path.endsWith('/heartbeat') && call.answered && call.at >= 700), 'a renewal landed after the plane recovered');
  assert.ok(candidate.calls.filter(call => !call.answered).length >= 2, 'the black-holed requests were abandoned and retried inside the lease');

  // And a stall the lease does not outlive: nothing the plane never answered authorises the
  // worker past the expiry the server issued, so it is stopped at the deadline — with the plane
  // still down — and never rides out the outage on the chance that the server is also down.
  const outlived = await stalledLaunch(150, 5_000);
  assert.equal(outlived.code, 1, 'the worker was stopped when the lease expired');
  assert.equal(outlived.released.length, 0, 'the lapse is the control plane\u2019s to explain (its own stall record), not a release');
  assert.ok(outlived.endedAt < 2_000, `the supervisor stopped at the server-issued deadline (${Math.round(outlived.endedAt)} ms), not a lease period later`);
  assert.ok(outlived.calls.filter(call => call.path.endsWith('/heartbeat') && call.answered).every(call => call.at < 200), 'no renewal was ever answered after the stall began');
});

// The plane's side of the same instance, on a real store: the tick record, the stall it records,
// the grace that keeps a lease live across the stall, and the lapse it explains.
const human: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const stallWorker: Principal = { id: 'worker-stall', role: 'worker', sessionKind: 'ai' };
const stallCoordinator: Principal = { id: 'graphyard-loop', role: 'coordinator', sessionKind: 'ai' };
let stallDatabase: EmbeddedPostgres, stallStore: Store, stallEngine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_SESSION_LIVENESS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1800);
  stallDatabase = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('session-liveness-plane'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await stallDatabase.initialise(); await stallDatabase.start(); await stallDatabase.createDatabase('graphyard_test');
  stallStore = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await stallStore.init();
  stallEngine = new Engine(stallStore, [15368], 120, 'owner/project');
  stallEngine.principals = [human, stallWorker, stallCoordinator];
});
after(async () => { if (stallStore) await stallStore.close(); if (stallDatabase) await stallDatabase.stop(); });
const stallId = () => randomUUID();
const stallInput = (title: string) => ({ title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] });
const stallDocument = async (workId: string) => (await stallStore.pool.query('SELECT document FROM work_items WHERE id=$1', [workId])).rows[0].document;
const stallOverwrite = async (workId: string, mutate: (document: Work) => void) => {
  const document = await stallDocument(workId); mutate(document);
  await stallStore.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [workId, JSON.stringify(document)]);
};
const stallEscalations = async (workId: string) => standingEscalations((await stallDocument(workId)) as Work).map(entry => entry.trigger);
const stallEvents = async (workId: string, kind: string) => (await stallStore.pool.query(`SELECT payload->'details' AS details FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq`, [workId, kind])).rows.map(row => row.details);

test('unit:fault-class-session-liveness GY-1764 classification — a lapse inside a recorded plane stall is explained by the stall, and a standing lease-loss settles only when the stall covers the lease\u2019s own expiry', () => {
  const stall: PlaneStall = { from: GY1791_AT(-90_000), to: GY1791_AT(-5_000) };
  const lease = { owner: 'graphyard-claude-1', epoch: 8, expiresAt: GY1791_AT(-45_000) };
  const explained = leaseLapseCause({ submission: null }, lease, [], [stall]);
  assert.equal(explained?.cause, 'control-plane-stall', 'the base classified this lapse as a loss: no stall record existed');
  assert.deepEqual(explained?.stall, stall);
  assert.equal(leaseLapseCause({ submission: null }, lease, [], []), null, 'the same lapse with no recorded stall is still a vanished worker');

  // The escalation the base raised for that lapse, once the stall is on the record: settled by
  // reconciliation itself, with the stall as its note — the way a blocked report explains a lapse.
  // The lapse is read from the attempt record the loss ended at the lease's own deadline.
  const escalation = { trigger: 'lease-loss' as const, reason: leaseLossReason({ owner: lease.owner, epoch: lease.epoch }), at: GY1791_AT(-4_000), actor: 'graphyard' };
  const attempt = (expiresAt: string) => ({ attempts: [{ epoch: 8, owner: lease.owner, claimedAt: GY1791_AT(-300_000), endedAt: expiresAt, end: 'expired' as const }], interventions: { blocked: 0, requirements: 0 }, submittedAt: null, resubmittedAt: null, reworkRounds: 0 }) as Work['pipeline'];
  const standing = (pipeline: ReturnType<typeof attempt> | undefined) => ({ submission: null, escalations: [escalation], escalation, epoch: 8, lease: null, stage: 'build' as const, pipeline });
  const settled = settleableLeaseLoss(standing(attempt(lease.expiresAt)), [], Date.parse(stall.to), [stall]);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].cause, 'control-plane-stall');
  assert.match(settled[0].note, /not answering between/);
  // A lease that ran out before the plane stalled was lost by its worker, however soon after the
  // stall the loss was raised: the raise is the first tick after the expiry, which the recovery
  // tick is for every lapse the stall merely delayed noticing. The stall must cover the expiry.
  assert.deepEqual(settleableLeaseLoss(standing(attempt(GY1791_AT(-100_000))), [], Date.parse(stall.to), [stall]), [], 'an expiry before the stall is not the stall\u2019s to explain');
  assert.deepEqual(settleableLeaseLoss(standing(undefined), [], Date.parse(stall.to), [stall]), [], 'with no attempt record of the lapse, nothing places the expiry inside the stall');
  assert.deepEqual(settleableLeaseLoss(standing(attempt(lease.expiresAt)), [], Date.parse(stall.to), []), [], 'and with no stall on the record the loss stands');
});

test('integration:fault-class-session-liveness GY-1764 escalation:lease-loss — the plane records its own stall, a heartbeat under it renews, and a lapse it covers is history with its cause', async () => {
  let work = await stallEngine.execute(human, 'create', null, stallInput('plane-stall-lapse'), stallId());
  work = await stallEngine.execute(human, 'ready', work.id, {}, stallId());
  work = await stallEngine.execute(stallWorker, 'claim', work.id, {}, stallId());
  const epoch = work.epoch;

  // The pass records its tick; a gap past the bound since the previous pass is one stall row.
  await stallEngine.reconcile();
  assert.equal((await stallStore.pool.query('SELECT tick_at FROM plane_liveness WHERE id = true')).rows.length, 1);
  await stallStore.pool.query('UPDATE plane_liveness SET tick_at = tick_at - interval \'90 seconds\'');
  await stallEngine.reconcile();
  const stalls = (await stallStore.pool.query(`SELECT payload->'details' AS details FROM events WHERE kind = 'plane.stall'`)).rows.map(row => row.details) as PlaneStall[];
  assert.equal(stalls.length, 1, 'the gap was recorded once');
  const stall = stalls[0];
  assert.ok(Date.parse(stall.to) - Date.parse(stall.from) >= 60_000, `the recorded gap covers the outage: ${stall.from}..${stall.to}`);
  await stallEngine.reconcile();
  assert.equal(Number((await stallStore.pool.query(`SELECT count(*) AS n FROM events WHERE kind = 'plane.stall'`)).rows[0].n), 1, 'a pass with no gap records nothing');

  // The renewals the stall ate: the lease ran out inside the gap, and the heartbeat the supervisor
  // sent once requests were answered again renews — the grace kept the lease live across the stall.
  await stallOverwrite(work.id, document => { document.lease!.expiresAt = new Date(Date.parse(stall.to) - 45_000).toISOString(); });
  const renewed = await stallEngine.execute(stallWorker, 'heartbeat', work.id, { epoch }, stallId());
  assert.ok(renewed.lease && Date.parse(renewed.lease.expiresAt) > Date.parse(stall.to), `the base refused this heartbeat: the lease had lapsed inside the stall (${JSON.stringify(renewed.lease)})`);

  // A loss raised for a lease that ran out before the stall began stands: the worker vanished on its
  // own, and the stall that merely delayed the plane's noticing explains nothing about it, even
  // though the first tick after the stall is the one that raised it.
  let lost = await stallEngine.execute(human, 'create', null, stallInput('plane-stall-loss'), stallId());
  lost = await stallEngine.execute(human, 'ready', lost.id, {}, stallId());
  lost = await stallEngine.execute(stallWorker, 'claim', lost.id, {}, stallId());
  const lostExpiry = new Date(Date.parse(stall.from) - 400_000).toISOString();
  await stallOverwrite(lost.id, document => { document.lease!.expiresAt = lostExpiry; document.pipeline!.attempts.at(-1)!.claimedAt = new Date(Date.parse(lostExpiry) - 60_000).toISOString(); });
  await stallEngine.reconcile();
  assert.deepEqual(await stallEscalations(lost.id), ['lease-loss'], 'a lease that ran out before the plane stalled was lost by its worker and stands');
  assert.equal((await stallEvents(lost.id, 'escalation.auto-settled')).length, 0, 'the stall recorded after it settles nothing about it');
  assert.equal(escalationModel.lapsedLeaseExpiry((await stallDocument(lost.id)) as Work, lost.epoch), lostExpiry, 'the attempt record holds the lapse at the lease\u2019s own deadline');

  // Whereas a loss raised while the stall was not yet on the record — the beat's write failed and
  // the pass classed the lapse without it — settles once the next beat records the stall that
  // covers the lease's expiry: reconciliation itself, with the stall as its note, where the base
  // held it for an approver. That stall begins after the earlier loss's expiry, which it leaves standing.
  let late = await stallEngine.execute(human, 'create', null, stallInput('plane-stall-late-record'), stallId());
  late = await stallEngine.execute(human, 'ready', late.id, {}, stallId());
  late = await stallEngine.execute(stallWorker, 'claim', late.id, {}, stallId());
  const lateExpiry = new Date(Date.parse(stall.from) - 200_000).toISOString();
  await stallOverwrite(late.id, document => { document.lease!.expiresAt = lateExpiry; document.pipeline!.attempts.at(-1)!.claimedAt = new Date(Date.parse(lateExpiry) - 60_000).toISOString(); });
  await stallEngine.reconcile();
  assert.deepEqual(await stallEscalations(late.id), ['lease-loss'], 'no stall covered the expiry yet, so the lapse was a loss');
  await stallStore.pool.query('UPDATE plane_liveness SET tick_at = $1', [new Date(Date.parse(lateExpiry) - 5_000)]);
  await stallEngine.reconcile();
  assert.deepEqual(await stallEscalations(late.id), [], 'the stall the plane recorded afterwards covers the expiry and settles the loss on the record alone');
  const settledRows = await stallEvents(late.id, 'escalation.auto-settled');
  assert.ok(settledRows.length, 'the settlement is on the ledger');
  assert.match(settledRows.at(-1)!.note, /not answering between/);
  assert.equal((await stallEvents(late.id, 'lease.expired')).length, 0, 'the lapse itself was a loss, not an explained expiry');
  assert.deepEqual(await stallEscalations(lost.id), ['lease-loss'], 'the earlier loss, whose expiry no stall covers, still stands');
  assert.ok((await readPlaneStalls(stallStore.pool, Date.parse(stall.from) - 1_000, Date.parse(stall.to) + 1_000)).some(entry => entry.from === stall.from && entry.to === stall.to), 'the reader the classification uses reads the stall back');
});

test('integration:fault-class-session-liveness GY-1764 escalation:lease-loss — the plane\u2019s tick runs on the lease pool, so a request pool exhausted while renewals still land records no stall', async () => {
  let work = await stallEngine.execute(human, 'create', null, stallInput('plane-stall-lease-pool'), stallId());
  work = await stallEngine.execute(human, 'ready', work.id, {}, stallId());
  work = await stallEngine.execute(stallWorker, 'claim', work.id, {}, stallId());
  await stallEngine.recordPlaneLiveness();
  const before = (await stallStore.pool.query('SELECT tick_at FROM plane_liveness WHERE id = true')).rows[0].tick_at as Date;
  // Every connection of the request pool is held behind slow work; the lease pool is untouched.
  const held = await Promise.all(Array.from({ length: (stallStore.pool as unknown as { options: { max: number } }).options.max }, () => stallStore.pool.connect()));
  try {
    const stalls = Number((await stallStore.leasePool.query(`SELECT count(*) AS n FROM events WHERE kind = 'plane.stall'`)).rows[0].n);
    const ticked = new Date(before.getTime() + 1_000);
    await stallEngine.recordPlaneLiveness(ticked);
    const after = (await stallStore.leasePool.query('SELECT tick_at FROM plane_liveness WHERE id = true')).rows[0].tick_at as Date;
    assert.equal(after.getTime(), ticked.getTime(), 'the base took the tick\u2019s connection from the request pool, where none was to be had: the tick landed over the lease pool');
    assert.equal(Number((await stallStore.leasePool.query(`SELECT count(*) AS n FROM events WHERE kind = 'plane.stall'`)).rows[0].n), stalls, 'and a saturated request pool is no stall');
    // A heartbeat lands on the same path, which is the point: the tick measures what serves renewals.
    assert.ok((await stallEngine.execute(stallWorker, 'heartbeat', work.id, { epoch: work.epoch }, stallId())).lease, 'renewals still land');
  } finally { for (const client of held) client.release(); }
});

test('integration:fault-class-session-liveness GY-1764 escalation:lease-loss — a beat records the time it landed, not the time it was sent, and beats never pile up behind a lease pool that is not answering', async () => {
  // The plane beats on its own timer; the first beat lands before the timer starts.
  const stop = await stallEngine.startPlaneBeat(20);
  // Then every lease-pool connection is held, as a black-holed path holds them: a beat sent now waits.
  const held = await Promise.all(Array.from({ length: (stallStore.leasePool as unknown as { options: { max: number } }).options.max }, () => stallStore.leasePool.connect()));
  try {
    const sentAt = (await stallStore.pool.query('SELECT now() AS at')).rows[0].at as Date;
    const beat = stallEngine.recordPlaneLiveness();
    await delay(1_100);
    // Behind it waits at most the timer's one in-flight beat: later intervals join no queue until the pool answers.
    assert.ok(stallStore.leasePool.waitingCount <= 2, `the base queued a beat per interval behind the held pool: ${stallStore.leasePool.waitingCount} waiting`);
    const landedAt = (await stallStore.pool.query('SELECT now() AS at')).rows[0].at as Date;
    for (const client of held.splice(0)) client.release();
    await beat;
    const tick = (await stallStore.leasePool.query('SELECT tick_at FROM plane_liveness WHERE id = true')).rows[0].tick_at as Date;
    assert.ok(tick.getTime() >= landedAt.getTime(), `the base stamped the beat when it was sent (${sentAt.toISOString()}); it landed at ${landedAt.toISOString()} and the record says ${tick.toISOString()}`);
    assert.ok(tick.getTime() - sentAt.getTime() >= 1_000, 'the held second is on the record, not replayed away');
  } finally { stop(); for (const client of held) client.release(); }
});

test('integration:fault-class-session-liveness GY-1788 action:session — the control plane moves a launcher\u2019s session record in one transaction: the record under the claimed epoch runs, the guessed record is closed', async () => {
  let work = await stallEngine.execute(human, 'create', null, stallInput('session-rekey'), stallId());
  work = await stallEngine.execute(human, 'ready', work.id, {}, stallId());
  const handle = { kind: 'implementation' as const, principal: stallWorker.id, runtime: 'claude', host: 'vishrog', subject: `${work.key}: session-rekey` };
  // The launcher's pre-claim registration under the snapshot's guess, coordinated once the runtime started.
  work = await stallEngine.execute(stallCoordinator, 'session', work.id, { ...handle, id: `${stallWorker.id}:1`, state: 'running', pane: 'w1V:pOLD', agentName: 'graphyard-opencode-4' }, stallId());
  // A review session of another principal, and an already-finished implementation record, are not the moving record's business.
  work = await stallEngine.execute(stallCoordinator, 'session', work.id, { kind: 'review', principal: 'graphyard-master', runtime: 'codex', host: 'vishrog', subject: 'review', id: 'review-1', state: 'running' }, stallId());
  // The launch claimed epoch 2: the launcher's one write records the session there.
  work = await stallEngine.execute(stallCoordinator, 'session', work.id, { ...handle, id: `${stallWorker.id}:2`, state: 'running', pane: 'w1V:pOLD', agentName: 'graphyard-opencode-4' }, stallId());
  const byId = Object.fromEntries((work.sessions ?? []).map(entry => [entry.id, entry]));
  assert.equal(byId[`${stallWorker.id}:2`]?.state, 'running');
  assert.equal(byId[`${stallWorker.id}:2`]?.pane, 'w1V:pOLD');
  assert.equal(byId[`${stallWorker.id}:1`]?.state, 'finished', 'the base left the guessed record running beside the new one');
  assert.match(byId[`${stallWorker.id}:1`]?.outcome ?? '', /runs one implementation session on .* at a time.*recorded that session as worker-stall:2/);
  assert.equal(byId['review-1']?.state, 'running', 'another principal\u2019s session is untouched');
  // The same document answers the write, so the launcher verifies the move from the answer.
  const document = await stallDocument(work.id) as Work;
  assert.equal(document.sessions?.find(entry => entry.id === `${stallWorker.id}:1`)?.state, 'finished');
  assert.equal(document.sessions?.find(entry => entry.id === `${stallWorker.id}:2`)?.state, 'running');
});

test('integration:fault-class-session-liveness GY-1764 escalation:lease-loss — the pass that first detects the stall is the pass that meets the expired lease, and it keeps the lease', async () => {
  let work = await stallEngine.execute(human, 'create', null, stallInput('plane-stall-first-pass'), stallId());
  work = await stallEngine.execute(human, 'ready', work.id, {}, stallId());
  work = await stallEngine.execute(stallWorker, 'claim', work.id, {}, stallId());
  await stallEngine.reconcile();
  // No stall is on the record yet: the plane was down from 90 s ago, and the lease ran out inside it.
  const before = Number((await stallStore.pool.query(`SELECT count(*) AS n FROM events WHERE kind = 'plane.stall'`)).rows[0].n);
  await stallStore.pool.query('UPDATE plane_liveness SET tick_at = tick_at - interval \'90 seconds\'');
  await stallOverwrite(work.id, document => { document.lease!.expiresAt = new Date(Date.now() - 45_000).toISOString(); });
  await stallEngine.reconcile();
  assert.equal(Number((await stallStore.pool.query(`SELECT count(*) AS n FROM events WHERE kind = 'plane.stall'`)).rows[0].n), before + 1, 'this very pass recorded the stall');
  assert.deepEqual(await stallEscalations(work.id), [], 'the recovery pass raised a lease loss the stall it detected explains');
  const after = await stallDocument(work.id) as Work;
  assert.ok(after.lease, 'the lease survived the recovery pass');
  assert.ok(Date.parse(after.lease!.expiresAt) > Date.now(), 'and was extended past now');
  const renewed = await stallEngine.execute(stallWorker, 'heartbeat', work.id, { epoch: work.epoch }, stallId());
  assert.ok(renewed.lease, 'the supervisor\'s heartbeat lands on a live lease');
});

// GY-1801: the moves GY-1791 added must never close a pane whose attempt still holds a live
// lease — the soak's pane-close invariant (GY-980). A rekey moves the launcher's record and
// closes the guessed record in the same transaction as a record, never as a pane, and the pane it
// leaves behind is no longer the new session's address. The stall's grace keeps a lease only
// `stallRenewalWindowMs` past the stall — the window a still-retrying supervisor needs, never a
// full lease period — and the loop's own closers (1g and the sweep) take no pane whose attempt
// still stands or whose record a live lease names: their close waits for the attempt's end, which
// the engine's lapse or the resume step's reclaim records first.
test('unit:rekey-never-closes-live-lease-pane — a rekey moves the record, never the pane; a stall-kept lease keeps its pane only for the renewal window; and no closer takes a standing attempt’s pane', async () => {
  // A rekey beside a live lease: epoch 1 is claimed and its session is the one the lease serves.
  let live = await stallEngine.execute(human, 'create', null, stallInput('rekey-live-lease'), stallId());
  live = await stallEngine.execute(human, 'ready', live.id, {}, stallId());
  live = await stallEngine.execute(stallWorker, 'claim', live.id, {}, stallId());
  const liveExpiry = live.lease!.expiresAt;
  const handle = { kind: 'implementation' as const, principal: stallWorker.id, runtime: 'claude', host: 'vishrog' };
  live = await stallEngine.execute(stallCoordinator, 'session', live.id, { ...handle, subject: `${live.key}: rekey-live-lease`, id: `${stallWorker.id}:1`, state: 'running', pane: 'w1V:pLIVE', agentName: 'graphyard-opencode-4' }, stallId());
  // The launch claimed epoch 2 and the record moves onto it in one write (GY-1791). The write is
  // a record move: no lease ends, no attempt ends, and no pane is closed by it.
  live = await stallEngine.execute(stallCoordinator, 'session', live.id, { ...handle, subject: `${live.key}: rekey-live-lease`, id: `${stallWorker.id}:2`, state: 'running', pane: 'w1V:pNEXT', agentName: 'graphyard-opencode-4' }, stallId());
  const byId = Object.fromEntries((live.sessions ?? []).map(entry => [entry.id, entry]));
  assert.equal(byId[`${stallWorker.id}:1`]?.state, 'finished', 'the guessed record is closed in the same transaction');
  assert.match(byId[`${stallWorker.id}:1`]?.outcome ?? '', /superseded: .* runs one implementation session/);
  assert.equal(byId[`${stallWorker.id}:1`]?.pane, 'w1V:pLIVE', 'the pane the guessed record carried stays bound on it: the move closed no pane');
  assert.equal(byId[`${stallWorker.id}:2`]?.state, 'running');
  assert.equal(byId[`${stallWorker.id}:2`]?.pane, 'w1V:pNEXT');
  assert.ok(live.lease && live.lease.epoch === 1 && live.lease.expiresAt === liveExpiry, 'the attempt’s live lease is untouched by the move');
  assert.equal(live.pipeline?.attempts.at(-1)?.endedAt ?? null, null, 'the attempt stands: the move ended nothing');
  // The pane the move left behind is no longer the new session's address: the paste check the loop
  // refuses on (GY-852) names the record the pane now belongs to.
  assert.match(checkPaneStillBelongs(live, `${stallWorker.id}:2`, 'w1V:pLIVE') ?? '', /not where .* is recorded/);

  // A stall-kept lease: the pass that first meets the expired lease inside a stall it just
  // recorded keeps the lease — bounded to the renewal window, never a full lease period — with
  // the attempt's pane standing, and a supervisor's heartbeat still renews under it.
  let kept = await stallEngine.execute(human, 'create', null, stallInput('stall-kept-pane'), stallId());
  kept = await stallEngine.execute(human, 'ready', kept.id, {}, stallId());
  kept = await stallEngine.execute(stallWorker, 'claim', kept.id, {}, stallId());
  kept = await stallEngine.execute(stallCoordinator, 'session', kept.id, { ...handle, subject: `${kept.key}: stall-kept-pane`, id: `${stallWorker.id}:1`, state: 'running', pane: 'w1V:pKEPT' }, stallId());
  await stallEngine.reconcile();
  await stallStore.pool.query('UPDATE plane_liveness SET tick_at = tick_at - interval \'90 seconds\'');
  await stallEngine.reconcile();
  const [stall] = (await stallStore.pool.query(`SELECT payload->'details' AS details FROM events WHERE kind = 'plane.stall' ORDER BY seq DESC LIMIT 1`)).rows.map(row => row.details) as PlaneStall[];
  // The lease ran out inside the stall, so the next pass keeps it for the stall — whichever of the
  // ledger's recorded stalls covers the expiry this pass reads (earlier tests left their own).
  const expirySet = Date.parse(stall.to) - 45_000;
  await stallOverwrite(kept.id, document => { document.lease!.expiresAt = new Date(expirySet).toISOString(); });
  await stallEngine.reconcile();
  const stalls = (await stallStore.pool.query(`SELECT payload->'details' AS details FROM events WHERE kind = 'plane.stall' ORDER BY seq`)).rows.map(row => row.details) as PlaneStall[];
  const covering = stalls.find(entry => Date.parse(entry.from) <= expirySet && expirySet <= Date.parse(entry.to))!;
  const graced = await stallDocument(kept.id) as Work;
  const gracedLease = graced.lease as (typeof graced.lease & { renewalFault?: { at: string; error: string } }) | null;
  assert.equal(gracedLease?.renewalFault === undefined ? null : gracedLease.renewalFault?.error, `the control plane was not answering between ${covering.from} and ${covering.to}`, 'the stall’s grace is on the lease');
  const gracedExpiry = Date.parse(graced.lease!.expiresAt);
  const windowMs = (engineModule as { stallRenewalWindowMs?: number }).stallRenewalWindowMs!;
  assert.ok(Math.abs(gracedExpiry - (Date.parse(covering.to) + windowMs)) < 2_000, `the grace ends one renewal window past the stall, not a lease period later: ${graced.lease!.expiresAt}`);
  assert.ok(gracedExpiry > Date.parse(graced.updatedAt ?? covering.to), 'and past now: the lease is live');
  assert.equal(graced.pipeline?.attempts.at(-1)?.endedAt ?? null, null, 'the attempt stands under the grace');
  assert.equal(graced.sessions?.find(entry => entry.id === `${stallWorker.id}:1`)?.pane, 'w1V:pKEPT', 'the pane the live lease binds is kept while the grace holds it');
  const renewed = await stallEngine.execute(stallWorker, 'heartbeat', kept.id, { epoch: kept.epoch }, stallId());
  assert.ok(renewed.lease && Date.parse(renewed.lease.expiresAt) > Date.parse(covering.to), 'a supervisor still retrying renews through the grace');
  // Past the window the lease lapses, explained by the stall that covered its expiry: from here a
  // close of the pane binds no live lease, which is what makes the loop's close legal. The grace
  // this stall spent does not apply twice: the heartbeat cleared it, and the pass that meets the
  // expired lease again finds the marker the grace left on the lease, exactly as the soak's days
  // leave it — one grace per stall, and a lapse on the pass that finds the window closed.
  await stallOverwrite(kept.id, document => {
    document.lease!.expiresAt = new Date(Date.parse(stall.to) - 500).toISOString();
    (document.lease as { renewalFault?: unknown }).renewalFault = gracedLease!.renewalFault;
  });
  await stallEngine.reconcile();
  const lapsed = await stallDocument(kept.id) as Work;
  assert.equal(lapsed.lease ?? null, null, 'the stall-kept lease lapsed once its window closed');
  assert.deepEqual(await stallEscalations(kept.id), [], 'the lapse is history with its cause, not a lease loss');
  assert.equal(lapsed.pipeline?.attempts.at(-1)?.end, 'expired', 'the attempt ended at the lapse');
  assert.equal((await stallEvents(kept.id, 'lease.expired')).at(-1)?.cause, 'control-plane-stall');

  // The loop's own closers. 1g sights a pane whose runtime left and closes it two sightings apart,
  // and the sweep takes the shells a launch left behind; neither may take a pane whose attempt
  // still stands — an end the engine's lapse or the resume step's reclaim has yet to record —
  // whatever the lease in the cycle's snapshot reads, and never the pane a live lease's own record
  // names, which after a rekey (or a rework round that reuses the submitted attempt's workspace)
  // is a pane the claimed session runs in.
  const closerProfile = { name: 'claude-1801', principal: stallWorker.id, agentName: 'graphyard-opencode-4', mode: 'launch', kind: 'claude', credentialFile: '/outside/1801.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const directory = await temporaryDirectory('session-liveness-closer');
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(directory, 'closer.token'), cliPath: '/usr/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [closerProfile] });
  const attempt = (epoch: number, ended: boolean) => ({ epoch, owner: stallWorker.id, claimedAt: GY1791_AT(-7_200_000 - epoch * 60_000), endedAt: ended ? GY1791_AT(-300_000) : null, end: ended ? 'expired' as const : null });
  const closeHandle = (id: string, pane: string, state: 'running' | 'finished') => ({ id, kind: 'implementation', principal: stallWorker.id, runtime: 'claude', host: 'vishrog', workspace: 'w1',
    pane, attach: `herdr pane attach ${pane}`, subject: 'soak: no pane closes under a live lease', startedAt: GY1791_AT(-30 * 60_000), updatedAt: GY1791_AT(-60_000), endedAt: null, state, outcome: null } as unknown as SessionHandle);
  const guardItem = (id: string, key: string, lease: Work['lease'], attempts: ReturnType<typeof attempt>[], sessions: SessionHandle[]) => ({
    id, key, title: 'Soak: no pane closes under a live lease', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [], plannedFiles: [], stage: 'build', ready: true, createdAt: GY1791_AT(-7_200_000), updatedAt: GY1791_AT(-60_000), stageEnteredAt: GY1791_AT(-7_200_000),
    epoch: attempts.at(-1)!.epoch, lease, workspaces: [], candidate: null, submission: null, blocker: null, scopeRequest: null,
    pipeline: { attempts, submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    sessions, gates: [], violations: [], evidence: [], observation: null,
  } as unknown as Work);
  try {
    const state: DaemonState = emptyDaemonState(config);
    const closed: string[] = [], recorded: SessionHandleInput[] = [];
    const effects = { persist: async () => {}, closeSession: async (pane: string) => { closed.push(pane); }, recordSession: async (_work: Work, wrote: SessionHandleInput) => { recorded.push(wrote); } } as unknown as DaemonEffects;
    // Herdr lists another agent of the same workspace, so the handle's pane reading agentless is
    // a read workspace, not a listing that holds nothing of it: the exit the step acts on.
    const runtime = { agents: [{ name: 'graphyard-other', pane_id: 'w1:pOTHER', agent: 'claude', agent_status: 'working' }], available: true };
    const cycle = (item: Work, at: number) => ({ config, state, effects, now: () => GY1791_NOW + at, clock: GY1791_NOW + at, performed: [],
      isolate: async (_k: string, _i: unknown, _n: string, fn: () => Promise<unknown>) => fn(), snapshot: { work: [item], now: new Date(GY1791_NOW + at).toISOString() } } as unknown as Cycle);
    const pass = async (item: Work, at: number) => { await daemonSessions.closeExitedWorkerSessions!(cycle(item, at), runtime); };
    // A grace-kept lease: expiry future, attempt standing. Nothing sights, nothing closes.
    const gracedItem = guardItem('work-1801a', 'GY-1801', { owner: stallWorker.id, epoch: 1, expiresAt: GY1791_AT(3_600_000) }, [attempt(1, false)], [closeHandle(`${stallWorker.id}:1`, 'w1:pKEPT', 'running')]);
    await pass(gracedItem, 0); state.cycle += 1; await pass(gracedItem, launchAppearanceMs + 60_000);
    assert.deepEqual(closed, [], 'the pane of a live lease is never closed, however dead its runtime reads');
    assert.ok(!Object.keys(state.actions).some(key => key.startsWith('exited:implementation:')), 'the exit is not even sighted while the attempt stands');
    // The revival window: the lease reads expired, the attempt has no end yet — a pass can still
    // class the lapse or keep the lease for a stall, so the close waits all the same.
    const revivalItem = guardItem('work-1801b', 'GY-1801', { owner: stallWorker.id, epoch: 1, expiresAt: GY1791_AT(-60_000) }, [attempt(1, false)], [closeHandle(`${stallWorker.id}:1`, 'w1:pREVIVAL', 'running')]);
    await pass(revivalItem, 0); state.cycle += 1; await pass(revivalItem, launchAppearanceMs + 60_000);
    assert.deepEqual(closed, [], 'an expired lease whose attempt has no end on the record yet holds its pane');
    // The engine's lapse records the end: the same handle's pane is sighted and then closed.
    const lapsedItem = guardItem('work-1801c', 'GY-1801', null, [attempt(1, true)], [closeHandle(`${stallWorker.id}:1`, 'w1:pLAPSED', 'running')]);
    await pass(lapsedItem, 0);
    assert.ok(Object.values(state.actions).some(action => action.state === 'waiting' && /agent has exited/.test(action.detail)), 'the ended attempt’s exited pane is sighted');
    state.cycle += 1;
    await pass(lapsedItem, 2 * launchAppearanceMs);
    assert.deepEqual(closed, ['w1:pLAPSED'], 'the pane of an ended attempt closes on the second sighting');
    assert.ok(recorded.some(entry => entry.id === `${stallWorker.id}:1` && entry.state === 'finished' && /agent has exited/.test(entry.outcome ?? '')), 'the handle is closed with the reason');
    // The epoch the handle names is the one that decides: an ended attempt's pane closes even
    // while the item's next attempt stands, and a standing attempt's pane stays shut beside an
    // ended one.
    closed.length = 0;
    const mixedItem = guardItem('work-1801d', 'GY-1801', { owner: stallWorker.id, epoch: 2, expiresAt: GY1791_AT(3_600_000) }, [attempt(1, true), attempt(2, false)],
      [closeHandle(`${stallWorker.id}:1`, 'w1:pOLD', 'running'), closeHandle(`${stallWorker.id}:2`, 'w1:pCURRENT', 'running')]);
    await pass(mixedItem, 0); state.cycle += 1; await pass(mixedItem, 2 * launchAppearanceMs + 60_000);
    assert.deepEqual(closed, ['w1:pOLD'], 'the ended first attempt’s pane closes; the standing second attempt’s pane does not');

    // The sweep: the rekeyed record pair — the superseded guessed record keeps the pane the
    // claimed record runs in, whose worktree is the workspace the first claim built — never hands
    // that pane to the sweep while the claimed lease lives; a shell in a standing attempt's
    // worktree waits for the end, whatever the lease reads; an ended attempt's shell closes.
    const worktrees = '/tmp/soak/.graphyard/worktrees';
    const rekeyed = guardItem('work-1801e', 'GY-1801', { owner: stallWorker.id, epoch: 2, expiresAt: GY1791_AT(3_600_000) }, [attempt(1, true), attempt(2, false)],
      [closeHandle(`${stallWorker.id}:1`, 'w1:pREKEY', 'finished'), closeHandle(`${stallWorker.id}:2`, 'w1:pREKEY', 'running')]);
    const standingShell = guardItem('work-1802', 'GY-1802', null, [attempt(3, false)], [closeHandle(`${stallWorker.id}:3`, 'w1:pSTANDING', 'running')]);
    const endedShell = guardItem('work-1803', 'GY-1803', null, [attempt(1, true)], [closeHandle(`${stallWorker.id}:4`, 'w1:pENDED', 'running')]);
    const snapshotWork = [rekeyed, standingShell, endedShell];
    const sweepState: DaemonState = emptyDaemonState(config);
    const sweepClosed: string[] = [];
    const agents = [{ name: 'graphyard-opencode-4', pane_id: 'w1:pREKEY', agent: 'claude', agent_status: 'idle', cwd: `${worktrees}/GY-1801-1` }];
    const panes = [
      { pane_id: 'w1:pREKEY', agent: 'claude', agent_status: 'idle', cwd: `${worktrees}/GY-1801-1` },
      { pane_id: 'w1:pSTANDING', agent_status: 'unknown', cwd: `${worktrees}/GY-1802-3` },
      { pane_id: 'w1:pENDED', agent_status: 'unknown', cwd: `${worktrees}/GY-1803-1` },
    ];
    const sweepEffects = { persist: async () => {}, closeSession: async (pane: string) => { sweepClosed.push(pane); }, recordSession: async () => {}, panes: async () => ({ panes, available: true }) } as unknown as DaemonEffects;
    const sweepCycle = (at: number) => ({ config, state: sweepState, effects: sweepEffects, now: () => GY1791_NOW + at, clock: GY1791_NOW + at, performed: [],
      isolate: async (_k: string, _i: unknown, _n: string, fn: () => Promise<unknown>) => fn(), snapshot: { work: snapshotWork, now: new Date(GY1791_NOW + at).toISOString() },
      open: snapshotWork, agents, closedPanes: new Set<string>() } as unknown as Cycle);
    await reclaimLaunchedPanes(sweepCycle(0));
    assert.ok(!sweepState.actions['sweep:pane:w1:pREKEY'], 'the pane a live lease’s record names is never the sweep’s, though the superseded record that first carries it is finished');
    assert.ok(!sweepState.actions['sweep:pane:w1:pSTANDING'], 'a shell in a standing attempt’s worktree is not the sweep’s, whatever the lease reads');
    assert.equal(sweepState.actions['sweep:pane:w1:pENDED']?.state, 'waiting', 'the ended attempt’s shell is sighted for its bound');
    sweepState.cycle += 1;
    await reclaimLaunchedPanes(sweepCycle(launchAppearanceMs + 60_000));
    assert.deepEqual(sweepClosed, ['w1:pENDED'], 'the ended attempt’s shell closed past its bound; nothing else was ever taken');

    // Another host's live lease records a handle at the same pane coordinate: that is its pane,
    // not this host's, so a local leftover shell there is still swept, cycle after cycle.
    const remoteLease = guardItem('work-1804', 'GY-1804', { owner: 'graphyard-claude-9', epoch: 1, expiresAt: GY1791_AT(3_600_000) }, [attempt(1, false)],
      [{ ...closeHandle('graphyard-claude-9:1', 'w1:pSHARED', 'running'), host: 'otherhost' } as SessionHandle]);
    const leftover = guardItem('work-1805', 'GY-1805', null, [attempt(1, true)], [closeHandle(`${stallWorker.id}:5`, 'w1:pSHARED', 'running')]);
    const multiWork = [remoteLease, leftover];
    const multiState: DaemonState = emptyDaemonState(config);
    const multiClosed: string[] = [];
    const multiEffects = { persist: async () => {}, closeSession: async (pane: string) => { multiClosed.push(pane); }, recordSession: async () => {},
      panes: async () => ({ panes: [{ pane_id: 'w1:pSHARED', agent_status: 'unknown', cwd: `${worktrees}/GY-1805-1` }], available: true }) } as unknown as DaemonEffects;
    const multiCycle = (at: number) => ({ config, state: multiState, effects: multiEffects, now: () => GY1791_NOW + at, clock: GY1791_NOW + at, performed: [],
      isolate: async (_k: string, _i: unknown, _n: string, fn: () => Promise<unknown>) => fn(), snapshot: { work: multiWork, now: new Date(GY1791_NOW + at).toISOString() },
      open: multiWork, agents: [], closedPanes: new Set<string>() } as unknown as Cycle);
    await reclaimLaunchedPanes(multiCycle(0));
    multiState.cycle += 1;
    await reclaimLaunchedPanes(multiCycle(launchAppearanceMs + 60_000));
    assert.deepEqual(multiClosed, ['w1:pSHARED'], 'a live lease’s handle recorded by another host never holds this host’s leftover pane');

    // Same host: an earlier round's finished handle of an item that now holds a live lease names a
    // coordinate this host later reused for another item's ended-attempt shell; only the pane of
    // the lease's own claimed record is held, so the leftover is swept, cycle after cycle.
    const reused = guardItem('work-1806', 'GY-1806', { owner: stallWorker.id, epoch: 2, expiresAt: GY1791_AT(3_600_000) }, [attempt(1, true), attempt(2, false)],
      [closeHandle(`${stallWorker.id}:1`, 'w1:pREUSED', 'finished'), closeHandle(`${stallWorker.id}:2`, 'w1:pLIVE2', 'running')]);
    const reusedShell = guardItem('work-1807', 'GY-1807', null, [attempt(1, true)], [closeHandle(`${stallWorker.id}:7`, 'w1:pREUSED', 'running')]);
    const reusedWork = [reused, reusedShell];
    const reusedState: DaemonState = emptyDaemonState(config);
    const reusedClosed: string[] = [];
    const reusedEffects = { persist: async () => {}, closeSession: async (pane: string) => { reusedClosed.push(pane); }, recordSession: async () => {},
      panes: async () => ({ panes: [{ pane_id: 'w1:pREUSED', agent_status: 'unknown', cwd: `${worktrees}/GY-1807-1` }, { pane_id: 'w1:pLIVE2', agent_status: 'unknown', cwd: `${worktrees}/GY-1806-2` }], available: true }) } as unknown as DaemonEffects;
    const reusedCycle = (at: number) => ({ config, state: reusedState, effects: reusedEffects, now: () => GY1791_NOW + at, clock: GY1791_NOW + at, performed: [],
      isolate: async (_k: string, _i: unknown, _n: string, fn: () => Promise<unknown>) => fn(), snapshot: { work: reusedWork, now: new Date(GY1791_NOW + at).toISOString() },
      open: reusedWork, agents: [], closedPanes: new Set<string>() } as unknown as Cycle);
    await reclaimLaunchedPanes(reusedCycle(0));
    reusedState.cycle += 1;
    await reclaimLaunchedPanes(reusedCycle(launchAppearanceMs + 60_000));
    assert.deepEqual(reusedClosed, ['w1:pREUSED'], 'a finished earlier handle never holds a reused pane; the live claimed record’s pane stays shut');
  } finally { void directory; }
});
