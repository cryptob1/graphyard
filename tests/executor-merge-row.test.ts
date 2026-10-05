import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlPlaneHandlers } from '../src/executor.js';

/**
 * GY-442, as GitHub merges (GY-1235): the executor's merge row never reads like an accepted merge.
 * It asks only for a fresh reading of the item and says GitHub merges the candidate; the delivery
 * is recorded from the merged observation, never from the row.
 */

test('manual:review-followups-triaged — the executor merge row only resyncs the item and names GitHub as the merger, never reporting a merge of its own (GY-442, GY-1235)', async () => {
  const work = { id: 'work-1', key: 'GY-1', candidate: { sha: 'a'.repeat(40) } } as any;
  const config = { herdrWorkspace: null } as any;
  const mutations: string[] = [];
  const refuse = async () => { throw new Error('unused'); };
  const handlers = controlPlaneHandlers(() => config, {
    snapshot: async () => ({ work: [work], now: new Date().toISOString() }), mutate: async (path: string) => { mutations.push(path); return {}; }, agents: () => [],
    workerCredentials: refuse, producerCredentials: refuse, dispatchWorker: refuse, launchReview: refuse, launchProducer: refuse,
    observeDeployment: refuse,
  } as any);
  const row = await handlers.merge!({ work: work.id, key: work.key } as any, { id: 'executor-a', host: 'unit-host' } as any);
  assert.deepEqual(mutations, ['work/work-1/resync'], 'the row asks for nothing but a fresh reading');
  assert.equal(row, 'GY-1: GitHub merges aaaaaaaaaaaa on its branch protection; Graphyard records the delivery from the merged observation');
  assert.doesNotMatch(String(row), /: merged$|merge requested/);
});
