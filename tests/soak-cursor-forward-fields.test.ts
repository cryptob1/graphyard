import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { daemonStatePath, readDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1960 through the real loop. A cursor a newer loop wrote carries an unknown top-level field and
 * unknown fields nested under the records this loop rewrites itself: its release (replaced at every
 * startup) and its latest reload (replaced at every reload). Over a simulated day of restarts, each
 * reading the cursor file, running cycles with a reload before each, and persisting through the
 * real writer, every unknown field is still in the file after every write, while the declared
 * fields of those records describe this process and its latest reload.
 */
const minute = 60_000, cycleMs = 15 * minute, restarts = 8, cyclesPerRun = 12;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha = (digit: string) => digit.repeat(40);

test('unit:soak-cursor-forward-fields — over a simulated day of loop restarts, cycles and reloads, the unknown top-level and nested cursor fields a newer loop wrote survive every write while the release and reload records stay this process\'s', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-cursor-forward');
  execFileSync('git', ['init', '-q', root]);
  const credentialFile = join(await temporaryDirectory('soak-cursor-forward-credentials'), 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'soak-host',
    masterAgentName: 'graphyard-master-soak', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const file = daemonStatePath(master);
  const futureTop = { addedBy: 'a newer loop' }, futureRelease = { builtBy: 'a newer loop' }, futureReload = { since: 'a newer loop' };
  await writeFile(file, JSON.stringify({ ...emptyDaemonState(master), futureTop,
    release: { commit: sha('a'), dirty: false, futureRelease }, config: { at: 'newer-loop', changed: [], refused: null, futureReload } }));

  const start = Date.parse('2030-01-01T00:00:00Z');
  let elapsed = 0, writes = 0, reloads = 0;
  const now = () => start + elapsed, iso = () => new Date(now()).toISOString();
  const losses: string[] = [];
  for (let restart = 0; restart < restarts; restart++) {
    const release = { commit: sha(restart % 2 ? 'b' : 'c'), dirty: false };
    const state = await readDaemonState(root, master);
    let cycles = 0;
    const persist: DaemonEffects['persist'] = async current => {
      await writeDaemonState(master, current);
      writes++;
      const written = JSON.parse(await readFile(file, 'utf8'));
      if (JSON.stringify(written.futureTop) !== JSON.stringify(futureTop)) losses.push(`write ${writes}: top-level field lost`);
      if (JSON.stringify(written.release?.futureRelease) !== JSON.stringify(futureRelease)) losses.push(`write ${writes}: release field lost`);
      if (JSON.stringify(written.config?.futureReload) !== JSON.stringify(futureReload)) losses.push(`write ${writes}: reload field lost`);
      if (written.release?.commit !== release.commit) losses.push(`write ${writes}: release names ${written.release?.commit}, not this process's ${release.commit}`);
    };
    const effects: DaemonEffects = {
      agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
      snapshot: async () => { if (++cycles >= cyclesPerRun) process.emit('SIGUSR2' as NodeJS.Signals); return { work: [], now: iso() }; },
      closeSession: () => {}, dispatch: async () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, persist, loadedRelease: release,
    };
    // Every other reload adopts a change, so the reload record is rewritten with a new declared reading.
    const reload = async () => { reloads++; return { config: master, changed: reloads % 2 ? ['maxWorkers'] : [], at: iso(), refused: null }; };
    const result = await runDaemon(master, state, effects, { intervalMs: 1, identity: { pid: process.pid, host: master.hostId }, signals: ['SIGUSR2'], now, log: () => {},
      checkout: () => ({ root: '/', commit: null, modified: [], untracked: [] }), reload, wake: { sleep: async () => { elapsed += cycleMs; return []; } } });
    assert.deepEqual(result.failed, [], `restart ${restart}: no cycle failed`);
    elapsed += minute;
  }
  assert.ok(writes >= restarts * cyclesPerRun, `the loop wrote the cursor every cycle: ${writes} writes`);
  assert.deepEqual(losses, [], 'every write kept the unknown fields and named this process\'s release');
  const final = await readDaemonState(root, master);
  assert.notEqual(final.config?.at, 'newer-loop', 'the reload record\'s declared fields are this loop\'s latest reload');
});
