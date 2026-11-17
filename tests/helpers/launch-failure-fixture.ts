import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterStatusReport } from '../../src/cli/master-status.js';
import { runCycle } from '../../src/daemon/cycle.js';
import type { DaemonEffects } from '../../src/daemon/effects.js';
import { daemonStatePath, emptyDaemonState } from '../../src/daemon/state.js';
import { masterConfigSchema, type WorkerProfile } from '../../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../../src/master/herdr.js';
import type { AgentRegistry, FleetRuntime } from '../../src/model/registry.js';
import { temporaryDirectory } from './temp-dirs.js';
import { workFixture } from './work-fixture.js';

/**
 * GY-3413: one ready item whose every worker launch fails with the same reason on whichever of two
 * runtimes the loop picks, each launch claiming the next epoch, as GY-3406's stale record did.
 * `cycle(ms)` runs the loop `ms` after 2030-01-01T00:00:00Z; `status(ms)` is `graphyard master status` then.
 */
export async function launchFailureFixture() {
  const t0 = Date.parse('2030-01-01T00:00:00Z'), iso = (ms: number) => new Date(t0 + ms).toISOString();
  const directory = await temporaryDirectory('launch-failure');
  const token = join(directory, 'coordinator.token'), workerToken = join(directory, 'worker.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await writeFile(workerToken, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const profiles = ['a', 'b'].map(name => ({ name: `worker-${name}`, principal: `worker-${name}`, agentName: `agent-${name}`, mode: 'launch', kind: 'claude', credentialFile: workerToken, agentArgs: [], environment: {} }) as unknown as WorkerProfile);
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'master', workers: profiles });
  const registry: Pick<AgentRegistry, 'runtimes' | 'accounts' | 'roles'> = {
    runtimes: ['opencode', 'claude'].map(name => ({ name, launch: { kind: name, environment: {} } }) as unknown as FleetRuntime),
    accounts: [{ name: 'oc-a', runtime: 'opencode' }, { name: 'cl-a', runtime: 'claude' }] as AgentRegistry['accounts'],
    roles: [{ name: 'worker', accounts: ['oc-a', 'cl-a'], concurrency: 2 }] as AgentRegistry['roles'] };
  const reason = (epoch: number) => `Worker launch failed: the worktree for GY-1 epoch ${epoch} could not be created: Submitted workspace branch is missing`;
  const work = [workFixture({ id: 'id-1', key: 'GY-1', priority: 1, createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(0) })];
  const state = emptyDaemonState(config);
  let epoch = 0, now = t0;
  const effects: DaemonEffects = {
    agents: () => [], persist: async () => {}, closeSession: () => {},
    credentials: async list => Object.fromEntries(list.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    registry: async () => registry,
    dispatch: async (_item, _profile, _agents, _snapshot, launch) => {
      const account = registry.accounts.find(entry => !launch?.exclude?.includes(entry.name))!;
      launch?.onRuntime?.(account.runtime);
      epoch += 1;
      throw new Error(reason(epoch));
    },
  };
  return {
    reason, launches: () => epoch,
    cycle: async (ms: number) => { now = t0 + ms; await runCycle(config, state, effects, () => now, undefined, () => {}); },
    status: async (ms: number) => {
      await writeFile(daemonStatePath(config), JSON.stringify(state));
      const root = await temporaryDirectory('launch-failure-status');
      execFileSync('git', ['init', '-q', root]);
      return masterStatusReport(root, config, async () => ({ work, now: iso(ms) }), async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`);
    },
  };
}
