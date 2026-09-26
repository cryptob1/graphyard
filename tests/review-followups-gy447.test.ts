import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { Store } from '../src/store.js';
import { failedStatement } from '../src/store/statements.js';
import { summaryOmitted } from '../src/store/summary-sql.js';
import { obligationDocuments } from '../src/cli/work.js';
import { inheritedObligations, type Work } from '../src/model.js';
import { obligationLedger } from '../src/coordination.js';

// GY-447: the follow-ups the independent review of GY-422 (PR #228) filed.

const proof = 'integration:harness', contract = 'src/harness/';
const bootstrap = { reason: 'introduces the harness', contractPaths: [contract], declaredBy: 'operator', declaredAt: '2026-09-01T00:00:00.000Z', policyRevision: 1 };
const delivered = { id: 'd', key: 'GY-1', title: 'Harness', stage: 'done', summary: true, plannedFiles: [contract], evidence: [],
  criteria: [{ id: 'AC-1', text: 'harness', proofs: [proof], bootstrap }] } as unknown as Work;
const open = { id: 'o', key: 'GY-2', title: 'Touches the harness', stage: 'build', plannedFiles: [`${contract}run.ts`], evidence: [],
  criteria: [{ id: 'AC-1', text: 'change', proofs: ['unit:change'] }] } as unknown as Work;

test('unit:gy447-obligations-over-summaries — a settled summary keeps the criteria, planned files and evidence obligations derive from, so the ledger and inheritance see a delivered item\'s bootstrap deferral without reading it', async () => {
  for (const field of ['criteria', 'plannedFiles', 'evidence', 'candidate', 'policyRevision']) assert.ok(!(summaryOmitted as readonly string[]).includes(field), `the summary keeps ${field}`);
  const reads: string[] = [];
  const all = await obligationDocuments([delivered, open], async path => { reads.push(path); throw new Error('not read'); });
  assert.deepEqual(reads, [], 'a summary carrying its criteria is used as it is');
  assert.deepEqual(obligationLedger(all).map(entry => [entry.key, entry.proof, entry.inheritedBy]), [['GY-1', proof, ['GY-2']]]);
  assert.deepEqual(inheritedObligations(open, all).map(entry => entry.key), ['GY-1']);
});

test('unit:gy447-obligations-read-trimmed-summaries-whole — a summary served without its criteria is read whole, so its bootstrap obligation stays in the ledger and is still inherited', async () => {
  const { criteria: _criteria, ...trimmed } = delivered as any;
  const reads: string[] = [];
  const all = await obligationDocuments([trimmed, open], async path => { reads.push(path); return delivered; });
  assert.deepEqual(reads, ['work/d']);
  assert.deepEqual(obligationLedger(all).map(entry => [entry.key, entry.inheritedBy]), [['GY-1', ['GY-2']]]);
  assert.deepEqual(inheritedObligations(open, all).map(entry => entry.key), ['GY-1']);
});

test('unit:gy447-lease-lane-names-statements — a statement that fails on the lease lane carries its SQL, exactly as on the request pool', async () => {
  const store = new Store('postgres://graphyard:unused@127.0.0.1:1/unused');
  try {
    for (const pool of [store.pool, store.leasePool]) {
      const client = Object.assign(new EventEmitter(), { query: async (_sql: string) => { throw new Error('canceling statement due to statement timeout'); } });
      pool.emit('connect', client as unknown as pg.PoolClient);
      const error = await client.query('UPDATE work_items SET lease = $1').catch((failure: unknown) => failure);
      assert.equal(failedStatement(error), 'UPDATE work_items SET lease = $1');
      client.emit('end');
    }
  } finally { await store.close(); }
});
