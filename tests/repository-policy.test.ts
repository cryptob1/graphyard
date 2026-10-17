import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { parseRepositoryConfig } from '../src/model/documentation.js';
import type { RepositoryPolicy } from '../src/model/repository-policy.js';
import { classifyRisk } from '../src/model/risk-class.js';
import { determineLane } from '../src/model/policy.js';
import { workerPreference } from '../src/model/worker-preference.js';
import { evaluate } from '../src/model/gates.js';
import { sensitiveReviewRefusal } from '../src/model/post-merge-review.js';
import { reviewedAfterMerge } from '../src/auto-dispatch.js';
import { mergeQueue } from '../src/merge-writer/executor.js';
import { failureDetail, releaseVerdict, type E2eReport } from '../src/e2e/runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { harness } from './install-harness.js';

// GY-1843: each repository declares its sensitive paths, normal-change review timing and
// pending-outcome rule in graphyard.json; a repository that declares none gets a generic default,
// never Graphyard's own layout, which Graphyard's graphyard.json declares for itself.

const H = 'a'.repeat(40), B = 'b'.repeat(40);
const at = '2026-10-08T12:00:00.000Z';
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');

/** A control-plane head on `files`, submitted and built, awaiting review. */
function planeHead(key: string, files: string[], fields: Record<string, unknown> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'graphyard-claude-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, plannedFiles: files,
    stage: 'review', revision: 9, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }], violations: [], implementers: ['graphyard-claude-1'],
    observation: { source: 'control-plane', at, candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, files,
      scopeFiles: files.map(path => ({ path, status: 'modified', sha: sha(path), additions: 1, deletions: 0, binary: false })), baseTip: B, baseTipContained: true },
    ...fields } as unknown as Work;
}
const reviewGate = (work: Work) => evaluate(work, [work], new Date(at), []).gates.find(gate => gate.name === 'review')!;

// The policy module and its readers' new exports are imported per case, so on a tree without them each case fails on its own rather than the file failing to load.
const policyModule = () => import('../src/model/repository-policy.js');
/** Runs `body` with `policy` in force, then restores the process's own. */
async function under<T>(policy: RepositoryPolicy, body: () => T): Promise<T> {
  const { setRepositoryPolicy } = await policyModule();
  setRepositoryPolicy(policy);
  try { return body(); } finally { setRepositoryPolicy(null); }
}

/** Today's tables (before GY-1843), copied verbatim so Graphyard's own graphyard.json is shown to reproduce them. */
const todaysRiskRules: { rule: string; pattern: RegExp }[] = [
  { rule: 'persistence layer', pattern: /^src\/store\// },
  { rule: 'server auth, principals, API assembler, bootstrap or routes', pattern: /^src\/server\/(auth|principals|index|main|routes)/ },
  { rule: 'operator agent', pattern: /^src\/operator-agent\.ts$/ },
  { rule: 'proof grants', pattern: /^src\/proof-grants\.ts$/ },
  { rule: 'installation', pattern: /^src\/install\// },
  { rule: 'deployment', pattern: /^deploy\// },
  { rule: 'Dockerfile', pattern: /^Dockerfile/ },
  { rule: 'compose file', pattern: /^compose\.ya?ml$/ },
  { rule: 'CI configuration', pattern: /^\.github\// },
  { rule: 'dependencies', pattern: /^package(-lock)?\.json$/ },
  { rule: 'merge path', pattern: /^src\/(merge-queue|direct-merge|merger-mode|main-guard|regression-guard)\.ts$/ },
  { rule: 'merge writer', pattern: /^src\/merge-writer\// },
  { rule: 'migrations', pattern: /^migrations\// },
];
const todaysHighRiskPaths = [
  /^migrations\/schema/, /^auth\/credentials/, /^src\/store\//, /^src\/server\/(routes|auth|principals|index|main)/,
  /^src\/operator-agent\.ts$/, /^src\/proof-grants\.ts$/, /^src\/install\//, /^deploy\//, /^Dockerfile(\.|$)/, /^compose\.ya?ml$/,
];
const corpus = [
  'src/store/x.ts', 'src/store/tables/work.ts', 'src/server/auth.ts', 'src/server/auth/session.ts', 'src/server/principals.ts', 'src/server/index.ts', 'src/server/main.ts',
  'src/server/routes/work.ts', 'src/server/routes.ts', 'src/server/jobs.ts', 'src/server/static.ts', 'src/server/lane-rework.ts', 'src/operator-agent.ts', 'src/operator-agent.test.ts',
  'src/proof-grants.ts', 'src/install/index.ts', 'src/installer.ts', 'deploy/helm/values.yaml', 'Dockerfile', 'Dockerfile.dev', 'scripts/Dockerfile', 'compose.yaml', 'compose.yml',
  'compose.override.yaml', '.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'packages/x/package.json', 'src/merge-queue.ts', 'src/direct-merge.ts', 'src/merger-mode.ts',
  'src/main-guard.ts', 'src/regression-guard.ts', 'src/merge-queue-report.ts', 'src/merge-writer/trial.ts', 'migrations/001.sql', 'migrations/schema/001_initial.sql',
  'auth/credentials/oauth.ts', 'src/model/policy.ts', 'docs/delivery.md', 'tests/risk-class.test.ts', 'README.md', 'graphyard.json', 'web/pages/work-details.tsx',
];

test('unit:repo-risk-policy — a declared risk.sensitive classifies exactly the paths its globs match, and the review gate, worker preference and lane read it', async () => {
  const { resolveRepositoryPolicy } = await policyModule();
  const payments = resolveRepositoryPolicy({ risk: { sensitive: [{ rule: 'payments', glob: 'app/payments/**' }, { rule: 'schema', glob: 'db/schema.rb' }] } });
  assert.equal(payments.risk.declared, true);
  assert.deepEqual(classifyRisk([{ path: 'app/payments/charge.rb' }], payments), { risk: 'sensitive', reasons: ['app/payments/charge.rb: payments'] });
  assert.deepEqual(classifyRisk([{ path: 'db/schema.rb' }, { path: 'app/models/user.rb' }], payments), { risk: 'sensitive', reasons: ['db/schema.rb: schema'] });
  // Exactly the declared globs: neither Graphyard's layout nor the generic default's surfaces.
  for (const path of ['app/models/user.rb', 'src/store/x.ts', '.github/workflows/ci.yml', 'package-lock.json', 'migrations/001.sql', 'db/schema.rb.bak'])
    assert.deepEqual(classifyRisk([{ path }], payments), { risk: 'normal', reasons: [] }, path);
  await under(payments, () => {
    // The review gate: a sensitive control-plane head needs its approval; a normal one passes and owes a post-merge review.
    const sensitive = planeHead('GY-1', ['app/payments/charge.rb']), normal = planeHead('GY-2', ['src/store/x.ts']);
    assert.deepEqual(reviewGate(sensitive).reasons, [sensitiveReviewRefusal(['app/payments/charge.rb: payments'])]);
    assert.deepEqual(reviewGate(normal).reasons, []);
    assert.equal(evaluate(normal, [normal], new Date(at), []).postMergeReview, 'owed');
    // Worker preference: a planned sensitive file, or a directory scope over its surface, goes to the strong runtimes.
    assert.equal(workerPreference({ plannedFiles: ['app/payments/charge.rb'] }), 'strong');
    assert.equal(workerPreference({ plannedFiles: ['app/'] }), 'strong', 'a scope over app/payments/ may change it');
    assert.equal(workerPreference({ plannedFiles: ['src/store/x.ts', 'src/server/auth.ts'] }), 'fast', 'Graphyard\'s own surfaces are not this repository\'s');
    // Lane: a declared sensitive path makes the change high; Graphyard's high paths do not.
    assert.equal(determineLane(['app/payments/charge.rb']), 'high');
    assert.equal(determineLane(['src/store/x.ts']), 'low');
  });
  // A wildcard within a segment: a directory plan its literal head may reach is strong, a sibling it cannot reach stays fast.
  const partial = resolveRepositoryPolicy({ risk: { sensitive: [{ rule: 'api secrets', glob: 'packages/api*/secrets.json' }, { rule: 'payments', glob: 'app/pay*/secret.ts' }] } });
  await under(partial, () => {
    for (const plan of ['packages/api-v2/', 'packages/api/', 'packages/', 'app/payments/', 'app/pay/**', 'packages/api-v2/secrets.json'])
      assert.equal(workerPreference({ plannedFiles: [plan] }), 'strong', `${plan} may change a sensitive file`);
    for (const plan of ['packages/web/', 'app/models/', 'packages/api-v2/readme.md'])
      assert.equal(workerPreference({ plannedFiles: [plan] }), 'fast', `${plan} cannot`);
  });
  // A terminal single star is one segment (thread PRRT_kwDOUZby-s6tcVmR): `config/*` holds config's own files only.
  const shallow = resolveRepositoryPolicy({ risk: { sensitive: [{ rule: 'config', glob: 'config/*' }] } });
  assert.deepEqual(classifyRisk([{ path: 'config/app.yml' }], shallow), { risk: 'sensitive', reasons: ['config/app.yml: config'] });
  assert.deepEqual(classifyRisk([{ path: 'config/public/images/logo.svg' }], shallow), { risk: 'normal', reasons: [] });
  // `only` narrows an entry to the class or to the lane.
  const narrowed = resolveRepositoryPolicy({ risk: { sensitive: [{ rule: 'ci', glob: '.ci/', only: 'risk' }, { rule: 'schema', glob: 'schema/', only: 'lane' }] } });
  assert.equal(classifyRisk([{ path: '.ci/run.sh' }], narrowed).risk, 'sensitive');
  assert.equal(determineLane(['.ci/run.sh'], narrowed), 'low');
  assert.equal(classifyRisk([{ path: 'schema/a.sql' }], narrowed).risk, 'normal');
  assert.equal(determineLane(['schema/a.sql'], narrowed), 'high');
});

test('unit:repo-risk-policy — a repository that declares none gets the generic default: src/store/x.ts is normal, CI configuration, lockfiles and migrations are sensitive', async () => {
  const { defaultRepositoryPolicy, resolveRepositoryPolicy } = await policyModule();
  const generic = resolveRepositoryPolicy({});
  assert.deepEqual(generic, defaultRepositoryPolicy);
  assert.equal(generic.risk.declared, false);
  assert.deepEqual(classifyRisk([{ path: 'src/store/x.ts' }], generic), { risk: 'normal', reasons: [] });
  for (const [path, rule] of [['.github/workflows/ci.yml', 'CI configuration'], ['package-lock.json', 'dependencies'], ['migrations/001.sql', 'migrations'],
    ['services/api/migrations/002.sql', 'migrations'], ['web/package.json', 'dependencies'], ['Dockerfile', 'Dockerfile'], ['docker-compose.yml', 'compose file'],
    ['deploy/prod.yaml', 'deployment'], ['infra/main.tf', 'infrastructure'], ['src/auth/session.ts', 'auth'], ['config/secrets.yaml', 'secrets']] as const)
    assert.deepEqual(classifyRisk([{ path }], generic), { risk: 'sensitive', reasons: [`${path}: ${rule}`] }, path);
  for (const path of ['src/server/principals.ts', 'src/install/index.ts', 'src/merge-writer/trial.ts', 'src/operator-agent.ts', 'src/store/tables/work.ts'])
    assert.equal(classifyRisk([{ path }], generic).risk, 'normal', `${path} is Graphyard's layout, not the default`);
  await under(generic, () => {
    assert.deepEqual(reviewGate(planeHead('GY-3', ['src/store/x.ts'])).reasons, []);
    assert.equal(reviewGate(planeHead('GY-4', ['migrations/001.sql'])).passed, false);
    assert.equal(workerPreference({ plannedFiles: ['src/store/x.ts'] }), 'fast');
    assert.equal(workerPreference({ plannedFiles: ['package-lock.json'] }), 'strong');
    assert.equal(determineLane(['.github/workflows/ci.yml']), 'high');
    assert.equal(determineLane(['src/store/x.ts']), 'low');
  });
  // An unseen change is still the worst case under any policy.
  assert.equal(classifyRisk([], generic).risk, 'sensitive');
});

test('unit:repo-risk-policy — Graphyard\'s own graphyard.json reproduces today\'s classification and lanes, and a process in a checkout reads it', async () => {
  const { defaultRepositoryPolicy, loadRepositoryPolicy, policySections, repositoryPolicyVariable, resolveRepositoryPolicy } = await policyModule();
  const text = await readFile(new URL('../graphyard.json', import.meta.url), 'utf8');
  const own = resolveRepositoryPolicy(policySections(parseRepositoryConfig(text) as unknown as Record<string, unknown>));
  assert.equal(own.risk.declared, true);
  for (const path of corpus) {
    const reasons = todaysRiskRules.filter(({ pattern }) => pattern.test(path)).map(({ rule }) => `${path}: ${rule}`);
    assert.deepEqual(classifyRisk([{ path }], own), reasons.length ? { risk: 'sensitive', reasons } : { risk: 'normal', reasons: [] }, path);
    assert.equal(determineLane([path], own) === 'high', todaysHighRiskPaths.some(pattern => pattern.test(path)), `lane of ${path}`);
  }
  assert.deepEqual([own.review, own.e2e], [defaultRepositoryPolicy.review, defaultRepositoryPolicy.e2e], 'Graphyard keeps today\'s review timing and pending rule');
  // The process reads the checkout's graphyard.json; the deployment variable overrides it; no file is the default.
  const root = await temporaryDirectory('graphyard-repo-policy-');
  assert.deepEqual(loadRepositoryPolicy({}, root), { policy: defaultRepositoryPolicy, source: 'default' });
  assert.deepEqual(loadRepositoryPolicy({}, new URL('..', import.meta.url).pathname).policy, own);
  const deployed = loadRepositoryPolicy({ [repositoryPolicyVariable]: JSON.stringify({ review: { normalChanges: 'pre-merge' } }) }, root);
  assert.deepEqual([deployed.source, deployed.policy.review.normalChanges, deployed.policy.risk.declared], ['environment', 'pre-merge', false]);
  assert.throws(() => loadRepositoryPolicy({ [repositoryPolicyVariable]: 'pre-merge' }, root), /GRAPHYARD_REPOSITORY_POLICY must be JSON/);
  // With no root given, the managed checkout's root is read, not the working directory: a launch from
  // a subdirectory finds the Git toplevel's declaration, and GRAPHYARD_REPOSITORY_ROOT names it outright.
  const checkout = await temporaryDirectory('graphyard-repo-policy-checkout-'), nested = join(checkout, 'packages', 'api');
  await mkdir(join(checkout, '.git'), { recursive: true }); await mkdir(nested, { recursive: true });
  await writeFile(join(checkout, 'graphyard.json'), JSON.stringify({ documentation: { paths: ['docs/'] }, risk: { sensitive: [{ rule: 'billing', glob: 'billing/' }] }, e2e: { pendingOutcomes: 'blocking' } }));
  const fromSubdirectory = loadRepositoryPolicy({}, undefined, nested);
  assert.deepEqual([fromSubdirectory.source, fromSubdirectory.policy.e2e.pendingOutcomes, classifyRisk([{ path: 'billing/charge.ts' }], fromSubdirectory.policy).risk], ['graphyard.json', 'blocking', 'sensitive']);
  const explicit = loadRepositoryPolicy({ GRAPHYARD_REPOSITORY_ROOT: checkout }, undefined, root);
  assert.deepEqual([explicit.source, explicit.policy.e2e.pendingOutcomes], ['graphyard.json', 'blocking']);
  assert.equal(loadRepositoryPolicy({ GRAPHYARD_REPOSITORY_ROOT: checkout, [repositoryPolicyVariable]: '{}' }, undefined, nested).source, 'environment', 'the deployment variable still overrides');
  assert.throws(() => parseRepositoryConfig(JSON.stringify({ documentation: { paths: ['docs/'] }, review: { normalChanges: 'sometimes' } })));
});

const report = (cases: { id: string; verdict: 'passed' | 'failed' | 'flaky' }[]): E2eReport => ({ runId: 'rc-1', url: 'https://uat.example.test', environment: 'uat', sha: H, startedAt: at, finishedAt: at,
  passed: cases.filter(entry => entry.verdict === 'passed').length, failed: cases.filter(entry => entry.verdict === 'failed').length, flaky: cases.filter(entry => entry.verdict === 'flaky').length, unrun: 0,
  cases: cases.map(({ id, verdict }) => ({ id, title: id, file: `e2e/${id}.json`, outcome: verdict === 'failed' ? 'fail' : 'pass', verdict, required: true, durationMs: 1, attempts: 1, attemptResults: [], executed: 1,
    failingStep: verdict === 'failed' ? { index: 0, step: 'GET /x', reason: 'status 500' } : null })) } as unknown as E2eReport);

test('unit:repo-review-and-pending-policy — review.normalChanges pre-merge holds a normal change for its approval before merge; post-merge keeps GY-1525', async () => {
  const { defaultRepositoryPolicy, resolveRepositoryPolicy } = await policyModule();
  const { reviewedBeforeMerge } = await import('../src/model/risk-class.js') as { reviewedBeforeMerge: (risk: 'sensitive' | 'normal') => boolean };
  assert.equal(typeof reviewedBeforeMerge, 'function', 'risk-class.ts exports reviewedBeforeMerge');
  const preMerge = resolveRepositoryPolicy({ review: { normalChanges: 'pre-merge' } });
  const postMerge = resolveRepositoryPolicy({ review: { normalChanges: 'post-merge' } });
  assert.deepEqual(postMerge.review, defaultRepositoryPolicy.review, 'post-merge is the default');
  const normal = planeHead('GY-5', ['src/feature.ts']);
  /** The built head as the control plane serves it: with the review gate its evaluation under the policy in force gives. */
  const served = () => ({ ...normal, gates: [...normal.gates, reviewGate(normal)] }) as Work;
  await under(preMerge, () => {
    assert.equal(reviewedBeforeMerge('normal'), true);
    const gate = reviewGate(normal);
    assert.equal(gate.passed, false, 'a normal change waits for its approval');
    assert.equal(evaluate(normal, [normal], new Date(at), []).postMergeReview, undefined, 'and owes no post-merge review');
    assert.equal(reviewedAfterMerge(normal), false, 'the loop launches its pre-merge reviewer');
    assert.equal(mergeQueue([served()], {}, Date.parse(at)).next, null, 'the merge writer does not trial it unreviewed');
  });
  await under(postMerge, () => {
    assert.equal(reviewedBeforeMerge('normal'), false);
    assert.equal(reviewedBeforeMerge('sensitive'), true);
    assert.deepEqual(reviewGate(normal).reasons, [], 'GY-1525: a normal change merges on its trial');
    assert.equal(evaluate(normal, [normal], new Date(at), []).postMergeReview, 'owed');
    assert.equal(reviewedAfterMerge(normal), true);
    assert.equal(mergeQueue([served()], {}, Date.parse(at)).next?.key, 'GY-5', 'the merge writer trials it without its review');
  });
  // The loop's checkout may declare another policy than the deployment's: the writer follows the served review gate.
  const servedPreMerge = await under(preMerge, served);
  await under(postMerge, () => assert.equal(mergeQueue([servedPreMerge], {}, Date.parse(at)).next, null, 'a server pre-merge gate holds it under a post-merge checkout'));
});

test('unit:repo-review-and-pending-policy — e2e.pendingOutcomes blocking makes a pending-outcome case block like any required case; non-blocking keeps GY-1802', async () => {
  const { defaultRepositoryPolicy, resolveRepositoryPolicy } = await policyModule();
  const { pendingUnder } = await import('../src/e2e/runner.js') as { pendingUnder: (cases: readonly string[], policy?: RepositoryPolicy) => readonly string[] };
  assert.equal(typeof pendingUnder, 'function', 'runner.ts exports pendingUnder');
  const blocking = resolveRepositoryPolicy({ e2e: { pendingOutcomes: 'blocking' } });
  const nonBlocking = resolveRepositoryPolicy({ e2e: { pendingOutcomes: 'non-blocking' } });
  assert.deepEqual(nonBlocking.e2e, defaultRepositoryPolicy.e2e, 'non-blocking is the default');
  const run = report([{ id: 'pending-case', verdict: 'failed' }, { id: 'plain-case', verdict: 'passed' }]);
  assert.deepEqual(pendingUnder(['pending-case'], blocking), []);
  assert.deepEqual(pendingUnder(['pending-case'], nonBlocking), ['pending-case']);
  const held = releaseVerdict(run, [], ['pending-case'], blocking);
  assert.deepEqual([held.passed, held.blocking.map(outcome => outcome.id), held.pending.map(outcome => outcome.id)], [false, ['pending-case'], []]);
  assert.match(failureDetail(run, ['pending-case'], blocking), /pending-case/);
  assert.doesNotMatch(failureDetail(run, ['pending-case'], blocking), /pending, not blocking/);
  const kept = releaseVerdict(run, [], ['pending-case'], nonBlocking);
  assert.deepEqual([kept.passed, kept.blocking.map(outcome => outcome.id), kept.pending.map(outcome => outcome.id)], [true, [], ['pending-case']]);
  // The policy in force decides when a caller names none.
  await under(blocking, () => assert.equal(releaseVerdict(run, [], ['pending-case']).passed, false));
  await under(nonBlocking, () => assert.equal(releaseVerdict(run, [], ['pending-case']).passed, true));
});

test('unit:repo-review-and-pending-policy — the policy schema and its defaults live in src/model/repository-policy.ts', async () => {
  const { resolveRepositoryPolicy } = await policyModule();
  const source = await readFile(new URL('../src/model/repository-policy.ts', import.meta.url), 'utf8');
  for (const needle of ['repositoryPolicySchema', 'genericSensitiveRules', 'defaultRepositoryPolicy', "'post-merge'", "'non-blocking'"]) assert.ok(source.includes(needle), needle);
  assert.throws(() => resolveRepositoryPolicy({ e2e: { pendingOutcomes: 'maybe' } }));
  assert.throws(() => resolveRepositoryPolicy({ risk: { sensitive: [{ rule: 'x', glob: '../outside' }] } }));
});

test('unit:repo-risk-policy — the installer deploys graphyard.json\'s policy as GRAPHYARD_REPOSITORY_POLICY, so a control plane whose image carries no checkout judges by the committed rules', async () => {
  const { loadRepositoryPolicy, repositoryPolicyVariable, resolveRepositoryPolicy } = await policyModule();
  const { coreEnv, prepareInstall } = await import('../src/install/index.js');
  const declared = { risk: { sensitive: [{ rule: 'payments', glob: 'app/payments/**' }] }, review: { normalChanges: 'pre-merge' }, e2e: { pendingOutcomes: 'blocking' } };
  const fixture = await harness({ provider: 'compose' });
  try {
    await writeFile(join(fixture.root, 'graphyard.json'), JSON.stringify({ documentation: { paths: ['docs/'], changelog: null }, ...declared }));
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'compose' }, fixture.deps, 'plan');
    const variable = coreEnv(session).find(value => value.name === repositoryPolicyVariable);
    assert.ok(variable, 'the control-plane variables carry the repository policy');
    assert.equal(variable!.secret, false);
    // The runtime image: no graphyard.json in its working directory, only the deployed variable.
    const image = await temporaryDirectory('graphyard-image-');
    const served = loadRepositoryPolicy({ [repositoryPolicyVariable]: variable!.value }, image);
    assert.deepEqual(served, { policy: resolveRepositoryPolicy(declared), source: 'environment' });
    assert.equal(classifyRisk([{ path: 'app/payments/charge.rb' }], served.policy).risk, 'sensitive');
    // A repository that declares none deploys `{}`, which clears a declaration since removed: the generic default.
    await writeFile(join(fixture.root, 'graphyard.json'), JSON.stringify({ documentation: { paths: ['docs/'], changelog: null } }));
    const bare = coreEnv(await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'compose' }, fixture.deps, 'plan')).find(value => value.name === repositoryPolicyVariable);
    assert.equal(bare?.value, '{}');
    assert.equal(loadRepositoryPolicy({ [repositoryPolicyVariable]: bare!.value }, image).policy.risk.declared, false);
    // A declaration the plane would refuse is a preflight refusal, never a silent default.
    await writeFile(join(fixture.root, 'graphyard.json'), JSON.stringify({ documentation: { paths: ['docs/'], changelog: null }, review: { normalChanges: 'sometimes' } }));
    await assert.rejects(prepareInstall(fixture.root, { repository: 'owner/project', provider: 'compose' }, fixture.deps, 'plan'), /normalChanges/);
  } finally { await fixture.cleanup(); }
  // Graphyard's own deployment keeps the variable through railway.ts and sets it from its graphyard.json.
  const railway = await readFile(new URL('../.railway/railway.ts', import.meta.url), 'utf8');
  assert.equal(railway.match(/GRAPHYARD_REPOSITORY_POLICY: preserve\(\)/g)?.length, 2, 'production and uat both preserve it');
  assert.match(await readFile(new URL('../scripts/configure-integrations.mjs', import.meta.url), 'utf8'), /\[policy\.variable\]: policy\.value/);
});

test('unit:repo-review-and-pending-policy — under e2e.pendingOutcomes blocking a failing pending-outcome case opens a release hold; non-blocking files none (GY-1802)', async () => {
  const { resolveRepositoryPolicy } = await policyModule();
  const { assessHolds, e2eRecord } = await import('../src/release-holds.js');
  const candidate = { id: '20261008T120000Z', sha: H, pendingOutcomes: ['outcome-a'] } as unknown as Parameters<typeof e2eRecord>[1];
  const contract = { outcomes: [{ id: 'outcome-a', title: 'Outcome A', cases: ['pending-case'] }] } as unknown as Parameters<typeof assessHolds>[0];
  const run = { ...report([{ id: 'pending-case', verdict: 'failed' }]), runId: `rc-${candidate.id}` };
  for (const [rule, opened] of [['blocking', 1], ['non-blocking', 0]] as const) {
    const policy = resolveRepositoryPolicy({ e2e: { pendingOutcomes: rule } });
    const e2e = e2eRecord(run, candidate, contract, policy)!;
    assert.deepEqual(e2e.blocking, rule === 'blocking' ? ['pending-case'] : [], rule);
    assert.equal(e2e.cases[0].pending, rule === 'blocking' ? undefined : true, `${rule}: the record marks the case pending only when it does not block`);
    const holds = assessHolds(contract, candidate, { deployedSha: H, e2e }, [], at, policy);
    assert.equal(holds.filter(entry => entry.kind === 'open').length, opened, `${rule}: ${opened} hold opened`);
  }
});

test('unit:repo-risk-policy — the item page shows the risk the server\'s policy gives, served on /api/status, not the browser\'s generic reading', async () => {
  const { resolveRepositoryPolicy, repositoryPolicy } = await policyModule();
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: WorkDetails } = await import('../web/pages/work-details.js');
  // @ts-expect-error the checked-in dashboard fixture is plain JavaScript
  const { fixtureApi, fixtureStatus, NOW } = await import('../scripts/dashboard-fixture.mjs');
  const noop = () => {};
  const render = (item: Work, status: Record<string, unknown>) => renderToStaticMarkup(createElement(WorkDetails, {
    token: 'fixture', work: [item], status, error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: {}, events: [], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false,
    sessionEpoch: { current: 0 }, api: async (path: string) => fixtureApi(path, 'admin'), refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop, item,
  } as any));
  const item = planeHead('GY-9', ['app/ledger/book.ts']);
  const custom = resolveRepositoryPolicy({ risk: { sensitive: [{ rule: 'ledger', glob: 'app/ledger/' }] } });
  // The status route serves the policy in force on the control plane (src/server/routes/status.ts).
  const served = await under(custom, () => repositoryPolicy());
  const shown = render(item, { ...fixtureStatus('admin'), repositoryPolicy: served });
  assert.match(shown, /class="risk-details">sensitive<small> · app\/ledger\/book\.ts: ledger<\/small>/);
  assert.doesNotMatch(shown, /risk-estimate/, 'a served policy is the gates\' own, so it is not labelled an estimate');
  // An older server that serves none: the page's own reading, labelled as such.
  const older = render(item, { ...fixtureStatus('admin'), repositoryPolicy: undefined });
  assert.match(older, /class="risk-details">normal/);
  assert.match(older, /risk-estimate/);
  const statusRoute = await readFile(new URL('../src/server/routes/status.ts', import.meta.url), 'utf8');
  assert.match(statusRoute, /repositoryPolicy: repositoryPolicy\(\)/, '/api/status serves the policy in force');
});

test('unit:repo-review-and-pending-policy — a candidate validates under its own checkout\'s e2e.pendingOutcomes, not the plane\'s installed GRAPHYARD_REPOSITORY_POLICY: a failing pending case fails the suite and opens a hold', async () => {
  const { repositoryPolicy, repositoryPolicyVariable, setRepositoryPolicy } = await policyModule();
  const { projectCaseSuite } = await import('../src/release-project.js');
  const { releaseHolds } = await import('../src/release-holds.js');
  const checkout = await temporaryDirectory('candidate-policy');
  await writeFile(join(checkout, 'graphyard.json'), `${JSON.stringify({ e2e: { pendingOutcomes: 'blocking' } })}\n`);
  await mkdir(join(checkout, 'e2e', 'cases'), { recursive: true });
  await writeFile(join(checkout, 'e2e', 'cases', 'pending-case.json'), JSON.stringify({ id: 'pending-case', title: 'A pending outcome', tags: ['api'], target: 'uat', required: true,
    steps: [{ kind: 'http', name: 'read /level', method: 'GET', path: '/level', status: 200, expect: [] }] }));
  const fetcher = (async (input: string | URL) => new URL(String(input)).pathname === '/healthz'
    ? new Response(JSON.stringify({ ok: true, commit: H }), { headers: { 'content-type': 'application/json' } }) : new Response('not yet', { status: 503 })) as typeof fetch;
  const candidate = { id: '20261008T120000Z', sha: H, pendingOutcomes: ['outcome-a'] } as unknown as Parameters<ReturnType<typeof releaseHolds>>[0];
  const contract = { outcomes: [{ id: 'outcome-a', title: 'Outcome A', cases: ['pending-case'], criteria: [] }] } as unknown as Parameters<typeof releaseHolds>[1]['contract'];
  // The plane was installed with a policy that keeps pending outcomes non-blocking, as the installer's variable carries it.
  const saved = process.env[repositoryPolicyVariable];
  process.env[repositoryPolicyVariable] = JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking' } });
  setRepositoryPolicy(null);
  try {
    assert.equal(repositoryPolicy().e2e.pendingOutcomes, 'non-blocking', 'the process serves the installed variable');
    {
      let report: E2eReport | null = null;
      const result = await projectCaseSuite(checkout, '', { fetcher, stepTimeoutMs: 1_000, contract, report: value => { report = value; } }).run('https://uat.example.test', candidate);
      assert.equal(result.passed, false, `the candidate's blocking rule fails the suite: ${result.detail}`);
      assert.doesNotMatch(result.detail, /pending, not blocking/);
      assert.equal(report!.pendingOutcomes, 'blocking', 'the report names the rule it was judged under');
      const filed: string[] = [];
      const outcome = await releaseHolds(() => '', { contract, push: false, now: () => new Date(at), report: async () => report, file: async item => { filed.push(item.title); return 'GY-99'; } })(candidate, { deployedSha: H } as Parameters<ReturnType<typeof releaseHolds>>[1]);
      assert.deepEqual([outcome.e2e?.blocking, outcome.holds.map(entry => entry.kind), filed.length], [['pending-case'], ['open'], 1], 'the holds judge by the same rule');
    }
  } finally {
    setRepositoryPolicy(null);
    if (saved === undefined) delete process.env[repositoryPolicyVariable]; else process.env[repositoryPolicyVariable] = saved;
  }
});
