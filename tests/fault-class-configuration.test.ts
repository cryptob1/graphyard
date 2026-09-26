import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { agentOwner, masterConfigSchema, type AttentionItem, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState, fileRecurringFaultClasses, type DaemonEffects } from '../src/master-daemon.js';
import { faultRecurrenceReport } from '../src/daemon/faults.js';
import { recurringClasses } from '../src/model/fault-classes.js';
import { trackFaults } from '../src/model/fault-tracking.js';
import { describeUnserved, startExecutorFor, type ExecutorPresence, type UnservedAction } from '../src/model/executor-presence.js';
import { attributeUnserved, executorFleetReport, type ExecutorRegistration } from '../src/executor-fleet.js';
import type { NextActionKind } from '../src/model/next-action.js';
import type { Work } from '../src/model.js';

// GY-374: the loop filed "Recurring configuration faults: 8 in 24 hours" from eight instances first
// seen in one cycle, 2026-09-25T20:18:35.111Z — the first cycle of the release that began tracking
// faults. Two causes were shared. Every line then standing (five fleet lines, the browser-profile
// setup line, the split executors, the unserved merge on GY-321) opened at once in an empty record, as
// if each had just happened. And the loop kept re-opening the same configuration: the split-executor
// line names the coordinator's commit, which every merge moves, and each item reaching merge while
// those executors waited for their restart opened one more "Nothing can run merge" instance. Each
// instance below is the text the item lists, replayed through the loop's own tracking.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const policy = { threshold: 3, windowHours: 24 };
const clock = Date.parse('2026-09-25T20:18:35.111Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}

const fleet = (text: string): AttentionItem => ({ subject: 'fleet', text, kind: 'fleet', ...agentOwner('master', 'graphyard master registry role set ROLE ACCOUNT[,ACCOUNT…] --concurrency N --reason REASON') });
const fleetLines = [
  fleet('claude-a serves no role; name it in a role or remove it'),
  ...['worker', 'reviewer', 'producer', 'escalation-handler'].map(role => fleet(`role ${role} is not configured; its sessions launch from local profiles until it is`)),
];
const browserProfile: AttentionItem = { subject: 'setup', text: 'No browser profile is configured: App permission updates, installation acceptance, and page-only protection changes cannot run through master browser until the operator lends the master a signed-in Chrome profile', ...agentOwner('master', 'graphyard master init --token-stdin --browser-profile PROFILE') };

/** exec-1 and exec-2 serve merge; both stand down on 8abcd9b23dab with no supervisor unit, as the item lists. */
function registration(name: string, standing: string): ExecutorRegistration {
  return { version: 1, name, host: 'vishrog', pid: name === 'exec-1' ? 4101 : 4102, principal: 'graphyard-executor', kinds: ['merge', 'refresh', 'proof'], intervalSeconds: 5, root: '/checkout',
    release: { commit: '8abcd9b23dab0c1d2e3f40516273849abcdef012', dirty: false }, supervisor: null, state: 'standing-down',
    standDown: { at: standing, reason: 'the coordinator runs another release', current: null, restart: 'graphyard master executors restart' },
    startedAt: '2026-09-24T20:00:00.000Z', updatedAt: standing, stoppedAt: null, claims: 12, lastClaim: null, inFlight: null, claiming: null };
}
const registrations = [registration('exec-1', '2026-09-24T22:21:30.732Z'), registration('exec-2', '2026-09-24T22:21:16.156Z')];
const live: ExecutorPresence[] = ['graphyard-master@vishrog/1', 'graphyard-master@vishrog/2'].map(executor =>
  ({ executor, host: 'vishrog', principal: 'graphyard-master', kinds: ['dispatch', 'review'] as NextActionKind[], seenAt: iso(0), claims: 0 }));
const waiting = (key: string, waitedMs: number): UnservedAction =>
  ({ key, work: `work-${key}`, id: `merge-${key}`, kind: 'merge', reason: `${key} is ready to merge`, waitedMs, since: iso(-waitedMs), start: startExecutorFor('merge') });

/** What the loop reads from `master status` for one cycle: the fleet's release line and the unserved-kind lines, attributed as reportedAttention does. */
function executorLines(coordinator: string, merging: UnservedAction[], restarted = false): AttentionItem[] {
  const releases = executorFleetReport(restarted ? registrations.map(entry => ({ ...entry, state: 'running' as const, standDown: null, release: { commit: coordinator, dirty: false } })) : registrations,
    { commit: coordinator }, { hostId: 'vishrog', alive: () => true });
  const unserved = describeUnserved({ live, unserved: merging });
  const lines = unserved.map(entry => ({ subject: entry.keys[0], text: entry.text, ...agentOwner('master', entry.start) }));
  return [...releases.attention, ...attributeUnserved(lines, unserved, releases)];
}

const observe = (state: ReturnType<typeof emptyDaemonState>, reported: AttentionItem[], at: number) =>
  trackFaults(state.faults, cycleFaults(state, [] as Work[], at, { config: config(), reported }), iso(at - clock));
const filing = () => {
  const filed: string[] = [];
  const effects = { faultClassPolicy: policy, persist: async () => {}, fileFaultClass: async (input: { title: string }) => { filed.push(input.title); return { key: 'GY-900', stage: 'backlog', origin: null } as unknown as Work; } } as unknown as DaemonEffects;
  return { filed, effects };
};

test('unit:fault-class-configuration — the eight lines standing on the first tracked cycle are the baseline, and file nothing', async () => {
  const state = emptyDaemonState(config());
  const first = [...fleetLines, ...executorLines('f7260fa41f2c9a8b7c6d5e4f3a2b1c0d9e8f7a6b', [waiting('GY-321', 32_000)]), browserProfile];
  const opened = observe(state, first, clock);
  // Every listed instance is still recorded and shown: the fleet lines, the split executors and the browser profile.
  assert.deepEqual(opened.map(entry => `${entry.kind}|${entry.subject}`).sort(), ['executor|executors', 'fleet|fleet', 'fleet|fleet', 'fleet|fleet', 'fleet|fleet', 'fleet|fleet', 'setup|setup']);
  assert.ok(opened.every(entry => entry.baseline), 'each was standing before the record began, so none is an occurrence inside the window');
  assert.equal(state.faults.since, iso(0), 'the record began with the first complete cycle');
  const { filed, effects } = filing();
  await fileRecurringFaultClasses(state, effects, [], clock, () => clock, []);
  assert.deepEqual(filed, [], 'the installation\'s state on the first cycle is not a recurring configuration fault');
  assert.deepEqual(faultRecurrenceReport(state, policy, clock).classes, []);
  // Standing on, they stay the same seven instances cycle after cycle.
  for (let cycle = 1; cycle <= 5; cycle++) assert.deepEqual(observe(state, first, clock + cycle * 90_000), []);
  // A partial first read is not the record's beginning: what it could not read is still baseline on the next, complete one.
  const partial = emptyDaemonState(config());
  trackFaults(partial.faults, cycleFaults(partial, [], clock, { config: config(), reported: fleetLines }), iso(0), true);
  assert.equal(partial.faults.since ?? null, null);
  assert.ok(observe(partial, [...fleetLines, browserProfile], clock + 90_000).every(entry => entry.baseline));
});

test('unit:fault-class-configuration — a configuration fault that appears after the record began still counts, so the baseline hides nothing new', async () => {
  const state = emptyDaemonState(config());
  observe(state, [], clock); // the record's first complete cycle: nothing standing
  const opened = observe(state, [...fleetLines, browserProfile], clock + 90_000);
  assert.equal(opened.length, 6);
  assert.ok(opened.every(entry => !entry.baseline));
  const { filed, effects } = filing();
  await fileRecurringFaultClasses(state, effects, [], clock + 90_000, () => clock, []);
  assert.deepEqual(filed, ['Recurring configuration faults: 6 in 24 hours']);
});

test('unit:fault-class-configuration — split executors are one standing fault across every release the coordinator moves to', () => {
  const state = emptyDaemonState(config());
  observe(state, [], clock);
  // The releases the coordinator ran after 20:18 while exec-1 and exec-2 waited for their restart.
  const releases = ['f7260fa41f2c1111', '4f141c984a602222', '4bb6305644f73333', '11ae54632e2c4444', 'b574e0cff6285555', 'd5dce35d70056666', 'e50f230396e27777', '22ae381881388888', '419c23e316ff9999'];
  const opened = releases.flatMap((commit, index) => observe(state, executorLines(commit, []), clock + (index + 1) * 90_000));
  assert.equal(opened.length, 1, 'the executors that need a restart are the same fault whichever commit the coordinator names');
  assert.match(opened[0].text, /^2 executors run a release other than the coordinator's [0-9a-f]{12} /);
  // Restarted onto the coordinator's release, the fault ends; standing down again later is a new instance.
  assert.deepEqual(observe(state, executorLines('419c23e316ff9999', [], true), clock + 20 * 90_000), []);
  assert.equal(observe(state, executorLines('2f76b9b7e0001111', []), clock + 21 * 90_000).length, 1);
});

test('unit:fault-class-configuration — an item waiting on merge only split executors serve restates the split, not a fault of its own', async () => {
  const state = emptyDaemonState(config());
  observe(state, [], clock);
  const merges = ['GY-321', 'GY-344', 'GY-349', 'GY-360', 'GY-200', 'GY-330', 'GY-169', 'GY-375', 'GY-274', 'GY-377', 'GY-170', 'GY-259', 'GY-394', 'GY-403'];
  const opened = merges.flatMap((key, index) => [
    ...observe(state, executorLines('f7260fa41f2c1111', [waiting(key, (index + 1) * 20_000)]), clock + (2 * index + 1) * 90_000),
    ...observe(state, executorLines('f7260fa41f2c1111', []), clock + (2 * index + 2) * 90_000),
  ]);
  assert.deepEqual(opened.map(entry => entry.subject), ['executors'], 'one fault: the executors that must be restarted');
  const { filed, effects } = filing();
  await fileRecurringFaultClasses(state, effects, [], clock + 30 * 90_000, () => clock, []);
  assert.deepEqual(filed, []);
  assert.deepEqual(recurringClasses(state.faults.instances, [], policy, clock + 30 * 90_000).map(entry => entry.count), [1]);
  // With the executors that serve merge up to date, nothing serving merge is its own fault again.
  const lines = executorLines('f7260fa41f2c1111', [waiting('GY-403', minute)], true);
  assert.deepEqual(lines.map(line => line.restates ?? null), [null]);
  assert.deepEqual(observe(state, lines, clock + 31 * 90_000).map(entry => entry.subject), ['GY-403']);
});

test('unit:fault-class-configuration — a record kept before the baseline existed has been tracking since its first instance', () => {
  const state = emptyDaemonState(config());
  observe(state, [], clock);
  observe(state, [browserProfile], clock + 90_000);
  delete state.faults.since; // as the loop's cursor was written before GY-374
  const opened = observe(state, [browserProfile, ...fleetLines], clock + 180_000);
  assert.equal(opened.length, 5);
  assert.ok(opened.every(entry => !entry.baseline), 'what opens after an upgrade is an occurrence');
  assert.equal(state.faults.since, iso(90_000));
});
