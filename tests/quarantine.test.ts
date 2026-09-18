import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containmentClockToleranceMs, containmentGraceMs, containmentSettlementRefusals, containmentVerificationSchema, type ContainmentVerification } from '../src/quarantine.js';
import { probeSupervisorAbsence, type SupervisorProbeDeps } from '../src/supervisor.js';

const now = Date.parse('2030-01-01T12:00:00.000Z');
const expired = (ms: number) => new Date(now - ms).toISOString();
const host = 'coordinator-host', path = '/srv/graphyard/worktrees/GY-45-3';
const target = { key: 'GY-45', epoch: 3, workspacePath: path };

function quarantined(overrides: Partial<{ lease: any; workspaces: any[]; quarantine: any }> = {}) {
  return {
    lease: 'lease' in overrides ? overrides.lease : { owner: 'worker-a', epoch: 3, expiresAt: expired(containmentGraceMs + 60_000) },
    workspaces: overrides.workspaces ?? [{ host, path, branch: 'graphyard/gy-45-3', epoch: 3, owner: 'worker-a' }],
    containmentQuarantine: 'quarantine' in overrides ? overrides.quarantine
      : { owner: 'worker-a', epoch: 3, at: expired(3_600_000), settlementHash: 'a'.repeat(64), launchAcknowledgedAt: expired(3_600_000), launchExpiresAt: expired(containmentGraceMs + 30_000) },
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
  assert.deepEqual(refusals(quarantined(), verification({ scopes: [{ unit: 'graphyard-watch-9-x.scope', activeState: 'inactive', processes: [] }] })), []);
});

test('an unexpired lease or launch authority refuses settlement until its grace window passes', () => {
  assert.deepEqual(refusals(quarantined({ lease: { owner: 'worker-a', epoch: 3, expiresAt: new Date(now + 60_000).toISOString() } })),
    [`Worker lease for epoch 3 has not been expired for the required ${containmentGraceMs / 1000}s grace window`]);
  assert.deepEqual(refusals(quarantined({ lease: { owner: 'worker-a', epoch: 3, expiresAt: expired(containmentGraceMs - 1_000) } })).length, 1, 'expiry inside the grace window is not yet death');
  assert.deepEqual(refusals(quarantined({ quarantine: { ...quarantined().containmentQuarantine, launchExpiresAt: expired(containmentGraceMs - 1_000) } })),
    [`Launch authority for epoch 3 has not been expired for the required ${containmentGraceMs / 1000}s grace window`]);
  assert.deepEqual(refusals(quarantined({ lease: { owner: 'worker-a', epoch: 3, expiresAt: 'not-a-time' } })).length, 1);
  assert.deepEqual(refusals(quarantined({ lease: { owner: 'worker-b', epoch: 4, expiresAt: expired(3_600_000) } })),
    ['A lease for epoch 4 supersedes quarantined epoch 3']);
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
  assert.deepEqual(refusals(quarantined(), verification({ scopes: [{ unit: 'graphyard-watch-1-a.scope', activeState: 'active', processes: [51, 52] }] })),
    ['Containment scope graphyard-watch-1-a.scope is active and still holds 2 process(es) of the assigned workspace']);
  // A live scope whose every member was inspected and works elsewhere is another assignment.
  assert.deepEqual(refusals(quarantined(), verification({ scopes: [{ unit: 'graphyard-watch-1-a.scope', activeState: 'active', processes: [] }] })), []);
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

function probeDeps(overrides: SupervisorProbeDeps = {}, processes: Record<number, { argv: string[]; uid?: number; cwd?: string }> = {}): SupervisorProbeDeps {
  const table = new Map(Object.entries(processes).map(([pid, record]) => [Number(pid), record]));
  const present = (pid: number) => { const record = table.get(pid); if (!record) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return record; };
  return {
    platform: 'linux', uid: 1000, resolvePath: value => value,
    listProcesses: () => [...table.keys()].map(String),
    readCommand: pid => present(pid).argv.join(' '),
    processOwner: pid => present(pid).uid ?? 1000,
    readCwd: pid => present(pid).cwd ?? '/',
    readCgroup: () => '',
    run: (_command, args) => args.includes('list-units') ? '' : args.includes('show-environment') ? 'LANG=C\n' : '',
    ...overrides,
  };
}

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
  const withScope = (state: string, members: string, processes: Record<number, { argv: string[]; uid?: number; cwd?: string }> = {}, extra: SupervisorProbeDeps = {}) =>
    probeSupervisorAbsence(target, probeDeps({
      run: (_command, args) => args.includes('list-units') ? '  graphyard-watch-7-abc.scope loaded active running Graphyard\n'
        : args.includes('show') ? properties('graphyard-watch-7-abc.scope', state) : '',
      readCgroup: () => members, ...extra,
    }, processes));
  const holding = withScope('active', '81\n82\n', { 81: { argv: ['claude'], cwd: path }, 82: { argv: ['sh'], cwd: '/tmp' } });
  assert.deepEqual(holding.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [81] }]);
  assert.deepEqual(withScope('inactive', '').scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'inactive', processes: [] }]);
  const emptyCgroup = probeSupervisorAbsence(target, probeDeps({
    run: (_command, args) => args.includes('list-units') ? 'graphyard-watch-7-abc.scope loaded active running Graphyard\n'
      : args.includes('show') ? properties('graphyard-watch-7-abc.scope', 'active') : '',
    readCgroup: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
  }));
  assert.deepEqual(emptyCgroup.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [] }]);
  const unreadable = probeSupervisorAbsence(target, probeDeps({
    run: (_command, args) => args.includes('list-units') ? 'graphyard-watch-7-abc.scope loaded active running Graphyard\n'
      : args.includes('show') ? properties('graphyard-watch-7-abc.scope', 'active') : '',
    readCgroup: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
  }));
  assert.match(unreadable.unverifiable[0], /Containment scope graphyard-watch-7-abc.scope could not be inspected/);
  // Inside a live containment scope an uninspectable member is a missing signal, not noise.
  const opaqueMember = withScope('active', '83\n', { 83: { argv: ['claude'] } }, { readCwd: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } });
  assert.deepEqual(opaqueMember.scopes, [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [] }]);
  assert.deepEqual(opaqueMember.unverifiable, ['Containment scope graphyard-watch-7-abc.scope holds process 83 whose working directory could not be read']);
  // Another assignment's live scope, fully inspected, does not fence this one.
  const neighbour = withScope('active', '84\n', { 84: { argv: ['claude'], cwd: '/srv/graphyard/worktrees/GY-51-2' } });
  assert.deepEqual({ scopes: neighbour.scopes, unverifiable: neighbour.unverifiable },
    { scopes: [{ unit: 'graphyard-watch-7-abc.scope', activeState: 'active', processes: [] }], unverifiable: [] });
  const stateless = probeSupervisorAbsence(target, probeDeps({
    run: (_command, args) => args.includes('list-units') ? 'graphyard-watch-7-abc.scope loaded active running Graphyard\n' : args.includes('show') ? 'LoadState=loaded\n' : '',
  }));
  assert.deepEqual(stateless.unverifiable, ['systemd reported no state for containment scope graphyard-watch-7-abc.scope']);
  const unnamed = probeSupervisorAbsence(target, probeDeps({
    run: (_command, args) => args.includes('list-units') ? 'unrelated-unit.scope loaded active running Other\n' : '',
  }));
  assert.deepEqual({ scopes: unnamed.scopes, unverifiable: unnamed.unverifiable }, { scopes: [], unverifiable: [] });
});
