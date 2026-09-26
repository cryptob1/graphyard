import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GitHub } from '../src/github.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';
import type { BaseRefresh } from '../src/merge-queue.js';
import { conflictRoute, docsOnlyConflict, docsSyncAdoption, docsSyncCarry, overlappingPaths } from '../src/model/docs-sync.js';
import { conflictHotspots, hotspotAttentionText, ledgerConflicts, type ConflictOccurrence } from '../src/model/conflict-hotspots.js';
import { docsSyncPrompt, docsSyncSessionName, type DocsSyncPlan } from '../src/docs-sync.js';
import { sessionNameRefusal } from '../src/session-name.js';

/**
 * GY-566. On 2026-09-26 thirteen queued items went back to a full worker rework in thirty minutes,
 * almost all for conflicts in the same few docs pages. A conflict confined to docs pages now goes
 * to a short docs-sync session and keeps its approval when the change outside docs/ is unchanged;
 * master status and Insights name the paths that keep conflicting.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;
const reviewed = 'a'.repeat(40), bound = 'b'.repeat(40), tip = 'c'.repeat(40), synced = 'd'.repeat(40);

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}

/** A submitted, approved item whose base refresh confirmed a conflict with base tip `tip` on `paths`. */
function conflicted(paths: string[] | null, observedAt = iso(-30_000)): Work {
  const candidate = { sha: reviewed, baseSha: bound, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, baseTip: tip, baseTipContained: false, conflicting: true,
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'independent-reviewer', sha: reviewed, state: 'APPROVED', submittedAt: iso(-60 * minute) }],
    protected: true, mergeable: false, merged: false, mergeSha: null, files: ['src/loop.ts', 'docs/master-agent.md'], scopeFiles: [], at: observedAt, prState: 'open', draft: false,
  } as unknown as Observation;
  const baseRefresh: BaseRefresh = { from: { sha: reviewed, baseSha: bound }, base: tip, baseTree: 'e'.repeat(40), policyRevision: 1, at: iso(-minute), head: null,
    conflict: `Candidate ${reviewed.slice(0, 12)} cannot be brought onto base branch tip ${tip.slice(0, 12)} without resolving a conflict`, merge: null, carry: null, trigger: 'conflict confirmed', conflictPaths: paths };
  return {
    id: 'work-42', key: 'GY-42', title: 'A change that documents itself', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts', 'docs/master-agent.md'], stage: 'merge', revision: 5, policyRevision: 1, createdAt: iso(-4 * 60 * minute), updatedAt: iso(0),
    stageEnteredAt: iso(-30 * minute), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, baseRefresh, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'merge', passed: false, reasons: ['Pull request is not mergeable against the current base'] }],
  } as Work;
}

function loop(work: () => Work, record: { decided: string[]; synced: DocsSyncPlan[]; agents: string[] }, local?: string[] | null): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: record.agents.map((name, index) => ({ name, pane_id: `pane-${index}`, agent_status: 'working' })), available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work: [work()], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work, action) => { record.decided.push(action); return { id: '5d8a8b9e-0000-4000-8000-000000000001' }; },
    decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'graphyard-approver-gy-42', pane: 'pane-a' }),
    docsSync: async (_item, plan) => { record.synced.push(plan); record.agents.push(`graphyard-docs-sync-gy-42-${plan.head.slice(0, 7)}`); return { agentName: record.agents.at(-1)!, pane: 'pane-s', account: 'reviewer-a', runtime: 'claude', session: null }; },
    ...(local === undefined ? {} : { conflictPaths: async () => local }),
    persist: async () => {},
  };
}

test('unit:docs-only-conflict-synced — a docs-only conflict leads to a docs-sync session and no rework decision; a conflict touching src/ still goes to rework; the approval is kept when the non-docs patch is unchanged', async () => {
  // The routing rule: docs/**/*.md only, and a known, non-empty set.
  assert.equal(docsOnlyConflict(['docs/master-agent.md', 'docs/guides/onboarding.md']), true);
  assert.equal(docsOnlyConflict(['docs/master-agent.md', 'src/cli/master-status.ts']), false);
  assert.equal(docsOnlyConflict(['README.md']), false, 'only pages under docs/ are the docs-sync\'s');
  assert.equal(docsOnlyConflict([]), false); assert.equal(docsOnlyConflict(null), false);
  assert.equal(conflictRoute(['docs/onboarding.md', 'src/cli/master-status.ts']).route, 'rework');
  assert.match(conflictRoute(['docs/onboarding.md', 'src/cli/master-status.ts']).reason, /src\/cli\/master-status\.ts/);
  assert.deepEqual(overlappingPaths(['docs/a.md', 'src/x.ts', 'docs/b.md'], ['docs/b.md', 'docs/a.md', 'src/y.ts']), ['docs/a.md', 'docs/b.md']);
  assert.equal(overlappingPaths(null, ['docs/a.md']), null, 'an unlisted side is unknown, never clean');

  // 1. A docs-only conflict: the loop launches one docs-sync session and requests no rework.
  const docs = { decided: [] as string[], synced: [] as DocsSyncPlan[], agents: [] as string[] };
  let item = conflicted(['docs/master-agent.md', 'docs/onboarding.md']);
  const state = emptyDaemonState(config());
  const first = await runCycle(config(), state, loop(() => item, docs), () => clock);
  assert.deepEqual(docs.decided, [], 'no rework decision is requested for a docs-only conflict');
  assert.equal(docs.synced.length, 1, 'one docs-sync session is launched');
  assert.deepEqual(docs.synced[0], { key: 'GY-42', pr: 42, branch: 'graphyard/gy-42-1', baseBranch: 'main', head: reviewed, base: tip, paths: ['docs/master-agent.md', 'docs/onboarding.md'] });
  assert.ok(first.actions.some(action => action.work === 'GY-42' && /^Launched docs-sync session .* no rework decision is requested/.test(action.detail)), 'the cycle reports the launch');
  assert.ok(first.actions.some(action => action.work === 'GY-42' && /both sides changed only docs pages/.test(action.detail)), 'the refresh report names the docs-sync route, not a worker');
  assert.deepEqual(state.conflicts.map(entry => [entry.work, entry.route, entry.paths]), [['GY-42', 'docs-sync', ['docs/master-agent.md', 'docs/onboarding.md']]]);
  // The session's instruction is narrow: merge the base, keep both meanings, stay in budget, touch only the conflicted paragraphs, rerun the checks.
  const prompt = docsSyncPrompt(config(), docs.synced[0], '/repo');
  for (const phrase of [`git merge --no-ff ${tip}`, 'both sides\' meaning', 'word budget', 'Touch only the conflicted paragraphs', 'tests/docs-budget.test.ts tests/docs-obligation.test.ts', 'never forced', 'Do not run graphyard complete'])
    assert.ok(prompt.includes(phrase), `the prompt says: ${phrase}`);

  assert.equal(sessionNameRefusal(docsSyncSessionName({ key: 'GY-1234', head: reviewed })), null, 'the session name is one every runtime accepts');
  // While the session runs, nothing more happens; a second cycle neither relaunches nor reworks.
  await runCycle(config(), state, loop(() => item, docs), () => clock);
  assert.deepEqual(docs.decided, []); assert.equal(docs.synced.length, 1);

  // The session ends without moving the head: once an observation taken after that still shows
  // the reviewed head, the conflict goes back to a worker as before.
  docs.agents.length = 0;
  await runCycle(config(), state, loop(() => item, docs), () => clock);
  assert.deepEqual(docs.decided, [], 'a push not yet observed is waited for');
  item = conflicted(['docs/master-agent.md', 'docs/onboarding.md'], iso(1_000));
  await runCycle(config(), state, loop(() => item, docs), () => clock + 2_000);
  assert.deepEqual(docs.decided, ['rework'], 'a docs-sync that gave up is followed by rework');
  assert.equal(state.conflicts[0].route, 'rework', 'and the conflict is counted as sent back');

  // 2. A conflict touching src/ goes to rework, and no docs-sync is launched — the loop's own
  // merge of the head and the base decides over the paths both sides changed.
  const code = { decided: [] as string[], synced: [] as DocsSyncPlan[], agents: [] as string[] };
  const mixed = conflicted(['docs/onboarding.md']);
  await runCycle(config(), emptyDaemonState(config()), loop(() => mixed, code, ['docs/onboarding.md', 'src/cli/master-status.ts']), () => clock);
  assert.deepEqual(code.decided, ['rework']); assert.deepEqual(code.synced, []);
  const unknown = { decided: [] as string[], synced: [] as DocsSyncPlan[], agents: [] as string[] };
  await runCycle(config(), emptyDaemonState(config()), loop(() => conflicted(null), unknown), () => clock);
  assert.deepEqual(unknown.decided, ['rework'], 'unknown conflicted paths go to a worker'); assert.deepEqual(unknown.synced, []);

  // 3. The synced head is recorded as the refresh's outcome, and the approval is kept only when
  // the diff outside docs/ has the same patch-id on both sides.
  const approved = conflicted(['docs/master-agent.md']);
  const observed = { candidate: { sha: synced, baseSha: tip, pr: 42 }, merged: false, prState: 'open' };
  const adoption = docsSyncAdoption(approved, observed)!;
  assert.deepEqual(adoption, { from: { sha: reviewed, baseSha: bound }, base: tip, head: synced, to: { sha: synced, baseSha: tip }, paths: ['docs/master-agent.md'] });
  assert.equal(docsSyncAdoption({ ...approved, reworkRequested: true }, observed), null, 'a worker\'s own sync after a rework is a new submission');
  assert.equal(docsSyncAdoption(approved, { ...observed, candidate: { ...observed.candidate, sha: reviewed } }), null, 'the reviewed head itself is no docs-sync');

  // GitHub describes the merge and both diffs; the docs hunk differs, the code hunk does not.
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'unused' });
  const code1 = { filename: 'src/loop.ts', status: 'modified', changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' };
  const compare: Record<string, any[]> = {
    [`${bound}...${reviewed}`]: [code1, { filename: 'docs/master-agent.md', status: 'modified', changes: 1, patch: '@@ -3 +3 @@\n-a\n+item text' }],
    [`${tip}...${synced}`]: [code1, { filename: 'docs/master-agent.md', status: 'modified', changes: 2, patch: '@@ -7 +7 @@\n-b\n+base text and item text' }],
    [`${bound}...${tip}`]: [{ filename: 'docs/master-agent.md', status: 'modified', changes: 1, patch: '@@ -3 +3 @@\n-a\n+base text' }],
  };
  (github as any).controlPlaneLogin = async () => 'graphyard-app[bot]';
  (github as any).request = async (path: string) => {
    if (path === `/commits/${synced}`) return { parents: [{ sha: reviewed }, { sha: tip }], author: { login: 'docs-sync-account' }, commit: { author: { email: 'sync@example.com' } } };
    if (path === `/commits/${tip}`) return { commit: { tree: { sha: 'f'.repeat(40) } } };
    const range = path.replace(/^\/compare\//, '');
    if (compare[range]) return { status: 'ahead', files: compare[range] };
    throw new Error(`unexpected request ${path}`);
  };
  const refresh = await github.docsSyncRefresh(approved, adoption);
  assert.equal(refresh.head, synced); assert.equal(refresh.trigger, 'docs sync'); assert.equal(refresh.conflict, null);
  assert.ok(refresh.docsSync!.reviewed && refresh.docsSync!.reviewed === refresh.docsSync!.synced, 'the diff outside docs/ has one patch-id on both sides');
  const approval = { provider: 'github' as const, reviewer: 'independent-reviewer', sha: reviewed };
  const carry = (docsSync = refresh.docsSync!, merge = refresh.merge!) => docsSyncCarry({ from: refresh.from, base: tip, at: iso(0), policyRevision: 1, merge, docsSync, reviewedFiles: ['src/loop.ts'], approval, proofs: [{ proof: 'unit:loop', evidence: undefined }] });
  const kept = carry();
  assert.equal(kept.approval.carried, true, 'the approval is kept on the docs-sync head');
  assert.match(kept.approval.reason, /diff outside docs\/ is unchanged/);
  assert.deepEqual(kept.to, { sha: synced, baseSha: tip });
  assert.equal(kept.evidence[0].carried, false, 'the proofs run again on the synced head');

  // The docs-sync also touched code: the approval is required again (still no rework round).
  compare[`${tip}...${synced}`] = [{ ...code1, patch: '@@ -1 +1 @@\n-old\n+newer' }];
  const touched = await github.docsSyncRefresh(approved, adoption);
  assert.notEqual(touched.docsSync!.reviewed, touched.docsSync!.synced);
  const required = carry(touched.docsSync!, touched.merge!);
  assert.equal(required.approval.carried, false);
  assert.match(required.approval.reason, /changed the diff outside docs\//);
  // A head that is not exactly the reviewed head merged with the conflicting tip carries nothing.
  assert.equal(carry(refresh.docsSync!, { ...refresh.merge!, parents: [reviewed, 'f'.repeat(40)] }).approval.carried, false);
});

test('unit:conflict-hotspots-reported — master status and Insights report the paths most often conflicting in the last 24 hours with counts and the items they sent back, and raise attention at 5 conflicts on one path', () => {
  const at = (hoursAgo: number) => iso(-hoursAgo * 3_600_000);
  const occurrences: ConflictOccurrence[] = [
    { work: 'GY-268', at: at(1), paths: ['docs/master-agent.md', 'docs/onboarding.md'], route: 'rework' },
    { work: 'GY-303', at: at(2), paths: ['docs/master-agent.md'], route: 'docs-sync' },
    { work: 'GY-316', at: at(3), paths: ['docs/master-agent.md', 'src/cli/master-status.ts'], route: 'rework' },
    { work: 'GY-401', at: at(5), paths: ['docs/master-agent.md'], route: 'docs-sync' },
    { work: 'GY-404', at: at(8), paths: ['docs/master-agent.md', 'docs/master-agent.md'], route: 'docs-sync' },
    { work: 'GY-417', at: at(9), paths: ['docs/onboarding.md'], route: 'docs-sync' },
    // Older than the window: not counted.
    { work: 'GY-100', at: at(30), paths: ['docs/master-agent.md'], route: 'rework' },
  ];
  const report = conflictHotspots(occurrences, clock);
  assert.equal(report.windowHours, 24); assert.equal(report.threshold, 5);
  assert.equal(report.conflicts, 6); assert.equal(report.sentBack, 2); assert.equal(report.docsSynced, 4);
  assert.deepEqual(report.hotspots[0], { path: 'docs/master-agent.md', conflicts: 5, items: ['GY-268', 'GY-303', 'GY-316', 'GY-401', 'GY-404'], sentBack: ['GY-268', 'GY-316'] });
  assert.deepEqual(report.hotspots.slice(1).map(entry => [entry.path, entry.conflicts]), [['docs/onboarding.md', 2], ['src/cli/master-status.ts', 1]]);
  assert.deepEqual(report.attention.map(entry => entry.path), ['docs/master-agent.md'], 'one path causing 5 conflicts in 24 hours is raised');
  const text = hotspotAttentionText(report.attention[0], report.windowHours);
  assert.match(text, /docs\/master-agent\.md caused 5 merge conflicts in the last 24 hours/);
  assert.match(text, /GY-268, GY-303, GY-316, GY-401, GY-404; 2 sent back to a worker/);
  assert.equal(conflictHotspots(occurrences.slice(1), clock).attention.length, 0, 'four is below the threshold');

  // Insights reads the same from the ledger: each confirmed conflict with its recorded paths,
  // docs-synced when a docs-sync refresh adopted a head for the same reviewed head.
  const rows = [
    { key: 'GY-268', kind: 'base.conflict', at: at(1), details: { from: { sha: 'h1' }, conflictPaths: ['docs/master-agent.md'] } },
    { key: 'GY-303', kind: 'base.conflict', at: at(2), details: { from: { sha: 'h2' }, conflictPaths: ['docs/master-agent.md'] } },
    { key: 'GY-303', kind: 'base.refreshed', at: at(1.5), details: { from: { sha: 'h2' }, trigger: 'docs sync' } },
    { key: 'GY-316', kind: 'base.conflict', at: at(3), details: { from: { sha: 'h3' }, conflict: 'recorded before GY-566' } },
  ];
  assert.deepEqual(ledgerConflicts(rows), [
    { work: 'GY-268', at: at(1), paths: ['docs/master-agent.md'], route: 'rework' },
    { work: 'GY-303', at: at(2), paths: ['docs/master-agent.md'], route: 'docs-sync' },
  ]);
  assert.deepEqual(conflictHotspots(ledgerConflicts(rows), clock).hotspots, [{ path: 'docs/master-agent.md', conflicts: 2, items: ['GY-268', 'GY-303'], sentBack: ['GY-268'] }]);
});
