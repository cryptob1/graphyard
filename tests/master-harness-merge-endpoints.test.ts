import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, masterHarness, type MasterConfig } from '../src/master.js';
import { harnessDecision, retiredMasterRules, writeHarnessPermissions } from '../src/harness.js';
import { masterHarnessDrift } from '../src/cli/master/fleet.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1217: the master's denies name the endpoints that merge, enqueue or approve, not the word
// "merge", so a read that mentions it runs; and an installed harness that still carries the old
// word-wide rules is reported as drift and rewritten by `master harness --apply`.

const launcher = resolve(fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)));
const config = (credentialFile: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

async function repository() {
  const root = await temporaryDirectory('master-harness');
  execFileSync('git', ['init', '-q', root]);
  return { root, master: config(join(root, '.graphyard-credentials/master/token')), cleanup: () => rm(root, { recursive: true, force: true }) };
}

const denied = [
  'gh api -X PUT repos/owner/project/pulls/606/merge',
  'gh api repos/owner/project/pulls/606/merge -X PUT -f merge_method=squash',
  'gh api --method PUT repos/owner/project/pulls/606/merge',
  'gh api repos/owner/project/merges -f base=main -f head=feature',
  'gh api repos/owner/project/merge-upstream -f branch=main',
  `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } }'`,
  `gh api graphql -f query='mutation { enqueuePullRequest(input: {pullRequestId: "PR_1"}) { mergeQueueEntry { id } } }'`,
  `gh api graphql -f query='mutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }' -f id=PR_1`,
  `gh api graphql -f query='mutation { addPullRequestReview(input: {pullRequestId: "PR_1", event: APPROVE}) { clientMutationId } }'`,
  'gh api graphql -F query=@enqueue.graphql',
  'gh api graphql --input body.json',
  'gh pr merge 606 --squash',
  'gh pr merge 606 --auto',
  'gh pr review 606 --approve',
];
const allowed = [
  `gh api repos/owner/project/pulls/606 -q '{state: .state, merged: .merged, mergeable: .mergeable, merged_at: .merged_at}'`,
  `gh api repos/owner/project/pulls?state=closed --jq '.[] | select(.merged_at != null) | .number'`,
  'gh api repos/owner/project/commits/abc123/pulls --jq ".[0].merge_commit_sha"',
  'gh api repos/owner/project/branches/main/protection',
  `gh api graphql -f query='query { repository(owner: "owner", name: "project") { pullRequest(number: 606) { merged mergeable mergeStateStatus mergeQueueEntry { position } autoMergeRequest { enabledAt } } } }'`,
  `gh api graphql -f query='{ repository(owner: "owner", name: "project") { mergeQueue(branch: "main") { entries(first: 10) { nodes { pullRequest { number } } } } } }'`,
  'gh pr view 606 --json state,merged,mergeable,mergeStateStatus,mergedAt',
  `gh pr view 606 --json mergeStateStatus -q '.mergeStateStatus' | jq -r .`,
];

test('unit:master-harness-denies-merge-endpoints-not-words — merge, enqueue, auto-merge and approval endpoints stay denied while reads that mention merge are not', async () => {
  const { root, master, cleanup } = await repository();
  try {
    const plan = masterHarness(root, master, 'claude');
    for (const command of denied) assert.equal(harnessDecision(plan, command).decision, 'deny', `${command} must stay denied`);
    for (const command of allowed) {
      const decision = harnessDecision(plan, command);
      assert.notEqual(decision.decision, 'deny', `${command} is a read and must not be denied (denied by ${decision.rule?.rule})`);
    }
    // gh pr view reads are allowed outright, not merely left to ask.
    assert.equal(harnessDecision(plan, 'gh pr view 606 --json merged,mergeable').decision, 'allow');
    const deny = plan.deny.map(entry => entry.rule);
    for (const rule of retiredMasterRules) assert.ok(!deny.includes(rule), `${rule} denies by word and is no longer generated`);
    assert.ok(!deny.some(rule => /^Bash\(gh api \*merge\*\)$|^Bash\(gh api graphql\*\)$/.test(rule)));
  } finally { await cleanup(); }
});

test('unit:master-harness-drift-reported — an installed older rule set is reported as harness drift naming its stale rules, and master harness --apply rewrites it', async () => {
  const { root, master, cleanup } = await repository();
  try {
    const plan = masterHarness(root, master, 'claude');
    assert.equal(await masterHarnessDrift(root, master), null, 'nothing installed is not drift');
    // The older generation: the same rules, with the word-wide denies in place of the endpoint ones.
    const scoped = new Set(['Bash(gh api *pulls/*/merge*)', 'Bash(gh api *repos/*/merges*)', 'Bash(gh api *merge-upstream*)', 'Bash(gh api graphql*mutation*)', 'Bash(gh api graphql*=@*)', 'Bash(gh api graphql*--input*)']);
    const older = { permissions: { allow: [...plan.allow.map(entry => entry.rule), 'Bash(npm test)'], deny: [...plan.deny.map(entry => entry.rule).filter(rule => !scoped.has(rule)), ...retiredMasterRules, 'Bash(rm -rf /)'] }, model: 'opus' };
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude/settings.local.json'), JSON.stringify(older));
    await writeFile(join(root, '.gitignore'), '.claude/settings.local.json\n');

    const item = await masterHarnessDrift(root, master);
    assert.ok(item, 'the older rule set is drift');
    assert.equal(item.subject, 'harness');
    assert.equal(item.next, 'graphyard master harness claude --apply');
    assert.match(item.text, /^Harness drift in \.claude\/settings\.local\.json: stale deny Bash\(gh api \*merge\*\), deny Bash\(gh api graphql\*\); missing deny Bash\(gh api \*pulls\/\*\/merge\*\)/);
    assert.match(item.text, /Run graphyard master harness claude --apply to rewrite it\.$/);
    assert.deepEqual(item.drift!.stale, retiredMasterRules.map(rule => ({ list: 'deny', rule })));
    assert.deepEqual(new Set(item.drift!.missing.map(entry => entry.rule)), scoped);

    // A dry run names what --apply would change and writes nothing.
    const preview = await writeHarnessPermissions(root, plan, false);
    assert.deepEqual(preview.removed, retiredMasterRules.map(rule => ({ list: 'deny', rule })));
    assert.deepEqual(JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8')), older);

    // `master harness claude --apply` is this write.
    const written = await writeHarnessPermissions(root, plan, true);
    assert.equal(written.applied, true);
    const settings = JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8'));
    for (const rule of retiredMasterRules) assert.ok(!settings.permissions.deny.includes(rule), `${rule} is removed`);
    for (const rule of scoped) assert.ok(settings.permissions.deny.includes(rule), `${rule} is installed`);
    assert.ok(settings.permissions.allow.includes('Bash(npm test)') && settings.permissions.deny.includes('Bash(rm -rf /)'), 'operator-added rules are kept');
    assert.equal(settings.model, 'opus', 'other settings are kept');
    assert.equal(await masterHarnessDrift(root, master), null, 'the rewritten harness matches the plan');
  } finally { await cleanup(); }
});
