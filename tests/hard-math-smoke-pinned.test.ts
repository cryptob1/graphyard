import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fixture from '../benchmarks/hard-math/fixture.js';
import { trialFileTimeoutMs } from './helpers/run-tests.js';

// GY-3206: the batch gate's check test:tests/hard-math-smoke.test.ts failed once and passed its
// re-run. The runner kills a test file's process group at its per-file bound, and that one file
// ran every controlled-fixture delivery in sequence under test timeouts adding up to three times
// the bound — the eight-merge repair run alone was allowed all of it. On a loaded host the file
// outran the bound while each of its tests was still inside its own. Each group of fixture runs
// now has its own file, no hard-math file may allow its tests more time than the runner allows
// the file, and a controlled run's own wall clock ends inside that bound.
test('unit:hard-math-smoke-pinned — no hard-math test file, and no controlled run in one, is allowed more time than the runner allows the file', () => {
  for (const [run, seconds] of Object.entries(fixture.controlledWallClockSeconds)) assert.ok(seconds * 1000 < trialFileTimeoutMs, `the ${run} controlled run's ${seconds} s wall clock ends inside the ${trialFileTimeoutMs} ms file bound`);
  const directory = join(process.cwd(), 'tests');
  const files = readdirSync(directory).filter(name => /^hard-math-.*\.test\.ts$/.test(name));
  assert.ok(files.includes('hard-math-smoke.test.ts'));
  for (const file of files) {
    const allowed = [...readFileSync(join(directory, file), 'utf8').matchAll(/\{\s*timeout:\s*([\d_]+)\s*\}/g)].reduce((sum, match) => sum + Number(match[1]!.replaceAll('_', '')), 0);
    assert.ok(allowed <= trialFileTimeoutMs, `${file} allows its tests ${allowed} ms inside a ${trialFileTimeoutMs} ms file bound`);
  }
});
