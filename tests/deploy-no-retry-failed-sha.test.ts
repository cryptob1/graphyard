import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { performSelfUpgrade, type DeployPorts, type SelfUpgradeDeps } from '../src/daemon/upgrade.js';
import { promotionReading } from '../src/daemon/continuous-deploy.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/** The new exports, imported in the case so a reverted source fails the case, not the file (graphyard verify's exercise). */
const continuousDeploy = () => import('../src/daemon/continuous-deploy.js') as Promise<Record<string, any>>;

/**
 * GY-2518: the loop never retries deploying a SHA whose post-deploy E2E already failed. Deploying
 * the exact commit whose end-to-end run failed changes nothing — the same tree fails the same
 * suite — yet the loop spent a second E2E run and filed another batch of E2E case items doing
 * exactly that. A tip whose e2e step has failed is spent at once: no further deploy starts while
 * the base tip still names that SHA, and the tip that moves in is deployed.
 */

const full = (prefix: string) => prefix.padEnd(40, '0');
const released = full('a1a1a1a1a1a1'), failed = full('b2b2b2b2b2b2'), next = full('c3c3c3c3c3c3');
const iso = (at: number) => new Date(at).toISOString();

const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: '/nonexistent/bin/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

/** A clean, detached coordinator checkout at `head`; a fetch finds `originTip`; every ancestry read answers "not contained". */
class FakeGit {
  checkouts: string[] = [];
  diff = 'src/daemon/run.ts\n';
  constructor(public head: string, public originTip: string) {}
  run = async (_command: string, args: string[]): Promise<string> => {
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
function fakePorts(options: { fails?: Record<string, string> } = {}) {
  const calls: string[] = [], pins: string[] = [];
  const step = (name: 'deploy' | 'health' | 'e2e') => async (commit: string) => {
    calls.push(`${name}:${commit.slice(0, 12)}`);
    if (options.fails?.[commit] === name) throw new Error(`${name} refused ${commit.slice(0, 12)}`);
  };
  const ports: DeployPorts = { deploy: step('deploy'), health: step('health'), e2e: step('e2e'),
    schemas: async () => ({ target: 7, database: 7 }), pin: async commit => { pins.push(commit); } };
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
  state.promotion = promotionReading(null, iso(0), { mainSha: released, promotedSha: released, promotedAt: iso(0) });
  return state;
}

/** The off-cycle deploy settles in the background; the cursor shows it when it does. */
async function settled(until: () => boolean) {
  const { setTimeout: sleep } = await import('node:timers/promises');
  for (let waited = 0; waited < 5_000 && !until(); waited += 5) await sleep(5);
  assert.ok(until(), 'the off-cycle deploy never settled');
}

test('unit:deploy-no-retry-failed-sha — a deploy of the base tip that fails at its e2e step and rolls back is never started again while the tip still names that SHA, and the tip that moves in is deployed', async () => {
  const { tipSpent, spentTipLine } = await continuousDeploy();
  const state = releasedState(promotionReading), fake = new FakeGit(released, failed), clock = { now: 0 };
  const { ports, calls, pins } = fakePorts({ fails: { [failed]: 'e2e' } }), fleet = { self: 0 };
  const upgradePass = () => performSelfUpgrade(master, state, deps(fake, clock, ports, fleet));

  // The first deploy of the tip fails at its e2e step and rolls back to the recorded release.
  assert.equal((await upgradePass()).outcome, 'skipped', 'the deploy starts off the cycle');
  await settled(() => !!state.promotion?.deployFailed);
  assert.deepEqual(calls, [`deploy:${failed.slice(0, 12)}`, `health:${failed.slice(0, 12)}`, `e2e:${failed.slice(0, 12)}`,
    `deploy:${released.slice(0, 12)}`, `health:${released.slice(0, 12)}`], 'the failed tip ran the full sequence, then the recorded release was redeployed');
  assert.equal(fake.head, released, 'the checkout is back on the recorded release');
  assert.equal(state.promotion?.deployFailed?.step, 'e2e');
  assert.equal(state.promotion?.deployFailed?.attempts, 1);
  assert.equal(state.promotion?.promotedSha, released, 'the rollback stands');

  // The base tip still names the failed SHA: no further deploy starts — not even the retry the
  // two-attempt budget used to grant. The checkout never moves, and the spent line says why.
  assert.equal(tipSpent(state.promotion?.deployFailed, failed), true, 'an e2e-failed SHA is spent on its first failure');
  clock.now += 60_000;
  const retry = await upgradePass();
  assert.equal(retry.outcome, 'skipped');
  assert.match(retry.reason ?? '', /failed at e2e/);
  assert.match(retry.reason ?? '', /its end-to-end run already failed and deploying the same commit again changes nothing, so it waits for the base branch to move/);
  assert.equal(spentTipLine(state.promotion?.deployFailed!), retry.reason, 'master status shows the same spent line');
  const afterSkip = calls.length;
  clock.now += 60_000;
  assert.equal((await upgradePass()).outcome, 'skipped', 'every pass while the tip stands still skips the same way');
  assert.equal(calls.length, afterSkip, 'no deploy step runs for the failed SHA again');
  assert.deepEqual(calls.filter(call => call.endsWith(failed.slice(0, 12))), [`deploy:${failed.slice(0, 12)}`, `health:${failed.slice(0, 12)}`, `e2e:${failed.slice(0, 12)}`],
    'the failed SHA ran its sequence exactly once');
  assert.equal(fake.head, released, 'the checkout never moves onto the failed SHA');
  assert.equal(state.promotion?.deployFailed?.attempts, 1, 'no second attempt is recorded');
  assert.deepEqual(pins, [], 'nothing is pinned');

  // The base tip moves to a new SHA: it deploys, passes, and the failure clears.
  fake.originTip = next;
  clock.now += 60_000;
  assert.equal((await upgradePass()).outcome, 'skipped', "the new tip's deploy starts off the cycle");
  await settled(() => state.promotion?.promotedSha === next);
  assert.deepEqual(calls.slice(afterSkip), [`deploy:${next.slice(0, 12)}`, `health:${next.slice(0, 12)}`, `e2e:${next.slice(0, 12)}`],
    'the moved tip is deployed');
  assert.equal(state.promotion?.deployFailed, null, 'a deploy that passes clears the failure');
  assert.deepEqual(pins, [next]);
  clock.now += 60_000;
  assert.equal((await upgradePass()).outcome, 'upgraded', 'the loop restarts onto the deployed tip');
  assert.equal(fleet.self, 1);
  assert.deepEqual(calls.filter(call => call.endsWith(failed.slice(0, 12))), [`deploy:${failed.slice(0, 12)}`, `health:${failed.slice(0, 12)}`, `e2e:${failed.slice(0, 12)}`],
    'the failed SHA was still deployed exactly once by the end');
});

test('unit:deploy-no-retry-failed-sha-spent-line — a tip that failed twice without reaching e2e keeps its two-attempt budget and its own spent line, and a moved tip resets it', async () => {
  const { tipSpent, spentTipLine } = await continuousDeploy();
  const failure = (step: string, attempts: number): any => ({ sha: failed, step, reason: `${step} refused`, rolledBackTo: released, kept: false, attempts, at: iso(0) });
  // A health failure (or any non-e2e step) is not spent on attempt one: the retry budget stands.
  assert.equal(tipSpent(failure('health', 1), failed), false);
  assert.match(spentTipLine(failure('health', 2)), /it failed twice, so it waits for the base branch to move/);
  assert.equal(tipSpent(failure('health', 2), failed), true);
  // The same SHA failing e2e on its second attempt is spent either way.
  assert.equal(tipSpent(failure('e2e', 2), failed), true);
  // A failure naming another SHA never spends this tip, and a spent tip deploys once the tip moves.
  assert.equal(tipSpent(failure('e2e', 1), next), false);
  assert.equal(tipSpent(null, failed), false);
  assert.equal(tipSpent(undefined, failed), false);
});
