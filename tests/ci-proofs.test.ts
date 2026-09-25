import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Dependency-free protected workflow script.
import { ciProofFamilies as registryFamilies, contract, contracts, planCiProofs } from '../scripts/contracts.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { defineUnitContract, judgeUnitCases, parseTap } from '../scripts/unit-contract.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { candidateWork, ciPlan, matrixEntry, planFromControlPlane } from '../scripts/enumerate-ci-proofs.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { ciRunEvents as reporterEvents, grantAuthorizes, observeCiRun, publishCiReport, readCiReports, validateCiRun, validateReport } from '../scripts/publish-acceptance.mjs';
import { ciFamilyAllows, ciPatternAllowed, ciProducerRuntime, ciProofFamilies, ciRunEvents, ciRunRefusal, compareCiAttempts, isCiProducer, observeCiCheckRun, staleCiAttemptRefusal, type CiRunBinding } from '../src/model/ci-proofs.js';
import { ciProducerGrants, ciProducerId, ciProducerPrincipal, ciProducerProvisioningSteps, ciProducerSecret, readRoster, registerCiProducer, withCiProducer } from '../src/install/ci-proofs.js';
import { delegationLimitAssignments } from '../src/install/limits.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), harness = 'c'.repeat(40);

// ---------------------------------------------------------------------------
// unit:ci-proofs-enumeration — the registry decides what CI runs; nothing else does
// ---------------------------------------------------------------------------
test('unit:ci-proofs-enumeration only unit and integration proofs are automatable', () => {
  assert.deepEqual([...ciProofFamilies], ['unit', 'integration']);
  assert.deepEqual([...registryFamilies], [...ciProofFamilies]);
  assert.equal(ciFamilyAllows('unit:anything'), true);
  assert.equal(ciFamilyAllows('integration:claim-safety'), true);
  assert.equal(ciFamilyAllows('manual:ci-proofs-docs'), false);
  assert.equal(ciFamilyAllows('e2e:deploy-smoke'), false);
  assert.equal(ciFamilyAllows('bogus'), false);
  // The CI producer's grant set is the two families and can never widen past them.
  assert.deepEqual(ciProducerGrants, ['unit:*', 'integration:*']);
  assert.equal(ciPatternAllowed('manual:*'), false);
  assert.equal(ciPatternAllowed('e2e:*'), false);
  assert.equal(ciPatternAllowed('integration:gy-65/*'), true);
  assert.equal(isCiProducer({ id: 'ci-proofs', role: 'producer', runtime: ciProducerRuntime }), true);
  assert.equal(isCiProducer({ id: 'trusted-acceptance', role: 'producer' }), false);
  assert.equal(isCiProducer({ id: 'operator', role: 'admin', runtime: ciProducerRuntime }), false);
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
  // Matrix entries name a filesystem-safe artifact slug beside the proof.
  assert.deepEqual(matrixEntry({ proof: 'integration:gy-65/trust', kind: 'integration' }), { proof: 'integration:gy-65/trust', kind: 'integration', slug: 'integration-gy-65-trust' });
  // The plan for a pull request is bound to the control plane's candidate record, never the event.
  const work = { id: '00000000-0000-4000-8000-000000000001', key: 'GY-65', stage: 'build', submission: { epoch: 1, pr: 7 }, policyRevision: 3, candidate: { sha: head, baseSha: base, pr: 7 },
    criteria: [{ id: 'AC-1', proofs: ['integration:claim-safety', 'manual:ci-proofs-docs'] }, { id: 'AC-2', proofs: ['unit:ci-proofs-enumeration'] }] };
  assert.equal(candidateWork([work, { ...work, id: 'x', stage: 'done' }], 7), work);
  assert.equal(candidateWork([work], 8), null);
  assert.throws(() => candidateWork([work, { ...work, id: 'y', key: 'GY-66' }], 7), /ambiguous/);
  const bound = ciPlan(work, head);
  assert.deepEqual(bound.work, { id: work.id, key: 'GY-65', pr: 7, policyRevision: 3, head, base });
  assert.deepEqual(bound.proofs.map((entry: any) => entry.proof), ['integration:claim-safety', 'unit:ci-proofs-enumeration']);
  assert.deepEqual(bound.deferred.map((entry: any) => entry.proof), ['manual:ci-proofs-docs']);
  assert.match(ciPlan(work, 'd'.repeat(40)).reason, /not dddd/);
  assert.match(ciPlan(null, head).reason, /no submitted candidate/);
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

// ---------------------------------------------------------------------------
// integration:ci-proofs-workflow — the protected chain from plan to publication
// ---------------------------------------------------------------------------
const expected = { repository: 'owner/repo', workId: '00000000-0000-4000-8000-000000000001', pr: 7, policyRevision: 1, runId: '900', runAttempt: '2', harnessCommit: harness };
const report = (proof = 'integration:claim-safety', result = 'pass') => ({ ...expected, schema: 1, proof, result, sha: head, baseSha: base, testedTree: 'd'.repeat(40),
  cases: contract(proof).requiredCases.map((id: string) => ({ id, result: result === 'pass' ? 'pass' : 'fail' })), executed: contract(proof).requiredCases.length, skipped: 0 });
const run = { id: 900, run_attempt: 2, repository: { full_name: 'owner/repo' }, head_sha: head, head_branch: 'graphyard/gy-65-1', status: 'in_progress', conclusion: null, event: 'pull_request_target', run_started_at: '2026-09-19T11:00:00Z' };
const job = (name = 'integration:claim-safety', overrides: Record<string, unknown> = {}) => ({ id: 4242, name, run_id: 900, run_attempt: 2, head_sha: head, status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/900/job/4242', ...overrides });
const binding: CiRunBinding = { provider: 'github-actions', repository: 'owner/repo', runId: '900', runAttempt: 2, jobId: 4242 };

test('integration:ci-proofs-workflow the reporter binds a report to the job that ran on the candidate head, never to the harness commit', () => {
  assert.deepEqual(validateCiRun(run, [job(), job('plan', { id: 1 })], report(), expected), { binding, jobUrl: 'https://github.com/owner/repo/actions/runs/900/job/4242' });
  assert.deepEqual([...reporterEvents], [...ciRunEvents]);
  // head_sha must equal the reported candidate head: a run on main (the harness commit) certifies nothing.
  assert.throws(() => validateCiRun({ ...run, head_sha: harness }, [job()], report(), expected), /ran on ccc/);
  assert.throws(() => validateCiRun({ ...run, event: 'push' }, [job()], report(), expected), /takes its definition from the candidate/);
  assert.throws(() => validateCiRun({ ...run, event: 'pull_request' }, [job()], report(), expected), /pull_request_target or workflow_dispatch/);
  assert.throws(() => validateCiRun({ ...run, id: 901 }, [job()], report(), expected), /does not match this trusted reporter invocation/);
  assert.throws(() => validateCiRun({ ...run, run_attempt: 1 }, [job()], report(), expected), /does not match/);
  assert.throws(() => validateCiRun(run, [], report(), expected), /found 0/);
  assert.throws(() => validateCiRun(run, [job(), job()], report(), expected), /found 2/);
  assert.throws(() => validateCiRun(run, [job('integration:claim-safety', { run_attempt: 1 })], report(), expected), /found 0/);
  assert.throws(() => validateCiRun(run, [job('integration:claim-safety', { head_sha: harness })], report(), expected), /has not completed on the reported candidate head/);
  assert.throws(() => validateCiRun(run, [job('integration:claim-safety', { status: 'in_progress', conclusion: null })], report(), expected), /has not completed/);
  // The job's conclusion is the result: a pass from a failed job, or a fail from a green one, is refused.
  assert.throws(() => validateCiRun(run, [job('integration:claim-safety', { conclusion: 'failure' })], report(), expected), /concluded failure; a pass report/);
  assert.throws(() => validateCiRun(run, [job()], report('integration:claim-safety', 'fail'), expected), /concluded success; a fail report/);
  assert.deepEqual(validateCiRun(run, [job('integration:claim-safety', { conclusion: 'failure' })], report('integration:claim-safety', 'fail'), expected).binding, binding);
  // Families outside the CI lane never publish, whatever job claims them.
  assert.throws(() => validateCiRun(run, [job('manual:ci-proofs-docs')], { ...report(), proof: 'manual:ci-proofs-docs' }, expected), /not an automatable proof/);
  assert.throws(() => validateCiRun(run, [job('e2e:deploy-smoke')], { ...report(), proof: 'e2e:deploy-smoke' }, expected), /not an automatable proof/);
});

test('integration:ci-proofs-workflow the reporter reads the attempt-scoped run and its jobs from GitHub before publishing', async () => {
  const requested: string[] = [];
  const fetcher = async (url: string) => { requested.push(url); return new Response(JSON.stringify(url.includes('/jobs') ? { total_count: 2, jobs: [job('plan', { id: 1 }), job()] } : run)); };
  assert.deepEqual(await observeCiRun(expected, report(), 'token-only', fetcher), { binding, jobUrl: 'https://github.com/owner/repo/actions/runs/900/job/4242' });
  assert.ok(requested.some(url => url.endsWith('/actions/runs/900/attempts/2')));
  assert.ok(requested.some(url => url.includes('/actions/runs/900/attempts/2/jobs?')));
  await assert.rejects(observeCiRun(expected, report(), '', fetcher), /token is required/);
  await assert.rejects(observeCiRun({ ...expected, runAttempt: 'latest' }, report(), 'token-only', fetcher), /Invalid run identity/);
  await assert.rejects(observeCiRun({ ...expected, repository: 'owner/repo/../other' }, report(), 'token-only', fetcher), /Invalid repository/);
  await assert.rejects(observeCiRun(expected, report(), 'token-only', async () => new Response('{}', { status: 404 })), /Cannot verify the GitHub run \(404\)/);
});

test('integration:ci-proofs-workflow the reporter refuses a stale candidate, a foreign producer and an ungranted proof before submitting', async () => {
  const calls: { path: string; body: any }[] = [];
  const controlPlane = (overrides: { actor?: any; authorities?: any[]; work?: any }) => async (url: string, init: any) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    if (path === '/api/status') return new Response(JSON.stringify({ actor: overrides.actor ?? { id: 'ci-proofs', role: 'producer', runtime: 'github-actions' } }));
    if (path === '/api/proof-grants') return new Response(JSON.stringify({ authorities: overrides.authorities ?? [{ principalId: 'ci-proofs', patterns: ['unit:*', 'integration:*'] }] }));
    if (path === '/api/work') return new Response(JSON.stringify([overrides.work ?? { id: expected.workId, stage: 'build', policyRevision: 1, candidate: { pr: 7, sha: head, baseSha: base } }]));
    return new Response(JSON.stringify({ evidence: [] }));
  };
  const ci = { binding, jobUrl: 'https://github.com/owner/repo/actions/runs/900/job/4242' };
  const configuration = { url: 'https://graphyard.example/', token: 'ci-secret', expected: { ...expected, proof: 'integration:claim-safety' }, ci };
  await publishCiReport(report(), configuration, controlPlane({}));
  const submitted = calls.find(call => call.path.endsWith('/evidence'))!;
  assert.equal(submitted.path, `/api/work/${expected.workId}/evidence`);
  assert.deepEqual(submitted.body, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 5, skipped: 0,
    url: 'https://github.com/owner/repo/actions/runs/900/attempts/2', artifacts: [{ kind: 'log', label: 'GitHub Actions job integration:claim-safety', availability: 'external', url: ci.jobUrl }], ciRun: binding });
  await assert.rejects(publishCiReport(report(), { ...configuration, ci: undefined }, controlPlane({})), /binding is required/);
  await assert.rejects(publishCiReport(report(), { ...configuration, ci: { ...ci, binding: { ...binding, runAttempt: 1 } } }, controlPlane({})), /does not match the report/);
  await assert.rejects(publishCiReport(report(), { ...configuration, url: 'http://graphyard.example/' }, controlPlane({})), /credential-free HTTPS/);
  await assert.rejects(publishCiReport(report(), configuration, controlPlane({ actor: { id: 'trusted-acceptance', role: 'producer' } })), /not the CI producer principal/);
  await assert.rejects(publishCiReport(report(), configuration, controlPlane({ authorities: [{ principalId: 'ci-proofs', patterns: ['unit:*'] }] })), /not granted integration:claim-safety/);
  await assert.rejects(publishCiReport(report(), configuration, controlPlane({ work: { id: expected.workId, stage: 'build', policyRevision: 1, candidate: { pr: 7, sha: 'e'.repeat(40), baseSha: base } } })), /Candidate changed/);
  await assert.rejects(publishCiReport(report(), configuration, controlPlane({ work: { id: expected.workId, stage: 'build', policyRevision: 2, candidate: { pr: 7, sha: head, baseSha: base } } })), /Candidate changed/);
  // The shared report validation still guards the inventory and the run identity.
  assert.throws(() => validateReport({ ...report(), executed: 0 }, expected));
  assert.throws(() => validateReport({ ...report(), harnessCommit: 'e'.repeat(40) }, expected));
  assert.equal(grantAuthorizes('integration:*', 'integration:claim-safety'), true);
  assert.equal(grantAuthorizes('integration:gy-65/*', 'integration:gy-65'), false);
  assert.equal(grantAuthorizes('manual:*', 'integration:claim-safety'), false);
});

test('integration:ci-proofs-workflow the plan waits for the control plane to observe the pushed head, then reads head, base and policy revision from it', async () => {
  const work = { id: expected.workId, key: 'GY-65', stage: 'build', submission: { epoch: 1, pr: 7 }, policyRevision: 4, candidate: { sha: 'e'.repeat(40), baseSha: base, pr: 7 }, criteria: [{ id: 'AC-1', proofs: ['integration:claim-safety', 'manual:ci-proofs-docs'] }] };
  let reads = 0;
  const fetcher = async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/status') return new Response(JSON.stringify({ actor: { id: 'ci-proofs', role: 'producer' } }));
    reads++;
    return new Response(JSON.stringify([reads >= 3 ? { ...work, candidate: { ...work.candidate, sha: head } } : work]));
  };
  const plan = await planFromControlPlane({ url: 'https://graphyard.example/', token: 'ci-secret', pr: 7, head, waitMs: 60_000, intervalMs: 1, fetcher, sleep: async () => {} });
  assert.equal(reads, 3);
  assert.deepEqual(plan.work, { id: expected.workId, key: 'GY-65', pr: 7, policyRevision: 4, head, base });
  assert.deepEqual(plan.proofs, [{ proof: 'integration:claim-safety', kind: 'integration' }]);
  assert.deepEqual(plan.deferred.map((entry: any) => entry.proof), ['manual:ci-proofs-docs']);
  // A head the control plane never observes plans nothing, with the reason.
  const stale = await planFromControlPlane({ url: 'https://graphyard.example/', token: 'ci-secret', pr: 7, head: 'f'.repeat(40), waitMs: 0, intervalMs: 1, fetcher, sleep: async () => {} });
  assert.deepEqual(stale.proofs, []); assert.match(stale.reason, /not ffff/);
  await assert.rejects(planFromControlPlane({ url: 'https://graphyard.example/', token: 'x', pr: 7, head, fetcher: async () => new Response(JSON.stringify({ actor: { role: 'worker' } })) }), /not a producer principal/);
  await assert.rejects(planFromControlPlane({ url: 'http://graphyard.example/', token: 'x', pr: 7, head, fetcher }), /credential-free HTTPS/);
});

test('integration:ci-proofs-workflow the publisher reads one report per downloaded artifact directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-ci-reports-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(directory, 'graphyard-acceptance-2-integration-claim-safety'));
  await writeFile(join(directory, 'graphyard-acceptance-2-integration-claim-safety', 'acceptance.json'), JSON.stringify(report()));
  await mkdir(join(directory, 'graphyard-acceptance-2-empty'));
  await writeFile(join(directory, 'stray.json'), '{}');
  const reports = await readCiReports(directory);
  assert.deepEqual(reports.map((entry: any) => entry.artifact), ['graphyard-acceptance-2-integration-claim-safety']);
  assert.equal(reports[0].report.proof, 'integration:claim-safety');
});

test('integration:ci-proofs-workflow the acceptance workflow plans, exercises and publishes with the secrets confined to protected jobs', async () => {
  const workflow = await readFile(new URL('../.github/workflows/acceptance.yml', import.meta.url), 'utf8');
  // Candidate pushes are planned from the default branch's definition; forks and non-candidate branches never are.
  assert.match(workflow, /pull_request_target:\n\s+types: \[opened, reopened, synchronize\]\n\s+branches: \[main\]/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository && startsWith\(github\.head_ref, 'graphyard\/'\)/);
  assert.match(workflow, /permissions:\n  contents: read\n  actions: read\n/);
  const jobs = Object.fromEntries([...workflow.matchAll(/^  ([a-z]+):\n([\s\S]*?)(?=^  [a-z]+:\n|(?![\s\S]))/gm)].map(match => [match[1], match[2]]));
  assert.deepEqual(Object.keys(jobs), ['plan', 'exercise', 'publish']);
  // Only the two protected jobs run in the reporting environment; the exercise job — the only one that builds or runs candidate code — holds no secret.
  assert.match(jobs.plan, /environment: graphyard-reporting/); assert.match(jobs.publish, /environment: graphyard-reporting/);
  assert.doesNotMatch(jobs.exercise, /environment:|secrets\./);
  assert.match(jobs.exercise, /name: \$\{\{ matrix\.proof \}\}/);
  assert.match(jobs.exercise, /include: \$\{\{ fromJSON\(needs\.plan\.outputs\.proofs\) \}\}/);
  assert.match(jobs.exercise, /run-acceptance\.mjs candidate\.json graphyard-acceptance acceptance\.json/);
  assert.match(jobs.exercise, /run-unit-acceptance\.mjs candidate\.json candidate acceptance\.json/);
  assert.match(jobs.exercise, /cache: npm/); assert.match(jobs.exercise, /postgres-17-alpine\.tar/); assert.match(jobs.exercise, /cache-from: type=gha/);
  assert.match(jobs.publish, /publish-acceptance\.mjs --candidate-run reports/);
  assert.match(jobs.publish, /GRAPHYARD_CI_PRODUCER_TOKEN: \$\{\{ secrets\.GRAPHYARD_CI_PRODUCER_TOKEN \}\}/);
  assert.match(jobs.plan, /GRAPHYARD_CI_PRODUCER_TOKEN: \$\{\{ secrets\.GRAPHYARD_CI_PRODUCER_TOKEN \}\}/);
  // The workflow lint runs in required CI with a pinned, checksummed actionlint.
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /workflow-lint:/); assert.match(ci, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/); assert.match(ci, /sha256sum --check/);
});

test('the unit runner installs the candidate before the protected inventory lands and verifies it byte for byte before the run', async () => {
  // A candidate's install lifecycle scripts run during `npm ci`; the inventory must be copied after
  // them, and checked right before the test process starts, or the judged cases are not the harness's.
  // The install is contained (containedInstall): its own PID namespace ends every process it started
  // before the copy, so nothing it left behind can replace the inventory after the check.
  const runner = await readFile(new URL('../scripts/run-unit-acceptance.mjs', import.meta.url), 'utf8');
  assert.match(runner, /const install = containedInstall\(candidate\);\n\s*execFileSync\(install\.command, install\.args,/);
  const install = runner.indexOf('execFileSync(install.command, install.args'), copy = runner.indexOf('await copyFile(join(harness, selected.file)'), compare = runner.indexOf('.equals(await readFile(join(candidate, selected.file)))'), run = runner.indexOf('spawnSync(process.execPath');
  assert.ok(install >= 0 && copy >= 0 && compare >= 0 && run >= 0);
  assert.ok(install < copy && copy < compare && compare < run);
  assert.doesNotMatch(runner.slice(compare, run), /execFileSync|spawnSync|copyFile/);
});

// ---------------------------------------------------------------------------
// integration:ci-proofs-trust — the control plane's own judgement of a CI binding (pure part;
// the server-side refusals run against a real database in ci-proofs-trust.test.ts)
// ---------------------------------------------------------------------------
const checkRun = (overrides: Record<string, unknown> = {}) => ({ id: 4242, head_sha: head, status: 'completed', conclusion: 'success', name: 'integration:claim-safety', details_url: 'https://github.com/owner/repo/actions/runs/900/job/4242', app: { id: 15368 }, ...overrides });
test('integration:ci-proofs-trust a binding certifies only the named job, from GitHub Actions, on the evidence commit, concluded as the result claims', () => {
  const observed = observeCiCheckRun('owner/repo', checkRun(), new Date('2026-09-19T12:00:00Z'));
  assert.deepEqual(observed, { repository: 'owner/repo', jobId: 4242, headSha: head, appId: 15368, detailsUrl: 'https://github.com/owner/repo/actions/runs/900/job/4242', status: 'completed', conclusion: 'success', name: 'integration:claim-safety', observedAt: '2026-09-19T12:00:00.000Z' });
  const evidence = { sha: head, result: 'pass' as const };
  assert.equal(ciRunRefusal(binding, observed, evidence, 'owner/repo'), null);
  assert.equal(ciRunRefusal(binding, observed, evidence, 'Owner/Repo'), null);
  assert.match(ciRunRefusal(binding, null, evidence, 'owner/repo')!, /could not be read/);
  assert.match(ciRunRefusal(binding, observed, evidence, 'other/repo')!, /names repository owner\/repo/);
  assert.match(ciRunRefusal({ ...binding, jobId: 1 }, observed, evidence, 'owner/repo')!, /reported job 4242, not the job 1/);
  assert.match(ciRunRefusal(binding, observeCiCheckRun('owner/repo', checkRun({ app: { id: 99 } })), evidence, 'owner/repo')!, /not published by GitHub Actions/);
  assert.match(ciRunRefusal(binding, observeCiCheckRun('owner/repo', checkRun({ details_url: 'https://github.com/owner/repo/actions/runs/901/job/4242' })), evidence, 'owner/repo')!, /belongs to workflow run 901/);
  assert.match(ciRunRefusal(binding, observeCiCheckRun('owner/repo', checkRun({ head_sha: harness })), evidence, 'owner/repo')!, /ran on ccc/);
  assert.match(ciRunRefusal(binding, observeCiCheckRun('owner/repo', checkRun({ status: 'in_progress', conclusion: null })), evidence, 'owner/repo')!, /has not completed/);
  assert.match(ciRunRefusal(binding, observeCiCheckRun('owner/repo', checkRun({ conclusion: 'failure' })), evidence, 'owner/repo')!, /concluded failure; a pass result/);
  assert.equal(ciRunRefusal(binding, observeCiCheckRun('owner/repo', checkRun({ conclusion: 'failure' })), { sha: head, result: 'fail' }, 'owner/repo'), null);
  // The trusted CI App set is the engine's, so a deployment that trusts another CI App names it once.
  assert.equal(ciRunRefusal(binding, observeCiCheckRun('owner/repo', checkRun({ app: { id: 99 } })), evidence, 'owner/repo', [99]), null);
});

test('integration:ci-proofs-trust an older run attempt can never overwrite a newer result for the same proof and candidate', () => {
  const stored = (runId: string, runAttempt: number, overrides: Record<string, unknown> = {}) => ({ id: runId, proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, producer: 'ci-proofs', trusted: true, result: 'pass' as const, executed: 5, skipped: 0, at: '', ciRun: { ...binding, runId, runAttempt, headSha: head, job: null, conclusion: 'success', verifiedAt: '' }, ...overrides });
  const submission = (runId: string, runAttempt: number, overrides: Record<string, unknown> = {}) => ({ proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, ciRun: { runId, runAttempt }, ...overrides });
  assert.equal(compareCiAttempts({ runId: '900', runAttempt: 1 }, { runId: '900', runAttempt: 2 }), -1);
  assert.equal(compareCiAttempts({ runId: '901', runAttempt: 1 }, { runId: '900', runAttempt: 9 }), 1);
  assert.equal(compareCiAttempts({ runId: '35437272466', runAttempt: 1 }, { runId: '35437272466', runAttempt: 1 }), 0);
  assert.equal(staleCiAttemptRefusal([], submission('900', 1)), null);
  assert.equal(staleCiAttemptRefusal([stored('900', 1)], submission('900', 2)), null);
  assert.equal(staleCiAttemptRefusal([stored('900', 2)], submission('901', 1)), null);
  assert.match(staleCiAttemptRefusal([stored('900', 2)], submission('900', 1))!, /older than the recorded run 900 attempt 2/);
  assert.match(staleCiAttemptRefusal([stored('900', 1), stored('901', 1)], submission('900', 2))!, /older than the recorded run 901 attempt 1/);
  assert.match(staleCiAttemptRefusal([stored('900', 2)], submission('900', 2))!, /already recorded/);
  // Another proof, candidate or policy revision is a different ledger line.
  assert.equal(staleCiAttemptRefusal([stored('900', 2)], submission('900', 1, { proof: 'unit:ci-proofs-enumeration' })), null);
  assert.equal(staleCiAttemptRefusal([stored('900', 2)], submission('900', 1, { sha: 'e'.repeat(40) })), null);
  assert.equal(staleCiAttemptRefusal([stored('900', 2)], submission('900', 1, { policyRevision: 2 })), null);
  // Producer-session evidence carries no run binding and is never compared.
  assert.equal(staleCiAttemptRefusal([stored('900', 2, { ciRun: undefined })], submission('900', 1)), null);
});

// ---------------------------------------------------------------------------
// The installer provisions the principal and says where the secret goes
// ---------------------------------------------------------------------------
test('integration:ci-proofs-trust the installer registers the CI producer with the family grants only, keeps its token, and counts it toward reviewer capacity', async () => {
  const fresh = ciProducerPrincipal([], () => 'generated-token-'.padEnd(40, 'x'));
  assert.deepEqual(fresh, { id: ciProducerId, role: 'producer', runtime: ciProducerRuntime, proofs: ['unit:*', 'integration:*'], token: 'generated-token-'.padEnd(40, 'x') });
  assert.equal(ciProducerPrincipal([{ id: ciProducerId, token: 'kept-token-'.padEnd(40, 'k') }]).token, 'kept-token-'.padEnd(40, 'k'));
  // An operator-edited entry is normalized back to the families; other principals are untouched.
  const roster = withCiProducer([{ id: 'operator', role: 'admin', token: 'o'.repeat(40) }, { id: ciProducerId, role: 'producer', proofs: ['manual:*'], token: 'kept-token-'.padEnd(40, 'k') }]);
  assert.deepEqual(roster.map(entry => entry.id), ['operator', ciProducerId]);
  assert.deepEqual((roster[1] as any).proofs, ['unit:*', 'integration:*']); assert.equal((roster[1] as any).token, 'kept-token-'.padEnd(40, 'k'));
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-ci-install-'));
  const file = join(directory, 'principals.json');
  await writeFile(file, JSON.stringify({ version: 1, principals: [{ id: 'operator', role: 'admin', token: 'o'.repeat(40) }, { id: 'evidence', role: 'producer', proofs: ['integration:x'], token: 'e'.repeat(40) }] }), { mode: 0o600 });
  const first = await registerCiProducer(file, [], () => 't'.repeat(40));
  assert.deepEqual(first, { principal: ciProducerId, runtime: ciProducerRuntime, grants: ['unit:*', 'integration:*'], changed: true });
  const registry = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(registry.principals.map((entry: any) => entry.id), ['operator', 'evidence', ciProducerId]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await registerCiProducer(file, [], () => 'u'.repeat(40))).changed, false);
  // Apply rewrote the file without the entry: the token comes back from the roster read beforehand.
  const previous = await readRoster(file);
  await writeFile(file, JSON.stringify({ version: 1, principals: registry.principals.slice(0, 2) }), { mode: 0o600 });
  await registerCiProducer(file, previous, () => 'u'.repeat(40));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).principals.at(-1).token, 't'.repeat(40));
  assert.deepEqual(await readRoster(join(directory, 'missing.json')), []);
  const limits = delegationLimitAssignments(JSON.parse(await readFile(file, 'utf8')).principals);
  assert.equal(limits.variables.GRAPHYARD_MAX_REVIEWERS, '2');
  const steps = ciProducerProvisioningSteps('owner/repo', 'https://graphyard.example');
  assert.ok(steps.some(step => step.includes(`gh secret set ${ciProducerSecret} --repo owner/repo --env graphyard-reporting`)));
  assert.ok(steps.some(step => step.includes('gh variable set GRAPHYARD_URL --repo owner/repo --env graphyard-reporting --body https://graphyard.example')));
});
