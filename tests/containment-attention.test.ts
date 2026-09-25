import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDispatchable, assessContainment, buildMasterStatus, containmentHold, masterConfigSchema, type ContainmentAssessment, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { probeSupervisorAbsence } from '../src/containment-probe.js';
import { containmentSettlementRefusals, countHeldChildren, isInteractiveShell, paneShellReport, type ContainmentVerification } from '../src/quarantine.js';
import type { Work } from '../src/model.js';

const observedAt = '2030-01-01T12:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(observedAt) + offsetMs).toISOString();
const workspace = { host: 'coordinator-host', path: '/srv/worktrees/GY-74-1', branch: 'graphyard/gy-74-1', epoch: 1, owner: 'worker-a' };
const clean = { method: 'linux-proc-systemd' as const, platform: 'linux', uid: 1000, workspacePath: workspace.path, processes: [], scopes: [], held: [], recordedScope: null, inaccessible: 0, unverifiable: [] };

function item(overrides: Partial<Work> = {}): Work {
  return { id: 'id-GY-74', key: 'GY-74', title: 'Item', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/item.ts'], stage: 'build', revision: 3, policyRevision: 1, createdAt: observedAt, updatedAt: observedAt,
    stageEnteredAt: observedAt, ready: true, epoch: 1, lease: null, workspaces: [workspace], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [], ...overrides } as Work;
}
/** A supervised launch: the quarantine records the launch deadlines, and the lease is renewed past them. */
function launched(leaseExpiresAt: string | null, launchAt = at(-60_000)) {
  return item({
    lease: leaseExpiresAt ? { owner: 'worker-a', epoch: 1, expiresAt: leaseExpiresAt } : null,
    containmentQuarantine: { owner: 'worker-a', epoch: 1, at: launchAt, settlementHash: 'a'.repeat(64), launchAcknowledgedAt: launchAt, launchExpiresAt: launchAt, leaseExpiresAt: launchAt },
  } as Partial<Work>);
}
const worker = { name: 'claude-a', principal: 'worker-a', agentName: 'claude-a', mode: 'worker' } as any;
const herdr = { name: 'claude-a', agent_status: 'working', pane_id: 'p1' } as any;
const status = async (work: Work, probe = () => clean) => {
  const containment = await assessContainment([work], { hostId: 'coordinator-host', observedAt, clockOffset: { min: 0, max: 1 }, localNow: new Date(observedAt), probe } as any);
  return buildMasterStatus({ work: [work], now: observedAt }, [worker], [herdr], {}, containment);
};

test('unit:containment-attention-live-worker a renewed lease on the quarantined epoch raises no attention and is never probed', async () => {
  // The launch deadlines have passed long ago, but the worker keeps renewing its lease.
  const live = launched(at(90_000), at(-3_600_000));
  let probed = 0;
  const report = (await status(live, () => { probed++; return clean; }));
  const row = report.work[0];
  assert.equal(probed, 0, 'a live worker\'s supervisor is not inspected for absence');
  assert.equal(row.attention, null);
  assert.equal(row.attentionOwner, null);
  assert.deepEqual(report.attentionItems, []);
  assert.equal(report.counts.attention, 0);
  assert.equal(report.counts.quarantined, 0);
  assert.equal(row.owner, 'worker-a');
  assert.deepEqual({ phase: row.containment?.phase, settleable: row.containment?.settleable, attestation: row.containment?.attestation },
    { phase: 'live', settleable: false, attestation: null });
  assert.doesNotMatch(JSON.stringify(report), /blocks dispatch|grace window/);
});

test('unit:containment-attention-live-worker a lapsed lease inside the grace window raises attention with the time remaining', async () => {
  const lapsing = launched(at(-30_000));
  const row = (await status(lapsing)).work[0];
  assert.equal(row.containment?.phase, 'grace');
  assert.equal(row.containment?.graceRemainingMs, 90_000);
  assert.equal(row.containment?.settleable, false);
  assert.equal(row.attention, `Worker lease for epoch 1 lapsed at ${at(-30_000)}; containment grace window has 90s remaining before supervisor absence can be verified`);
  assert.match(row.attentionOwner!.next, /settle-containment GY-74 REASON once settleable/);
  assert.equal(row.attentionOwner!.human, false);
  // Reconciliation may already have cleared the lapsed lease; the quarantine's own deadlines still time the window.
  assert.equal((await status(launched(null, at(-30_000)))).work[0].containment?.phase, 'grace');
});

test('unit:containment-attention-live-worker a lease past its grace window names the elapsed window and the settle command once settleable', async () => {
  const stranded = launched(null, at(-600_000));
  const settleable = (await status(stranded)).work[0];
  assert.equal(settleable.containment?.phase, 'lapsed');
  assert.equal(settleable.containment?.settleable, true);
  assert.equal(settleable.attention, 'Containment quarantine from epoch 1 is verified settleable; run master settle-containment GY-74');
  assert.equal(settleable.attentionOwner!.next, 'graphyard master settle-containment GY-74 REASON');

  const held = (await status(stranded, () => ({ ...clean, processes: [{ pid: 4242, evidence: 'command' as const }] }) as any)).work[0];
  assert.equal(held.containment?.settleable, false);
  assert.match(held.attention!, new RegExp(`^Containment quarantine from epoch 1 blocks dispatch: worker lease lapsed at ${at(-600_000).replace(/\./g, '\\.')}, past the 120s grace window; Process 4242 of the contained worker is still present`));
  assert.match(held.attentionOwner!.next, /Stop the recorded supervisor/);
});

test('unit:containment-hold-wording a live worker holds dispatch as the item in progress by its owner, not as a quarantine', async () => {
  const live = launched(at(90_000));
  const hold = containmentHold(live, Date.parse(observedAt));
  assert.equal(hold, `GY-74 is in progress by worker-a under lease epoch 1 (active until ${at(90_000)})`);
  assert.doesNotMatch(hold!, /quarantin|containment/i);
  assert.throws(() => assertDispatchable(live, [live], observedAt), (error: Error) => error.message === hold);
  assert.equal((await status(live)).work[0].containment?.hold, hold);
});

test('unit:containment-hold-wording a lapsed or superseded owner still holds dispatch as unverified containment', async () => {
  const lapsed = launched(null, at(-600_000));
  assert.throws(() => assertDispatchable(lapsed, [lapsed], observedAt), /^Error: Dispatch blocked by unverified worker containment from epoch 1$/);
  // A lease held by someone else, or on another epoch, is not the contained worker at work.
  const other = { ...lapsed, lease: { owner: 'worker-b', epoch: 1, expiresAt: at(90_000) } } as Work;
  assert.equal(containmentHold(other, Date.parse(observedAt)), 'Dispatch blocked by unverified worker containment from epoch 1');
  const superseded = { ...lapsed, lease: { owner: 'worker-a', epoch: 2, expiresAt: at(90_000) } } as Work;
  assert.equal(containmentHold(superseded, Date.parse(observedAt)), 'Dispatch blocked by unverified worker containment from epoch 1');
  assert.equal(containmentHold(item(), Date.parse(observedAt)), null);
});

/**
 * GY-189: after `watch` exits, the launch pane's own interactive shell stays in the worktree.
 * It is matched by its working directory alone, so it used to hold the fence forever.
 */
const scope = { unit: 'graphyard-watch-3995651-575387af-2c89-4469-b3cd-b0b89ab52d42.scope', pid: 3995651 };
const shellPid = 4242;
const session = (pane: string) => ({ id: 'worker-a:1', kind: 'implementation', principal: 'worker-a', epoch: null, runtime: 'claude', host: 'coordinator-host', workspace: 'w1V', tab: null, pane,
  agentName: null, role: null, head: null, attach: `herdr pane attach ${pane}`, transcript: null, subject: 'GY-74: Item', startedAt: at(-3_600_000), updatedAt: at(-3_600_000), endedAt: null, state: 'running', outcome: null });

const pane = 'w1V:p2PP';
/** A quarantine whose lease and launch lapsed ten minutes ago, recorded with its launch scope and its session's pane. */
function stranded(overrides: Partial<Work> = {}) {
  const lapsed = launched(null, at(-600_000));
  return { ...lapsed, containmentQuarantine: { ...lapsed.containmentQuarantine!, scope }, sessions: [session(pane)], ...overrides } as Work;
}
/** What the host probe reports for the pane shell, with the recorded scope in the given state. */
function paneShellProbe(options: { activeState?: string; children?: number; command?: string; inScope?: boolean; stdinTerminal?: boolean; paneShell?: ContainmentVerification['paneShell'] } = {}): ContainmentVerification {
  const { activeState = 'not-found', children = 0, command = '/usr/bin/bash', inScope = false, stdinTerminal = true, paneShell = { pane, pid: shellPid, foregroundGroup: shellPid } } = options;
  return { ...clean, host: 'coordinator-host', observedAt, clockOffset: { min: 0, max: 1 },
    processes: [{ pid: shellPid, evidence: 'workspace' }],
    scopes: inScope ? [{ unit: scope.unit, activeState, processes: [shellPid], attributed: [] }] : [],
    held: [{ pid: shellPid, command, cwd: workspace.path, unit: inScope ? scope.unit : null, children, stdinTerminal }],
    recordedScope: { ...scope, activeState }, paneShell } as ContainmentVerification;
}
/** What `herdr pane process-info --pane` answers for the recorded pane. */
const herdrProcessInfo = (shell: number, foreground: number, paneId = pane) => ({ type: 'pane_process_info', process_info: { pane_id: paneId, shell_pid: shell, foreground_process_group_id: foreground, foreground_processes: [] } });
const refusals = (work: Work, verification: ContainmentVerification) => containmentSettlementRefusals(work, verification, { now: Date.parse(observedAt) });

async function loop(work: Work, overrides: Partial<DaemonEffects> = {}, carried?: DaemonState) {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-pane-shell-'));
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const profile = { name: 'opencode-1', principal: 'worker-a', agentName: 'graphyard-opencode-1', mode: 'launch', kind: 'claude', credentialFile: join(directory, 'worker.token'), agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: '/srv/graphyard/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'coordinator-host', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile] });
  const state = carried ?? emptyDaemonState(config), closed: string[] = [], settled: ContainmentAssessment[] = [];
  const effects: DaemonEffects = {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [work], now: observedAt }),
    closeSession: pane => { closed.push(pane); }, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: observedAt, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    settleContainment: async (_item, assessment) => { settled.push(assessment); },
    ...overrides,
  };
  try { await runCycle(config, state, effects, () => Date.parse(observedAt)); }
  finally { await rm(directory, { recursive: true, force: true }); }
  return { closed, settled, state };
}
const probedBy = (verification: ContainmentVerification): DaemonEffects['containment'] => (items, observed) =>
  assessContainment(items, { hostId: 'coordinator-host', observedAt: observed.now, clockOffset: { min: 0, max: 1 }, localNow: new Date(observed.now), probe: () => verification } as any);

test('unit:idle-pane-shell-not-a-worker the pane\'s childless interactive shell does not hold the fence once the recorded scope is not found, and the loop settles within one cycle', async () => {
  const work = stranded();
  assert.deepEqual(refusals(work, paneShellProbe()), [], 'an idle pane shell beside a not-found scope is no worker');
  assert.deepEqual(refusals(work, paneShellProbe({ activeState: 'inactive' })), [], 'an inactive (ended) scope is ended too');
  for (const command of ['/usr/bin/bash', '-bash', 'bash -i', '/bin/zsh -l', 'fish']) assert.equal(isInteractiveShell(command), true, command);
  for (const command of ['bash -c sleep 100', 'bash -lc watch', '/usr/bin/bash script.sh', 'node server.js', 'claude', 'bash --rcfile x', 'bash -s', 'bash -is', 'sh -', 'zsh -s arg']) assert.equal(isInteractiveShell(command), false, command);

  const { settled, state } = await loop(work, { containment: probedBy(paneShellProbe()) });
  assert.equal(settled.length, 1, 'the loop settles the quarantine in the same cycle it verified it');
  assert.equal(settled[0].settleable, true);
  assert.deepEqual(settled[0].refusals, []);
  assert.equal(state.actions[`settle:${work.id}:1`]?.state, 'done');
});

test('unit:idle-pane-shell-not-a-worker the loop counts each held process\'s live children beside the host probe, and an idle pane shell it reports settles', async () => {
  const table: Record<number, { argv: string[]; cwd: string; ppid: number }> = {
    [shellPid]: { argv: ['/usr/bin/bash'], cwd: workspace.path, ppid: 900 },
    4300: { argv: ['/usr/bin/bash'], cwd: workspace.path, ppid: 900 },
    4301: { argv: ['sleep', '100'], cwd: '/tmp', ppid: 4300 },
  };
  const present = (pid: number) => { const entry = table[pid]; if (!entry) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return entry; };
  const probed = await probeSupervisorAbsence({ key: 'GY-74', epoch: 1, workspacePath: workspace.path, scope }, {
    platform: 'linux', uid: 1000, resolvePath: value => value, listProcesses: () => Object.keys(table),
    readCommand: pid => present(pid).argv.join('\0'), processOwner: () => 1000, readCwd: pid => present(pid).cwd, readParent: pid => present(pid).ppid, readCgroup: () => '',
    run: (_command, args) => args.includes('show') ? 'LoadState=not-found\nActiveState=inactive\n' : args.includes('show-environment') ? 'LANG=C\n' : '',
  });
  const stdin: Record<number, string> = { [shellPid]: '/dev/pts/7', 4300: '/dev/pts/8' };
  const table$ = { listProcesses: () => Object.keys(table), readParent: (pid: number) => present(pid).ppid, readStdin: (pid: number) => stdin[pid] ?? '/dev/null' };
  const report = countHeldChildren(probed, table$);
  assert.deepEqual(report.held.map(entry => [entry.pid, entry.children, entry.stdinTerminal]), [[shellPid, 0, true], [4300, 1, true]]);
  // A parent that cannot be read leaves every count out: nothing is proven idle.
  const unread = countHeldChildren(probed, { ...table$, readParent: pid => { if (pid === 4301) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return present(pid).ppid; } });
  assert.deepEqual(unread.held.map(entry => entry.children), [undefined, undefined]);
  // `bash < script` reads a file, not its terminal; an unreadable fd 0 proves nothing (review of a1939bd7).
  const redirected = countHeldChildren(probed, { ...table$, readStdin: pid => pid === shellPid ? `${workspace.path}/script.sh` : stdin[pid] });
  assert.deepEqual(redirected.held.map(entry => entry.stdinTerminal), [false, true]);
  const unreadable = countHeldChildren(probed, { ...table$, readStdin: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  assert.deepEqual(unreadable.held.map(entry => entry.stdinTerminal), [undefined, undefined]);
  assert.equal(report.recordedScope?.activeState, 'not-found');
  const verification = { ...report, host: 'coordinator-host', observedAt, clockOffset: { min: 0, max: 1 }, paneShell: paneShellReport(pane, herdrProcessInfo(shellPid, shellPid)) } as ContainmentVerification;
  assert.deepEqual(refusals(stranded(), verification), [`Process 4300 of the contained worker is still present on coordinator-host (matched by assigned workspace); pid 4300 cmdline "/usr/bin/bash" cwd ${workspace.path}`],
    'the idle shell is excused; the shell running sleep still holds the fence');
});

test('unit:idle-pane-shell-not-a-worker a shell with a child process, a live scope, or no child count still refuses settlement', async () => {
  const work = stranded();
  const still = /Process 4242 of the contained worker is still present on coordinator-host \(matched by assigned workspace\); pid 4242 cmdline "/;
  assert.match(refusals(work, paneShellProbe({ children: 1 })).join('\n'), still, 'a shell running something may be running the worker');
  assert.match(refusals(work, paneShellProbe({ activeState: 'active' })).join('\n'), still, 'a live scope means the supervisor is still there');
  assert.match(refusals(work, paneShellProbe({ activeState: 'active', inScope: true })).join('\n'), /Containment scope .* is active and still holds 1 process/);
  const uncounted = paneShellProbe();
  delete uncounted.held[0].children;
  assert.match(refusals(work, uncounted).join('\n'), still, 'a probe that did not count children proves nothing about idleness');
  assert.match(refusals(work, paneShellProbe({ command: 'bash -c sleep 100' })).join('\n'), still, 'a shell running a command is not idle');
  // The excused shell must be the recorded pane's own shell, idle at its prompt (review of 9d8e1240).
  assert.match(refusals(work, paneShellProbe({ paneShell: { pane, pid: 5555, foregroundGroup: 5555 } })).join('\n'), still, 'a childless shell in the worktree that is not the pane\'s shell is unrelated and still holds the fence');
  assert.match(refusals(work, paneShellProbe({ paneShell: { pane, pid: shellPid, foregroundGroup: 6000 } })).join('\n'), still, 'a pane shell with a foreground job in front of it is not idle');
  assert.match(refusals(work, paneShellProbe({ paneShell: { pane: 'w1V:pOTHER', pid: shellPid, foregroundGroup: shellPid } })).join('\n'), still, 'another pane\'s shell proves nothing about the recorded session');
  assert.match(refusals(work, paneShellProbe({ paneShell: null })).join('\n'), still, 'a pane Herdr could not read proves nothing');
  assert.match(refusals(stranded({ sessions: [] } as Partial<Work>), paneShellProbe()).join('\n'), still, 'without a recorded session pane nothing ties the shell to the worker');
  assert.match(refusals(work, paneShellProbe({ command: 'bash -s' })).join('\n'), still, 'a shell reading a script from stdin is not idle');
  // `bash < script` shows a bare `bash` command line; only a terminal on fd 0 makes it a prompt (review of a1939bd7).
  assert.match(refusals(work, paneShellProbe({ stdinTerminal: false })).join('\n'), still, 'a shell executing a script redirected into its stdin is not idle');
  const unreadStdin = paneShellProbe();
  delete unreadStdin.held[0].stdinTerminal;
  assert.match(refusals(work, unreadStdin).join('\n'), still, 'a probe that could not read the shell\'s stdin proves nothing about idleness');
  assert.equal(paneShellReport(pane, herdrProcessInfo(shellPid, shellPid, 'w1V:pOTHER')), null, 'an answer about another pane is ignored');
  assert.equal(paneShellReport(pane, { process_info: { pane_id: pane, shell_pid: 'x' } }), null);
  assert.deepEqual(paneShellReport(pane, herdrProcessInfo(shellPid, shellPid)), { pane, pid: shellPid, foregroundGroup: shellPid });
  const unscoped = { ...work, containmentQuarantine: { ...work.containmentQuarantine!, scope: undefined } } as Work;
  assert.match(refusals(unscoped, { ...paneShellProbe(), recordedScope: null }).join('\n'), still, 'without a recorded scope nothing proves the supervisor ended');

  const { settled, state } = await loop(work, { containment: probedBy(paneShellProbe({ children: 1 })) });
  assert.deepEqual(settled, [], 'the loop does not settle while the shell has a child');
  assert.match(state.actions[`escalation:containment:${work.id}:1`]?.detail ?? '', still);
});

test('unit:ended-worker-pane-closed the loop closes the Herdr pane of a worker whose supervisor scope has ended, once', async () => {
  const work = stranded();
  const ended = await loop(work, { containment: probedBy(paneShellProbe()) });
  assert.deepEqual(ended.closed, ['w1V:p2PP'], 'the pane of the ended worker is closed by the session cleanup');
  const action = ended.state.actions[`close:ended-scope:${work.id}:1:w1V:p2PP`];
  assert.equal(action?.state, 'done');
  assert.match(action!.detail, /Closed pane w1V:p2PP of GY-74 epoch 1: its supervisor scope graphyard-watch-3995651-.*\.scope is not-found/);

  // A pane Herdr already closed settles the same record, and says so.
  const gone = await loop(work, { containment: probedBy(paneShellProbe({ activeState: 'failed' })), closeSession: () => { throw new Error('herdr: pane_not_found w1V:p2PP'); } });
  assert.match(gone.state.actions[`close:ended-scope:${work.id}:1:w1V:p2PP`]?.detail ?? '', /^Pane was already gone w1V:p2PP/);
});

test('unit:ended-worker-pane-closed a close that fails keeps the fence up, and a later cycle retries it before settling', async () => {
  const work = stranded(), key = `close:ended-scope:${work.id}:1:w1V:p2PP`;
  const failed = await loop(work, { containment: probedBy(paneShellProbe()), closeSession: () => { throw new Error('herdr: server unavailable'); } });
  assert.equal(failed.state.actions[key]?.state, 'failed');
  assert.match(failed.state.actions[key]!.detail, /Could not close pane w1V:p2PP of GY-74 epoch 1 .*herdr: server unavailable; the containment quarantine stays until it is closed/);
  assert.deepEqual(failed.settled, [], 'the excused shell\'s pane is still open, so the quarantine is not settled');
  assert.equal(failed.state.actions[`settle:${work.id}:1`], undefined);

  // The quarantine is still there on the next cycle, so the close is retried; once it is done the fence comes down.
  const retried = await loop(work, { containment: probedBy(paneShellProbe()) }, failed.state);
  assert.deepEqual(retried.closed, ['w1V:p2PP']);
  assert.equal(retried.state.actions[key]?.state, 'done');
  assert.equal(retried.state.actions[key]?.attempts, 2);
  assert.equal(retried.settled.length, 1);
  assert.equal(retried.state.actions[`settle:${work.id}:1`]?.state, 'done');
});

test('unit:ended-worker-pane-closed settlement after a close comes only from a probe taken once the pane is gone', async () => {
  const work = stranded(), key = `close:ended-scope:${work.id}:1:w1V:p2PP`;
  // The shell started a background job after the first probe counted its children, and the job survives the pane close.
  const probes: string[][] = [];
  let paneOpen = true;
  const sequenced: DaemonEffects['containment'] = (items, observed) => {
    probes.push(items.map(item => item.key));
    return probedBy(paneOpen ? paneShellProbe() : paneShellProbe({ children: 1, paneShell: null }))!(items, observed);
  };
  const first = await loop(work, { containment: sequenced, closeSession: pane => { assert.equal(pane, 'w1V:p2PP'); paneOpen = false; } });
  assert.deepEqual(probes, [['GY-74'], ['GY-74']], 'the closed pane\'s item is probed again after the close');
  assert.equal(first.state.actions[key]?.state, 'done');
  assert.deepEqual(first.settled, [], 'the pre-close assessment that excused the shell never lowers the fence');
  assert.equal(first.state.actions[`settle:${work.id}:1`], undefined);
  assert.equal(first.state.actions[`escalation:containment:${work.id}:1`], undefined, 'the next cycle\'s probe, not the re-probe, decides whether to escalate');

  // The next cycle probes again; the survivor still holds the fence and is escalated, not settled.
  const next = await loop(work, { containment: sequenced, closeSession: () => { throw new Error('closed twice'); } }, first.state);
  assert.deepEqual(next.settled, []);
  assert.match(next.state.actions[`escalation:containment:${work.id}:1`]?.detail ?? '', /Process 4242 of the contained worker is still present/);

  // A re-probe that finds nothing left settles in the same cycle, from that fresh assessment.
  let reprobed = 0;
  const clean = await loop(work, { containment: (items, observed) => { reprobed += 1; return probedBy(paneShellProbe())!(items, observed); } });
  assert.equal(reprobed, 2);
  assert.equal(clean.settled.length, 1);
  assert.equal(clean.state.actions[`settle:${work.id}:1`]?.state, 'done');
});

test('unit:ended-worker-pane-closed a pane whose supervisor scope is still live is left alone', async () => {
  const work = stranded();
  for (const activeState of ['active', 'activating', 'deactivating', 'unqueried']) {
    const live = await loop(work, { containment: probedBy(paneShellProbe({ activeState })) });
    assert.deepEqual(live.closed, [], `a ${activeState} scope keeps its pane`);
  }
  // A verification of some other scope says nothing about this pane's supervisor.
  const other = await loop(work, { containment: probedBy({ ...paneShellProbe(), recordedScope: { unit: 'graphyard-watch-1-other.scope', pid: 1, activeState: 'not-found' } }) });
  assert.deepEqual(other.closed, []);
  // A live worker is never probed, so its pane is never closed.
  const renewing = await loop({ ...work, lease: { owner: 'worker-a', epoch: 1, expiresAt: at(90_000) } } as Work, { containment: probedBy(paneShellProbe()) });
  assert.deepEqual(renewing.closed, []);
});

test('unit:ended-worker-pane-closed only a pane the host probe found idle in this worktree is closed, whatever the session ledger names', async () => {
  // The worker can write its own session handle: pointed at another agent's pane, whose shell
  // Herdr reports outside this worktree, the ledger alone never gets that pane closed.
  const other = 'w1V:pOTHER', spoofed = stranded({ sessions: [session(other)] } as Partial<Work>);
  const foreign = await loop(spoofed, { containment: probedBy(paneShellProbe({ paneShell: { pane: other, pid: 7777, foregroundGroup: 7777 } })) });
  assert.deepEqual(foreign.closed, [], 'a pane whose shell is not in the worktree belongs to someone else');
  assert.deepEqual(foreign.settled, []);
  const unread = await loop(stranded(), { containment: probedBy(paneShellProbe({ paneShell: null })) });
  assert.deepEqual(unread.closed, [], 'a pane Herdr could not read is not proven to be this worker\'s');
  for (const busy of [{ children: 1 }, { command: 'bash -c sleep 100' }, { stdinTerminal: false }, { paneShell: { pane, pid: shellPid, foregroundGroup: 6000 } }]) {
    const running = await loop(stranded(), { containment: probedBy(paneShellProbe(busy)) });
    assert.deepEqual(running.closed, [], `a pane shell running something is left for the fence to report: ${JSON.stringify(busy)}`);
  }
  const idle = await loop(stranded(), { containment: probedBy(paneShellProbe()) });
  assert.deepEqual(idle.closed, [pane]);
});
