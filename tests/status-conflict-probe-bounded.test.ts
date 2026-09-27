import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { candidateConflicts, openCandidates, probeCandidateConflictsWithBudget } from '../src/conflicts.js';
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

test('unit:conflict-probe-overlap-only-cached: the probe runs for overlapping pairs only and caches results', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'conflict-probe-'));
  const gitRoot = await mkdtemp(join(tmpdir(), 'conflict-probe-git-'));
  try {
    execFileSync('git', ['init', '-q', gitRoot]);
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRoot });
    execFileSync('git', ['config', 'user.email', 'test@test.invalid'], { cwd: gitRoot });

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

    await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, mockRun);
    assert.equal(firstCallProbes, 5, `Expected 5 probes on first call (only overlapping pairs), got ${firstCallProbes}`);

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

    await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, mockRun2);
    assert.equal(secondCallProbes, 0, `Expected 0 probes on second call with unchanged heads (cached), got ${secondCallProbes}`);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(gitRoot, { recursive: true, force: true });
  }
});

test('unit:conflict-probe-budgeted: the probe respects wall-clock budget and reports unprobed pairs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conflict-budget-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@test.invalid'], { cwd: root });

    // Create test data with many overlapping candidates (all touching src/common.ts)
    const work: Work[] = [];
    for (let i = 1; i <= 10; i++) {
      work.push(workWithFiles(`GY-${i}`, ['src/common.ts'], String(i).padStart(40, String(i))));
    }

    // Mock probe that tracks calls
    let probeCount = 0;
    const trackingProbe = () => {
      probeCount++;
      return [];
    };

    // Simulate a budget that runs out immediately
    let callCount = 0;
    const budget = {
      timeoutMs: 10, // Very short budget
      elapsedMs: () => {
        callCount++;
        // Return elapsed time that exceeds budget after the first few calls
        return callCount > 2 ? 100 : 0; // After 2 calls, claim 100ms has passed
      },
    };

    const result = candidateConflicts(work, trackingProbe, budget);

    // With 10 items that all overlap, there are 45 pairs. With very short budget, only the first few should be probed
    assert.ok(probeCount <= 5, `Expected probes to be limited by budget, got ${probeCount}`);

    // Check that unprobed list is populated because budget ran out
    let totalUnprobed = 0;
    for (const item of openCandidates(work)) {
      totalUnprobed += result[item.key].unprobed.length;
    }
    assert.ok(totalUnprobed > 0, `Expected some unprobed pairs due to budget timeout, got ${totalUnprobed} unprobed`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unit:conflict-probe-null-uncached: an unavailable head is probed again once it becomes available', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'conflict-null-'));
  const gitRoot = await mkdtemp(join(tmpdir(), 'conflict-null-git-'));
  try {
    execFileSync('git', ['init', '-q', gitRoot]);
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRoot });
    execFileSync('git', ['config', 'user.email', 'test@test.invalid'], { cwd: gitRoot });

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

    // Head B is unavailable: the pair is unprobed and no result is persisted for it.
    const first = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, mockRun);
    assert.equal(mergeTreeCalls, 0, 'an unavailable head must not reach merge-tree');
    assert.deepEqual(first.report['GY-1'].unprobed, ['GY-2']);
    assert.equal(first.report['GY-1'].conflicts.length, 0);
    await assert.rejects(readFile(cacheFile, 'utf8'), 'an unprobed (null) result must not be written to the disk cache');

    // Head B becomes available: the pair is probed for real and its result is persisted.
    headBPresent = true;
    const second = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, mockRun);
    assert.equal(mergeTreeCalls, 1, 'the pair must be probed once the head arrives');
    assert.deepEqual(second.report['GY-1'].unprobed, []);
    assert.equal(second.report['GY-1'].conflicts.length, 0);
    await assert.doesNotReject(readFile(cacheFile, 'utf8'));

    // The persisted result is reused: neither head changed, so no new probe runs.
    headBPresent = false;
    mergeTreeCalls = 0;
    const third = await probeCandidateConflictsWithBudget(gitRoot, work, dataRoot, mockRun);
    assert.equal(mergeTreeCalls, 0, 'a cached pair must not be probed again while its heads are unchanged');
    assert.deepEqual(third.report['GY-1'].unprobed, []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(gitRoot, { recursive: true, force: true });
  }
});

