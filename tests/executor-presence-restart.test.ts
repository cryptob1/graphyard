import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Principal, Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import type { NextActionKind } from '../src/model/next-action.js';
import { describeUnserved, executorRegistry, executorReport } from '../src/model/executor-presence.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import { executorEffects, type ExecutorEffects } from '../src/auto-dispatch.js';
import { releaseGuardedEffects } from '../src/executor.js';
import { actionRoutes } from '../src/server/routes/actions.js';
import { matchRoute, type RouteContext } from '../src/server/routes.js';

/**
 * GY-1288: three configuration faults at one instant, 2026-10-05T09:43:15.274Z — "Nothing can run
 * dispatch" (GY-1287), "approve-scope" (GY-1286) and "request-review" (GY-1238), each saying no
 * executor is alive. The fleet was alive. The main checkout moved at 09:37:39 and the loop's
 * self-upgrade restarted the executors (`restartExecutors`): its fence forbids every claim on the
 * host while it waits — up to 30s for announced claims, 120s for held ones (GY-916) and 120s for
 * the units to register again — and the one executor inside a long dispatch renewed its claim but
 * polled nothing. Presence was heard only from claim polls, so after the 120s liveness window the
 * control plane saw an empty fleet and every pending kind it served became one fault.
 *
 * Each test is named for the proof it produces: manual:fault-class-configuration. The executors are
 * driven through the shipped HTTP effects (`executorEffects`) and release guard into the shipped
 * action routes; only the engine's queue is a stub, since presence is judged beside it.
 */

const at = (time: string) => Date.parse(`2026-10-05T${time}Z`);
const kinds: NextActionKind[] = ['request-review', 'approve-scope', 'reclaim', 'verify-deployment', 'resync', 'dispatch'];
const host = 'vishrog', slot = (n: number) => `graphyard-master@${host}/${n}`;
const actor = { id: 'graphyard-master', role: 'coordinator' } as Principal;

const row = (key: string, kind: NextActionKind, requestedAt: string, state: 'pending' | 'claimed' = 'pending', claim: ActionRow['claim'] = null): ActionRow => ({
  id: key.replace(/\D/g, '').padStart(32, kind === 'dispatch' ? 'd' : kind === 'approve-scope' ? 'a' : 'e'), kind, work: `work-${key}`, key, inputs: { kind } as ActionRow['inputs'], gate: 'build', refusal: null,
  reason: `${key} needs ${kind}`, binding: 'b', requestedBy: 'graphyard', requestedAt: new Date(at(requestedAt)).toISOString(), state, claim, attempts: state === 'claimed' ? 1 : 0, history: [] });
const item = (key: string, rows: ActionRow[]) => ({ id: `work-${key}`, key, stage: 'build', actionQueue: { actions: rows, history: [] } }) as unknown as Work;

/** The long dispatch slot 2 was inside, and the rows that waited behind the restart, as the 09:43:15 instances name them. */
const running = row('GY-1279', 'dispatch', '09:37:20', 'claimed', { executor: slot(2), host, principal: actor.id, claimedAt: new Date(at('09:37:35')).toISOString(), expiresAt: new Date(at('09:39:35')).toISOString() } as ActionRow['claim']);
// The running dispatch is not judged: its claim is held, which is a fact of the queue, not of presence.
const queue = () => [
  item('GY-1287', [row('GY-1287', 'dispatch', '09:41:00')]), item('GY-1285', [row('GY-1285', 'dispatch', '09:42:00')]),
  item('GY-1286', [row('GY-1286', 'approve-scope', '09:41:10')]),
  item('GY-1238', [row('GY-1238', 'request-review', '09:42:00')]), item('GY-1236', [row('GY-1236', 'request-review', '09:42:30')]),
];
const instances = [
  { subject: 'GY-1287', text: 'Nothing can run dispatch: GY-1287 has waited 2m and 1 more for an executor that serves it, and no executor is alive. It is not queued behind other work — start an executor that serves dispatch: systemctl --user start graphyard-executor@1 on a coordinator host that declared executors (node scripts/graphyard-executor.mjs --install --count 1 declares one), or node scripts/graphyard-executor.mjs --kinds dispatch' },
  { subject: 'GY-1286', text: 'Nothing can run approve-scope: GY-1286 has waited 2m for an executor that serves it, and no executor is alive. It is not queued behind other work — start an executor that serves approve-scope: systemctl --user start graphyard-executor@1 on a coordinator host that declared executors (node scripts/graphyard-executor.mjs --install --count 1 declares one), or node scripts/graphyard-executor.mjs --kinds approve-scope' },
  { subject: 'GY-1238', text: 'Nothing can run request-review: GY-1238 has waited 1m and 1 more for an executor that serves it, and no executor is alive. It is not queued behind other work — start an executor that serves request-review: systemctl --user start graphyard-executor@1 on a coordinator host that declared executors (node scripts/graphyard-executor.mjs --install --count 1 declares one), or node scripts/graphyard-executor.mjs --kinds request-review' },
];

/** The engine beside the routes: an idle claim finds nothing, slot 2's first claim takes the dispatch, and its renewals hold it. */
function stubEngine() {
  let taken = false;
  return {
    claimNextAction: async (_actor: Principal, body: { executor?: string }) => {
      const action = body.executor === slot(2) && !taken ? running : null;
      if (action) taken = true;
      return { action, open: 0, at: new Date().toISOString() };
    },
    renewClaimedAction: async (_actor: Principal, id: string) => { assert.equal(id, running.id); return { action: running, work: { id: running.work, key: running.key } }; },
  };
}
/** The shipped HTTP effects, with fetch answered by the shipped action routes against the stub engine. */
function wired(engine: object): ExecutorEffects {
  const fetcher = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    for (const route of actionRoutes.routes) {
      const params = matchRoute(route, init.method, url.pathname);
      if (!params) continue;
      const context = { actor, url, services: { engine }, body: async () => Buffer.from(String(init.body ?? '')), idempotencyKey: () => 'key' } as unknown as RouteContext;
      try { return new Response(JSON.stringify(await route.handle(context, params)), { status: 200 }); }
      catch (error) { return new Response(JSON.stringify({ error: String(error) }), { status: 400 }); }
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }) as unknown as typeof fetch;
  return executorEffects({ url: 'https://graphyard.example', token: 'token', fetcher }, Object.fromEntries(kinds.map(kind => [kind, async () => `${kind} ran`])));
}

/**
 * The restart, replayed on a mocked clock: slot 1 polls at 09:37:30, slot 2 claims the long
 * dispatch at 09:37:35, the checkout moves at 09:37:39 and the fence stands from 09:37:45 to the
 * instant of the faults. Slot 1 asks to claim every 5s and slot 2 renews every 30s throughout.
 * `heard` false is the fleet as base heard it: the fenced claim and the renewal reach the control
 * plane as nothing at all.
 */
async function replay(heard: boolean) {
  mock.timers.enable({ apis: ['Date'], now: at('09:37:00') });
  try {
    const engine = stubEngine();
    const registry = executorRegistry(engine);
    const effects = wired(engine);
    let fence: object | null = null;
    const guarded = (name: string) => releaseGuardedEffects(heard ? effects : { ...effects, present: undefined }, { loaded: { commit: 'a'.repeat(40), dirty: false } as never, current: () => 'a'.repeat(40), standDown: () => {}, fenced: async () => fence });
    const one = guarded(slot(1)), two = guarded(slot(2));
    const step = (to: number) => mock.timers.setTime(to);
    step(at('09:37:30'));
    await one.claim({ host, executor: slot(1), kinds });
    step(at('09:37:35'));
    const claimed = await two.claim({ host, executor: slot(2), kinds });
    assert.equal(claimed.action?.key, 'GY-1279', 'slot 2 is inside the long dispatch');
    step(at('09:37:45'));
    fence = { id: 'restart', pid: 1, host, at: new Date().toISOString() };
    for (let time = at('09:37:45'); time <= at('09:43:15'); time += 5_000) {
      step(time);
      assert.deepEqual(await one.claim({ host, executor: slot(1), kinds }), { action: null, open: 0 }, 'a fenced executor claims nothing');
      if ((time - at('09:37:35')) % 30_000 === 0 && heard) await effects.renew!(running);
    }
    step(at('09:43:15.274'));
    const now = new Date();
    const report = executorReport(queue(), registry, now);
    const attention = describeUnserved(report).map(entry => ({ subject: entry.keys[0], text: entry.text }));
    return { report, faults: classifyAttention(attention).filter(entry => entry.faultClass === 'configuration') };
  } finally { mock.timers.reset(); }
}

for (const [index, instance] of instances.entries()) {
  test(`manual:fault-class-configuration — GY-1288 instance ${index + 1}, ${instance.subject} at 2026-10-05T09:43:15.274Z: a fleet behind the self-upgrade restart's fence is heard alive, so no "Nothing can run" fault is filed`, async () => {
    // The base: the restart silences the fleet, and the instance is reproduced word for word as a configuration fault.
    const base = await replay(false);
    assert.equal(base.report.live.length, 0, 'base hears nobody after the liveness window');
    const reproduced = base.faults.find(fault => fault.subject === instance.subject);
    assert.ok(reproduced, `${instance.subject} reproduces on the base hearing`);
    assert.equal(reproduced.text, instance.text);
    assert.equal(reproduced.kind, 'executor');
    // The candidate: the fenced claim is a presence poll and the renewal refreshes the busy slot.
    const candidate = await replay(true);
    assert.deepEqual(candidate.report.live.map(entry => entry.executor).sort(), [slot(1), slot(2)]);
    assert.deepEqual(candidate.report.served, [...kinds].sort());
    assert.deepEqual(candidate.report.unserved, [], 'every pending row waits its turn behind the restart, none is unserved');
    assert.equal(candidate.faults.find(fault => fault.subject === instance.subject), undefined, `${instance.subject} does not recur`);
  });
}

test('manual:fault-class-configuration — GY-1288: a fleet that really is silent is still reported, and presence never claims or outlives the window', async () => {
  mock.timers.enable({ apis: ['Date'], now: at('09:00:00') });
  try {
    const engine = stubEngine();
    const registry = executorRegistry(engine);
    const effects = wired(engine);
    // A presence poll is heard with the kinds it names, and claims nothing.
    assert.deepEqual(await effects.present!({ host, executor: slot(1), kinds: ['dispatch'] }), { observed: true, at: new Date().toISOString() });
    assert.deepEqual(registry.live(new Date()).map(entry => [entry.executor, entry.kinds, entry.claims]), [[slot(1), ['dispatch'], 0]]);
    // A presence poll naming a kind no executor may report is refused, as a claim naming it would be.
    await assert.rejects(effects.present!({ host, executor: slot(1), kinds: ['no-such-kind' as NextActionKind] }));
    // Past the window with nothing heard, the dispatch row is unserved again: presence is only ever a statement about now.
    mock.timers.setTime(at('09:02:01'));
    const report = executorReport([item('GY-1287', [row('GY-1287', 'dispatch', '09:00:30')])], registry, new Date());
    assert.equal(report.live.length, 0);
    assert.deepEqual(report.unserved.map(entry => entry.key), ['GY-1287']);
    // A renewal from an executor this process never heard poll is known by the kind it runs.
    await effects.renew!(running);
    assert.deepEqual(registry.live(new Date()).map(entry => [entry.executor, entry.kinds]), [[slot(2), ['dispatch']]]);
  } finally { mock.timers.reset(); }
});
