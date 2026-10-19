import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { performSelfUpgrade, type DeployPorts, type SelfUpgradeDeps } from '../src/daemon/upgrade.js';

/** The new exports, imported in each test so a reverted source fails the case, not the file (graphyard verify's exercise). */
const upgrade = () => import('../src/daemon/upgrade.js') as Promise<Record<string, any>>;
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';

/**
 * GY-1982: the loop deploys each new base tip between cycles through fake deploy, health and
 * end-to-end ports, records it on the cursor's release reading and restarts onto it; a failed tip
 * is rolled back to the recorded release, unless it migrated the database.
 */

const full = (prefix: string) => prefix.padEnd(40, '0');
const released = full('a1a1a1a1a1a1'), tip = full('b2b2b2b2b2b2'), next = full('c3c3c3c3c3c3');
const start = Date.parse('2026-10-18T12:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();

const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: '/nonexistent/bin/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

/** A clean, detached coordinator checkout at `head`; a fetch finds `originTip`; every ancestry read answers "not contained". */
class FakeGit {
  checkouts: string[] = [];
  diff = 'src/daemon/run.ts\n';
  constructor(public head: string, public originTip: string) {}
  run = async (command: string, args: string[]): Promise<string> => {
    assert.equal(command, 'git');
    const [op, ...operands] = args.slice(2);
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? this.head : this.originTip}\n`;
    if (op === 'symbolic-ref') throw Object.assign(new Error('fatal: not a symbolic ref'), { status: 1 });
    if (op === 'status') return '';
    if (op === 'fetch') return '';
    if (op === 'diff') return this.diff;
    if (op === 'checkout') { this.head = operands[2]; this.checkouts.push(operands[2]); return ''; }
    if (op === 'merge-base') throw Object.assign(new Error('not an ancestor'), { status: 1 });
    throw new Error(`fake git cannot answer: git ${args.slice(2).join(' ')}`);
  };
}

/** Fake ports: every call is recorded as `step:commit-prefix`; `fails` names the step that throws for a commit. */
function fakePorts(options: { fails?: Record<string, string>; schemas?: { target: number | null; database: number | null } } = {}) {
  const calls: string[] = [], pins: string[] = [];
  const step = (name: 'deploy' | 'health' | 'e2e') => async (commit: string) => {
    calls.push(`${name}:${commit.slice(0, 12)}`);
    if (options.fails?.[commit] === name) throw new Error(`${name} refused ${commit.slice(0, 12)}`);
  };
  const ports: DeployPorts = { deploy: step('deploy'), health: step('health'), e2e: step('e2e'),
    schemas: async () => options.schemas ?? { target: 7, database: 7 }, pin: async commit => { pins.push(commit); } };
  return { ports, calls, pins };
}

function deps(fake: FakeGit, clock: { now: number }, ports: DeployPorts, fleet: { self: number }): SelfUpgradeDeps {
  return { root: '/coordinator', run: fake.run, now: () => clock.now, deploy: async () => ports,
    restartSelf: async () => { fleet.self += 1; } };
}

function releasedState(promotionReading: (...args: any[]) => any): DaemonState {
  const state = emptyDaemonState(master);
  state.release = { commit: released, dirty: false };
  state.deployment = null;
  state.promotion = promotionReading(null, iso(start - 60_000), { mainSha: released, promotedSha: released, promotedAt: iso(start - 60_000) });
  return state;
}

test('unit:continuous-deploy-advances-release — a base tip that differs from the recorded release is deployed between cycles, health and end to end pass, the release reading names it with its time, and the loop restarts onto it', async () => {
  const { deployKey, deployLine, promotionReading } = await upgrade();
  const state = releasedState(promotionReading), fake = new FakeGit(released, tip), clock = { now: start };
  const { ports, calls, pins } = fakePorts(), fleet = { self: 0 };
  const guard = coordinatorCheckoutGuard({
    state: () => state, read: async () => ({ root: '/coordinator', commit: fake.head, modified: [], untracked: [] }),
    agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(clock.now) }), persist: async () => {}, now: () => clock.now, log: () => {}, applies: () => true,
  });
  assert.equal(await guard.start(released), null);

  const pass = await guard.betweenCycles(current => performSelfUpgrade(master, current, deps(fake, clock, ports, fleet)));
  assert.equal(pass.refusal, null);
  assert.equal(pass.upgraded?.outcome, 'upgraded');
  assert.deepEqual(calls, [`deploy:${tip.slice(0, 12)}`, `health:${tip.slice(0, 12)}`, `e2e:${tip.slice(0, 12)}`], 'the tip runs the upgrade sequence, then health, then end to end');
  assert.deepEqual(fake.checkouts, [tip], 'the checkout is aligned with the tip before it is deployed');
  assert.equal(state.promotion?.promotedSha, tip, 'the release reading names the tip');
  assert.equal(state.promotion?.mainSha, tip);
  assert.equal(state.promotion?.promotedAt, iso(start), 'and the time it was deployed');
  assert.equal(state.promotion?.deployFailed, null);
  assert.deepEqual(pins, [tip], 'the deployed tip is pinned known good');
  assert.equal(fleet.self, 1, 'the loop requests its own restart onto it');
  assert.equal(state.actions[deployKey]?.state, 'done');
  assert.equal(guard.expected(), tip, 'the loop\'s own deploy is never drift');

  // The process the supervisor starts runs the tip: the next pass deploys nothing.
  state.release = { commit: tip, dirty: false };
  calls.length = 0;
  clock.now += 60_000;
  assert.equal((await performSelfUpgrade(master, state, deps(fake, clock, ports, fleet))).outcome, 'up-to-date');
  assert.deepEqual(calls, [], 'the recorded release is not deployed again');

  // A tip touching no loaded code is deployed and restarted onto all the same.
  fake.originTip = next; fake.diff = 'docs/delivery.md\n';
  clock.now += 60_000;
  assert.equal((await performSelfUpgrade(master, state, deps(fake, clock, ports, fleet))).outcome, 'upgraded');
  assert.equal(state.promotion?.promotedSha, next);
  assert.equal(fleet.self, 2, 'a docs-only deploy still restarts the loop onto it');
});

test('unit:continuous-deploy-rolls-back — a tip failing health or end to end is rolled back to the recorded release through the same sequence, recorded with its step and reason in one status line, and attempted at most twice until the base tip moves', async () => {
  const { deployKey, deployLine, promotionReading } = await upgrade();
  const state = releasedState(promotionReading), fake = new FakeGit(released, tip), clock = { now: start };
  const fails: Record<string, string> = { [tip]: 'health' };
  const { ports, calls } = fakePorts({ fails }), fleet = { self: 0 };
  const pass = () => performSelfUpgrade(master, state, deps(fake, clock, ports, fleet));

  const first = await pass();
  assert.equal(first.outcome, 'failed');
  assert.deepEqual(calls, [`deploy:${tip.slice(0, 12)}`, `health:${tip.slice(0, 12)}`, `deploy:${released.slice(0, 12)}`, `health:${released.slice(0, 12)}`],
    'the recorded release is redeployed through the same sequence');
  assert.equal(fake.head, released, 'the checkout is back on the recorded release');
  assert.equal(state.promotion?.promotedSha, released, 'the release reading still names the recorded release');
  assert.deepEqual({ ...state.promotion?.deployFailed, at: undefined }, { sha: tip, step: 'health', reason: `health refused ${tip.slice(0, 12)}`, rolledBackTo: released, kept: false, attempts: 1, at: undefined });
  const line = `deploy of ${tip.slice(0, 12)} failed at health: health refused ${tip.slice(0, 12)}; rolled back to ${released.slice(0, 12)}`;
  assert.equal(deployLine(state.promotion?.deployFailed), line, 'master status shows one line naming both commits');
  assert.equal(first.outcome === 'failed' && first.reason, line);
  assert.equal(state.actions[deployKey]?.state, 'failed');
  assert.equal(fleet.self, 0, 'nothing restarts onto the failed tip');

  // The second attempt fails end to end this time; the third pass deploys nothing.
  fails[tip] = 'e2e';
  calls.length = 0;
  clock.now += 60_000;
  assert.equal((await pass()).outcome, 'failed');
  assert.deepEqual(calls.slice(0, 3), [`deploy:${tip.slice(0, 12)}`, `health:${tip.slice(0, 12)}`, `e2e:${tip.slice(0, 12)}`]);
  assert.deepEqual(calls.slice(3), [`deploy:${released.slice(0, 12)}`, `health:${released.slice(0, 12)}`], 'an end-to-end failure rolls back as well');
  assert.equal(state.promotion?.deployFailed?.step, 'e2e');
  assert.equal(state.promotion?.deployFailed?.attempts, 2);
  calls.length = 0;
  clock.now += 60_000;
  const third = await pass();
  assert.equal(third.outcome, 'skipped');
  assert.match(third.outcome === 'skipped' ? third.reason : '', /failed twice, so it waits for the base branch to move/);
  assert.deepEqual(calls, [], 'a tip that failed twice is not attempted again');
  assert.equal(fake.head, released);

  // The base tip moves: the new tip is deployed.
  fake.originTip = next;
  clock.now += 60_000;
  assert.equal((await pass()).outcome, 'upgraded');
  assert.deepEqual(calls, [`deploy:${next.slice(0, 12)}`, `health:${next.slice(0, 12)}`, `e2e:${next.slice(0, 12)}`]);
  assert.equal(state.promotion?.promotedSha, next);
  assert.equal(deployLine(state.promotion?.deployFailed), null, 'a deploy that passes clears the failure line');
});

test('unit:continuous-deploy-no-rollback-across-migration — a failed tip that migrated the database is kept, its line says why, and no served-release observation holds the restart', async () => {
  const { deployKey, deployLine, promotionReading } = await upgrade();
  const state = releasedState(promotionReading), fake = new FakeGit(released, tip), clock = { now: start };
  // Production is observed serving the recorded release, which does not contain the tip: the
  // release-lagged hold (GY-1585) would have held the restart onto it.
  state.deployment = { source: 'github', sha: released, at: iso(start), reason: null, deployed: ['GY-1'], pending: ['GY-2'] } as unknown as DaemonState['deployment'];
  const { ports, calls } = fakePorts({ fails: { [tip]: 'health' }, schemas: { target: 8, database: 7 } }), fleet = { self: 0 };

  const outcome = await performSelfUpgrade(master, state, deps(fake, clock, ports, fleet));
  assert.deepEqual(calls, [`deploy:${tip.slice(0, 12)}`, `health:${tip.slice(0, 12)}`], 'the older release is never redeployed onto the migrated database');
  assert.equal(state.promotion?.deployFailed?.kept, true);
  assert.equal(state.promotion?.deployFailed?.rolledBackTo, null);
  assert.equal(state.promotion?.promotedSha, tip, 'the loop keeps the new release');
  assert.equal(deployLine(state.promotion?.deployFailed), `deploy of ${tip.slice(0, 12)} failed at health: health refused ${tip.slice(0, 12)}; the release was kept because the database was migrated`);
  assert.equal(outcome.outcome, 'upgraded', 'the restart onto the kept release goes ahead');
  assert.equal(fleet.self, 1);
  assert.notEqual(state.upgrade.stalled?.cause, 'release-lagged', 'no restart is held for a served-release observation');
  assert.equal(state.actions['upgrade:held'], undefined);
});
