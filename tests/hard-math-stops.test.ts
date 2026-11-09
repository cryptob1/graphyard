import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinnedPython } from '../benchmarks/hard-math/python.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runFixture } from './helpers/hard-math-fixture.js';

// A file of its own (GY-3206): the runner bounds each test file, so these fixture runs no longer
// share tests/hard-math-smoke.test.ts's bound with every other one.
const python=await pinnedPython(await temporaryDirectory('hard-math-stops-python',process.cwd()));

test('integration:hard-math-smoke — failed and usage-limited runs release actual scratch leases and sessions', {timeout:210_000},async()=>{
  for(const [label,options,budget] of [
    ['early-stop',{haltAfterClaims:true},1000],['usage-stop',{waitAfterClaims:true},3],
  ] as const) {
    const receipt=await runFixture(python,label,options,budget);
    assert.equal(receipt.outcome,'FAIL');assert.equal(receipt.cleanup.complete,true,receipt.reason);
    assert.ok(receipt.work.every(w=>!(w.record as any).lease));
    assert.ok(receipt.sessions.length>=3);assert.ok(receipt.sessions.every(s=>s.endedAt));
    if(label==='usage-stop') assert.match(receipt.reason,/usage limit|abort/i);
  }
});
