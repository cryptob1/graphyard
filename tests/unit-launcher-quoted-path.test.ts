import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { foreignUnitText, perInstallUnits, type InstallUnits } from '../src/install/units.js';
import type { UpDependencies, UpEvent, UpRequest } from '../src/up.js';

/**
 * GY-1880: setup words a unit's ExecStart back by systemd's own quoting rules, so a launcher
 * `loopUnitText` spelled quoted for a CLI checkout path holding whitespace reads as exactly that
 * checkout — setup reports the unit current and rewrites nothing, where a bare whitespace split
 * read one current launcher as several wrong ones, rewrote the same unit on every rerun and polled
 * it to a timeout. The proof: unit:unit-launcher-quoted-path.
 *
 * The renderer, the readers and the master-loop step are the real ones; only the host is simulated
 * (unit files on disk, the cursor's text, git), as tests/up-loop-code.test.ts does. The coordinator
 * WorkingDirectory holds no whitespace — `loopUnitText` refuses to write one — so the checkout whose
 * path holds a space is the CLI's, which the unit's ExecStart quotes.
 */
// Loaded inside the test, so a tree without them fails as a test case, not at load.
const supervisor = () => import('../src/supervisor.js');
const repositorySetup = () => import('../src/repository-setup.js');

const SERVER = 'http://127.0.0.1:4310';
const COMMIT = 'a'.repeat(40), OLD_COMMIT = 'b'.repeat(40), REPO_COMMIT = 'c'.repeat(40);
const escape = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface QuotedWorld { calls: { args: string[]; stdin?: string }[]; loopRunning: boolean }

const world = (): QuotedWorld => ({ calls: [], loopRunning: true });
const baseStatus = (loop: boolean) => ({
  githubRepository: 'acme/shop',
  mergeWriter: { merger: 'control-plane' },
  fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-b'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, eligible: true }, { name: 'claude-b', enabled: true, loggedIn: true, eligible: true }] },
  setup: { protection: 'checks', loop },
});
const named = (w: QuotedWorld, args: string[]) => w.calls.filter(call => call.args.join(' ') === args.join(' '));

function dependencies(root: string, w: QuotedWorld): UpDependencies {
  let clock = 0;
  const yieldTurn = () => new Promise<void>(accept => setImmediate(accept));
  return {
    root, pollMs: 1, machineWaitMs: 200,
    emit: () => {},
    now: () => clock,
    sleep: async ms => { clock += ms; await yieldTurn(); },
    serverUrl: async () => SERVER,
    masterToken: async () => 'm'.repeat(40),
    status: async () => baseStatus(w.loopRunning),
    publishOnboarding: async () => null,
    onboardingMerged: async () => true,
    signIn: async () => `${SERVER}/#sign-in=${'d'.repeat(43)}`,
    operatorToken: async () => 'o'.repeat(40),
    installDirectory: () => '/install/acme-shop',
    ensureDeployKey: async () => '/install/acme-shop/deploy',
    cli: async (args, options = {}) => {
      w.calls.push({ args, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) });
      if (args[0] === 'master' && args[1] === 'restart') w.loopRunning = true;
      return { code: 0, stdout: '{}' };
    },
  };
}

const request = (): UpRequest => ({ repository: 'acme/shop', provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null, merger: 'control-plane' });

/** A root whose up state records every step but the master loop done, so a run reaches that step alone. */
async function resumedRoot(label: string) {
  const root = await temporaryDirectory(label);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'up.json'), JSON.stringify({
    version: 1, repository: 'acme/shop', provider: 'compose', merger: 'control-plane', noHerdr: false, goal: null,
    completed: ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'merger-setting', 'master-autonomy', 'onboarding', 'accounts', 'harness'],
  }));
  return root;
}

test('unit:unit-launcher-quoted-path — a loop unit whose ExecStart quotes a CLI checkout path holding whitespace reads back as exactly that checkout, so setup reports it current and does not rewrite it; a stale launcher is repaired onto the quoted path once and a later check reports it current; unquoted paths still parse as before', async () => {
  const { loopUnitText } = await supervisor();
  const { readLoopCode, systemdCommandLineWords, unitLauncherCheckout } = await repositorySetup();
  const { runUp } = await import('../src/up.js');
  const units: InstallUnits = perInstallUnits('acme/shop');

  // The host: a coordinator checkout (whose WorkingDirectory holds no whitespace — the renderer
  // refuses one), a unit directory beside it, and two CLI checkouts whose paths hold a space.
  const base = await temporaryDirectory('unit-launcher-quoted-path');
  const home = join(base, 'home'), unitDirectory = join(base, 'units'), installDir = join(base, 'install'), root = join(base, 'repo');
  const cliCheckout = join(base, 'My Apps', 'graphyard'), cliPath = join(cliCheckout, 'bin', 'graphyard.mjs');
  const oldCheckout = join(base, 'My Apps', 'graphyard-old'), oldCliPath = join(oldCheckout, 'bin', 'graphyard.mjs');
  for (const directory of [home, unitDirectory, installDir, join(cliCheckout, 'bin'), join(oldCheckout, 'bin'), root]) await mkdir(directory, { recursive: true });
  const unitFile = join(unitDirectory, units.master);

  // What `master init` writes, through the real renderer: the CLI path that holds whitespace is
  // quoted, and that quoting is exactly what a bare whitespace split misread.
  const render = (launcher: string) => loopUnitText({ root, cliPath: launcher, repository: 'acme/shop', intervalSeconds: 30, installDir, heldLauncher: null });
  await writeFile(unitFile, render(cliPath));
  const current = await readFile(unitFile, 'utf8');
  assert.match(current, new RegExp(`^ExecStart=.* "${escape(cliPath)}" master run$`, 'm'), 'the renderer quotes the CLI path that holds whitespace');

  // Read back: both readers answer exactly the checkout the launcher starts, and the unit is the
  // coordinator's own.
  assert.equal(unitLauncherCheckout(current, home), cliCheckout, 'the launcher reads back as exactly the checkout whose path holds a space');
  assert.equal(foreignUnitText(current, root), null, 'the unit is the coordinator checkout\'s own, never another install\'s');

  // Through the whole reading: the loop's launcher is this CLI's checkout, its cursor reports this
  // CLI's commit, and nothing is stale.
  const run = (_command: string, args: string[]) => args[2] === 'rev-parse' ? `${args[1] === root ? REPO_COMMIT : COMMIT}\n` : '';
  const loaded = async () => (await readFile(unitFile, 'utf8')).includes(`"${cliPath}" master run`) ? COMMIT : OLD_COMMIT;
  const read = async () => readLoopCode(root, { cliPath, run, units, unitDirectory, home, master: { repository: 'acme/shop', credentialFile: join(home, 'master.token') }, cursor: JSON.stringify({ release: { commit: await loaded(), dirty: false } }) });
  const reading = await read();
  assert.equal(reading.loop?.launcher, cliCheckout, 'the reading records the quoted launcher\'s checkout exactly');
  assert.equal(reading.loopCommit, COMMIT, 'the cursor reports this CLI\'s commit');
  assert.equal(reading.loopStale, null, 'a current quoted launcher is not other code');
  assert.equal(reading.loopReplace, null);

  // Setup (the master-loop step of `graphyard up`) reports it current and rewrites nothing: no
  // `master init --replace-supervisor`, no restart — where the bare split rewrote this very unit on
  // every rerun and timed out waiting for a restart that changed nothing.
  const settled = world();
  const settledRun = await runUp(request(), { ...dependencies(await resumedRoot('unit-launcher-quoted-path-current'), settled), loopCode: read });
  assert.equal(settledRun.exitCode, 0, settledRun.next);
  assert.deepEqual(named(settled, ['master', 'init', '--token-stdin', '--replace-supervisor']), [], 'a current quoted launcher is never rewritten');
  assert.deepEqual(named(settled, ['master', 'restart']), [], 'and never restarted');

  // A stale launcher: the unit still starts an older CLI checkout, whose path holds whitespace too.
  // The reading names it as other code a rewrite replaces.
  await writeFile(unitFile, render(oldCliPath));
  const stale = await read();
  assert.equal(stale.loop?.launcher, oldCheckout, 'the stale launcher reads back as exactly its own quoted checkout');
  assert.equal(stale.loopReplace, 'unit', 'a unit on another checkout is rewritten');
  assert.match(stale.loopStale ?? '', new RegExp(`starts the CLI in ${escape(oldCheckout)}`), 'the reading names the checkout the quoted launcher starts');

  // The repair: `master init --replace-supervisor` writes the unit through the real renderer onto
  // this CLI's quoted path, exactly once, and a later check reports it current.
  const repaired = world(), events: UpEvent[] = [];
  const deps = dependencies(await resumedRoot('unit-launcher-quoted-path-repaired'), repaired);
  const outcome = await runUp(request(), { ...deps, loopCode: read, cli: async (args, options = {}) => {
    if (args[0] === 'master' && args[1] === 'init') {
      repaired.calls.push({ args, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) });
      await writeFile(unitFile, render(cliPath));
      return { code: 0, stdout: '{"supervisor":{"state":"updated"}}' };
    }
    return deps.cli(args, options);
  } });
  assert.equal(outcome.exitCode, 0, outcome.next);
  assert.equal(named(repaired, ['master', 'init', '--token-stdin', '--replace-supervisor']).length, 1, 'the stale quoted launcher is repaired exactly once');
  const written = await readFile(unitFile, 'utf8');
  assert.match(written, new RegExp(`^ExecStart=.* "${escape(cliPath)}" master run$`, 'm'), 'the repaired unit starts this CLI\'s quoted launcher');
  assert.equal(unitLauncherCheckout(written, home), cliCheckout, 'and the repaired unit reads back as this checkout');
  assert.deepEqual(named(repaired, ['master', 'restart']), [], 'the rewrite already restarted the unit, so the step restarts it no second time');
  const after = await read();
  assert.equal(after.loopCommit, COMMIT, 'a later check reports this CLI\'s commit');
  assert.equal(after.loopStale, null, 'and judges the repaired loop as this code');

  // `foreignUnitText` words a quoted executor line the same way: a unit whose quoted script starts
  // the CLI checkout's executor reads back as exactly that checkout, never as the working
  // directory's own.
  const scriptPath = join(cliCheckout, 'scripts', 'graphyard-executor.mjs');
  const executor = (execStart: string) => `[Unit]\nDescription=Graphyard executor\n\n[Service]\nWorkingDirectory=${root}\nExecStart=${execStart}\n`;
  assert.equal(foreignUnitText(executor(`/usr/bin/node "${scriptPath}" --slot %i`), root), cliCheckout, 'a double-quoted executor script reads back as exactly its checkout');
  assert.equal(foreignUnitText(executor(`/usr/bin/node '${scriptPath}' --slot %i`), root), cliCheckout, 'and so does a single-quoted one');

  // Unquoted paths still parse as before, byte for byte the old whitespace split.
  assert.equal(unitLauncherCheckout(`[Service]\nExecStart=/usr/bin/node /opt/graphyard/bin/graphyard.mjs master run\n`, home), '/opt/graphyard');
  assert.equal(unitLauncherCheckout(`[Service]\nExecStart=/usr/bin/node /opt/pin/dist/cli.js master run\n`, home), '/opt/pin');
  assert.equal(foreignUnitText(executor(`/usr/bin/node /opt/pilot/scripts/graphyard-executor.mjs --slot %i`), root), '/opt/pilot');

  // The wording itself, where the quoting rules bite: quoted whitespace groups one word, quoted and
  // bare text concatenate, a double-quoted backslash escapes, stray whitespace separates nothing,
  // and an unterminated quote still yields the word it opened.
  assert.deepEqual(systemdCommandLineWords('/usr/bin/node "/opt/My Tools/cli/bin/graphyard.mjs" master run'), ['/usr/bin/node', '/opt/My Tools/cli/bin/graphyard.mjs', 'master', 'run']);
  assert.deepEqual(systemdCommandLineWords("node 'a b'c d"), ['node', 'a bc', 'd']);
  assert.deepEqual(systemdCommandLineWords('x "a\\"b c"'), ['x', 'a"b c']);
  assert.deepEqual(systemdCommandLineWords('  spaced\tout '), ['spaced', 'out']);
  assert.deepEqual(systemdCommandLineWords(''), []);
  assert.deepEqual(systemdCommandLineWords('"unterminated path'), ['unterminated path']);
});
