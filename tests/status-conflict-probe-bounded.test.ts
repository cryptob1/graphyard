import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BUDGET_EXHAUSTED_REASON, PROBE_FAILED_REASON, candidateConflicts, openCandidates, probeCandidateConflictsWithBudget } from '../src/conflicts.js';
import { buildMasterStatus } from '../src/master.js';
import type { Work } from '../src/model.js';

function workWithFiles(key: string, files: string[], sha: string): Work {
  return {
    id: `id-${key}`, key, title: `Work ${key}`, description: '', type: 'feature',
    priority: 1, dependencies: [], criteria: [], policy: { checks: [], review: false },
    plannedFiles: files, stage: 'build', revision: 1, policyRevision: 1,
    createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z',
    stageEnteredAt: '2030-01-01T00:00:00Z', ready: true, epoch: 1, lease: null,
    workspaces: [], candidate: { sha, baseSha: 'base', pr: 1, branch: 'main', author: 'test' },
    submission: { epoch: 1, pr: 1 }, reworkRequested: false, scenarioRequirements: [],
    evidence: [], observation: null, blocker: null, gates: [],
    violations: [],
  } as Work;
}

const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const allPairs = (count: number): Array<[number, number]> => {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) pairs.push([i, j]);
  return pairs;
};
/** The unordered pairs named in a report's unprobed lists. */
const unprobedPairs = (report: Record<string, { unprobed: string[] }>, keys: string[]): Set<string> => {
  const pairs = new Set<string>();
  for (const key of keys) for (const partner of report[key].unprobed) pairs.add(pairKey(key, partner));
  return pairs;
};
const gitInit = (root: string) => {
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@test.invalid'], { cwd: root });
};
/** Blocks the calling thread for `ms` without a timer, the way a slow git invocation would. */
const block = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

test('unit:conflict-probe-overlap-only-cached: the probe runs for overlapping pairs only and caches results', async () => {
  const dataRoot = await temporaryDirectory('conflict-probe');
  const gitRoot = await temporaryDirectory('conflict-probe-git');
  try {
    gitInit(gitRoot);

    // Create 5 overlapping pairs by building 100 candidates with specific file patterns
    const work: Work[] = [];

    // 5 pairs that overlap:
    // Pair 1: GY-1, GY-2 (both have src/a.ts)
    work.push(workWithFiles('GY-1', ['src/a.ts'], '1'.repeat(40)));
    work.push(workWithFiles('GY-2', ['src/a.ts'], '2'.repeat(40)));

    // Pair 2: GY-3, GY-4 (both have src/b.ts)
    work.push(workWithFiles('GY-3', ['src/b.ts'], '3'.repeat(40)));
    work.push(workWithFiles('GY-4', ['src/b.ts'], '4'.repeat(40)));

    // Pair 3: GY-5, GY-6 (both have src/c.ts)
    work.push(workWithFiles('GY-5', ['src/c.ts'], '5'.repeat(40)));
    work.push(workWithFiles('GY-6', ['src/c.ts'], '6'.repeat(40)));

    // Pair 4: GY-7, GY-8 (both have src/d.ts)
    work.push(workWithFiles('GY-7', ['src/d.ts'], '7'.repeat(40)));
    work.push(workWithFiles('GY-8', ['src/d.ts'], '8'.repeat(40)));

    // Pair 5: GY-9, GY-10 (both have src/e.ts)
    work.push(workWithFiles('GY-9', ['src/e.ts'], '9'.repeat(40)));
    work.push(workWithFiles('GY-10', ['src/e.ts'], 'a'.repeat(40)));

    // Fill to 100 with non-overlapping files
    for (let i = 11; i <= 100; i++) {
      const shaPrefix = String(i % 10);
      work.push(workWithFiles(`GY-${i}`, [`src/${i}.ts`], (shaPrefix + shaPrefix.repeat(39)).slice(0, 40)));
    }

    // First call: should probe 5 pairs (only overlapping ones) and skip the rest
    let firstCallProbes = 0;
    const mockRun = (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[2] === 'cat-file') {
        // Presence checks always return true for our test shas
        return '';
      }
      if (cmd === 'git' && args[2] === 'merge-tree') {
        firstCallProbes++;
        return ''; // Successful clean merge (no throw, so the probe returns [])
      }
      return '';
    };

    const first = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, mockRun);
    assert.equal(first.budgetMs, 10_000, 'the default wall-clock budget is 10 s');
    assert.equal(firstCallProbes, 5, `Expected 5 probes on first call (only overlapping pairs), got ${firstCallProbes}`);
    assert.deepEqual(first.unprobedReasons, {}, 'every overlapping pair was probed, so none is left unprobed');

    // Second call with same heads: should reuse cache, no new probes for the same pairs
    let secondCallProbes = 0;
    const mockRun2 = (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[2] === 'cat-file') {
        return '';
      }
      if (cmd === 'git' && args[2] === 'merge-tree') {
        secondCallProbes++;
        return '';
      }
      return '';
    };

    const second = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, mockRun2);
    assert.equal(secondCallProbes, 0, `Expected 0 probes on second call with unchanged heads (cached), got ${secondCallProbes}`);
    assert.deepEqual(second.unprobedReasons, {});
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(gitRoot, { recursive: true, force: true });
  }
});

test('unit:conflict-probe-overlap-only-cached: an ancestor path overlaps everything beneath it and near-misses do not overlap', () => {
  const sha = (n: number) => String(n).repeat(40);
  const items = [
    workWithFiles('GY-file', ['foo'], sha(1)),
    workWithFiles('GY-nested', ['foo/bar'], sha(2)),
    workWithFiles('GY-near', ['foo.ts'], sha(3)),
    workWithFiles('GY-nearer', ['foo.tsx'], sha(4)),
    workWithFiles('GY-dir', ['lib/'], sha(5)),
    workWithFiles('GY-inside', ['lib/deep.ts'], sha(6)),
  ];
  const probed: Array<[string, string]> = [];
  const probe = (a: string, b: string) => { probed.push([a, b]); return []; };
  const report = candidateConflicts(items, probe);

  // foo vs foo/bar (a file against a path beneath it) and lib/ vs lib/deep.ts (a directory
  // prefix) must be probed; the foo.ts / foo.tsx near-misses must not be.
  assert.deepEqual(probed, [[sha(1), sha(2)], [sha(5), sha(6)]], 'exactly the ancestor and directory-prefix pairs are probed');
  assert.deepEqual(report['GY-file'].conflicts, [], 'a clean merge over an overlapping pair is conflict-free, not unprobed');
  assert.deepEqual(report['GY-near'].unprobed, [], 'near-miss pairs are neither probed nor reported');
  assert.deepEqual(unprobedPairs(report, items.map(item => item.key)), new Set(), 'no pair was left unprobed');
});

test('unit:conflict-probe-budgeted: the probe stops at its wall-clock budget and names every pair it left unprobed, with the reason', () => {
  const work: Work[] = [];
  for (let i = 1; i <= 6; i++) work.push(workWithFiles(`GY-${i}`, ['src/common.ts'], String(i).padStart(40, String(i))));
  let probes = 0;
  const probe = () => { probes++; return []; };
  let clockCalls = 0;
  // The clock reads 0 for the first pair and 50 ms from the second on: against a 10 ms budget
  // exactly the first pair is probed and the other 14 are left unprobed.
  const budget = { timeoutMs: 10, elapsedMs: () => (clockCalls++ < 1 ? 0 : 50) };

  const report = candidateConflicts(work, probe, budget);
  assert.equal(probes, 1, `Expected the budget to cut the run off after the first pair, got ${probes} probes`);

  const keys = work.map(item => item.key);
  const expectedUnprobed = allPairs(work.length).filter(([i, j]) => !(i === 0 && j === 1)).map(([i, j]) => pairKey(keys[i], keys[j]));
  assert.deepEqual(unprobedPairs(report, keys), new Set(expectedUnprobed), 'exactly the pairs the budget never reached are named unprobed');
});

test('unit:conflict-probe-budgeted: each unprobed pair carries its reason, and an unprobed pair is never reported conflict-free', () => {
  const work: Work[] = [];
  for (let i = 1; i <= 6; i++) work.push(workWithFiles(`GY-${i}`, ['src/common.ts'], String(i).padStart(40, String(i))));
  let probes = 0;
  const probe = (a: string, b: string) => { probes++; return a === work[0].candidate!.sha ? null : []; };
  let clockCalls = 0;
  const budget = { timeoutMs: 10, elapsedMs: () => (clockCalls++ < 1 ? 0 : 50) };

  const unprobedReasons: Record<string, string> = {};
  const report = candidateConflicts(work, probe, budget, unprobedReasons);

  const keys = work.map(item => item.key);
  // The first pair was probed but its head was unavailable; the budget stopped the rest.
  assert.equal(unprobedReasons[pairKey(keys[0], keys[1])], PROBE_FAILED_REASON, 'a pair whose probe failed is named with the failure reason');
  const budgeted = Object.entries(unprobedReasons).filter(([, reason]) => reason === BUDGET_EXHAUSTED_REASON).map(([key]) => key);
  assert.equal(budgeted.length, 14, 'the pairs the budget never reached are named with the budget reason');
  assert.deepEqual(unprobedPairs(report, keys), new Set(Object.keys(unprobedReasons)), 'every unprobed pair has exactly one reason and every reason names an unprobed pair');
  assert.equal(probes, 1);
  for (const key of keys) {
    assert.deepEqual(report[key].conflicts, [], 'an unprobed pair is never reported as a conflict');
  }
});

test('unit:conflict-probe-budgeted: a slow git holds the budget — each call is killed at the deadline and the rest are named unprobed', async () => {
  const dataRoot = await temporaryDirectory('conflict-budget-slow');
  const gitRoot = await temporaryDirectory('conflict-budget-slow-git');
  try {
    gitInit(gitRoot);
    const work: Work[] = [];
    for (let i = 1; i <= 6; i++) work.push(workWithFiles(`GY-${i}`, ['src/common.ts'], String(i).padStart(40, String(i))));

    let mergeTreeCalls = 0;
    const allottedMs: number[] = [];
    // A git that wants 5 s per merge-tree. It honours the deadline it is handed, the way
    // execFileSync kills the real git at its timeout, and reports the kill as a failure.
    const slowRun = (command: string, args: string[], timeoutMs?: number): string => {
      if (command === 'git' && args[2] === 'cat-file') return '';
      if (command === 'git' && args[2] === 'merge-tree') {
        mergeTreeCalls++;
        const wanted = 5_000, allotted = timeoutMs ?? 60_000;
        allottedMs.push(allotted);
        block(Math.min(wanted, allotted + 50));
        if (allotted < wanted) {
          const error = new Error('fake git killed at the budget deadline') as Error & { killed?: boolean; status?: number | null };
          error.killed = true;
          error.status = null;
          throw error;
        }
        return '';
      }
      return '';
    };

    const started = Date.now();
    const result = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, slowRun, 400);
    const elapsed = Date.now() - started;

    assert.equal(mergeTreeCalls, 1, `Expected the budget to stop the run after the first slow call, got ${mergeTreeCalls}`);
    assert.ok(allottedMs[0] <= 400, `each git call is bounded by the remaining budget, got ${allottedMs[0]}ms`);
    assert.ok(elapsed < 2_000, `the report returns at the budget even though each git call wanted 5 s, took ${elapsed}ms`);

    const keys = work.map(item => item.key);
    assert.deepEqual(unprobedPairs(result.report, keys), new Set(allPairs(work.length).map(([i, j]) => pairKey(keys[i], keys[j]))), 'every pair is accounted for');
    assert.equal(result.unprobedReasons[pairKey(keys[0], keys[1])], PROBE_FAILED_REASON, 'the pair whose git call was killed at the deadline is named with the failure reason');
    const budgeted = Object.entries(result.unprobedReasons).filter(([, reason]) => reason === BUDGET_EXHAUSTED_REASON);
    assert.equal(budgeted.length, 14, 'the pairs the spent budget never reached are named with the budget reason');
    assert.equal(result.budgetMs, 400);
    for (const key of keys) assert.deepEqual(result.report[key].conflicts, [], 'nothing probed-through is invented: no conflicts are reported');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(gitRoot, { recursive: true, force: true });
  }
});

test('unit:conflict-probe-budgeted: master status still returns every other section when the budget runs out', () => {
  const left = workWithFiles('GY-left', ['src/sync.ts'], 'c'.repeat(40));
  const right = workWithFiles('GY-right', ['src/sync.ts'], 'd'.repeat(40));
  const work = [left, right];
  // A budget that is already spent: no pair is probed, both are named unprobed.
  const unprobedReasons: Record<string, string> = {};
  let clockCalls = 0;
  const report = candidateConflicts(work, () => { throw new Error('no probe may run once the budget is spent'); }, { timeoutMs: 0, elapsedMs: () => (clockCalls++ === 0 ? 0 : 1) }, unprobedReasons);
  assert.deepEqual(unprobedReasons, { [pairKey('GY-left', 'GY-right')]: BUDGET_EXHAUSTED_REASON });

  const status = buildMasterStatus({ work, now: '2030-01-01T00:00:00Z' }, [], [], {}, {}, { pending: [], completed: [] }, 'main', undefined, undefined, { report, available: true, reason: null });
  for (const section of ['work', 'counts', 'schedule', 'conflicts', 'speed', 'attentionItems']) {
    assert.ok(section in status, `master status still returns the ${section} section when the conflict budget is spent`);
  }
  const row = (key: string) => status.work.find(entry => entry.key === key)!;
  assert.deepEqual(row('GY-left').conflicts, { candidates: [], files: [], unprobed: ['GY-right'], probed: true }, 'the unprobed pair is named, never reported conflict-free');
  assert.deepEqual(row('GY-right').conflicts, { candidates: [], files: [], unprobed: ['GY-left'], probed: true });
});

test('unit:conflict-probe-budgeted: the fetch is inside the budget — it is killed at the deadline, the report still answers, and nothing is invented', async () => {
  const dataRoot = await temporaryDirectory('conflict-fetch-budget');
  const gitRoot = await temporaryDirectory('conflict-fetch-budget-git');
  try {
    gitInit(gitRoot);
    const work: Work[] = [];
    for (let i = 1; i <= 3; i++) work.push(workWithFiles(`GY-${i}`, ['src/common.ts'], String(i).padStart(40, String(i))));

    const fetchTimeouts: number[] = [];
    let catFileCalls = 0, mergeTreeCalls = 0;
    // A fetch that wants 5 s and is killed at whatever the budget hands it, the way execFileSync
    // kills the real git; with nothing fetched, no head is present and no probe may run.
    const slowFetchRun = (command: string, args: string[], timeoutMs?: number): string => {
      if (command === 'git' && args[2] === 'fetch') {
        fetchTimeouts.push(timeoutMs ?? 60_000);
        block(Math.min(5_000, fetchTimeouts[0] + 50));
        const error = new Error('fake git fetch killed at the budget deadline') as Error & { killed?: boolean };
        error.killed = true;
        throw error;
      }
      if (command === 'git' && args[2] === 'cat-file') { catFileCalls++; throw new Error('head was never fetched'); }
      if (command === 'git' && args[2] === 'merge-tree') { mergeTreeCalls++; return ''; }
      return '';
    };

    const started = Date.now();
    const result = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, slowFetchRun, 400);
    const elapsed = Date.now() - started;

    assert.equal(fetchTimeouts.length, 1, 'the fetch ran once');
    assert.ok(fetchTimeouts[0] > 0 && fetchTimeouts[0] <= 400, `the fetch is handed the remaining budget, not the 60 s default, got ${fetchTimeouts[0]}ms`);
    assert.ok(elapsed < 2_000, `the report answers at the budget even though the fetch wanted 5 s, took ${elapsed}ms`);
    assert.equal(result.available, false, 'a fetch killed at the deadline is reported unavailable');
    assert.match(result.reason!, /could not be fetched: fake git fetch killed/);
    assert.equal(catFileCalls, 0, 'no presence check runs once the budget is spent by the fetch');
    assert.equal(mergeTreeCalls, 0, 'no merge-tree runs once the budget is spent by the fetch');
    const keys = work.map(item => item.key);
    assert.deepEqual(unprobedPairs(result.report, keys), new Set(allPairs(work.length).map(([i, j]) => pairKey(keys[i], keys[j]))), 'every overlapping pair is accounted for');
    for (const [, reason] of Object.entries(result.unprobedReasons)) {
      assert.equal(reason, BUDGET_EXHAUSTED_REASON, 'the pairs the spent fetch left are named with the budget reason');
    }
    for (const key of keys) assert.deepEqual(result.report[key].conflicts, [], 'nothing is reported as a conflict without a probe');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(gitRoot, { recursive: true, force: true });
  }
});

test('unit:conflict-probe-budgeted: the fetch pays the budget first — the probe phase gets only what the fetch left', async () => {
  const dataRoot = await temporaryDirectory('conflict-fetch-first');
  const gitRoot = await temporaryDirectory('conflict-fetch-first-git');
  try {
    gitInit(gitRoot);
    const work: Work[] = [];
    for (let i = 1; i <= 6; i++) work.push(workWithFiles(`GY-${i}`, ['src/common.ts'], String(i).padStart(40, String(i))));

    const mergeTreeAllotted: number[] = [];
    let mergeTreeCalls = 0;
    // A fetch that takes 300 ms of a 400 ms budget, then succeeds; the first merge-tree wants 5 s
    // and honours whatever it is handed, the way execFileSync kills the real git at its timeout.
    const run = (command: string, args: string[], timeoutMs?: number): string => {
      if (command === 'git' && args[2] === 'fetch') { block(300); return ''; }
      if (command === 'git' && args[2] === 'cat-file') return '';
      if (command === 'git' && args[2] === 'merge-tree') {
        mergeTreeCalls++;
        const wanted = 5_000, allotted = timeoutMs ?? 60_000;
        mergeTreeAllotted.push(allotted);
        block(Math.min(wanted, allotted + 50));
        if (allotted < wanted) {
          const error = new Error('fake git killed at the budget deadline') as Error & { killed?: boolean; status?: number | null };
          error.killed = true;
          error.status = null;
          throw error;
        }
        return '';
      }
      return '';
    };

    const started = Date.now();
    const result = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, run, 400);
    const elapsed = Date.now() - started;

    assert.equal(mergeTreeCalls, 1, `the probe phase starts on the remainder and stops at the deadline, got ${mergeTreeCalls} merge-tree calls`);
    assert.ok(mergeTreeAllotted[0] < 400, `the first merge-tree gets only what the fetch left, not the whole budget, got ${mergeTreeAllotted[0]}ms`);
    assert.ok(elapsed < 2_000, `the report answers inside the budget even though each call wanted 5 s, took ${elapsed}ms`);
    assert.equal(result.available, true, 'the fetch completed inside the budget');

    const keys = work.map(item => item.key);
    assert.equal(result.unprobedReasons[pairKey(keys[0], keys[1])], PROBE_FAILED_REASON, 'the pair whose merge-tree was killed at the deadline is named with the failure reason');
    const budgeted = Object.entries(result.unprobedReasons).filter(([, reason]) => reason === BUDGET_EXHAUSTED_REASON);
    assert.equal(budgeted.length, 14, 'the pairs the remaining budget never reached are named with the budget reason');
    assert.deepEqual(unprobedPairs(result.report, keys), new Set(allPairs(work.length).map(([i, j]) => pairKey(keys[i], keys[j]))), 'every pair is accounted for');
    for (const key of keys) assert.deepEqual(result.report[key].conflicts, [], 'nothing probed-through is invented: no conflicts are reported');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(gitRoot, { recursive: true, force: true });
  }
});

test('unit:conflict-probe-overlap-only-cached: a pair the disk cache answers is reported however far the budget is spent', async () => {
  const dataRoot = await temporaryDirectory('conflict-cache-budget');
  const gitRoot = await temporaryDirectory('conflict-cache-budget-git');
  try {
    gitInit(gitRoot);
    const shaA = '1'.repeat(40), shaB = '2'.repeat(40);
    const work = [
      workWithFiles('GY-1', ['src/a.ts'], shaA),
      workWithFiles('GY-2', ['src/a.ts'], shaB),
    ];

    // The pair's answer, cached by an earlier call: a real conflict over src/a.ts.
    await mkdir(join(dataRoot, 'conflict-probes'), { recursive: true });
    await writeFile(join(dataRoot, 'conflict-probes', [shaA, shaB].sort().join('-') + '.json'), JSON.stringify({ result: ['src/a.ts'], at: '2030-01-01T00:00:00Z' }), 'utf8');

    let catFileCalls = 0, mergeTreeCalls = 0;
    // A fetch that eats the whole budget and is killed: the disk cache read has already run, so
    // the pair is still reported, and no git call may reach for the heads it never fetched.
    const slowFetchRun = (command: string, args: string[], timeoutMs?: number): string => {
      if (command === 'git' && args[2] === 'fetch') {
        block(Math.min(5_000, (timeoutMs ?? 60_000) + 50));
        const error = new Error('fake git fetch killed at the budget deadline') as Error & { killed?: boolean };
        error.killed = true;
        throw error;
      }
      if (command === 'git' && args[2] === 'cat-file') { catFileCalls++; throw new Error('head was never fetched'); }
      if (command === 'git' && args[2] === 'merge-tree') { mergeTreeCalls++; return ''; }
      return '';
    };

    const started = Date.now();
    const result = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, slowFetchRun, 400);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 2_000, `the cached answer is reported without waiting on the fetch it did not need, took ${elapsed}ms`);
    assert.equal(result.available, false, 'the failed fetch is still named');
    assert.equal(catFileCalls, 0, 'a cached pair is answered from the cache, not re-probed');
    assert.equal(mergeTreeCalls, 0, 'a cached pair is answered from the cache, not re-probed');
    assert.deepEqual(result.report['GY-1'].conflicts, [{ key: 'GY-2', files: ['src/a.ts'] }], 'the cached conflict is reported even with the budget spent');
    assert.deepEqual(result.report['GY-2'].conflicts, [{ key: 'GY-1', files: ['src/a.ts'] }]);
    assert.deepEqual(result.report['GY-1'].unprobed, [], 'a cached pair is never left unprobed');
    assert.deepEqual(result.unprobedReasons, {});
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(gitRoot, { recursive: true, force: true });
  }
});

test('unit:conflict-probe-null-uncached: an unavailable head is probed again once it becomes available', async () => {
  const dataRoot = await temporaryDirectory('conflict-null');
  const gitRoot = await temporaryDirectory('conflict-null-git');
  try {
    gitInit(gitRoot);

    const shaA = '1'.repeat(40);
    const shaB = '2'.repeat(40);
    const work = [
      workWithFiles('GY-1', ['src/a.ts'], shaA),
      workWithFiles('GY-2', ['src/a.ts'], shaB),
    ];

    const cacheFile = join(dataRoot, 'conflict-probes', [shaA, shaB].sort().join('-') + '.json');
    let headBPresent = false;
    let mergeTreeCalls = 0;
    const mockRun = (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[2] === 'cat-file') {
        if (args[4] === `${shaB}^{commit}` && !headBPresent) throw new Error('missing head');
        return '';
      }
      if (cmd === 'git' && args[2] === 'merge-tree') {
        mergeTreeCalls++;
        return '';
      }
      return '';
    };

    // Head B is unavailable: the pair is unprobed with the failure reason and no result is persisted for it.
    const first = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, mockRun);
    assert.equal(mergeTreeCalls, 0, 'an unavailable head must not reach merge-tree');
    assert.deepEqual(first.report['GY-1'].unprobed, ['GY-2']);
    assert.equal(first.report['GY-1'].conflicts.length, 0);
    assert.equal(first.unprobedReasons[pairKey('GY-1', 'GY-2')], PROBE_FAILED_REASON, 'the unavailable head is named with the failure reason');
    await assert.rejects(readFile(cacheFile, 'utf8'), 'an unprobed (null) result must not be written to the disk cache');

    // Head B becomes available: the pair is probed for real and its result is persisted.
    headBPresent = true;
    const second = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, mockRun);
    assert.equal(mergeTreeCalls, 1, 'the pair must be probed once the head arrives');
    assert.deepEqual(second.report['GY-1'].unprobed, []);
    assert.equal(second.report['GY-1'].conflicts.length, 0);
    assert.deepEqual(second.unprobedReasons, {});
    await assert.doesNotReject(readFile(cacheFile, 'utf8'));

    // The persisted result is reused: neither head changed, so no new probe runs.
    headBPresent = false;
    mergeTreeCalls = 0;
    const third = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, mockRun);
    assert.equal(mergeTreeCalls, 0, 'a cached pair must not be probed again while its heads are unchanged');
    assert.deepEqual(third.report['GY-1'].unprobed, []);
    assert.deepEqual(third.unprobedReasons, {});
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(gitRoot, { recursive: true, force: true });
  }
});
