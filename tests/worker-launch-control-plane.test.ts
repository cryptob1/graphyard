import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountLaunch, dispatchWork, setupMaster, type WorkerProfile } from '../src/master.js';
import { MergeWriterUnreadError, readMergeWriter, workerConfinementCredential } from '../src/master/dispatch.js';
import { planeWideFailure } from '../src/model/blocker-class.js';
import { coordinatorConfinement, readOnlyMountWrapper } from '../src/master/profiles.js';
import { grantWorkerPaths, workerPaths, writablePaths } from '../src/worker-sandbox.js';
import type { Work } from '../src/model.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1523 AC-6: a worker launched while the control plane is the merge writer has nowhere to push,
 * so the launch mints no push credential, sets no GH_CONFIG_DIR and confines the session with no
 * keyring proxy (`ownGitHubCredential: false`, `secretsBus: null`), while the sandbox grant still
 * holds the shared object store and refs/heads/graphyard it commits through. A github-mode launch
 * is unchanged: its Herdr tab arguments equal the recorded snapshot.
 */
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const addedDirectories = (args: string[], cwd: string) => args.flatMap((arg, index) => arg === '--add-dir' ? [resolve(cwd, args[index + 1])] : []);

/** A repository laid out like a Graphyard checkout — an origin, the main clone and a managed linked worktree — with a worker profile and a ready item. */
async function dispatchFixture(name = 'GY-7-1') {
  const root = await realpath(await temporaryDirectory('launch-control-plane'));
  const origin = join(root, 'origin.git'), main = join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'ignore' });
  git(main, 'config', 'user.email', 't@example.com'); git(main, 'config', 'user.name', 'T');
  await writeFile(join(main, 'README.md'), '# Fixture\n'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base'); git(main, 'push', '-q', 'origin', 'main');
  const worktree = join(main, '.graphyard/worktrees', name);
  git(main, 'worktree', 'add', '-q', '-b', `graphyard/${name.toLowerCase()}`, worktree);
  git(main, 'remote', 'set-url', 'origin', 'https://github.com/owner/project.git');
  const credentialDirectory = await temporaryDirectory('launch-control-plane-credentials');
  const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
  await setupMaster(main, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
  const item = { id: 'id-GY-7', key: 'GY-7', title: 'GY-7', description: '', type: 'feature', priority: 2, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 1, policyRevision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] } as unknown as Work;
  const herdrCalls: string[][] = [], minted: { key: string; epoch: number; directory: string }[] = [], released: number[] = [];
  const herdr = (_command: string, args: string[]) => { herdrCalls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'p1', tab_id: 't1' }, tab: { tab_id: 't1' } } : {} }); };
  const prepare = async () => ({ epoch: 3, path: worktree, base: 'c'.repeat(40) });
  const release = async (_root: string, _key: string, epoch: number) => { released.push(epoch); };
  const minter = async (_root: string, input: { key: string; epoch: number; directory: string }) => { minted.push({ key: input.key, epoch: input.epoch, directory: input.directory }); await mkdir(input.directory, { recursive: true }); };
  const tabArgs = () => herdrCalls.find(args => args[0] === 'tab' && args[1] === 'create')!;
  const typed = () => expandTypedCommand(herdrCalls.find(args => args[0] === 'pane' && args[1] === 'run')![3]);
  const commonDir = join(main, '.git');
  return { root, main, worktree, commonDir, credential, credentialDirectory, profile, item, herdrCalls, minted, released, herdr, prepare, release, minter, tabArgs, typed,
    dispatch: (mergeWriter: 'github' | 'control-plane') => dispatchWork(main, item, profile, [], herdr, [item], prepare, release, 1, new Date().toISOString(), { mergeWriter, credential: minter }),
    cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
const environmentOf = (tabArgs: string[]) => tabArgs.flatMap((arg, index) => arg === '--env' ? [tabArgs[index + 1]] : []);

test('unit:worker-launch-credential-free — a control-plane launch calls no credential minter, carries no GH_CONFIG_DIR or GitHub token variable, confines the session with ownGitHubCredential false and secretsBus null, and still grants the shared objects and refs/heads/graphyard', async () => {
  const fixture = await dispatchFixture();
  try {
    const started = await fixture.dispatch('control-plane');
    assert.equal(started.mergeWriter, 'control-plane'); assert.equal(started.pushCredential, 'none');
    assert.deepEqual(fixture.minted, [], 'no push credential is minted');
    assert.deepEqual(fixture.released, [], 'the launch succeeded and kept its claim');
    const environment = environmentOf(fixture.tabArgs());
    assert.ok(!environment.some(entry => /^(GH_CONFIG_DIR|GH_TOKEN|GITHUB_TOKEN|GIT_CONFIG_COUNT)=/.test(entry)), `no GitHub credential environment reaches the tab: ${environment.join(' ')}`);
    assert.ok(environment.includes(`GRAPHYARD_TOKEN_FILE=${fixture.credential}`), 'the Graphyard worker credential itself is still the session\'s');
    // The grant: the worktree's admin directory, the shared object store and the worker branch namespace.
    const launched = fixture.typed();
    assert.equal(launched.kind, 'codex');
    const granted = addedDirectories(launched.args, fixture.worktree);
    for (const path of [join(fixture.commonDir, 'objects'), join(fixture.commonDir, 'refs', 'heads', 'graphyard')]) assert.ok(granted.includes(path), `the session is granted ${path}: ${launched.args.join(' ')}`);
    assert.deepEqual(new Set(granted), new Set(writablePaths(workerPaths(fixture.worktree)).filter(path => path !== fixture.worktree)));
    const expected = grantWorkerPaths('codex', accountLaunch(fixture.profile, null).args, writablePaths(workerPaths(fixture.worktree)), fixture.worktree);
    assert.deepEqual(launched.args.slice(0, expected.length), expected, 'the grant is the one every worker launch gets');
    // The confinement words the launch derives from the mode.
    assert.deepEqual(workerConfinementCredential('control-plane'), { ownGitHubCredential: false, secretsBus: null });
    assert.deepEqual(workerConfinementCredential('github'), { ownGitHubCredential: true });
  } finally { await fixture.cleanup(); }
});

test('unit:worker-launch-credential-free — secretsBus null binds the session bus to /dev/null with no credential of its own, where a plain session reaches the keyring proxy', async () => {
  const base = await temporaryDirectory('launch-control-plane-bus');
  const server = createServer();
  const saved = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, GRAPHYARD_SECRETS_BUS: process.env.GRAPHYARD_SECRETS_BUS };
  try {
    const runtime = join(base, 'run'), root = join(base, 'checkout'), session = join(root, '.graphyard', 'worktrees', 'GY-1-1');
    mkdirSync(runtime, { recursive: true }); mkdirSync(session, { recursive: true });
    execFileSync('git', ['init', '-q', root]);
    const bus = join(runtime, 'bus'), proxy = join(runtime, 'graphyard-secrets-bus');
    writeFileSync(bus, '');
    await new Promise<void>(done => server.listen(proxy, done));
    process.env.XDG_RUNTIME_DIR = runtime; delete process.env.GRAPHYARD_SECRETS_BUS;
    const replacement = (wrapper: readonly string[]) => wrapper[wrapper.indexOf(realpathSync(bus)) - 1];
    assert.equal(replacement(readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: session })), realpathSync(proxy), 'a session without a credential of its own reaches the keyring through the proxy');
    assert.equal(replacement(readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: session, ownGitHubCredential: false, secretsBus: null })), '/dev/null', 'secretsBus null unbinds it with no credential of its own');
    const confined = await coordinatorConfinement({ kind: 'claude', args: [], coordinatorRoot: root, sessionDirectory: session, bwrap: '/usr/bin/bwrap', platform: 'linux', mountNamespaceWorks: true, ownGitHubCredential: false, secretsBus: null });
    assert.equal(replacement(confined!.wrapper), '/dev/null', 'the launch confinement passes secretsBus null through');
    const plain = await coordinatorConfinement({ kind: 'claude', args: [], coordinatorRoot: root, sessionDirectory: session, bwrap: '/usr/bin/bwrap', platform: 'linux', mountNamespaceWorks: true, ownGitHubCredential: false });
    assert.equal(replacement(plain!.wrapper), realpathSync(proxy), 'without it, ownGitHubCredential false alone keeps the proxy');
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await new Promise<void>(done => server.close(() => done()));
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit:worker-launch-credential-free — the merger is read from /api/status with the master credential: a status without the field is an older server\'s github; a refused, failed, timed-out or unknown read refuses the launch as a plane-wide failure instead of guessing github', async () => {
  const directory = await temporaryDirectory('launch-control-plane-status');
  try {
    const credentialFile = join(directory, 'master.token'); await writeFile(credentialFile, coordinatorToken, { mode: 0o600 });
    const config = { url: 'https://graphyard.example', credentialFile };
    const seen: { url: string; authorization: string | null }[] = [];
    const answering = (status: number, body: unknown) => (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), authorization: String((init?.headers as Record<string, string>)?.Authorization ?? null) }); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
    assert.equal(await readMergeWriter(config, answering(200, { mergeWriter: { merger: 'control-plane', line: 'x' } })), 'control-plane');
    assert.deepEqual(seen, [{ url: 'https://graphyard.example/api/status', authorization: `Bearer ${coordinatorToken}` }]);
    assert.equal(await readMergeWriter(config, answering(200, { mergeWriter: { merger: 'github', line: null } })), 'github');
    assert.equal(await readMergeWriter(config, answering(200, { baseBranch: 'main' })), 'github', 'an older server without the field has only GitHub as its writer');
    const refused = async (fetcher: typeof fetch, cause: RegExp, planeWide = true) => {
      const error = await readMergeWriter(config, fetcher).then(() => null, (error: unknown) => error);
      assert.ok(error instanceof MergeWriterUnreadError, `refused: ${String(error)}`);
      assert.match(error.message, /^the merge writer could not be read from https:\/\/graphyard\.example\/api\/status \(/);
      assert.match(error.cause, cause);
      assert.match(error.message, /so the launch is refused before anything is claimed rather than minting a push credential the control plane may have retired; it is dispatched again once the status read succeeds$/);
      assert.equal(planeWideFailure(error.message), planeWide, `the loop ${planeWide ? 'cools no profile for' : 'counts'} it: ${error.message}`);
    };
    await refused(answering(503, { error: 'down' }), /^HTTP 503$/);
    await refused(answering(502, { error: 'Application failed to respond' }), /^HTTP 502$/);
    await refused((async () => { throw new TypeError('fetch failed'); }) as typeof fetch, /^fetch failed$/);
    await refused((async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as typeof fetch, /^The operation was aborted due to timeout$/);
    await refused((async () => new Response('not json', { status: 200 })) as typeof fetch, /JSON/, false);
    await refused(answering(200, { mergeWriter: { merger: 'later-writer' } }), /^mergeWriter\.merger is "later-writer", which this launcher does not know$/, false);
    await refused(answering(401, { error: 'bad credential' }), /^HTTP 401$/, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:worker-launch-credential-free — a launch whose merger read fails is refused before anything is claimed, reserved or minted; the reader given to dispatchWork is the launch\'s one switch between the two confinements', async () => {
  const fixture = await dispatchFixture();
  try {
    let prepared = 0;
    const prepare = async () => { prepared += 1; return fixture.prepare(); };
    const unread = new MergeWriterUnreadError('https://graphyard.example/api/status', 'HTTP 503');
    const launch = (readMergeWriter: () => Promise<'github' | 'control-plane'>) => dispatchWork(fixture.main, fixture.item, fixture.profile, [], fixture.herdr, [fixture.item], prepare, fixture.release, 1, new Date().toISOString(), { readMergeWriter, credential: fixture.minter });
    await assert.rejects(launch(async () => { throw unread; }), (error: unknown) => error === unread);
    assert.equal(prepared, 0, 'nothing was claimed'); assert.deepEqual(fixture.minted, [], 'nothing was minted'); assert.deepEqual(fixture.herdrCalls, [], 'no pane was opened'); assert.deepEqual(fixture.released, [], 'there was no claim to release');
    const started = await launch(async () => 'control-plane');
    assert.equal(prepared, 1); assert.equal(started.mergeWriter, 'control-plane'); assert.equal(started.pushCredential, 'none'); assert.deepEqual(fixture.minted, []);
    assert.ok(!environmentOf(fixture.tabArgs()).some(entry => /^GH_CONFIG_DIR=/.test(entry)));
  } finally { await fixture.cleanup(); }
});

/** The github-mode tab arguments with this host's paths, name, PATH and verification-slot settings replaced, so the record is stable across hosts. */
const normalized = (tabArgs: string[], fixture: { main: string; credentialDirectory: string; minted: { directory: string }[] }) =>
  tabArgs.map(arg => arg.split(fixture.minted[0]?.directory ?? '\u0000').join('<session-credential>').split(fixture.credentialDirectory).join('<credentials>').split(fixture.main).join('<root>').split(`GRAPHYARD_HOST_ID=${hostname()}`).join('GRAPHYARD_HOST_ID=<host>')
    .replace(/^(PATH|GRAPHYARD_VERIFICATION_SLOTS_DIR|GRAPHYARD_VERIFICATION_SLOTS)=.*$/s, '$1=<host>'));
/** Recorded from a github-mode launch before GY-1523 changed the control-plane launch: the tab is created in the worktree, named for the item and agent, and carries the Graphyard variables, the verification environment and the minted push credential's gh and git environment. */
const githubSnapshot = ['tab', 'create', '--cwd', '<root>/.graphyard/worktrees/GY-7-1', '--label', 'GY-7 · eng-a',
  '--env', 'GRAPHYARD_URL=https://graphyard.example', '--env', 'GRAPHYARD_TOKEN_FILE=<credentials>/worker.token', '--env', 'GRAPHYARD_HOST_ID=<host>', '--env', 'GRAPHYARD_HERDR_AGENT_KIND=codex',
  '--env', 'GRAPHYARD_VERIFICATION_SLOTS_DIR=<host>', '--env', 'GRAPHYARD_VERIFICATION_SLOTS=<host>', '--env', 'PATH=<host>',
  '--env', 'GH_CONFIG_DIR=<session-credential>', '--env', 'GH_TOKEN=', '--env', 'GITHUB_TOKEN=', '--env', 'GH_PROMPT_DISABLED=1', '--env', 'GIT_TERMINAL_PROMPT=0', '--env', 'GIT_CONFIG_COUNT=4',
  '--env', 'GIT_CONFIG_KEY_0=credential.helper', '--env', 'GIT_CONFIG_VALUE_0=',
  '--env', 'GIT_CONFIG_KEY_1=credential.https://github.com.helper', '--env', 'GIT_CONFIG_VALUE_1=!f() { test "$1" = get || exit 0; printf \'username=x-access-token\\npassword=%s\\n\' "$(cat \'<session-credential>/token\')"; }; f',
  '--env', 'GIT_CONFIG_KEY_2=url.https://github.com/.pushInsteadOf', '--env', 'GIT_CONFIG_VALUE_2=git@github.com:',
  '--env', 'GIT_CONFIG_KEY_3=url.https://github.com/.pushInsteadOf', '--env', 'GIT_CONFIG_VALUE_3=ssh://git@github.com/', '--no-focus'];

test('unit:worker-launch-github-snapshot — a github-mode launch mints the attempt\'s push credential, sets GH_CONFIG_DIR to it, confines the session with its own credential and types the Herdr tab arguments the recorded snapshot holds', async () => {
  const fixture = await dispatchFixture();
  try {
    const started = await fixture.dispatch('github');
    assert.equal(started.mergeWriter, 'github'); assert.equal(started.pushCredential, 'minted');
    assert.equal(fixture.minted.length, 1); assert.deepEqual([fixture.minted[0].key, fixture.minted[0].epoch], ['GY-7', 3]);
    const environment = environmentOf(fixture.tabArgs());
    assert.ok(environment.includes(`GH_CONFIG_DIR=${fixture.minted[0].directory}`), environment.join(' '));
    assert.ok(environment.includes('GH_TOKEN=') && environment.includes('GITHUB_TOKEN='), 'the host tokens are cleared for the session');
    const recorded = normalized(fixture.tabArgs(), fixture);
    assert.deepEqual(recorded, githubSnapshot, `record: ${JSON.stringify(recorded)}`);
  } finally { await fixture.cleanup(); }
});
