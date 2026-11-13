import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import type { Principal } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { appliedReworkBrief, reworkBriefSection } from '../src/master/rework-brief.js';
import { reworkAttention } from '../src/master/attention.js';

// e2e:rework-reason-visible — a rework always carries its reason: readable from the stored item
// (what `status GY-N` and the item page print), in the next worker's brief, and as an attention line.
test('e2e:rework-reason-visible — a rework carries the reviewer\'s reason and raises attention; one without a reason is refused', async () => {
  setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
  const store = await withDatabase('rework-reason-visible'); await store.init();
  const engine = new Engine(store, 7200, 'owner/project');
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
  const master: Principal = { id: 'graphyard-master-project-operator', role: 'operator-agent', scope: { repositories: ['owner/project'], workItems: ['*'] } };
  let work = await engine.execute(master, 'create', null, { reason: 'fixture', title: 'Rework fixture', type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:rework-reason-visible'] }] }, randomUUID());
  work = await engine.execute(master, 'ready', work.id, { reason: 'fixture', expectedRevision: work.revision }, randomUUID());

  await assert.rejects(engine.execute(master, 'rework', work.id, { reason: '   ', previousWorkerStopped: true }, randomUUID()));
  assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, false);

  const reason = 'BLOCKING: the retry path drops the reviewer\'s findings';
  await engine.execute(master, 'rework', work.id, { reason, previousWorkerStopped: true }, randomUUID());
  const stored = (await store.list()).find(item => item.id === work.id)!;
  assert.equal(stored.lastRework?.reason, reason);
  assert.match(reworkBriefSection(stored, appliedReworkBrief(stored)), /retry path drops/);
  assert.match(reworkAttention([stored])[0]!.text, /retry path drops/);
});
