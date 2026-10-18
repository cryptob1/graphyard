import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { workerFastGates, workerFastGatesSentence, workerSyncSentence } from '../src/master/worker-fast-gates.js';
import { hour, minute } from './helpers/soak-world.js';
import { type Failover, FailoverWorld, api, failoverInstalled, principals, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1797, on the real loop over a simulated day: every worker dispatch goes through `dispatchWork`
 * on a real master root, and every request the launcher writes — first attempts and rework rounds
 * alike, once per dispatched item and again on each later attempt — names the fast mechanical
 * gates as one command line, after the sync instruction and before the complete instruction,
 * exactly once, when and only when the checkout the loop runs from carries every gate. The day's
 * items are all delivered through those requests with every system invariant holding: the
 * addition changes what a worker is told, never how the loop launches, supervises or lands it.
 */
soakControlPlanes('soak-worker-fast-gates', 444);

const gates = [...workerFastGates.tests, ...workerFastGates.scripts];
const plan = (items: number, rework: number[]) => ({ items, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(rework), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: items, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: items } });

/** Every request the real launcher wrote, read from the launch file its typed command line names. */
function capturing(world: FailoverWorld) {
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
  return requests;
}

/** The launcher's rework-decisions reads go to the master's configured URL; the day's plane answers them, as in tests/soak-rework-brief.test.ts. */
async function answeringDecisions<T>(url: string, body: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    const decisions = new RegExp(`^${url.replace(/[.]/g, '\\.')}/api/work/([^/]+)/decisions$`).exec(target);
    if (!decisions) return realFetch(input, init);
    return new Response(JSON.stringify(await api(principals.operatorAgent, 'GET', `work/${decisions[1]}/decisions`)), { status: 200 });
  }) as typeof fetch;
  try { return await body(); } finally { globalThis.fetch = realFetch; }
}

test('unit:soak-invariants-hold — over a day on a checkout that carries the gates, every worker request of every attempt names the sync instruction, then the fast gates as one command line, then complete, each exactly once, every item is delivered and every invariant holds; on a checkout without them the same day\'s requests render as before', { timeout: 600_000 }, async () => {
  // A master root that carries every gate, as this repository's own checkout does: the launcher
  // reads them from the root it runs from, not from the repository's name.
  const { root, master } = await failoverInstalled();
  for (const gate of gates) { mkdirSync(dirname(join(root, gate)), { recursive: true }); writeFileSync(join(root, gate), ''); }
  const world = new FailoverWorld(new Set());
  const requests = capturing(world);
  const failover: Required<Failover> = { root, master, world, dispatches: [], samples: [], refused: [] };
  const { items, final, violations, failures, lost, sessions } = await answeringDecisions(master.url, () => simulateDay({ hours: 3, failover, plan: plan(5, [1, 3, 4]) }));
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered, the three sent back included');
  assert.deepEqual(violations, [], 'every system invariant holds across the day');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.equal(sessions.length, 5 + 3, 'five first attempts and three rework rounds');
  assert.equal(requests.length, sessions.length, 'one request per launched session');
  for (const item of items) {
    const theirs = requests.filter(request => request.key === item.key);
    assert.equal(theirs.length, [1, 3, 4].includes(items.indexOf(item) + 1) ? 2 : 1, `${item.key}: one request per attempt`);
    const sync = workerSyncSentence(master.cliPath, item.key);
    for (const [attempt, { text }] of theirs.entries()) {
      const label = `${item.key} attempt ${attempt + 1}`;
      // The request names the sync instruction, then the gates as one command line, then complete.
      const syncAt = text.indexOf(sync), gatesAt = text.indexOf(workerFastGatesSentence), completeAt = text.indexOf('--head as your last action');
      assert.ok(syncAt >= 0, `${label}: the request carries the sync instruction for this item and CLI`);
      assert.equal(syncAt + sync.length, gatesAt, `${label}: the gates sentence follows the sync instruction directly`);
      assert.ok(gatesAt < completeAt, `${label}: the gates sentence sits before the complete instruction`);
      assert.equal(text.split(workerFastGatesSentence).length - 1, 1, `${label}: the gates sentence appears exactly once`);
      assert.equal(text.split(sync).length - 1, 1, `${label}: the sync instruction appears exactly once`);
      for (const gate of gates) assert.equal(text.split(gate).length - 1, 1, `${label}: ${gate} is named exactly once`);
      // The first attempt carries no rework brief; the rework round carries its brief after the gates.
      if (attempt === 0) assert.doesNotMatch(text, /This attempt is a rework round/, `${label} is no rework round`);
      else assert.ok(text.indexOf('This attempt is a rework round') > gatesAt, `${label}: the rework brief follows the gates sentence`);
    }
  }

  // The same day on a checkout that carries no gate — any other managed repository — launches the
  // same attempts with requests that name neither the gates nor the sync instruction, so the
  // addition is read from the checkout at each launch and never from anything the item carries.
  const bare = await failoverInstalled();
  const bareWorld = new FailoverWorld(new Set());
  const bareRequests = capturing(bareWorld);
  const bareDay = await answeringDecisions(bare.master.url, () => simulateDay({ hours: 3, failover: { root: bare.root, master: bare.master, world: bareWorld, dispatches: [], samples: [], refused: [] }, plan: plan(5, [1, 3, 4]) }));
  assert.deepEqual(bareDay.final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered without the gates');
  assert.deepEqual(bareDay.violations, [], 'every system invariant holds without the gates');
  assert.deepEqual(bareDay.failures, [], 'no cycle failed without the gates');
  assert.equal(bareRequests.length, sessions.length, 'the same attempts were launched');
  for (const { key, text } of bareRequests) {
    assert.ok(!text.includes(workerFastGatesSentence) && !text.includes(` sync ${key} `) && gates.every(gate => !text.includes(gate)), `${key}: a request from a checkout without the gates names neither them nor the sync instruction`);
    assert.ok(text.includes(`status ${key} before editing. Work only in the current assigned worktree`), `${key}: the request keeps the pre-edit instruction with its one space`);
  }
});
