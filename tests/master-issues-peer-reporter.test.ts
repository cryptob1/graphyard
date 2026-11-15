import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterCredentialMask, peerTokenDirectory, preparePeerExchange, sessionMountNamespaceWorks } from '../src/master/confinement.js';
import { herdrSessionPaths } from '../src/master/herdr.js';
import { launchSession } from '../src/master/launch.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import { worktreeRoot } from '../src/install/worktree-root.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { peerCommand } from '../src/cli/master/peers.js';
import type { MasterSession } from '../src/cli/master/session.js';
import { withDatabase } from './helpers/postgres.js';
import { expandTypedCommand } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Principal } from '../src/model.js';

// GY-3385: `principal add` needs a host write the confined Master session is refused (EROFS on the
// install's apply lock), so no install could peer. `master peer issue --root DIR` mints the peer's
// reporter identity through the control plane from the Master's own session and places the token
// under that install's config directory. Install A's master session is launched the way the loop
// launches it, under its real confinement: a session launched before the peer was recorded places
// nothing and names the rerun; the relaunched session places the token, each side records the peer,
// and B's master send reaches A authenticated as the identity A's confined session issued.

const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(checkout, 'bin', 'graphyard.mjs');
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const closers: (() => Promise<void>)[] = [];
after(async () => { for (const close of closers.reverse()) await close(); });

/** The pane surface the stubs report: each pane's runtime kind, recorded from its typed launch line the way Herdr classifies one. */
const paneKinds = new Map<string, string>();
const recordTypedRuntime = (args: string[]) => { paneKinds.set(args[2], expandTypedCommand(args[3]).kind); };
const shellAnswers = (args: string[]): string | null => {
  const pane = args[1] === 'process-info' ? args[3] : args[2];
  const kind = paneKinds.get(pane) ?? 'claude';
  const json = (result: unknown) => JSON.stringify({ result });
  if (args[0] === 'pane' && args[1] === 'read') return `${kind === 'claude' ? 'Claude Code' : kind} ready\n`;
  if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: kind, agent_status: 'idle', pane_id: pane } });
  if (args[0] === 'pane' && args[1] === 'process-info') return json({ process_info: { shell_pid: 100, foreground_process_group_id: 200, foreground_processes: [{ argv: [kind] }] } });
  if (args[0] === 'agent' && args[1] === 'rename') return json({ agent: { agent: kind, agent_status: 'idle', name: args[3] } });
  return null;
};

interface FixtureInstall { name: string; root: string; url: string; command: (id: 'peer' | 'send', ...args: string[]) => Promise<any>; messages: () => Promise<{ id: number; from: string; text: string }[]> }

test(`e2e:master-issues-peer-reporter — a confined Master session issues another install on its host its reporter identity; both sides peer and the peer's send reaches it`, { timeout: 600_000 }, async () => {
  assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this host');
  // The fixture HOME lives under this checkout, not the host's tmpdir: the confinement replaces
  // /tmp with its own scratch, which would hide every path under it the wrapper must bind.
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  const home = await temporaryDirectory('peer-issue-home', join(checkout, '.graphyard'));
  const scratch = await temporaryDirectory('peer-issue-scratch', join(checkout, '.graphyard'));
  const saved = { HOME: process.env.HOME, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME };
  process.env.HOME = home;
  process.env.GRAPHYARD_CONFIG_HOME = join(home, '.config', 'graphyard');
  const installs: Record<string, FixtureInstall> = {};

  const install = async (name: string): Promise<FixtureInstall> => {
    const coordinator: Principal = { id: `${name}-master`, role: 'coordinator' };
    const store: Store = await withDatabase(`master_issues_peer_${name.replace(/\W/g, '_')}`);
    await store.init();
    const engine = new Engine(store, 120, `owner/${name}`);
    const http = server(engine, [{ ...coordinator, token: token(coordinator) }]);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    let running = true;
    closers.push(async () => { if (!running) return; running = false; http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); });
    const api = async (path: string, body?: unknown, key?: string) => {
      const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(coordinator)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key ?? crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json() as any;
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result;
    };
    const root = await temporaryDirectory(`peer-issue-${name}`, scratch);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '--initial-branch=main');
    git('remote', 'add', 'origin', `https://github.com/owner/${name}.git`);
    await writeFile(join(root, 'README.md'), 'Fixture.\n');
    git('add', '.'); git('commit', '-qm', 'base');
    await setupMaster(root, { url, token: token(coordinator), cliPath: cli, hostId: 'fixture-host', herdrWorkspace: `w-${name}`,
      credentialDirectory: join(process.env.GRAPHYARD_CONFIG_HOME!, name), run: { worktreeRoot: await temporaryDirectory(`peer-issue-${name}-worktrees`, scratch) } });
    /** The real `graphyard master peer|send` subcommand, as this install's Master runs it in its own session. */
    const command = async (id: 'peer' | 'send', ...args: string[]) => {
      const printed: any[] = [];
      await peerCommand({ id, args, print: (value: unknown) => printed.push(value), root, master: await loadMasterConfig(root), masterApi: (path: string) => api(path), masterMutation: (path: string, data: unknown, key?: string) => api(path, data, key) } as unknown as MasterSession);
      return printed[0];
    };
    const made: FixtureInstall = { name, root, url, command, messages: async () => (await api('master/messages')).messages };
    installs[name] = made;
    return made;
  };

  // What the confined master session runs: the real CLI's peer issue against the other checkout.
  const issueScript = (peerRoot: string) => {
    const script = join(installs['install-a']!.root, '.graphyard', 'peer-issue-fixture.mjs');
    writeFileSync(script, [
      "import { execFile } from 'node:child_process';",
      'const outcome = await new Promise(resolve => execFile(process.execPath,',
      "  [process.env.GRAPHYARD_CLI, 'master', 'peer', 'issue', '--root', process.env.PEER_ROOT],",
      "  { encoding: 'utf8', timeout: 180_000, cwd: process.env.GRAPHYARD_REPOSITORY_ROOT },",
      '  (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, output: `${stdout ?? ""}${stderr ?? ""}` })));',
      "console.log(`PEER-ISSUE-EXIT ${outcome.code}`);",
      'console.log(`PEER-ISSUE-OUT ${outcome.output.replace(/\\s+/g, " ").slice(0, 1500)}`);',
      '',
    ].join('\n'));
    chmodSync(script, 0o600);
    return script;
  };

  /** Launch install A's master session the way the loop does: under its real confinement, its state and each recorded peer's token directory granted writable. */
  const launchConfined = async (peerRoot: string) => {
    const a = installs['install-a']!;
    const config = await loadMasterConfig(a.root);
    const script = issueScript(peerRoot);
    const paneEnvironment: Record<string, string> = { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, GRAPHYARD_REPOSITORY_ROOT: a.root, GRAPHYARD_CLI: cli, PEER_ROOT: peerRoot };
    let masterOutput = '';
    const run = async (_command: string, args: string[]) => {
      if (args[0] === 'tab' && args[1] === 'create') return JSON.stringify({ result: { root_pane: { pane_id: 'w-install-a:master', tab_id: 'w-install-a:master-tab' } } });
      if (args[0] === 'pane' && args[1] === 'run') {
        recordTypedRuntime(args);
        // The typed line carries the whole confinement: running it is running the session.
        masterOutput = await new Promise<string>((resolve, reject) =>
          execFile('/bin/bash', ['-ec', args[3]], { encoding: 'utf8', timeout: 300_000, cwd: a.root, env: { ...paneEnvironment, HOME: home } },
            (error, stdout, stderr) => error ? reject(new Error(`the confined master session exited: ${`${stdout ?? ''} ${stderr ?? ''}`.replace(/\s+/g, ' ').slice(-2000)}`)) : resolve(`${stdout ?? ''}\n${stderr ?? ''}`)));
        return '';
      }
      return shellAnswers(args) ?? JSON.stringify({ result: {} });
    };
    const launched = await launchSession({ name: config.masterAgentName, kind: process.execPath, args: [script, '{request}'],
      text: 'Issue the peer install its reporter identity.', workspace: config.herdrWorkspace, label: `Graphyard master · ${config.repository}`,
      environment: { GRAPHYARD_MASTER: '1', ...paneEnvironment }, run, onPane: () => undefined,
      start: { directory: a.root, cwd: a.root, coordinatorRoot: a.root, environment: paneEnvironment, confinement: 'master', timeoutMs: 240_000,
        contract: { args: [script, '{request}'] },
        masterStateDirectory: dirname(config.credentialFile),
        stateDirectories: [resolve(config.credentialFile, '../..', 'reviewers'), worktreeRoot(a.root, config), ...preparePeerExchange(config)],
        credentialMask: masterCredentialMask(config, []), herdrPaths: herdrSessionPaths(config) } });
    assert.equal(launched.started.state, 'started', launched.started.detail);
    return masterOutput;
  };

  try {
    const a = await install('install-a'), b = await install('install-b');
    const directoryOf = async (root: string) => dirname(dirname((await loadMasterConfig(root)).credentialFile));
    const tokensOf = async (root: string, name: string) => join(peerTokenDirectory(await directoryOf(root)), `${name}.token`);

    // The session the loop launched before any peer existed records the peer and names the rerun:
    // its confinement grants no peer directory, and the token is placed by nothing.
    const first = await launchConfined(b.root);
    assert.match(first, /PEER-ISSUE-EXIT 1/, `the first session's issue failed as expected: ${first.slice(-800)}`);
    assert.match(first, /could not be placed.*peer is recorded.*rerun master peer issue --root \S*install-b/s, first.slice(-800));
    const recorded = (await loadMasterConfig(a.root)).peers;
    assert.equal(recorded?.length, 1);
    assert.equal(recorded![0]!.name, 'install-b');
    assert.equal(recorded![0]!.url, b.url);
    assert.equal(recorded![0]!.tokenFile, await tokensOf(a.root, 'install-b'), 'the entry names the token the peer will place under this install');
    assert.equal(recorded![0]!.configDirectory, await directoryOf(b.root), 'the entry names the peer install, earning the relaunch its grant');
    assert.ok(!existsSync(await tokensOf(b.root, 'install-a')), 'no token was placed by the session without the grant');

    // The relaunched session — the loop's next launch, now with the peer recorded — places it.
    const second = await launchConfined(b.root);
    assert.match(second, /PEER-ISSUE-EXIT 0/, `the relaunched session's issue succeeded: ${second.slice(-800)}`);
    assert.match(second, /"issued": ?"install-b"/, second.slice(-800));
    const tokenFile = await tokensOf(b.root, 'install-a');
    assert.ok(existsSync(tokenFile), `the reporter token landed in the peer install's config directory: ${tokenFile}`);
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600, 'the token file has mode 0600');
    assert.match(readFileSync(tokenFile, 'utf8'), /^gyr_/, 'the file holds the minted reporter token');
    // The peer's own Master issues its side from its session the same way, and each list names the other.
    assert.deepEqual(await b.command('peer', 'issue', '--root', a.root), { issued: 'install-a', url: a.url, reporter: 'install-a', tokenFile: await tokensOf(a.root, 'install-b'), next: `Its Master records this side from its own session: master peer issue --root ${b.root}` });
    assert.deepEqual((await a.command('peer', 'list')).peers.map((peer: { name: string }) => peer.name), ['install-b']);
    assert.deepEqual((await b.command('peer', 'list')).peers.map((peer: { name: string }) => peer.name), ['install-a']);

    // The peer's Master reaches the first install through Graphyard, authenticated as the identity
    // the confined session issued: its send is stored on the first install's plane.
    const sent = await b.command('send', 'install-a', 'GY-7', 'here', 'fails', 'on', 'your', 'trial', 'image;', 'can', 'you', 'add', 'Go', '1.23?');
    assert.equal(sent.sent, 'install-a');
    const received = (await a.messages()).find(message => message.from === 'install-b');
    assert.equal(received?.text, 'GY-7 here fails on your trial image; can you add Go 1.23?');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete (process.env as Record<string, string | undefined>)[name]; else (process.env as Record<string, string | undefined>)[name] = value;
    }
  }
});
