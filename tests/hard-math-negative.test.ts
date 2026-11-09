import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinnedPython } from '../benchmarks/hard-math/python.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runFixture } from './helpers/hard-math-fixture.js';

// A file of its own (GY-3206): the runner bounds each test file, so these fixture runs no longer
// share tests/hard-math-smoke.test.ts's bound with every other one.
const python=await pinnedPython(await temporaryDirectory('hard-math-negative-python',process.cwd()));

test('integration:hard-math-smoke — missing pushed delivery and incorrect artifacts cannot produce PASS', {timeout:210_000},async()=>{
  const missing=await runFixture(python,'missing',{missingDelivery:true},1000,'single');assert.equal(missing.outcome,'FAIL');assert.match(missing.reason,/Missing delivery/);
  const incorrect=await runFixture(python,'incorrect',{incorrectArtifact:true},1000,'single');assert.equal(incorrect.outcome,'FAIL');assert.equal(incorrect.artifact,null);
  assert.ok(incorrect.failures.some(f=>f.component==='integration' && /CLI exact oracle rejected/.test(f.reason)),incorrect.reason);
  assert.ok((incorrect.work[0].record as any).evidence.some((e:any)=>e.proof==='manual:certified-artifact' && e.trusted && e.result==='fail'));
});
