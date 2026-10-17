import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCases, parseCase } from '../src/e2e/case.js';
import { checkoutContract, e2eSuite, releaseMaxWaitSeconds, runCases } from '../src/e2e/runner.js';
import { checkoutRepositoryPolicy } from '../src/model/repository-policy.js';
// @ts-expect-error The fixture is a plain ES module the uat job runs under tsx.
import { runOnboardingE2e } from '../scripts/onboarding-delivery-fixture.mjs';

// GY-1938: candidate 20261017T182412Z's e2e suite was killed at its one-hour command timeout. GY-1904
// gave candidate-batches-five GET steps that wait up to 3600 s for a delivery the shared UAT install
// never makes; the case was pending on the candidate, so it could never block, yet the run waited on it
// until SIGTERM and recorded no report. A pending case now asks once, and every release run caps a wait.
const root = new URL('..', import.meta.url).pathname;
const candidate = { id: 'rc-gy-1938', pendingOutcomes: ['small-exact-candidates'] };

/** UAT as the shared install answers: items are created, none is ever delivered. */
const undelivered = () => {
  const reads: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = (init?.method ?? 'GET').toUpperCase();
    reads.push(`${method} ${url.pathname}`);
    if (url.pathname === '/healthz') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (method === 'POST' && url.pathname === '/api/work') return new Response(JSON.stringify({ id: `w${reads.length}` }), { status: 200 });
    return new Response(JSON.stringify({ delivery: null }), { status: 200 });
  }) as typeof fetch;
  return { fetcher, reads };
};

test('unit:release-e2e-pending-case-never-waits — the checkout\'s candidate-batches-five, pending on the candidate, finishes at once on an install that delivers nothing, in the e2e suite and the onboarding fixture\'s run, without failing either', async () => {
  const cases = (await loadCases(root)).filter(entry => entry.definition.id === 'candidate-batches-five');
  assert.equal(cases.length, 1);
  assert.ok(cases[0].definition.steps.some(step => step.kind === 'http' && (step.waitSeconds ?? 0) > releaseMaxWaitSeconds), 'the case still declares a wait longer than a release run allows');
  const contract = await checkoutContract(root), policy = checkoutRepositoryPolicy(root);

  const suite = undelivered(), began = Date.now();
  const result = await e2eSuite(cases, 't', { fetcher: suite.fetcher, root, contract, policy }).run('http://uat.test', candidate);
  assert.ok(Date.now() - began < 30_000, `the suite returned in ${Date.now() - began} ms`);
  assert.equal(result.passed, true, result.detail); assert.match(result.detail, /pending, not blocking: case candidate-batches-five/);
  assert.equal(suite.reads.filter(read => read.startsWith('GET /api/work/')).length, 2, 'each of the two attempts asked once for the first delivery, then stopped');

  const fixture = undelivered();
  const report = await runOnboardingE2e(cases, { url: 'http://uat.test', token: 't', candidate, contract, policy, root, fetcher: fixture.fetcher, fixture: async () => { throw new Error('no fixture case is selected'); } });
  assert.equal(report.cases[0].pending, true); assert.equal(report.cases[0].attempts, 2);
  assert.doesNotMatch(report.cases[0].failingStep!.reason, /after waiting/);
});

test('unit:release-e2e-wait-is-bounded — a required case not pending still waits, up to the run\'s cap, and a release run\'s cap keeps a case\'s two attempts inside the suite\'s one-hour command timeout', async () => {
  assert.ok(2 * releaseMaxWaitSeconds <= 1800, `two attempts wait at most ${2 * releaseMaxWaitSeconds} s`);
  const waiting = parseCase('e2e/cases/waits.json', JSON.stringify({ id: 'waits', title: 'Waits', target: 'uat', required: true,
    steps: [{ kind: 'http', method: 'GET', path: '/api/work/one', status: 200, waitSeconds: 3600, expect: [{ path: 'delivery.mergeSha', type: 'string' }] }] }));
  const { fetcher, reads } = undelivered(), began = Date.now();
  const report = await runCases([{ file: 'e2e/cases/waits.json', definition: waiting }], { url: 'http://uat.test', token: 't', fetcher, waitPollMs: 100, maxWaitSeconds: 1, pendingCases: ['other'] });
  assert.ok(Date.now() - began < 10_000); assert.equal(report.cases[0].outcome, 'fail');
  assert.match(report.cases[0].failingStep!.reason, /\(still, after waiting 1 s\)/); assert.ok(reads.filter(read => read.startsWith('GET /api/work/')).length > 1, 'it asked again while it waited');
});
