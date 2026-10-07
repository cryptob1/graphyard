import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { api, principals, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';
import { acceptancePollMs } from '../src/daemon/acceptance.js';
import type { Goal } from '../src/model/goal.js';

/**
 * The acceptance role (GY-1417) across a day of the real loop: goals drafted, judged, auto-merged
 * and recorded, through failures that must converge. One concern of the release-candidate soak
 * (GY-404), split per concern (GY-1363): the world is tests/helpers/soak-world.ts, the control
 * planes tests/helpers/soak-plane.ts, the day itself tests/helpers/soak-simulation.ts (its
 * acceptanceWorld holds this day's goals), and every suite asserts the system invariants after
 * every cycle.
 */
soakControlPlanes('soak-acceptance', 411);

test('unit:soak.acceptance-goals — across a day the loop drives three goals to delivering: one draft run per revision, a failed open or post retried with the same draft and pull request, a refused or closed-unmerged draft closed and drafted again, a failed run retried after an hour, auto-merge enabled once per approved head, pull requests read at most once per poll interval, and every invariant holding', { timeout: 600_000 }, async () => {
  const day = await simulateDay({
    hours: 6, acceptance: true,
    plan: { items: 4, leftovers: 1, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  const { violations, failures, lost, state } = day;
  const acceptance = day.acceptanceDay!;
  assert.deepEqual(violations, [], 'every system invariant holds while goals move');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');

  // Every goal reached delivering: its acceptance pull request merged and its cases are protected.
  const goals = (await api(principals.coordinator, 'GET', 'goals')).goals as Goal[];
  const goal = (name: string) => goals.find(entry => entry.key === acceptance.goals[name])!;
  for (const name of ['signup', 'billing', 'audit']) {
    assert.equal(goal(name).stage, 'delivering', `${name} was delivered to its implementation: ${goal(name).stage}`);
    assert.ok(goal(name).protected.cases.length === 1 && goal(name).merged?.pr === goal(name).acceptance!.pr, `${name}'s merged pull request protects its one case`);
  }
  const runs = (name: string, role: 'draft' | 'judge') => acceptance.runs.filter(run => run.goal === name && run.role === role);
  const opens = (name: string) => acceptance.opens.filter(entry => entry.goal === name);

  // signup: the first open and the first post failed and were retried with the same draft, never another run;
  // its first draft was refused, so its pull request was closed and one more draft opened one more pull request.
  assert.equal(runs('signup', 'draft').length, 2, 'one draft run per draft revision');
  assert.equal(runs('signup', 'judge').length, 2, 'one judgement per draft');
  assert.equal(opens('signup').length, 2, 'the failed post reused the pull request it had opened');
  assert.deepEqual(acceptance.posts.filter(post => post.goal === 'signup').map(post => post.ok), [false, true, true], 'the failed post was posted again, then the second draft');
  assert.ok(acceptance.closes.includes(opens('signup')[0].pr), 'the refused pull request was closed');
  assert.equal(goal('signup').drafts, 2); assert.equal(goal('signup').refusal?.by, principals.approver.id);
  assert.notEqual(goal('signup').acceptance!.author, goal('signup').approval!.by, 'the author never judged its own draft');

  // billing: a person closed its approved pull request unmerged, so it went back to drafting with the reason and was drafted again.
  assert.equal(opens('billing').length, 2);
  assert.match(goal('billing').refusal?.reason ?? '', /closed without merging/);
  const history = (await api(principals.coordinator, 'GET', `goals/${goal('billing').key}`)).history as { kind: string }[];
  assert.deepEqual(history.map(entry => entry.kind), ['goal.recorded', 'goal.draft', 'goal.approve', 'goal.closed', 'goal.draft', 'goal.approve', 'goal.merged']);

  // audit: its first draft run returned nothing on both models, and it was run again only after an hour.
  const audit = runs('audit', 'draft');
  assert.equal(audit.length, 3, `primary and fallback failed once, then one run drafted: ${JSON.stringify(audit)}`);
  assert.ok(audit[2].at - audit[1].at >= hour, 'a failed draft is retried after an hour, not every cycle');

  // Auto-merge was enabled once per approved head, and each pull request was read at most once per poll interval.
  assert.equal(acceptance.enqueues.length, new Set(acceptance.enqueues).size, `auto-merge enabled once per approved head: ${acceptance.enqueues.join(', ')}`);
  assert.equal(acceptance.enqueues.length, 4, 'three goals, and billing\'s second pull request');
  const byPull = new Map<number, number[]>();
  for (const read of acceptance.reads) byPull.set(read.pr, [...byPull.get(read.pr) ?? [], read.at]);
  for (const [pr, reads] of byPull) reads.slice(1).forEach((at, index) => assert.ok(at - reads[index] >= acceptancePollMs, `#${pr} was read again after ${at - reads[index]} ms`));
  assert.ok(acceptance.reads.length <= 6 * hour / acceptancePollMs * 2, `the pull request reads stay bounded: ${acceptance.reads.length}`);
  // Nothing is left behind: no acceptance pull request is open, and each goal has one action whose detail moved with it.
  assert.deepEqual([...acceptance.pulls].filter(([, pull]) => pull.state === 'open').map(([pr]) => pr), [], 'no acceptance pull request is left open');
  const keys = Object.keys(state.actions).filter(key => key.startsWith('acceptance:'));
  assert.equal(keys.length, 3, `one action per goal: ${keys.join(', ')}`);
});
