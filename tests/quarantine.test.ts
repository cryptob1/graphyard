import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containmentClockToleranceMs, containmentGraceMs, containmentSettlementRefusals, containmentVerificationSchema, type ContainmentVerification } from '../src/quarantine.js';
import { probeSupervisorAbsence, scopeSupervisorPid, type SupervisorProbeDeps } from '../src/containment-probe.js';

const now = Date.parse('2030-01-01T12:00:00.000Z');
const expired = (ms: number) => new Date(now - ms).toISOString();
const host = 'coordinator-host', path = '/srv/graphyard/worktrees/GY-45-3';
const target = { key: 'GY-45', epoch: 3, workspacePath: path };

function quarantined(overrides: Partial<{ lease: any; workspaces: any[]; quarantine: any }> = {}) {
  return {
    lease: 'lease' in overrides ? overrides.lease : { owner: 'worker-a', epoch: 3, expiresAt: expired(containmentGraceMs + 60_000) },
    workspaces: overrides.workspaces ?? [{ host, path, branch: 'graphyard/gy-45-3', epoch: 3, owner: 'worker-a' }],
    containmentQuarantine: 'quarantine' in overrides ? overrides.quarantine
      : { owner: 'worker-a', epoch: 3, at: expired(3_600_000), settlementHash: 'a'.repeat(64), launchAcknowledgedAt: expired(3_600_000),
        launchExpiresAt: expired(containmentGraceMs + 30_000), leaseExpiresAt: expired(containmentGraceMs + 60_000) },
  };
}
function verification(overrides: Partial<ContainmentVerification> = {}): ContainmentVerification {
  return containmentVerificationSchema.parse({
    method: 'linux-proc-systemd', host, uid: 1000, platform: 'linux', workspacePath: path,
    observedAt: new Date(now - 1_000).toISOString(), clockOffset: { min: -40, max: 60 },
    processes: [], scopes: [], inaccessible: 0, unverifiable: [], ...overrides,
  });
}
const refusals = (work: ReturnType<typeof quarantined>, record = verification()) => containmentSettlementRefusals(work as any, record, { now });

test('verified supervisor death is the only state that authorizes automatic settlement', () => {
  assert.deepEqual(refusals(quarantined()), []);
  // An acknowledgement that never happened leaves no launch authority to expire.
  assert.deepEqual(refusals(quarantined({ quarantine: { owner: 'worker-a', epoch: 3, at: expired(3_600_000), settlementHash: 'a'.repeat(64) } })), []);
  assert.deepEqual(refusals(quarantined({ lease: null })), []);
  assert.deepEqual(refusals(quarantined(), verification({ scopes: [{ unit: 'graphyard-watch-9-x.scope', activeState: 'inactive', processes: [], attributed: [] }] })), []);
});

test('an unexpired lease or launch authority refuses settlement until its grace window passes', () => {
  const graceSeconds = containmentGraceMs / 1000;
  assert.deepEqual(refusals(quarantined({ lease: { owner: 'worker-a', epoch: 3, expiresAt: new Date(now + 60_000).toISOString() } })),
    [`Worker lease for epoch 3 has not been expired for the required ${graceSeconds}s grace window`]);
  assert.deepEqual(refusals(quarantined({ lease: { owner: 'worker-a', epoch: 3, expiresAt: expired(containmentGraceMs - 1_000) } })).length, 1, 'expiry inside the grace window is not yet death');
  assert.deepEqual(refusals(quarantined({ quarantine: { ...quarantined().containmentQuarantine, launchExpiresAt: expired(containmentGraceMs - 1_000) } })),
    [`Launch authority for epoch 3 has not been expired for the required ${graceSeconds}s grace window`]);
  assert.deepEqual(refusals(quarantined({ lease: { owner: 'worker-a', epoch: 3, expiresAt: 'not-a-time' } })),
    ['Worker lease for epoch 3 carries no readable expiry']);
  assert.deepEqual(refusals(quarantined({ lease: { owner: 'worker-b', epoch: 4, expiresAt: expired(3_600_000) } })),
    ['A lease for epoch 4 supersedes quarantined epoch 3']);

  // Reconciliation clears an expired lease long before the grace window closes, so the
  // deadline the quarantine retained is what the window is measured from.
  const retained = (leaseExpiresAt: string | undefined) =>
    refusals(quarantined({ lease: null, quarantine: { ...quarantined().containmentQuarantine, leaseExpiresAt } }));
  assert.deepEqual(retained(expired(containmentGraceMs - 1_000)),
    [`Worker lease for epoch 3 has not been expired for the required ${graceSeconds}s grace window`], 'a cleared lease record does not skip the window');
  assert.deepEqual(retained(new Date(now + 60_000).toISOString()).length, 1);
  assert.deepEqual(retained(expired(containmentGraceMs + 1_000)), []);
  assert.deepEqual(retained(undefined),
    [`Quarantined epoch 3 records no worker-lease deadline, so its ${graceSeconds}s grace window cannot be established`]);
  // Whichever deadline is later rules: neither record can shorten the other's window.
  assert.deepEqual(refusals(quarantined({ lease: { owner: 'worker-a', epoch: 3, expiresAt: expired(containmentGraceMs - 1_000) },
    quarantine: { ...quarantined().containmentQuarantine, leaseExpiresAt: expired(containmentGraceMs + 600_000) } })).length, 1);
  assert.deepEqual(refusals(quarantined({ lease: { owner: 'worker-a', epoch: 3, expiresAt: expired(containmentGraceMs + 600_000) },
    quarantine: { ...quarantined().containmentQuarantine, leaseExpiresAt: expired(containmentGraceMs - 1_000) } })).length, 1);
});

test('settlement is bound to the registered workspace of the quarantined epoch', () => {
  assert.deepEqual(refusals(quarantined({ quarantine: null })), ['No containment quarantine is recorded for this task']);
  assert.deepEqual(refusals(quarantined({ workspaces: [] })), ['Epoch 3 registered no workspace, so its supervisor has no verifiable host']);
  assert.deepEqual(refusals(quarantined({ workspaces: [{ host: 'other-host', path, branch: 'b', epoch: 3, owner: 'worker-a' }] })),
    [`Verification ran on host ${host}; epoch 3 is registered on other-host`]);
  assert.deepEqual(refusals(quarantined({ workspaces: [{ host, path: '/srv/elsewhere', branch: 'b', epoch: 3, owner: 'worker-a' }] })),
    [`Verification inspected ${path}; epoch 3 is registered at /srv/elsewhere`]);
  assert.deepEqual(refusals(quarantined({ workspaces: [{ host, path, branch: 'b', epoch: 2, owner: 'worker-a' }] })).length, 1, 'another epoch workspace is not this epoch');
});

test('a live process, live scope, or incomplete probe refuses instead of assuming death', () => {
  assert.deepEqual(refusals(quarantined(), verification({ processes: [{ pid: 4242, evidence: 'command' }] })),
    [`Process 4242 of the contained worker is still present on ${host} (matched by supervisor command line)`]);
  assert.deepEqual(refusals(quarantined(), verification({ processes: [{ pid: 77, evidence: 'workspace' }] })),
    [`Process 77 of the contained worker is still present on ${host} (matched by assigned workspace)`]);
  assert.deepEqual(refusals(quarantined(), verification({ scopes: [{ unit: 'graphyard-watch-1-a.scope', activeState: 'active', processes: [51, 52], attributed: [] }] })),
    ['Containment scope graphyard-watch-1-a.scope is active and still holds 2 process(es) that are not attributed to another assignment']);
  // A live scope holds another assignment only when every member it kept was attributed to one.
  assert.deepEqual(refusals(quarantined(), verification({ scopes: [{ unit: 'graphyard-watch-1-a.scope', activeState: 'active', processes: [], attributed: [51] }] })), []);
  assert.deepEqual(refusals(quarantined(), verification({ scopes: [{ unit: 'graphyard-watch-1-a.scope', activeState: 'active', processes: [52], attributed: [51] }] })).length, 1);
  assert.deepEqual(refusals(quarantined(), verification({ unverifiable: ['Containment scope graphyard-watch-1-a.scope holds process 51 whose working directory could not be read'] })).length, 1);
  // Privileged host processes outside every containment scope are recorded, not guessed at.
  assert.deepEqual(refusals(quarantined(), verification({ inaccessible: 12 })), []);
  assert.deepEqual(refusals(quarantined(), verification({ unverifiable: ['systemd user manager is unavailable'] })),
    ['Host verification was incomplete: systemd user manager is unavailable']);
  assert.deepEqual(refusals(quarantined(), verification({ platform: 'darwin' })),
    ['Supervisor absence was not established by Linux process and scope inspection; the host reports darwin']);
});

test('a stale, future, or unbounded observation is not evidence about the present', () => {
  assert.deepEqual(refusals(quarantined(), verification({ observedAt: new Date(now - 180_000).toISOString() })),
    ['Host verification is older than 120s; verify the host again']);
  assert.deepEqual(refusals(quarantined(), verification({ observedAt: new Date(now + 60_000).toISOString() })),
    ['Host verification is dated after the control-plane clock; clocks disagree']);
  assert.deepEqual(refusals(quarantined(), verification({ clockOffset: { min: 20_000, max: 20_050 } })),
    [`Verifying host clock differs from the control plane by more than ${containmentClockToleranceMs}ms; clocks disagree`]);
  assert.deepEqual(refusals(quarantined(), verification({ clockOffset: { min: -60_000, max: -59_000 } })).length, 1);
  assert.deepEqual(refusals(quarantined(), verification({ clockOffset: { min: -1_000, max: 30_000 } })),
    [`Verifying host could not bound its clock against the control plane within ${containmentClockToleranceMs}ms`]);
  assert.deepEqual(refusals(quarantined(), verification({ clockOffset: { min: 100, max: -100 } })),
    ['Host verification reported inconsistent clock bounds']);
});

type FakeProcess = { argv: string[]; uid?: number; cwd?: string; ppid?: number };
function probeDeps(overrides: SupervisorProbeDeps = {}, processes: Record<number, FakeProcess> = {}): SupervisorProbeDeps {
  const table = new Map(Object.entries(processes).map(([pid, record]) => [Number(pid), record]));
  const present = (pid: number) => { const record = table.get(pid); if (!record) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return record; };
  return {
    platform: 'linux', uid: 1000, resolvePath: value => value,
    listProcesses: () => [...table.keys()].map(String),
    readCommand: pid => present(pid).argv.join('\0'),
    processOwner: pid => present(pid).uid ?? 1000,
    readCwd: pid => present(pid).cwd ?? '/',
    // Unparented processes were reparented away from whatever started them.
    readParent: pid => present(pid).ppid ?? 1,
    readCgroup: () => '',
    run: (_command, args) => args.includes('list-units') ? '' : args.includes('show-environment') ? 'LANG=C\n' : '',
    ...overrides,
  };
}
const supervisorOf = (key: string, epoch: number) => ['node', '/opt/graphyard/bin/graphyard.mjs', 'watch', key, String(epoch), '--', 'claude'];

test('host probing reports a dead supervisor only when every signal was collected', () => {
  const clean = probeSupervisorAbsence(target, probeDeps({}, { 10: { argv: ['/usr/bin/bash'] }, 11: { argv: ['node', 'server.js'], cwd: '/srv/other' } }));
  assert.deepEqual({ processes: clean.processes, scopes: clean.scopes, unverifiable: clean.unverifiable }, { processes: [], scopes: [], unverifiable: [] });
  assert.deepEqual({ method: clean.method, platform: clean.platform, uid: clean.uid, workspacePath: clean.workspacePath },
    { method: 'linux-proc-systemd', platform: 'linux', uid: 1000, workspacePath: path });
  assert.deepEqual(containmentSettlementRefusals(quarantined() as any, verification({ ...clean, host, observedAt: new Date(now).toISOString(), clockOffset: { min: 0, max: 5 } }), { now }), []);
});

test('a surviving supervisor or workspace process is detected regardless of its owner', () => {
  const supervisor = probeSupervisorAbsence(target, probeDeps({}, {
    42: { argv: ['node', '/opt/graphyard/bin/graphyard.mjs', 'watch', 'GY-45', '3', '--', 'claude'], uid: 65_534 },
  }));
  assert.deepEqual(supervisor.processes, [{ pid: 42, evidence: 'command' }]);
  assert.deepEqual(supervisor.unverifiable, []);
  const agent = probeSupervisorAbsence(target, probeDeps({}, { 43: { argv: ['claude'], cwd: `${path}/src` } }));
  assert.deepEqual(agent.processes, [{ pid: 43, evidence: 'workspace' }]);
  // Another epoch's supervisor and another user's unrelated process are not this fence.
  const unrelated = probeSupervisorAbsence(target, probeDeps({}, {
    44: { argv: ['node', 'graphyard.mjs', 'watch', 'GY-45', '2', '--', 'claude'] },
    45: { argv: ['claude'], uid: 65_534, cwd: `${path}/src` },
  }));
  assert.deepEqual(unrelated.processes, []);
});

test('an unreadable process, scope query, or systemd manager stays unverifiable', () => {
  // A privileged process outside every containment scope cannot be the contained worker,
  // so it is counted rather than treated as a surviving one or as a missing signal.
  const denied = probeSupervisorAbsence(target, probeDeps({ readCwd: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } }, { 50: { argv: ['claude'] } }));
  assert.deepEqual({ processes: denied.processes, inaccessible: denied.inaccessible, unverifiable: denied.unverifiable }, { processes: [], inaccessible: 1, unverifiable: [] });
  const table = probeSupervisorAbsence(target, probeDeps({ listProcesses: () => { throw new Error('proc is not mounted'); } }));
  assert.match(table.unverifiable[0], /Host process table could not be read: proc is not mounted/);
  const noManager = probeSupervisorAbsence(target, probeDeps({ run: () => { throw new Error('Failed to connect to bus'); } }));
  assert.match(noManager.unverifiable[0], /systemd user manager is unavailable/);
  const listing = probeSupervisorAbsence(target, probeDeps({ run: (_c, args) => { if (args.includes('list-units')) throw new Error('systemctl exited 1'); return ''; } }));
  assert.match(listing.unverifiable[0], /Containment scope query failed: systemctl exited 1/);
  assert.deepEqual(probeSupervisorAbsence(target, probeDeps({ platform: 'darwin' })).unverifiable,
    ['Supervisor absence requires Linux process and systemd scope inspection; this host reports darwin']);
  const vanishing = probeSupervisorAbsence(target, probeDeps({ readCommand: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } }, { 60: { argv: ['claude'] } }));
  assert.deepEqual({ processes: vanishing.processes, unverifiable: vanishing.unverifiable }, { processes: [], unverifiable: [] });
});

test('containment scopes are attributed to the assigned workspace before they are dismissed', () => {
  const properties = (unit: string, state: string, group = `/user.slice/${unit}`) => `LoadState=loaded\nActiveState=${state}\nControlGroup=${group}\n`;
  const withScope = (state: string, members: string, processes: Record<number, FakeProcess> = {}, extra: SupervisorProbeDeps = {}) =>
    probeSupervisorAbsence(target, probeDeps({
      run: (_command, args) => args.includes('list-units') ? '  graphyard-watch-7-abc.scope loaded active running Graphyard\n'
        : args.includes('show') ? properties('graphyard-watch-7-abc.scope', state) : '',
      readCgroup: () => members, ...extra,
    }, processes));
  // A member working outside the workspace is not thereby another assignment's: the scope
  // name carries the supervisor's PID, never the work key, so it cannot excuse anyone.
  const holding = withScope('active', '81\n82\n', { 81: { argv: ['claude'], cwd: path }, 82: { argv: ['sh'], cwd: '/tmp' } });
  assert.deepEqual(holding.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [81, 82], attributed: [] }]);
  assert.deepEqual(withScope('inactive', '').scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'inactive', processes: [], attributed: [] }]);
  const emptyCgroup = probeSupervisorAbsence(target, probeDeps({
    run: (_command, args) => args.includes('list-units') ? 'graphyard-watch-7-abc.scope loaded active running Graphyard\n'
      : args.includes('show') ? properties('graphyard-watch-7-abc.scope', 'active') : '',
    readCgroup: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
  }));
  assert.deepEqual(emptyCgroup.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [], attributed: [] }]);
  const unreadable = probeSupervisorAbsence(target, probeDeps({
    run: (_command, args) => args.includes('list-units') ? 'graphyard-watch-7-abc.scope loaded active running Graphyard\n'
      : args.includes('show') ? properties('graphyard-watch-7-abc.scope', 'active') : '',
    readCgroup: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
  }));
  assert.match(unreadable.unverifiable[0], /Containment scope graphyard-watch-7-abc.scope could not be inspected/);
  // Inside a live containment scope an uninspectable member holds the fence up.
  const opaqueMember = withScope('active', '83\n', { 83: { argv: ['claude'] } }, { readCwd: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } });
  assert.deepEqual(opaqueMember.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [83], attributed: [] }]);
  // A member that exited while the scope was being read is gone, not a survivor.
  const departed = withScope('active', '83\n', {}, { readCwd: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
  assert.deepEqual(departed.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [], attributed: [] }]);
  // Another assignment's live scope is dismissed only by the supervisor its members descend
  // from: a different work key or epoch, read from that live process's own command line.
  const neighbour = withScope('active', '84\n', { 84: { argv: ['claude'], cwd: '/srv/graphyard/worktrees/GY-51-2', ppid: 90 }, 90: { argv: supervisorOf('GY-51', 2) } });
  assert.deepEqual({ scopes: neighbour.scopes, unverifiable: neighbour.unverifiable },
    { scopes: [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [], attributed: [84] }], unverifiable: [] });
  // The same scope, whose supervisor died and left the worker reparented, still fences.
  const orphan = withScope('active', '84\n', { 84: { argv: ['claude'], cwd: '/srv/graphyard/worktrees/GY-51-2', ppid: 1 } });
  assert.deepEqual(orphan.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [84], attributed: [] }]);
  // This assignment's own supervisor never attributes its descendants elsewhere.
  const ours = withScope('active', '85\n', { 85: { argv: ['claude'], cwd: '/tmp', ppid: 91 }, 91: { argv: supervisorOf(target.key, target.epoch) } });
  assert.deepEqual(ours.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [85], attributed: [] }]);
  // An ordinary command that merely carries a 'watch' argument attributes nothing.
  const lookalike = withScope('active', '86\n', { 86: { argv: ['claude'], cwd: '/tmp', ppid: 92 }, 92: { argv: ['npm', 'run', 'watch', 'GY-51', '2'] } });
  assert.deepEqual(lookalike.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [86], attributed: [] }]);
  // Ancestry is followed past intermediate processes and survives a broken parent link.
  const nested = withScope('active', '87\n', { 87: { argv: ['bash'], cwd: '/tmp', ppid: 88 }, 88: { argv: ['claude'], ppid: 93 }, 93: { argv: supervisorOf('GY-51', 2) } });
  assert.deepEqual(nested.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [], attributed: [87] }]);
  const broken = withScope('active', '87\n', { 87: { argv: ['bash'], cwd: '/tmp', ppid: 88 } });
  assert.deepEqual(broken.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [87], attributed: [] }]);
  const stateless = probeSupervisorAbsence(target, probeDeps({
    run: (_command, args) => args.includes('list-units') ? 'graphyard-watch-7-abc.scope loaded active running Graphyard\n' : args.includes('show') ? 'LoadState=loaded\n' : '',
  }));
  assert.deepEqual(stateless.unverifiable, ['systemd reported no state for containment scope graphyard-watch-7-abc.scope']);
  const unnamed = probeSupervisorAbsence(target, probeDeps({
    run: (_command, args) => args.includes('list-units') ? 'unrelated-unit.scope loaded active running Other\n' : '',
  }));
  assert.deepEqual({ scopes: unnamed.scopes, unverifiable: unnamed.unverifiable }, { scopes: [], unverifiable: [] });
});

test('unit:containment-scope-attribution: the recorded scope is held whole, a neighbour scope is attributed to its own live supervisor, and every held process is reported with cmdline and cwd', () => {
  const ours = 'graphyard-watch-7000-abc.scope', theirs = 'graphyard-watch-7100-def.scope';
  const otherWorkspace = '/srv/graphyard/worktrees/GY-39-1';
  const recorded = { ...target, scope: { unit: ours, pid: 7000 } };
  const units: Record<string, { state: string; members: string }> = {};
  const deps = (processes: Record<number, FakeProcess>, extra: SupervisorProbeDeps = {}) => probeDeps({
    run: (_command, args) => {
      if (args.includes('list-units')) return Object.keys(units).map(unit => `${unit} loaded active running Graphyard\n`).join('');
      if (args.includes('show')) {
        const unit = args.at(-1)!;
        return units[unit] ? `LoadState=loaded\nActiveState=${units[unit].state}\nControlGroup=/user.slice/${unit}\n` : 'LoadState=not-found\nActiveState=inactive\n';
      }
      return '';
    },
    readCgroup: group => units[group.slice('/user.slice/'.length)]?.members ?? '',
    ...extra,
  }, processes);
  // GY-59's settlement named GY-39's scope: the GY-39 cursor session had reparented away from
  // its supervisor, so ancestry could not attribute it. Its scope name carries the live GY-39
  // supervisor's pid, working from GY-39's workspace, and that attributes the whole scope.
  units[theirs] = { state: 'active', members: '81\n82\n' };
  const neighbour = probeSupervisorAbsence(recorded, deps({
    7100: { argv: supervisorOf('GY-39', 1), cwd: otherWorkspace },
    81: { argv: ['cursor-agent', '--profile', 'claude'], cwd: otherWorkspace, ppid: 1 },
    82: { argv: ['node', 'mcp-server.js'], cwd: `${otherWorkspace}/tools`, ppid: 81 },
  }));
  assert.deepEqual(neighbour.scopes, [{ unit: theirs, activeState: 'active', processes: [], attributed: [81, 82] }]);
  assert.deepEqual({ held: neighbour.held, recordedScope: neighbour.recordedScope, unverifiable: neighbour.unverifiable },
    { held: [], recordedScope: { unit: ours, pid: 7000, activeState: 'not-found' }, unverifiable: [] }, 'the recorded scope is reported gone even though systemd no longer lists it');
  assert.deepEqual(containmentSettlementRefusals(quarantined({ quarantine: { ...quarantined().containmentQuarantine, scope: { unit: ours, pid: 7000 } } }) as any,
    verification({ ...neighbour, host, observedAt: new Date(now).toISOString(), clockOffset: { min: 0, max: 5 } }), { now }), []);
  // A member of the neighbour's scope working inside this workspace is never excused.
  const intruder = probeSupervisorAbsence(recorded, deps({ 7100: { argv: supervisorOf('GY-39', 1), cwd: otherWorkspace }, 81: { argv: ['claude'], cwd: `${path}/src`, ppid: 1 } }));
  assert.deepEqual(intruder.scopes, [{ unit: theirs, activeState: 'active', processes: [81], attributed: [] }]);
  assert.deepEqual(intruder.held, [{ pid: 81, command: 'claude', cwd: `${path}/src`, unit: theirs }]);
  // The scope's supervisor must be alive, be a supervisor, and work outside this workspace: a
  // dead or reused pid, a look-alike command, or this assignment's own supervisor attributes nothing.
  for (const supervisor of [undefined, { argv: ['npm', 'run', 'watch', 'GY-39', '1'] }, { argv: supervisorOf('GY-39', 1), cwd: path }, { argv: supervisorOf(target.key, target.epoch), cwd: path }] as (FakeProcess | undefined)[]) {
    const orphaned = probeSupervisorAbsence(recorded, deps({ ...(supervisor ? { 7100: supervisor } : {}), 81: { argv: ['cursor-agent'], cwd: otherWorkspace, ppid: 1 } } as Record<number, FakeProcess>));
    assert.deepEqual(orphaned.scopes, [{ unit: theirs, activeState: 'active', processes: [81], attributed: [] }]);
    assert.deepEqual(orphaned.held.filter(entry => entry.pid === 81), [{ pid: 81, command: 'cursor-agent', cwd: otherWorkspace, unit: theirs }]);
  }
  // Ancestry still attributes a member whose scope supervisor cannot be read.
  const byAncestry = probeSupervisorAbsence(recorded, deps({ 81: { argv: ['cursor-agent'], cwd: otherWorkspace, ppid: 90 }, 90: { argv: supervisorOf('GY-51', 2) } }));
  assert.deepEqual(byAncestry.scopes, [{ unit: theirs, activeState: 'active', processes: [], attributed: [81] }]);

  // This assignment's recorded scope is held whole: a member working elsewhere, even one whose
  // ancestry reaches another assignment's supervisor, is still this containment's.
  units[ours] = { state: 'active', members: '61\n62\n' };
  delete units[theirs];
  const own = probeSupervisorAbsence(recorded, deps({
    61: { argv: ['claude', '--resume'], cwd: '/tmp/scratch', ppid: 90 }, 90: { argv: supervisorOf('GY-51', 2) },
    62: { argv: ['bash'], cwd: `${path}/src` },
  }, { readCwd: pid => pid === 62 ? `${path}/src` : pid === 61 ? '/tmp/scratch' : (() => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); })() }));
  assert.deepEqual(own.scopes, [{ unit: ours, activeState: 'active', processes: [61, 62], attributed: [] }]);
  assert.deepEqual(own.recordedScope, { unit: ours, pid: 7000, activeState: 'active' });
  assert.deepEqual(own.held, [{ pid: 62, command: 'bash', cwd: `${path}/src`, unit: ours }, { pid: 61, command: 'claude --resume', cwd: '/tmp/scratch', unit: ours }], 'a workspace process is found first, then the rest of the scope');
  // Without a recorded scope the same scope is judged member by member, as before.
  const legacy = probeSupervisorAbsence(target, deps({ 61: { argv: ['claude', '--resume'], cwd: '/tmp/scratch', ppid: 90 }, 90: { argv: supervisorOf('GY-51', 2) }, 62: { argv: ['bash'], cwd: `${path}/src` } }));
  assert.deepEqual(legacy.scopes, [{ unit: ours, activeState: 'active', processes: [62], attributed: [61] }]);
  assert.equal(legacy.recordedScope, null);
  // The settlement report prints each held process's cmdline and cwd, names the recorded scope,
  // and refuses a verification that did not inspect the recorded scope at all.
  const work = quarantined({ quarantine: { ...quarantined().containmentQuarantine, scope: { unit: ours, pid: 7000 } } }) as any;
  const refusals = containmentSettlementRefusals(work, verification({ ...own, host, observedAt: new Date(now).toISOString(), clockOffset: { min: 0, max: 5 } }), { now });
  assert.deepEqual(refusals, [
    `Process 62 of the contained worker is still present on coordinator-host (matched by assigned workspace); pid 62 cmdline "bash" cwd ${path}/src`,
    `Containment scope ${ours} (the scope epoch 3 was launched in) is active and still holds 2 process(es) that are not attributed to another assignment; pid 61 cmdline "claude --resume" cwd /tmp/scratch; pid 62 cmdline "bash" cwd ${path}/src`,
  ]);
  delete units[ours];
  const survivor = probeSupervisorAbsence(recorded, deps({ 42: { argv: supervisorOf(target.key, target.epoch), cwd: path } }, { readCwd: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } }));
  assert.deepEqual(survivor.held, [{ pid: 42, command: supervisorOf(target.key, target.epoch).join(' '), cwd: null, unit: null }]);
  assert.match(containmentSettlementRefusals(work, verification({ ...survivor, host, observedAt: new Date(now).toISOString(), clockOffset: { min: 0, max: 5 } }), { now }).join('\n'),
    /Process 42 of the contained worker is still present on coordinator-host \(matched by supervisor command line\); pid 42 cmdline "node \/opt\/graphyard\/bin\/graphyard.mjs watch GY-45 3 -- claude" cwd <unreadable>/);
  assert.deepEqual(containmentSettlementRefusals(work, verification(), { now }), [`Host verification did not inspect recorded containment scope ${ours} (supervisor pid 7000) of epoch 3`]);
  assert.deepEqual(containmentSettlementRefusals(work, verification({ recordedScope: { unit: theirs, pid: 7100, activeState: 'not-found' } }), { now }), [`Host verification did not inspect recorded containment scope ${ours} (supervisor pid 7000) of epoch 3`]);
  assert.deepEqual(containmentSettlementRefusals(work, verification({ recordedScope: { unit: ours, pid: 7000, activeState: 'not-found' } }), { now }), []);
  // A quarantine that recorded no scope is settled by the member-by-member rule alone.
  assert.deepEqual(containmentSettlementRefusals(quarantined() as any, verification({ recordedScope: null }), { now }), []);
  assert.deepEqual(scopeSupervisorPid(ours), 7000);
  assert.deepEqual(scopeSupervisorPid('graphyard-watch-x-abc.scope'), null);
});
