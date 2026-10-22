import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, masterHarness, type MasterConfig } from '../src/master.js';
import { harnessDecision, retiredMasterRules, writeHarnessPermissions } from '../src/harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1217: the master's denies name the endpoints that merge, enqueue or approve, not the word
// "merge", so a read that mentions it runs; and `master harness --apply` rewrites an installed
// harness that still carries the old word-wide rules.

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

// GY-1308: the coordinator checkout's settings lost the merge and push denies and kept the retired
// word-wide GraphQL deny.
const driftRules = ['Bash(gh pr merge:*)', 'Bash(gh api *pulls/*/merge*)', 'Bash(gh api *repos/*/merges*)', 'Bash(gh api *merge-upstream*)',
  'Bash(gh api graphql*mutation*)', 'Bash(gh api graphql*=@*)', 'Bash(gh api graphql*--input*)', 'Bash(git push:*)'];
async function drifted(root: string, master: MasterConfig) {
  const plan = masterHarness(root, master, 'claude');
  const installed = { permissions: { allow: [...plan.allow.map(entry => entry.rule), 'Bash(npm test)'], deny: [...plan.deny.map(entry => entry.rule).filter(rule => !driftRules.includes(rule)), 'Bash(gh api graphql*)', 'Bash(rm -rf /)'] }, model: 'opus' };
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(join(root, '.claude/settings.local.json'), JSON.stringify(installed));
  await writeFile(join(root, '.gitignore'), '.claude/settings.local.json\n');
  return { plan, installed };
}

test('unit:harness-deny-plan-names-every-drift-rule — the rewritten deny list holds every rule the drift check named and drops only the stale graphql deny, keeping allow rules and read-only gh usage', async () => {
  const { root, master, cleanup } = await repository();
  try {
    const { plan, installed } = await drifted(root, master);
    for (const rule of driftRules) assert.ok(plan.deny.some(entry => entry.rule === rule), `${rule} is in the master deny plan`);
    const written = await writeHarnessPermissions(root, plan, true);
    assert.deepEqual(written.removed, [{ list: 'deny', rule: 'Bash(gh api graphql*)' }], 'only the stale graphql deny is removed');
    const settings = JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8'));
    for (const rule of driftRules) assert.ok(settings.permissions.deny.includes(rule), `${rule} is installed`);
    assert.ok(!settings.permissions.deny.includes('Bash(gh api graphql*)'));
    assert.deepEqual(settings.permissions.deny.filter((rule: string) => !driftRules.includes(rule)), installed.permissions.deny.filter(rule => rule !== 'Bash(gh api graphql*)'), 'every other deny is kept');
    assert.deepEqual(settings.permissions.allow, installed.permissions.allow, 'allow rules are intact');
    assert.equal(settings.model, 'opus');
    // Read-only gh usage the harness needs still runs.
    for (const command of allowed) assert.notEqual(harnessDecision(plan, command).decision, 'deny', `${command} stays open`);
    for (const command of ['gh pr view 606 --json state', 'gh pr checks 606', 'gh pr diff 606', 'gh pr list --head graphyard/gy-1'])
      assert.equal(harnessDecision(plan, command).decision, 'allow', `${command} is allowed`);
    for (const command of ['gh pr merge 606 --squash', 'git push origin main', 'gh api graphql --input body.json']) assert.equal(harnessDecision(plan, command).decision, 'deny', `${command} is denied`);
  } finally { await cleanup(); }
});
