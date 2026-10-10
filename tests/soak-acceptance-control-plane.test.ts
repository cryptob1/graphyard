import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { api, principals, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';
import { acceptancePollMs } from '../src/daemon/acceptance.js';
import type { Goal } from '../src/model/goal.js';

/**
 * GY-1535: the acceptance role's day under the control-plane merger, through the real loop. The
 * same three goals as tests/soak-acceptance.test.ts, but each draft is one change committed for the
 * merge writer and landed by its steps (tests/helpers/soak-acceptance-writer.ts holds main's
 * first-parent history): a failed commit, a change conflicting with the base, a push refused because
 * main moved, and a landing record lost after the push must all converge, with the writer's work and
 * pushes bounded and every system invariant holding after every cycle.
 */
soakControlPlanes('soak-acceptance-control-plane', 423);

test('unit:soak.acceptance-control-plane — across a day the loop lands three goals\' acceptance changes through the merge writer with no pull request: one push per landed head, a push refused on a moved base made again on the new tip, a lost landing record recorded again without a second push, a failed base refresh refused and recorded again on a later poll, a conflicting change committed again from the current base without another draft run, landing tried at most once per poll interval, and every invariant holding', { timeout: 600_000 }, async () => {
  const day = await simulateDay({
    hours: 6, acceptance: 'control-plane',
    plan: { items: 4, leftovers: 1, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  const { violations, failures, lost } = day;
  const acceptance = day.acceptanceDay!, writer = acceptance.writer!, main = acceptance.main!;
  assert.deepEqual(violations, [], 'every system invariant holds while goals land through the merge writer');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  assert.deepEqual(writer.github, [], 'no pull request was opened, read, landed or closed');

  const goals = (await api(principals.coordinator, 'GET', 'goals')).goals as Goal[];
  const goal = (name: string) => goals.find(entry => entry.key === acceptance.goals[name])!;
  const runs = (name: string, role: 'draft' | 'judge') => acceptance.runs.filter(run => run.goal === name && run.role === role);
  const pushed = writer.pushes.filter(push => push.result === 'pushed');
  for (const name of ['signup', 'billing', 'audit']) {
    const merged = goal(name);
    assert.equal(merged.stage, 'planning', `${name} was handed to the planner: ${merged.stage}`);
    assert.equal(merged.acceptance!.pr, null); assert.equal(merged.merged!.pr, null);
    assert.deepEqual(merged.protected.cases.length, 1, `${name}'s merged change protects its one case`);
    assert.notEqual(merged.acceptance!.author, merged.approval!.by, 'the author never judged its own change');
    // The recorded merge is main's first-parent commit whose second parent is exactly the approved head, pushed once.
    assert.equal(main.find(commit => commit.sha === merged.merged!.mergeSha)?.second, merged.approval!.head);
    assert.equal(pushed.filter(push => push.head === merged.approval!.head).length, 1, `${name}'s approved head was pushed once`);
  }
  assert.equal(pushed.length, 3, 'one landed push per goal, none for a refused, conflicting or already-landed change');

  // signup: its first commit failed and was made again with the same draft; its refused first change was drafted again.
  assert.deepEqual(writer.commits.filter(entry => entry.goal === 'signup').map(entry => entry.ok), [false, true, true]);
  assert.equal(runs('signup', 'draft').length, 2, 'one draft run per draft revision');
  assert.equal(goal('signup').refusal?.by, principals.approver.id);

  // billing: main moved between its fetch and its push, so the leased push was refused and made again on the new tip; then the record was lost and recorded again without a second push.
  const billing = writer.pushes.filter(push => push.goal === 'billing');
  assert.deepEqual(billing.map(push => push.result), ['rejected', 'pushed']);
  assert.deepEqual(writer.records.filter(entry => entry.goal === 'billing').map(entry => entry.ok), [false, true]);
  const records = writer.records.filter(entry => entry.goal === 'billing');
  assert.ok(records[1]!.at - records[0]!.at >= acceptancePollMs, 'the lost record is recorded again after the poll interval, not every cycle');
  assert.ok(billing[1]!.at <= records[0]!.at, 'the record retry came after the one push');
  assert.equal(runs('billing', 'draft').length, 1, 'neither the race nor the lost record drafted again');

  // audit: its approved change conflicted with main, so it was recorded closed and the same outcomes committed again from the current base and judged again, with no other draft run.
  assert.match(goal('audit').refusal?.reason ?? '', /conflicts with main/);
  assert.equal(goal('audit').refusal?.pr, null);
  assert.equal(writer.commits.filter(entry => entry.goal === 'audit').length, 2);
  assert.equal(runs('audit', 'judge').length, 2);
  assert.equal(runs('audit', 'draft').length, 3, 'primary and fallback failed once, then one draft run; the conflict needed none');
  assert.deepEqual(((await api(principals.coordinator, 'GET', `goals/${goal('audit').key}`)).history as { kind: string }[]).map(entry => entry.kind),
    ['goal.recorded', 'goal.draft', 'goal.approve', 'goal.closed', 'goal.draft', 'goal.approve', 'goal.merged']);

  // The repeated work stays bounded: each head is merged at most once per poll interval (plus the writer's retrials within one try), and main is only ever read for a landing.
  const byHead = new Map<string, number[]>();
  for (const entry of writer.merges) byHead.set(entry.head, [...byHead.get(entry.head) ?? [], entry.at]);
  for (const [head, times] of byHead) {
    const tries = times.filter((at, index) => index === 0 || at - times[index - 1]! >= acceptancePollMs);
    assert.ok(times.length <= tries.length * 3, `${head.slice(0, 12)} was merged ${times.length} times over ${tries.length} tries`);
  }
  assert.ok(writer.merges.length <= 8, `the writer made a bounded number of merges: ${writer.merges.length}`);
  assert.ok(writer.fetches.length <= 2 * writer.merges.length, `fetches stay bounded by the merges: ${writer.fetches.length}`);
  assert.ok(writer.pushes.length <= 4, `pushes stay bounded: ${writer.pushes.length}`);
  // GY-1657: the land route refreshes origin/main before every judgement. signup's first refresh failed, so its
  // record was refused rather than judged on a stale ref, and recorded again on a later poll without a second push.
  assert.deepEqual(writer.refreshes.filter(entry => entry.goal === 'signup').map(entry => entry.ok), [false, true]);
  const signup = writer.records.filter(entry => entry.goal === 'signup');
  assert.deepEqual(signup.map(entry => entry.ok), [false, true]);
  assert.ok(signup[1]!.at - signup[0]!.at >= acceptancePollMs, 'the refused record is made again after the poll interval, not every cycle');
  assert.equal(writer.refreshes.length, writer.records.filter(entry => entry.goal !== 'billing' || entry.ok).length, 'one refresh per judged record: the repeated read stays bounded by the records');
  const keys = Object.keys(day.state.actions).filter(key => key.startsWith('acceptance:'));
  assert.equal(keys.length, 3, `one action per goal: ${keys.join(', ')}`);
});
