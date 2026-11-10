import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterCredentialMask, sessionMountNamespaceWorks } from '../src/master/confinement.js';
import { launchSession } from '../src/master/launch.js';
import { herdrSessionPaths } from '../src/master/herdr.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { saveReviewerProfile } from '../src/reviewer.js';
import { migrateHerdr } from '../src/herdr-migration.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { worktreeRoot } from '../src/install/worktree-root.js';
import type { Principal } from '../src/model.js';
import { withDatabase } from './helpers/postgres.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { workFixture } from './helpers/work-fixture.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3237: after a GY-3212 migration moved an install from its private Herdr to the host's main
// one, the master session's confinement still granted only the private instance's socket and
// config, so `herdr agent list` answered "Permission denied" (Landlock denies the main server's
// socket) and `master review GY-N` — the documented recovery step — could not run. A fixture
// install is migrated, and the confined master session, launched the way the loop launches it,
// runs both against the main Herdr's own socket.

const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(checkout, 'bin', 'graphyard.mjs');
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const HEAD = sha40('candidate'), BASE = sha40('base');

test(`e2e:confined-master-main-herdr — a fixture install migrated from its private Herdr to the main one launches a confined master session that runs herdr agent list and master review GY-N against the main server's socket`, { timeout: 600_000 }, async () => {
  assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this host');
  // The fixture HOME lives in this checkout, not the host's tmpdir: the confinement replaces /tmp
  // with its own scratch, which would hide the main Herdr's socket whatever the grant did. It sits
  // directly under the checkout so the main server's socket path fits a Unix socket's 107 bytes.
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  const home = await temporaryDirectory('herdr-home', checkout);
  const root = await temporaryDirectory('herdr-checkout', checkout);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' }).trim();
  const operator: Principal = { id: 'operator', role: 'admin' }, coordinator: Principal = { id: 'master', role: 'coordinator' };
  const tokens = new Map([[operator.id, `operator-${'t'.repeat(32)}`], [coordinator.id, `coordinator-${'t'.repeat(32)}`]]);

  let store: Store | null = null, http: ReturnType<typeof server> | null = null, url = '';
  let herdrServer: ReturnType<typeof createServer> | null = null;
  const saved = { HOME: process.env.HOME, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.GRAPHYARD_CONFIG_HOME = join(home, '.config', 'graphyard');
  try {
    // The control plane the fixture install answers to, with the item its master session reviews.
    store = await withDatabase('confined-master-main-herdr');
    await store.init();
    const engine = new Engine(store, 120, 'owner/project');
    const started = http = server(engine, [operator, coordinator].map(entry => ({ ...entry, token: tokens.get(entry.id)! })));
    await new Promise<void>(resolve => started.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(started.address() as { port: number }).port}`;
    const at = new Date().toISOString();
    const candidate = { sha: HEAD, baseSha: BASE, pr: 7, branch: 'graphyard/gy-1-1', author: 'implementer' };
    const work = workFixture({ id: '1f0c9a5e-7b2d-4c8a-9f3e-6d5b4a3c2d10', key: 'GY-1', title: 'Migrated review', type: 'bug', priority: 1,
      criteria: [{ id: 'AC-1', text: 'The confined master session reaches the main Herdr', proofs: ['e2e:confined-master-main-herdr'] }],
      stage: 'review', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, epoch: 1,
      workspaces: [{ host: 'fixture-host', path: '/w/gy-1', branch: candidate.branch, epoch: 1, owner: 'implementer' }],
      candidate, submission: { epoch: 1, pr: 7 },
      observation: { source: 'control-plane', candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: BASE, baseTree: sha40('tree'), baseTipContained: true },
      gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }] });
    await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);

    // The checkout a pre-GY-3212 release installed: its credential directory under the fixture
    // home, its workspace on its own private Herdr instance.
    const installId = 'owner-project', installDirectory = join(home, '.config', 'graphyard', installId);
    const instance = { configHome: join(installDirectory, 'herdr'), session: 'gy-fixture' };
    mkdirSync(join(instance.configHome, 'herdr', 'sessions', instance.session), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    git(root, 'remote', 'add', 'origin', 'https://github.com/owner/project.git');
    await setupMaster(root, { url, token: tokens.get(coordinator.id)!, cliPath: cli, hostId: 'fixture-host', herdrWorkspace: 'wPrivate',
      credentialDirectory: installDirectory });
    await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude', agentArgs: ['--setting-sources', 'user'] });
    const config = await loadMasterConfig(root);
    assert.equal(config.herdrWorkspace, 'wPrivate');
    // The pre-GY-3212 record: this install runs its own private Herdr instance.
    await (await import('node:fs/promises')).writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ ...config, herdrInstance: instance }, null, 2));
    // The install state a reviewer launch has already created on a real host, which the master
    // session's confinement grants beside its credential.
    mkdirSync(resolve(config.credentialFile, '../..', 'reviewers'), { recursive: true });
    // The registry the reviewer launch selects from, and the account home its login probe reads.
    const claudeHome = join(root, '.graphyard', 'claude-home');
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, 'settings.json'), `${JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-key' } })}\n`);
    const apply = await fetch(`${url}/api/agent-registry/apply`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.get(operator.id)!}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'confined-master-registry' },
      body: JSON.stringify({ runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')], models: [{ name: 'default', id: null }],
        accounts: [{ name: 'claude-a', runtime: 'claude', model: 'default', credential: { host: 'fixture-host', home: claudeHome } }],
        roles: [{ name: 'reviewer', accounts: ['claude-a'], concurrency: 4 }], reason: 'confined-master-main-herdr fixture' }) });
    assert.equal(apply.status, 200, `${apply.status}: ${await apply.text()}`);

    // The migration itself, as the upgrade path runs it: launches move to the main workspace, the
    // drained private server is removed and every record drops herdrInstance.
    const migrationRun = async (_command: string, args: string[]) => {
      if (args[0] === '--session') return JSON.stringify({ panes: [] });
      if (args[0] === 'workspace') return JSON.stringify({ workspaces: [{ workspace_id: 'wMain', label: `graphyard-${installId}` }] });
      return '';
    };
    await migrateHerdr(root, migrationRun, home);
    const migrated = await loadMasterConfig(root);
    assert.equal(migrated.herdrWorkspace, 'wMain');
    assert.equal(migrated.herdrInstance, undefined, 'the drained private instance is gone from the records');

    // The host's main Herdr: a server on its own socket, plus the stub `herdr` client a pane runs.
    const mainHerdr = join(home, '.config', 'herdr');
    mkdirSync(join(mainHerdr, 'sessions', 'wMain'), { recursive: true });
    const socket = join(mainHerdr, 'herdr.sock');
    const localBin = join(home, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    writeFileSync(join(localBin, 'herdr'), [
      '#!/usr/bin/env node',
      "import net from 'node:net';",
      'const client = net.connect(process.env.HERDR_SOCKET_PATH);',
      "client.write(JSON.stringify({ args: process.argv.slice(2) }) + '\\n');",
      "let text = '';",
      "client.on('data', chunk => { text += chunk.toString(); });",
      "client.on('end', () => process.stdout.write(text));",
      "client.on('error', error => { console.error('herdr fixture client: ' + error.message); process.exit(1); });",
      '',
    ].join('\n'));
    chmodSync(join(localBin, 'herdr'), 0o755);
    writeFileSync(join(localBin, 'claude'), '#!/usr/bin/env node\nconsole.log(\'Claude Code ready\');\n');
    chmodSync(join(localBin, 'claude'), 0o755);

    // What the confined master session runs: the two recovery steps the migration left it owing.
    writeFileSync(join(root, '.graphyard', 'master-session-fixture.mjs'), [
      "import { execFileSync } from 'node:child_process';",
      'const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", timeout: 240_000, ...options });',
      "const list = run('herdr', ['agent', 'list']);",
      'if (!Array.isArray(JSON.parse(list).result?.agents)) throw new Error(`herdr agent list did not answer an inventory: ${list}`);',
      "console.log('MASTER-AGENT-LIST-OK');",
      "const review = run(process.execPath, [process.env.GRAPHYARD_CLI, 'master', 'review', 'GY-1'], { cwd: process.env.GRAPHYARD_REPOSITORY_ROOT });",
      "console.log('MASTER-REVIEW-OK ' + review.split('\\n')[0].slice(0, 120));",
      '',
    ].join('\n'));

    // The main server's answers: the pane surface a real Herdr serves, every reply through the socket.
    let connections = 0, agentLists = 0, reviewTabs = 0;
    const herdrNet = herdrServer = createServer(connection => {
      connections++;
      let buffer = '';
      connection.on('data', chunk => {
        buffer += chunk.toString();
        const at = buffer.indexOf('\n');
        if (at < 0) return;
        const { args }: { args: string[] } = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        const json = (result: unknown) => JSON.stringify({ result });
        let answer = '';
        if (args[0] === 'agent' && args[1] === 'list') { agentLists++; answer = json({ agents: [] }); }
        else if (args[0] === 'tab' && args[1] === 'create') {
          reviewTabs++;
          answer = json({ root_pane: { pane_id: 'wMain:review', tab_id: 'wMain:review-tab' } });
        }
        else if (args[0] === 'pane' && args[1] === 'run') {
          // Async, never spawnSync: the server itself must stay answering while the pane runs.
          execFile('/bin/bash', ['-ec', args[3]], { encoding: 'utf8', timeout: 120_000, cwd: process.cwd(),
            env: { PATH: `${localBin}:${process.env.PATH}`, HOME: home } }, (error, stdout, stderr) => {
            connection.end(error ? `${JSON.stringify({ error: { code: 'pane_run_failed', message: `${stdout ?? ''}${stderr ?? ''}${error.message}`.slice(0, 800) } })}\n` : '\n');
          });
          return;
        }
        else {
          const canned = startedAtOnce(args, 'idle');
          if (canned !== null) answer = canned;
          else if (args[0] === 'pane' && args[1] === 'list') answer = json({ panes: [] });
        }
        connection.end(`${answer}\n`);
      });
    });
    await new Promise<void>(resolve => herdrNet.listen(socket, resolve));

    // The launch the loop makes: the pane environment names the main Herdr's socket, exactly as a
    // pane the main server created inherits it, and the confinement grants what the install
    // records now — the main Herdr — beside the master's own state.
    const paneEnvironment: Record<string, string> = {
      PATH: `${localBin}:${dirname(process.execPath)}:${process.env.PATH}`,
      HERDR_SOCKET_PATH: socket,
      GRAPHYARD_URL: url,
      GRAPHYARD_HOST_ID: 'fixture-host',
      GRAPHYARD_CLI: cli,
      GRAPHYARD_REPOSITORY_ROOT: root,
    };
    let masterOutput = '';
    const run = async (_command: string, args: string[]) => {
      if (args[0] === 'tab' && args[1] === 'create') return JSON.stringify({ result: { root_pane: { pane_id: 'wMain:master', tab_id: 'wMain:master-tab' } } });
      if (args[0] === 'pane' && args[1] === 'run') {
        // The typed line carries the whole confinement: running it is running the session. Async,
        // never spawnSync — the socket server below must keep answering while the session runs.
        masterOutput = await new Promise<string>((resolve, reject) =>
          execFile('/bin/bash', ['-ec', args[3]], { encoding: 'utf8', timeout: 300_000, cwd: root, env: { ...paneEnvironment, HOME: home } },
            (error, stdout, stderr) => error ? reject(new Error(`the confined master session exited: ${`${stdout ?? ''}\n${stderr ?? ''}`.slice(-1200)}`)) : resolve(`${stdout ?? ''}\n${stderr ?? ''}`)));
        return '';
      }
      return startedAtOnce(args, 'idle') ?? JSON.stringify({ result: {} });
    };
    const launched = await launchSession({ name: config.masterAgentName, kind: process.execPath, args: [join(root, '.graphyard', 'master-session-fixture.mjs'), '{request}'],
      text: 'Run the recovery steps the migration left this install owing.', workspace: migrated.herdrWorkspace, label: 'Graphyard master · owner/project',
      environment: { GRAPHYARD_MASTER: '1', ...paneEnvironment }, run,
      onPane: () => undefined,
      start: { directory: root, cwd: root, coordinatorRoot: root, environment: paneEnvironment, confinement: 'master', timeoutMs: 240_000,
        masterStateDirectory: dirname(config.credentialFile),
        stateDirectories: [resolve(config.credentialFile, '../..', 'reviewers'), worktreeRoot(root, migrated)],
        credentialMask: masterCredentialMask(config, []), herdrPaths: herdrSessionPaths(migrated) } });
    assert.equal(launched.started.state, 'started', launched.started.detail);

    // Both recovery steps ran inside the confinement and reached the main server through its socket.
    assert.ok(masterOutput.includes('MASTER-AGENT-LIST-OK'), `herdr agent list ran inside the confinement: ${masterOutput.slice(-800)}`);
    assert.ok(masterOutput.includes('MASTER-REVIEW-OK'), `master review GY-1 ran inside the confinement: ${masterOutput.slice(-800)}`);
    assert.ok(agentLists >= 1, 'the main Herdr served the agent inventory');
    assert.ok(reviewTabs >= 1, 'the main Herdr served the reviewer launch of master review');
    assert.ok(connections >= 2, 'every answer came through the main server\'s own socket');
  } finally {
    if (herdrServer) await new Promise<void>(resolve => (herdrServer as NonNullable<typeof herdrServer>).close(() => resolve()));
    if (http) { (http as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); await new Promise<void>(resolve => http!.close(() => resolve())); }
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete (process.env as Record<string, string | undefined>)[name]; else (process.env as Record<string, string | undefined>)[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('unit:tests/confined-master-main-herdr.test.ts — a master pane a Herdr migration left in the moved-away workspace is closed through the recorded private instance once, and the master relaunches; a pane in the current workspace, or with no instance recorded, is not', async () => {
  const { runCycle } = await import('../src/daemon/cycle.js');
  const { emptyDaemonState } = await import('../src/daemon/state.js');
  const { masterConfigSchema } = await import('../src/master.js');
  const directory = await temporaryDirectory('confined-master-relaunch');
  const instance = { configHome: join(directory, 'herdr'), session: 'gy-fixture' };
  const MASTER = 'graphyard-master-project';
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: `${directory}/coordinator.token`, cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: MASTER, workers: [], herdrWorkspace: 'wMain', herdrInstance: instance });
  const state = emptyDaemonState(config);
  state.master = { ...state.master, agentName: MASTER, pane: 'wPrivate:p2', runtime: 'claude', account: 'a', session: 'session-a', startedAt: new Date(Date.now() - 3_600_000).toISOString() };
  const closed: { pane: string; instance: typeof instance }[] = [], ended: string[] = [], launched: string[] = [];
  const effects = {
    snapshot: async () => ({ work: [], now: new Date().toISOString() }),
    herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    dispatch: async () => { throw new Error('no dispatch'); },
    masterSession: {
      launch: async () => { launched.push(`pane-${launched.length + 1}`); return { agentName: MASTER, pane: `pane-${launched.length}`, runtime: 'claude', account: 'a', session: 'session-b' }; },
      end: async (session: string) => { ended.push(session); },
      closeMigratedPane: async (pane: string, target: typeof instance) => { closed.push({ pane, instance: target }); },
    },
    persist: async () => {},
  };
  // The migrated-away pane is invisible to the current inventory; the cycle closes it through the
  // private instance and relaunches the master into the main workspace.
  await runCycle(config, state, effects as never);
  assert.deepEqual(closed, [{ pane: 'wPrivate:p2', instance }]);
  assert.equal(launched.length, 1, 'the master relaunches with a confinement for the install the migration left');
  assert.equal(state.master.pane, 'pane-1');
  assert.equal(state.actions['master:migrate-pane:wPrivate:p2']?.state, 'done');
  await runCycle(config, state, effects as never);
  assert.deepEqual(closed, [{ pane: 'wPrivate:p2', instance }], 'the close is not repeated');
  // With no private instance recorded there is nothing to close through: the pane is simply absent.
  closed.length = 0;
  const plain = { ...config, herdrInstance: undefined };
  const freshState = emptyDaemonState(plain);
  freshState.master = state.master;
  await runCycle(plain, freshState, effects as never);
  assert.deepEqual(closed, [], 'no recorded instance, no instance-targeted close');
  // A pane the current inventory still shows is the ordinary live master, never closed here.
  const visible = { ...effects, herdr: () => ({ agents: [{ name: MASTER, pane_id: 'wPrivate:p2', agent: 'claude', agent_status: 'working' }], available: true }) };
  await runCycle(plain, freshState, visible as never);
  assert.deepEqual(closed, []);
});
