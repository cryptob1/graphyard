import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { api, principals, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';
import { acceptancePollMs } from '../src/daemon/acceptance.js';
import { planPollMs, planRetryMs, planStepRetryMs } from '../src/daemon/planner.js';
import { plannedWork } from './helpers/soak-planner.js';
import type { Goal } from '../src/model/goal.js';

/**
 * The acceptance role (GY-1417) across a day of the real loop: goals drafted, judged, landed by the
 * control plane and recorded, through failures that must converge. One concern of the release-candidate soak
 * (GY-404), split per concern (GY-1363): the world is tests/helpers/soak-world.ts, the control
 * planes tests/helpers/soak-plane.ts, the day itself tests/helpers/soak-simulation.ts (its
 * acceptanceWorld holds this day's goals), and every suite asserts the system invariants after
 * every cycle.
 */
soakControlPlanes('soak-acceptance', 411);

test('unit:soak.acceptance-goals — across a day the loop drives three goals to planning: one draft run per revision, a failed open or post retried with the same draft and pull request, a refused or closed-unmerged draft closed and drafted again, a failed run retried after an hour, a conflicting approved draft reopened from the current base without another run, landing asked at most once per poll interval, pull requests read at most once per poll interval, and every invariant holding', { timeout: 600_000 }, async () => {
  const day = await simulateDay({
    hours: 6, acceptance: true,
    plan: { items: 4, leftovers: 1, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  const { violations, failures, lost, state } = day;
  const acceptance = day.acceptanceDay!;
  assert.deepEqual(violations, [], 'every system invariant holds while goals move');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');

  // Every goal reached planning (GY-1418): its acceptance pull request merged and its cases are protected.
  const goals = (await api(principals.coordinator, 'GET', 'goals')).goals as Goal[];
  const goal = (name: string) => goals.find(entry => entry.key === acceptance.goals[name])!;
  for (const name of ['signup', 'billing', 'audit']) {
    assert.equal(goal(name).stage, 'planning', `${name} was handed to the planner: ${goal(name).stage}`);
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
  // Its approved pull request conflicted with the base, so the same outcomes were opened again from the current base and judged again, with no other draft run.
  assert.equal(opens('audit').length, 2); assert.equal(runs('audit', 'judge').length, 2);
  assert.match(goal('audit').refusal?.reason ?? '', /conflicts with main/);
  assert.deepEqual(((await api(principals.coordinator, 'GET', `goals/${goal('audit').key}`)).history as { kind: string }[]).map(entry => entry.kind), ['goal.recorded', 'goal.draft', 'goal.approve', 'goal.closed', 'goal.draft', 'goal.approve', 'goal.merged']);

  // Landing was asked of each approved pull request at most once per poll interval, and each pull request was read at most once per poll interval.
  assert.equal(new Set(acceptance.lands.map(entry => entry.pr)).size, 5, 'three goals, billing\'s and audit\'s second pull requests');
  for (const [entries, what] of [[acceptance.reads, 'read'], [acceptance.lands, 'landed']] as const) {
    const byPull = new Map<number, number[]>();
    for (const entry of entries) byPull.set(entry.pr, [...byPull.get(entry.pr) ?? [], entry.at]);
    for (const [pr, times] of byPull) times.slice(1).forEach((at, index) => assert.ok(at - times[index] >= acceptancePollMs, `#${pr} was ${what} again after ${at - times[index]} ms`));
  }
  assert.ok(acceptance.reads.length <= 6 * hour / acceptancePollMs * 2, `the pull request reads stay bounded: ${acceptance.reads.length}`);
  // Nothing is left behind: no acceptance pull request is open, and each goal has one action whose detail moved with it.
  assert.deepEqual([...acceptance.pulls].filter(([, pull]) => pull.state === 'open').map(([pr]) => pr), [], 'no acceptance pull request is left open');
  const keys = Object.keys(state.actions).filter(key => key.startsWith('acceptance:'));
  assert.equal(keys.length, 3, `one action per goal: ${keys.join(', ')}`);
});

test('unit:soak.planner-goals — across a day the loop plans, judges, releases and delivers three merged goals: one plan run per plan, a plan refused before approval planned again after an hour, one judgement per posted plan, an approver refusal planned again, a release that died after creating an item retried without making it twice, items dispatched only after the items they depend on are done, delivery asked at most once per poll interval, and every invariant holding', { timeout: 600_000 }, async () => {
  const day = await simulateDay({
    hours: 14, acceptance: true, planner: true,
    plan: { items: 4, leftovers: 1, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  const { violations, failures, lost, state } = day;
  const goalsOf = day.acceptanceDay!.goals, planner = day.plannerDay!;
  assert.deepEqual(violations, [], 'every system invariant holds while goals are planned and delivered');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');

  const goals = (await api(principals.coordinator, 'GET', 'goals')).goals as Goal[];
  const goal = (name: string) => goals.find(entry => entry.key === goalsOf[name])!;
  const history = async (name: string) => ((await api(principals.coordinator, 'GET', `goals/${goal(name).key}`)).history as { kind: string; at?: string }[]).map(entry => entry.kind);
  const runs = (name: string, role: 'plan' | 'judge') => planner.runs.filter(run => run.goal === name && run.role === role);
  const work = await plannedWork(goalsOf);
  for (const name of ['signup', 'billing', 'audit']) {
    assert.equal(goal(name).stage, 'delivered', `${name} was delivered: ${goal(name).stage} ${JSON.stringify(state.actions[`planner:${goal(name).id}`]?.detail)}`);
    assert.notEqual(goal(name).plan!.author, goal(name).planApproval!.by, 'the author never judged its own plan');
    // Approval gates creation: every item was created after the approval, once, and carries its planned dependencies.
    assert.equal(work[name].length, goal(name).plan!.items.length, `${name}'s released plan made each item once: ${work[name].map(item => item.key).join(', ')}`);
    for (const item of work[name]) {
      assert.ok(Date.parse(item.createdAt) >= Date.parse(goal(name).planApproval!.at), `${item.key} was created after the plan was approved`);
      assert.equal(item.stage, 'done', `${item.key} is done`);
    }
    assert.deepEqual(goal(name).items!.map(entry => entry.key).sort(), work[name].map(item => item.key).sort());
  }

  // signup: its first plan let parallel items share a file, so it was refused before any approver saw it and planned again an hour later.
  const signupPlans = runs('signup', 'plan');
  assert.equal(signupPlans.length, 2, 'one run for the refused plan, one for the plan posted');
  assert.ok(signupPlans[1].at - signupPlans[0].at >= planRetryMs, 'a plan refused before approval is planned again after an hour, not every cycle');
  assert.equal(runs('signup', 'judge').length, 1, 'the refused plan was never judged');
  assert.equal(goal('signup').planDrafts, 1);
  // Its first release died after the control plane created the first item; the retry came ten minutes later and found that item.
  const releases = planner.releases.filter(entry => entry.goal === 'signup');
  assert.deepEqual(releases.map(entry => entry.ok), [false, true]);
  assert.ok(releases[1].at - releases[0].at >= planStepRetryMs, 'a failed release is asked again after ten minutes');
  // ui depends on api, so it was dispatched only once api was done.
  const [apiItem, ui] = ['api', 'ui'].map(ref => work.signup.find(item => item.key === goal('signup').items!.find(entry => entry.ref === ref)!.key)!);
  assert.deepEqual(ui.dependencies, [apiItem.id]);
  const dispatched = day.sessions.filter(session => session.key === ui.key).map(session => session.dispatchAt);
  assert.ok(dispatched.length && Math.min(...dispatched) >= Date.parse(apiItem.stageEnteredAt), `${ui.key} was dispatched only after ${apiItem.key} was done`);
  // billing: the approver refused its first plan, so it was planned and judged again.
  assert.equal(runs('billing', 'plan').length, 2); assert.equal(runs('billing', 'judge').length, 2);
  assert.equal(goal('billing').planDrafts, 2); assert.equal(goal('billing').planRefusal?.by, principals.approver.id);
  // audit: one plan, one judgement, one release, two parallel items with no dependency.
  assert.equal(runs('audit', 'plan').length, 1); assert.equal(runs('audit', 'judge').length, 1);
  assert.ok(work.audit.every(item => !item.dependencies.length));
  assert.deepEqual(await history('audit'), ['goal.recorded', 'goal.draft', 'goal.approve', 'goal.closed', 'goal.draft', 'goal.approve', 'goal.merged', 'goal.plan', 'goal.plan-approve', 'goal.released', 'goal.deliver']);
  // One plan run per plan revision and one judgement per posted plan, everywhere.
  for (const role of ['plan', 'judge'] as const) {
    const seen = planner.runs.filter(run => run.role === role).map(run => `${run.goal}:${run.revision}`);
    assert.equal(new Set(seen).size + (role === 'plan' ? 1 : 0), seen.length, `one ${role} run per revision but signup's refused plan: ${seen.join(', ')}`);
  }
  // Delivery was asked once every item was served, each request at most once per poll interval: signup's failed request came back five minutes later.
  for (const name of ['signup', 'billing', 'audit']) {
    const asks = planner.delivers.filter(entry => entry.goal === name);
    assert.equal(asks.length, name === 'signup' ? 2 : 1, `${name} asked delivery ${asks.length} times`);
    asks.slice(1).forEach((entry, index) => assert.ok(entry.at - asks[index].at >= planPollMs, `${name}'s delivery was asked again after ${entry.at - asks[index].at} ms`));
  }
  const keys = Object.keys(state.actions).filter(key => key.startsWith('planner:'));
  assert.equal(keys.length, 3, `one planner action per goal: ${keys.join(', ')}`);
});
