import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listTestFiles, repositoryRoot } from '../scripts/ci-tests.mjs';
import { policySchema } from '../src/model/policy.js';

// GY-1093 ran the soak and timing budgets only on release candidates; GY-1983 removed candidates, so
// every test file is in the one ordinary selection the merge writer's trial runs. One case per
// proof: unit:fast-gate-required-set, unit:ci-bubblewrap-install-resilient.

const ciPath = '.github/workflows/ci.yml';

test('unit:fast-gate-required-set — GY-2009 removes Actions PR gates; the selection is every test file, the soak and timing budgets included (GY-1983)', async () => {
  assert.ok(!existsSync(join(repositoryRoot, ciPath)), 'ci.yml is gone; the merge writer trial is the gate');
  assert.ok(!existsSync(join(repositoryRoot, '.github/workflows/acceptance.yml')));
  assert.ok(!existsSync(join(repositoryRoot, '.github/workflows/deploy-smoke.yml')));
  assert.ok(!existsSync(join(repositoryRoot, '.github/workflows/release.yml')), 'release.yml is gone; installs build the image locally');
  const required = policySchema.parse({}).checks;
  assert.deepEqual(required, ['test', 'typecheck'], 'the default required checks are test and typecheck');
  const affected = execFileSync(process.execPath, ['scripts/ci-tests.mjs', 'affected', 'package.json'], { cwd: repositoryRoot, env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  assert.match(affected[0]!, /^full: /);
  assert.deepEqual(affected.slice(1), listTestFiles());
});

test('unit:ci-bubblewrap-install-resilient — GY-2009 removed the Actions shards, so no bubblewrap install step remains to bound', () => {
  assert.ok(!existsSync(join(repositoryRoot, ciPath)), 'ci.yml is gone');
});
