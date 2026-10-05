import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupTipRefs, isTipRef } from '../src/tip-cleanup.js';
import type { ProtectionRun } from '../src/protection.js';

// GY-1236. The removed merge queue published each entry's speculative tip under
// refs/graphyard/queue/<key>; `graphyard master tip-cleanup` deletes the leftovers once.

/** A fake GitHub behind `gh api`: matching-refs lists every ref under the prefix, DELETE removes one. */
function fakeGitHub(refs: string[]) {
  const live = new Set(refs), calls: string[][] = [];
  const run: ProtectionRun = (command, args) => {
    assert.equal(command, 'gh');
    calls.push(args);
    const path = args.find(arg => arg.startsWith('repos/'))!;
    const listing = path.match(/^repos\/owner\/project\/git\/matching-refs\/(.+)$/);
    if (listing) return [...live].filter(ref => ref.startsWith(`refs/${listing[1]}`)).join('\n');
    const removal = path.match(/^repos\/owner\/project\/git\/(refs\/.+)$/);
    if (args.includes('DELETE') && removal && live.delete(removal[1])) return '';
    throw new Error(`Unexpected gh ${args.join(' ')}`);
  };
  return { run, live, calls };
}

test('unit:tip-branch-cleanup — the cleanup deletes the two leftover speculative tips and leaves the item branch, reporting what it deleted', () => {
  const tips = ['refs/graphyard/queue/gy-501', 'refs/graphyard/queue/gy-502'], item = 'refs/heads/graphyard/gy-503-1';
  const github = fakeGitHub([...tips, item, 'refs/heads/main']);
  // Without --apply nothing is written: the report names what would go.
  const plan = cleanupTipRefs({ repository: 'owner/project' }, { apply: false }, github.run);
  assert.deepEqual(plan.tips, tips);
  assert.deepEqual(plan.deleted, []);
  assert.equal(github.calls.some(args => args.includes('DELETE')), false, 'a plan deletes nothing');
  assert.equal(github.live.size, 4);

  const applied = cleanupTipRefs({ repository: 'owner/project' }, { apply: true }, github.run);
  assert.deepEqual(applied.deleted, tips, 'the report names every ref it deleted');
  assert.deepEqual(applied.refused, []);
  assert.deepEqual([...github.live].sort(), [item, 'refs/heads/main'], 'only the tips are gone: the item branch and main stay');
  assert.deepEqual(github.calls.filter(args => args.includes('DELETE')).map(args => args.find(arg => arg.startsWith('repos/'))),
    tips.map(ref => `repos/owner/project/git/${ref}`), 'one DELETE per tip, never one for the item branch');

  // A second run finds nothing left to delete.
  assert.deepEqual(cleanupTipRefs({ repository: 'owner/project' }, { apply: true }, github.run).deleted, []);
});

test('unit:tip-branch-cleanup — only the queue\'s tip refs match: item branches, main and the base refresh\'s scratch branches never do', () => {
  assert.equal(isTipRef('refs/graphyard/queue/gy-77'), true);
  assert.equal(isTipRef('refs/heads/graphyard/gy-77-tip-3'), true);
  for (const ref of ['refs/heads/graphyard/gy-77-1', 'refs/heads/main', 'refs/heads/graphyard-merge-check/gy-77', 'refs/heads/graphyard-revert/main-abc', 'refs/graphyard/queue/gy-77/nested'])
    assert.equal(isTipRef(ref), false, ref);
});

test('unit:tip-branch-cleanup — a delete GitHub refuses is reported with its reason and the rest still go', () => {
  const github = fakeGitHub(['refs/graphyard/queue/gy-1', 'refs/graphyard/queue/gy-2']);
  const run: ProtectionRun = (command, args, input) => {
    if (args.includes('DELETE') && args.some(arg => arg.endsWith('/gy-1'))) throw new Error('HTTP 403: Resource not accessible by integration');
    return github.run(command, args, input);
  };
  const result = cleanupTipRefs({ repository: 'owner/project' }, { apply: true }, run);
  assert.deepEqual(result.deleted, ['refs/graphyard/queue/gy-2']);
  assert.deepEqual(result.refused, [{ ref: 'refs/graphyard/queue/gy-1', error: 'HTTP 403: Resource not accessible by integration' }]);
});
