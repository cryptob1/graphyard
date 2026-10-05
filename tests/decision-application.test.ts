import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { actionableSubjects, approvalStep, approvalWatchSchema, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { approverSettleMs } from '../src/daemon/decisions.js';
import { applyKey, maxApplyAttempts } from '../src/daemon/cycle-approvers.js';
import * as metrics from '../src/daemon/metrics.js';

const { approverWait, approverWaitWording } = metrics;
import { decisionKey } from '../src/daemon/reconcile.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1298: a two-party decision an approver approved but whose application recorded no outcome
// stood 'approved' forever. Only its own approver could resume it, the loop put it to another
// approver, and every later request of the action was refused "already approved; wait for it" —
// GY-949's rework stood approved for 2.5 days behind an approver account out of quota. The loop
// now applies a judged decision itself, the control plane reconciles a standing approval instead
// of refusing a re-request, and the silence measure names the apply owed, not an approver's
// judgement. Each test is named for the proof it produces.

const minute = 60_000, clock = Date.parse('2026-10-05T12:40:00.000Z'), iso = (at: number) => new Date(at).toISOString();
const head = 'a'.repeat(40), base = 'b'.repeat(40), tip = 'e'.repeat(40), branch = 'graphyard/gy-949-1';
const profile = { name: 'worker-0', principal: 'principal-0', agentName: 'graphyard-worker-0', mode: 'launch', kind: 'claude', credentialFile: '/srv/credentials/worker-0.token', agentArgs: [], approvals: 'auto', environment: {} } as unknown as WorkerProfile;
const loopConfig = () => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/srv/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
  githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile], run: { intervalSeconds: 300 } }) as MasterConfig;

/** A submitted candidate whose base refresh conflicts: only a fresh attempt resolves it, so it needs a rework. */
function conflicted(): Work {
  const candidate = { sha: head, baseSha: base, pr: 42, branch, author: 'worker' };
  return {
    id: 'work-GY-949', key: 'GY-949', title: 'Conflicted candidate', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/loop.ts'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true }, stage: 'merge', ready: true, epoch: 1,
    revision: 7, policyRevision: 1, createdAt: iso(clock - 72 * 60 * minute), updatedAt: iso(clock - minute), stageEnteredAt: iso(clock - 48 * 60 * minute), lease: null, workspaces: [],
    submission: { epoch: 1, pr: 42 }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], containmentQuarantine: null,
    observation: { clockOffset: { min: 0, max: 0 }, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: false, merged: false, mergeSha: null,
      files: ['src/loop.ts'], scopeFiles: [], at: iso(clock - 30_000), prState: 'open', draft: false, baseTip: tip, baseTipContained: false },
    baseRefresh: { from: { sha: head, baseSha: base }, base: tip, baseTree: 'f'.repeat(40), policyRevision: 1, at: iso(clock - 47 * 60 * minute), head: null, conflict: 'merging main into the candidate conflicts in src/loop.ts', carry: null },
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'merge', passed: false, reasons: ['Pull request is not mergeable against the current base'] }],
  } as unknown as Work;
}
/** The same item once its rework is applied: the attempt is ended and the candidate goes back to a worker. */
const reworked = (): Work => ({ ...conflicted(), stage: 'build', reworkRequested: true, revision: 8, gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] }) as unknown as Work;

/** The rework decision GY-949 held: approved 2.5 days ago by an approver whose session ended before applying it. */
const approvedRework = () => ({ id: randomUUID(), action: 'rework', state: 'approved', input: { previousWorkerStopped: true, binding: `${head}:conflict` }, requestedBy: 'graphyard-master-operator', requestedAt: iso(clock - 61 * 60 * minute),
  reason: 'GY-949: the base refresh conflicts', precedent: [], situation: { sha: head, baseSha: base }, approvedBy: 'graphyard-approver-graphyard', approvedAt: iso(clock - 60 * 60 * minute), approvalReason: 'Only a fresh attempt resolves the conflict', outcome: null });

type Apply = NonNullable<DaemonEffects['applyDecision']>;
function loop(decision: ReturnType<typeof approvedRework>, apply?: Apply) {
  const config = loopConfig(), state = emptyDaemonState(config);
  let item = conflicted();
  const applied: { decision: string; reason: string }[] = [], dispatched: string[] = [], requested: string[] = [], approvers: string[] = [];
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), stopSupervisor: () => {},
    credentials: async (configured: WorkerProfile[]) => Object.fromEntries(configured.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [item], now: iso(clock), jobs: [] }),
    closeSession: () => {}, requestProof: () => {}, merge: async () => ({}),
    dispatch: async (work: Work) => { dispatched.push(work.key); return {}; },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(clock), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (work: Work, action: string) => { requested.push(action); return { id: randomUUID() }; },
    decisions: async () => ({ decisions: [decision] }),
    withdraw: async () => {},
    // The control plane applies the recorded approval: the rework is applied and the item returns to a worker.
    applyDecision: apply ?? (async (_work: Work, id: string, reason: string) => {
      applied.push({ decision: id, reason });
      Object.assign(decision, { state: 'applied', outcome: 'Rework authorized' }); item = reworked();
      return { id, state: 'applied', outcome: 'Rework authorized' };
    }),
    approver: async () => { approvers.push('launched'); return { agentName: 'graphyard-approver-gy-949', pane: 'pane-1' }; },
    persist: async () => {},
  } as unknown as DaemonEffects;
  return { state, applied, dispatched, requested, approvers, run: () => runCycle(config, state, effects, () => clock) };
}

test('unit:approved-decision-applies-on-cycle — an approved-unapplied rework on a conflicted item is applied by the loop, and the item is dispatched to a worker within one cycle', async () => {
  // Adopted: no watch of the loop's holds it (requested by hand, or the loop's state was lost).
  // Supervised: the loop's own watch, whose approver session is gone without applying it.
  for (const watched of [false, true]) {
    const decision = approvedRework(), harness = loop(decision);
    if (watched) {
      const key = decisionKey(conflicted(), { action: 'rework', reason: '', binding: `${head}:conflict` } as never);
      harness.state.approvals[key] = approvalWatchSchema.parse({ work: 'GY-949', action: 'rework', decision: decision.id, requestedAt: iso(clock - 61 * 60 * minute), agentName: 'graphyard-approver-gy-949', launchedAt: iso(clock - 61 * 60 * minute), launches: 1 });
    }
    await harness.run();
    assert.deepEqual(harness.applied.map(entry => entry.decision), [decision.id], `${watched ? 'supervised' : 'adopted'}: the loop applies the approved decision on its next cycle`);
    assert.match(harness.applied[0].reason, /approved by graphyard-approver-graphyard at .* never applied/);
    assert.deepEqual(harness.approvers, [], 'no approver session is launched to judge it again');
    assert.deepEqual(harness.requested, [], 'and no second rework is requested');
    const settled = Object.values(harness.state.approvals).find(watch => watch.decision === decision.id);
    assert.ok(settled?.settledAt, 'the watch is settled by the application');
    // The very next cycle dispatches the reworked item to a worker, without operator action.
    await harness.run();
    assert.deepEqual(harness.dispatched, ['GY-949'], `${watched ? 'supervised' : 'adopted'}: the item is dispatched within one cycle of the application`);
  }
});

test('unit:approved-decision-applies-on-cycle — an approved decision is never put to another approver: the loop applies it once its approver had the settle window', () => {
  const watch = approvalWatchSchema.parse({ work: 'GY-949', action: 'rework', decision: randomUUID(), requestedAt: iso(clock - 10 * minute), agentName: 'graphyard-approver-gy-949', launchedAt: iso(clock - 10 * minute), launches: 3 });
  const sessions = { agents: [], available: false };
  const approved = (approvedAt: number) => ({ state: 'approved', approvedBy: 'approver-agent', approvedAt: iso(approvedAt) });
  // Even with every launch spent and Herdr unreadable, a judged decision is applied, not relaunched or escalated.
  assert.equal(approvalStep(watch, approved(clock - approverSettleMs), sessions, clock).step, 'apply');
  assert.match(approvalStep(watch, approved(clock - approverSettleMs), sessions, clock).detail, /was approved by approver-agent at .* and never applied/);
  assert.equal(approvalStep(watch, { state: 'approved', approvedBy: 'approver-agent', approvedAt: null }, sessions, clock).step, 'apply', 'an approval with no recorded time is applied at once');
  // Its own approver applies it in the moments after approving it; the loop does not race that.
  assert.equal(approvalStep(watch, approved(clock - 1_000), sessions, clock).step, 'wait');
  // A requested decision is still the approver's to judge.
  assert.equal(approvalStep(watch, { state: 'requested' }, { agents: [], available: true }, clock).step, 'exhausted');
});

test('unit:approved-decision-applies-on-cycle — an application the control plane supersedes is requested again for the current candidate', async () => {
  const decision = approvedRework();
  const harness = loop(decision, async (_work, id) => { Object.assign(decision, { state: 'stale', outcome: 'the candidate moved' }); return { id, state: 'stale', outcome: 'the candidate moved' }; });
  await harness.run();
  assert.deepEqual(harness.applied, [], 'nothing was applied');
  assert.deepEqual(harness.requested, ['rework'], 'the superseded approval is replaced by a request for the current candidate');
});

test('unit:approved-decision-applies-on-cycle — a failing application is retried on the widening interval, escalated once its bound is spent, and applied once the control plane recovers', async () => {
  // The control plane cannot apply it (it throws, or answers it still approved), then recovers.
  const decision = approvedRework(), calls: number[] = [];
  let failing = true, cycleNo = 0;
  const harness = loop(decision, async (_work, id) => {
    calls.push(cycleNo);
    if (failing) { if (calls.length % 2) throw new Error('the control plane is unreachable: timeout'); return { id, state: 'approved' }; }
    Object.assign(decision, { state: 'applied', outcome: 'Rework authorized' });
    return { id, state: 'applied', outcome: 'Rework authorized' };
  });
  const cycles = 12;
  for (cycleNo = 1; cycleNo <= cycles; cycleNo += 1) await harness.run();
  // Never every cycle: attempts on cycles 1, 2, 4, 8 — each failure doubles the wait.
  assert.deepEqual(calls, [1, 2, 4, 8], 'the apply backs off on the widening retry interval');
  const escalations = Object.entries(harness.state.actions).filter(([key]) => key === `escalation:decision-unapplied:${decision.id}`);
  assert.equal(escalations.length, 1, 'escalated once the bound is spent');
  assert.equal(escalations[0][1].kind, 'escalation');
  assert.match(escalations[0][1].detail, new RegExp(`${maxApplyAttempts} applications by the loop have failed.*graphyard master approve GY-949 ${decision.id}`));
  assert.equal(harness.state.actions[applyKey(decision.id)].attempts, 4, 'one failed action per attempt, not per cycle');
  assert.deepEqual(harness.approvers, [], 'no approver session is launched to judge it again');
  assert.deepEqual(harness.requested, [], 'and no second rework is requested');
  assert.equal(Object.keys(harness.state.approvals).length, 1, 'one watch, not one per cycle');
  // The control plane recovers: the next retry on the interval applies it, and nothing more is attempted.
  failing = false;
  for (; cycleNo <= cycles + 20; cycleNo += 1) await harness.run();
  assert.equal(calls.length, 5, 'applied on the next retry, then never called again');
  assert.ok(Object.values(harness.state.approvals)[0].settledAt, 'the watch is settled');
  assert.equal(Object.keys(harness.state.actions).filter(key => key.startsWith('escalation:')).length, 1, 'no further escalation');
});

test('unit:loop-silence-decision-state — a decision approved but never applied is named as such, with its approvedAt, not as waiting for an approver to judge it', () => {
  const config = loopConfig(), item = conflicted();
  const key = decisionKey(item, { action: 'rework', reason: '', binding: `${head}:conflict` } as never);
  const watch = approvalWatchSchema.parse({ work: 'GY-949', action: 'rework', decision: 'decision-949', requestedAt: iso(clock - 61 * 60 * minute), agentName: 'graphyard-approver-gy-949', launchedAt: iso(clock - 61 * 60 * minute), launches: 1 });
  const subject = (approvals: Record<string, typeof watch>) => actionableSubjects(config, [item], clock, { approvals }).find(entry => entry.kind === 'decision' && entry.work === 'GY-949')!;
  // Unjudged, it waits on its approver session, and that wait is the approver's (a decision fault).
  const waiting = subject({ [key]: watch });
  assert.match(waiting.detail, new RegExp(`${approverWaitWording.waiting} graphyard-approver-gy-949 to judge it`));
  assert.equal(approverWait(waiting), true);
  // Judged: the loop's supervision recorded the approval on the watch, and the subject names it.
  const approvedAt = iso(clock - 60 * 60 * minute);
  const approved = subject({ [key]: { ...watch, approvedAt, approvedBy: 'graphyard-approver-graphyard' } });
  assert.match(approved.detail, new RegExp(`decision decision-949 ${(metrics as { approvedUnappliedWording?: string }).approvedUnappliedWording ?? 'is approved but unapplied: approved at'} ${approvedAt.replace(/[.]/g, '\\.')} by graphyard-approver-graphyard; the loop applies it`));
  assert.doesNotMatch(approved.detail, /to judge it/, 'it is not said to wait for an approver to judge it');
  assert.equal(approverWait(approved), false, 'the apply is owed by the loop, so it is not read as an approver’s wait');
});

test('unit:loop-silence-decision-state — the loop records the approval on its watch while the decision stands approved', async () => {
  const decision = approvedRework(), harness = loop(decision);
  const key = decisionKey(conflicted(), { action: 'rework', reason: '', binding: `${head}:conflict` } as never);
  // Approved a moment ago: its approver may still be applying it, so the loop only notes the state.
  Object.assign(decision, { approvedAt: iso(clock - 5_000) });
  harness.state.approvals[key] = approvalWatchSchema.parse({ work: 'GY-949', action: 'rework', decision: decision.id, requestedAt: iso(clock - 20 * minute), agentName: 'graphyard-approver-gy-949', launchedAt: iso(clock - 20 * minute), launches: 1 });
  await harness.run();
  assert.deepEqual(harness.applied, []);
  assert.equal(harness.state.approvals[key].approvedAt, decision.approvedAt);
  assert.equal(harness.state.approvals[key].approvedBy, 'graphyard-approver-graphyard');
});

// ---- The control plane (AC-2) --------------------------------------------------------------
let teardown: (() => Promise<void>) | null = null;
after(async () => { await teardown?.(); });
const observed = (paths: string[], sha = head): Observation => ({
  candidate: { sha, baseSha: base, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' }, checks: [{ name: 'test', result: 'success', appId: 15368 }],
  reviews: [{ reviewer: 'reviewer', sha, state: 'CHANGES_REQUESTED' }], merged: false, mergeSha: null, mergeable: true, protected: true, files: paths, at: new Date().toISOString(),
  scopeFiles: paths.map(path => ({ path, status: 'modified' as const, sha: 'c'.repeat(40), additions: 1, deletions: 1, binary: false })),
}) as Observation;

async function controlPlane() {
  const repository = 'owner/applications';
  const operator: Principal = { id: 'apply-operator', role: 'admin', sessionKind: 'human' };
  const implementer: Principal = { id: 'apply-implementer', role: 'worker', sessionKind: 'ai' };
  const credentials = [operator, implementer].map(principal => ({ ...principal, token: `apply-${principal.id}-${'x'.repeat(32)}` }));
  const master = { id: 'apply-master', token: `apply-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'decision:rework'] };
  const approver = { id: 'apply-approver', token: `apply-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1298;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('decision-application'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('application_test');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/application_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  const http = server(engine, credentials);
  teardown = async () => { http.close(); await store.close(); await database.stop(); };
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const send = async (token: string, path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const decisions = async (key: string) => (await (await fetch(`${url}/api/work/${key}/decisions`, { headers: { Authorization: `Bearer ${master.token}` } })).json() as { decisions: any[] }).decisions;
  for (const agent of [master, approver]) {
    const provisioned = await send(credentials[0].token, 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions agent identities' });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
  }
  let pr = 1290;
  /** A high-lane submitted candidate: its rework waits for an independent approver. */
  const submitted = async (title: string) => {
    const paths = [`src/server/routes/${title}.ts`];
    const created = await send(master.token, 'work', { title, plannedFiles: paths, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Application fixture' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    let work = await engine.execute(operator, 'ready', created.body.id, {}, randomUUID());
    work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
    work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'apply-host', path: `/tmp/applications/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
    work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: ++pr }, randomUUID());
    return engine.observe(work.id, work.revision, { ...observed(paths), candidate: { ...observed(paths).candidate, pr, branch: work.workspaces.at(-1)!.branch } });
  };
  /** The approver approves the rework and its session ends before the application: approved, no outcome. */
  const stranded = async (title: string) => {
    const work = await submitted(title);
    assert.equal(work.lane, 'high');
    const requested = await send(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The reviewer requested changes' });
    assert.equal(requested.body.state, 'requested', JSON.stringify(requested.body));
    const execute = engine.execute;
    engine.execute = (async (...args: Parameters<typeof execute>) => {
      if (args[1] === 'rework') { engine.execute = execute; throw new Error('the approver session ended while applying the rework'); }
      return execute.apply(engine, args);
    }) as typeof execute;
    const approval = await send(approver.token, `work/${work.key}/approve`, { decision: requested.body.id, reason: 'The verdict stands on this head' });
    engine.execute = execute;
    assert.notEqual(approval.status, 200, 'the interrupted application answers no outcome');
    const [standing] = await decisions(work.key);
    assert.deepEqual([standing.state, standing.approvedBy, standing.outcome], ['approved', approver.id, null]);
    return { work, standing };
  };
  return { engine, store, send, decisions, stranded, master, approver };
}
let fixture: ReturnType<typeof controlPlane> | null = null;
const plane = () => fixture ??= controlPlane();

test('unit:approved-rework-rerequest-reconciles — a re-request while an approved rework stands for the same candidate applies it instead of refusing "wait for it"', { timeout: 120_000 }, async () => {
  const { store, send, decisions, stranded, master } = await plane();
  const { work, standing } = await stranded('same-candidate');
  const again = await send(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The reviewer requested changes; re-requested' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.doesNotMatch(JSON.stringify(again.body), /wait for it/);
  assert.equal(again.body.id, standing.id, 'the standing approval answers the request');
  assert.equal(again.body.state, 'applied');
  assert.equal(again.body.approvedBy, standing.approvedBy, 'under its recorded approver');
  assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, true, 'and the item goes back to a worker');
  assert.equal((await decisions(work.key)).length, 1, 'no second decision is recorded');
});

test('unit:approved-rework-rerequest-reconciles — once the candidate moved, the approved rework is superseded and the re-request is recorded for the current candidate', { timeout: 120_000 }, async () => {
  const { engine, store, send, decisions, stranded, master } = await plane();
  const { work, standing } = await stranded('moved-candidate');
  // The candidate moves after the approval (a new head, as GY-949's c7c93c895f68): the approval judged one that no longer stands.
  const current = (await store.list()).find(item => item.id === work.id)!, moved = observed(current.plannedFiles, '9'.repeat(40));
  const pushed = await engine.observe(work.id, current.revision, { ...moved, candidate: { ...moved.candidate, pr: current.candidate!.pr, branch: current.candidate!.branch } });
  assert.equal(pushed.candidate?.sha, '9'.repeat(40), 'the candidate moved');
  const again = await send(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The reviewer requested changes on the current head' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.notEqual(again.body.id, standing.id, 'a new decision is recorded for the current candidate');
  assert.equal(again.body.state, 'requested', 'and waits for its own approver');
  const superseded = (await decisions(work.key)).find(entry => entry.id === standing.id);
  assert.equal(superseded.state, 'stale');
  assert.match(superseded.outcome, /candidate moved from aaaaaaaaaaaa on bbbbbbbbbbbb to 999999999999 .* never applied; superseded/);
  assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, false, 'nothing was applied for the head the approval judged');
});

test('unit:approved-decision-applies-on-cycle — the loop’s apply call applies a standing approval under its recorded approver, once', { timeout: 120_000 }, async () => {
  const { store, send, decisions, stranded, master, approver } = await plane();
  const { work, standing } = await stranded('loop-apply');
  // An identity without the action's authority cannot apply it.
  const refused = await send(approver.token, `work/${work.key}/decide`, { action: 'apply', decision: standing.id, reason: 'not mine to apply' });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  const applied = await send(master.token, `work/${work.key}/decide`, { action: 'apply', decision: standing.id, reason: 'The loop applies the recorded approval' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual([applied.body.id, applied.body.state, applied.body.approvedBy], [standing.id, 'applied', approver.id]);
  assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, true);
  // Applying it again answers it as it stands, and records no second outcome.
  const repeated = await send(master.token, `work/${work.key}/decide`, { action: 'apply', decision: standing.id, reason: 'The loop applies the recorded approval' });
  assert.equal(repeated.body.state, 'applied');
  assert.equal((await decisions(work.key)).filter(entry => entry.id === standing.id).length, 1);
});
