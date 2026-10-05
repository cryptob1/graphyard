import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState, reconcilePendingActions, storeAction } from '../src/master-daemon.js';
import { trackFaults } from '../src/model/fault-classes.js';
import { conflictSince, type BaseRefresh } from '../src/merge-queue.js';
import { staleRefreshRecord } from '../src/engine.js';

// GY-1087 names this file for its proof: manual:fault-class-merge. The master loop filed 4 merge
// faults in 24 hours on 1 October 2026. They shared one cause: a merge-path step the control plane
// had made itself was then read back as a fault.
//
//   - merge-refused (GY-1063): publishing a speculative tip pushed the pull request's branch twice,
//     once to reset it to the reviewed head and once for the merge onto it. GitHub raised a
//     pull_request event for each push, and both resolved to the tip. CI's per-PR concurrency
//     cancelled one of the two runs. The cancelled one was the later-created run (36876948155, no
//     jobs), so GitHub read the head's three required CI checks as expected. Auto-merge sat BLOCKED
//     for seven hours, and the merge-now probe was refused: "3 of 4 required status checks are expected".
//   - contaminated (GY-417, GY-971): each was counted seconds after its own ejection, while the
//     restore the ejection owes, which the reconciliation job runs on its own, had not run yet.
//   - action:merge (GY-999): a restart interrupted the guarded merge request. Resuming it is a
//     retry, and it merged on that retry twelve minutes later.
//
// Each instance is replayed below from the ledger and GitHub as they stood when the loop recorded
// it, and asserted not to recur. The file imports nothing the base lacks, so against the base each
// subtest loads and fails on its own assertion: the instance reproduces. GY-1236 removed the
// speculative tips, ejections and branch restores the merge-refused and contaminated instances
// came from, so only the action:merge instance is replayed now.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const instances = [
  { id: 'action:merge|GY-999|2026-10-01T11:28:27.729Z', kind: 'action:merge', subject: 'GY-999', at: '2026-10-01T11:28:27.729Z' },
  { id: 'contaminated|GY-417|2026-10-01T13:39:08.701Z', kind: 'contaminated', subject: 'GY-417', at: '2026-10-01T13:39:08.701Z' },
  { id: 'merge-refused|GY-1063|2026-10-01T16:57:44.689Z', kind: 'merge-refused', subject: 'GY-1063', at: '2026-10-01T16:57:44.689Z' },
  { id: 'contaminated|GY-971|2026-10-01T22:16:21.164Z', kind: 'contaminated', subject: 'GY-971', at: '2026-10-01T22:16:21.164Z' },
] as const;

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'cryptob1/graphyard', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master', autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(key: string, at: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: key, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], stage: 'build', revision: 1, policyRevision: 2,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}

test('manual:fault-class-merge — the item lists 4 instances; the one whose machinery remains is replayed below', () => {
  assert.equal(new Set(instances.map(instance => instance.id)).size, 4);
  assert.deepEqual([...new Set(instances.map(instance => instance.kind))].sort(), ['action:merge', 'contaminated', 'merge-refused']);
});

// ---- action:merge: a guarded merge a restart interrupted ------------------------------------------

test(`manual:fault-class-merge — ${instances[0].id}: a merge request a restart interrupted is retried, not counted as a merge fault`, () => {
  const now = Date.parse(instances[0].at);
  const state = emptyDaemonState(config());
  const head = '0a8649094eb12adcfb40fecc0b5c7f6ad5b7b449', key = `merge:work-GY-999:${head}:8f0e21d734c4652cf2b2b2b15af3832873bf5cbf:1`;
  storeAction(state, key, { kind: 'merge', work: 'GY-999', principal: null, state: 'started', detail: 'Requesting the guarded merge of GY-999', attempts: 1, epoch: 1, cycle: 0, at: new Date(now - 60_000).toISOString() });
  const unmerged = item('GY-999', instances[0].at, { stage: 'merge', candidate: { sha: head, baseSha: '8f0e21d734c4652cf2b2b2b15af3832873bf5cbf', pr: 530, branch: 'graphyard/gy-999-1' } as Work['candidate'] });
  const [resumed] = reconcilePendingActions(state, [unmerged], now);
  assert.equal(resumed.detail, 'Resumed: no merge was observed; the guarded merge may be attempted again');
  assert.equal(resumed.state, 'failed', 'the merge is still owed, so the loop asks again');
  assert.equal(resumed.faultClass ?? null, null, 'the retry carries no fault class');
  trackFaults(state.faults, [], new Date(now).toISOString());
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'action:merge'), [], 'no merge fault instance is recorded');
  // Not weakened: a merge request that itself fails is still a merge fault.
  storeAction(state, 'merge:refused', { kind: 'merge', work: 'GY-999', principal: null, state: 'failed', detail: 'GitHub refused the guarded merge', attempts: 1, epoch: 1, cycle: 1, at: new Date(now).toISOString() });
  assert.equal(state.faults.instances.filter(entry => entry.kind === 'action:merge').length, 1);
});

// ---- base-conflict: a base refresh conflict under 30 minutes is self-handled, rework or not (GY-1129) ----

const gy1129Instances = [
  { id: 'base-conflict|GY-501|2026-10-03T01:48:21.031Z', kind: 'base-conflict', subject: 'GY-501', at: '2026-10-03T01:48:21.031Z',
    head: 'bfe5c971a12513ea32dbf6828557343e7c8449c2', base: '1f8c8d17a255304a991873ea2f64fa4c5ea2c2bf',
    conflict: 'Candidate bfe5c971a125 cannot be brought onto base branch tip 1f8c8d17a255 without resolving a conflict, which is content nobody reviewed or proved: Speculative merge of 1f8c8d17a255 into graphyard-merge-check/gy-501 conflicts and cannot be resolved by Graphyard. Run graphyard sync GY-501, resolve it and push; the approval and proofs bound to bfe5c971a125 do not survive the resolution.',
    stage: 'merge', reworkRequested: true },
  { id: 'base-conflict|GY-1073|2026-10-03T02:08:38.001Z', kind: 'base-conflict', subject: 'GY-1073', at: '2026-10-03T02:08:38.001Z',
    head: 'cf391b944d4fd37ab8706fa2bbcfba4bbd698e4f', base: 'e7ab679fb2ebaa0d087b32873afda18e8d8ee5ff',
    conflict: 'Candidate cf391b944d4f cannot be brought onto base branch tip e7ab679fb2eb without resolving a conflict, which is content nobody reviewed or proved: Speculative merge of e7ab679fb2eb into graphyard-merge-check/gy-1073 conflicts and cannot be resolved by Graphyard. Run graphyard sync GY-1073, resolve it and push; the approval and proofs bound to cf391b944d4f do not survive the resolution.',
    stage: 'build', reworkRequested: false },
  { id: 'base-conflict|GY-417|2026-10-03T02:14:59.107Z', kind: 'base-conflict', subject: 'GY-417', at: '2026-10-03T02:14:59.107Z',
    head: '938b292d6ea58324dbec487c44f4089d0063ebee', base: 'e7ab679fb2ebaa0d087b32873afda18e8d8ee5ff',
    conflict: 'Candidate 938b292d6ea5 cannot be brought onto base branch tip e7ab679fb2eb without resolving a conflict, which is content nobody reviewed or proved: Speculative merge of e7ab679fb2eb into graphyard-merge-check/gy-417 conflicts and cannot be resolved by Graphyard. Run graphyard sync GY-417, resolve it and push; the approval and proofs bound to 938b292d6ea5 do not survive the resolution.',
    stage: 'merge', reworkRequested: false },
] as const;

for (const entry of gy1129Instances) {
  test(`manual:fault-class-merge — ${entry.id}: a base conflict in rework or under 30 minutes is self-handled, not a merge fault`, () => {
    const key = entry.subject, now = Date.parse(entry.at), branch = `graphyard/${key.toLowerCase()}-1`;
    const conflicting = (at: string, reworkRequested = entry.reworkRequested, stage = entry.stage) => item(key, at, {
      stage: stage as Work['stage'],
      reworkRequested,
      candidate: { sha: entry.head, baseSha: entry.base, pr: 500, branch } as Work['candidate'],
      submission: { epoch: 1, pr: 500 } as Work['submission'],
      observation: { candidate: { sha: entry.head, baseSha: entry.base, pr: 500, branch }, merged: false, prState: 'open', checks: [], reviews: [], files: [], scopeFiles: [], at, baseTip: entry.base } as unknown as Work['observation'],
      baseRefresh: { from: { sha: entry.head, baseSha: entry.base }, base: entry.base, baseTree: '', policyRevision: 2, at, head: null, conflict: entry.conflict, merge: null, carry: null } as Work['baseRefresh'],
    });
    const faults = (work: Work, testNow = now) => cycleFaults(emptyDaemonState(config()), [work], testNow, { config: config() }).filter(fault => fault.subject === key && fault.kind === 'base-conflict');
    assert.deepEqual(faults(conflicting(entry.at)), [], `at recorded time (${entry.at}), the base conflict is in rework or motion and not counted as a merge fault`);
    // Not weakened: the same conflict unhandled after two hours with no rework requested is a merge fault.
    assert.equal(faults(conflicting(new Date(now - 2 * 3_600_000).toISOString(), false, 'merge'), now).length, 1, 'a base conflict unhandled for two hours still counts as a merge fault');
    assert.equal(faults(conflicting(new Date(now - 2 * 3_600_000).toISOString(), false, 'build'), now).length, 1, 'returned to build with no rework decided for two hours, it still counts as a merge fault');
    assert.equal(faults(conflicting(new Date(now - 2 * 3_600_000).toISOString(), true, 'merge'), now).length, 1, 'a base conflict with rework requested unhandled for two hours still counts as a merge fault');
    assert.equal(faults(conflicting(new Date(now - 2 * 3_600_000).toISOString(), true, 'build'), now).length, 1, 'returned to build with rework requested but unhandled for two hours still counts as a merge fault');
  });
}

// ---- base-conflict: the bound runs from the first conflict on the head (GY-1200) ---------------------

// Review follow-up of GY-1129: each refresh onto a new base tip re-records the conflict with a fresh
// `at`, so on a base moving more often than 30 minutes a conflict nobody handles never aged past the
// bound. The bound now runs from `conflictSince`, the first conflict recorded on the same head.
test('manual:fault-class-merge — a conflict re-recorded on each new base tip still counts once its first conflict on the head is past the bound', () => {
  const key = 'GY-1200', head = 'a'.repeat(40), branch = 'graphyard/gy-1200-1', now = Date.parse('2026-10-04T12:00:00.000Z');
  const tips = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40), '4'.repeat(40), '5'.repeat(40)];
  const conflict = `Candidate ${head.slice(0, 12)} cannot be brought onto base branch tip without resolving a conflict.`;
  // The loop's refreshes, one per base tip, every 20 minutes over 80 minutes, each conflicting; the engine carries conflictSince.
  let record: Work['baseRefresh'] = null;
  for (const [index, base] of tips.entries()) {
    const refresh = { from: { sha: head, baseSha: tips[0] }, base, baseTree: '', policyRevision: 2, at: new Date(now - (tips.length - 1 - index) * 20 * 60_000).toISOString(), head: null, conflict, merge: null, carry: null };
    record = { ...refresh, conflictSince: conflictSince(record, refresh) } as Work['baseRefresh'];
  }
  assert.equal(record!.at, new Date(now).toISOString(), 'the latest refresh is fresh');
  assert.equal(record!.conflictSince, new Date(now - 80 * 60_000).toISOString(), 'the first conflict on the head is kept across refreshes');
  const work = (refresh: Work['baseRefresh'], reworkRequested = false) => item(key, refresh!.at, {
    stage: 'merge', reworkRequested,
    candidate: { sha: head, baseSha: tips[0], pr: 700, branch } as Work['candidate'],
    submission: { epoch: 1, pr: 700 } as Work['submission'],
    observation: { candidate: { sha: head, baseSha: tips[0], pr: 700, branch }, merged: false, prState: 'open', checks: [], reviews: [], files: [], scopeFiles: [], at: refresh!.at, baseTip: refresh!.base } as unknown as Work['observation'],
    baseRefresh: refresh,
  });
  const faults = (subject: Work) => cycleFaults(emptyDaemonState(config()), [subject], now, { config: config() }).filter(fault => fault.subject === key && fault.kind === 'base-conflict');
  assert.equal(faults(work(record)).length, 1, 'an unhandled conflict re-recorded every 20 minutes counts once its first conflict is 80 minutes old');
  assert.equal(faults(work(record, true)).length, 1, 'requesting rework does not exempt it');
  // Not weakened the other way: a conflict first found 10 minutes ago, re-recorded once since, is still in motion.
  const recent = { ...record!, conflictSince: new Date(now - 10 * 60_000).toISOString() } as Work['baseRefresh'];
  assert.deepEqual(faults(work(recent)), [], 'a conflict first found within the bound is self-handled');
  // A record that predates conflictSince reads its own time, as before.
  const legacy = { ...record!, conflictSince: undefined } as Work['baseRefresh'];
  assert.deepEqual(faults(work(legacy)), [], 'a record without conflictSince is bounded by its own time');
});

test('conflictSince — carried only across conflicts on the same head and policy revision', () => {
  const head = 'b'.repeat(40), at = '2026-10-04T11:00:00.000Z', later = '2026-10-04T11:40:00.000Z';
  const previous = { from: { sha: head, baseSha: 'c'.repeat(40) }, policyRevision: 2, at, conflict: 'conflicts', conflictSince: null };
  const refresh = { from: { sha: head, baseSha: 'c'.repeat(40) }, policyRevision: 2, at: later, conflict: 'conflicts' };
  assert.equal(conflictSince(previous, refresh), at, 'a record predating the field reads its own time as the first conflict');
  assert.equal(conflictSince({ ...previous, conflictSince: '2026-10-04T10:00:00.000Z' }, refresh), '2026-10-04T10:00:00.000Z', 'an earlier first conflict is kept');
  assert.equal(conflictSince(null, refresh), later, 'the first refresh to conflict starts the clock');
  assert.equal(conflictSince({ ...previous, conflict: null }, refresh), later, 'a clean refresh in between restarts the clock');
  assert.equal(conflictSince({ ...previous, from: { sha: 'd'.repeat(40), baseSha: 'c'.repeat(40) } }, refresh), later, 'a new head restarts the clock');
  assert.equal(conflictSince({ ...previous, policyRevision: 1 }, refresh), later, 'a new policy revision restarts the clock');
  assert.equal(conflictSince(previous, { ...refresh, conflict: null }), null, 'a clean refresh records no conflict');
});

test('staleRefreshRecord — conflictSince and conflictPaths survive only beside a conflict (GY-1230)', () => {
  const head = 'b'.repeat(40), base = 'c'.repeat(40);
  const previous: BaseRefresh = {
    from: { sha: 'a'.repeat(40), baseSha: base }, base, baseTree: 'e'.repeat(40), policyRevision: 2, at: '2026-10-04T11:00:00.000Z',
    head, conflict: 'conflicts', conflictSince: '2026-10-04T10:00:00.000Z', conflictPaths: ['docs/README.md'],
  };
  const reading = (conflict: string | null): BaseRefresh => ({
    from: { sha: head, baseSha: base }, base, baseTree: 'f'.repeat(40), policyRevision: 2, at: '2026-10-04T11:40:00.000Z', head, conflict,
  });
  const clean = staleRefreshRecord(previous, reading(null));
  assert.equal('conflictSince' in clean, false, 'a clean stale reading drops the conflict clock the head carried');
  assert.equal('conflictPaths' in clean, false, 'a clean stale reading drops the conflicted paths the head carried');
  const conflicted = staleRefreshRecord(previous, reading('conflicts'));
  assert.equal(conflicted.conflictSince, previous.conflictSince, 'beside a conflict the first conflict on the head is kept');
  assert.deepEqual(conflicted.conflictPaths, previous.conflictPaths, 'beside a conflict the conflicted paths are kept');
  const elsewhere = staleRefreshRecord({ ...previous, head: 'd'.repeat(40) }, reading('conflicts'));
  assert.equal(elsewhere.conflictSince, undefined, 'a record for another head carries nothing onto the reading');
});
