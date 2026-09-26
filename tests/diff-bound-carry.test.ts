import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, patchId } from '../src/github.js';
import { queueRef, tipValidation, type QueueSpeculation } from '../src/merge-queue.js';
import { carriedApproval, currentCarry, decideCarry, describeGround, evidenceBindsCandidate, type CarryInput, type Evidence, type TipMerge, type Work } from '../src/model.js';

// GY-330: review and proofs bind the change's own diff. Each test is named for the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1'), P = sha40('c1'), TIP = sha40('d1');
const at = '2026-09-25T08:00:00.000Z';

// The reviewed change: one hunk of src/queue.ts and a new test file. The base then edited another
// hunk of src/queue.ts, higher up, so on the tip the same change sits four lines further down.
const hunk = (line: number, body: string) => `@@ -${line},3 +${line},4 @@ export function queue() {\n   const entries = [];\n-  return entries;\n+  ${body}\n+  return entries.sort();\n }`;
const reviewedFiles = (body = 'entries.push(next);') => [
  { filename: 'src/queue.ts', status: 'modified', changes: 3, patch: hunk(40, body) },
  { filename: 'tests/queue.test.ts', status: 'added', changes: 2, patch: '@@ -0,0 +1,2 @@\n+import { queue } from "../src/queue.js";\n+test("queue", () => queue());' },
];
const tipFiles = (body = 'entries.push(next);') => reviewedFiles(body).map(file => file.filename === 'src/queue.ts' ? { ...file, patch: hunk(44, body) } : file);

/** A GitHub adapter whose compare answers are the two diffs above and whose tip is App-authored. */
function github(compare: Record<string, unknown[]>) {
  const client = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used' });
  const requested: string[] = [];
  client.controlPlaneLogin = async () => 'graphyard-owner-repo[bot]';
  client.request = async (path: string) => {
    requested.push(path);
    if (path === `/commits/${TIP}`) return { sha: TIP, parents: [{ sha: H }, { sha: P }], author: { login: 'graphyard-owner-repo[bot]', type: 'Bot' }, commit: { author: { email: 'bot@users.noreply.github.com' } } };
    if (path.startsWith('/compare/')) { const range = path.slice('/compare/'.length).split('?')[0]; return { status: 'ahead', files: compare[range] ?? [] }; }
    throw new Error(`Unexpected request ${path}`);
  };
  return { client, requested };
}
const evidence = (proof: string, overrides: Partial<Evidence> = {}): Evidence => ({ id: `ev-${proof}`, proof, sha: H, baseSha: B, policyRevision: 1, producer: 'ci-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at, ...overrides });
function input(merge: TipMerge, overrides: Partial<CarryInput> = {}): CarryInput {
  return { from: { sha: H, baseSha: B }, to: { sha: TIP, baseSha: P }, policyRevision: 1, at, merge, predecessor: { key: null, validated: true },
    reviewedFiles: ['src/queue.ts', 'tests/queue.test.ts'], approval: { provider: 'github', reviewer: 'reviewer[bot]', sha: H, reviewId: 900 },
    proofs: [{ proof: 'unit:queue', evidence: evidence('unit:queue', { scopeFiles: ['src/queue.ts'] }) }, { proof: 'manual:unscoped', evidence: evidence('manual:unscoped') }],
    app: 'graphyard', ...overrides };
}

test('unit:diff-bound-carry — a patch-id from GitHub\'s compare ignores where the change sits and sees any edit to the change itself', () => {
  const reviewed = patchId(reviewedFiles());
  assert.match(reviewed!, /^[0-9a-f]{40}$/);
  assert.equal(patchId(tipFiles()), reviewed, 'the same change four lines further down has the same patch-id');
  assert.equal(patchId([...reviewedFiles()].reverse()), reviewed, 'the order GitHub lists files in does not matter');
  assert.notEqual(patchId(tipFiles('entries.push(other);')), reviewed, 'an edit to the change itself changes the patch-id');
  assert.notEqual(patchId(reviewedFiles().slice(0, 1)), reviewed, 'a file dropped from the change changes the patch-id');
  // Whitespace inside a line is content: indentation and string literals are part of the change.
  const yaml = (line: string) => [{ filename: 'ci.yml', status: 'modified', changes: 1, patch: `@@ -1,2 +1,2 @@\n jobs:\n-  old: 1\n+${line}` }];
  assert.notEqual(patchId(yaml('  new: 1')), patchId(yaml('new: 1')), 'a change of indentation changes the patch-id');
  assert.equal(patchId(yaml('  new: 1  \r')), patchId(yaml('  new: 1')), 'trailing whitespace and a carriage return do not');
  // A list that is not the whole change is never compared.
  assert.equal(patchId([{ filename: 'assets/logo.png', status: 'modified', changes: 0 }]), null, 'a binary file has no patch to compare');
  assert.equal(patchId(Array.from({ length: 300 }, (_, index) => ({ filename: `f${index}`, status: 'modified', changes: 1, patch: '@@ -1 +1 @@\n-a\n+b' }))), null, 'a truncated list');
  assert.equal(patchId(undefined), null);
  assert.match(patchId([{ filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed', changes: 0 }])!, /^[0-9a-f]{40}$/, 'a pure rename has no patch to give');
});

test('unit:diff-bound-carry — an approval and every proof carry across a base that edited another hunk of a reviewed file when the change\'s own diff is unchanged', async () => {
  const { client, requested } = github({ [`${B}...${H}`]: reviewedFiles(), [`${P}...${TIP}`]: tipFiles(), [`${B}...${P}`]: [{ filename: 'src/queue.ts' }, { filename: 'docs/queue.md' }] });
  const merge: TipMerge = await (client as any).describeMerge(H, TIP, B, P);
  // Each side of the diff is GitHub's compare of the head against its merge base with its own base.
  assert.ok(requested.includes(`/compare/${B}...${H}`) && requested.includes(`/compare/${P}...${TIP}`), requested.join(' '));
  assert.deepEqual(merge.baseChanges, ['src/queue.ts', 'docs/queue.md'], 'the base changed a reviewed file');
  assert.equal(merge.diff!.reviewed, patchId(reviewedFiles()));
  assert.equal(merge.diff!.tip, merge.diff!.reviewed);

  const carry = decideCarry(input(merge));
  assert.equal(carry.approval.carried, true, carry.approval.reason);
  assert.deepEqual(carry.evidence.map(entry => [entry.proof, entry.carried]), [['unit:queue', true], ['manual:unscoped', true]], 'a proof scoped to the edited file, and one with no scope, both carry');
  // The record names the ground: 'diff unchanged' and the patch-id.
  const id = merge.diff!.reviewed!;
  assert.deepEqual(carry.ground, { rule: 'diff unchanged', patchId: id, tipPatchId: id });
  assert.equal(describeGround(carry.ground), `diff unchanged (patch-id ${id.slice(0, 12)})`);
  assert.match(carry.approval.reason, new RegExp(`diff unchanged \\(patch-id ${id.slice(0, 12)}\\)`));
  for (const entry of carry.evidence) assert.match(entry.reason, /diff unchanged \(patch-id [0-9a-f]{12}\)/);

  // The carried bindings apply to the tip; the combined tip's CI still has to pass before merge.
  const speculation: QueueSpeculation = { ref: queueRef('GY-7'), tip: TIP, base: P, baseTree: sha40('7e'), predecessors: [], policyRevision: 1, publishedAt: at, merge, carry, reviewedHead: H };
  const work = { key: 'GY-7', candidate: { sha: TIP, baseSha: P, pr: 7, branch: 'graphyard/gy-7-1', author: 'worker' }, policyRevision: 1, policy: { checks: ['test'], review: true },
    queue: { sequence: 1, enqueuedAt: at, policyRevision: 1, speculation } } as unknown as Work;
  assert.equal(currentCarry(work), carry);
  assert.equal(carriedApproval(work)?.originalSha, H);
  assert.equal(evidenceBindsCandidate(work, evidence('unit:queue', { scopeFiles: ['src/queue.ts'] })), true);
  assert.deepEqual(tipValidation(work, work.queue!, ['Required CI check test has not passed on the current candidate']),
    [`Merge queue is validating speculative tip ${TIP.slice(0, 12)}: Required CI check test has not passed on the current candidate`], 'the combined-tip CI still runs before merge');
  // Only the CI-pending refusal is the tip's validation (GY-332): any other test-gate refusal is the
  // candidate's own and is never relabelled as queue progress.
  const other = 'Required CI check test reported by an untrusted app';
  assert.equal(tipValidation(work, work.queue!, [other]), null, 'a refusal of another shape is not the tip validating');
  assert.deepEqual(tipValidation(work, work.queue!, [other, 'Required CI check test has not passed on the current candidate']),
    [`Merge queue is validating speculative tip ${TIP.slice(0, 12)}: Required CI check test has not passed on the current candidate`], 'only the CI-pending refusal is relabelled');

  // An unchanged diff decides on its own: the base's file list is not needed.
  assert.equal(decideCarry(input({ ...merge, baseChanges: null })).approval.carried, true);
});

test('unit:diff-bound-carry — the approval is re-required when the candidate\'s own diff changed, and nothing carries across a resolved conflict', async () => {
  // The merge changed the change itself: its hunk now reads differently on the tip.
  const { client } = github({ [`${B}...${H}`]: reviewedFiles(), [`${P}...${TIP}`]: tipFiles('entries.push(merged);'), [`${B}...${P}`]: [{ filename: 'src/queue.ts' }] });
  const merge: TipMerge = await (client as any).describeMerge(H, TIP, B, P);
  assert.notEqual(merge.diff!.tip, merge.diff!.reviewed);
  const changed = decideCarry(input(merge));
  assert.equal(changed.approval.carried, false);
  assert.match(changed.approval.reason, /changed reviewed files src\/queue\.ts; a fresh independent approval/);
  assert.match(changed.approval.reason, /the candidate's own diff changed \(patch-id [0-9a-f]{12} became [0-9a-f]{12}\)/);
  assert.equal(changed.ground!.rule, 'diff changed');
  assert.deepEqual(changed.evidence.map(entry => entry.carried), [false, false], 'the scoped proof overlaps the change; the unscoped one cannot be shown independent');
  assert.match(describeGround(changed.ground)!, /^diff changed/);

  // A resolved conflict is new content nobody reviewed: refused whatever the patch-ids say.
  const unchanged = { ...merge, diff: { reviewed: merge.diff!.reviewed, tip: merge.diff!.reviewed } };
  const conflicted = decideCarry(input({ ...unchanged, conflicts: true }));
  assert.deepEqual([conflicted.approval.carried, ...conflicted.evidence.map(entry => entry.carried)], [false, false, false]);
  assert.match(conflicted.approval.reason, /needed conflict resolution/);

  // Without a comparable diff — a side GitHub could not list completely — the files rule decides, as before.
  const unread = decideCarry(input({ ...merge, diff: { reviewed: merge.diff!.reviewed, tip: null } }));
  assert.equal(unread.approval.carried, false);
  assert.equal(unread.ground!.rule, 'files');
  const disjoint = decideCarry(input({ ...merge, diff: { reviewed: null, tip: null }, baseChanges: ['docs/queue.md'] }));
  assert.equal(disjoint.approval.carried, true, 'the files rule still carries an approval over a base that touched no reviewed file');
  // A decision recorded before the rule has no diff at all and is decided exactly as it was.
  const legacy = decideCarry(input({ ...merge, diff: undefined, baseChanges: ['docs/queue.md'] }));
  assert.equal(legacy.approval.carried, true);
  assert.match(legacy.approval.reason, /changed none of the 2 reviewed files/);
});
