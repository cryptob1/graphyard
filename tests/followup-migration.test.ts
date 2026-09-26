import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followUpItem, type LaunchThread } from '../src/review-threads.js';
import { followUpEntries, followUpEntryKey, followUpParent, mergeDuplicateFollowUps } from '../src/model/machine-backlog.js';
import { isClosed } from '../src/model/closure.js';
import type { Work } from '../src/model.js';

// GY-402: the follow-up items filed before one-per-parent — GY-259 held GY-396, GY-399 and GY-401 —
// are folded by a one-time migration into each parent's oldest open one, and the rest closed as
// superseded by it. Nothing is deleted.

const thread = (id: string, path: string, excerpt: string): LaunchThread => ({ id, author: 'chatgpt-codex-connector', path, line: 7, outdated: false, excerpt, url: `https://github.com/owner/project/pull/217#discussion_${id}` });
/** A follow-up item exactly as the loop filed one before GY-402: its title and description, and no origin. */
function legacy(key: string, createdAt: string, sha: string, reviewId: number, threads: LaunchThread[], findings: { path: string | null; line: number | null; text: string }[]): Work {
  const item = followUpItem({ key: 'GY-259', workId: 'work-259', pr: 217, sha, reviewId }, threads, findings);
  return { id: `work-${key}`, key, title: item.title, description: item.description, type: 'chore', priority: 2, dependencies: item.dependencies, plannedFiles: item.plannedFiles,
    criteria: item.criteria, policy: { checks: ['test'], review: true }, stage: 'backlog', ready: false, revision: 1, policyRevision: 1, createdAt, updatedAt: createdAt, stageEnteredAt: createdAt,
    epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [] } as unknown as Work;
}

test('unit:followup-migration-merges — three follow-up items of one parent merge into the oldest open one, which holds every finding; the other two are closed as superseded by it, and nothing is deleted', () => {
  const duplicates = [
    legacy('GY-396', '2026-09-25T09:00:00Z', 'a1'.padEnd(40, 'f'), 501, [thread('PRRT_one', 'src/research.ts', 'the budget is never enforced')], [{ path: 'docs/research.md', line: null, text: 'docs/research.md — the flag is undocumented' }]),
    legacy('GY-399', '2026-09-25T11:00:00Z', 'b2'.padEnd(40, 'f'), 502, [thread('PRRT_one', 'src/research.ts', 'the budget is never enforced')], [{ path: 'src/research.ts', line: 90, text: 'src/research.ts:90 — a timeout leaves the run live' }]),
    legacy('GY-401', '2026-09-25T13:00:00Z', 'c3'.padEnd(40, 'f'), 503, [], [{ path: 'src/research.ts', line: 95, text: 'src/research.ts:95 — a timeout leaves the run live' }, { path: null, line: null, text: 'the brief could name its model' }]),
  ];
  const unrelated = legacy('GY-400', '2026-09-25T10:00:00Z', 'd4'.padEnd(40, 'f'), 504, [], [{ path: 'src/x.ts', line: 1, text: 'src/x.ts:1 — other parent' }]);
  unrelated.title = 'Follow-ups from the approved review of GY-300 (PR #210)';
  const operator = { ...unrelated, id: 'work-GY-402', key: 'GY-402', title: 'An operator item', description: '' } as Work;
  const all = [duplicates[2]!, unrelated, duplicates[0]!, operator, duplicates[1]!];
  const every = duplicates.flatMap(item => followUpEntries(item));

  const result = mergeDuplicateFollowUps(all, 'graphyard-operator', new Date('2026-09-26T00:00:00Z'));

  // The count merged is reported, and nothing is deleted.
  assert.equal(result.merged, 2);
  assert.equal(all.length, 5);
  // One open item for the parent: the oldest, holding every finding of the three, each once.
  const open = all.filter(item => followUpParent(item) === 'GY-259' && item.stage !== 'done');
  assert.deepEqual(open.map(item => item.key), ['GY-396']);
  const survivor = open[0]!;
  assert.equal(survivor.origin?.reviewFollowUps?.parent, 'GY-259');
  const held = new Set(followUpEntries(survivor).map(followUpEntryKey));
  for (const finding of every) assert.ok(held.has(followUpEntryKey(finding)), `${finding.text} is held by ${survivor.key}`);
  assert.equal(held.size, 4, 'the budget thread named twice and the timeout named at two lines are held once each');
  for (const text of ['the budget is never enforced', 'the flag is undocumented', 'a timeout leaves the run live', 'the brief could name its model']) assert.ok(survivor.description.includes(text), text);
  assert.match(survivor.description, /Merged from GY-399, GY-401/);
  // Two closed items, each naming the survivor.
  const closed = all.filter(item => followUpParent(item) === 'GY-259' && isClosed(item));
  assert.deepEqual(closed.map(item => item.key).sort(), ['GY-399', 'GY-401']);
  for (const item of closed) {
    assert.equal(item.closure?.ref, 'GY-396');
    assert.match(item.closure!.reason, /^Superseded by GY-396/);
    assert.equal(item.closure?.by, 'graphyard-operator');
    assert.equal(item.closure?.from, 'backlog');
    assert.ok(item.description.length > 0, 'a closed item keeps its own record');
  }
  assert.deepEqual(result.closed.map(item => item.key).sort(), ['GY-399', 'GY-401']);
  assert.deepEqual(result.survivors.map(entry => ({ key: entry.work.key, absorbed: entry.absorbed, added: entry.added })), [{ key: 'GY-396', absorbed: ['GY-399', 'GY-401'], added: 2 }]);
  // Another parent's lone item and the operator's item are untouched.
  assert.equal(unrelated.stage, 'backlog');
  assert.equal(operator.stage, 'backlog');
  // A second run finds nothing left to merge.
  assert.equal(mergeDuplicateFollowUps(all, 'graphyard-operator', new Date('2026-09-26T01:00:00Z')).merged, 0);
});
