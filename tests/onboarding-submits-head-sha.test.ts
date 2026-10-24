import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { publishOnboarding } from '../src/up.js';
import { fileOnboardingWork } from '../src/onboarding.js';
import { onboardingBranch } from '../src/model/onboarding-work.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2938: `graphyard up`'s onboarding apply publishes the files `init --scan --apply` wrote as one
 * commit on `graphyard/onboarding` and submits that commit as a work item by head sha, exactly as a
 * worker's `complete --head` submits (GY-1523) — no pull request is opened, and the build gate reads
 * the submitted head as its candidate. Against a control-plane merger the old filing submitted
 * `{epoch, pr}` for a pull request nothing ever reads, so GY-1 stalled in build forever.
 */
const repository = 'owner/project';
const operator = { id: 'graphyard-operator', role: 'admin' as const, sessionKind: 'human' as const };
const token = 'o'.repeat(40);
const git = (args: readonly string[], cwd?: string) => execFileSync('git', cwd ? ['-C', cwd, ...args] : [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let fixtureRoot: string, checkout: string, baseTip: string;
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  // The operator's checkout and its origin, laid out as a fresh repository is: main pushed, and the
  // onboarding files `init --scan --apply` wrote sitting untracked in the checkout.
  fixtureRoot = await realpath(await temporaryDirectory('onboarding-head'));
  const origin = join(fixtureRoot, 'origin.git');
  checkout = join(fixtureRoot, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(['config', 'user.email', 't@example.com'], checkout);
  git(['config', 'user.name', 'T'], checkout);
  await writeFile(join(checkout, 'README.md'), '# Fixture\n');
  git(['add', '--', 'README.md'], checkout);
  git(['commit', '-q', '-m', 'base'], checkout);
  git(['push', '-q', 'origin', 'main'], checkout);
  baseTip = git(['rev-parse', 'refs/remotes/origin/main'], checkout);
  await writeFile(join(checkout, 'AGENTS.md'), '# Coordination\n');
  await writeFile(join(checkout, '.gitignore'), '.graphyard/\n');
  await writeFile(join(checkout, 'graphyard.json'), '{}\n');

  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 938;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('onboarding-head-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('onboarding_head_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/onboarding_head_test`); await store.init();
  // The control plane is the merge writer: it observes submitted heads from this checkout's own object store.
  engine = new Engine(store, 120, repository);
  engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  engine.principals = [operator];
  http = server(engine, [{ ...operator, token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (pg) await pg.stop();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

/** The substituted host: real git, gh recorded — `repo view` answers, anything else is a failure. */
let ghCalls: string[][] = [];
const run = (program: string, args: string[], env?: Record<string, string>): string => {
  if (program === 'gh') { ghCalls.push(args); if (args[0] === 'repo' && args[1] === 'view') return 'main'; throw new Error(`gh ${args.join(' ')} ran`); }
  return execFileSync(program, args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) });
};
const filing = (commit: string, requestId: string) => ({ server: url, token, commit, checks: null, host: 'test-host', path: join(checkout, '.graphyard', 'onboarding'), requestId });

test('unit:onboarding-submits-head-sha — the onboarding apply publishes one commit on graphyard/onboarding, opens no pull request, and its item is submitted with that head and epoch, so the build gate reads the head as its candidate', async () => {
  // The publish commits the onboarding files above the base tip and pushes the branch; it opens no
  // pull request and names none: the only gh it runs is the default-branch read.
  const published = await publishOnboarding(checkout, repository, run);
  assert.ok(published, 'the base branch lacks the onboarding files, so the publish carries them');
  const commit = published!.commit;
  assert.match(commit, /^[0-9a-f]{40}$/, 'the publish answers the onboarding commit');
  assert.equal(Object.keys(published!).sort().join(','), 'commit', 'the publish names no pull request');
  assert.deepEqual(ghCalls.map(args => args.slice(0, 2).join(' ')), ['repo view'], 'no gh pr create (nor any other pull-request command) ran on the substituted host');
  assert.equal(git(['rev-parse', `refs/heads/${onboardingBranch}`], join(fixtureRoot, 'origin.git')), commit, 'the onboarding branch on origin holds the commit');

  // The commit is observable from the checkout the control plane reads, above the base tip.
  assert.equal(git(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], checkout), commit);

  // Filing creates the item and submits the head with the claim's epoch, as a worker's complete does.
  const filed = await fileOnboardingWork(filing(commit, 'request-onboarding-1'));
  assert.equal(filed.key, 'GY-1');
  const item = await engine.store.workDocument(filed.id);
  assert.ok(item, 'the item exists');
  assert.equal(item!.submission?.epoch, 1, 'the submission carries the claim epoch');
  assert.equal(item!.candidate?.sha, commit, 'the build gate reads the onboarding commit as the candidate');
  assert.equal(item!.candidate?.branch, onboardingBranch, 'the candidate sits on the onboarding branch');
  assert.equal(item!.candidate?.baseSha, baseTip, 'the candidate was read against the base tip');
  assert.equal(item!.observation?.source, 'control-plane', 'the head was observed from the shared object store, never from a pull request');
  assert.ok((item!.candidate?.pr ?? 0) > 0, 'the candidate holds its own change number');
  assert.equal(item!.candidate?.pr, item!.submission?.pr, 'the submission names no pull request: its number is the change number the head was observed under');
  const build = (item!.gates ?? []).find(gate => gate.name === 'build');
  assert.equal(build?.passed, true, `the build gate passes on the submitted head: ${JSON.stringify(build)}`);
  assert.ok(!JSON.stringify(item!.gates).match(/pull request/i), 'no gate reads a pull request');

  // A rerun republishes the same commit (same tree, parent and message) and the filing replays its
  // receipt: one item, one head, no second pull request.
  ghCalls = [];
  const republished = await publishOnboarding(checkout, repository, run);
  assert.equal(republished?.commit, commit, 'the rerun publishes the same commit');
  const refilled = await fileOnboardingWork(filing(commit, 'request-onboarding-1'));
  assert.equal(refilled.key, filed.key, 'the rerun replays the filing, it does not file twice');
  assert.equal((await store.list()).length, 1, 'exactly one onboarding item exists');
});
