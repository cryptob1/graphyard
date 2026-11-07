import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { ChildRun } from '../src/child-runner.js';
import { reclaimJobLeftovers } from '../src/daemon/disk-headroom.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { runWorkerVerification } from '../src/merge-writer/worker-verification.js';
import { trialBuilder, trialImageBuildArgs } from '../src/install/trial-image.js';
import { processPidNamespace, processStartTicks } from '../src/tmp-reclaim.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const clock = Date.parse('2030-01-01T00:00:00Z');

test('unit:tests/job-end-cleanup.test.ts — the sweep closes a Graphyard pane whose session has ended and leaves a live session\'s pane alone', async () => {
  const directory = await temporaryDirectory('job-end-panes');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const worktree = (name: string) => { const path = join(directory, '.graphyard/worktrees', name); mkdirSync(path, { recursive: true }); return path; };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const state = emptyDaemonState(config);
  const handle = (id: string, pane: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'implementation', principal: 'worker', epoch: 1, runtime: 'claude', host: 'other-host', pane, subject: 'x', state: 'running', ...extra });
  const work = [
    { id: 'w1', key: 'GY-1', stage: 'done', sessions: [handle('review:1', 'pane-done', { kind: 'review' })] },
    { id: 'w2', key: 'GY-2', stage: 'review', sessions: [handle('worker:1', 'pane-ended', { state: 'finished' }), handle('worker:2', 'pane-working', { state: 'finished' })] },
    { id: 'w3', key: 'GY-3', stage: 'build', sessions: [handle('worker:1', 'pane-live')] },
    { id: 'w4', key: 'GY-4', stage: 'review', sessions: [] },
  ] as unknown as Work[];
  // GY-4's finished session is no longer in the coordination view; its item's history names it.
  const history = [handle('proof:1', 'pane-history', { kind: 'proof', state: 'finished' })] as unknown as NonNullable<Work['sessions']>;
  const agents = [
    { pane_id: 'pane-done', agent: 'codex', agent_status: 'idle', cwd: worktree('GY-1-1') },
    { pane_id: 'pane-ended', agent: 'claude', agent_status: 'idle', cwd: worktree('GY-2-1') },
    { pane_id: 'pane-working', agent: 'claude', agent_status: 'working', cwd: worktree('GY-2-2') },
    { pane_id: 'pane-live', agent: 'claude', agent_status: 'idle', cwd: worktree('GY-3-1') },
    { pane_id: 'pane-history', agent: null, agent_status: 'unknown', cwd: worktree('GY-4-1') },
    { pane_id: 'pane-foreign', agent: null, agent_status: 'unknown', cwd: worktree('GY-3-9') },
  ];
  const closed: string[] = [];
  const effects: DaemonEffects = {
    agents: () => agents, credentials: async () => ({}), snapshot: async () => ({ work, now: new Date(clock).toISOString() }),
    sessionHistory: async item => item.key === 'GY-4' ? history : item.sessions ?? [],
    closeSession: pane => { closed.push(pane); }, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
  };
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(closed.sort(), ['pane-done', 'pane-ended', 'pane-history'], 'ended sessions\' panes close; the live, working and foreign panes stay');
  assert.ok(Object.values(state.actions).some(action => action.kind === 'close' && action.detail === 'Closed pane pane-ended: its session has ended'));
});

// A stand-in docker CLI: it logs each call; `start` exits with $FAKE_EXIT, or holds until `rm` ends it.
const fakeDocker = (log: string) => `#!/bin/sh
echo "$*" >> ${JSON.stringify(log)}
case "$3" in
  start) if [ -n "$FAKE_EXIT" ]; then exit "$FAKE_EXIT"; fi; echo $$ > ${JSON.stringify(log + '.client')}; exec sleep 60 ;;
  rm) kill "$(cat ${JSON.stringify(log + '.client')})" 2>/dev/null; exit 0 ;;
esac
exit 0
`;

test('unit:tests/job-end-cleanup.test.ts — a trial container ending by pass, failure, timeout or abort is removed with its volumes', async () => {
  for (const ending of ['0', '1', '124', 'abort']) {
    const base = await temporaryDirectory(`job-end-${ending}`, process.cwd());
    const bin = join(base, 'bin'), log = join(base, 'docker.log');
    await mkdir(bin);
    await writeFile(join(bin, 'docker'), fakeDocker(log));
    await chmod(join(bin, 'docker'), 0o755);
    const [program, ...words] = trialContainerLaunch({ image: 'graphyard-trial:local', mounts: [], network: 'none' });
    const child = spawn(program!, [...words, 'true'], { cwd: base, env: { PATH: `${bin}:/usr/bin:/bin`, ...(ending === 'abort' ? {} : { FAKE_EXIT: ending }) }, stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    if (ending === 'abort') {
      for (let waited = 0; !(await calls()).some(line => line.includes(' start ')); waited += 50) {
        assert.ok(waited < 10_000, 'the launcher starts its container');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      child.kill('SIGTERM');
    }
    await exited;
    const name = /--name (graphyard-trial-[0-9a-f]+)/.exec((await calls()).find(line => line.includes(' create '))!)![1]!;
    assert.ok((await calls()).some(line => line.endsWith(`rm --force --volumes ${name}`)), `a trial ending by ${ending} removes its container and volumes`);
  }
});

test('unit:tests/job-end-cleanup.test.ts — a verification run that fails leaves no scratch directory or owner marker', async () => {
  const parent = await temporaryDirectory('job-end-verify');
  const work = { key: 'GY-1', criteria: [] } as unknown as Work;
  await assert.rejects(runWorkerVerification(process.cwd(), work, { head: 'f'.repeat(40), epoch: 1, mode: 'verify' }, 'main', parent));
  assert.deepEqual(await readdir(parent), []);
});

test('unit:tests/job-end-cleanup.test.ts — the sweep removes leftovers whose owner is gone, keeps a running one\'s, and prunes only Graphyard\'s trial build cache older than a day', async () => {
  const root = await temporaryDirectory('job-end-sweep');
  const temporary = join(root, 'tmp'), checkouts = join(root, 'checkouts'), verification = join(root, 'trials');
  const gone = 2 ** 22 + 12345;
  const marked = (directory: string, pid: number) => { mkdirSync(directory, { recursive: true }); writeFileSync(`${directory}.owner`, JSON.stringify({ pid, startedAt: pid === process.pid ? processStartTicks(pid) : null, pidNamespace: processPidNamespace(), at: new Date().toISOString() })); return directory; };
  const deadVerify = marked(join(verification, 'verify-dead'), gone), liveVerify = marked(join(verification, 'verify-live'), process.pid);
  const deadTrial = marked(join(temporary, 'gy-tdead'), gone), liveTrial = marked(join(temporary, 'gy-tlive'), process.pid);
  const deadCheckout = marked(join(checkouts, 'gy-cdead'), gone);
  const docker: string[][] = [];
  const run = (async (command: string, args: string[]) => {
    assert.equal(command, 'docker');
    docker.push(args);
    if (args[0] === 'ps' && args.includes('name=^graphyard-trial-')) return 'graphyard-trial-ended\n';
    if (args[0] === 'buildx') return 'ID\tRECLAIMABLE\tSIZE\nabc\ttrue\t2GB\nTotal:\t2GB\n';
    return '';
  }) as ChildRun;
  const removed = await reclaimJobLeftovers(run, { temporary: [temporary], checkouts: [checkouts], verification: [verification] });
  for (const path of [deadVerify, deadTrial, deadCheckout]) assert.ok(!existsSync(path) && !existsSync(`${path}.owner`), `${path} goes: its owner is gone`);
  for (const path of [liveVerify, liveTrial]) assert.ok(existsSync(path), `${path} stays: its owner runs`);
  assert.ok(docker.some(args => args.join(' ') === 'rm --volumes graphyard-trial-ended'), 'a stopped trial container goes with its volumes');
  const prunes = docker.filter(args => args.includes('prune'));
  assert.deepEqual(prunes, [['buildx', 'prune', '--builder', trialBuilder, '--filter', 'until=24h', '--force']], 'only Graphyard\'s own builder\'s cache older than a day is pruned');
  assert.ok(trialImageBuildArgs('/src').join(' ').includes(`buildx build --builder ${trialBuilder} --load`), 'trial images build on that builder');
  assert.ok(removed.includes('trial build cache older than a day (2GB)'));
});
