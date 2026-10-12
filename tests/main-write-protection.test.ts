import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureMainWriteProtection } from '../src/install/deploy-key.js';
import { applyProtection } from '../src/install/github.js';
import type { GitHubCli } from '../src/install/github.js';
import { mainWriteRuleset, mainWriteRulesetCurrent, mainWriteRulesetName, mergeQueueRuleset } from '../src/protection.js';

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
    if (path.startsWith('repos/owner/project/rulesets?')) return json(state.rulesets.map(({ id, name }) => ({ id, name })));
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
  assert.deepEqual(write!.body.rules.map((rule: any) => rule.type).sort(), ['deletion', 'non_fast_forward', 'update']);
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
