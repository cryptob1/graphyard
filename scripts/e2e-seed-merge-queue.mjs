// Runs four heads' trials at once (GY-3120) and saves the board snapshot inside the pending trials, with
// two healthy heads and one recorded blocker waiting behind it.
//
//   node --import tsx scripts/e2e-seed-merge-queue.mjs
//
// Run from the checkout scripts/e2e-serve.mjs serves: it reads the database URL that serve wrote to
// .graphyard/e2e-serve.json. Re-running refreshes the flight's step instant.
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { mergeHeads, mergeRecordKinds } from '../src/merge-writer/executor.ts';
import { foldMergeLedger } from '../src/model/merge-ledger.ts';

const { databaseUrl } = JSON.parse(await readFile('.graphyard/e2e-serve.json', 'utf8'));
const now = new Date().toISOString(), filed = '2020-01-01T00:00:00.000Z', base = 'b'.repeat(40);
const head = n => String(n).repeat(40);
const item = (n, key, fields = {}) => ({
  id: `3100a000-0000-4000-8000-00000000000${n}`, key, title: `Merge queue head ${n}`, description: 'Seeded for the merge queue board.',
  type: 'chore', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
  policy: { checks: ['test'], review: true }, policyRevision: 1, revision: 1, stage: 'test', stageEnteredAt: filed,
  ready: true, epoch: 1, lease: null, workspaces: [], evidence: [], violations: [], blocker: null, reworkRequested: false, nextAction: null,
  createdAt: `2020-01-01T00:0${n}:00.000Z`, updatedAt: filed,
  candidate: { sha: head(n), baseSha: base, createdAt: filed }, submission: { epoch: 1, sha: head(n), at: filed }, observation: { source: 'control-plane', candidate: { sha: head(n) } },
  gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] },
    { name: 'test', passed: false, reasons: [`merge writer has not trialled ${head(n).slice(0, 12)} on ${base.slice(0, 12)}`] }],
  ...fields,
});
const work = [item(1, 'GY-QFLIGHT'), item(2, 'GY-QBATCH-2'), item(3, 'GY-QBATCH-3'), item(4, 'GY-QBATCH-4'),
  item(5, 'GY-QUEUED-1'), item(6, 'GY-QUEUED-2'), item(7, 'GY-QBLOCKED', { blocker: 'Recorded failure' })];
const events = [];
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const results = await mergeHeads({
    baseBranch: 'main', now: () => Date.parse(now), holds: async () => false,
    fetch: async () => base,
    merge: async candidate => ({ mergeSha: candidate, files: [] }),
    record: async (item, event) => {
      const { kind, ...payload } = event;
      events.push({ kind: mergeRecordKinds[kind], work: item.key, payload: kind === 'intent' ? { ...payload, key: item.key } : payload });
    },
    trial: async () => {
      events.push({ kind: 'merge.trial-step', work: work[0].key, payload: { head: head(1), step: 'tests', at: now } });
      const ledger = foldMergeLedger(events);
      for (const item of work) {
        item.mergeLedger = ledger[item.key] ?? null;
        await pool.query('INSERT INTO work_items(id, document) VALUES($1, $2) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document', [item.id, JSON.stringify(item)]);
      }
      // Preserve the snapshot taken inside the running trials, before any verdict or push; the last trial to start sees every intent.
      throw new Error('E2E captured pending batch');
    },
    push: async () => { throw new Error('E2E must not push'); },
  }, work.slice(0, 4));
  if (results.length !== 4 || results.some(result => result.error?.message !== 'E2E captured pending batch'))
    throw new Error('Batch did not reach the pending trial snapshot');
} finally { await pool.end(); }
