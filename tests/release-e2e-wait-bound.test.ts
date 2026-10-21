import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCases, parseCase } from '../src/e2e/case.js';
import { checkAnswer, checkoutContract, deliverySuspendedCases, deployedE2e, e2eSuite, exercisesDelivery, installServesDeliveries, releaseRetries, releaseWaitBudgetSeconds, releaseWaitUntil, runCases } from '../src/e2e/runner.js';
import { checkoutRepositoryPolicy } from '../src/model/repository-policy.js';

// GY-1938: candidate 20261017T182412Z's e2e suite was killed at its one-hour command timeout. GY-1904
// gave a delivery case seven GET steps that each wait up to 3600 s for a delivery the shared UAT
// install never makes: its merger is github with no GitHub App wired, so it delivers nothing. That
// case left with the release candidates (GY-1983); `deliveryCase` keeps its shape.
// Every case, step and attempt of a release run now shares one wait deadline well below that
// timeout, a pending case asks once, and an install that cannot serve deliveries pends its delivery
// cases, while a case whose condition is met still passes. The run's clock is fake throughout.
const root = new URL('..', import.meta.url).pathname;
const candidate = { id: 'rc-gy-1938', pendingOutcomes: [] as string[] };

/** A fake clock: pausing advances it, and so does every request, by a second of latency. */
const fakeClock = () => {
  const clock = { at: Date.parse('2026-10-17T18:24:12Z'), now: () => clock.at, sleep: async (ms: number) => { clock.at += ms; } };
  return clock;
};
const hour = 3_600_000;
/** One created change, seven waits of 3600 s for its delivery, then the delivery view: the shape of GY-1904's delivery case. */
const deliveryCase = [{ file: 'e2e/cases/delivery-waits.json', definition: parseCase('e2e/cases/delivery-waits.json', JSON.stringify({ id: 'delivery-waits', title: 'A change is delivered', target: 'uat', required: true, steps: [
  { kind: 'http', name: 'create a change', method: 'POST', path: '/api/work', body: { title: 'E2E case {{case}} run {{run}}' }, status: 200, expect: [], save: { id1: 'id' } },
  ...[1, 2, 3, 4, 5, 6, 7].map(n => ({ kind: 'http', name: `delivery read ${n}`, method: 'GET', path: '/api/work/{{id1}}', status: 200, expect: [{ path: 'delivery.mergeSha', type: 'string' }], waitSeconds: 3600 })),
  { kind: 'http', name: 'the delivery view', method: 'GET', path: '/api/delivery', status: 200, expect: [] },
] })) }];

/** UAT as the shared install answers: items are created, none is ever delivered, and no GitHub App is wired (only the repository label is configured). */
const undelivered = (wired = false, clock = fakeClock()) => {
  const reads: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = (init?.method ?? 'GET').toUpperCase();
    reads.push(`${method} ${url.pathname}`); clock.at += 1_000;
    if (url.pathname === '/healthz') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.pathname === '/api/merger') return new Response(JSON.stringify(wired ? { mode: 'control-plane' } : { mode: 'github', merger: 'github' }), { status: 200 });
    if (url.pathname === '/api/status') return new Response(JSON.stringify(wired ? { github: true, repository: 'owner/repo', githubRepository: 'owner/repo' } : { github: false, repository: 'owner/repo', githubRepository: null }), { status: 200 });
    if (method === 'POST' && url.pathname === '/api/work') return new Response(JSON.stringify({ id: `w${reads.length}` }), { status: 200 });
    return new Response(JSON.stringify({ delivery: null }), { status: 200 });
  }) as typeof fetch;
  return { fetcher, reads, clock };
};

test('unit:release-e2e-probe-names-delivery-ability — the probe reads the install\'s merger and wiring, and a merger it cannot read never suspends a case', async () => {
  const unwired = undelivered(false), capable = undelivered(true);
  assert.equal((await installServesDeliveries('http://uat.test', 't', unwired.fetcher)).servesDeliveries, false, 'a github merger with a repository label but no GitHub App wired delivers nothing');
  const githubWired = (async (input: string | URL | Request) => new URL(String(input)).pathname === '/api/merger' ? Response.json({ mode: 'github' }) : Response.json({ github: true, repository: 'owner/repo', githubRepository: 'owner/repo' })) as typeof fetch;
  assert.equal((await installServesDeliveries('http://uat.test', 't', githubWired)).servesDeliveries, true, 'a github merger with its App wired delivers');
  assert.equal((await installServesDeliveries('http://uat.test', 't', capable.fetcher)).servesDeliveries, true, 'a control-plane merger acts on the plane itself');
  const down = (async () => { throw new Error('down'); }) as typeof fetch;
  assert.equal((await installServesDeliveries('http://uat.test', 't', down)).servesDeliveries, true, 'a merger the probe cannot read blocks exactly as before');
  let probed: { deliveryProbe?: string } | undefined;
  const plain = parseCase('e2e/cases/plain.json', JSON.stringify({ id: 'plain', title: 'Plain', target: 'uat', required: true, steps: [{ kind: 'http', method: 'GET', path: '/healthz', status: 200, expect: [] }] }));
  const noMerger = (async (input: string | URL | Request) => new URL(String(input)).pathname === '/api/merger' ? new Response('', { status: 500 }) : Response.json({ ok: true })) as typeof fetch;
  const plainRun = await e2eSuite([{ file: 'e2e/cases/plain.json', definition: plain }], 't', { fetcher: noMerger, report: value => { probed = value; } }).run('http://uat.test', null);
  assert.equal(plainRun.passed, true, plainRun.detail);
  assert.equal(probed?.deliveryProbe, 'unreadable', 'the run report names a probe that could not read the merger');
  const cases = [...(await loadCases(root)).filter(entry => entry.definition.target === 'uat'), ...deliveryCase];
  assert.deepEqual(deliverySuspendedCases(cases, false), ['delivery-waits'], 'the delivery cases are the ones a no-delivery install cannot serve');
  assert.deepEqual(deliverySuspendedCases(cases, true), [], 'an install that can deliver runs every case for real');
  assert.ok(exercisesDelivery({ steps: [{ kind: 'http', method: 'GET', path: '/api/delivery', status: 200, expect: [] }] }), 'the delivery surface is recognised');
  assert.ok(!exercisesDelivery({ steps: [{ kind: 'http', method: 'GET', path: '/api/work', status: 200, expect: [] }] }), 'an ordinary case is not');
});

test('unit:release-e2e-pending-case-never-waits — a delivery case, undeliverable on the install, is asked once per attempt and reported pending in the e2e suite, without failing it', async () => {
  const cases = deliveryCase;
  const contract = await checkoutContract(root), policy = checkoutRepositoryPolicy(root);

  const suite = undelivered(false), began = suite.clock.at;
  const result = await e2eSuite(cases, 't', { fetcher: suite.fetcher, root, contract, policy, now: suite.clock.now, sleep: suite.clock.sleep }).run('http://uat.test', candidate);
  assert.ok(suite.clock.at - began < 60_000, `the suite took ${suite.clock.at - began} fake ms`);
  assert.equal(result.passed, true, result.detail);
  assert.match(result.detail, /pending, not blocking: case delivery-waits/);
  assert.match(result.detail, /the install serves no deliveries \(merger github without a repository wired\)/);
  assert.equal(suite.reads.filter(read => read.startsWith('GET /api/work/')).length, 2, 'each of the two attempts asked once for the first delivery, then stopped');
});

test('unit:release-e2e-wait-bound — seven waiting GET steps of 3600 s each, in a required case not pending, share the run\'s one deadline: the suite reports inside its one-hour command timeout', async () => {
  const cases = deliveryCase;
  const waits = cases[0].definition.steps.filter(step => step.kind === 'http' && step.method === 'GET' && step.waitSeconds === 3600);
  assert.equal(waits.length, 7, 'the case waits on seven sequential GET steps of 3600 s');
  assert.ok(releaseWaitBudgetSeconds * 1000 < hour, 'the shared deadline falls below the command timeout');
  const contract = await checkoutContract(root), policy = checkoutRepositoryPolicy(root);

  // An install that can deliver, so nothing is suspended, but whose deliveries never arrive: the worst case for the waits.
  const install = undelivered(true), began = install.clock.at;
  const result = await e2eSuite(cases, 't', { fetcher: install.fetcher, root, contract, policy, now: install.clock.now, sleep: install.clock.sleep }).run('http://uat.test', candidate);
  const took = install.clock.at - began;
  assert.ok(took < hour, `the suite took ${took / 1000} fake s against a ${hour / 1000} s timeout`);
  assert.ok(took <= releaseWaitBudgetSeconds * 1000 + 120_000, `waits past the shared deadline cost only single asks: ${took / 1000} fake s`);
  assert.equal(result.passed, false, 'an unmet required case still blocks');
  assert.match(result.detail, /after waiting \d+ s, all that remained of case candidate-batches-five's \d+ s wait budget for this attempt/);
  assert.match(result.detail, /delivery\.mergeSha is unset \(delivery is null\), expected string/, 'the failure names the delivery state the install answered, not an undefined-typed value');
  assert.doesNotMatch(result.detail, /after 0 s|shared wait deadline|is undefined/);

  const direct = undelivered(true), start = direct.clock.at;
  const report = await runCases(cases, { url: 'http://uat.test', token: 't', fetcher: direct.fetcher, now: direct.clock.now, sleep: direct.clock.sleep, retries: releaseRetries, waitUntil: releaseWaitUntil(start) });
  assert.equal(report.cases[0].attempts, 2, 'the retry shares the same deadline');
  assert.ok(direct.clock.at - start < hour);
});

test('unit:release-e2e-met-condition-passes — a waiting case whose deliveries arrive inside the shared deadline still passes, after asking again while it waited', async () => {
  const waiting = parseCase('e2e/cases/waits.json', JSON.stringify({ id: 'waits', title: 'Waits', target: 'uat', required: true,
    steps: [1, 2].map(n => ({ kind: 'http', method: 'GET', path: `/api/work/w${n}`, status: 200, waitSeconds: 3600, expect: [{ path: 'delivery.mergeSha', type: 'string' }] })) }));
  const clock = fakeClock(), began = clock.at, reads: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input)); reads.push(url.pathname); clock.at += 1_000;
    if (url.pathname === '/healthz') return Response.json({ ok: true });
    // The delivery lands ten fake minutes into the run.
    return Response.json({ delivery: clock.at - began >= 600_000 ? { mergeSha: 'a'.repeat(40) } : null });
  }) as typeof fetch;
  const report = await runCases([{ file: 'e2e/cases/waits.json', definition: waiting }], { url: 'http://uat.test', token: 't', fetcher, now: clock.now, sleep: clock.sleep, retries: releaseRetries, waitUntil: releaseWaitUntil(began) });
  assert.equal(report.cases[0].verdict, 'passed', JSON.stringify(report.cases[0].failingStep));
  assert.equal(report.cases[0].attempts, 1);
  assert.ok(reads.filter(path => path === '/api/work/w1').length > 1, 'it asked again while it waited');
  assert.ok(clock.at - began < releaseWaitBudgetSeconds * 1000);
});

test('unit:release-e2e-wait-is-bounded — a step\'s own cap still bounds its wait, and names it', async () => {
  const waiting = parseCase('e2e/cases/waits.json', JSON.stringify({ id: 'waits', title: 'Waits', target: 'uat', required: true,
    steps: [{ kind: 'http', method: 'GET', path: '/api/work/one', status: 200, waitSeconds: 3600, expect: [{ path: 'delivery.mergeSha', type: 'string' }] }] }));
  const { fetcher, reads, clock } = undelivered();
  const report = await runCases([{ file: 'e2e/cases/waits.json', definition: waiting }], { url: 'http://uat.test', token: 't', fetcher, now: clock.now, sleep: clock.sleep, waitPollMs: 100, maxWaitSeconds: 1, pendingCases: ['other'] });
  assert.equal(report.cases[0].outcome, 'fail');
  assert.match(report.cases[0].failingStep!.reason, /\(still, after waiting 1 s\)/); assert.ok(reads.filter(read => read.startsWith('GET /api/work/')).length >= 1);
});

// GY-2603: the deploy run held all fifteen cases under the one shared deadline, so candidate-batches-five's waits spent it and every later waiting case was granted 0 s and failed, rolling back every deploy.
const waitingCase = (id: string, path: string) => ({ file: `e2e/cases/${id}.json`, definition: parseCase(`e2e/cases/${id}.json`, JSON.stringify({ id, title: id, target: 'uat', required: true,
  steps: [{ kind: 'http', method: 'GET', path, status: 200, waitSeconds: 3600, expect: [{ path: 'delivery.mergeSha', type: 'string' }] }] })) });

test('unit:release-e2e-wait-bound — a case whose path reads nothing names the nearest value the answer holds, not an undefined type', () => {
  const step = { kind: 'http', method: 'GET', path: '/x', status: 200, expect: [{ path: 'delivery.mergeSha', type: 'string' }] } as const;
  assert.equal(checkAnswer(step as never, 200, { delivery: { state: 'merging' } }, ''), 'delivery.mergeSha is unset (delivery is {"state":"merging"}), expected string');
  assert.equal(checkAnswer(step as never, 200, { id: 'w1' }, ''), 'delivery.mergeSha is unset ((body) is {"id":"w1"}), expected string');
  assert.equal(checkAnswer(step as never, 200, undefined, ''), 'delivery.mergeSha is unset (the answer has no body), expected string');
});

test('integration:e2e-runner-wait-budget — a deploy run whose first case never delivers still gives every later case its own wait, and rolls back naming each failing case', async () => {
  const clock = fakeClock(), began = clock.at;
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input)); clock.at += 1_000;
    if (url.pathname === '/healthz') return Response.json({ ok: true });
    if (url.pathname === '/api/merger') return Response.json({ mode: 'control-plane' });
    if (url.pathname === '/api/status') return Response.json({ github: true });
    // `never` is never delivered; each `late` item is delivered two fake minutes after it is first asked about.
    if (url.pathname === '/api/work/never') return Response.json({ delivery: null });
    const first = (asked[url.pathname] ??= clock.at);
    return Response.json({ delivery: clock.at - first >= 120_000 ? { mergeSha: 'a'.repeat(40) } : { state: 'merging' } });
  }) as typeof fetch;
  const asked: Record<string, number> = {};
  const cases = [waitingCase('a-never', '/api/work/never'), ...[1, 2, 3].map(n => waitingCase(`b-late-${n}`, `/api/work/late${n}`))];
  const suite = ((_cases: unknown, token: string, options: Parameters<typeof e2eSuite>[2]) => e2eSuite(cases, token, { ...options, fetcher, now: clock.now, sleep: clock.sleep })) as typeof e2eSuite;
  const rolledBack = await deployedE2e(root, 'http://install.test', 't', suite).then(() => null, (error: Error) => error.message);
  assert.ok(clock.at - began < hour, `the run took ${(clock.at - began) / 1000} fake s`);
  assert.ok(rolledBack, 'the failing required case still fails the deploy');
  assert.match(rolledBack!, /case a-never failed at step 1 .*delivery\.mergeSha is unset \(delivery is null\), expected string \(still, after waiting \d+ s, all that remained of case a-never's \d+ s wait budget for this attempt\)/);
  assert.doesNotMatch(rolledBack!, /b-late|after 0 s|shared wait deadline/, 'every later case waited for its delivery and passed');
});
