import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planeWideFailure } from '../src/model/blocker-class.js';
import { hour, minute } from './helpers/soak-world.js';
import { type Failover, FailoverWorld, api, failoverInstalled, principals, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1569, on the real loop over a simulated day: every worker dispatch goes through `dispatchWork`
 * on a real master root, and every rework round reads the item's decisions before anything is
 * claimed and carries the applied rework decision's reason in its worker's request. The round's
 * grounds reach the worker, so no coordinator has to restate them as a criterion (the review-stage
 * scope widening GY-1543 and GY-1519 needed). A decisions read the plane fails refuses that launch
 * before any claim, cools nothing, counts toward no blocker, and the round is launched again with
 * its brief: no rework round ever starts without the reason it was sent back for.
 */
soakControlPlanes('soak-rework-brief', 424);

const plan = (items: number, rework: number[]) => ({ items, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(rework), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: items, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: items } });

test('unit:soak-invariants-hold — every rework round of the day reads its decisions once before claiming and its worker\'s request carries the applied rework decision\'s reason; the one decisions read the plane fails refuses that launch before any claim, cools no profile, counts toward no blocker, and the round is launched again with its brief and delivered, with every invariant holding', { timeout: 300_000 }, async () => {
  const { root, master } = await failoverInstalled();
  const world = new FailoverWorld(new Set());
  // Every request the real launcher wrote, read from the launch files its typed command line names.
  const requests: { key: string; text: string }[] = [];
  const run = world.run;
  world.run = (command, args) => {
    if (command === 'herdr' && args[0] === 'pane' && args[1] === 'run') {
      const stem = /^GY=('?)([^';]+)\1;/.exec(args[3])?.[2];
      const text = stem ? readFileSync(`${stem}.request`, 'utf8') : '';
      requests.push({ key: /\bImplement (GY-\d+):/.exec(text)?.[1] ?? '', text });
    }
    return run(command, args);
  };
  // The launcher's decisions reads go to the master's configured URL; the day's plane answers them,
  // failing the first with a 503 as a read meets while the plane restarts.
  const reads: { id: string; at: number; failed: boolean }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    const decisions = new RegExp(`^${master.url.replace(/[.]/g, '\\.')}/api/work/([^/]+)/decisions$`).exec(target);
    if (!decisions) return realFetch(input, init);
    const failed = !reads.length;
    reads.push({ id: decodeURIComponent(decisions[1]), at: Date.now(), failed });
    if (failed) return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
    return new Response(JSON.stringify(await api(principals.operatorAgent, 'GET', `work/${decisions[1]}/decisions`)), { status: 200 });
  }) as typeof fetch;
  const failover: Required<Failover> = { root, master, world, dispatches: [], samples: [], refused: [] };
  let day: Awaited<ReturnType<typeof simulateDay>>;
  try { day = await simulateDay({ hours: 3, failover, plan: plan(5, [1, 3, 4]) }); }
  finally { globalThis.fetch = realFetch; }
  const { items, final, violations, failures, lost, state, sessions } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered, the three sent back included');
  assert.deepEqual(violations, [], 'every system invariant holds across the rework rounds and the refused read');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');

  const reworked = [1, 3, 4].map(n => items[n - 1]);
  // Reads are bounded by rework launches: none for a first attempt, none per cycle.
  assert.deepEqual(new Set(reads.map(read => read.id)), new Set(reworked.map(item => item.id)), 'only the items sent back had their decisions read');
  assert.equal(reads.length, reworked.length + 1, `one read per rework launch, the refused one included: ${reads.length}`);

  // The refused read: before the claim, in the plane's words, as a plane-wide failure.
  assert.equal(failover.refused.length, 1, JSON.stringify(failover.refused));
  const [refused] = failover.refused;
  assert.match(refused.error, /^the rework decisions of GY-\d+ could not be read from https:\/\/graphyard\.example\/api\/work\/[^/]+\/decisions \(HTTP 503\), so the launch is refused before anything is claimed rather than starting a rework round without the reason it was sent back for/);
  assert.ok(planeWideFailure(refused.error), 'the loop reads the refusal as a plane-wide failure');
  assert.deepEqual(state.dispatchFailures, {}, 'a plane-wide refusal counts toward no dispatch-failure run');
  assert.equal(world.launched, 5 + reworked.length + 1, 'five first attempts, three rework rounds, and the one refused launch');
  assert.equal(sessions.length, 5 + reworked.length, 'the refused launch started no session');

  // Every first attempt's request carries no brief; every rework round's carries its applied decision's reason.
  for (const item of items) {
    const theirs = requests.filter(request => request.key === item.key);
    assert.doesNotMatch(theirs[0].text, /This attempt is a rework round/, `${item.key}'s first attempt is no rework round`);
    if (!reworked.includes(item)) { assert.equal(theirs.length, 1, `${item.key} was launched once`); continue; }
    assert.equal(theirs.length, 2, `${item.key}: a first attempt and one rework round, never a round launched without its brief`);
    const applied = ((await api(principals.operatorAgent, 'GET', `work/${item.id}/decisions`)).decisions as { action: string; state: string; reason: string; approvedAt: string }[])
      .filter(decision => decision.action === 'rework' && decision.state === 'applied').sort((a, b) => Date.parse(a.approvedAt) - Date.parse(b.approvedAt));
    assert.equal(applied.length, 1, `${item.key} was sent back by one applied rework decision`);
    assert.match(theirs[1].text, /This attempt is a rework round of PR #\d+ at head [0-9a-f]{12}\./);
    assert.ok(theirs[1].text.includes(`sent it back for this reason, which is this round's brief: ${applied[0].reason.trim()}`), `${item.key}'s rework round carries the decision's reason: ${theirs[1].text.slice(0, 400)}`);
  }
  // The refused item's round was launched after the refusal, at the epoch its first attempt left.
  const retried = sessions.filter(session => session.work === reads[0].id);
  assert.equal(retried.length, 2, 'the refused item ran its first attempt and one rework round');
  assert.ok(retried[1].dispatchAt > reads[0].at, 'its rework round came after the refused read');
});
