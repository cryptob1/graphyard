import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type Work } from '../src/model.js';
import { defaultOptimisticExclude, optimisticEligibility, parseOptimisticExclude, sharedInfrastructure } from '../src/optimistic-merge.js';
import { masterConfigSchema, optimisticExcludeGlobs, optimisticMergeEnabled } from '../src/master/profiles.js';
import { onboardingMergeQueue } from '../src/repository-setup.js';

// GY-503: the shared-infrastructure paths that keep a change out of the optimistic lane are
// per-repository configuration — `mergeQueue.optimisticExclude`, a glob list onboarding writes
// with product defaults — never this repository's file names. Each test is named for the proof
// it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const now = new Date('2026-09-27T09:00:00.000Z'), at = '2026-09-27T08:00:00.000Z';
const ci = 15368;

/** A sample repository layout that is not this one: a Python service with a database and CI. */
const sample = {
  source: 'services/billing/api.py',
  tests: 'tests/test_billing.py',
  manifest: 'pyproject.toml',
  ci: '.github/workflows/tests.yml',
  migration: 'db/migrations/0002_orders.py',
};
/** An item every gate but the merge queue passes for, changing `files` while the base changed `baseChanges`. */
function item(key: string, files: string[], baseChanges: string[]): Work {
  const candidate = { sha: sha40(`a${key.slice(3)}`), baseSha: sha40('b0'), pr: 300 + Number(key.slice(4)), branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  return { id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: files, criteria: [],
    policy: { checks: ['test'], review: false }, stage: 'merge', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine', path: `/tmp/${key}`, branch: candidate.branch, epoch: 1, owner: 'agent' }], candidate, submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [],
    observation: { clockOffset: { min: 0, max: 0 }, candidate, baseTip: sha40('b1'), baseTree: sha40('e1'), checks: [{ name: 'test', result: 'success', appId: ci }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null,
      files, scopeFiles: [], baseChanges, at: now.toISOString() },
  } as unknown as Work;
}
const judge = (work: Work, all: Work[] = [work], settings: number | { batchSize: number; optimistic?: boolean; optimisticExclude?: string[] } = 4) =>
  Object.assign(work, evaluate(work, all, now, [ci], settings));
const verdict = (work: Work, exclude?: string[]) => optimisticEligibility(work, [work], { enabled: true, gatesPass: true, ...(exclude ? { exclude } : {}) });
const reasons = (work: Work, exclude?: string[]) => (verdict(work, exclude) as { eligible: false; reasons: string[] }).reasons.join('; ');

test('unit:optimistic-exclude-configurable the product defaults keep a sample repository on the queue for its manifests, CI, helpers, schemas and migrations', () => {
  // A plain change to the sample layout is disjoint from the base and touches nothing excluded.
  const plain = judge(item('GY-60', [sample.source, sample.tests], ['services/billing/report.py']));
  assert.equal(plain.queue, null, 'a disjoint change over no excluded path skips the queue');
  assert.equal(verdict(plain).eligible, true);
  // Each product-default family holds its change back, at the head or on the base.
  for (const path of [sample.manifest, sample.ci, sample.migration, 'requirements.lock', 'tests/conftest.py', 'db/schema.py']) {
    assert.equal(sharedInfrastructure(path), true, path);
    const own = judge(item('GY-61', [sample.source, path], []));
    assert.ok(own.queue, `${path} takes the queue`);
    assert.match(reasons(own), new RegExp(`changes shared infrastructure: .*${path.replace(/[.*]/g, '\\$&')}`));
    const base = judge(item('GY-62', [sample.source], [path]));
    assert.ok(base.queue, `a base that changed ${path} since the item's run holds it back`);
    assert.match(reasons(base), /base changed shared infrastructure since [0-9a-f]{12}/);
  }
  // Nothing this repository names is in the defaults: its own source files are not infrastructure.
  for (const path of ['src/model/work.ts', 'src/store/tables.ts', 'src/optimistic-merge.ts'])
    assert.equal(sharedInfrastructure(path), false, path);
});

test('unit:optimistic-exclude-configurable a repository\u2019s own exclude globs decide eligibility, replacing the defaults for the sample layout', () => {
  // The repository tunes its list to its layout: services/** and conftest are its shared setup.
  const exclude = ['services/**', 'tests/conftest.py'];
  const tuned = item('GY-63', [sample.source, sample.tests], ['docs/runbooks/billing.md']);
  assert.equal(verdict(tuned, exclude).eligible, false);
  assert.match(reasons(tuned, exclude), new RegExp(`changes shared infrastructure: ${sample.source.replace(/[.*]/g, '\\$&')}`));
  const baseTuned = item('GY-64', [sample.tests], [sample.source]);
  assert.equal(verdict(baseTuned, exclude).eligible, false);
  assert.match(reasons(baseTuned, exclude), new RegExp(`base changed shared infrastructure since [0-9a-f]{12}: ${sample.source.replace(/[.*]/g, '\\$&')}`));
  // The list replaces the defaults: a manifest outside it no longer holds anything back …
  const manifest = item('GY-65', [sample.manifest], []);
  assert.equal(verdict(manifest, exclude).eligible, true, 'a path the repository did not exclude is not infrastructure under its list');
  // … and an empty list excludes nothing: the repository turned every exclusion off.
  const empty = item('GY-66', [sample.ci], []);
  assert.equal(verdict(empty, []).eligible, true, 'an empty exclude list leaves every path eligible');
  // An omitted list keeps the product defaults.
  assert.equal(verdict(item('GY-67', [sample.manifest], [])).eligible, false, 'no configuration keeps the product defaults');
  // The whole gate follows one configured list: the engine evaluates through the same settings.
  const gated = judge(item('GY-68', [sample.source], []), undefined, { batchSize: 4, optimisticExclude: exclude });
  assert.ok(gated.queue, 'the merge gate reads the configured globs');
  assert.ok(gated.queue && gated.queue.sequence >= 1);
  const skipped = judge(item('GY-69', ['docs/runbooks/billing.md'], []), undefined, { batchSize: 4, optimisticExclude: exclude });
  assert.equal(skipped.queue, null, 'a change outside the configured globs still skips the queue');
});

test('unit:optimistic-exclude-configurable the exclude list is per-repository configuration with product defaults, written by onboarding', () => {
  // The configuration the control plane serves: the master's list, or the product defaults.
  assert.deepEqual(optimisticExcludeGlobs(null), [...defaultOptimisticExclude]);
  assert.deepEqual(optimisticExcludeGlobs({}), [...defaultOptimisticExclude]);
  assert.deepEqual(optimisticExcludeGlobs({ mergeQueue: { optimisticExclude: ['backend/**', 'package.json'] } }), ['backend/**', 'package.json']);
  // The master config schema carries the key and refuses a list that is not repository-relative globs.
  const queue = masterConfigSchema.shape.mergeQueue;
  assert.equal(queue.safeParse({ optimisticExclude: ['services/**', 'package.json'] }).success, true);
  assert.equal(queue.safeParse({ optimisticExclude: [] }).success, true);
  for (const bad of [42, ['/absolute/path'], ['a/../b'], ['has space'], [`${'g'.repeat(201)}`], Array.from({ length: 101 }, (_, i) => `d${i}/`)])
    assert.equal(queue.safeParse({ optimisticExclude: bad }).success, false, JSON.stringify(bad));
  // The published form is validated the same way, deduplicated and trimmed.
  assert.deepEqual(parseOptimisticExclude(['a/', ' b/ ', 'a/']), ['a/', 'b/']);
  assert.equal(parseOptimisticExclude('services/**'), null);
  assert.equal(parseOptimisticExclude(['..']), null);
  // Onboarding writes the defaults under the key an operator tunes, and keeps that choice.
  assert.deepEqual(onboardingMergeQueue(), { optimisticExclude: [...defaultOptimisticExclude] });
  assert.deepEqual(Object.keys(onboardingMergeQueue()), ['optimisticExclude']);
});

test('unit:optimistic-exclude-configurable the optimistic mode itself turns off per repository', () => {
  assert.equal(optimisticMergeEnabled({ mergeQueue: { optimistic: false } }), false);
  assert.equal(optimisticMergeEnabled({ mergeQueue: { optimistic: true, optimisticExclude: ['x/'] } }), true);
  assert.equal(masterConfigSchema.shape.mergeQueue.safeParse({ optimistic: false, optimisticExclude: ['services/**'] }).success, true);
  const off = judge(item('GY-70', [sample.source], []), undefined, { batchSize: 4, optimistic: false, optimisticExclude: [] });
  assert.ok(off.queue, 'with the mode off every entry of this repository takes the queue, however narrow its change');
});
