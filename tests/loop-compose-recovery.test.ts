import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runDaemon, writeDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { composeServer } from '../src/daemon/compose-recovery.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { ChildRunOptions } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2966: on 2026-10-27 both compose servers exited and stayed down 32 hours while the loops
// printed only 'fetch failed'. A loop that cannot reach its compose install's control plane for two
// minutes now runs `docker compose up -d` in the install's compose directory, logs it, and master
// status says since when, why the server last exited and how much disk is free.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

test('unit:loop-restarts-stopped-compose-server — over 2 minutes unreachable, the loop runs one docker compose up -d in the compose directory, logs it, and master status names since when, the last exit and the free disk', async () => {
  const root = await temporaryDirectory('compose-recovery-root');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const credentials = await temporaryDirectory('compose-recovery-credentials');
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:5', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const composeDirectory = join(credentials, 'compose');

  // The host's Docker, faked: every command is recorded with the directory it ran in.
  const commands: { line: string; cwd: string | undefined }[] = [];
  const run = (command: string, args: string[], options?: ChildRunOptions) => {
    const line = [command, ...args].join(' ');
    commands.push({ line, cwd: options?.cwd });
    if (line.startsWith('docker compose ps')) return '{"Service":"server","State":"exited","Status":"Exited (1) 3 minutes ago"}\n';
    if (line.startsWith('docker compose logs')) return 'Graphyard listening on port 4310\nError: Connection terminated unexpectedly\n';
    if (line.startsWith('docker info')) return '/var/lib/docker\n';
    if (line.startsWith('df')) return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/nvme0n1p2 976762584 975713944 1048576 100% /\n';
    return '';
  };

  let clock = Date.parse('2030-01-01T00:00:00Z');
  const started = clock, log: string[] = [];
  const state = emptyDaemonState(config), host = new EventEmitter() as unknown as NodeJS.Process;
  const effects: DaemonEffects = {
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {},
    snapshot: async () => { throw new TypeError('fetch failed'); },
    persist: current => writeDaemonState(config, current),
    composeServer: () => composeServer(composeDirectory, run),
  };
  const result = await runDaemon(config, state, effects, {
    intervalMs: 30_000, identity: { pid: process.pid, host: 'machine-a' }, process: host, log: line => log.push(line), now: () => clock,
    // Each wait passes on the fake clock; the loop is stopped after 4 minutes 30 seconds unreachable.
    delay: async ms => { clock += ms; if (clock - started > 270_000) host.emit('SIGTERM'); },
  });
  assert.ok(result.failed.length >= 3, `the loop kept failing on the unreachable plane (${result.failed.length} failed cycles)`);
  assert.ok(clock - started > 120_000);

  const ups = commands.filter(command => command.line === 'docker compose up -d');
  assert.equal(ups.length, 1, `exactly one docker compose up -d: ${commands.map(command => command.line).join('; ')}`);
  assert.equal(ups[0].cwd, composeDirectory, 'it runs in the install\'s compose directory');
  assert.ok(log.some(line => line.includes(`ran docker compose up -d in ${composeDirectory}`) && line.includes('fetch failed')), log.join('\n'));

  const report = await masterStatusReport(root, config, async () => { throw new TypeError('fetch failed'); }, async () => '');
  assert.equal(report.controlPlane.reachable, false);
  assert.equal(report.controlPlane.unreachableSince, new Date(started).toISOString(), 'since the first failed snapshot');
  assert.equal(report.controlPlane.lastExitReason, 'Exited (1) 3 minutes ago: Error: Connection terminated unexpectedly');
  assert.equal(report.controlPlane.freeDisk, '1.0 GiB free on / (Docker data at /var/lib/docker)');
  assert.match(report.controlPlane.restart ?? '', /^started/);
});
