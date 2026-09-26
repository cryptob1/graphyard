import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedCheckRework, routineDecision } from '../src/master-daemon.js';
import { attributeTipFailure, checkFailureOf, ejectedTipRestore, predecessorWait, type CheckFailure } from '../src/merge-queue.js';
import type { ScopeFile, Work } from '../src/model.js';
import { placeInQueue } from '../src/model/queue.js';
import { failingTestCommand, failingTests } from './helpers/timing-report.js';

// GY-471, 2026-09-25 21:15 PT: the loop requested rework for GY-392 because `test` failed on
// bbc1c212e0e1, the speculative queue tip published for it behind GY-235 and GY-422. The failing
// test was unit:hotspot-registry: src/cli/master-status.ts exceeded its module budget, a file only
// GY-422 changed (its own tip 8c14bf920 failed the same way). The approver refused the rework as
// misattributed; GY-392 stalled and GY-422 stayed queued ahead of everything.

const at = '2026-09-25T21:15:00.000Z', now = new Date(at), clock = Date.parse(at);
const sha = (text: string) => text.padEnd(40, '0');
const base = sha('b'), ciApp = 15368;
const tip392 = sha('bbc1c212e0e1'), own392 = sha('39200'), tip422 = sha('8c14bf920'), tip235 = sha('23500');
const budget = 'src/cli/master-status.ts';
const outputOf = (named: string[]): CheckFailure => ({ name: 'test', id: 9001, named, subjects: [`tests/hotspot-registry.test.ts: every module stays inside its line budget`] });
const file = (path: string, changed: boolean): ScopeFile => ({ path, status: 'modified', sha: sha('f1'), baseSha: changed ? sha('f0') : sha('f1'), additions: 1, deletions: 0, binary: false });
const planned = (path: string): ScopeFile => ({ path, status: 'modified', sha: sha('f2'), additions: 3, deletions: 1, binary: false });

function item(key: string, head: string, sequence: number | null, options: { result?: string; scopeFiles?: ScopeFile[]; predecessors?: string[]; failure?: CheckFailure; reviewed?: string; plannedFiles?: string[]; on?: string } = {}): Work {
  const bound = options.on ?? base;
  const candidate = { sha: head, baseSha: bound, pr: Number(key.slice(3)), branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const predecessors = options.predecessors;
  return {
    id: key.toLowerCase(), key, title: key, description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: options.plannedFiles ?? ['src/daemon/'], stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, candidate,
    workspaces: [{ host: 'machine-a', path: `/tmp/${key}`, epoch: 1, owner: 'worker', branch: candidate.branch }],
    submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    queue: sequence === null ? null : { sequence, enqueuedAt: at, policyRevision: 1,
      speculation: predecessors ? { ref: `refs/graphyard/queue/${key.toLowerCase()}`, tip: head, base: bound, baseTree: sha('e'), predecessors, policyRevision: 1, publishedAt: at, reviewedHead: options.reviewed } : null },
    queueSequence: sequence ?? 0,
    queueHistory: predecessors && sequence !== null ? [{ at, event: 'predicted', sequence, tip: head, predecessors, from: options.reviewed }] : [],
    observation: { candidate, checks: [{ name: 'test', result: options.result ?? 'success', appId: ciApp, id: 9001 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED', submittedAt: at }],
      merged: false, mergeSha: null, mergeable: true, protected: true, files: (options.scopeFiles ?? []).map(entry => entry.path), scopeFiles: options.scopeFiles ?? [], at, prState: 'open', draft: false,
      baseTip: base, baseTree: sha('e'), baseTipContained: true, ...(options.failure ? { checkFailures: [options.failure] } : {}) },
  } as unknown as Work;
}
/** The engine's placement of `work` in the queue as it stands, applied to the record. */
const place = (work: Work, all: Work[]) => {
  const next = placeInQueue(work, all.map(entry => entry.id === work.id ? work : entry), now, [ciApp], true);
  return { ...work, queue: next.queue, queueSequence: next.queueSequence, queueEjection: next.ejection, queueHistory: next.history } as Work;
};
const decide = (work: Work) => routineDecision(work, { autoMerge: true }, clock);
const replace = (all: Work[], work: Work) => all.map(entry => entry.id === work.id ? work : entry);

/**
 * The queue as it stood: GY-235 at the head on the base branch, GY-422's tip on GY-235's, and
 * GY-392's tip bbc1c212 on GY-422's, failing `test` on the file GY-422 changed. `predecessor` is
 * how GY-422's own tip stands on `test`.
 */
function incident(options: { predecessor: 'failure' | 'success'; entryChangesNamed?: boolean }) {
  const gy235 = item('GY-235', tip235, 1, { predecessors: [], scopeFiles: [planned('src/model/board.ts')], plannedFiles: ['src/model/board.ts'] });
  const gy422 = item('GY-422', tip422, 2, { predecessors: ['GY-235'], on: tip235, result: options.predecessor, plannedFiles: ['src/master/', budget],
    scopeFiles: [planned('src/master/status.ts'), planned(budget), file('src/model/board.ts', false)], ...(options.predecessor === 'failure' ? { failure: outputOf([budget]) } : {}) });
  const gy392 = item('GY-392', tip392, 3, { predecessors: ['GY-235', 'GY-422'], on: tip422, result: 'failure', reviewed: own392, plannedFiles: ['src/daemon/', ...(options.entryChangesNamed ? [budget] : [])],
    scopeFiles: [planned('src/daemon/cycle.ts'), options.entryChangesNamed ? planned(budget) : file(budget, false), file('src/model/board.ts', false), file('src/master/status.ts', false)],
    failure: outputOf([`/home/runner/work/graphyard/graphyard/${budget}`, 'tests/hotspot-registry.test.ts']) });
  return { gy235, gy422, gy392, all: [gy235, gy422, gy392] };
}

test('unit:speculative-failure-attributed — the GY-392/GY-422 replay ejects GY-422 with the failure named and re-queues GY-392 with no rework decision', () => {
  // GY-422's own tip fails the same check: the failure on GY-392's tip is GY-422's.
  let { gy422, gy392, all } = incident({ predecessor: 'failure' });
  const attribution = attributeTipFailure(gy392, all, 'test', [ciApp]);
  assert.equal(attribution?.verdict, 'predecessor');
  assert.deepEqual(attribution!.culprits.map(entry => entry.key), ['GY-422'], 'GY-235 passes and changes no named file, so only GY-422 is blamed');
  assert.match(attribution!.culprits[0].evidence, /GY-422's own head 8c14bf920000 fails test too/);

  // The 2026-09-25 rework: asked of GY-392 while its tip was still the queue's to judge.
  assert.equal(failedCheckRework(gy392), null, 'a failure on a live queue tip asks nothing of the entry');
  assert.equal(decide(gy392), null, 'no rework decision is requested for GY-392');
  gy392 = place(gy392, all);
  assert.ok(gy392.queue, 'GY-392 is not ejected for a failure its predecessor explains');
  assert.equal(decide(gy392), null);

  gy422 = place(gy422, all); all = replace(all, gy422);
  assert.equal(gy422.queue, null, 'GY-422 is ejected');
  assert.match(gy422.queueEjection!.reason, /^Required CI check test did not pass on speculative tip 8c14bf920000/, 'with the failure named');
  assert.equal(decide(gy422)?.action, 'rework', 'the culprit is the one asked to fix it');

  // With GY-422 gone GY-392 keeps its place and is predicted afresh behind GY-235 alone.
  gy392 = place(gy392, replace(all, gy392));
  assert.equal(gy392.queue?.sequence, 3, 'GY-392 is re-queued: it keeps its place');
  const placement = placeInQueue(gy392, replace(all, gy392), now, [ciApp], true).placement!;
  assert.deepEqual(placement.predecessors, ['GY-235']);
  assert.equal(placement.current, false, 'its tip is rebuilt without GY-422');
  assert.equal(decide(gy392), null);
});

test('unit:speculative-failure-attributed — an isolated failure whose named file only a predecessor changed ejects the predecessor and re-queues the entry with no rework', () => {
  // GY-422's own tip passes, so the bisection isolates GY-392: the failing output still names a
  // file only GY-422's diff changes.
  let { gy422, gy392, all } = incident({ predecessor: 'success' });
  gy392 = place(gy392, all); all = replace(all, gy392);
  assert.equal(gy392.queue, null, 'the entry leaves the tip it cannot pass');
  assert.equal(gy392.queueEjection!.attribution!.verdict, 'predecessor');
  assert.match(gy392.queueEjection!.attribution!.culprits[0].evidence, /GY-422's diff changes src\/cli\/master-status\.ts, which the failing test output names, and GY-392's diff does not/);
  assert.deepEqual(gy392.queueEjection!.predecessors, ['GY-422'], 'and waits for the predecessor the failure is attributed to');
  assert.match(gy392.queueEjection!.reason, /attributed to predecessor GY-422 .*so GY-392 waits for it and asks no rework/);
  assert.equal(failedCheckRework(gy392), null);
  assert.equal(decide(gy392), null, 'no rework decision is requested for GY-392');
  assert.deepEqual(predecessorWait(gy392, all), ['GY-422']);
  assert.match(placeInQueue(gy392, all, now, [ciApp], true).reasons[0], /^Waiting for GY-422 to land or leave the merge queue: .*failure is attributed to it/);

  gy422 = place(gy422, all); all = replace(all, gy422);
  assert.equal(gy422.queue, null, 'GY-422 leaves the queue on GY-392\'s record');
  assert.match(gy422.queueEjection!.reason, /^Required CI check test failed on speculative tip bbc1c212e0e1 of GY-392 and is attributed to this entry: GY-422's diff changes src\/cli\/master-status\.ts/);
  const rework = decide(gy422);
  assert.equal(rework?.action, 'rework');
  assert.equal(rework?.binding, `${tip422}:ci-attributed:GY-392:${tip392}`);

  // GY-392 no longer waits. Its ejected tip still carries GY-235 and GY-422, so it is restored to
  // its own reviewed head first, and that head re-enters the queue — still with no rework.
  assert.deepEqual(predecessorWait(gy392, all), []);
  assert.deepEqual(ejectedTipRestore(gy392, all)?.foreign, ['GY-235', 'GY-422']);
  assert.equal(decide(gy392), null);
  const restoredCandidate = { ...gy392.candidate!, sha: own392, baseSha: base };
  const restored = { ...gy392, candidate: restoredCandidate, observation: { ...gy392.observation!, candidate: restoredCandidate, checks: [{ name: 'test', result: 'pending', appId: ciApp, id: 9002 }], checkFailures: undefined } } as Work;
  const requeued = place(restored, replace(all, restored));
  assert.ok(requeued.queue, 'GY-392 is re-queued');
  assert.equal(requeued.queueHistory!.at(-1)!.event, 'enqueued');
  assert.equal(decide(requeued), null);

  // A new GY-422 head is judged afresh: the record blamed the head it saw, not the item.
  const fresh = incident({ predecessor: 'success' }).gy422;
  const moved = { ...fresh, candidate: { ...fresh.candidate!, sha: sha('42201') } } as Work;
  assert.equal(place(moved, replace(all, moved)).queue?.sequence, 2);
});

test('unit:speculative-failure-attributed — only a failure the entry\'s own diff explains, or that no predecessor explains, asks for the entry\'s rework', () => {
  // The entry's own diff also changes the named file: the rule cannot clear it.
  let { gy392, all } = incident({ predecessor: 'success', entryChangesNamed: true });
  gy392 = place(gy392, all);
  assert.equal(gy392.queueEjection!.attribution!.verdict, 'entry');
  assert.equal(gy392.queueEjection!.predecessors, undefined);
  assert.equal(decide(gy392)?.action, 'rework');

  // Output that names nothing a predecessor changed: unexplained, so the entry's.
  ({ gy392, all } = incident({ predecessor: 'success' }));
  gy392 = { ...gy392, observation: { ...gy392.observation!, checkFailures: [outputOf(['tests/other.test.ts'])] } } as Work;
  gy392 = place(gy392, replace(all, gy392));
  assert.equal(gy392.queueEjection!.attribution!.verdict, 'unexplained');
  assert.equal(decide(gy392)?.action, 'rework');
});

test('unit:rework-names-attribution — every CI-failure rework request on a queue tip names the tip\'s predecessors and the attribution evidence', () => {
  let { gy392, all } = incident({ predecessor: 'success', entryChangesNamed: true });
  gy392 = place(gy392, all);
  const rework = decide(gy392);
  assert.equal(rework?.action, 'rework');
  assert.match(rework!.reason, /GY-392: required CI check test failed on candidate bbc1c212e0e1\. Candidate bbc1c212e0e1 is a speculative merge-queue tip built behind predecessors GY-235, GY-422; attribution: test failed on speculative tip bbc1c212e0e1 built behind GY-235, GY-422; the failing output names \/home\/runner\/work\/graphyard\/graphyard\/src\/cli\/master-status\.ts, tests\/hotspot-registry\.test\.ts, and GY-392's own diff changes src\/cli\/master-status\.ts, while no predecessor's own head fails test\./);

  ({ gy392, all } = incident({ predecessor: 'success' }));
  gy392 = { ...gy392, observation: { ...gy392.observation!, checkFailures: undefined } } as Work;
  gy392 = place(gy392, replace(all, gy392));
  assert.match(decide(gy392)!.reason, /built behind predecessors GY-235, GY-422; attribution: test failed on speculative tip bbc1c212e0e1 built behind GY-235, GY-422; the failing output names no file, no predecessor's own head fails test, and no predecessor's diff alone holds a named file, so nothing but GY-392's change explains it \(the check output named no file\)\./);

  // A tip published on the base branch alone says so; a head that never was a tip adds nothing.
  const alone = place(item('GY-500', sha('500'), 1, { predecessors: [], result: 'failure', scopeFiles: [planned('src/daemon/cycle.ts')] }), []);
  assert.match(decide(alone)!.reason, /is a speculative merge-queue tip built on the base branch with no predecessor; attribution: test failed on speculative tip 500000000000 built on the base branch alone;/);
  const plain = item('GY-501', sha('501'), null, { result: 'failure' });
  assert.doesNotMatch(decide(plain)!.reason, /speculative/);

  // The culprit's own request names the entry's tip, its predecessors and the evidence.
  let culprit: Work;
  ({ gy392, all } = incident({ predecessor: 'success' }));
  gy392 = place(gy392, all); all = replace(all, gy392);
  culprit = place(all.find(entry => entry.key === 'GY-422')!, all);
  assert.match(decide(culprit)!.reason, /^GY-422: required CI check test failed on speculative tip bbc1c212e0e1 of GY-392, built behind predecessors GY-235, GY-422, and is attributed to this item: GY-422's diff changes src\/cli\/master-status\.ts, which the failing test output names, and GY-392's diff does not\. Attribution: test failed on speculative tip bbc1c212e0e1 built behind GY-235, GY-422; attributed to GY-422: /);
});

test('unit:speculative-failure-attributed — the failing output is read from the check run and the CI log', () => {
  const log = ['✔ fine (0.1ms)', 'ℹ fail 1', '', '✖ failing tests:', '', 'test at tests/hotspot-registry.test.ts:3:1', '✖ every module stays inside its line budget (0.8ms)',
    '  AssertionError [ERR_ASSERTION]: src/cli/master-status.ts exceeds its module budget (900 > 800 lines)', '      at TestContext.<anonymous> (file:///home/runner/work/graphyard/graphyard/tests/hotspot-registry.test.ts:3:37)',
    '      at Test.run (node:internal/test_runner/test:1081:25)', ''].join('\n');
  const [failing] = failingTests(log);
  assert.deepEqual(failing, { file: 'tests/hotspot-registry.test.ts', name: 'every module stays inside its line budget',
    detail: ['  AssertionError [ERR_ASSERTION]: src/cli/master-status.ts exceeds its module budget (900 > 800 lines)', '      at TestContext.<anonymous> (file:///home/runner/work/graphyard/graphyard/tests/hotspot-registry.test.ts:3:37)'] });
  assert.match(failingTestCommand(failing), /^::error file=tests\/hotspot-registry\.test\.ts,title=Failing test::every module stays inside its line budget%0A/);

  const failure = checkFailureOf({ name: 'test', id: 7, output: { title: 'test', summary: null, text: null } }, [
    { path: '.github', title: null, message: 'Process completed with exit code 1.' },
    { path: 'tests/hotspot-registry.test.ts', title: 'Failing test', message: [failing.name, ...failing.detail].join('\n') },
  ]);
  assert.deepEqual(failure.named, ['tests/hotspot-registry.test.ts', 'src/cli/master-status.ts', '/home/runner/work/graphyard/graphyard/tests/hotspot-registry.test.ts']);
  assert.deepEqual(failure.subjects, ['tests/hotspot-registry.test.ts: every module stays inside its line budget']);
});
