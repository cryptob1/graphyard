// The golden eval's planning step (GY-2970): ten items from eval/golden/, filed once per run
// against each item's own fresh scaffold copy, two runs, one result row per item per run — and
// the scratch install taken down afterwards, failure included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { goldenDir, loadGoldenItems, plan, type Filed, type GoldenInstall, type GoldenResult, type SettledRow } from '../scripts/eval-golden.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/** A fake install: records every filing with the scaffold copy it was handed, settles each as `settled`, counts its disposals. */
function fakeInstall(settled: (item: string) => SettledRow = () => ({ outcome: 'done', attempts: 1, reworkRounds: 0, minutes: 3.5 })) {
  const filed: { item: string; scaffold: string; run: number }[] = [], settledKeys: string[] = [];
  let disposals = 0, refused: string | null = null;
  const byKey = new Map<string, string>();
  const install: GoldenInstall = {
    async file(item, scaffold, run) {
      if (refused === item.name) throw new Error(`the control plane refused ${item.name}`);
      assert.ok(existsSync(join(scaffold, 'package.json')), `${item.name} run ${run} was handed a scaffold copy that holds the extracted scaffold`);
      filed.push({ item: item.name, scaffold, run });
      const key = `GY-${filed.length}`;
      byKey.set(key, item.name);
      return { key, id: `id-${filed.length}` };
    },
    async settle(filed: Filed) {
      settledKeys.push(filed.key);
      return settled(byKey.get(filed.key)!);
    },
    async dispose() { disposals++; },
  };
  return { install, filed, settledKeys, disposals: () => disposals, refuse: (name: string) => { refused = name; } };
}

test('unit:eval-golden-files-ten-items-twice-and-cleans-up — the planning step files the ten golden items once per run, each against its own fresh scaffold copy, writes one row per item per run, and takes the scratch install down afterwards', async () => {
  const parent = await temporaryDirectory('eval-golden');
  const scratch = join(parent, 'scratch');
  const resultsPath = join(parent, 'results', 'golden-test-release.json');
  const fake = fakeInstall();

  const result = await plan(fake.install, { release: 'golden-test-release', runs: 2, boundMs: 60_000, goldenDir: goldenDir(), scratch, resultsPath });

  // The golden set is the fixed ten, and each item is filed exactly once per run.
  const names = (await readdir(goldenDir(), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.equal(names.length, 10);
  assert.deepEqual(fake.filed.filter(call => call.run === 1).map(call => call.item).sort(), names);
  assert.deepEqual(fake.filed.filter(call => call.run === 2).map(call => call.item).sort(), names);
  assert.equal(fake.filed.length, 20);
  assert.equal(fake.settledKeys.length, 20);

  // Every filing is handed its own fresh scaffold copy: twenty distinct directories, each a real
  // extraction of that item's tarball (the fake checked package.json exists in it).
  assert.equal(new Set(fake.filed.map(call => call.scaffold)).size, 20);
  for (const item of names) {
    const copies = fake.filed.filter(call => call.item === item).map(call => call.scaffold);
    assert.equal(new Set(copies).size, 2, `${item} ran against two fresh copies`);
    const [run1, run2] = copies;
    assert.notEqual(run1, run2);
    assert.match(run1!, new RegExp(`${item}-run-1$`));
    assert.match(run2!, new RegExp(`${item}-run-2$`));
  }

  // The result file carries one row per item per run, each with outcome, attempts, rework rounds and minutes.
  const written = JSON.parse(await readFile(resultsPath, 'utf8')) as GoldenResult;
  assert.deepEqual(written, { release: 'golden-test-release', runs: 2, rows: result.rows } satisfies GoldenResult);
  assert.equal(written.rows.length, 20);
  for (const name of names) for (const run of [1, 2]) {
    const row = written.rows.find(candidate => candidate.item === name && candidate.run === run);
    assert.ok(row, `a row for ${name} run ${run}`);
    for (const field of ['outcome', 'attempts', 'reworkRounds', 'minutes']) assert.ok(field in row, `${field} on ${name} run ${run}`);
  }
  assert.deepEqual(result, written);

  // The scratch install went down exactly once, after the runs, and the scaffold copies went with it.
  assert.equal(fake.disposals(), 1);
  assert.ok(!existsSync(scratch));
});

test('unit:eval-golden-files-ten-items-twice-and-cleans-up — a filing that fails still takes the scratch install down and removes the scaffold copies', async () => {
  const parent = await temporaryDirectory('eval-golden-failure');
  const scratch = join(parent, 'scratch');
  const fake = fakeInstall();
  fake.refuse('base-broken-proof');

  await assert.rejects(plan(fake.install, { release: 'golden-failed-release', runs: 2, boundMs: 60_000, goldenDir: goldenDir(), scratch, resultsPath: join(parent, 'results', 'gone.json') }),
    /refused base-broken-proof/);

  assert.equal(fake.disposals(), 1);
  assert.ok(!existsSync(scratch));
  assert.equal(existsSync(join(parent, 'results', 'gone.json')), false);
});

test('unit:eval-golden-files-ten-items-twice-and-cleans-up — the golden set covers the fault classes its items are chosen for', async () => {
  const items = await loadGoldenItems();
  assert.equal(items.length, 10);
  const byName = new Map(items.map(item => [item.name, item]));
  // A plain feature, a bug whose proof fails on the base, two items that touch the same file, and the six single-item classes.
  assert.ok(byName.get('plain-feature'));
  assert.equal(byName.get('base-broken-proof')!.type, 'bug');
  assert.ok(byName.get('conflict-changelog-a') && byName.get('conflict-changelog-b'));
  for (const name of ['rework-first-head', 'long-multi-attempt', 'docs-budget', 'review-changes-e2e', 'requirements-gap', 'flaky-outside']) assert.ok(byName.get(name), name);
  // Every item carries criteria with proofs, so a filed item is judgeable.
  for (const item of items) {
    assert.ok(item.criteria.length >= 1, `${item.name} carries a criterion`);
    for (const criterion of item.criteria) assert.ok(criterion.proofs.length >= 1, `${item.name}'s criterion carries a proof`);
  }
});
