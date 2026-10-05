import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlPlaneHandlers } from '../src/executor.js';

/**
 * GY-442: the executor's merge row names an outcome that is neither pending nor merged the way the
 * loop's merge step does since GY-246, so it never reads like an accepted merge.
 */

test('manual:review-followups-triaged — the executor merge row names an outcome that is neither pending nor merged, and records pending and merged outcomes verbatim (GY-442)', async () => {
  const work = { id: 'work-1', key: 'GY-1' } as any;
  const config = { herdrWorkspace: null } as any;
  const row = async (outcome: unknown) => {
    const refuse = async () => { throw new Error('unused'); };
    const handlers = controlPlaneHandlers(() => config, {
      snapshot: async () => ({ work: [work], now: new Date().toISOString() }), mutate: refuse, agents: () => [],
      workerCredentials: refuse, producerCredentials: refuse, dispatchWorker: refuse, launchReview: refuse, launchProducer: refuse,
      observeDeployment: refuse,
    });
    return handlers.merge!({ work: work.id, key: work.key } as any, { id: 'executor-a', host: 'unit-host' } as any);
  };
  const neither = /the merge reported neither a pending request nor a merge GitHub performed/;
  assert.equal(await row({ result: 'merge requested', pending: true }), 'GY-1: merge requested');
  assert.equal(await row({ result: 'merged', merged: true }), 'GY-1: merged');
  assert.equal(await row({ result: 'merge requested' }), 'GY-1: merge requested; the merge reported neither a pending request nor a merge GitHub performed');
  assert.match(String(await row(undefined)), neither);
  assert.match(String(await row({})), neither);
  assert.equal(await row({ pending: true }), 'GY-1: the guarded merge returned without a result of its own');
});
