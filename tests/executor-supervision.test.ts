import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { actionIdleMs, claimAction, renewClaim, settleAction, type ActionRow } from '../src/model/actions.js';
import { describeUnserved, executorLiveMs, executorRegistry, executorReport } from '../src/model/executor-presence.js';
import { executorRunnableKinds } from '../src/model/action-kinds.js';
import { executorEffects, runExecutor } from '../src/auto-dispatch.js';
import { emptyDaemonState, preserveKey, launchAppearanceMs, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { inspectProfileAccounts, masterConfigSchema, workerPrompt, type MasterConfig } from '../src/master.js';
import { MERGE_PROTOCOL } from '../src/protocol-version.js';
import { executorDeclarationFile, executorSlotUndeclaredExit, executorSupervisionStatus, executorUnit, executorUnitTemplate, installExecutorSupervision, readExecutorDeclaration, renderExecutorUnit, setupRepository, writeExecutorDeclaration, type SystemctlRunner } from '../src/repository-setup.js';
import { executorFleet } from '../src/cli/executor-report.js';
import OverviewPage from '../web/pages/overview.js';
import { boardFromStatus } from '../src/model/board.js';
import WorkDetails from '../web/pages/work-details.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-105: nothing brought executors back. The fleet stopped at a reboot or a crash until a person
 * retyped the command, and an action nobody could claim looked exactly like one waiting its turn.
 *
 * Three proofs, each a test named for it: integration:executor-supervised-restart (the shipped
 * unit starts an executor, restarts it after a kill, and the killed executor's claim is taken
 * again rather than stranded), integration:unserved-queue-visible (master status and the
 * dashboard say when no live executor serves a pending action's kind, with the wait and what to
 * start), and integration:killed-worker-work-preserved (a worker killed outright keeps its partial
 * work exactly as an exhausted one does, and the next attempt's request names the commit).
 */

const repository = 'owner/project';
const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'bin/graphyard.mjs');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const processAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === 'EPERM'; } };
const until = async (predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await delay(100); }
};
const readBody = (req: IncomingMessage) => new Promise<string>(resolve => { let text = ''; req.on('data', chunk => text += chunk); req.on('end', () => resolve(text)); });
const json = (res: ServerResponse, status: number, body: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

/** A coordinator checkout for the executor to run in: master.json, its credential, and the shipped scripts beside it. */
async function coordinatorCheckout(url: string, declaration: { count: number; kinds: ('resync' | 'merge')[] | null; intervalSeconds: number }) {
  const checkout = await temporaryDirectory('executor-checkout');
  const credentials = await temporaryDirectory('executor-credentials');
  git(checkout, 'init', '-q'); git(checkout, 'remote', 'add', 'origin', `https://github.com/${repository}.git`);
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(join(checkout, '.graphyard'), { mode: 0o700 });
  await writeFile(join(checkout, '.graphyard/master.json'), JSON.stringify({ version: 1, url, credentialFile, cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234, hostId: 'unit-host', masterAgentName: 'graphyard-master-unit', autoMerge: true, mergeMethod: 'merge', workers: [], run: {} }), { mode: 0o600 });
  await writeExecutorDeclaration(checkout, { version: 1, ...declaration });
  // The script imports its TypeScript neighbours relative to its own real path, so the shipped
  // scripts directory is linked in rather than copied.
  await symlink(join(root, 'scripts'), join(checkout, 'scripts'));
  await symlink(join(root, 'examples'), join(checkout, 'examples'));
  return { checkout, credentials, credentialFile };
}

/**
 * The control plane as an executor sees it, over the real queue functions and an in-memory item:
 * one `resync` row, a three-second claim lease so a dead executor's claim lapses inside the test,
 * and a `resync` route the test can hold open — an executor inside that handler is an executor
 * mid-action, which is the moment a kill has to be survived.
 */
function fakeControlPlane(leaseMs: number) {
  const now = () => new Date();
  const row: ActionRow = { id: 'a'.repeat(32), kind: 'resync', work: 'work-1', key: 'GY-1', inputs: { kind: 'resync', pr: null, sha: null, baseSha: null, baseTip: null, observedAt: null }, gate: 'build', refusal: 'Pull request has not been independently observed', reason: 'GY-1 needs a fresh provider reading', binding: 'resync:none', requestedBy: 'graphyard', requestedAt: now().toISOString(), state: 'pending', claim: null, attempts: 0, history: [] };
  const work = { id: 'work-1', key: 'GY-1', title: 'Fixture', stage: 'build', actionQueue: { actions: [row], history: [] } } as unknown as Work;
  const state = { held: [] as ServerResponse[], holdResync: true, resyncs: 0, claims: [] as { executor: string; host: string; kinds: string[]; at: string }[] };
  const http = createServer(async (req, res) => {
    const path = req.url ?? '';
    if (req.method === 'GET' && path === '/api/status') return json(res, 200, { actor: { id: 'master', role: 'coordinator' }, repository, baseBranch: 'main', githubAppId: 1234, build: { commit: null, protocol: MERGE_PROTOCOL } });
    if (req.method === 'GET' && path === '/api/work-snapshot') return json(res, 200, { now: now().toISOString(), work: [work] });
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
    try {
      if (path === '/api/actions/claim') {
        state.claims.push({ executor: body.executor, host: body.host, kinds: body.kinds, at: now().toISOString() });
        const claimed = claimAction([work], { id: body.executor ?? 'master', host: body.host, principal: 'master' }, now(), { kinds: body.kinds, leaseMs });
        return json(res, 200, { action: claimed?.row ?? null, open: claimed ? 0 : 1, at: now().toISOString() });
      }
      const renew = /^\/api\/actions\/([0-9a-f]{32})\/renew$/.exec(path), settle = /^\/api\/actions\/([0-9a-f]{32})\/settle$/.exec(path);
      if (renew) return json(res, 200, renewClaim(work, renew[1], { executor: body.executor ?? 'master', principal: 'master' }, now(), leaseMs));
      if (settle) return json(res, 200, { action: settleAction(work, settle[1], { executor: body.executor ?? 'master', principal: 'master' }, body.result, body.reason, now()).action });
      if (path === '/api/work/work-1/resync') {
        state.resyncs++;
        if (state.holdResync) { state.held.push(res); return; }
        return json(res, 200, { changed: true, work: { ...work, lease: null } });
      }
      return json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
  });
  return { http, row, work, state, release: () => { state.holdResync = false; for (const res of state.held.splice(0)) json(res, 200, { changed: true, work }); } };
}

/** The unit as systemd would read it: its [Service] keys, and the argv ExecStart names for one instance. */
function parseUnit(text: string, instance: string) {
  const service: Record<string, string> = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { section = line; continue; }
    if (section === '[Service]') { const eq = line.indexOf('='); service[line.slice(0, eq)] = line.slice(eq + 1); }
  }
  const argv = service.ExecStart.split(' ').map(part => part.replaceAll('%i', instance).replaceAll('%%', '%'));
  return { service, argv, cwd: service.WorkingDirectory.replaceAll('%%', '%') };
}

/**
 * systemd's restart policy, as the unit declares it: `Restart=always` starts the process again
 * `RestartSec` after any exit, except an exit status `RestartPreventExitStatus` names. Nothing
 * else of systemd is imitated; the executor under it is the real one.
 */
function superviseLikeSystemd(unit: ReturnType<typeof parseUnit>, env: NodeJS.ProcessEnv, log: string[]) {
  assert.equal(unit.service.Restart, 'always');
  const restartMs = Number(unit.service.RestartSec) * 1000, prevent = (unit.service.RestartPreventExitStatus ?? '').split(/\s+/).filter(Boolean).map(Number);
  const starts: ChildProcess[] = [];
  const exits: { pid: number; code: number | null; signal: string | null }[] = [];
  let stopped = false, timer: NodeJS.Timeout | null = null;
  const start = () => {
    const child = spawn(unit.argv[0], unit.argv.slice(1), { cwd: unit.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', chunk => log.push(`[${child.pid}] ${chunk}`)); child.stderr!.on('data', chunk => log.push(`[${child.pid}] ${chunk}`));
    starts.push(child);
    child.on('exit', (code, signal) => {
      exits.push({ pid: child.pid!, code, signal });
      if (stopped || (code !== null && prevent.includes(code))) return;
      timer = setTimeout(start, restartMs);
    });
    return child;
  };
  start();
  return { starts, exits, current: () => starts.at(-1)!, stop: async () => { stopped = true; if (timer) clearTimeout(timer); const child = starts.at(-1)!; if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null, 'the executor to stop on SIGTERM', 30_000); } } };
}

test('integration:executor-supervised-restart: the shipped unit starts an executor from the host declaration, restarts it after a kill, and the killed executor\'s claim is re-claimed by the restarted one rather than stranded', async () => {
  const plane = fakeControlPlane(3000);
  await new Promise<void>(resolve => plane.http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(plane.http.address() as { port: number }).port}`;
  const { checkout, credentials } = await coordinatorCheckout(url, { count: 1, kinds: ['resync'], intervalSeconds: 1 });
  // systemd's keep-alive channel, recorded: the executor speaks to it only because NOTIFY_SOCKET is set.
  const notifications = join(credentials, 'notify.log'), bin = join(credentials, 'bin');
  await mkdir(bin); await writeFile(join(bin, 'systemd-notify'), `#!/bin/sh\necho "$@" >> '${notifications}'\n`); await chmod(join(bin, 'systemd-notify'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NOTIFY_SOCKET: '/run/user/0/systemd/notify-fixture', GRAPHYARD_TOKEN: undefined, GRAPHYARD_TOKEN_FILE: undefined, GRAPHYARD_URL: undefined };
  const log: string[] = [];
  const template = await readFile(join(root, 'examples/master', executorUnitTemplate), 'utf8');
  const unit = parseUnit(renderExecutorUnit(template, { root: checkout, node: process.execPath }), '1');
  try {
    // The unit's policy: restart forever, never on a slot the host did not declare, and a watchdog
    // above the executor's own synchronous command timeout so it catches a wedged process only.
    assert.equal(unit.service.Restart, 'always');
    assert.match(template, /^StartLimitIntervalSec=0$/m);
    assert.equal(unit.service.RestartPreventExitStatus, String(executorSlotUndeclaredExit));
    assert.ok(Number(unit.service.WatchdogSec) > 90, 'the watchdog window exceeds the 90s synchronous command timeout');
    assert.equal(unit.service.NotifyAccess, 'all');
    assert.equal(unit.cwd, checkout, 'the unit runs in the coordinator checkout that holds master.json');
    assert.deepEqual(unit.argv, [process.execPath, join(checkout, 'scripts/graphyard-executor.mjs'), '--slot', '1']);

    const supervisor = superviseLikeSystemd(unit, env, log);
    try {
      // 1. The unit starts an executor: it reads the declaration (kinds, interval), claims under a
      //    stable slot name, and is inside the resync handler the control plane is holding open.
      await until(() => plane.state.held.length === 1, `the first executor to claim and enter its handler\n${log.join('')}`, 90_000);
      const first = supervisor.current();
      assert.equal(plane.row.state, 'claimed'); assert.equal(plane.row.claim?.executor, 'master@unit-host/1'); assert.equal(plane.row.claim?.host, 'unit-host');
      assert.deepEqual(plane.state.claims[0].kinds, ['resync'], 'a slot serves the kinds the host declared');
      assert.equal(plane.row.attempts, 1);
      assert.match(log.join(''), /serving resync every 1s as slot 1 under systemd supervision/);

      // 2. Killed outright, mid-action. Nothing is renewed, the claim lapses, and the restart policy
      //    brings the same slot back after RestartSec.
      process.kill(first.pid!, 'SIGKILL');
      await until(() => !processAlive(first.pid!), 'the killed executor to be gone');
      await until(() => supervisor.starts.length === 2, 'the unit to restart the executor', Number(unit.service.RestartSec) * 1000 + 30_000);
      const second = supervisor.current();
      assert.notEqual(second.pid, first.pid);
      assert.deepEqual(supervisor.exits.map(exit => exit.signal), ['SIGKILL']);

      // 3. The restarted executor takes the row the dead one held, as a further attempt of the same
      //    action; the handler now completes and the row settles. The claim was never stranded.
      await until(() => plane.state.resyncs >= 2, `the restarted executor to re-claim the lapsed row and run it\n${log.join('')}`, 60_000);
      plane.release();
      await until(() => plane.row.state === 'done', `the re-claimed action to settle\n${log.join('')}`, 30_000);
      assert.equal(plane.row.attempts, 2);
      assert.equal(plane.row.result, 'done');
      assert.deepEqual(plane.row.history.map(entry => entry.event), ['claimed', 'reclaimed', 'claimed', 'completed']);
      assert.match(plane.row.history.find(entry => entry.event === 'reclaimed')!.reason, /claim by master@unit-host\/1 expired without a result/);
      assert.equal(plane.row.history.at(-1)!.executor, 'master@unit-host/1', 'the restarted slot settled under the same stable name');
      // Both incarnations answered the watchdog: ready at start, a keep-alive per poll.
      await until(async () => (await readFile(notifications, 'utf8').catch(() => '')).split('\n').filter(line => line === 'WATCHDOG=1').length >= 2, 'watchdog keep-alives from both incarnations');
      const notified = (await readFile(notifications, 'utf8')).trim().split('\n');
      assert.equal(notified.filter(line => line === '--ready').length, 2, 'each start told systemd it was ready');
    } finally { await supervisor.stop(); }
    const stopped = supervisor.current();
    assert.ok(stopped.exitCode === 0 || stopped.signalCode === 'SIGTERM', `a SIGTERM from the supervisor stops the executor cleanly (${stopped.exitCode}, ${stopped.signalCode})\n${log.join('')}`);

    // 4. A slot above the declared count exits with the status the unit refuses to restart on,
    //    naming the command that would declare it, so an over-enabled instance does not flap.
    const undeclared = parseUnit(renderExecutorUnit(template, { root: checkout, node: process.execPath }), '2');
    const stray = superviseLikeSystemd(undeclared, env, log);
    await until(() => stray.exits.length === 1, 'slot 2 to exit', 90_000);
    await delay(200);
    assert.equal(stray.exits[0].code, executorSlotUndeclaredExit);
    assert.equal(stray.starts.length, 1, 'RestartPreventExitStatus keeps the undeclared slot down');
    assert.match(log.join(''), /Slot 2 is above this host's declared count of 1; raise it with node scripts\/graphyard-executor.mjs --install --count 2/);

    // 5. Connecting a coordinator host installs and enables that supervision: `init` writes the
    //    declaration (kept as declared), binds the template to this checkout, enables one
    //    instance per slot, and disables an instance enabled under a larger earlier declaration.
    const systemctl: string[][] = [];
    const runSystemctl: SystemctlRunner = args => {
      systemctl.push(args);
      if (args[0] === 'list-units') return `graphyard-executor@1.service loaded active running Graphyard executor slot 1\ngraphyard-executor@3.service loaded inactive dead Graphyard executor slot 3\n`;
      if (args[0] === 'list-unit-files') return 'graphyard-executor@3.service enabled -\n';
      if (args[0] === 'is-active') return 'active';
      return '';
    };
    const unitDirectory = join(credentials, 'systemd-user');
    const setup = await setupRepository(checkout, { url, cliPath: launcher, hostId: 'unit-host' }, { executors: { run: runSystemctl, unitDirectory, node: process.execPath } });
    assert.equal(setup.executors?.installed, true, JSON.stringify(setup.executors));
    const installed = setup.executors as Awaited<ReturnType<typeof installExecutorSupervision>>;
    assert.deepEqual(installed.declaration, { version: 1, count: 1, kinds: ['resync'], intervalSeconds: 1 }, 'the declaration the host already made is kept');
    assert.equal(await readFile(join(unitDirectory, executorUnitTemplate), 'utf8'), renderExecutorUnit(template, { root: checkout, node: process.execPath }));
    assert.deepEqual(systemctl.filter(args => ['daemon-reload', 'enable', 'disable'].includes(args[0])), [['daemon-reload'], ['enable', '--now', executorUnit(1)], ['disable', '--now', executorUnit(3)]]);
    assert.deepEqual(installed.units, [{ slot: 1, unit: executorUnit(1), active: 'active' }]);
    assert.deepEqual(installed.disabled, [executorUnit(3)]);
    // A host without a coordinator credential installs nothing: it can run no executor.
    const workerOnly = await temporaryDirectory('worker-only');
    try { git(workerOnly, 'init', '-q'); assert.equal((await setupRepository(workerOnly, { url, cliPath: launcher, hostId: 'w' }, { executors: { run: runSystemctl, unitDirectory } })).executors, null); }
    finally { await rm(workerOnly, { recursive: true, force: true }); }
    // And a host without a systemd user manager keeps its declaration and is told what to copy by hand.
    const unsupervised = await installExecutorSupervision(checkout, { count: 2, run: () => { throw new Error('Failed to connect to bus'); }, unitDirectory });
    assert.equal(unsupervised.installed, false);
    assert.match(unsupervised.next, /copy examples\/master\/graphyard-executor@\.service .*graphyard-executor@1\.service graphyard-executor@2\.service/);
    assert.equal((await readExecutorDeclaration(checkout))!.count, 2);
    // What `master status` reads from this host: the exact unit to start for a slot that is down.
    const status = await executorSupervisionStatus(checkout, args => { if (args[0] === 'is-active') { const error = new Error('inactive') as Error & { stdout: string }; error.stdout = 'inactive\n'; throw error; } return ''; });
    assert.deepEqual(status.units.map(unit => unit.active), ['inactive', 'inactive']);
    assert.equal(status.start, `systemctl --user start ${executorUnit(1)} ${executorUnit(2)}`);
  } finally {
    await new Promise<void>(resolve => plane.http.close(() => resolve()));
    await rm(checkout, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true });
  }
});

// --- Against a real control plane: presence, the unserved report, and a killed worker's partial work ---

const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA].map(principal => ({ ...principal, token: `supervision-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, home: string;

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(principal, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows as { actor: string; kind: string; payload: any }[];
const fresh = () => store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
async function released(title: string) {
  const work = await ok(operator, 'POST', 'work', { title, plannedFiles: [`src/${title.replace(/\W+/g, '-')}.ts`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }] }) as Work;
  return ok(operator, 'POST', `work/${work.id}/ready`, {}) as Promise<Work>;
}
const dashboard = (work: Work[], status: any, selected: string | null = null): any => ({
  token: '', work, status, error: '', connected: true, lastUpdated: null, view: 'overview', setView: () => {}, filter: null, setFilter: () => {}, selected, setSelected: () => {}, creating: false, setCreating: () => {},
  busy: false, setBusy: () => {}, observedAt: Date.now(), jobs: [], query: '', setQuery: () => {}, operatorAgents: [], events: [], operatorAgentsError: null,
  features: {}, editingRequirements: false, setEditingRequirements: () => {}, codexAvailable: false, queue: [], sessionEpoch: { current: 0 },
  api: async () => ({}), refresh: async () => {}, action: async () => {}, setError: () => {}, signOut: () => {},
  // The board GET /api/board serves over the same work (GY-200): the Work page renders its groups.
  board: boardFromStatus(work, Date.now(), status),
});

before(async () => {
  const port = Number(process.env.GRAPHYARD_EXECUTOR_SUPERVISION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 30);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('executor-supervision-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('supervision_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/supervision_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  home = await temporaryDirectory('executor-supervision');
  await mkdir(join(home, 'env-a'), { recursive: true });
  await writeFile(join(home, 'env-a/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-real-token', refreshToken: 'not-a-real-token' } }));
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); await rm(home, { recursive: true, force: true }).catch(() => {}); });

test('integration:unserved-queue-visible: a pending action whose kind no live executor serves is reported as unserved — not queued behind other work — by the control plane, master status and the dashboard, naming its wait and what to start, within the idle bound', async () => {
  await fresh();
  const work = await released('unserved dispatch');
  const item = await reload(work.id);
  const row = item.actionQueue!.actions.find(entry => entry.kind === 'dispatch')!;
  assert.ok(row, 'a released item with nobody on it needs a dispatch, and the control plane keeps the row for it');

  // Nobody polls. The queue alone cannot tell this from every executor being busy; presence can.
  const before = await ok(coordinator, 'GET', 'actions');
  assert.deepEqual(before.executors.live, []);
  assert.deepEqual(before.executors.unserved.map((entry: any) => [entry.key, entry.kind]), [[item.key, 'dispatch']]);
  assert.match(before.executors.unserved[0].start, /systemctl --user start graphyard-executor@1/);

  // A kind no executor may ever run is not a fleet failure. `escalate` and `request-rework` are
  // in-step judgments: `executorRunnableKinds` forbids a handler for either and the shipped
  // executor refuses the kind outright, so however long such a row waits it is never reported as
  // unserved and the start command it would have carried is never offered.
  assert.deepEqual(['escalate', 'request-rework'].filter(kind => (executorRunnableKinds as readonly string[]).includes(kind)), [], 'no executor may run an in-step judgment');
  const raised = await released('standing escalation');
  const claimed = await ok(workerA, 'POST', `work/${raised.id}/claim`, {}) as Work;
  await ok(workerA, 'POST', `work/${raised.id}/request`, { type: 'escalation', epoch: claimed.epoch, trigger: 'security-concern', reason: 'a judgment, not an executor step' });
  // An escalation no longer freezes the work it does not block (GY-104): with nobody on the item
  // its next step is the assignment, carrying the concern. Once a worker holds it again, the
  // concern is what is left to do.
  await ok(workerA, 'POST', `work/${raised.id}/claim`, {});
  const held = await reload(raised.id);
  assert.equal(held.nextAction!.kind, 'escalate', 'a standing escalation needs a judgment, not an executor');
  assert.ok(held.actionQueue!.actions.some(entry => entry.kind === 'escalate'), 'the control plane keeps an open row for that escalation');
  const withEscalation = await ok(coordinator, 'GET', 'actions');
  assert.deepEqual(withEscalation.executors.unserved.map((entry: any) => [entry.key, entry.kind]), [[item.key, 'dispatch']], 'the standing escalation is not an unserved kind, however dead the fleet');

  // An executor that serves merge and resync polls. It is alive and visible, and the dispatch row
  // is still unserved: its kind is what nobody runs, not its place in the queue.
  const stopping = new AbortController();
  try {
  const effects = executorEffects({ url, token: token(coordinator) }, { merge: async () => 'not reached', resync: async () => 'not reached' });
  const executorHost = { id: 'master-loop@runner-3/1', host: 'runner-3' };
  const running = runExecutor(executorHost, effects, { intervalMs: 200, signal: stopping.signal });
  await until(async () => (await ok(coordinator, 'GET', 'actions')).executors.live.length === 1, 'the polling executor to appear as live');
  const during = await ok(coordinator, 'GET', 'actions');
  assert.deepEqual(during.executors.live.map((entry: any) => ({ executor: entry.executor, host: entry.host, kinds: entry.kinds })), [{ executor: executorHost.id, host: 'runner-3', kinds: ['resync', 'merge'] }]);
  assert.deepEqual(during.executors.served, ['merge', 'resync']);
  assert.equal(during.executors.unserved.length, 1);
  assert.equal(during.executors.unserved[0].kind, 'dispatch');
  assert.ok(during.executors.unserved[0].waitedMs >= 0 && typeof during.executors.unserved[0].since === 'string');
  const status = await ok(coordinator, 'GET', 'status');
  assert.equal(status.executors.live, 1);
  assert.equal(status.executors.attention.length, 1);
  assert.match(status.executors.attention[0].text, new RegExp(`^Nothing can run dispatch: ${item.key} has waited \\d+s for an executor that serves it, and the 1 live executor \\(${executorHost.id.replace(/[/@]/g, '\\$&')}\\) serves none of it\\. It is not queued behind other work — start an executor that serves dispatch`));

  // master status: the same fact, addressed to the master with this host's own unit to start.
  const checkout = await temporaryDirectory('status-host');
  try {
    git(checkout, 'init', '-q');
    await mkdir(join(checkout, '.graphyard'), { mode: 0o700 });
    await writeExecutorDeclaration(checkout, { version: 1, count: 1, kinds: null, intervalSeconds: 5 });
    const snapshot = await ok(coordinator, 'GET', 'work-snapshot');
    const fleet = await executorFleet(checkout, path => ok(coordinator, 'GET', path), snapshot, args => { if (args[0] === 'is-active') { const error = new Error('inactive') as Error & { stdout: string }; error.stdout = 'inactive\n'; throw error; } return ''; });
    assert.equal(fleet.presence.available, true);
    assert.equal(fleet.unserved[0].kind, 'dispatch');
    const unserved = fleet.attention.find(entry => entry.text.startsWith('Nothing can run dispatch'))!;
    assert.equal(unserved.subject, item.key);
    assert.equal(unserved.role, 'master'); assert.equal(unserved.human, false);
    assert.equal(unserved.next, `systemctl --user start ${executorUnit(1)}`, 'a declared slot that is down is the thing to start');
    assert.ok(fleet.attention.some(entry => /Executor slot 1 is inactive although this host declares 1 slot/.test(entry.text)) === false, 'the down slot is named once, on the unserved line that already starts it');
  } finally { await rm(checkout, { recursive: true, force: true }); }

  // The dashboard: the home page raises it as an alert, and the item's drawer says nobody can claim
  // its action rather than that it is waiting for an executor.
  const work2 = await reload(work.id);
  const home = renderToStaticMarkup(createElement(OverviewPage, dashboard([work2], { ...status, actor: { role: 'admin' } })));
  assert.match(home, /No executor serves dispatch\./);
  assert.match(home, new RegExp(`Nothing can run dispatch: ${item.key} has waited`));
  assert.match(home, /not queued behind other work/);
  const drawer = renderToStaticMarkup(createElement(WorkDetails, { ...dashboard([work2], { ...status, actor: { role: 'admin' } }, work2.id), item: work2 }));
  assert.match(drawer, /nobody can claim it: no live executor serves dispatch \(waited /);
  assert.doesNotMatch(drawer, /waiting for an executor to claim it/);

  // An executor that does serve dispatch appears, and the kind is served: nothing is unserved.
  const serving = runExecutor({ id: 'master-loop@runner-4/1', host: 'runner-4' }, executorEffects({ url, token: token(coordinator) }, { dispatch: async () => { await delay(60_000, undefined, { signal: stopping.signal }); return 'held'; } }), { intervalMs: 200, signal: stopping.signal });
  await until(async () => (await ok(coordinator, 'GET', 'actions')).executors.served.includes('dispatch'), 'the dispatch executor to appear as live');
  const served = await ok(coordinator, 'GET', 'actions');
  assert.deepEqual(served.executors.unserved, []);
  assert.equal((await ok(coordinator, 'GET', 'status')).executors.attention.length, 0);

  // Every executor stops. Presence lapses inside one claim lease, which is inside the idle bound,
  // and the report says no executor is alive at all.
  stopping.abort(); await running; await serving;
  assert.ok(executorLiveMs <= actionIdleMs, 'a dead fleet is reported inside the idle bound');
  const later = new Date(Date.now() + executorLiveMs + 1);
  const report = executorReport(await store.list(), executorRegistry(engine), later);
  assert.deepEqual(report.live, []);
  assert.deepEqual(report.served, []);
  assert.ok(report.unserved.some(entry => entry.key === item.key), 'the dispatch row is unserved once nobody alive can take it');
  assert.deepEqual([...new Set(report.unserved.map(entry => entry.kind))], ['dispatch'], 'with the whole fleet dead the escalation is still not reported as something to start an executor for');
  const [line] = describeUnserved(report);
  assert.match(line.text, /and no executor is alive\. It is not queued behind other work — start an executor that serves/);
  // The model's own bound on the presence window, so a poll interval that fits it keeps a live
  // executor visible and a stopped one drops out.
  const registry = executorRegistry({});
  const t0 = new Date('2026-09-21T10:00:00Z');
  registry.observe({ executor: 'e', host: 'h', principal: 'p', kinds: [...executorRunnableKinds] }, t0);
  assert.equal(registry.live(new Date(t0.getTime() + executorLiveMs)).length, 1);
  assert.equal(registry.live(new Date(t0.getTime() + executorLiveMs + 1)).length, 0);
  } finally { stopping.abort(); }
});

test('integration:killed-worker-work-preserved: a worker killed outright keeps its partial work as an exhausted one does — committed on the attempt branch before the item is re-dispatched, recorded as interrupted rather than as a spent account — and the next attempt\'s request names the commit', async () => {
  await fresh();
  const profile = { name: 'builder', principal: workerA.id, agentName: 'agent-builder', mode: 'launch' as const, kind: 'claude' as const, credentialFile: join(home, 'builder.token'), accounts: ['env-a'] };
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: join(home, 'coordinator.token'), cliPath: launcher, repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-supervision',
    workers: [profile], environments: [{ name: 'env-a', kind: 'claude', home: join(home, 'env-a') }] }) as MasterConfig;
  const clock = { skewMs: 0 };
  const now = () => Date.now() + clock.skewMs;
  // The worker processes themselves: a real process per attempt, so the kill is a kill. Herdr's
  // inventory is derived from which of them are still alive, as Herdr's would be.
  const agents: { name: string; pane_id: string; pid: number }[] = [];
  const herdr = () => agents.filter(agent => processAlive(agent.pid)).map(agent => ({ name: agent.name, pane_id: agent.pane_id, agent_status: 'working' }));
  const worktrees: string[] = [];
  const dispatched: { work: string; epoch: number }[] = [];
  const stopped: string[] = [];
  const settlementToken = 'd'.repeat(64);
  let fenced = false;
  const effects: DaemonEffects = {
    agents: herdr, herdr: () => ({ agents: herdr(), available: true }),
    credentials: () => inspectProfileAccounts(config, 'worker', config.workers, { builder: { available: true, reason: null } }, { quota: false, now, cacheMs: 0 }),
    snapshot: async () => { const snapshot = await ok(coordinator, 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: new Date(Date.parse(snapshot.now) + clock.skewMs).toISOString() }; },
    closeSession: () => {},
    dispatch: async work => {
      // What the launcher does: claim under the worker, register the worktree, and — when the
      // launch is fenced — record the containment its supervisor created; then start the process.
      const claimed = await ok(workerA, 'POST', `work/${work.id}/claim`, {}) as Work;
      const worktree = await temporaryDirectory('killed-worktree'); worktrees.push(worktree);
      const branch = `graphyard/${work.key.toLowerCase()}-${claimed.epoch}`;
      git(worktree, 'init', '-q', '-b', branch); await writeFile(join(worktree, 'README.md'), 'base\n');
      git(worktree, 'add', '-A'); git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
      await ok(workerA, 'POST', `work/${work.id}/workspace`, { epoch: claimed.epoch, host: 'loop-host', path: worktree, branch });
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      await until(() => !!child.pid && processAlive(child.pid), 'the worker process to start');
      if (fenced) await ok(workerA, 'POST', `work/${work.id}/quarantine`, { epoch: claimed.epoch, settlementHash: createHash('sha256').update(settlementToken).digest('hex'), scope: { unit: `graphyard-watch-${child.pid}-${randomUUID()}.scope`, pid: child.pid } });
      agents.push({ name: profile.agentName, pane_id: `pane-${dispatched.length}`, pid: child.pid! });
      dispatched.push({ work: work.key, epoch: claimed.epoch });
    },
    requestProof: () => {}, merge: async () => ({}), observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'none', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    sessionOutput: () => '',
    reportCapacity: (work, event) => ok(coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
    preserveWork: async (work, epoch, cause = 'interrupted by provider quota exhaustion') => {
      const { preservePartialWork } = await import('../src/master.js');
      return preservePartialWork(work.workspaces.find(entry => entry.epoch === epoch)!.path, `${work.key} attempt ${epoch} ${cause}`);
    },
    stopSupervisor: async orphan => { stopped.push(`${orphan.key}:${orphan.epoch}`); await ok(workerA, 'POST', `work/${orphan.id}/settle`, { epoch: orphan.epoch, settlementToken }); },
  };
  const state: DaemonState = emptyDaemonState(config);
  const cycle = () => runCycle(config, state, effects, now);
  try {
    // --- A. The agent dies under a healthy supervisor, which settles its fence and exits without releasing.
    let work = await released('killed worker');
    await cycle();
    assert.deepEqual(dispatched, [{ work: work.key, epoch: 1 }]);
    work = await reload(work.id);
    assert.equal(work.lease?.owner, workerA.id); assert.equal(work.epoch, 1);
    const [worktree] = worktrees, base = git(worktree, 'rev-parse', 'HEAD');
    // Mid-work: a tracked file edited, a new file written, nothing committed.
    await writeFile(join(worktree, 'README.md'), 'base\nhalf-finished change\n'); await writeFile(join(worktree, 'feature.ts'), 'export const half = true;\n');
    // Killed outright: the process is gone, Herdr stops listing it; no fence stands (the
    // supervisor settled its own quarantine at exit) and the lease is still live.
    process.kill(agents[0].pid, 'SIGKILL');
    await until(() => !processAlive(agents[0].pid), 'the worker process to die');
    assert.deepEqual(herdr(), []);
    // A session still inside its launch window is not judged on its absence from Herdr.
    clock.skewMs += 20_000; await cycle();
    assert.equal(state.actions[preserveKey(work, 1)], undefined, 'a session given less than the appearance window is not yet a dead worker');
    assert.equal((await reload(work.id)).lease?.epoch, 1);
    // Past the window it is a dead worker once it has been seen gone twice: the partial work is
    // committed and recorded, and the attempt ends.
    clock.skewMs += launchAppearanceMs; await cycle();
    assert.equal(state.actions[preserveKey(work, 1)], undefined, 'one reading of an absent session is not a dead worker');
    assert.equal(state.absences[work.id]?.epoch, 1, 'the absence is on the record for the next cycle');
    clock.skewMs += 20_000; const detection = await cycle();
    const preserved = state.actions[preserveKey(work, 1)];
    assert.equal(preserved?.state, 'done', preserved?.detail);
    assert.match(preserved.detail, /ended without submitting: its agent session agent-builder is gone from Herdr \(first seen gone at [^)]+\) and its supervisor has exited without releasing the lease\. Partial work committed at [0-9a-f]{12} on graphyard\/gy-\d+-1/);
    assert.ok(detection.actions.some(action => action.kind === 'preserve' && action.state === 'done'));
    assert.equal(git(worktree, 'status', '--porcelain'), '', 'the worktree is left clean');
    const kept = git(worktree, 'rev-parse', 'HEAD');
    assert.notEqual(kept, base);
    assert.equal(git(worktree, 'log', '-1', '--format=%s'), `WIP: ${work.key} attempt 1 interrupted before it could submit`);
    assert.deepEqual(git(worktree, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['README.md', 'feature.ts']);
    work = await reload(work.id);
    assert.equal(work.lease, null, 'the attempt ended on the record before anything could dispatch the item again');
    const record = work.capacity!.exhaustions[0];
    assert.match(record.reason, /^ended without submitting: its agent session agent-builder is gone from Herdr \(first seen gone at [^)]+\) and its supervisor has exited without releasing the lease$/);
    assert.deepEqual({ ...record, at: null }, { cause: 'interrupted', role: 'worker', epoch: 1, profile: 'builder', account: null, runtime: 'claude', reason: record.reason, resetsAt: null, owner: workerA.id, recordedBy: coordinator.id, at: null,
      partialWork: { state: 'committed', commit: kept, branch: `graphyard/${work.key.toLowerCase()}-1`, path: worktree, detail: 'uncommitted changes were committed on the attempt branch, unpushed' } });
    const history = await events(work);
    assert.ok(history.some(event => event.kind === 'capacity.interrupted' && event.actor === coordinator.id && event.payload.details.exhaustion.partialWork.commit === kept), 'history says interrupted, not exhausted');
    assert.ok(!history.some(event => event.kind === 'capacity.exhausted'), 'a killed worker is never a spent account');
    assert.equal((work as any).pipeline.attempts[0].end, 'released');
    // Re-dispatched on the next cycle, and the next attempt is told where the partial work is.
    clock.skewMs += 20_000; await cycle();
    work = await reload(work.id);
    assert.equal(work.epoch, 2); assert.equal(dispatched.length, 2, JSON.stringify(Object.entries(state.actions).filter(([key]) => key.startsWith('dispatch'))));
    const prompt = workerPrompt(config, work, profile, 2);
    assert.match(prompt, new RegExp(`The previous attempt \\(epoch 1\\) ended without submitting: its agent session agent-builder is gone from Herdr \\(first seen gone at [^)]+\\) and its supervisor has exited without releasing the lease; its work is kept as commit ${kept} on local branch graphyard/${work.key.toLowerCase()}-1 \\(worktree ${worktree}\\)\\. Read it with git log and git show`));
    assert.doesNotMatch(prompt, /ran out of quota/);

    // The second attempt ends the ordinary way — a blocker for the operator, its lease released,
    // its session gone — so the profile is free for the next item and the first is not re-offered.
    await ok(workerA, 'POST', `work/${work.id}/blocked`, { epoch: 2, reason: 'fixture: parked for the operator' });
    await ok(workerA, 'POST', `work/${work.id}/release`, { epoch: 2 });
    process.kill(agents[1].pid, 'SIGKILL'); await until(() => !processAlive(agents[1].pid), 'the second worker process to die');

    // --- B. The agent dies but its supervisor keeps renewing the lease: the orphan step keeps the
    //     partial work and puts it on the record before it stops that supervisor.
    fenced = true;
    let second = await released('orphaned supervisor');
    clock.skewMs += 20_000; await cycle();
    second = await reload(second.id);
    assert.equal(second.epoch, 1); assert.ok(second.containmentQuarantine?.scope, 'the fenced launch recorded its scope');
    const orphanTree = worktrees[2];
    await writeFile(join(orphanTree, 'notes.md'), 'partial\n');
    process.kill(agents[2].pid, 'SIGKILL'); await until(() => !processAlive(agents[2].pid), 'the fenced worker process to die');
    // First observation: seen gone. The supervisor renews once more, which is what proves it orphaned.
    clock.skewMs += 20_000; await cycle();
    assert.equal(stopped.length, 0);
    await ok(workerA, 'POST', `work/${second.id}/heartbeat`, { epoch: 1 });
    clock.skewMs += 20_000; await cycle();
    assert.deepEqual(stopped, [`${second.key}:1`], 'the orphaned supervisor is stopped through its scope');
    const orphanPreserved = state.actions[preserveKey(second, 1)];
    assert.equal(orphanPreserved?.state, 'done', orphanPreserved?.detail);
    assert.match(orphanPreserved.detail, /is gone from Herdr while its supervisor \(pid \d+\) still renewed the lease\. Partial work committed at/);
    assert.equal(git(orphanTree, 'log', '-1', '--format=%s'), `WIP: ${second.key} attempt 1 interrupted before it could submit`);
    second = await reload(second.id);
    assert.equal(second.lease, null); assert.equal(second.containmentQuarantine ?? null, null);
    assert.equal(second.capacity!.exhaustions[0].cause, 'interrupted');
    assert.equal(second.capacity!.exhaustions[0].partialWork.commit, git(orphanTree, 'rev-parse', 'HEAD'));
    clock.skewMs += 20_000; await cycle();
    second = await reload(second.id);
    assert.equal(second.epoch, 2);
    assert.match(workerPrompt(config, second, profile, 2), new RegExp(`its work is kept as commit ${git(orphanTree, 'rev-parse', 'HEAD')}`));
    // A record is made once per attempt: cycling again neither commits nor records anything more.
    const before = JSON.stringify(state.actions[preserveKey(second, 1)]);
    clock.skewMs += 20_000; await cycle();
    assert.equal(JSON.stringify(state.actions[preserveKey(second, 1)]), before);
  } finally {
    for (const agent of agents) { try { process.kill(agent.pid, 'SIGKILL'); } catch { /* already gone */ } }
    for (const worktree of worktrees) await rm(worktree, { recursive: true, force: true });
  }
});
