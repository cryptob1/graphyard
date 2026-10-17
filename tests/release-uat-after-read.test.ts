import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uatValidationCeilingMs, validate, type ReleaseCandidate, type Suite } from '../src/release-candidate.js';

// GY-1970: release candidate 20261017T224540Z (bd867a076ce9bed217e2e09814caac968b3c5434) failed
// exactly one UAT suite — deployment, "UAT moved from bd867a… to no observable commit while the
// suites ran". Every real suite had passed; the single /healthz read after them came back
// unreadable, and the old one-read judgement recorded that as a move. The post-suite check now
// re-reads within a bounded window before judging, and these tests drive that window on a fake
// fetcher and a fake clock: `now` starts at the candidate's cut and each `sleep` advances it by
// the poll interval, so a whole window elapses without reading a wall clock.

const candidateSha = 'bd867a076ce9bed217e2e09814caac968b3c5434';
const cutAt = '2026-10-17T22:45:40.000Z';
const url = 'https://uat.example.test';

const candidateAt = (): ReleaseCandidate => ({ id: '20261017T224540Z', sha: candidateSha, cutAt, trigger: 'schedule', since: null, items: [] });
const greenSuite = (name: string): Suite => ({ name, run: async () => ({ name, passed: true, detail: 'ok' }) });

// The bounded window and its reader arrive with the change; they are reached through a dynamic
// import so a tree without the change fails these cases as test cases — the recorded spurious
// deployment failure — not as an import error the base exercise cannot execute.
const afterRead = async () => {
  const module = await import('../src/release-candidate.js');
  if (typeof module.readServedAfterSuites !== 'function' || typeof module.uatAfterReadWindowMs !== 'number')
    throw new TypeError('this tree predates GY-1970: validate judges the post-suite deployment on a single /healthz read, so an unreadable moment records a move to no observable commit');
  return module;
};

/** One /healthz answer: a commit body (readable only when it holds a full SHA), a non-2xx response, or a thrown network error. */
type Step = string | Response | Error;
const healthy = (commit: string) => new Response(JSON.stringify({ ok: true, version: '0.1.0', revision: 'unknown', schema: 3, commit }));
const refused = () => new Response('unhealthy', { status: 503 });

interface UatStub { fetcher: typeof fetch; probes(): number; now: () => Date; sleep: (ms: number) => Promise<void> }
/**
 * A UAT deployment answering /healthz probe by probe: an array repeats its last answer, a function
 * of the elapsed fake milliseconds and the 1-based probe count decides per read. Everything the
 * check reads is recorded, so a test can count the reads a window spent.
 */
const stub = (serving: readonly Step[] | ((elapsedMs: number, probe: number) => Step)): UatStub => {
  const start = Date.parse(cutAt);
  let elapsed = 0, probe = 0;
  const fetcher = (async (target: URL | string) => {
    if (new URL(String(target)).pathname !== '/healthz') return new Response('ok');
    probe++;
    const step = typeof serving === 'function' ? serving(elapsed, probe) : serving[Math.min(probe - 1, serving.length - 1)];
    if (step instanceof Error) throw step;
    return typeof step === 'string' ? healthy(step) : step;
  }) as unknown as typeof fetch;
  return { fetcher, probes: () => probe, now: () => new Date(start + elapsed), sleep: async ms => { elapsed += ms; } };
};
const run = (uat: UatStub) => validate(candidateAt(), url, [greenSuite('api')], { timeoutMs: 0, fetcher: uat.fetcher, now: uat.now, sleep: uat.sleep });

test('unit:failing-suite-reproduced — candidate 20261017T224540Z\'s failing deployment suite is reproduced: green suites with one unreadable post-suite /healthz read, which recovers into a pass within the window and still fails when nothing becomes readable', async () => {
  // The candidate's observed sequence: /healthz named the candidate SHA before the suites ran and
  // every suite passed, then the post-suite read found nothing observable. A single unreadable
  // moment that recovers to the candidate SHA is the failure the candidate recorded, and the
  // bounded re-read turns it back into the pass the suites earned.
  const moment = stub([candidateSha, refused(), candidateSha]);
  const recovered = await run(moment);
  assert.equal(recovered.result, 'passed', 'the unreadable moment recovered to the candidate SHA within the window');
  assert.deepEqual(recovered.suites.map(suite => suite.name), ['api'], 'no deployment suite is recorded: the suite that failed the candidate is green');
  assert.ok(recovered.suites.every(suite => suite.passed), 'every suite passed');
  assert.equal(recovered.deployedSha, candidateSha, 'the verdict stays bound to the SHA the suites ran against');
  assert.equal(moment.probes(), 3, 'one read before the suites, the unreadable one after them, and the re-read that recovered');

  // The same single unreadable read, with no recovery ever coming, is still a failure — the
  // reproduction is the failing suite's situation, not a run any read would pass.
  const stranded = stub([candidateSha, refused()]);
  const dark = await run(stranded);
  assert.equal(dark.result, 'failed', 'an unreadable moment that never recovers still fails the candidate');
  const deployment = dark.suites.find(suite => suite.name === 'deployment');
  assert.ok(deployment, 'the failure is the deployment suite, the one that failed the candidate');
  assert.match(deployment!.detail, /unreadable/, 'the detail says the deployment was unreadable');
});

test('unit:release-uat-after-read-bounded — the post-suite check re-reads /healthz within a bounded window before judging: every unreadable shape recovers into a pass, the deadline stays unreadable-failed, and a readable move fails as moved', async () => {
  const { uatAfterReadWindowMs } = await afterRead();

  // An unreadable moment of each shape — a non-2xx answer, a network error, a body with no full
  // SHA (an unstamped commit, or a truncated one) — recovering to the candidate SHA passes.
  for (const [shape, moment] of <const>[['non-2xx', refused()], ['network error', new TypeError('read failed')], ['body without a full SHA', 'unknown'], ['short SHA in the body', candidateSha.slice(0, 9)]]) {
    const uat = stub([candidateSha, moment, candidateSha]);
    const result = await run(uat);
    assert.equal(result.result, 'passed', `${shape}: a moment that recovers to the candidate SHA within the window passes`);
    assert.ok(result.suites.every(suite => suite.passed), `${shape}: no deployment failure is recorded`);
  }

  // A recovery exactly at the deadline is still within the window.
  const atDeadline = stub((elapsed, probe) => probe === 1 || elapsed >= uatAfterReadWindowMs ? candidateSha : refused());
  const recovered = await run(atDeadline);
  assert.equal(recovered.result, 'passed', 'a read naming the candidate SHA at the deadline is a recovery, not a move');

  // Unreadable through the deadline fails, and says the deployment was unreadable — never moved,
  // which is what a window of nulls observed nothing about.
  const dark = stub([candidateSha, refused()]);
  const unreadable = await run(dark);
  assert.equal(unreadable.result, 'failed');
  const deployment = unreadable.suites.find(suite => suite.name === 'deployment');
  assert.ok(deployment, 'the failure is the deployment suite');
  assert.match(deployment!.detail, /unreadable/);
  assert.doesNotMatch(deployment!.detail, /moved/, 'an unreadable window is not judged a move');
  assert.ok(dark.probes() > 2, 'the window re-read rather than judging on the first unreadable answer');

  // A readable answer naming another commit still fails as moved, judged at the first read.
  const moved = stub([candidateSha, 'e'.repeat(40)]);
  const movedResult = await run(moved);
  assert.equal(movedResult.result, 'failed');
  const move = movedResult.suites.find(suite => suite.name === 'deployment');
  assert.equal(move?.detail, `UAT moved from ${candidateSha} to ${'e'.repeat(40)} while the suites ran`, 'a readable move is judged exactly as before');
  assert.equal(moved.probes(), 2, 'the readable move ends the window at once: no re-reads');
});

test('unit:release-uat-after-read-bounded — readServedAfterSuites reads once when a read is readable, re-reads only while unreadable, and reports the deadline as unreadable', async () => {
  const { readServedAfterSuites, uatAfterReadWindowMs } = await afterRead();

  // Its clock is read in milliseconds, exactly as `awaitServing`'s is.
  const serving = stub([candidateSha]);
  assert.deepEqual(await readServedAfterSuites(url, { timeoutMs: uatAfterReadWindowMs, fetcher: serving.fetcher, now: () => serving.now().getTime(), sleep: serving.sleep }), { served: candidateSha, readable: true });
  assert.equal(serving.probes(), 1, 'a readable first read is judged at once');

  const moved = stub([refused(), 'e'.repeat(40)]);
  assert.deepEqual(await readServedAfterSuites(url, { timeoutMs: uatAfterReadWindowMs, fetcher: moved.fetcher, now: () => moved.now().getTime(), sleep: moved.sleep }), { served: 'e'.repeat(40), readable: true });
  assert.equal(moved.probes(), 2, 'the first readable answer ends the window whatever it names');

  const dark = stub(() => refused());
  assert.deepEqual(await readServedAfterSuites(url, { timeoutMs: 30_000, intervalMs: 10_000, fetcher: dark.fetcher, now: () => dark.now().getTime(), sleep: dark.sleep }), { served: null, readable: false });
  assert.equal(dark.probes(), 4, 'reads at 0s, 10s, 20s and the 30s deadline, then the window ends');
});

test('unit:release-uat-after-read-bounded — the re-read window is bounded well under the uat job timeout', async () => {
  const { uatAfterReadWindowMs } = await afterRead();
  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  const ceiling = uatValidationCeilingMs(workflow, 'uat');
  assert.ok(uatAfterReadWindowMs > 0);
  assert.ok(uatAfterReadWindowMs * 10 <= ceiling, `the ${uatAfterReadWindowMs / 1000}s re-read window stays an order of magnitude under the ${Math.round(ceiling / 60_000)}m uat ceiling`);
});
