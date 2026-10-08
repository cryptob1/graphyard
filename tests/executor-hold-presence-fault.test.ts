import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runExecutorTick } from '../src/auto-dispatch.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import { describeUnserved, ExecutorRegistry, executorReport } from '../src/model/executor-presence.js';
import type { ActionRow } from '../src/model/actions.js';
import type { Work } from '../src/model.js';

/**
 * GY-1538: under a host memory hold the executor claimed only its non-launching kinds, and a claim
 * is also presence, so the control plane read dispatch and request-review as served by nobody and
 * filed "Nothing can run ..." as a configuration fault (GY-1515, GY-1537, GY-1530). Each instance is
 * replayed through the executor tick, the presence registry and the fault classifier.
 */
const clock = new Date('2030-01-01T12:00:00.000Z');
const row = (key: string, kind: ActionRow['kind']): ActionRow => ({ id: key.padEnd(32, '0'), kind, work: `work-${key}`, key, inputs: { kind } as ActionRow['inputs'], gate: 'build', refusal: null, reason: `${key} needs ${kind}`, binding: 'b',
  requestedBy: 'graphyard', requestedAt: new Date(clock.getTime() - 120_000).toISOString(), state: 'pending', claim: null, attempts: 0, history: [] });
const item = (key: string, kind: ActionRow['kind']) => ({ id: `work-${key}`, key, stage: 'build', actionQueue: { actions: [row(key, kind)], history: [] } }) as unknown as Work;

for (const [key, kind] of [['GY-1515', 'dispatch'], ['GY-1537', 'request-review'], ['GY-1530', 'dispatch']] as const) {
  test(`unit:hold-presence-no-config-fault — ${key} waiting on ${kind} under a host memory hold files no configuration fault`, async () => {
    const registry = new ExecutorRegistry();
    const identity = { id: 'executor-a', host: 'machine-a' };
    const poll = (kinds: string[]) => { registry.observe({ executor: identity.id, host: identity.host, principal: 'graphyard-executor', kinds: kinds as never }, clock); };
    await runExecutorTick(identity, { claim: async request => { poll(request.kinds); return { action: null }; }, settle: async () => {}, present: async request => { poll(request.kinds); },
      handlers: { dispatch: async () => 'launched', 'request-review': async () => 'launched', resync: async () => 'resynced' }, launchHold: async () => 'host machine-a has 2.0 GB free' });
    const unserved = describeUnserved(executorReport([item(key, kind)], registry, clock));
    const faults = classifyAttention(unserved.map(entry => ({ subject: 'executors', text: entry.text }))).filter(entry => entry.faultClass === 'configuration');
    assert.deepEqual(faults, [], `${key}: ${unserved.map(entry => entry.text).join('; ')}`);
  });
}
