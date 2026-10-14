import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FleetClient } from '../src/fleet.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { readAccountStartFailures, readProfileLaunchRecords } from '../src/master/dispatch.js';
import { dispatchFailureBlockAfter } from '../src/daemon/dispatch-failures.js';
import { fleetIdleCause, maxAutomaticClears } from '../src/model/blocker-class.js';
import { hour, minute } from './helpers/soak-world.js';
import { FailoverWorld, failoverInstalled, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * Dispatch under failure: unbuildable worktrees, start failures per account, launches failing for
 * one cause, and a drained fleet. One concern of the release-candidate soak (GY-404), split per
 * concern (GY-1363) so concurrent changes stop colliding in one file: the world is
 * tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day itself
 * tests/helpers/soak-simulation.ts, and every suite asserts the system invariants after every
 * cycle.
 */
soakControlPlanes('soak-dispatch', 409);

test('unit:soak-invariants-hold — an item whose worktree the host cannot build for part of the day spends no attempt and cools no profile: it retries on a doubling backoff and is delivered, with every invariant holding', { timeout: 300_000 }, async () => {
  // GY-860 AC-2: the item's dispatch fails with a workspace failure — the real child runner's
  // message, carrying git's text — for its first hour. Each failure releases the claim with the
  // message, so the epoch comes back; the loop cools off no profile and retries on a doubling
  // backoff instead of every cycle. Once the host is repaired the item is dispatched and delivered.
  const n = 2, until = hour;
  const { items, final, violations, failures, lost, state, sessions, workspaceFailures, workspaceCooled, dayStart } = await simulateDay({
    hours: 6, workspaceFailure: { item: n, until },
    plan: { items: 4, leftovers: 1, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  const key = items[n - 1].key;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered, the one whose workspace failed included');
  assert.deepEqual(violations, [], 'every system invariant holds across the workspace failures');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');

  assert.ok(workspaceFailures.length >= 2, `the scenario ran: ${JSON.stringify(workspaceFailures)}`);
  // The epoch does not climb: every failed claim held the same epoch, and so did the delivering attempt.
  const epochs = new Set(workspaceFailures.map(entry => entry.epoch));
  assert.equal(epochs.size, 1, `each workspace failure handed the epoch back: ${[...epochs].join(', ')}`);
  assert.deepEqual(sessions.filter(session => session.key === key).map(session => session.epoch), [...epochs], 'the attempt that delivered it holds the epoch the failures handed back');
  // The profile stays in rotation: no cycle cooled one off for the workspace, and the profile that
  // failed is the one that later delivered.
  assert.deepEqual(workspaceCooled, [], 'no profile was cooled off for a workspace failure');
  const first = workspaceFailures[0];
  assert.ok(sessions.some(session => session.profile.name === first.profile && session.dispatchAt - dayStart > first.at), `${first.profile}, whose launch failed on the workspace, was dispatched to again`);
  // A doubling backoff, not a retry every cycle: the gaps between failures grow.
  const gaps = workspaceFailures.slice(1).map((entry, index) => entry.at - workspaceFailures[index].at);
  assert.ok(gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1]), `the retries back off: ${gaps.map(gap => Math.round(gap / minute)).join(', ')} min`);
  assert.ok(workspaceFailures.length <= 8, `an hour of failures is a handful of retries, not one per cycle: ${workspaceFailures.length}`);
  // The item's dispatch record keeps git's message.
  const failedRecord = Object.entries(state.actions).find(([action, entry]) => action.startsWith(`dispatch:${items[n - 1].id}:`) && /already used by worktree/.test(entry.detail));
  assert.ok(!failedRecord || /workspace could not be prepared/.test(failedRecord[1].detail), 'a kept failure record names the workspace, not the profile');
});

test('unit:soak-dispatch-start-failures — every invariant holds as start failures on the real dispatch path fall forward across the day, each item launched once per dispatch: three consecutive failures of one account across items raise one attention item, a later start on the account clears it, and every failed pane is closed at its bound', { timeout: 300_000 }, async () => {
  // GY-417: account failover and the failure ledger repeat per dispatch, so the real loop runs a
  // day whose every dispatch goes through `dispatchWork` on a master root whose OpenCode account's
  // runtime never comes up: each launch falls forward to the Claude account, is recorded, and is
  // bounded — the failed pane is closed at the start bound and the claim is released. The fourth
  // dispatch finds the account healthy: it starts, and the ledger and its attention item clear.
  const { root, master, profile } = await failoverInstalled();
  const world = new FailoverWorld(new Set(['opencode']));
  const { final, violations, failures, lost, reportedDispatches, sessions, failover } = await simulateDay({
    hours: 3, failover: { root, master, world, dispatches: [], samples: [] },
    plan: { items: 5, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 5, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 5 } },
  });
  assert.ok(failover, 'the day ran the failover scenario');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the real launches');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.equal(reportedDispatches, sessions.length, 'each settled dispatch launch was reported to a cycle');
  assert.equal(world.launched, 5, 'every item of the day was dispatched through the real path');
  assert.deepEqual(world.kinds, ['opencode', 'claude', 'opencode', 'claude', 'opencode', 'claude', 'opencode', 'opencode'],
    `three launches fell forward to the second account, the last two started on the preferred one: ${world.kinds.join(', ')}`);
  assert.equal(world.closedBrokenPanes, 3, 'each runtime that never started had its pane closed at the start bound');
  assert.equal(failover.dispatches.length, 5);

  // Every fallback dispatch named the account that failed and the one that took the launch.
  for (const [index, dispatched] of failover.dispatches.entries()) {
    if (index < 3) {
      assert.ok(dispatched.fallback!.note.startsWith('opencode-a failed to start: ') && dispatched.fallback!.note.endsWith('; launched on claude-b'), dispatched.fallback!.note);
      assert.equal(dispatched.account!.environment, 'claude-b');
    } else {
      assert.equal(dispatched.fallback, null, 'a dispatch whose preferred account starts records no fallback');
      assert.equal(dispatched.account!.environment, 'opencode-a');
    }
  }

  // The ledger grew one failure per launch across items, raised exactly one attention item at
  // three in a row — three items, still one item, never more — and cleared on the healthy start.
  const counts = failover.samples.map(sample => sample.failures['opencode-a']?.failures ?? 0);
  assert.deepEqual(counts, [1, 2, 3, 0, 0], `one consecutive failure per launch across items: ${counts.join(', ')}`);
  const raised = failover.samples.map(sample => sample.attention.items.length);
  assert.deepEqual(raised, [0, 0, 1, 0, 0], `one attention item, exactly at three consecutive failures: ${raised.join(', ')}`);
  assert.equal(new Set(failover.samples.map(sample => sample.key)).size, 5, 'the failing launches ran on different items');
  const attention = failover.samples[2].attention.items[0];
  assert.equal(attention.subject, 'opencode-a never starts');
  assert.ok(attention.text.includes('failed to start 3 launches in a row'), attention.text);
  assert.ok(attention.text.includes('opencode-a (runtime opencode)'), attention.text);
  const row = failover.samples[2].attention.rows[profile.name];
  assert.ok(row.fallback!.startsWith('opencode-a failed to start: ') && row.fallback!.endsWith('; launched on claude-b'), row.fallback!);
  assert.equal(failover.samples[3].attention.rows[profile.name].fallback, null, 'the healthy start turned the row\'s fallback off');

  // The last dispatch record and the ledger agree: the account started, nothing is held against it.
  const record = (await readProfileLaunchRecords(root, [profile]))[profile.name];
  assert.equal(record.account, 'opencode-a');
  assert.equal(record.runtime, 'opencode');
  assert.deepEqual(record.failedAccounts, []);
  assert.deepEqual(await readAccountStartFailures(master), {}, 'the healthy start cleared the account\'s run of failures');
});

test('unit:soak-dispatch-pi-fallback — every invariant holds as the registry sends each item to a Pi account first: Pi launches that never start fall forward to the strong account in the same dispatch, a healthy Pi account starts again and clears its run', { timeout: 300_000 }, async () => {
  // GY-1746: the worker role lists the strong account ahead of two Pi accounts, and the dispatch
  // path (`dispatchWork` -> the registry's choice) puts Pi first for a low or medium risk item. The
  // first three dispatches find Pi's runtime never coming up: each Pi account is recorded as
  // failed and the strong account takes the same dispatch. The fourth finds Pi healthy.
  const { root, master } = await failoverInstalled();
  const host = master.hostId ?? 'unknown-host', at = new Date().toISOString();
  let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', { runtimes: proposedRuntimes.filter(runtime => ['pi', 'claude'].includes(runtime.name)),
    models: [{ name: 'glm', id: 'zai/glm-5.3' }, { name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host, home: null } }, { name: 'pi-a', runtime: 'pi', model: 'glm', credential: { host, home: null } }],
    roles: [{ name: 'worker', accounts: ['claude-b', 'pi-a'], concurrency: 10 }], reason: 'fixture' }, { actor: 'operator', at }).registry;
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      const choice = chooseSession(registry, request, Date.now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const session: FleetSession = { id: `session-${registry.sessions.length + 1}`, role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: at, selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry = { ...registry, sessions: [...registry.sessions, session] };
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async (id, reason) => { registry = { ...registry, sessions: registry.sessions.map(session => session.id === id ? { ...session, endedAt: at, endReason: reason } : session) }; },
  };
  const world = new FailoverWorld(new Set(['pi']));
  const { final, violations, failures, lost, failover } = await simulateDay({
    hours: 3, failover: { root, master, world, dispatches: [], samples: [], probe: { registry: client, quota: false, cacheMs: 0 } as never, lane: 'low' },
    plan: { items: 5, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 5, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 5 } },
  });
  assert.ok(failover, 'the day ran the registry-backed scenario');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the Pi launches and their fallbacks');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(world.kinds, ['pi', 'claude', 'pi', 'claude', 'pi', 'claude', 'pi', 'pi'], `Pi is tried first for every item; three fell forward to the strong account and the last two started on Pi: ${world.kinds.join(', ')}`);
  assert.equal(world.closedBrokenPanes, 3, 'each Pi runtime that never started had its pane closed at the start bound');
  assert.deepEqual(failover.samples.map(sample => sample.failures['pi-a']?.failures ?? 0), [1, 2, 3, 0, 0], 'the account records one failure per launch and the healthy start clears them');
  assert.deepEqual(failover.dispatches.map(dispatched => dispatched.account!.environment), ['claude-b', 'claude-b', 'claude-b', 'pi-a', 'pi-a']);
  assert.deepEqual(await readAccountStartFailures(master), {}, 'the healthy start cleared the account\'s run of failures');
});

test('unit:soak-dispatch-preference-by-risk — every invariant holds as the registry sends each item by the risk class of its planned change and never by its lane: a sensitive planned path rides the strong account although the Pi account is eligible and healthy all day, and a normal plan rides Pi even from a high lane', { timeout: 300_000 }, async () => {
  // GY-1772: the preference the dispatch path computes (`workerPreference` in `dispatchWork`, the
  // registry's `workerOrder` on its answer) reads the item's `plannedFiles` against the risk class's
  // sensitive rules and never the lane, per item and per cycle. Every item here plans its change
  // before any launch and Pi stays healthy and eligible throughout, so the account each dispatch
  // starts is the preference's own answer: items 1, 2 and 5 plan a sensitive path (persistence,
  // migrations, deployment) and ride the strong account although Pi could have taken them; items 3
  // and 4 plan normal files and start on Pi — item 3 with its dispatch call overridden to the high
  // lane (the override shapes what `dispatchWork` is handed, not the lane the day's stamping stores,
  // which the assertions below read), item 4 as the day's unknown-change observations stamp one
  // anyway. An item that plans no files is judged the same worst case by the unit suite; a day
  // cannot deliver one, since nothing outside an empty plan may change, so the sensitive plans
  // stand for the class here.
  const { root, master } = await failoverInstalled();
  const host = master.hostId ?? 'unknown-host', at = new Date().toISOString();
  let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', { runtimes: proposedRuntimes.filter(runtime => ['pi', 'claude'].includes(runtime.name)),
    models: [{ name: 'glm', id: 'zai/glm-5.3' }, { name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host, home: null } }, { name: 'pi-a', runtime: 'pi', model: 'glm', credential: { host, home: null } }],
    roles: [{ name: 'worker', accounts: ['claude-b', 'pi-a'], concurrency: 10 }], reason: 'fixture' }, { actor: 'operator', at }).registry;
  const asked: { work: string | null; prefer: 'fast' | 'strong' | undefined; account: string | null }[] = [];
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      const choice = chooseSession(registry, request, Date.now());
      asked.push({ work: request.work, prefer: request.prefer, account: choice.account?.name ?? null });
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const session: FleetSession = { id: `session-${registry.sessions.length + 1}`, role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: at, selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry = { ...registry, sessions: [...registry.sessions, session] };
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async (id, reason) => { registry = { ...registry, sessions: registry.sessions.map(session => session.id === id ? { ...session, endedAt: at, endReason: reason } : session) }; },
  };
  const world = new FailoverWorld(new Set());
  const { items, final, violations, failures, lost, failover } = await simulateDay({
    hours: 3, failover: { root, master, world, dispatches: [], samples: [], probe: { registry: client, quota: false, cacheMs: 0 } as never,
      plannedFiles: { 1: ['src/store/soak-item-1.ts'], 2: ['src/soak/item-2.ts', 'migrations/schema/0042_soak.sql'], 5: ['deploy/soak-item-5.env'] }, lanes: { 3: 'high', 4: 'high' } },
    plan: { items: 5, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 5, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 5 } },
  });
  assert.ok(failover, 'the day ran the registry-backed scenario');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the risk-class selections');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(new Set(failover.dispatches.map(dispatched => dispatched.work)), new Set(items.map(item => item.key)), 'each item was dispatched exactly once');
  assert.equal(world.closedBrokenPanes, 0, 'no pane was closed for a failed start: every ordered account started');
  // One launch per dispatch, on the runtime the preference ordered: a strong plan's account is the
  // strong runtime, a fast plan's is Pi. The strong items queue on the strong account while it is
  // busy, so the day dispatches them in whatever order the account frees; the selection is what
  // must not vary.
  assert.equal(world.kinds.length, failover.dispatches.length, 'each dispatch launched exactly one session');
  for (const [index, dispatched] of failover.dispatches.entries()) {
    assert.equal(dispatched.account!.prefer, dispatched.work === items[0].key || dispatched.work === items[1].key || dispatched.work === items[4].key ? 'strong' : 'fast', `${dispatched.work} was sent by its planned change's class`);
    assert.equal(dispatched.account!.environment, dispatched.account!.prefer === 'strong' ? 'claude-b' : 'pi-a', `${dispatched.work} started on the account the preference ordered`);
    assert.equal(world.kinds[index], dispatched.account!.prefer === 'strong' ? 'claude' : 'pi', `${dispatched.work} launched the ${world.kinds[index]} runtime the preference ordered`);
    assert.equal(dispatched.fallback, null, `${dispatched.work} fell forward to no second account`);
  }
  // The registry was asked once per item with exactly the preference the plan's class gives, and
  // the strong asks found Pi eligible all the same: the same healthy account takes the fast items
  // the same day, so strong was a choice, never a shortage.
  for (const [n, prefer] of [[1, 'strong'], [2, 'strong'], [3, 'fast'], [4, 'fast'], [5, 'strong']] as const) {
    const request = asked.find(entry => entry.work === items[n - 1].key);
    assert.ok(request, `the registry was asked for ${items[n - 1].key}`);
    assert.equal(request!.prefer, prefer, `${items[n - 1].key} was asked with preference ${prefer}`);
  }
  // The lane never decided: both fast items rode a high lane on a normal plan and still took Pi. The
  // stored lane read here is the day's stamping for both; item 3's `lanes` override only shaped the
  // item handed to `dispatchWork`, which is where the preference would have read it had it read lanes.
  for (const n of [3, 4]) assert.equal(final.find(item => item.key === items[n - 1].key)!.lane, 'high', `${items[n - 1].key} rode a high lane and still started on Pi`);
  // The last dispatch record names the preference that ordered its accounts, beside the account it chose.
  const last = failover.dispatches.at(-1)!;
  const record = (await readProfileLaunchRecords(root, [{ name: 'soak-failover' }]))['soak-failover'];
  assert.equal(record.key, last.work);
  assert.equal(record.prefer, last.account!.prefer, 'the launch record keeps the preference the dispatch judged');
  assert.equal(record.account, last.account!.environment);
  assert.deepEqual(record.failedAccounts, []);
});

test('unit:soak-invariants-hold — launches that keep failing for one cause are blocked after three with git\'s error named, a refused block is asked for again only after its backoff, the item is dispatched again once unblocked, an item failing for changing causes is never blocked, and every invariant holds', { timeout: 300_000 }, async () => {
  // GY-1078: a launch whose worktree cannot be created spends an epoch and fails with git's stderr.
  // The loop counts consecutive failures of one item with one cause across epochs, records the
  // cause as the item's blocker through the real `dispatchblock` command at the third, and stops
  // dispatching it until the operator clears the blocker. The run, the escalation record and the
  // blocker request repeat per item and per cycle, so they live here.
  const constant = 2, changing = 3, unblockAfterMs = 20 * minute;
  const { items, final, violations, failures, lost, state, failing } = await simulateDay({
    hours: 3, dispatchFailing: { constant, changing, refuseBlocks: 1, unblockAfterMs },
    plan: { items: 4, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  assert.deepEqual(violations, [], 'every system invariant holds across the failing launches, the blocker and the unblock');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered, both failing ones included');

  // The constant item: exactly three failed launches, one blocker, nothing dispatched while it stood.
  const held = items[constant - 1], launches = failing.launches.filter(entry => entry.key === held.key);
  const failed = launches.filter(entry => entry.failure !== null);
  assert.equal(failed.length, dispatchFailureBlockAfter, `three failed launches before the blocker: ${launches.map(entry => `${entry.epoch}:${entry.failure ? 'failed' : 'launched'}`).join(', ')}`);
  assert.deepEqual(new Set(failed.map(entry => entry.epoch)).size, failed.length, 'each failed launch spent its own epoch');
  const blocks = failing.blocks.filter(entry => entry.key === held.key);
  assert.deepEqual(blocks.map(entry => entry.refused), [true, false], 'one refused block request, then one that recorded the blocker: never one per cycle');
  assert.ok(blocks[1].at - blocks[0].at >= 5 * minute, `the refused block was asked for again only after its backoff: ${(blocks[1].at - blocks[0].at) / minute} min`);
  assert.match(blocks[1].reason, new RegExp(`Dispatch failed 3 consecutive times with the same cause since .*so the master loop stopped redispatching ${held.key}: Worker launch failed: the worktree for ${held.key} epoch N could not be created: .*fatal: 'graphyard/${held.key.toLowerCase()}-N' is already used by worktree`), 'the blocker names the cause in git\'s words');
  const escalations = Object.entries(state.actions).filter(([key]) => key.startsWith(`escalation:dispatch-failures:${held.id}:`));
  assert.deepEqual(escalations.map(([, action]) => [action.state, action.attempts]), [['done', 2]], 'one escalation record for the run, counting the refusal and the block');
  assert.ok(failing.blockedAt !== null && failing.unblocked !== null, 'the blocker was sighted and cleared');
  assert.ok(failing.blockedAt! - blocks[1].at < 2 * minute, 'the blocker landed on the item the cycle it was accepted');
  assert.deepEqual(launches.filter(entry => entry.at > blocks[0].at && entry.at < failing.unblocked!), [], 'nothing launched the item while it was held or blocked');
  const resumed = launches.filter(entry => entry.at >= failing.unblocked!);
  assert.equal(resumed.length, 1, 'one launch once the blocker cleared');
  assert.equal(resumed[0].failure, null, 'and it succeeded');

  // The changing item: four failures, each a different cause, so no run reached the bound.
  const varied = items[changing - 1], theirs = failing.launches.filter(entry => entry.key === varied.key);
  assert.deepEqual(theirs.map(entry => entry.failure !== null), [true, true, true, true, false], 'four failed launches with changing causes, then one that launched');
  assert.deepEqual(failing.blockerSeen.filter(entry => entry.key === varied.key), [], 'the item failing for changing causes was never blocked');
  assert.deepEqual(failing.blocks.filter(entry => entry.key === varied.key), [], 'and no block was ever asked for it');
  assert.equal(Object.keys(state.actions).filter(key => key.startsWith(`escalation:dispatch-failures:${varied.id}:`)).length, 0);
  assert.deepEqual(state.dispatchFailures, {}, 'every failure run was retired: by the blocker, or by the launch that landed');
});

test('unit:soak-invariants-hold — a fleet drained into finished sessions holding every profile name still dispatches: each launch closes the finished session it takes the name from, no profile name ever has two live panes, no dispatch block is recorded on the fleet-idle cause, a fleet-idle dispatch-failure blocker clears once a profile is launchable, and every invariant holds', { timeout: 300_000 }, async () => {
  // GY-1322: the pane close a dispatch makes over a finished, unowned session repeats per item
  // dispatched, and the dispatch-failure blocker probe repeats per cycle per blocked item, so both
  // live here. Every attempt's session is also left finished in its pane, so the fleet drains
  // again after every submission and the next dispatch onto that profile reclaims it.
  const finishAt = 20 * minute, seeded = 1;
  const { final, violations, failures, lost, state, drain, items, launches, dayStart, herdr } = await simulateDay({
    hours: 4, drained: { finishAt, seeded },
    plan: { items: 5, releaseEveryMs: 3 * minute, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  assert.deepEqual(violations, [], 'every system invariant holds across the drain, the reclaims and the cleared blocker');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered, the seeded one included');
  assert.ok(launches.length >= items.length, 'every item was dispatched');

  // Nothing launched while every profile's holder was working; the first launches closed the finished holders.
  assert.ok(launches.every(at => at - dayStart >= finishAt), 'nothing launched while every profile name was held by a working session');
  assert.ok(drain.reclaimed.length > 0 && drain.reclaimed.every(entry => entry.at >= finishAt), `every reclaim came after the fleet finished: ${drain.reclaimed.map(entry => `${entry.key}@${entry.at / minute}m`).join(', ')}`);
  assert.ok(drain.reclaimed.every(entry => entry.status === 'idle' || entry.status === 'done'), 'only finished sessions were closed');
  assert.ok(drain.holders.every(pane => drain.reclaimed.some(entry => entry.pane === pane)), `every drained holder was closed by the dispatch that took its name: ${drain.reclaimed.map(entry => entry.pane).join(', ')}`);
  assert.equal(herdr.agents.size, 0, 'no finished session outlived the day');
  assert.equal(new Set(drain.reclaimed.map(entry => entry.pane)).size, drain.reclaimed.length, 'each finished session was closed once');
  assert.ok(drain.peakPerName <= 1, `no profile name ever had two live panes (peak ${drain.peakPerName})`);

  // No dispatch block on the fleet-idle cause, and the seeded blocker cleared through the loop's probe.
  assert.deepEqual(drain.blocks, [], 'the loop never asked to block an item on the drain');
  assert.deepEqual(state.dispatchFailures, {}, 'no dispatch-failure run was kept');
  assert.ok(drain.seededAt !== null && drain.clearedAt !== null, 'the seeded blocker was recorded and cleared');
  // The drain's own cycle hands every reclaimed profile to a waiting item, so the next profile free
  // is the first one a submission leaves: the launch onto it shows when one was.
  const freed = launches.map(at => at - dayStart).find(at => at > finishAt + minute)!;
  assert.ok(drain.clearedAt! > finishAt, `the blocker stood while no profile could launch (cleared at ${drain.clearedAt! / minute} min)`);
  assert.ok(drain.clearedAt! - freed <= 3 * minute, `and cleared within a few cycles of a profile coming free at ${freed / minute} min (${drain.clearedAt! / minute} min)`);
  const seededItem = final.find(item => item.id === items[seeded - 1].id)!;
  assert.ok((seededItem.blockerProbe?.clears ?? 0) <= maxAutomaticClears, 'cleared within the automatic-clear bound');
  assert.equal(seededItem.blockerProbe?.class, 'dispatch-failure', 'the probe that cleared it was the dispatch-failure class');
  assert.ok(fleetIdleCause(seededItem.blockerProbe!.blocker), 'and the blocker it cleared was on the fleet-idle cause');
});
