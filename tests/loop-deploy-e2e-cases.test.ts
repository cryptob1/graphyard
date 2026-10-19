import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { e2eSuite } from '../src/e2e/runner.js';
import type { CaseFile } from '../src/e2e/case.js';

/**
 * GY-1982 AC-4: the loop's end-to-end step after a continuous deploy runs every case under
 * e2e/cases/ — the cases release-candidate.yml ran on GitHub — through the e2e runner against the
 * install's own URL, and a failing case is the end-to-end failure that rolls the deploy back.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

/** A fake runner: records the cases it was asked to run and the URL, and answers `passed`. */
function fakeSuite(passed: boolean) {
  const seen = { cases: [] as string[], url: null as string | null, token: null as string | null, runAll: false };
  const suite = ((cases: readonly CaseFile[], token: string, options: Parameters<typeof e2eSuite>[2] = {}) => ({
    name: 'e2e',
    run: async (url: string) => {
      seen.cases = cases.filter(options.select ?? (() => false)).map(entry => entry.definition.id);
      seen.url = url; seen.token = token; seen.runAll = options.runAll === true;
      return passed ? { name: 'e2e', passed: true, detail: `${seen.cases.length} E2E cases passed` } : { name: 'e2e', passed: false, detail: '1 of 15 E2E cases failed: sign-in failed at step 2' };
    },
  })) as unknown as typeof e2eSuite;
  return { suite, seen };
}

test('unit:loop-deploy-runs-e2e-cases — the deploy\'s end-to-end step selects every case under e2e/cases/ and runs each through the runner; a failing case is the end-to-end failure', async () => {
  const { deployedE2e } = await import('../src/e2e/runner.js') as Record<string, any>;
  const everyCase = (await readdir(`${root}/e2e/cases`)).filter(name => name.endsWith('.json')).map(name => name.replace(/\.json$/, '')).sort();
  assert.ok(everyCase.length > 0);

  const passing = fakeSuite(true);
  const result = await deployedE2e(root, 'http://127.0.0.1:4311', 'coordinator-token', passing.suite);
  assert.equal(result.passed, true);
  assert.deepEqual(passing.seen.cases, everyCase, 'every case under e2e/cases/ is selected, whatever it targets');
  assert.equal(passing.seen.url, 'http://127.0.0.1:4311', 'against the install\'s own URL');
  assert.equal(passing.seen.runAll, true, 'each case runs and records its own result');

  const failing = fakeSuite(false);
  await assert.rejects(deployedE2e(root, 'http://127.0.0.1:4311', 'coordinator-token', failing.suite), /1 of 15 E2E cases failed: sign-in failed at step 2/,
    'a failing case throws, the end-to-end failure continuous deploy rolls back on');
  assert.deepEqual(failing.seen.cases, everyCase);
});

test('unit:loop-deploy-runs-e2e-cases — through the real runner and its verdict, a failing optional case still fails the deploy\'s end-to-end step', async () => {
  const { deployedE2e, e2eSuite: realSuite } = await import('../src/e2e/runner.js') as Record<string, any>;
  const { parseCase } = await import('../src/e2e/case.js') as Record<string, any>;
  const optional = parseCase('e2e/cases/optional-home.json', JSON.stringify({ id: 'optional-home', title: 'Optional home', target: 'any', required: false, steps: [{ kind: 'http', method: 'GET', path: '/home', status: 200, expect: [] }] }));
  const fetcher = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/merger') return Response.json({ mode: 'control-plane' });
    return path === '/home' ? new Response('down', { status: 503 }) : Response.json({ ok: true });
  }) as typeof fetch;
  let clock = 0;
  const suite = ((_cases: readonly CaseFile[], token: string, options: Parameters<typeof e2eSuite>[2] = {}) =>
    realSuite([{ file: 'e2e/cases/optional-home.json', definition: optional }], token, { ...options, fetcher, now: () => clock, sleep: async (ms: number) => { clock += ms; } })) as typeof e2eSuite;
  await assert.rejects(deployedE2e(root, 'http://127.0.0.1:4311', 'coordinator-token', suite), /1 E2E case failed: case optional-home failed at step 1/,
    'the release verdict passes an optional failure, but continuous deploy rolls back on it');
});
