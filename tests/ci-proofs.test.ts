import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
// @ts-expect-error Dependency-free protected workflow script.
import { ciProofFamilies as registryFamilies, contract, contracts, planCiProofs } from '../scripts/contracts.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { defineUnitContract, judgeUnitCases, parseTap } from '../scripts/unit-contract.mjs';



// ---------------------------------------------------------------------------
// unit:ci-proofs-enumeration — the registry decides what CI runs; nothing else does
// ---------------------------------------------------------------------------
test('unit:ci-proofs-enumeration only unit and integration proofs are automatable', () => {
  assert.deepEqual([...registryFamilies], ['unit', 'integration']);
  const plan = planCiProofs(['unit:anything', 'integration:claim-safety', 'manual:ci-proofs-docs', 'e2e:deploy-smoke', 'bogus']);
  assert.deepEqual(plan.runnable.map((entry: any) => entry.proof), ['integration:claim-safety']);
  assert.deepEqual(plan.deferred.map((entry: any) => entry.proof), ['unit:anything', 'manual:ci-proofs-docs', 'e2e:deploy-smoke', 'bogus']);
});

test('unit:ci-proofs-enumeration a plan runs every registered automatable proof of the item and names why the rest wait for a producer session', () => {
  const registered = Object.keys(contracts);
  assert.ok(registered.includes('integration:claim-safety') && registered.includes('unit:ci-proofs-enumeration'));
  const plan = planCiProofs(['integration:claim-safety', 'unit:ci-proofs-enumeration', 'integration:claim-safety', 'manual:ci-proofs-docs', 'e2e:deploy-smoke', 'integration:unregistered']);
  assert.deepEqual(plan.runnable, [{ proof: 'integration:claim-safety', kind: 'integration' }, { proof: 'unit:ci-proofs-enumeration', kind: 'unit' }]);
  assert.deepEqual(plan.deferred.map((entry: any) => entry.proof), ['manual:ci-proofs-docs', 'e2e:deploy-smoke', 'integration:unregistered']);
  assert.match(plan.deferred[0].reason, /manual:\* proofs are not automatable/);
  assert.match(plan.deferred[1].reason, /e2e:\* proofs are not automatable/);
  assert.match(plan.deferred[2].reason, /no registered contract/);
  // A registry the candidate could edit is not the one consulted: the plan takes the registry it is given.
  assert.deepEqual(planCiProofs(['integration:claim-safety'], {}).runnable, []);
});

test('unit:ci-proofs-enumeration a unit contract judges its fixed inventory from the TAP stream', () => {
  const unit = defineUnitContract({ file: 'tests/example.test.ts', cases: { first: 'unit:example the first case', second: 'unit:example the second case' } });
  assert.equal(unit.kind, 'unit');
  assert.deepEqual(unit.requiredCases, ['first', 'second']);
  const tap = ['TAP version 13', '# Subtest: unit:example the first case', 'ok 1 - unit:example the first case', '  ---', '  duration_ms: 1', '  ...',
    'not ok 2 - unit:example the second case', 'ok 3 - unit:example an unrelated test # SKIP test name does not match pattern', '1..3'].join('\n');
  assert.deepEqual([...parseTap(tap)], [['unit:example the first case', 'pass'], ['unit:example the second case', 'fail'], ['unit:example an unrelated test', 'skipped']]);
  assert.deepEqual(judgeUnitCases(unit, tap), [{ id: 'first', result: 'pass' }, { id: 'second', result: 'fail' }]);
  // A title that never reports is skipped, and a candidate cannot rename a case into passing.
  assert.deepEqual(judgeUnitCases(unit, 'ok 1 - unit:example the first case\nok 2 - unit:example the second case renamed\n'), [{ id: 'first', result: 'pass' }, { id: 'second', result: 'skipped' }]);
  assert.throws(() => defineUnitContract({ file: 'src/engine.ts', cases: { a: 'x' } }), /tests\/\*\.test\.ts/);
  assert.throws(() => defineUnitContract({ file: 'tests/empty.test.ts', cases: {} }), /declares no cases/);
  // The registered unit contract names this file and titles that exist in it, so the CI lane can run it.
  const registered = contract('unit:ci-proofs-enumeration');
  assert.equal(registered.file, 'tests/ci-proofs.test.ts');
  assert.equal(registered.source, 'tests/ci-proofs.test.ts');
  assert.ok(registered.requiredCases.length >= 3);
});

test('unit:ci-proofs-enumeration the registered unit inventory titles exist in this file verbatim', async () => {
  const source = await readFile(new URL('./ci-proofs.test.ts', import.meta.url), 'utf8');
  for (const title of Object.values(contract('unit:ci-proofs-enumeration').titles) as string[]) assert.ok(source.includes(`test('${title}'`), `missing test ${title}`);
});

