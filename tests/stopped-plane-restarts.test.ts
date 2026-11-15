import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { deployRecordPath, readDeployRecord, servingReport, watchMain, type DeployWatchPorts } from '../src/deploy-watch.js';
import { MERGE_PROTOCOL } from '../src/protocol-version.js';
import type { ChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3347: the rexera-remote episode (2026-11-15) — with the compose stack down, the loop
// crash-looped on 'fetch failed' and graphyard-deploy ('upgrade --watch') sat idle, because it
// acts only on a new tip. Nothing restarted the server. The watch's own pass now brings a stopped
// plane back up at the commit it already recorded as serving — recreating the containers when
// `up` fails on a network that is gone, retrying with a backoff, and after three failures
// recording one plain reason where master status and the alert path already read deploy failures —
// and a loop started against an unreachable plane stays running, resuming cycles when it answers.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const repository = 'owner/project';
const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const listen = (http: Server, port = 0) => new Promise<void>(resolve => http.listen(port, '127.0.0.1', resolve));
const close = (http: Server) => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
const portOf = (http: Server) => (http.address() as { port: number }).port;
const waitFor = async <T>(read: () => T | null, timeoutMs: number): Promise<T | null> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() >= deadline) return null;
    await delay(250);
  }
};

test('unit:stopped-plane-restarts — with the plane down, no new tip and no deploy running, the watcher runs up for the recorded serving commit within one poll and health returns', async () => {
  // Imported in the test so the base commit, which has no such recovery, fails this case rather than the file.
  const [{ stoppedPlanePorts }, { stoppedPlaneAttempts }] = await Promise.all([import('../src/cli/upgrade.js'), import('../src/deploy-watch.js')]);
  const root = await temporaryDirectory('stopped-plane-watch');
  const composeDirectory = join(root, 'install', 'compose');
  const file = deployRecordPath(root);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  const resetRecord = async (tip: string) => writeFile(file, `${JSON.stringify({ tip, failed: null, reason: null, at: new Date().toISOString(), repository }, null, 2)}\n`);

  // A real health endpoint: it answers healthy exactly while the (stubbed) compose stack is up.
  let planeUp = false;
  const health = createHttpServer((request, response) => {
    response.writeHead(planeUp ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: planeUp }));
  });
  await listen(health);
  const url = `http://127.0.0.1:${portOf(health)}`;

  // The host's Docker, faked: every compose command is recorded with the directory it ran in;
  // `up` brings the stack (so the health endpoint answers) unless it is scripted to fail.
  const composeLog: { line: string; cwd?: string }[] = [];
  let upFailure: { kind: 'network' | 'hard'; remaining: number } | null = null;
  const run: ChildRun = (command, args, options) => {
    const line = [command, ...args].join(' ');
    composeLog.push({ line, cwd: options?.cwd });
    if (line === 'docker compose up -d') {
      if (upFailure && upFailure.remaining-- > 0) {
        if (upFailure.kind === 'network') throw new Error(`Error response from daemon: network graphyard-owner-project_default was found but has incorrect label com.docker.compose.network`);
        throw new Error('Error response from daemon: driver "overlay" failed to set up the rootfs: no space left on device');
      }
      planeUp = true;
      return 'Stack started';
    }
    if (line === 'docker compose down') { planeUp = false; return ''; }
    return '';
  };
  const lines = (prefix: string) => composeLog.filter(entry => entry.line.startsWith(prefix)).map(entry => entry.line);

  let fetched = a;
  const deploySteps: string[] = [];
  const ports: DeployWatchPorts = {
    fetch: async () => fetched,
    head: async () => a,
    build: async commit => { deploySteps.push(`build ${commit.slice(0, 7)}`); },
    restart: async commit => { deploySteps.push(`restart ${commit.slice(0, 7)}`); },
    checkout: async commit => { deploySteps.push(`checkout ${commit.slice(0, 7)}`); },
    health: async commit => { deploySteps.push(`health ${commit.slice(0, 7)}`); },
    pin: async commit => { deploySteps.push(`pin ${commit.slice(0, 7)}`); },
    prune: async () => {},
    schema: async () => 7,
    database: async () => 7,
    stoppedPlane: stoppedPlanePorts(url, composeDirectory, run),
  };
  const pass = () => watchMain(file, ports, { intervalMs: 1_000, once: true, log: () => {}, repository });
  const probe = async () => (await fetch(`${url}/healthz`)).json() as Promise<{ ok: boolean }>;

  try {
    // The plane is down and the base tip is what the record already serves: one poll runs `up`
    // in the install's compose directory — the stack's own image is the recorded serving commit —
    // and health returns. Nothing is built, restarted or pinned: there is no new commit to deploy.
    await resetRecord(a);
    planeUp = false; composeLog.length = 0; deploySteps.length = 0;
    await pass();
    assert.deepEqual(lines('docker compose'), ['docker compose up -d'], 'one up for the recorded serving commit, within the one poll');
    assert.ok(composeLog.every(entry => entry.cwd === composeDirectory), 'the compose commands run in the install\'s compose directory');
    assert.deepEqual(deploySteps, [], 'no deploy step ran: no new tip');
    assert.equal((await probe()).ok, true, 'health returns after up');
    assert.deepEqual([readDeployRecord(file)?.tip, readDeployRecord(file)?.failed, readDeployRecord(file)?.reason], [a, null, null], 'the record stays the serving commit, clean');

    // When `up` fails because the old Docker network id is gone, the containers are recreated
    // (down, then up) and the stack comes back.
    await resetRecord(a);
    planeUp = false; composeLog.length = 0; deploySteps.length = 0;
    upFailure = { kind: 'network', remaining: 1 };
    await pass();
    assert.deepEqual(lines('docker compose'), ['docker compose up -d', 'docker compose down', 'docker compose up -d'], 'a missing-network failure recreates the containers and succeeds');
    assert.equal((await probe()).ok, true, 'health returns after the recreate');
    assert.equal(readDeployRecord(file)?.reason, null, 'no failure is recorded once the plane answers');
    upFailure = null;

    // While a deploy is running — the pass is deploying a new tip — the stopped-plane logic does
    // nothing: no compose command runs, even though /healthz fails throughout.
    await resetRecord(a);
    fetched = b;
    planeUp = false; composeLog.length = 0; deploySteps.length = 0;
    await pass();
    assert.deepEqual(deploySteps, [`build ${b.slice(0, 7)}`, `restart ${b.slice(0, 7)}`, `health ${b.slice(0, 7)}`, `checkout ${b.slice(0, 7)}`, `pin ${b.slice(0, 7)}`], 'the pass deployed the new tip');
    assert.deepEqual(lines('docker compose'), [], 'the watcher ran no stack command while a deploy was running');
    assert.equal(readDeployRecord(file)?.tip, b, 'the new tip is recorded as served');

    // Three failures record exactly one plain reason beside the serving tip, where master status
    // and the alert path already read deploy failures.
    planeUp = false; composeLog.length = 0;
    upFailure = { kind: 'hard', remaining: stoppedPlaneAttempts };
    await pass();
    assert.equal(lines('docker compose up -d').length, stoppedPlaneAttempts, `${stoppedPlaneAttempts} attempts with the backoff between them, and no recreate (the error is not a missing network)`);
    assert.deepEqual(lines('docker compose down'), [], 'a hard failure does not recreate the containers');
    const failed = readDeployRecord(file);
    assert.equal(failed?.tip, b, 'the serving commit stands');
    assert.equal(failed?.failed, b, 'the failed deployment names the serving tip, so master status reads the reason');
    assert.match(failed?.reason ?? '', new RegExp(`^the stopped control plane was not brought back up at ${b.slice(0, 12)} in ${stoppedPlaneAttempts} attempts: .*no space left on device`), 'one plain reason naming the last failure');
    assert.equal((failed?.reason?.match(/was not brought back/g) ?? []).length, 1, 'exactly one failure reason is recorded');
    const report = await servingReport(root, repository, 'main');
    assert.deepEqual([report.failedDeploy?.tip, report.failedDeploy?.reason], [b, failed?.reason], 'master status and the alert path read the reason where they already read deploy failures');
    upFailure = null;
  } finally { await close(health); }
});

test('integration:stopped-plane-restarts — a loop started against an unreachable plane stays running and resumes cycles when the plane answers', async () => {
  const root = await temporaryDirectory('stopped-plane-loop');
  const credentials = await temporaryDirectory('stopped-plane-loop-credentials');
  const credentialFile = join(credentials, 'coordinator.token');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(join(root, '.graphyard'), { recursive: true });

  // The plane this loop polls: a real HTTP server, held off the port until the loop has been
  // started against it unreachable.
  const now = () => new Date().toISOString();
  const item = {
    id: 'blocked-1', key: 'GY-70', title: 'Needs an operator', stage: 'ready', ready: true, blocker: 'Waiting on an external contract', priority: 1, epoch: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['integration:loop'] }], policy: { checks: ['test'], review: true }, workspaces: [], evidence: [],
    gates: [{ name: 'ready', passed: false, reasons: ['Waiting on an external contract'] }], violations: [], createdAt: now(), updatedAt: now(), stageEnteredAt: now(),
    lease: null, candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], observation: null, revision: 1, policyRevision: 1,
  };
  let snapshots = 0;
  const plane = createHttpServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/status') return response.end(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository, baseBranch: 'main', githubAppId: 1234, build: { commit: null, protocol: MERGE_PROTOCOL } }));
    if (request.url === '/api/work-snapshot') { snapshots++; return response.end(JSON.stringify({ work: [item], now: now() })); }
    response.statusCode = 404;
    response.end('{}');
  });
  await listen(plane);
  const port = portOf(plane), url = `http://127.0.0.1:${port}`;
  await close(plane);
  await writeFile(join(root, '.graphyard', 'master.json'), JSON.stringify({
    version: 1, url, credentialFile, cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, workers: [], run: { intervalSeconds: 5, deploymentShaField: 'commit' },
  }), { mode: 0o600 });

  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: url, GRAPHYARD_CONFIG_HOME: join(credentials, 'config') };
  delete env.GRAPHYARD_TOKEN; delete env.GRAPHYARD_TOKEN_FILE; delete env.GRAPHYARD_FOR_PERSON;
  const child = spawn(process.execPath, [launcher, 'master', 'run'], { cwd: root, env });
  const journal: string[] = [];
  child.stderr?.setEncoding('utf8').on('data', piece => { journal.push(...piece.trim().split('\n').filter(Boolean).slice(-100)); });
  let exit: number | null | undefined;
  child.on('exit', (code, signal) => { exit = code ?? (signal ? -1 : 0); });
  const cursor = join(credentials, 'coordinator.daemon.json');
  const readCursor = () => existsSync(cursor) ? JSON.parse(readFileSync(cursor, 'utf8')) as { cycle?: number; failures?: { consecutive?: number; last?: { reason?: string } } } : null;

  try {
    // Before GY-3347 the process died at once on the startup status read ('fetch failed'), so the
    // supervisor restarted it every few seconds. Now it reaches its daemon cursor and stays up.
    const started = await waitFor(() => {
      if (exit !== undefined) return 'exited' as const;
      return readCursor() ?? null;
    }, 90_000);
    assert.ok(started !== null && started !== 'exited', `master run survives the unreachable plane instead of exiting on 'fetch failed' (exit ${exit}; ${journal.slice(-3).join(' | ')})`);

    // It keeps waiting quietly: cycles fail on the unreachable plane and are retried in-process.
    const failing = await waitFor(() => { const state = readCursor(); return state?.failures?.consecutive && state.failures.consecutive >= 1 ? state : null; }, 90_000);
    assert.ok(failing, `the loop records its failed cycles against the unreachable plane (${journal.slice(-3).join(' | ')})`);
    assert.match(String(failing?.failures?.last?.reason ?? ''), /fetch/i);
    assert.equal(exit, undefined, 'the loop is still running while the plane is unreachable');

    // The plane answers: the loop resumes its cycles on it without a restart.
    await listen(plane, port);
    const answered = await waitFor(() => { const state = readCursor(); return state?.failures?.consecutive === 0 && (state.cycle ?? 0) >= 1 ? state : null; }, 90_000);
    assert.ok(answered, `the loop resumes cycles when the plane answers (failures ${JSON.stringify(readCursor()?.failures ?? null)}; ${journal.slice(-3).join(' | ')})`);
    assert.ok(snapshots >= 1, 'the resumed cycles read the plane\'s snapshot');

    child.kill('SIGTERM');
    const stopped = await waitFor(() => exit !== undefined ? exit : null, 30_000);
    if (stopped === null) { child.kill('SIGKILL'); assert.fail('the loop did not stop on SIGTERM'); }
    assert.equal(exit, 0, 'the loop stops cleanly once the plane is back');
  } finally {
    if (exit === undefined) child.kill('SIGKILL');
    await close(plane);
  }
});
