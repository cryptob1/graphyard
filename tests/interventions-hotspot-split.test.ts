import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as interventions from '../src/interventions.js';
import { foldRules } from '../src/interventions/fold-rules.js';

// GY-1447: src/interventions.ts caused 5 merge conflicts in 24h, each sending an item back to a
// worker, because every intervention fix reworded the same page. It is now a re-export barrel over
// modules under src/interventions/, one per concern, and the fold reads each ledger kind through a
// rule of its own. This suite fails when the barrel or one of its modules grows back.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFile(join(root, path), 'utf8');
const lines = (text: string) => text.split('\n').length;
// The per-module bound tests/hotspots.test.ts holds the registry modules to.
const moduleBudget = { lines: 320, bytes: 28_000 };
const barrelBudget = { lines: 40, bytes: 4_000 };
const modules = async () => (await readdir(join(root, 'src/interventions'))).filter(name => name.endsWith('.ts')).sort().map(name => `src/interventions/${name}`);

test('unit:interventions-hotspot-split — src/interventions.ts and every module split out of it stay within the size bound', async () => {
  const barrel = await read('src/interventions.ts');
  assert.ok(lines(barrel) <= barrelBudget.lines && barrel.length <= barrelBudget.bytes, `src/interventions.ts has ${lines(barrel)} lines, ${barrel.length} bytes; budget ${barrelBudget.lines} lines, ${barrelBudget.bytes} bytes. Put the growth in the module that owns it`);
  const files = await modules();
  assert.ok(files.length >= 4, 'src/interventions.ts is split into modules under src/interventions/');
  for (const file of files) {
    const text = await read(file);
    assert.ok(lines(text) <= moduleBudget.lines, `${file} has ${lines(text)} lines; the budget is ${moduleBudget.lines}. Split it by concern rather than raising the bound`);
    assert.ok(text.length <= moduleBudget.bytes, `${file} is ${text.length} bytes; the budget is ${moduleBudget.bytes}`);
  }
});

test('unit:interventions-hotspot-split — the barrel only re-exports, and each module names the one concern it owns', async () => {
  const code = (await read('src/interventions.ts')).split('\n').filter(line => line.trim() && !/^\s*(\/\/|\/\*\*|\*)/.test(line));
  for (const line of code) assert.match(line, /^export (type )?\{[^}]*\} from '\.[^']+';$/, `src/interventions.ts only re-exports: ${line.slice(0, 120)}`);
  for (const file of await modules()) assert.match((await read(file)).split('\n')[0], /^\/\/ Concern: \S.{10,}$/, `${file} opens with a "// Concern: …" header naming what it owns`);
  for (const name of ['readInterventionLedger', 'foldInterventions', 'computeInterventionReport', 'detectPatterns', 'readInterventionReport', 'openPatternItems', 'startPatternScan', 'interventionScan', 'recordIntervention', 'recordJudgement', 'judgementToWork', 'loopSettledInBound', 'windowOutcomes'])
    assert.equal(typeof (interventions as Record<string, unknown>)[name], 'function', `src/interventions.ts still exports ${name}`);
  assert.ok(Array.isArray(interventions.interventionLedgerKinds) && interventions.controlPlaneActor.id === 'graphyard');
});

test('unit:interventions-hotspot-split — the fold reads each ledger kind through its own rule, not a shared switch', async () => {
  const folded = interventions.interventionLedgerKinds.filter(kind => kind !== 'intervention.recorded' && kind !== 'judgement.recorded');
  assert.deepEqual(Object.keys(foldRules).sort(), [...folded].sort(), 'one rule per ledger kind the fold reads');
  assert.ok(Object.values(foldRules).every(rule => typeof rule === 'function'));
  const fold = await read('src/interventions/fold.ts');
  assert.doesNotMatch(fold, /switch \(row\.kind\)|^\s*case '/m, 'the fold dispatches to foldRules rather than a switch over kinds');
  assert.match(fold, /foldRules\[row\.kind\]/);
});
