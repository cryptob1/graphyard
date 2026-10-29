// The golden eval's comparison (GY-2970): two result files read as one line per flipped item,
// named before the totals — unchanged items are named nowhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compare, readResult, type GoldenResult } from '../scripts/eval-golden.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const row = (item: string, run: number, outcome: GoldenResult['rows'][number]['outcome'], attempts: number) =>
  ({ item, run, outcome, attempts, reworkRounds: 0, minutes: 1 });

async function fixture(parent: string, name: string, result: GoldenResult) {
  const path = join(parent, `${name}.json`);
  await writeFile(path, JSON.stringify(result));
  return path;
}

test('unit:eval-compare-names-flipped-items — the comparison names each flipped item, by name, before the totals, and names no unchanged item', async () => {
  const parent = await temporaryDirectory('eval-compare');
  const left = await fixture(parent, 'before', { release: 'before-release', runs: 1, rows: [
    row('plain-feature', 1, 'done', 1),        // done → blocked in the next release
    row('requirements-gap', 1, 'blocked', 2),  // blocked → done
    row('long-multi-attempt', 1, 'done', 2),   // attempts up by two
    row('retry-once', 1, 'done', 1),           // attempts up by exactly one: not a flip
    row('steady', 1, 'blocked', 1),            // unchanged
  ] });
  const right = await fixture(parent, 'after', { release: 'after-release', runs: 1, rows: [
    row('plain-feature', 1, 'blocked', 2),
    row('requirements-gap', 1, 'done', 1),
    row('long-multi-attempt', 1, 'done', 4),
    row('retry-once', 1, 'done', 2),
    row('steady', 1, 'blocked', 1),
  ] });

  const output = compare(await readResult(left), await readResult(right));
  const lines = output.split('\n');

  // Every flip is its own line, named by item and run, with both outcomes and both attempt counts.
  assert.ok(lines.some(line => line.includes('plain-feature run 1') && line.includes('done → blocked') && line.includes('attempts 1 → 2')), output);
  assert.ok(lines.some(line => line.includes('requirements-gap run 1') && line.includes('blocked → done')), output);
  assert.ok(lines.some(line => line.includes('long-multi-attempt run 1') && line.includes('attempts 2 → 4')), output);

  // Unchanged items, and a one-attempt drift, are named nowhere.
  assert.ok(!output.includes('steady'), output);
  assert.ok(!output.includes('retry-once'), output);

  // The flips come before the totals, and the totals name both releases.
  const totals = lines.findIndex(line => line.startsWith('totals:'));
  const firstFlip = lines.findIndex(line => line.includes('plain-feature run 1'));
  assert.ok(totals > -1, output);
  assert.ok(firstFlip > -1 && firstFlip < totals, output);
  assert.match(lines[totals]!, /before-release/);
  assert.match(lines[totals]!, /after-release/);
  assert.match(lines[totals]!, /3 of 5 rows flipped/);
});

test('unit:eval-compare-names-flipped-items — two result files with nothing flipped print none and the totals alone', async () => {
  const parent = await temporaryDirectory('eval-compare-none');
  const same = { release: 'either-release', runs: 1, rows: [row('plain-feature', 1, 'done', 1), row('flaky-outside', 1, 'timed out', 3)] };
  const left = await fixture(parent, 'a', same), right = await fixture(parent, 'b', same);

  const output = compare(await readResult(left), await readResult(right));
  const lines = output.split('\n');
  assert.equal(lines[0], 'flipped: none');
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /1 done, 0 blocked, 1 timed out/);
});
