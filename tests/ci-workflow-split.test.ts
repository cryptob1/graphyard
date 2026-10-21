import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTestFiles, repositoryRoot } from '../scripts/ci-tests.mjs';
import { policySchema } from '../src/model/policy.js';
import { readWorkflow } from '../src/protection.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1093 ran the soak and timing budgets only on release candidates; GY-1983 removed candidates, so
// every test file is in the one ordinary selection the merge writer's trial runs. One case per
// proof: unit:fast-gate-required-set, unit:ci-bubblewrap-install-resilient.

const read = (path: string) => readFileSync(join(repositoryRoot, path), 'utf8');
const ciPath = '.github/workflows/ci.yml';

test('unit:fast-gate-required-set — GY-2009 removes Actions PR gates; the selection is every test file, the soak and timing budgets included (GY-1983)', async () => {
  assert.ok(!existsSync(join(repositoryRoot, ciPath)), 'ci.yml is gone; the merge writer trial is the gate');
  assert.ok(!existsSync(join(repositoryRoot, '.github/workflows/acceptance.yml')));
  assert.ok(!existsSync(join(repositoryRoot, '.github/workflows/deploy-smoke.yml')));
  const required = policySchema.parse({}).checks;
  assert.deepEqual(required, ['test', 'typecheck'], 'the default required checks are test and typecheck');
  assert.equal(readWorkflow(read('.github/workflows/release.yml')).pullRequest, false, 'release.yml never runs on a pull request');
  const dir = await temporaryDirectory('ci-workflow-split'), out = join(dir, 'selected.txt');
  execFileSync(process.execPath, ['scripts/ci-tests.mjs', 'select', '--out', out], { cwd: repositoryRoot, env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_STEP_SUMMARY: '' }, stdio: ['ignore', 'ignore', 'ignore'] });
  assert.deepEqual(readFileSync(out, 'utf8').split('\n').filter(Boolean), listTestFiles());
});

test('unit:ci-bubblewrap-install-resilient — GY-2009 removed the Actions shards, so no bubblewrap install step remains to bound', () => {
  assert.ok(!existsSync(join(repositoryRoot, ciPath)), 'ci.yml is gone');
});
