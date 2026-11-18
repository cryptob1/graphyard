import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState } from '../src/daemon/state.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { daemonSummary, runDaemon } from '../src/daemon/run.js';
import { loopCodeRoot } from '../src/daemon/checkout-state.js';
import { readRelease } from '../src/protocol-version.js';
import { liveMasterConfig, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3454: a deploy installs a new CLI release and moves master.json's cliPath to it. The running
// loop is bound to its loaded cliPath, so the reload is refused — and the loop used to stay on the
// old code, since its own cliPath still named the release it loaded. It now restarts through its
// supervisor unit within the cycle, the merge trials in flight left running for the next loop.

const start = Date.parse('2030-07-01T00:00:00Z');

/** A CLI release directory: a git checkout holding one commit; returns its launcher path and commit. */
async function release(root: string, name: string) {
  const directory = join(root, '.graphyard', 'cli-releases', name);
  await mkdir(join(directory, 'bin'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', directory]);
  await writeFile(join(directory, 'bin', 'graphyard.mjs'), `// ${name}\n`);
  execFileSync('git', ['-C', directory, 'add', '.']);
  execFileSync('git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', name]);
  return { cliPath: join(directory, 'bin', 'graphyard.mjs'), commit: execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
}

test('integration:loop-adopts-new-cli — a deploy moves master.json cliPath to the serving release, and the running loop restarts through its supervisor unit within one cycle, leaving its in-flight trials for the next loop to adopt', { timeout: 60_000 }, async () => {
  const root = await temporaryDirectory('loop-adopts-new-cli');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const old = await release(root, 'old'), served = await release(root, 'new');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: old.cliPath,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  // On disk, master.json names the old release until the deploy moves it.
  let file: MasterConfig = config;
  const live = liveMasterConfig(root, config, async () => file, Date.now, async () => null);
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date(start).toISOString() }),
    closeSession: () => {}, dispatch: async () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {}, loadedRelease: { commit: old.commit, dirty: false } } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  const inFlights = ['GY-1', 'GY-2'].map(key => ({ key, id: key, head: 'a'.repeat(40), startedAt: new Date(start).toISOString(), step: 'tests', stepStartedAt: new Date(start).toISOString() }));
  state.mergeWriter.inFlights = inFlights;

  let clock = start, cycle = 0;
  const restarts: number[] = [], logs: string[] = [], host = new EventEmitter() as unknown as NodeJS.Process;
  await runDaemon(config, state, effects, { intervalMs: 20_000, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], process: host,
    now: () => clock, log: line => logs.push(line), root, deployUnit: () => null, reload: () => live.reload(true),
    delay: async () => {
      clock += 60_000; cycle += 1;
      // After two cycles on the old release, the deploy serves the new one and moves cliPath to it.
      if (cycle === 2) {
        await mkdir(join(root, '.graphyard'), { recursive: true });
        await writeFile(join(root, '.graphyard', 'deploy.json'), JSON.stringify({ tip: served.commit, failed: null, reason: null, at: new Date(clock).toISOString() }));
        file = { ...config, cliPath: served.cliPath };
      }
      if (cycle >= 10) host.emit('SIGUSR2');
    },
    restartLoop: async () => { restarts.push(cycle); host.emit('SIGUSR2'); } });

  assert.deepEqual(restarts, [2], `the loop restarts in the first cycle that reads the moved cliPath, not after its handover window:\n${logs.join('\n')}`);
  assert.ok(logs.some(line => line.includes('which a running master loop is bound to')), 'the reload itself is still refused: the restart adopts the new cliPath');
  const restarted = logs.find(line => line.includes('restarting through the supervisor unit'));
  assert.ok(restarted?.includes(`serves ${served.commit.slice(0, 12)}`), `the restart names the serving release: ${restarted}`);
  assert.ok(restarted?.includes('the merge trial(s) of GY-1, GY-2 run on, detached, and the next loop adopts them'), 'the restart leaves the in-flight trials for the next loop');
  assert.deepEqual(state.mergeWriter.inFlights, inFlights, 'the persisted in-flight trials survive the restart for the next loop to adopt');

  // The supervisor starts the next loop from master.json, which now names the new release: it loads
  // that release, and master status shows the loop on it.
  const next = structuredClone(state), nextConfig = await live.reload(true).then(reload => reload.cliPath ? { ...config, cliPath: reload.cliPath } : reload.config);
  await runDaemon(nextConfig, next, { ...effects, loadedRelease: readRelease(loopCodeRoot(nextConfig.cliPath, root)) } as DaemonEffects,
    { once: true, intervalMs: 20_000, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], process: new EventEmitter() as unknown as NodeJS.Process, now: () => clock, log: () => {}, root, deployUnit: () => null });
  assert.equal(daemonSummary(next, clock, 20_000).release?.commit, served.commit, 'master status shows the loop on the new release');
});
