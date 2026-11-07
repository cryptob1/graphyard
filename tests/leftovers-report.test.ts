import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-3190: the loop reports once a UTC day what its sweeps stopped or removed and the disk Graphyard's leftovers hold.

// Imported in each test, so a base without the module fails each case rather than the file.
const leftovers = () => import('../src/daemon/leftovers.js');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { diskFloorGb: 30 } });
const disk = { trialRuns: 10, worktrees: 20, trialCheckouts: null, trialImages: 4_000_000_000, buildCache: 500 };

function fixture() {
  let clock = Date.parse('2030-04-01T23:50:00Z');
  const handle = { id: 'review:1', kind: 'review', principal: 'worker', epoch: 1, runtime: 'claude', host: 'machine-a', pane: 'pane-1', subject: 'x', state: 'running' };
  const work = [{ id: 'w1', key: 'GY-1', stage: 'done', sessions: [handle], workspaces: [{ host: 'machine-a', epoch: 1, path: '/w/GY-1-1', owner: 'worker', branch: 'b' }] }] as unknown as Work[];
  const lines: string[] = [], removed: string[] = [];
  let low = true;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(clock).toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
    recordSession: async (_item, input) => { handle.state = input.state; },
    removeWorktree: async path => { removed.push(path); return true; },
    stopOrphanedProcesses: async () => ['chrome (1)', 'node (2)'],
    stopOrphanTrials: async () => ['container graphyard-trial-a'],
    diskVolumes: async () => [{ path: '/home', freeBytes: low ? 1e9 : 100e9 }],
    reclaimDisk: async () => { low = false; return ['image graphyard-trial:old', 'container graphyard-trial-b', '/home/.gy/trials/gy-t1']; },
    leftoverDisk: async () => disk,
  };
  return { effects, lines, removed, tick: (ms: number) => { clock += ms; }, log: (line: string) => lines.push(line) };
}

test('unit:tests/leftovers-report.test.ts — the day tallies what each sweep returned; the first persist of the next UTC day reports it once with the disk readings and restarts the counts', async () => {
  await leftovers();
  const { effects, lines, tick, log } = fixture();
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, Date.now, undefined, log);
  assert.equal(state.leftovers.day, '2030-04-01');
  assert.deepEqual(state.leftovers.counts, { processes: 2, trialContainers: 1, reclaimed: 3, panes: 1, worktrees: 1 });
  assert.equal(state.leftovers.report, null, 'a fresh cursor marks its day and reports nothing');
  tick(60_000);
  await runCycle(config, state, effects, Date.now, undefined, log);
  // The pane and worktree were already handled; processes and trial containers are stopped again.
  assert.deepEqual(state.leftovers.counts, { processes: 4, trialContainers: 2, reclaimed: 3, panes: 1, worktrees: 1 });
  assert.equal(lines.filter(line => line.includes('leftovers report')).length, 0);
  tick(10 * 60_000);
  await runCycle(config, state, effects, Date.now, undefined, log);
  assert.deepEqual(state.leftovers.report, { day: '2030-04-01', counts: { processes: 6, trialContainers: 3, reclaimed: 3, panes: 1, worktrees: 1 }, disk, at: '2030-04-02T00:01:00.000Z' });
  assert.equal(state.leftovers.day, '2030-04-02');
  assert.deepEqual(state.leftovers.counts, { processes: 0, trialContainers: 0, reclaimed: 0, panes: 0, worktrees: 0 });
  tick(60_000);
  await runCycle(config, state, effects, Date.now, undefined, log);
  const reports = lines.filter(line => line.includes('leftovers report'));
  assert.equal(reports.length, 1, 'one journal line carries the report, exactly once');
  assert.deepEqual(JSON.parse(reports[0]!.slice(reports[0]!.indexOf('{'))), state.leftovers.report);
  assert.equal((state.leftovers.report as { day: string } | null)?.day, '2030-04-01', 'the report stands until the next day ends');
  assert.deepEqual(state.leftovers.counts, { processes: 2, trialContainers: 1, reclaimed: 0, panes: 0, worktrees: 0 });
});

test('unit:tests/leftovers-report.test.ts — disk readings are recursive bytes of each directory and docker system df sizes of graphyard-trial images and the build cache, null when unreadable', async () => {
  const { directoryBytes, leftoverDisk } = await leftovers();
  const root = mkdtempSync(join(tmpdir(), 'leftovers-'));
  try {
    mkdirSync(join(root, 'runs/a/b'), { recursive: true });
    writeFileSync(join(root, 'runs/a/one'), 'x'.repeat(1000));
    writeFileSync(join(root, 'runs/a/b/two'), 'y'.repeat(500));
    const runs = await directoryBytes(join(root, 'runs'));
    assert.ok(runs !== null && runs >= 1500, String(runs));
    const df = { Images: [{ Repository: 'graphyard-trial', Tag: 'a', Size: '1.5GB' }, { Repository: 'graphyard-trial-base', Tag: 'b', Size: '500MB' }, { Repository: 'postgres', Tag: '16', Size: '400MB' }],
      BuildCache: [{ Size: '2GB' }, { Size: '250kB' }] };
    const calls: string[][] = [];
    const reading = await leftoverDisk({ trialRuns: join(root, 'runs'), worktrees: join(root, 'missing'), trialCheckouts: join(root, 'runs/a/b') }, (command, args) => { calls.push([command, ...args]); return JSON.stringify(df); });
    assert.deepEqual(reading, { trialRuns: runs, worktrees: null, trialCheckouts: await directoryBytes(join(root, 'runs/a/b')), trialImages: 2_000_000_000, buildCache: 2_000_250_000 });
    assert.deepEqual(calls, [['docker', 'system', 'df', '-v', '--format', 'json']]);
    const noDocker = await leftoverDisk({ trialRuns: root, worktrees: root, trialCheckouts: root }, () => { throw new Error('docker: not found'); });
    assert.equal(noDocker.trialImages, null);
    assert.equal(noDocker.buildCache, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unit:tests/leftovers-report.test.ts — master status shows the latest report under leftovers, read from the persisted cursor, and taking the readings removes nothing', async () => {
  const { leftoverDisk } = await leftovers();
  const root = await temporaryDirectory('leftovers-status-root');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const credentials = await temporaryDirectory('leftovers-status-credentials');
  const credentialFile = join(credentials, 'coordinator.token');
  writeFileSync(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const status = masterConfigSchema.parse({ ...config, url: 'http://127.0.0.1:5', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)) });
  const kept = join(root, '.graphyard/trial-runs/run-1/log');
  mkdirSync(join(kept, '..'), { recursive: true });
  writeFileSync(kept, 'z'.repeat(2048));
  const { effects, tick, log } = fixture();
  effects.persist = current => writeDaemonState(status, current);
  effects.leftoverDisk = () => leftoverDisk({ trialRuns: join(root, '.graphyard/trial-runs'), worktrees: join(root, '.graphyard/worktrees'), trialCheckouts: join(root, 'no-trials') }, () => { throw new Error('docker: not found'); });
  const state = emptyDaemonState(status);
  await runCycle(status, state, effects, Date.now, undefined, log);
  const unreachable = async () => { throw new TypeError('fetch failed'); };
  assert.equal((await masterStatusReport(root, status, unreachable, async () => '')).leftovers, null, 'no report before the first UTC midnight');
  tick(20 * 60_000);
  await runCycle(status, state, effects, Date.now, undefined, log);
  const report = (await masterStatusReport(root, status, unreachable, async () => '')).leftovers;
  assert.equal(report?.day, '2030-04-01');
  assert.deepEqual(report?.counts, { processes: 4, trialContainers: 2, reclaimed: 3, panes: 1, worktrees: 1 });
  assert.equal(report?.at, '2030-04-02T00:10:00.000Z');
  assert.deepEqual(Object.keys(report!.disk), ['trialRuns', 'worktrees', 'trialCheckouts', 'trialImages', 'buildCache']);
  assert.ok(report!.disk.trialRuns! >= 2048, String(report!.disk.trialRuns));
  assert.deepEqual([report!.disk.worktrees, report!.disk.trialCheckouts, report!.disk.trialImages, report!.disk.buildCache], [null, null, null, null]);
  assert.ok(existsSync(kept), 'the report removes nothing');
});
