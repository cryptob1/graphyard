import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CHECK_NAME, GitHub } from '../src/github.js';
import type { Observation, Work } from '../src/model.js';
import { predictQueue, queueRef, queueSequencingReason } from '../src/merge-queue.js';
import { mergeBaseDismissal, missingBaseAncestry } from '../src/merge-base-ancestry.js';
import { buildMasterStatus } from '../src/master.js';

// GY-145. Each test is named for the proof it produces: unit:tree-identical-base-still-refreshed
// and unit:merge-base-dismissal-reported.

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
// P: the base the tip was built on. M: the base branch tip now, tree-identical to P but not an
// ancestor of the tip (the predecessor landed as a new commit). TIP: the published queue tip.
const H = sha40('a1'), P = sha40('c1'), M = sha40('c2'), TIP = sha40('d1'), TREE = sha40('7e1'), MERGED = sha40('e1');
const at = '2026-09-23T10:00:00.000Z';
const PR = 116;
const reviewer = 'graphyard-reviewer[bot]';

function queued(observation: Partial<Observation> = {}): Work {
  const candidate = { sha: TIP, baseSha: P, pr: PR, branch: 'graphyard/gy-100-1', author: 'implementer' };
  return { id: 'work-100', key: 'GY-100', title: 'Queued head', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'merge', revision: 9, policyRevision: 4, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [], candidate, submission: { epoch: 1, pr: PR }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    gates: [{ name: 'ready', passed: true, reasons: [] }], queueSequence: 1,
    queue: { sequence: 1, enqueuedAt: at, policyRevision: 4, speculation: { ref: queueRef('GY-100'), tip: TIP, tipTree: sha40('7d1'), base: P, baseTree: TREE, predecessors: [], policyRevision: 4, publishedAt: at, reviewedHead: H } },
    observation: { candidate: { ...candidate }, checks: [], reviews: [{ id: 31, reviewer, sha: TIP, state: 'APPROVED', submittedAt: at }], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/x.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: M, baseTree: TREE, baseTipContained: true, baseTipAncestor: false, ...observation },
  } as Work;
}

/** The real GitHub adapter over a stubbed request surface; `ancestor` is whether TIP contains M. */
function provider(ancestor: boolean) {
  const writes: string[] = [];
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.controlPlaneLogin = async () => 'graphyard-owner-project[bot]';
  github.request = async (path, method = 'GET') => {
    if (method !== 'GET') writes.push(`${method} ${path}`);
    if (path === '/merges' && method === 'POST') return { sha: MERGED };
    if (method !== 'GET') return { id: 1 };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: M } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) {
      const sha = path.slice(9);
      return { sha, commit: { tree: { sha: sha === M || sha === P ? TREE : sha40(`7${sha.slice(0, 3)}`) }, message: 'x', author: { email: 'noreply@github.com' } }, parents: [{ sha: H }, { sha: M }], author: null };
    }
    if (path.startsWith('/compare/')) {
      const [from, to] = path.slice(9).split('?')[0].split('...');
      return { status: from === to ? 'identical' : from === M && to === TIP && ancestor ? 'ahead' : 'diverged', files: [] };
    }
    if (path === `/pulls/${PR}`) return { number: PR, head: { sha: TIP, ref: 'graphyard/gy-100-1', repo: { full_name: 'owner/project' } },
      base: { sha: P, ref: 'main', repo: { full_name: 'owner/project' } }, user: { login: 'implementer' }, merged: false, mergeable: true, draft: false, state: 'open', merge_commit_sha: null };
    if (path.includes('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] } };
    throw new Error(`Unexpected request ${path}`);
  };
  return { github, writes };
}

test('unit:tree-identical-base-still-refreshed — a queue head bound to a base tree-identical to, but not an ancestor of, the base branch tip is republished onto that tip and its merge is refused until then', async () => {
  const now = Date.parse(at);
  // The head does not contain M: the tip is not carried, it is published onto M.
  const item = queued();
  const [placement] = predictQueue([item], now);
  assert.deepEqual([placement.current, placement.binding, placement.publishable, placement.tip, placement.predictedBase], [false, null, true, null, M]);
  assert.match(placement.reasons[0], new RegExp(`does not contain base branch tip ${M.slice(0, 12)} by ancestry`));
  assert.ok(queueSequencingReason(placement.reasons[0]), 'the control plane republishes it itself: nobody is asked for a round');
  assert.deepEqual(missingBaseAncestry(item), { head: TIP, baseTip: M, boundBase: P });
  // The publisher merges M into the reviewed head, a merge commit, instead of recording a carry.
  const refresh = provider(false);
  const speculation = await refresh.github.publishSpeculativeTip(item, placement);
  assert.deepEqual([speculation.tip, speculation.base, speculation.baseTree, speculation.carriedBase ?? null], [MERGED, M, TREE, null]);
  // The branch goes back to the reviewed head, M is merged onto it, and the tip is published.
  assert.deepEqual(refresh.writes, ['PATCH /git/refs/heads/graphyard/gy-100-1', 'POST /merges', `PATCH /git/${queueRef('GY-100')}`]);
  assert.deepEqual(speculation.merge?.parents, [H, M], 'the new tip has the base tip commit itself as a parent');
  // The merge broker refuses the head, before any approval is re-posted, naming the missing ancestry.
  const master = await readFile(new URL('../src/master.ts', import.meta.url), 'utf8');
  assert.match(master, /const unancestored = missingBaseAncestry\(current\);\n\s*if \(unancestored\) throw new Error\(`\$\{work\.key\} merge refused: \$\{missingAncestryReason\(unancestored\)\}`\);\n[^]*?const carried = carriedApproval\(current\);\n\s*const reposted = carried && repost/);
  // A base tip that IS an ancestor of the head keeps the carry: nothing is republished.
  const ancestor = queued({ baseTipAncestor: true });
  const [kept] = predictQueue([ancestor], now);
  assert.deepEqual([kept.current, kept.binding, kept.publishable], [true, 'tree-equivalent', false]);
  assert.equal(missingBaseAncestry(ancestor), null);
  const carry = provider(true);
  const carried = await carry.github.publishSpeculativeTip(ancestor, { ...kept, publishable: true }, async () => { throw new Error('nothing may be written'); });
  assert.deepEqual([carried.tip, carried.base, carried.carriedBase?.sha], [TIP, P, M]);
  assert.deepEqual(carry.writes, []);
  // An observation from before GY-145 carries no ancestry answer and is judged as it was.
  assert.equal(predictQueue([queued({ baseTipAncestor: undefined })], now)[0].current, true);
});

test('unit:merge-base-dismissal-reported — an approval GitHub dismissed for a merge-base change is an attention item naming the dismissal time and the commits', () => {
  const dismissedAt = '2026-09-23T10:05:00.000Z';
  const item = queued({ reviews: [{ id: 31, reviewer, sha: TIP, state: 'DISMISSED', submittedAt: at,
    dismissal: { reason: 'The merge-base changed after approval.', mergeBase: true, verdict: 'approved', commit: M, at: dismissedAt, by: null } } as Observation['reviews'][number]] });
  const dismissal = mergeBaseDismissal(item);
  assert.deepEqual(dismissal && [dismissal.reviewer, dismissal.reviewId, dismissal.sha, dismissal.at, dismissal.commit, dismissal.baseTip, dismissal.boundBase], [reviewer, 31, TIP, dismissedAt, M, M, P]);
  const status = buildMasterStatus({ work: [item], now: dismissedAt }, [], []);
  const entry = status.attentionItems.find(line => line.subject === 'GY-100');
  assert.ok(entry, 'the dismissal is an attention item against the item');
  assert.match(entry.text, new RegExp(`^GY-100: GitHub dismissed ${reviewer.replace(/[[\]]/g, '\\$&')}'s approval of ${TIP.slice(0, 12)} \\(review #31\\) at ${dismissedAt} for a merge-base change attributed to commit ${M.slice(0, 12)}; bound base ${P.slice(0, 12)}, base branch tip ${M.slice(0, 12)}\\.`));
  assert.match(entry.text, /does not contain base branch tip .* by ancestry/);
  assert.match(entry.text, /the approval is not re-posted before a merge attempt meanwhile$/);
  assert.equal(entry.role, 'master');
  assert.equal(status.work.find(row => row.key === 'GY-100')!.attention, entry.text);
  // A change request someone dismissed, or a dismissal with a person's reason, is not reported as one.
  const withdrawn = queued({ reviews: [{ id: 32, reviewer, sha: TIP, state: 'DISMISSED', submittedAt: at, dismissal: { reason: 'merge base moved, will re-review', mergeBase: false, verdict: 'approved', commit: null, at: dismissedAt, by: 'someone' } } as Observation['reviews'][number]] });
  assert.equal(mergeBaseDismissal(withdrawn), null);
  // A head that contains the base tip says the approval is restored and re-posted.
  const contained = queued({ baseTipAncestor: true, reviews: item.observation!.reviews });
  assert.match(mergeBaseDismissal(contained) ? buildMasterStatus({ work: [contained], now: dismissedAt }, [], []).attentionItems.find(line => line.subject === 'GY-100')!.text : '', /The head contains .* so the approval is restored and re-posted/);
});
