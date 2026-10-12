import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureMainWriteProtection } from '../src/install/deploy-key.js';
import { applyProtection } from '../src/install/github.js';
import type { GitHubCli } from '../src/install/github.js';
import { mainWriteRuleset, mainWriteRulesetCurrent, mainWriteRulesetName, mergeQueueRuleset } from '../src/protection.js';
import { runUp, upControlPlaneSteps, upStateFile, type UpEvent, type UpRequest } from '../src/up.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dirname, join } from 'node:path';

// GY-1715: under the control-plane merger, setup protects the base branch with a ruleset that
// refuses pushes, force pushes and deletions from every actor but the merge writer's deploy key.
// A fake GitHub holds the repository's rulesets, classic protection and deploy keys.

const WRITER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFzs4bbnB6bJVeLLB+C7aK2b6qJ9fcQ0Y6hVwLrjQJvQ graphyard-merge-writer-box-1';
const OTHER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO6YdF1p3nqlEWpqTXzmXb5Gc0Ztw1KqHoNfk2xzXyAB';

interface GitHubState {
  defaultBranch: string;
  rulesets: any[];
  classic: any | null;
  keys: { id: number; key: string; title: string; readOnly: boolean }[];
  rulesetsUnreadable?: boolean;
}

function fakeGitHub(state: GitHubState) {
  const writes: { method: string; path: string; body: any }[] = [];
  const reads: string[] = [];
  const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '', code: 0 });
  const missing = { stdout: '', stderr: 'HTTP 404: Not Found', code: 1 };
  const gh: GitHubCli = async (args, options) => {
    if (args[0] === 'repo' && args[1] === 'deploy-key' && args[2] === 'list') { reads.push('deploy-keys'); return json(state.keys); }
    if (args[0] !== 'api') throw new Error(`unexpected gh ${args.join(' ')}`);
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1]! : 'GET';
    const path = args.find((arg, index) => index > 0 && arg.startsWith('repos/'))!;
    if (method !== 'GET') {
      const body = options?.input ? JSON.parse(options.input) : null;
      writes.push({ method, path, body });
      const id = method === 'POST' ? 100 + state.rulesets.length : Number(path.split('/').pop());
      if (/\/rulesets(\/\d+)?$/.test(path)) state.rulesets = [...state.rulesets.filter(ruleset => ruleset.id !== id), { id, ...body }];
      if (path.endsWith('/protection')) state.classic = body;
      return json({ id });
    }
    reads.push(path);
    if (path === 'repos/owner/project') return json({ default_branch: state.defaultBranch, owner: { type: 'Organization' }, allow_auto_merge: false });
    if (path.startsWith('repos/owner/project/rulesets?')) {
      // GitHub pages the list (per_page defaults to 30): only the page asked for is returned.
      const query = new URLSearchParams(path.split('?')[1]);
      const size = Number(query.get('per_page') ?? 30), page = Number(query.get('page') ?? 1);
      return state.rulesetsUnreadable ? missing : json(state.rulesets.slice((page - 1) * size, page * size).map(({ id, name }) => ({ id, name })));
    }
    const one = path.match(/\/rulesets\/(\d+)$/);
    if (one) { const found = state.rulesets.find(ruleset => ruleset.id === Number(one[1])); return found ? json(found) : missing; }
    if (path.endsWith('/protection')) return state.classic ? json(state.classic) : missing;
    if (path.includes('/rules/branches/')) return json(state.rulesets.flatMap(ruleset => (ruleset.rules ?? []).map((rule: any) => ({ ...rule, ruleset_id: ruleset.id }))));
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, writes, reads, state };
}
const fresh = (overrides: Partial<GitHubState> = {}): GitHubState => ({ defaultBranch: 'main', rulesets: [], classic: null, keys: [{ id: 1, key: WRITER, title: 'graphyard-merge-writer-box-1', readOnly: false }], ...overrides });

test('unit:main-write-protection-ruleset — control-plane setup writes an active ruleset on the base branch that refuses updates, force pushes and deletions from every actor, administrators included, with deploy keys as the only bypass, and refuses while any read-write deploy key other than the merge writer\'s would share that bypass', async () => {
  const github = fakeGitHub(fresh());
  const result = await ensureMainWriteProtection('owner/project', github.gh, { writerKey: WRITER });
  assert.equal(result.state, 'created');
  assert.equal(result.baseBranch, 'main', 'the base branch is the repository\'s default branch unless named');
  assert.equal(github.writes.length, 1);
  const [write] = github.writes;
  assert.equal(write!.method, 'POST');
  assert.equal(write!.path, 'repos/owner/project/rulesets');
  assert.deepEqual(write!.body, mainWriteRuleset('main'));
  assert.equal(write!.body.name, mainWriteRulesetName);
  assert.equal(write!.body.enforcement, 'active');
  assert.deepEqual(write!.body.conditions.ref_name.include, ['refs/heads/main']);
  assert.deepEqual(write!.body.rules.map((rule: any) => rule.type).sort(), ['creation', 'deletion', 'non_fast_forward', 'update']);
  // Creating the base branch is a push too: on a repository whose base branch does not exist yet, only a deploy key may create it.
  assert.ok((write!.body.rules as any[]).some(rule => rule.type === 'creation'), 'creation of the base branch is restricted to the bypass');
  assert.equal(mainWriteRulesetCurrent({ ...mainWriteRuleset('main'), rules: mainWriteRuleset('main').rules.filter(rule => rule.type !== 'creation') }, 'main'), false, 'a Graphyard ruleset without the creation rule is drift and is rewritten');
  assert.equal((write!.body.rules as any[]).find(rule => rule.type === 'update').parameters.update_allows_fetch_and_merge, false);
  // No role, team, App or organization admin may bypass: only deploy keys, and the install registers one read-write key.
  assert.deepEqual(write!.body.bypass_actors, [{ actor_id: null, actor_type: 'DeployKey', bypass_mode: 'always' }]);

  // A named base branch is protected instead of the default one.
  const named = fakeGitHub(fresh());
  assert.equal((await ensureMainWriteProtection('owner/project', named.gh, { baseBranch: 'trunk', writerKey: WRITER })).baseBranch, 'trunk');
  assert.deepEqual(named.writes[0]!.body.conditions.ref_name.include, ['refs/heads/trunk']);
  assert.ok(!named.reads.includes('repos/owner/project'), 'a named base branch needs no repository read');

  // GitHub's deploy-key bypass covers every deploy key, so another read-write key would push too:
  // setup refuses, writing nothing and claiming nothing, until that key is removed. Read-only keys cannot push.
  const sharedKeys = [...fresh().keys, { id: 2, key: OTHER, title: 'ci-pusher', readOnly: false }, { id: 3, key: OTHER, title: 'mirror', readOnly: true }];
  const shared = fakeGitHub(fresh({ keys: sharedKeys }));
  await assert.rejects(ensureMainWriteProtection('owner/project', shared.gh, { writerKey: WRITER }), /Read-write deploy keys ci-pusher on owner\/project would share the merge writer's bypass, so main was not protected/);
  assert.deepEqual(shared.writes, []);
  // The same refusal holds when Graphyard's ruleset already stands: it is not reported as protecting the branch.
  const standing = fakeGitHub(fresh({ keys: sharedKeys, rulesets: [{ id: 9, ...mainWriteRuleset('main') }] }));
  await assert.rejects(ensureMainWriteProtection('owner/project', standing.gh, { writerKey: WRITER }), /ci-pusher/);
  assert.deepEqual(standing.writes, []);
  // Removing the other key lets the same setup protect the branch; read-only keys never block it.
  shared.state.keys = shared.state.keys.filter(key => key.title !== 'ci-pusher');
  assert.equal((await ensureMainWriteProtection('owner/project', shared.gh, { writerKey: WRITER })).state, 'created');
  // A merge-writer key that is not registered read-write, or a key list that cannot be read, also refuses without writing.
  const unregistered = fakeGitHub(fresh({ keys: [{ id: 3, key: OTHER, title: 'mirror', readOnly: true }] }));
  await assert.rejects(ensureMainWriteProtection('owner/project', unregistered.gh, { writerKey: WRITER }), /not registered read-write/);
  assert.deepEqual(unregistered.writes, []);
  const unreadable = fakeGitHub(fresh());
  const failingList: GitHubCli = async (args, options) => args[1] === 'deploy-key' ? { stdout: '', stderr: 'HTTP 403', code: 1 } : unreadable.gh(args, options);
  await assert.rejects(ensureMainWriteProtection('owner/project', failingList, { writerKey: WRITER }), /deploy keys of owner\/project could not be read/);
  assert.deepEqual(unreadable.writes, []);

  // An install whose deploy-key step completed in an earlier run (before this protection existed) still
  // gets it: graphyard up checks the base branch on every control-plane run, through the install's own key.
  const root = await temporaryDirectory('main-write-protection');
  {
    const installDir = join(root, 'install');
    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, 'deploy-key'), 'private', { mode: 0o600 });
    await writeFile(join(installDir, 'deploy-key.pub'), `${WRITER}\n`, { mode: 0o600 });
    const request: UpRequest = { repository: 'owner/project', provider: 'compose', agent: true, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null, merger: 'control-plane' };
    await mkdir(dirname(upStateFile(root)), { recursive: true });
    await writeFile(upStateFile(root), JSON.stringify({ version: 1, repository: request.repository, provider: request.provider, merger: 'control-plane', completed: [...upControlPlaneSteps], noHerdr: true, goal: null }));
    const resumed = fakeGitHub(fresh());
    const events: UpEvent[] = [];
    const ghCalls: string[][] = [];
    await runUp(request, {
      root, emit: event => { events.push(event); }, now: () => 0, sleep: async () => {}, pollMs: 1, machineWaitMs: 0, humanWaitMs: 0,
      serverUrl: async () => null, masterToken: async () => null, status: async () => null,
      cli: async () => ({ code: 0, stdout: '{}' }), publishOnboarding: async () => null, onboardingMerged: async () => true,
      installDirectory: () => installDir,
      gh: async (args, input) => { ghCalls.push(args); return resumed.gh(args, input === undefined ? undefined : { input }); },
    });
    assert.ok(events.some(event => event.kind === 'step' && event.step === 'deploy-key' && event.state === 'skipped'), 'the deploy-key step itself is done by the earlier run');
    assert.deepEqual(resumed.writes.map(write => [write.method, write.path]), [['POST', 'repos/owner/project/rulesets']]);
    assert.deepEqual(resumed.writes[0]!.body, mainWriteRuleset('main'));
    assert.ok(events.some(event => event.kind === 'note' && /Base branch protection: Graphyard merge writer only on main/.test(event.text)), 'the run reports the protection');
    assert.ok(!ghCalls.some(args => args[1] === 'deploy-key' && args[2] === 'add'), 'the registered key is not added again');
  }
});

test('unit:main-write-protection-idempotent — applying the protection twice writes once; a drifted Graphyard ruleset is rewritten in place; a base branch the operator already protects (classic protection or another ruleset) is left untouched and reported', async () => {
  const github = fakeGitHub(fresh());
  assert.equal((await ensureMainWriteProtection('owner/project', github.gh, { writerKey: WRITER })).state, 'created');
  const after = JSON.stringify(github.state);
  github.writes.length = 0;
  const second = await ensureMainWriteProtection('owner/project', github.gh, { writerKey: WRITER });
  assert.equal(second.state, 'unchanged');
  assert.deepEqual(github.writes, [], 'a second run changes nothing');
  assert.equal(JSON.stringify(github.state), after);
  assert.ok(mainWriteRulesetCurrent(github.state.rulesets[0], 'main'));

  // Graphyard's own ruleset, drifted (someone added an admin bypass), is rewritten by id, not duplicated.
  const drifted = fakeGitHub(fresh({ rulesets: [{ id: 7, ...mainWriteRuleset('main'), bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }, ...mainWriteRuleset('main').bypass_actors] }] }));
  assert.equal((await ensureMainWriteProtection('owner/project', drifted.gh, { writerKey: WRITER })).state, 'updated');
  assert.deepEqual(drifted.writes.map(write => [write.method, write.path]), [['PUT', 'repos/owner/project/rulesets/7']]);
  assert.equal(drifted.state.rulesets.length, 1);
  assert.equal((await ensureMainWriteProtection('owner/project', drifted.gh, { writerKey: WRITER })).state, 'unchanged');

  // Graphyard's ruleset past the first page of GET /rulesets (GitHub's default page is 30) is still found:
  // a second application reads every page and writes nothing, rather than reporting the operator's rulesets or adding a duplicate.
  const tagRulesets = Array.from({ length: 130 }, (_, index) => ({ id: 1000 + index, name: `Operator tags ${index}`, target: 'tag', enforcement: 'active', conditions: { ref_name: { include: [`refs/tags/v${index}`], exclude: [] } }, rules: [] }));
  const paged = fakeGitHub(fresh({ rulesets: [...tagRulesets, { id: 7, ...mainWriteRuleset('main') }] }));
  assert.equal((await ensureMainWriteProtection('owner/project', paged.gh, { writerKey: WRITER })).state, 'unchanged');
  assert.equal(paged.writes.length, 0);
  assert.ok(paged.reads.includes('repos/owner/project/rulesets?includes_parents=false&per_page=100&page=2'), 'the second page is read');
  assert.ok(!paged.reads.some(path => path.includes('/protection') || path.includes('/rules/branches/')), 'Graphyard\'s ruleset is not taken for absent, so no operator protection is looked for');
  paged.state.rulesets = paged.state.rulesets.map(ruleset => ruleset.id === 7 ? { ...ruleset, enforcement: 'evaluate' } : ruleset);
  assert.equal((await ensureMainWriteProtection('owner/project', paged.gh, { writerKey: WRITER })).state, 'updated', 'drift past page one is rewritten in place');
  assert.deepEqual(paged.writes.map(write => [write.method, write.path]), [['PUT', 'repos/owner/project/rulesets/7']]);
  // A ruleset list that cannot be read refuses rather than guessing from a partial list.
  const unreadableRulesets = fakeGitHub(fresh({ rulesetsUnreadable: true }));
  await assert.rejects(ensureMainWriteProtection('owner/project', unreadableRulesets.gh, { writerKey: WRITER }), /rulesets of owner\/project could not be read, so main was not protected/);
  assert.deepEqual(unreadableRulesets.writes, []);

  // The operator's classic branch protection is kept as is and reported.
  const classic = { required_pull_request_reviews: { required_approving_review_count: 1 }, enforce_admins: { enabled: true } };
  const protectedClassic = fakeGitHub(fresh({ classic }));
  const classicResult = await ensureMainWriteProtection('owner/project', protectedClassic.gh, { writerKey: WRITER });
  assert.equal(classicResult.state, 'operator-protected');
  assert.match(classicResult.detail, /main already carries the operator's branch protection; left as is/);
  assert.deepEqual(protectedClassic.writes, []);
  assert.deepEqual(protectedClassic.state.classic, classic);

  // So is an operator ruleset already active on the branch.
  const operatorRuleset = { id: 3, name: 'Protect main', target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [{ type: 'pull_request' }] };
  const protectedRuleset = fakeGitHub(fresh({ rulesets: [operatorRuleset] }));
  const rulesetResult = await ensureMainWriteProtection('owner/project', protectedRuleset.gh, { writerKey: WRITER });
  assert.equal(rulesetResult.state, 'operator-protected');
  assert.match(rulesetResult.detail, /operator's rulesets; left as is/);
  assert.deepEqual(protectedRuleset.writes, []);
  assert.deepEqual(protectedRuleset.state.rulesets, [operatorRuleset]);

  // The operator's protection is accepted only for a key that can push: a writer key registered read-only,
  // or another read-write key sharing the deploy-key bypass, refuses and leaves the operator's rules untouched.
  const readOnlyWriter = fakeGitHub(fresh({ classic, keys: [{ id: 1, key: WRITER, title: 'graphyard-merge-writer-box-1', readOnly: true }] }));
  await assert.rejects(ensureMainWriteProtection('owner/project', readOnlyWriter.gh, { writerKey: WRITER }), /merge writer's deploy key is not registered read-write on owner\/project/);
  assert.deepEqual(readOnlyWriter.writes, []);
  assert.deepEqual(readOnlyWriter.state.classic, classic);
  const sharedBypass = fakeGitHub(fresh({ rulesets: [operatorRuleset], keys: [...fresh().keys, { id: 2, key: OTHER, title: 'ci-deploy', readOnly: false }] }));
  await assert.rejects(ensureMainWriteProtection('owner/project', sharedBypass.gh, { writerKey: WRITER }), /Read-write deploy keys ci-deploy on owner\/project would share the merge writer's bypass/);
  assert.deepEqual(sharedBypass.writes, []);
  assert.deepEqual(sharedBypass.state.rulesets, [operatorRuleset]);
});

test('unit:main-write-protection-github-mode-unchanged — github-mode setup (branch protection plus the merge queue) writes neither the merge-writer ruleset nor a deploy-key bypass, and the merge-queue ruleset keeps its single App bypass', async () => {
  const github = fakeGitHub(fresh({ keys: [] }));
  await applyProtection(github.gh, { repository: 'owner/project', branch: 'main', requiredChecks: ['test'], graphyardAppId: 42, reviewCount: 1 });
  assert.ok(github.writes.length > 0, 'github-mode setup still protects the branch');
  assert.deepEqual(github.writes.map(write => [write.method, write.path]), [
    ['PUT', 'repos/owner/project/branches/main/protection'],
    ['POST', 'repos/owner/project/rulesets'],
  ]);
  for (const write of github.writes) {
    assert.notEqual(write.body?.name, mainWriteRulesetName);
    assert.ok(!JSON.stringify(write.body).includes('DeployKey'), `${write.method} ${write.path} carries no deploy-key bypass`);
  }
  assert.ok(!github.reads.includes('deploy-keys'), 'github mode never reads deploy keys');
  assert.deepEqual(mergeQueueRuleset({ baseBranch: 'main', githubAppId: 42 }).bypass_actors, [{ actor_id: 42, actor_type: 'Integration', bypass_mode: 'pull_request' }]);
});
