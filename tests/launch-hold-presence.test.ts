import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Principal, Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import type { NextActionKind } from '../src/model/next-action.js';
import { describeUnserved, executorRegistry, executorReport } from '../src/model/executor-presence.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import { executorEffects, launchingKinds, runExecutorTick, type ExecutorEffects } from '../src/auto-dispatch.js';
import { actionRoutes } from '../src/server/routes/actions.js';
import { matchRoute, type RouteContext } from '../src/server/routes.js';

/**
 * GY-1539: while the GY-612 launch hold stood, the claim poll named only the non-launching kinds and
 * the control plane recorded exactly those as the executor's presence, so the fleet report filed
 * "Nothing can run dispatch/request-review" although both slots serve them. The poll now names what
 * the executor serves beside what it may claim, and presence records the former.
 */
const host = 'vishrog', slot = (n: number) => `graphyard-master@${host}/${n}`;
const actor = { id: 'graphyard-master', role: 'coordinator' } as Principal;
const served: NextActionKind[] = ['request-review', 'approve-scope', 'reclaim', 'verify-deployment', 'resync', 'dispatch'];
const row = (key: string, kind: NextActionKind): ActionRow => ({ id: key.replace(/\D/g, '').padStart(32, 'd'), kind, work: `work-${key}`, key, inputs: { kind } as ActionRow['inputs'], gate: 'build', refusal: null,
  reason: `${key} needs ${kind}`, binding: 'b', requestedBy: 'graphyard', requestedAt: new Date(Date.now() - 120_000).toISOString(), state: 'pending', claim: null, attempts: 0, history: [] });
const item = (key: string, kind: NextActionKind) => ({ id: `work-${key}`, key, stage: 'build', actionQueue: { actions: [row(key, kind)], history: [] } }) as unknown as Work;

function plane(wired: NextActionKind[]) {
  const polls: { kinds?: NextActionKind[]; serves?: NextActionKind[] }[] = [];
  const engine = { claimNextAction: async (_actor: Principal, body: { kinds?: NextActionKind[]; serves?: NextActionKind[] }) => { polls.push(body); return { action: null, open: 0, at: new Date().toISOString() }; } };
  const fetcher = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    for (const route of actionRoutes.routes) {
      const params = matchRoute(route, init.method, url.pathname);
      if (!params) continue;
      const context = { actor, url, services: { engine }, body: async () => Buffer.from(String(init.body ?? '')), idempotencyKey: () => 'key' } as unknown as RouteContext;
      return new Response(JSON.stringify(await route.handle(context, params)), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const effects: ExecutorEffects = { ...executorEffects({ url: 'https://graphyard.example', token: 't', fetcher }, Object.fromEntries(wired.map(kind => [kind, async () => 'ran']))), launchHold: async () => 'host vishrog is below its memory floor' };
  return { engine, effects, polls };
}

test('unit:launch-hold-serves-kinds — a held executor claims only non-launching kinds yet names every handler kind as served', async () => {
  const sent: { kinds: NextActionKind[]; serves?: NextActionKind[] }[] = [];
  const handlers = Object.fromEntries(served.map(kind => [kind, async () => 'ran']));
  await runExecutorTick({ id: slot(1), host }, { claim: async request => { sent.push(request); return { action: null }; }, settle: async () => {}, handlers, launchHold: async () => 'held' });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].kinds.every(kind => !launchingKinds.includes(kind)), 'queue matching stays narrowed');
  assert.deepEqual([...sent[0].serves!].sort(), [...served].sort());
  // An executor that serves only launching kinds claims nothing but still says it is alive and what it serves.
  const presence: unknown[] = [];
  const step = await runExecutorTick({ id: slot(2), host }, { claim: async () => { throw new Error('no claim'); }, present: async request => { presence.push(request); }, settle: async () => {}, handlers: { dispatch: async () => 'ran' }, launchHold: async () => 'held' });
  assert.match(step.reason, /claims nothing: held/);
  assert.deepEqual(presence, [{ host, executor: slot(2), kinds: ['dispatch'], serves: ['dispatch'] }]);
});

test('integration:presence-records-served-kinds — the claim route records presence from the served kinds, the engine still matches on the claim kinds', async () => {
  const { engine, effects, polls } = plane(served);
  const registry = executorRegistry(engine);
  await runExecutorTick({ id: slot(1), host }, effects);
  assert.ok(polls[0].kinds!.every(kind => !launchingKinds.includes(kind)));
  const live = registry.live(new Date());
  assert.deepEqual(live.map(entry => [entry.executor, [...entry.kinds].sort()]), [[slot(1), [...served].sort()]]);
  // The presence-only route behind a restart fence records served kinds the same way.
  await effects.present!({ host, executor: slot(2), kinds: ['resync'], serves: ['dispatch', 'resync'] });
  assert.deepEqual(registry.live(new Date()).find(entry => entry.executor === slot(2))!.kinds, ['dispatch', 'resync']);
});

test('integration:no-executor-fault-during-hold — a hold raises no "Nothing can run" row, and a really missing kind still does', async () => {
  const work = [item('GY-1', 'dispatch'), item('GY-2', 'request-review')];
  const { engine, effects } = plane(served);
  const registry = executorRegistry(engine);
  await runExecutorTick({ id: slot(1), host }, effects);
  const report = executorReport(work, registry, new Date());
  assert.deepEqual(report.unserved, []);
  assert.deepEqual(describeUnserved(report), []);
  // No hold: an executor that genuinely lacks dispatch still files the fault with its start command.
  const lacking = plane(['resync']);
  const bare = executorRegistry(lacking.engine);
  await runExecutorTick({ id: slot(3), host }, { ...lacking.effects, launchHold: undefined });
  const faults = classifyAttention(describeUnserved(executorReport(work, bare, new Date())).map(entry => ({ subject: entry.keys[0], text: entry.text })));
  assert.ok(faults.some(fault => fault.faultClass === 'configuration' && /Nothing can run dispatch/.test(fault.text) && /graphyard-executor@1/.test(fault.text)));
});
