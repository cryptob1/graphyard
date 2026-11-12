import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { serveGitHttp } from './helpers/git-http-remote.js';
import { harness } from './install-harness.js';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall, resumeCommand, type ProfileRequest } from '../src/install/index.js';
import { pushEnvironment } from '../src/merge-writer/executor.js';
import { ghConfigDirectory, trialHiddenPaths } from '../src/merge-writer/trial.js';
import { installDirectory, readInstallRecord } from '../src/install/secrets.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { defaultChildRun } from '../src/child-runner.js';
import { masterConfigSchema } from '../src/master.js';
import { recordedUp, runUp, upRequestFromArgs, type UpDependencies } from '../src/up.js';

// GY-3269 AC-1: `install --push-auth gh` makes the operator's gh login the merge writer's
// credential. Against a git remote that accepts only HTTPS with a token, and a stub gh standing in
// for a keyring-stored login (it prints the token only where the session bus reaches it), the
// install registers no deploy key, the merge writer's push lands, and the token appears in no file
// under the install directory or checkout and in no session environment — it crosses from gh to
// git alone, inside the push child, at the moment of the push.

const TOKEN = 'gh_fixture_token_never_on_disk_or_in_env';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The stub gh the push child finds on PATH: `gh auth token` prints the fixture token, but only
 * where the session bus reaches it — the fixture's stand-in for a login kept in the system keyring
 * (gh's own default since 2.24 wherever a Secret Service exists): no bus, no token. */
async function stubGh(directory: string) {
  const bin = join(directory, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'gh'), `#!/bin/sh\n[ -n "$DBUS_SESSION_BUS_ADDRESS" ] || exit 1\nexec printf '%s\\n' ${TOKEN}\n`, { mode: 0o755 });
  await chmod(join(bin, 'gh'), 0o755);
  return bin;
}

/** A checkout whose origin is unreachable, so only the merge writer's explicit https URL can work. */
async function mergeWriterCheckout(directory: string) {
  const origin = join(directory, 'repo.git'), checkout = join(directory, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(origin, 'config', 'http.receivepack', 'true');
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.com');
  await writeFile(join(checkout, 'a.txt'), 'base\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'base'); git(checkout, 'push', '-q', 'origin', 'main');
  const baseTip = git(checkout, 'rev-parse', 'HEAD');
  await writeFile(join(checkout, 'b.txt'), 'merge\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'merge');
  const mergeSha = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'reset', '-q', '--hard', baseTip);
  git(checkout, 'remote', 'set-url', 'origin', 'git@127.0.0.1:0/unreachable.git');
  return { origin, checkout, baseTip, mergeSha };
}

const masterConfig = (run: Record<string, unknown>) => masterConfigSchema.parse({ version: 1, repository: 'owner/project', baseBranch: 'main', url: 'https://graphyard.example', credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run });

/** No file under DIRECTORY holds TEXT; names every file it read. */
async function filesHolding(directory: string, text: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesHolding(path, text));
    else if ((await readFile(path, 'utf8').catch(() => '')).includes(text)) found.push(path);
  }
  return found;
}

test('e2e:push-with-gh-login — install --push-auth gh --apply registers no deploy key, records the gh login, and the merge writer pushes over https with it', { timeout: 120_000 }, async () => {
  const directory = await temporaryDirectory('push-with-gh-login');
  const server = await serveGitHttp(directory, TOKEN, []);
  const bin = await stubGh(directory);
  const remote = await mergeWriterCheckout(directory);
  const fixture = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310' });
  try {
    // The install: no deploy key, the record and the profile request carry the gh login, and the
    // whole recorded surface — commands, inputs, files, requests — never touches the token.
    const requests: ProfileRequest[] = [];
    const registered = fixture.deps.registerProfiles!;
    fixture.deps.registerProfiles = async request => { requests.push(request); return registered(request); };
    const { request } = installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--push-auth', 'gh', '--apply']);
    assert.equal(request.pushAuth, 'gh');
    const session = await prepareInstall(fixture.root, request, fixture.deps, 'apply');
    const plan = await buildPlan(session);
    assert.deepEqual(plan.actions.filter(action => /^github\.(deploy-key|merge-token|push-auth)$/.test(action.id)).map(action => action.id), ['github.push-auth']);
    const summary = await applyInstall(session, plan);
    assert.equal(summary.deployKey, null);
    assert.equal(summary.mergeCredential, 'gh');
    assert.equal(fixture.commandLines().filter(line => line.includes('deploy-key')).length, 0, 'no deploy key is registered');
    const install = installDirectory('owner-project', fixture.configHome);
    assert.ok(!existsSync(join(install, 'deploy-key')), 'no deploy key file exists under the install directory');
    assert.equal((await readInstallRecord(install))?.pushAuth, 'gh');
    assert.equal(requests[0]?.pushAuth, 'gh', 'the profile request master.json records carries the gh login');
    assert.match(resumeCommand(session), /--push-auth gh/);
    // A rerun without the flag keeps the recorded gh login, as it keeps the base branch.
    const rerun = await prepareInstall(fixture.root, installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--apply']).request, fixture.deps, 'apply');
    assert.equal(rerun.inputs.pushAuth, 'gh', 'a bare install --apply keeps the recorded --push-auth gh');
    assert.match(resumeCommand(rerun), /--push-auth gh/);
    for (const surface of [JSON.stringify(plan), JSON.stringify(summary), fixture.commandLines().join('\n'), fixture.transport.commands.map(command => command.input ?? '').join('\n'), [...fixture.transport.files.values()].map(file => file.content).join('\n')]) {
      assert.ok(!surface.includes(TOKEN), `the install surface holds no token: ${surface.slice(0, 200)}`);
    }

    // The merge writer: master.json's run.mergeWriter.pushAuth gh fetches and pushes the https URL,
    // with the stub gh — a keyring login reached over the session bus — answering git's credential
    // prompt inside the push child alone. The bus address rides the push child's allowlisted
    // environment; without it the stub prints nothing and the remote refuses the empty password.
    const bus = 'unix:path=/run/user/fixture/bus';
    const reads = mergeWriterReads(masterConfig({ mergeWriter: { pushAuth: 'gh' } }), remote.checkout, defaultChildRun,
      { base: join(directory, 'managed'), record: async () => {}, environment: { PATH: `${bin}:${process.env.PATH}`, GRAPHYARD_MERGE_WRITER_GIT_URL: server.url, DBUS_SESSION_BUS_ADDRESS: bus } });
    assert.equal(await reads.fetch(), remote.baseTip, 'the fetch reads the base tip over the gh login');
    assert.equal(await reads.push(remote.mergeSha, remote.baseTip), 'pushed');
    assert.equal(git(remote.origin, 'rev-parse', 'main'), remote.mergeSha, 'the merge landed on the served repository');

    // The push child's environment carries the helper that runs gh, never a token or an askpass file.
    const push = pushEnvironment({ pushAuth: 'gh' }, { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'ambient', GH_CONFIG_DIR: '/custom/gh', DBUS_SESSION_BUS_ADDRESS: bus, XDG_RUNTIME_DIR: '/run/user/fixture' });
    assert.equal(push.GH_TOKEN, undefined);
    assert.equal(push.GH_CONFIG_DIR, '/custom/gh', 'gh keeps the config directory the loop named');
    assert.equal(push.DBUS_SESSION_BUS_ADDRESS, bus, 'a keyring-stored gh login reaches its Secret Service over the session bus');
    assert.equal(push.XDG_RUNTIME_DIR, '/run/user/fixture');
    assert.match(push.GIT_CONFIG_VALUE_0!, /gh auth token/);
    assert.ok(!Object.values(push).includes(TOKEN), 'no push variable holds the token');
    // The bus stays gh-mode's alone: a deploy-key push never carries it.
    assert.equal(pushEnvironment('/keys/deploy', { DBUS_SESSION_BUS_ADDRESS: bus }).DBUS_SESSION_BUS_ADDRESS, undefined);
    const found = [...await filesHolding(fixture.configHome, TOKEN), ...await filesHolding(remote.checkout, TOKEN), ...await filesHolding(fixture.root, TOKEN)];
    assert.deepEqual(found, [], 'no file under the install directory or a checkout holds the token');
  } finally {
    await fixture.cleanup();
    server.close();
  }
});

test('integration:push-with-gh-login — the flag refuses any other value and the piped token', () => {
  assert.throws(() => installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--push-auth', 'pat', '--plan']), /Use --push-auth gh/);
  assert.throws(() => installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--push-auth', 'gh', '--merge-token-stdin', '--plan']), /Choose one merge-writer credential/);
});

test('integration:push-with-gh-login — the trial never reads the gh login the merge writer pushes with', { timeout: 60_000 }, async () => {
  // A plaintext hosts.yml is what gh writes where no keyring exists; under --push-auth gh it is the
  // merge writer's own credential, so the trial's children must not read it (the keyring side is
  // already unreachable: the trial strips the session-bus variables and masks the runtime sockets).
  const home = await temporaryDirectory('push-gh-login-home');
  const ghDir = join(home, '.config', 'gh');
  await mkdir(ghDir, { recursive: true });
  await writeFile(join(ghDir, 'hosts.yml'), `github.com:\n    oauth_token: ${TOKEN}\n`);
  const environment = { PATH: process.env.PATH!, HOME: home };
  assert.ok(trialHiddenPaths(undefined, environment, 1000).includes(ghConfigDirectory(environment)), 'the operator\'s gh config directory is a hidden path on every install');
  let hidden: readonly string[] | undefined;
  const reads = mergeWriterReads(masterConfig({ mergeWriter: { pushAuth: 'gh' } }), '/unused', async () => '',
    { base: '/unused', record: async () => {}, environment,
      trial: async input => { hidden = input.hidden; return { build: 'pass', tests: { passed: 0, failed: [], files: 0 }, durationMs: 1, logTail: '', files: [], proofs: {} }; } });
  await reads.trial('a'.repeat(40), [], { key: 'GY-3269', type: 'feature', criteria: [] } as never, 'b'.repeat(40));
  assert.ok(hidden!.includes(ghDir), `the merge writer's trial hides the gh config directory: ${hidden!.join(', ')}`);
});

test('integration:push-with-gh-login — preflight asks gh in the push child\'s environment, not the installer\'s shell', { timeout: 60_000 }, async () => {
  // A login that answers `gh auth status` in the fuller shell but not `gh auth token` in the push
  // child's would push an empty password on every cycle; preflight refuses it before anything is
  // written. The stub answers the push environment's own call with failure.
  const fixture = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310', extraResponses: [
    { match: 'gh auth token', result: { stdout: '', stderr: 'no oauth token', code: 1 } },
  ] });
  try {
    const session = await prepareInstall(fixture.root, installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--push-auth', 'gh', '--apply']).request, fixture.deps, 'apply');
    const plan = await buildPlan(session);
    const check = plan.preflight.find(item => item.name === 'GitHub CLI');
    assert.equal(check?.ok, false, 'a login the push child cannot read is refused');
    assert.match(`${check?.detail} ${check?.fix}`, /push child/);
    assert.match(`${check?.detail} ${check?.fix}`, /keyring/);
    await assert.rejects(() => applyInstall(session, plan), /Preflight is incomplete/);
  } finally { await fixture.cleanup(); }
});

test('integration:push-with-gh-login — a rerun of up without the flag keeps --push-auth gh for every install child', async () => {
  const root = await temporaryDirectory('push-with-gh-login-up');
  const runs: string[][] = [];
  const deps: UpDependencies = {
    root, emit: () => {}, now: () => 0, sleep: async () => {},
    serverUrl: async () => 'http://127.0.0.1:4310', masterToken: async () => 'm'.repeat(40), status: async () => null,
    publishOnboarding: async () => null, landlockAbi: () => 9,
    cli: async args => { runs.push(args); return args.includes('--plan') ? { code: 0, stdout: JSON.stringify({ preflight: [{ name: 'GitHub CLI', ok: true }] }) } : { code: 1, stdout: '', stderr: 'the run stops at install' }; },
    gh: async () => ({ code: 0, stdout: '', stderr: '' }),
    git: async () => ({ code: 0, stdout: 'git@github.com:owner/project.git', stderr: '' }),
  };
  await runUp({ repository: 'owner/project', provider: 'compose', agent: false, master: 'claude', pushAuth: 'gh' }, deps);
  runs.length = 0;
  await runUp(upRequestFromArgs([], recordedUp(root)), deps);
  assert.ok(runs.length > 0 && runs.every(args => args.includes('--push-auth')), `every install child of the rerun carries --push-auth gh: ${JSON.stringify(runs)}`);
});
