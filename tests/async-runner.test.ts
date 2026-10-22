import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ChildProcessError, childRunner, runChild } from '../src/child-runner.js';
import { emptyDaemonState, runCycle, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { listHerdrAgents, masterConfigSchema, startAgentSession, type HerdrAgent, type MasterConfig, type MasterRun, type ProducerProfile, type WorkerProfile } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { DispatchRequest } from '../src/model/dispatch.js';
import type { Work } from '../src/model.js';
// Time-bomb allowance (GY-1694): the 2030-01-01 clock is handed to runCycle as its explicit now over fixtures derived from it; Date.now() only measures elapsed time and child deadlines.

// GY-125. Each test is named for the proof it produces: unit:no-sync-child-processes,
// integration:snapshot-read-unblocked-by-launch.

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const launcher = join(repository, 'bin/graphyard.mjs');
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

function config(credentialFile: string, overrides: Partial<Omit<MasterConfig, 'run'>> & { run?: Partial<MasterRun> } = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], ...overrides });
}
function work(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-1', key: 'GY-125', title: 'Never block the loop on a child', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:child-wait-attributed'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 3, policyRevision: 1,
    createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
function effects(overrides: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: iso(0) }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    persist: async () => {},
    ...overrides,
  };
}
async function privateDirectory(label: string) {
  const directory = await temporaryDirectory(label);
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  return { directory, token };
}

/**
 * A Herdr on PATH whose session start takes thirty seconds — until the test releases it — and
 * whose every other command answers at once. Since GY-121 a launch is `pane run` typing the
 * command line and then `agent get` and `pane read` until the runtime is ready: here `pane run`
 * itself holds for the delay, exactly as `agent start … --timeout 30000` held before it, and the
 * runtime is seen ready the moment it returns. The script is a real child process: what it
 * exercises is the runner, not a stub of it.
 */
async function slowHerdr(directory: string, startDelayMs: number) {
  const release = join(directory, 'release');
  const script = join(directory, 'herdr-stub.mjs');
  await writeFile(script, `
    import { existsSync } from 'node:fs';
    const args = process.argv.slice(2);
    const answer = value => { process.stdout.write(JSON.stringify(value)); };
    if (args[0] === 'pane' && args[1] === 'run') {
      const deadline = Date.now() + ${startDelayMs};
      const wait = () => { if (existsSync(${JSON.stringify(release)}) || Date.now() >= deadline) answer({ result: { ran: true } }); else setTimeout(wait, 25); };
      wait();
    } else if (args[0] === 'pane' && args[1] === 'read') process.stdout.write('claude ready\\n');
    else if (args[0] === 'agent' && args[1] === 'get') answer({ result: { agent: { agent: 'claude', agent_status: 'idle', pane_id: args[2] } } });
    else if (args[0] === 'agent' && args[1] === 'rename') answer({ result: { agent: { agent: 'claude', agent_status: 'idle', name: args[3] } } });
    else if (args[0] === 'agent' && args[1] === 'list') answer({ result: { agents: [{ name: 'someone-else', pane_id: 'pane-9', agent_status: 'working' }] } });
    else if (args[0] === 'tab' && args[1] === 'create') answer({ result: { root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' } } });
    else answer({ result: {} });
  `);
  const executable = join(directory, 'herdr');
  await writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  await chmod(executable, 0o755);
  return { path: `${directory}:${process.env.PATH ?? ''}`, release: () => writeFile(release, 'go') };
}

test('unit:no-sync-child-processes — the loop, the dispatcher, the merge broker and every runtime helper they reach run children only through the asynchronous runner; the one synchronous child is the CLI reading its own commit at startup', async () => {
  // The five modules the item names, and the helpers those modules reach at runtime for
  // Herdr, gh, git and systemctl. None may hold a synchronous child call, a blocking sleep, or
  // its own import of node:child_process: the runner is the only way out of the process.
  // The first three are re-export barrels over their modules under src/master/, src/daemon/ and src/cli/master/ (GY-177).
  const split = async (directory: string) => (await readdir(join(repository, directory))).filter(name => name.endsWith('.ts')).sort().map(name => `${directory}/${name}`);
  const loop = ['src/master.ts', ...await split('src/master'), 'src/master-daemon.ts', ...await split('src/daemon'), 'src/auto-dispatch.ts', 'src/producer.ts', 'src/reviewer.ts'];
  const reached = ['src/harness.ts', 'src/install/worktree-root.ts', 'src/cli/master.ts', ...await split('src/cli/master'), 'src/cli/master-status.ts'];
  // The single allow-listed CLI-startup path: `cliCommit` reads the CLI checkout's own commit for
  // the version-skew guard once, when a `master` command starts, before the loop runs a cycle.
  const allowed = new Map([['src/protocol-version.ts', 'cliCommit reads the CLI checkout commit once at command startup']]);
  const synchronous = /\b(?:execFileSync|spawnSync|execSync)\b|Atomics\.wait\(/;
  const childProcessImport = /from ['"]node:child_process['"]/;
  // Comments are not calls: a doc comment may name execFileSync to say what replaced it.
  const uncommented = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
  const offenders: string[] = [];
  for (const file of [...loop, ...reached, ...allowed.keys()]) {
    const source = uncommented(await readFile(join(repository, file), 'utf8'));
    const lines = source.split('\n').map((line, index) => ({ line, number: index + 1 })).filter(entry => synchronous.test(entry.line));
    if (allowed.has(file)) { assert.ok(lines.length > 0, `${file} is allow-listed for ${allowed.get(file)}; an allow-list entry nothing uses is removed`); continue; }
    offenders.push(...lines.map(entry => `${file}:${entry.number}: ${entry.line.trim().slice(0, 120)}`));
    if (childProcessImport.test(source)) offenders.push(`${file}: imports node:child_process; children go through src/child-runner.ts`);
  }
  assert.deepEqual(offenders, [], 'no synchronous child process outside the allow-listed CLI-startup path');
  // The runner itself is asynchronous by construction: it spawns and awaits, never blocks.
  const runner = uncommented(await readFile(join(repository, 'src/child-runner.ts'), 'utf8'));
  assert.ok(!synchronous.test(runner), 'the runner holds no synchronous child call');
  assert.match(runner, /import \{ spawn \} from 'node:child_process'/);

  // The runner's contract, on real children: stdout is the value; a non-zero exit rejects with
  // the fields execFileSync's error carried; a child past its bound is killed and says so.
  assert.equal((await runChild(process.execPath, ['-e', "process.stdout.write('answer')"])).trim(), 'answer');
  await assert.rejects(runChild(process.execPath, ['-e', "process.stdout.write('partial'); process.stderr.write('reason'); process.exit(3)"]), (error: unknown) => {
    assert.ok(error instanceof ChildProcessError);
    assert.equal(error.status, 3); assert.equal(error.stdout, 'partial'); assert.equal(error.stderr, 'reason'); assert.equal(error.timedOut, false);
    assert.match(error.message, /^Command failed: .*-e process\.stdout/);
    return true;
  });
  const started = Date.now();
  await assert.rejects(runChild(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 200 }), (error: unknown) => {
    assert.ok(error instanceof ChildProcessError);
    assert.equal(error.timedOut, true); assert.equal(error.signal, 'SIGTERM'); assert.match(error.message, /did not finish within 200ms and was killed/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000, 'a timed-out child is killed at its bound, not waited out');
  await assert.rejects(runChild('graphyard-no-such-command-125', []), (error: unknown) => error instanceof ChildProcessError && /could not be started/.test(error.message));

});

test('integration:snapshot-read-unblocked-by-launch — while the dispatcher waits thirty seconds on a Herdr session start, a cycle beside it reads its snapshot in under two seconds and completes without a failure', async () => {
  const { directory, token } = await privateDirectory('unblocked');
  const herdr = await slowHerdr(directory, 30_000);
  const run = childRunner({ timeoutMs: 60_000, env: { ...process.env, PATH: herdr.path } });
  // A control plane on this host: the snapshot is a real HTTP read with the loop's own bound.
  const server = createServer((request, response) => {
    setTimeout(() => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ work: [], now: new Date().toISOString() })); }, 20);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const reads: number[] = [];
  const snapshot = async () => {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/work-snapshot`, { signal: AbortSignal.timeout(8_000) });
    const body = await response.json() as { work: Work[]; now: string };
    reads.push(Date.now() - startedAt);
    return body;
  };
  try {
    const master = config(token, { producers: [{ name: 'producer-a', principal: 'producer-a', agentName: 'producer-a', kind: 'claude', credentialFile: join(directory, 'producer.token'), agentArgs: [], approvals: 'auto', environment: {} } as ProducerProfile] });
    const request: DispatchRequest = { id: 'req-unit', kind: 'producer', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, pr: 125, group: 'unit', proofs: ['unit:child-wait-attributed'], requestedAt: iso(0), reason: 'unit proofs', state: 'requested' };
    const submitted = work({ stage: 'review', epoch: 1, submission: { epoch: 1, pr: 125 }, candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 125, branch: 'graphyard/gy-125-1', author: 'worker' }, autoDispatch: { review: null, producers: [request], history: [] } } as Partial<Work>);
    // The dispatcher's tick launches the producer through the real launch path — the request file
    // written, `herdr pane run` typing the command line — run by the runner against the Herdr
    // above, whose `pane run` does not answer.
    const launches: string[] = [];
    const dispatcher: DispatchEffects = {
      snapshot: async () => ({ work: [submitted], now: iso(0) }),
      agents: () => listHerdrAgents(run),
      credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
      reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
      launchReview: async () => { throw new Error('no review in this test'); },
      launchProducer: async (item, req, profile) => { launches.push(`${item.key}:${req.group}:${profile.name}`); return startAgentSession('producer-gy-125-1', 'claude', 'pane-1', [], 'Produce the unit proofs', run, { directory }); },
      persist: async () => {},
    };
    const tickStartedAt = Date.now();
    const tick = runDispatchTick(master, emptyDispatchCursor(master), dispatcher, Date.now, 8_000);
    // The launch is in flight: the stub is waiting on its release, and the cycle now runs beside it.
    await sleep(300);
    assert.deepEqual(launches, ['GY-125:unit:producer-a'], 'the tick reached the launch');
    const state = emptyDaemonState(master), log: string[] = [];
    const result = await runDaemon(master, state, effects({ snapshot, agents: () => listHerdrAgents(run) }), { once: true, intervalMs: 20_000, identity: { pid: process.pid, host: master.hostId }, signals: [], log: line => log.push(line) });
    assert.equal(reads.length, 1, 'the cycle read its snapshot once');
    assert.ok(reads[0] < 2_000, `the snapshot read completed in ${reads[0]}ms while the launch was still waiting`);
    assert.ok(Date.now() - tickStartedAt < 10_000, 'the cycle did not wait for the launch to end');
    assert.equal(result.failed.length, 0, 'the cycle logged no failure');
    assert.equal(result.cycles.length, 1);
    assert.equal(state.failures.consecutive, 0);
    assert.ok(!log.some(line => /failed in the snapshot call|aborted due to timeout/.test(line)), log.join('\n'));
    // The cycle's own Herdr read went through the same runner, beside the stalled launch.
    assert.ok(log.some(line => /cycle 0 complete with /.test(line)), log.join('\n'));
    // Let the launch finish: the tick then records it as launched, exactly as a fast Herdr would.
    await herdr.release();
    const ticked = await tick;
    assert.deepEqual(ticked.launched.map(entry => [entry.kind, entry.work, entry.profile]), [['producer', 'GY-125', 'producer-a']]);
    assert.deepEqual(ticked.refused, []);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
