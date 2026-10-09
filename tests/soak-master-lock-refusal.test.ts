import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readLockRefusal, recordLockRefusal, unsupervisedHolderAttention, type LockRefusal } from '../src/master/loop-restart.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1603 over time: this install's unit restarts its `master run` every RestartSec into the same
 * lock refusal while an unsupervised loop holds the lock, and `master status` reads the refusal
 * record at any moment. The record was rewritten in place, so a status read that landed inside a
 * refusal's write saw an empty or partial file and the holder's attention item vanished during the
 * very crash-loop it exists to expose. The invariant here: across every refusal and every read,
 * status names the holder, and the count only grows.
 */
const unit = { unit: 'graphyard-master-soak.service', mainPid: 0 };
const restartSecMs = 10_000;

test('unit:soak-lock-refusal-visible — two hundred supervisor restarts refused on an unsupervised holder\'s lock, read by status concurrently throughout: every read names the holder with a count that never falls, an interrupted write hides nothing, and a new holder starts its own count', { timeout: 600_000 }, async () => {
  const root = await temporaryDirectory('soak-lock-refusal');
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  const lock = { pid: process.pid, host: 'soak-host', heartbeatAt: new Date(0).toISOString(), startedAt: '2026-10-09T20:00:00.000Z' };
  const attention = (refusal: LockRefusal | null) => unsupervisedHolderAttention({ refusal, lock, hostId: lock.host, unit });

  const first = await recordLockRefusal(root, lock, new Date(0));
  const refusals = 200;
  let done = false, reads = 0, last = first.count;
  const misses: string[] = [];
  const reader = async () => {
    while (!done) {
      const refusal = await readLockRefusal(root);
      reads++;
      const item = attention(refusal);
      if (!refusal || !item) { misses.push(`read ${reads}: ${refusal ? 'no attention' : 'no record'}`); continue; }
      if (refusal.count < last) misses.push(`read ${reads}: count fell from ${last} to ${refusal.count}`);
      last = Math.max(last, refusal.count);
      assert.match(item.text, new RegExp(`pid ${lock.pid} on ${lock.host}, started ${lock.startedAt}`));
    }
  };
  const readers = [reader(), reader(), reader()];
  try {
    for (let index = 1; index < refusals; index++) {
      // A refusal the supervisor interrupted mid-write leaves its temporary file behind, never a torn record.
      if (index % 40 === 0) await writeFile(join(root, '.graphyard', `master-lock-refusal.json.interrupted-${index}.tmp`), '{"holder":{"pid"', { mode: 0o600 });
      await recordLockRefusal(root, lock, new Date(index * restartSecMs));
    }
  } finally { done = true; await Promise.all(readers); }

  assert.deepEqual(misses, [], 'status named the unsupervised holder on every read, with a count that never fell');
  assert.ok(reads >= refusals, `status read the record throughout the refusals: ${reads} reads`);
  const final = await readLockRefusal(root);
  assert.equal(final?.count, refusals, 'every refusal of the same holder counts');
  assert.equal(final?.refusedAt, new Date((refusals - 1) * restartSecMs).toISOString(), 'the record names the latest refusal');
  assert.match(attention(final)!.text, new RegExp(`refused on it ${refusals} time\\(s\\)`));
  assert.ok((await readdir(join(root, '.graphyard'))).filter(name => name.startsWith('master-lock-refusal.json.') && !name.includes('interrupted')).length === 0, 'every published refusal leaves no temporary file');

  // A new holder after the old one is stopped starts its own count; the unit's own loop raises nothing.
  const next = { ...lock, startedAt: '2026-10-09T22:00:00.000Z', host: 'soak-host' };
  const restarted = await recordLockRefusal(root, { ...next, pid: process.ppid }, new Date(refusals * restartSecMs));
  assert.equal(restarted.count, 1, 'a different holder is counted from one');
  assert.equal(unsupervisedHolderAttention({ refusal: final, lock, hostId: lock.host, unit: { ...unit, mainPid: lock.pid } }), null, 'a holder that is the unit\'s MainPID is supervised');
});
