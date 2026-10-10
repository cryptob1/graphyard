import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { alignmentInMotionUntil, executorFleetReport, type ExecutorRegistration, type FleetAlignment } from '../src/executor-fleet.js';
import { owedUpgrade, selfUpgradeBoundMs } from '../src/master-resources.js';
import { heldCliPointer, readHeldCli } from '../src/daemon/upgrade.js';

// GY-1619 names this file for its proof: manual:fault-class-configuration. The master loop filed 3 configuration
// faults in 24 hours on 9-10 October 2026, each on subject `executors`: "2 executors run a release other than the
// coordinator's <tip> and claim nothing until restarted". Every one was a release advance under way. The loop's
// self-upgrade had checked the coordinator checkout out at the merged tip and held the fleet restart (GY-1585)
// until production served it; the executors ran the pinned snapshot of the release production served (the loaded
// commit is that release in each instance, an ancestor of the tip), and the restart completed minutes later — the
// cursor shows `upgrade:7460bb74…` restarted at 23:07:14 and `upgrade:f2220fe0…` at 00:22:07 after the hold lifted.
//
// The shared cause: executorFleetReport judged the fleet against the checkout's commit alone, with no reference to
// the loop's own alignment, so every advance's checkout-then-restart window was one new configuration fault.
//
// Each instance is replayed as the loop stood when it recorded it: the fleet registrations, the cursor's owed
// restart and held stall, and the held-CLI pin. Against the base (no alignment read) the split reproduces as a
// configuration fault; against the candidate it is the alignment in motion — or, read with the pin, no split at all —
// while a split nothing is fixing still counts.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-project',
  autoMerge: true, mergeMethod: 'merge', workers: [],
});

interface Instance { id: string; observedAt: string; coordinator: string; loaded: string; movedAt: string; restarted: string }
const instances: Instance[] = [
  { id: 'executor|executors|2026-10-09T20:25:00.623Z', observedAt: '2026-10-09T20:25:00.623Z', coordinator: '07094753fccc8fa95d201a0da7ba0e1db4994056', loaded: '173346baeb32d71eb3bcfd7ce1ec93237944ecb4', movedAt: '2026-10-09T20:24:10.000Z', restarted: 'held until production served #1069' },
  { id: 'executor|executors|2026-10-09T22:53:01.470Z', observedAt: '2026-10-09T22:53:01.470Z', coordinator: '7460bb74c8b85e6a2fb13334f26003d95e6158fe', loaded: '80fb3e97a54dcaa73a9ce2088c583ffac5d78d0e', movedAt: '2026-10-09T22:52:08.262Z', restarted: 'restarted 23:07:14' },
  { id: 'executor|executors|2026-10-10T00:13:46.202Z', observedAt: '2026-10-10T00:13:46.202Z', coordinator: 'f2220fe045fc8dc3d905c3d3f432ca8247ce6140', loaded: '87f0d5d1d150b4d1b94a06640d56f13fd58fc2eb', movedAt: '2026-10-10T00:12:51.281Z', restarted: 'hold lifted 00:21:59, restarted 00:22:07' },
];

const registration = (slot: number, loaded: string, at: string): ExecutorRegistration => ({
  version: 1, name: `graphyard-master@vishrog/${slot}`, host: 'vishrog', pid: 4000 + slot, principal: 'graphyard-master', kinds: ['dispatch'], intervalSeconds: 15,
  root: '/home/vish/code/graphyard', release: { commit: loaded, dirty: false }, supervisor: { unit: `graphyard-executor@${slot}.service`, restart: `systemctl --user restart graphyard-executor@${slot}.service` },
  state: 'running', standDown: null, startedAt: at, updatedAt: at, stoppedAt: null, claims: 3, lastClaim: null, inFlight: null, claiming: null,
});
const fleet = (entry: Instance) => [1, 2].map(slot => registration(slot, entry.loaded, entry.movedAt));

/** The loop's cursor at the instant: the checkout moved to the tip, the restart onto it held while production serves the loaded release. */
function cursor(entry: Instance, overrides: { attemptedAt?: string; stalled?: DaemonState['upgrade']['stalled'] | null; pending?: boolean } = {}): DaemonState {
  const state = emptyDaemonState(config()), attempted = overrides.attemptedAt ?? entry.movedAt;
  if (overrides.pending !== false) state.upgrade.pending = { from: null, to: entry.coordinator, code: true };
  const stalled = overrides.stalled === undefined ? { cause: 'release-lagged' as const, reason: `restart held: production serves release ${entry.loaded.slice(0, 12)}`, since: entry.movedAt, at: attempted } : overrides.stalled;
  if (stalled) state.upgrade.stalled = stalled;
  state.actions[`upgrade:${entry.loaded}`] = { kind: 'config', work: null, principal: null, state: 'done', detail: `Checking out base tip ${entry.coordinator.slice(0, 12)}`, attempts: 1, epoch: null, cycle: 1, at: entry.movedAt } as DaemonState['actions'][string];
  state.actions['upgrade:held'] = { kind: 'config', work: null, principal: null, state: 'waiting', detail: 'restart held', attempts: 1, epoch: null, cycle: 1, at: attempted } as DaemonState['actions'][string];
  return state;
}
const alignmentOf = (state: DaemonState, held: string | null = null): FleetAlignment => ({ held, upgrade: owedUpgrade(state), boundMs: selfUpgradeBoundMs });

/** What the loop's fault step records for the fleet: the attention master status reports, through cycleFaults. */
function configurationFaults(entry: Instance, alignment: FleetAlignment, at = entry.observedAt) {
  const now = Date.parse(at);
  const report = executorFleetReport(fleet(entry), { commit: entry.coordinator }, { hostId: 'vishrog', now, alive: () => true, ...alignment });
  return { report, faults: cycleFaults(emptyDaemonState(config()), [], now, { config: config(), reported: report.attention }).filter(fault => fault.faultClass === 'configuration') };
}

for (const entry of instances) test(`manual:fault-class-configuration — ${entry.id} (${entry.restarted}) reproduces on the base and is the alignment under way on the candidate`, () => {
  // Base: the fleet read against the checkout alone.
  const base = configurationFaults(entry, {});
  assert.equal(base.faults.length, 1, 'against the base the split is a configuration fault');
  assert.equal(base.faults[0].kind, 'executor');
  assert.match(base.faults[0].text, new RegExp(`run a release other than the coordinator's ${entry.coordinator.slice(0, 12)}`));

  // Candidate, with the cursor's owed restart: in motion within the self-upgrade's bound, so not counted.
  const owed = configurationFaults(entry, alignmentOf(cursor(entry)));
  assert.deepEqual(owed.faults, [], 'the split the owed, held restart is completing is no fault');
  assert.equal(owed.report.attention.length, 1, 'master status still names the split');
  assert.equal(owed.report.attention[0].inMotionUntil, new Date(Date.parse(entry.movedAt) + selfUpgradeBoundMs).toISOString());
  assert.match(owed.report.attention[0].text, /self-upgrade owes this restart/);

  // Candidate, with the held-CLI pin on the loaded release: the executors run what the alignment means them to, no split.
  const pinned = configurationFaults(entry, alignmentOf(cursor(entry), entry.loaded));
  assert.deepEqual(pinned.faults, []);
  assert.deepEqual(pinned.report.attention, []);
  assert.equal(pinned.report.split, false);
  assert.match(pinned.report.executors[0].line, /the release the held restart pins/);
});

test('manual:fault-class-configuration — a split nothing is fixing still counts', () => {
  const entry = instances[2];
  // No owed restart: a checkout moved by hand, or one the loop completed elsewhere.
  assert.equal(configurationFaults(entry, alignmentOf(cursor(entry, { pending: false, stalled: null }))).faults.length, 1);
  // The owed restart names another commit.
  assert.equal(configurationFaults(entry, alignmentOf(cursor({ ...entry, coordinator: instances[1].coordinator }))).faults.length, 1);
  // The loop stopped retrying: its last attempt is past the bound.
  const later = new Date(Date.parse(entry.movedAt) + selfUpgradeBoundMs + 1).toISOString();
  assert.equal(configurationFaults(entry, alignmentOf(cursor(entry)), later).faults.length, 1);
  // A stall the loop cannot clear by retrying.
  for (const cause of ['executors-unavailable', 'supervisor-unreachable'] as const)
    assert.equal(configurationFaults(entry, alignmentOf(cursor(entry, { stalled: { cause, reason: cause, since: entry.movedAt, at: entry.movedAt } }))).faults.length, 1, cause);
  // A claim-refused restart retried every pass is in motion only within the bound of the refusal's start.
  const refused = (at: string) => alignmentOf(cursor(entry, { attemptedAt: at, stalled: { cause: 'executors-refused', reason: 'a claim is held', since: entry.movedAt, at } }));
  const retried = new Date(Date.parse(entry.movedAt) + selfUpgradeBoundMs - 60_000).toISOString();
  assert.deepEqual(configurationFaults(entry, refused(retried), retried).faults, []);
  const standing = new Date(Date.parse(entry.movedAt) + selfUpgradeBoundMs + 60_000).toISOString();
  assert.equal(configurationFaults(entry, refused(standing), standing).faults.length, 1, 'a refusal standing past the bound counts though retried each pass');
  // A pin on a release the executors do not run is no cover.
  assert.equal(configurationFaults(entry, { held: instances[1].loaded }).faults.length, 1);
});

test('manual:fault-class-configuration — alignmentInMotionUntil needs an attempted loaded-code restart onto the coordinator commit', () => {
  const at = Date.parse('2026-10-10T00:13:46.202Z'), to = instances[2].coordinator;
  assert.equal(alignmentInMotionUntil({}, to, at), null);
  assert.equal(alignmentInMotionUntil({ upgrade: { to, code: false, attemptedAt: at } }, to, at), null);
  assert.equal(alignmentInMotionUntil({ upgrade: { to, code: true, attemptedAt: null } }, to, at), null);
  assert.equal(alignmentInMotionUntil({ upgrade: { to: to.slice(0, 12), code: true, attemptedAt: at }, boundMs: 1000 }, to, at), new Date(at + 1000).toISOString());
});

test('manual:fault-class-configuration — the fleet report reads the held-CLI pin the self-upgrade writes', async () => {
  const root = await temporaryDirectory('gy-1619-held-');
  assert.equal(readHeldCli(root), null);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(heldCliPointer(root), `${JSON.stringify({ commit: instances[2].loaded, root: join(root, '.graphyard', 'held-cli', 'x'), loop: true })}\n`);
  assert.equal(readHeldCli(root), instances[2].loaded);
  await writeFile(heldCliPointer(root), 'not json');
  assert.equal(readHeldCli(root), null);
});
