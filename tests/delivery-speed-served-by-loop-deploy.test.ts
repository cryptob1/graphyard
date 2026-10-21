import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import type { DaemonState } from '../src/daemon/state.js';
import type { DeployPorts } from '../src/daemon/continuous-deploy.js';

/**
 * GY-2844: the loop's own verified deploy of a main commit serves every merge that commit contains,
 * so merged→production measures those items from the deploy instead of counting them pending.
 */

const full = (prefix: string) => prefix.padEnd(40, '0');
const start = Date.parse('2026-10-20T12:00:00.000Z');
const iso = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
const merged = (key: string, minutes: number, sha: string) => ({ id: key, key, stage: 'done', createdAt: iso(-60), closure: null,
  delivery: { mergeSha: sha, mergedAt: iso(minutes) } }) as unknown as Work;

const ports: DeployPorts = { deploy: async () => {}, health: async () => {}, schemas: async () => ({ target: 1, database: 1 }) };

/** One loop deploy of `tip`, committed at `committedAt` minutes, passing at `at` minutes. */
async function deploy(state: DaemonState, tip: string, committedAt: number, at: number) {
  const { deployTip } = await import('../src/daemon/continuous-deploy.js');
  const git = (...args: string[]) => args[0] === 'show' ? `${iso(committedAt).replace('.000Z', 'Z')}\n` : '';
  assert.equal(await deployTip(state, tip, state.promotion?.promotedSha ?? full('0'), ports, { git, at: () => iso(at), persist: async () => {}, note: async () => {} }), 'deployed');
}

test('unit:delivery-speed-served-by-loop-deploy — a verified loop deploy serves every merge its commit contains; a later merge stays pending until a later deploy contains it', async () => {
  const { deliverySpeed } = await import('../src/flow-analytics.js');
  const state = { promotion: null, release: null } as unknown as DaemonState;
  const a = merged('GY-1', 0, full('a1')), b = merged('GY-2', 10, full('b2')), c = merged('GY-3', 25, full('c3'));
  // Main at b2 (the merge of GY-2, committed at minute 10) deploys at minute 20; GY-3 merges after it.
  await deploy(state, full('b2'), 10, 20);
  assert.deepEqual(state.promotion?.deploys, [{ sha: full('b2'), committedAt: iso(10).replace('.000Z', 'Z'), at: iso(20) }]);
  const first = deliverySpeed([a, b, c], { now: start + 30 * 60_000, deploys: state.promotion!.deploys }).mergedToProduction['24h'];
  assert.equal(first.count, 2, 'both merges the deployed commit contains are measured');
  assert.deepEqual(first.slowest.filter(sample => !sample.pending).map(sample => [sample.key, sample.ms]), [['GY-1', 20 * 60_000], ['GY-2', 10 * 60_000]],
    'each is served at the deploy instant, no earlier than its merge');
  assert.equal(first.pending, 1, 'the merge after the deployed commit is pending');
  assert.ok(first.slowest.some(sample => sample.key === 'GY-3' && sample.pending));

  // AC-2: a later verified deploy that contains GY-3 serves it; the earlier items keep their first serving instant.
  await deploy(state, full('c3'), 25, 40);
  const second = deliverySpeed([a, b, c], { now: start + 50 * 60_000, deploys: state.promotion!.deploys }).mergedToProduction['24h'];
  assert.equal(second.pending, 0);
  assert.deepEqual(second.slowest.map(sample => [sample.key, sample.ms]), [['GY-1', 20 * 60_000], ['GY-3', 15 * 60_000], ['GY-2', 10 * 60_000]]);
});
