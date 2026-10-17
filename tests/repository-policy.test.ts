import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  await under(preMerge, () => {
    assert.equal(reviewedBeforeMerge('normal'), true);
    const gate = reviewGate(normal);
    assert.equal(gate.passed, false, 'a normal change waits for its approval');
    assert.equal(evaluate(normal, [normal], new Date(at), []).postMergeReview, undefined, 'and owes no post-merge review');
    assert.equal(reviewedAfterMerge(normal), false, 'the loop launches its pre-merge reviewer');
    assert.equal(mergeQueue([normal], {}, Date.parse(at)).next, null, 'the merge writer does not trial it unreviewed');
  });
  await under(postMerge, () => {
    assert.equal(reviewedBeforeMerge('normal'), false);
    assert.equal(reviewedBeforeMerge('sensitive'), true);
    assert.deepEqual(reviewGate(normal).reasons, [], 'GY-1525: a normal change merges on its trial');
    assert.equal(evaluate(normal, [normal], new Date(at), []).postMergeReview, 'owed');
    assert.equal(reviewedAfterMerge(normal), true);
    assert.equal(mergeQueue([normal], {}, Date.parse(at)).next?.key, 'GY-5', 'the merge writer trials it without its review');
  });
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
