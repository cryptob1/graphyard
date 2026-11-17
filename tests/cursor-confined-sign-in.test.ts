import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialMaskFor, readOnlyMountWrapper, sessionMountNamespaceWorks, type MaskProbe } from '../src/master/confinement.js';
import { sessionConfinement } from '../src/master/launch.js';
import { accountLaunch, checkAgentEnvironment } from '../src/master/environments.js';
import { runtimeLoginHomes } from '../src/master/profiles.js';
import { connectProvider, observeAccount, relaySubscriptionLogin, type FleetLaunchAccount } from '../src/fleet.js';
import { runSmokePrompt } from '../src/master/connect-accounts.js';
import { headlessArgs } from '../src/headless-session.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, foldObservations, proposedRuntimes, type AgentRegistry } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3329: on a host with no desktop keyring cursor-agent saves its sign-in to
// `$XDG_CONFIG_HOME/cursor/auth.json` (falling back to `$HOME/.config/cursor/auth.json`) and never
// reads it from CURSOR_CONFIG_DIR, so a confined worker — private HOME, no XDG_CONFIG_HOME — found
// no sign-in and failed with "Authentication required. Please run 'agent login' first", while the
// account still looked logged in. Each cursor account's home is now its XDG config home in every
// launch, login and smoke check, and the login probe reads the sign-in file itself: a confined
// worker on an account with a sign-in authenticates, a second account cannot read the first
// account's sign-in, and an account with no usable sign-in reads not logged in, names the login
// command, and is never selected for launch.

const HOST = 'cursor-host-1';
const hostProbe: MaskProbe = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A stand-in cursor-agent on a keyring-less host: it reads its sign-in the way the real one does — `$XDG_CONFIG_HOME/cursor/auth.json`, falling back to `$HOME/.config/cursor/auth.json` — and never from CURSOR_CONFIG_DIR. */
const stubCursorAgent = (bin: string) => {
  const script = join(bin, 'cursor-agent');
  writeFileSync(script, [
    '#!/bin/sh',
    'sign_in="${XDG_CONFIG_HOME:-$HOME/.config}/cursor/auth.json"',
    'case "$1" in',
    '  login)',
    '    # The login writes the sign-in where the runtime reads it, and its profile beside it.',
    '    mkdir -p "$(dirname "$sign_in")" "$CURSOR_CONFIG_DIR"',
    '    printf \'{"accessToken":"%s"}\\n\' "signed-in-through-$CURSOR_CONFIG_DIR" > "$sign_in"',
    '    printf \'{"authInfo":{"userId":"%s"}}\\n\' "$(basename "$CURSOR_CONFIG_DIR")" > "$CURSOR_CONFIG_DIR/cli-config.json"',
    '    echo "Visit https://cursor.example/device and enter code CURSOR-1234"',
    '    exit 0;;',
    'esac',
    'if [ -s "$sign_in" ]; then printf "AUTHENTICATED $(cat "$sign_in")\\nOK\\n"; exit 0; fi',
    "echo \"Authentication required. Please run 'agent login' first\" >&2",
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  symlinkSync(script, join(bin, 'agent'));
  return script;
};

function fixture(home: string) {
  const root = join(home, 'code', 'project');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
  writeFileSync(join(root, 'test.js'), 'console.log(\'the fixture test passes\');\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'seed');
  const worktree = join(root, '.graphyard', 'worktrees', 'gy-3329-1');
  mkdirSync(dirname(worktree), { recursive: true });
  git(root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-3329-1', worktree, 'main');
  for (const [key, value] of [['user.email', 'w@t'], ['user.name', 'Worker']]) git(worktree, 'config', key, value);
  writeFileSync(join(root, 'advance.md'), 'advanced on main\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'advance main');
  git(root, 'update-ref', 'refs/remotes/origin/main', git(root, 'rev-parse', 'HEAD'));

  // Two cursor accounts with their own sign-ins, and a third that only looks logged in: its
  // cli-config.json profile is there, but no sign-in a confined session can read.
  const accounts = join(home, '.coding_agents');
  const account = (name: string, token: string | null) => {
    const accountHome = join(accounts, name);
    mkdirSync(join(accountHome, 'cursor'), { recursive: true });
    // GY-3414: a signed-in profile names its user in authInfo; a profile-only one does not.
    writeFileSync(join(accountHome, 'cli-config.json'), `${JSON.stringify(token ? { authInfo: { userId: name } } : {}, null, 2)}\n`, { mode: 0o600 });
    if (token) writeFileSync(join(accountHome, 'cursor', 'auth.json'), `${JSON.stringify({ accessToken: token }, null, 2)}\n`, { mode: 0o600 });
    return accountHome;
  };
  const cursorA = account('cursor-a', 'cursor-a-sign-in'), cursorB = account('cursor-b', 'cursor-b-sign-in'), cursorC = account('cursor-c', null);
  // The operator's own cursor sign-in, where a keyring-less cursor-agent keeps it: no confined
  // session may read it, and no launch may fall back to it.
  const operatorSignIn = join(home, '.config', 'cursor', 'auth.json');
  mkdirSync(dirname(operatorSignIn), { recursive: true });
  writeFileSync(operatorSignIn, `${JSON.stringify({ accessToken: 'the-operator-sign-in' }, null, 2)}\n`, { mode: 0o600 });

  const configHome = join(home, '.config', 'graphyard');
  const masterToken = join(configHome, 'install', 'master.token'), workerToken = join(configHome, 'install', 'workers', 'worker.token');
  for (const file of [masterToken, workerToken]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'a-credential\n', { mode: 0o600 }); }
  const config = { credentialFile: masterToken, environments: [{ home: cursorA }, { home: cursorB }, { home: cursorC }] };
  return { root, worktree, cursorA, cursorB, cursorC, operatorConfig: join(home, '.config', 'cursor'), operatorSignIn, configHome, workerToken, config };
}

/**
 * The confined worker launch a dispatch builds for one cursor account: the launch environment, the
 * runtime's one-task form, and the coordinator confinement. A host whose sandbox cannot build
 * another mount namespace (an executor inside one already) still gets the same wrapper's words.
 */
async function confinedCursorLaunch(f: ReturnType<typeof fixture>, account: { name: string; home: string }, interim: string) {
  const contract = { ...proposedRuntimes.find(runtime => runtime.name === 'cursor')!.launch, environment: { XDG_CONFIG_HOME: interim } };
  const fleet: FleetLaunchAccount = { name: account.name, kind: 'cursor', home: account.home, key: null,
    fleet: { runtime: 'cursor', contract: contract as FleetLaunchAccount['fleet']['contract'], model: 'default', modelId: null, session: 'session-1', reason: 'confined worker launch', role: 'worker', revision: 1 } };
  const launch = accountLaunch({ kind: 'cursor', approvals: 'auto', agentArgs: [], environment: {} }, fleet, { headless: true, repositoryRoot: f.root });
  const prompt = 'Reply with the single word: ok';
  const args = headlessArgs('cursor', launch.args, prompt, launch.contract);
  const credentialMask = credentialMaskFor(f.config, { credentialFile: f.workerToken, runtimeHomes: runtimeLoginHomes(launch.environment, launch.contract?.homeVariable, launch.kind) }, f.configHome);
  let wrapper: readonly string[];
  try {
    const confinement = await sessionConfinement('cursor', args, { directory: f.worktree, cwd: f.worktree, environment: launch.environment, secretsBus: null, credentialMask, maskProbe: hostProbe }, f.root);
    wrapper = confinement?.wrapper ?? readOnlyMountWrapper({ coordinatorRoot: f.root, sessionDirectory: f.worktree, environment: launch.environment, credentialMask });
  } catch (error) {
    // An executor already inside a sandbox cannot nest another namespace: the wrapper is the same
    // one the trial's host runs for real.
    if (!/refuses the unprivileged namespaces|bubblewrap \(bwrap\) is not installed|needs Linux/.test(error instanceof Error ? error.message : String(error))) throw error;
    wrapper = readOnlyMountWrapper({ coordinatorRoot: f.root, sessionDirectory: f.worktree, environment: launch.environment, credentialMask });
  }
  return { launch, wrapper, env: { ...process.env, ...launch.environment } };
}

/** Run a command inside the built confinement, as the launcher spawns its runtime. */
const confined = (wrapper: readonly string[], env: NodeJS.ProcessEnv, command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) =>
  spawnSync(wrapper[0], [...wrapper.slice(1), command, ...args], { cwd: options.cwd, env, encoding: 'utf8', timeout: options.timeout ?? 120_000, killSignal: 'SIGKILL' });

test('e2e:cursor-confined-sign-in — a confined cursor worker authenticates on its own account\'s sign-in, a second account cannot read it, and an account with no usable sign-in reads not logged in with its login command and is not selected for launch', async () => {
  // The fixture HOME lives in this checkout, not the host's tmpdir: the sandbox replaces /tmp with
  // its own scratch, which would hide the fixture's accounts whatever the mask did.
  const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  const home = await temporaryDirectory('cursor-confined-sign-in', join(checkout, '.graphyard'));
  const savedHome = process.env.HOME, savedPath = process.env.PATH;
  const bin = await temporaryDirectory('cursor-agent-bin', home);
  const stub = stubCursorAgent(bin);
  process.env.HOME = home;
  process.env.PATH = `${bin}:${savedPath ?? ''}`;
  const runsConfinement = await sessionMountNamespaceWorks();
  try {
    const f = fixture(home);

    // 1. A confined worker launch on cursor-b — the second cursor account, whose own home must win
    //    over the interim value a one-account role once pinned to cursor-a — authenticates.
    const worker = await confinedCursorLaunch(f, { name: 'cursor-b', home: f.cursorB }, f.cursorA);
    assert.equal(worker.launch.environment.CURSOR_CONFIG_DIR, f.cursorB);
    assert.equal(worker.launch.environment.XDG_CONFIG_HOME, f.cursorB, 'the account\'s own home is its XDG config home, over the interim pinned to cursor-a');
    assert.ok(worker.wrapper.some((word, index) => word === '--bind' && worker.wrapper[index + 1] === f.cursorB && worker.wrapper[index + 2] === f.cursorB), 'the account\'s home is re-exposed writable to its session');
    if (runsConfinement) {
      const ran = confined(worker.wrapper, worker.env, join(bin, 'cursor-agent'), ['-p', '--output-format', 'json', 'Reply with the single word: ok'], { cwd: f.worktree });
      const output = ran.stdout + '\n' + ran.stderr;
      assert.equal(ran.status, 0, `the confined cursor-agent ran: ${output.slice(-600)}`);
      assert.ok(ran.stdout.includes('AUTHENTICATED') && ran.stdout.includes('cursor-b-sign-in'), `it authenticated on cursor-b's own sign-in: ${output.slice(-600)}`);
      assert.ok(!output.includes('cursor-a-sign-in') && !output.includes('the-operator-sign-in'), 'neither the first account nor the operator supplied the sign-in');

      // 2. That same confined session cannot read the first account's sign-in, nor the operator's own.
      const reads = confined(worker.wrapper, worker.env, '/bin/sh', ['-c', 'for p do if test -r "$p"; then echo "READABLE $p"; else echo "DENIED $p"; fi; done', 'sh',
        join(f.cursorA, 'cursor', 'auth.json'), f.cursorA, f.operatorSignIn, join(f.cursorB, 'cursor', 'auth.json')]);
      assert.equal(reads.status, 0, `the confined probe ran: ${reads.stderr}`);
      assert.ok(reads.stdout.includes(`DENIED ${join(f.cursorA, 'cursor', 'auth.json')}\n`), `cursor-a's sign-in is unreadable: ${reads.stdout}`);
      assert.ok(reads.stdout.includes(`DENIED ${f.cursorA}\n`), `cursor-a's home is unreadable: ${reads.stdout}`);
      assert.ok(reads.stdout.includes(`DENIED ${f.operatorSignIn}\n`), `the operator's own sign-in is unreadable: ${reads.stdout}`);
      assert.ok(reads.stdout.includes(`READABLE ${join(f.cursorB, 'cursor', 'auth.json')}\n`), `cursor-b keeps its own sign-in: ${reads.stdout}`);

      // A launch on cursor-a reads the same isolation from the other side: its own sign-in, not cursor-b's.
      const first = await confinedCursorLaunch(f, { name: 'cursor-a', home: f.cursorA }, f.cursorA);
      const ranFirst = confined(first.wrapper, first.env, join(bin, 'cursor-agent'), ['-p', 'Reply with the single word: ok'], { cwd: f.worktree });
      assert.ok(ranFirst.stdout.includes('cursor-a-sign-in'), `cursor-a authenticates on its own sign-in: ${ranFirst.stdout}${ranFirst.stderr}`);
    } else {
      // The words the run above executes still name the boundary: the other accounts' homes and the
      // operator's own cursor sign-in are masked, and only the launch's own account is kept.
      for (const path of [f.cursorA, f.cursorC, f.operatorConfig]) {
        const at = worker.wrapper.findIndex((word, index) => word === '--tmpfs' && worker.wrapper[index + 1] === path);
        assert.ok(at >= 0, `${path} is masked from the session`);
        assert.equal(worker.wrapper[at - 1], '0111', `${path} is masked unreadable`);
      }
      for (const path of [f.cursorB, join(f.cursorB, 'cursor', 'auth.json')]) assert.ok(!worker.wrapper.includes(path) || worker.wrapper.some((word, index) => word === '--bind' && worker.wrapper[index + 2] === f.cursorB), `${path} stays the session's own`);
    }

    // 3. cursor-c has no sign-in a confined session can read: the smoke test reports it not logged
    //    in, the account health names it and the login command, and no session is selected on it.
    const provider = connectProvider('cursor')!;
    const smoke = await runSmokePrompt(provider, f.cursorC, { runner: async (command, args, options) => {
      const ran = spawnSync(command, args, { env: options?.env, timeout: options?.timeoutMs, encoding: 'utf8' });
      if (ran.status !== 0) throw new Error(`${ran.stderr.trim()}\n${ran.stdout.trim()}`.trim());
      return ran.stdout;
    }, timeoutMs: 20_000 });
    assert.equal(smoke.healthy, false, 'the smoke test catches the account that cannot sign in');
    assert.match(smoke.error!, /Authentication required\. Please run 'agent login' first/);
    const health = await checkAgentEnvironment({ name: 'cursor-c', kind: 'cursor', home: f.cursorC }, { quota: false, cacheMs: 0 });
    assert.equal(health.loggedIn, false, 'the probe reads the profile-only account as not logged in');
    assert.match(health.reason ?? '', /^cursor-c is not logged in: .*cli-config\.json names no signed-in user$/);
    assert.ok(health.login!.startsWith('CURSOR_CONFIG_DIR=') && health.login!.includes('XDG_CONFIG_HOME=') && health.login!.includes('cursor-c') && health.login!.endsWith('agent login'),
      `the report names the account and the login command: ${health.login}`);

    // Selection: the executor observes its accounts, the registry folds the readings, and the role's
    // first account — cursor-c, the one with no usable sign-in — is passed over for cursor-a.
    const cursorRuntime = proposedRuntimes.find(runtime => runtime.name === 'cursor')!;
    const now = new Date().toISOString();
    const homes = { 'cursor-a': f.cursorA, 'cursor-b': f.cursorB, 'cursor-c': f.cursorC } as const;
    let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', {
      runtimes: [cursorRuntime], models: [{ name: 'default', id: null }],
      accounts: (['cursor-c', 'cursor-a', 'cursor-b'] as const).map(name => ({ name, runtime: 'cursor', model: 'default', credential: { host: HOST, home: homes[name] } })),
      roles: [{ name: 'worker', accounts: ['cursor-c', 'cursor-a', 'cursor-b'], concurrency: 2 }], reason: 'fixture',
    }, { actor: 'operator', at: now }).registry;
    const observed = await Promise.all(registry.accounts.map(async account => {
      const runtime = registry.runtimes.find(entry => entry.name === account.runtime)!;
      const { quota } = await observeAccount(account, runtime, { quota: false, cacheMs: 0 }, registry.accounts);
      return { account: account.name, quota };
    }));
    assert.equal(observed.find(entry => entry.account === 'cursor-c')!.quota.loggedIn, false, 'the executor observes cursor-c as not logged in');
    foldObservations(registry, { host: HOST, observations: observed }, { actor: 'master', at: now });
    const choice = chooseSession(registry, { role: 'worker', host: HOST }, Date.parse(now));
    assert.ok(choice.account, `a session is chosen: ${choice.reason}`);
    assert.equal(choice.account!.name, 'cursor-a', 'the account with no usable sign-in is not selected for launch');
    assert.ok(choice.skipped.some(entry => entry.account === 'cursor-c' && /cursor-c is not logged in/.test(entry.reason)), `cursor-c is passed over by name: ${JSON.stringify(choice.skipped)}`);

    // The login command the report names is the one that produces a sign-in inside the account home.
    const login = await relaySubscriptionLogin(provider, f.cursorC, { login: { command: stub, args: ['login'] }, pollMs: 50, loginTimeoutMs: 20_000 });
    assert.equal(login.loggedIn, true, `the named login completes the sign-in: ${login.error}`);
    assert.ok(existsSync(join(f.cursorC, 'cursor', 'auth.json')), 'the login wrote the sign-in under the account home');
    assert.equal((await checkAgentEnvironment({ name: 'cursor-c', kind: 'cursor', home: f.cursorC }, { quota: false, cacheMs: 0 })).loggedIn, true, 'the account reads logged in once its sign-in exists');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    rmSync(home, { recursive: true, force: true });
  }
});
