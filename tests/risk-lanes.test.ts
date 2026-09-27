import { test } from 'node:test';
import assert from 'node:assert/strict';
import { determineLane, type Lane } from '../src/model/policy.js';
import { evaluate, defaultSpeedTargets, type SpeedTargets } from '../src/model/gates.js';
import type { Work } from '../src/model/work.js';

// AC-1: src/model/policy.ts assigns every item a lane (low, medium or high) from a shipped path policy.
test('AC-1: risk-lane-assigned - determineLane classifies paths correctly', () => {
  // High-risk paths
  assert.equal(determineLane(['migrations/schema/001_initial.sql']), 'high');
  assert.equal(determineLane(['auth/credentials/oauth.ts']), 'high');
  assert.equal(determineLane(['deploy/install/setup.sh']), 'high');
  assert.equal(determineLane(['src/server/routes/api.ts']), 'high');

  // Any high-risk path makes the whole lane high
  assert.equal(determineLane(['src/model/foo.ts', 'migrations/schema/002_add_table.sql']), 'high');

  // Low-risk paths: test-only
  assert.equal(determineLane(['tests/unit.test.ts']), 'low');
  assert.equal(determineLane(['tests/integration.test.ts', 'tests/helpers.ts']), 'low');

  // Low-risk paths: docs-only
  assert.equal(determineLane(['docs/README.md']), 'low');
  assert.equal(determineLane(['docs/api/index.md', 'docs/guides/setup.md']), 'low');

  // Single-module changes are low-risk
  assert.equal(determineLane(['src/model/policy.ts', 'src/model/policy.test.ts']), 'low');
  assert.equal(determineLane(['src/cli/command1.ts', 'src/cli/command2.ts']), 'low');

  // Multiple modules (not all same top-level dir) are medium
  assert.equal(determineLane(['src/model/policy.ts', 'src/cli/main.ts']), 'medium');
  assert.equal(determineLane(['src/foo.ts', 'tests/foo.test.ts', 'docs/foo.md']), 'medium');

  // Empty path list defaults to medium
  assert.equal(determineLane([]), 'medium');
});

// AC-2: In src/model/gates.ts a low-lane item is landable with its required CI checks green and one approving review
test('AC-2: lane-sets-required-gates - gates reflect lane requirements', () => {
  const createWork = (files: string[]) => ({
    id: 'test-id',
    key: 'TEST-1',
    type: 'feature' as const,
    title: 'Test',
    criteria: [
      { id: 'AC-1', text: 'Test AC', proofs: ['unit:core', 'manual:security'] },
    ],
    policy: { checks: ['test'], review: true },
    plannedFiles: [],
    stage: 'build',
    ready: true,
    epoch: 1,
    lease: null,
    workspaces: [{ host: 'local', path: '/tmp/test', branch: 'feature', epoch: 1, owner: 'test' }],
    candidate: { sha: 'abc123', baseSha: 'def456', pr: 1, branch: 'feature', author: 'test' },
    observation: {
      candidate: { sha: 'abc123', baseSha: 'def456', pr: 1, branch: 'feature', author: 'test' },
      checks: [{ name: 'test', result: 'success', appId: 15368 }],
      reviews: [{ reviewer: 'alice', sha: 'abc123', state: 'APPROVED' }],
      merged: false,
      mergeable: true,
      protected: true,
      files,
      at: new Date().toISOString(),
      scopeFiles: files.map(path => ({
        path,
        status: 'added' as const,
        sha: 'sha1',
        additions: 1,
        deletions: 0,
        binary: false,
      })),
    },
    evidence: [],
    violations: [],
    reworkRequested: false,
    scenarioRequirements: [],
    dependencies: [],
    submission: { pr: 1, epoch: 1 },
    revision: 1,
    policyRevision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stageEnteredAt: new Date().toISOString(),
  } as unknown as Work);

  const now = new Date();

  // Low-lane items should pass acceptance with just CI and one review
  const lowLaneWork = createWork(['src/model/policy.ts']);
  const lowResult = evaluate(lowLaneWork, [lowLaneWork], now, [15368]);
  assert.equal(lowResult.lane, 'low');

  // Acceptance gate should pass because low-lane skips unit/integration proofs
  const acceptanceGate = lowResult.gates.find(g => g.name === 'acceptance');
  assert.ok(acceptanceGate?.passed, 'Low-lane should pass acceptance with CI and one review, skipping unit/integration proofs');

  // High-lane items should still require all proofs
  const highLaneWork = createWork(['src/server/routes/api.ts']);
  const highResult = evaluate(highLaneWork, [highLaneWork], now, [15368]);
  assert.equal(highResult.lane, 'high');

  // Acceptance gate for high-lane should fail because unit:core proof is unproven
  const highAcceptanceGate = highResult.gates.find(g => g.name === 'acceptance');
  assert.ok(!highAcceptanceGate?.passed, 'High-lane should require all proofs including unit and integration');
});

// AC-3: Lanes are inputs to the single landability verdict; speed targets are shipped and reported
test('AC-3: lanes-feed-verdict - lanes affect verdict and speed targets are reported', () => {
  const createWork = (files: string[]) => ({
    id: 'test-id',
    key: 'TEST-1',
    type: 'feature' as const,
    title: 'Test',
    criteria: [],
    policy: { checks: ['test'], review: true },
    plannedFiles: [],
    stage: 'build',
    ready: true,
    epoch: 1,
    lease: null,
    workspaces: [{ host: 'local', path: '/tmp/test', branch: 'feature', epoch: 1, owner: 'test' }],
    candidate: { sha: 'abc123', baseSha: 'def456', pr: 1, branch: 'feature', author: 'test' },
    observation: {
      candidate: { sha: 'abc123', baseSha: 'def456', pr: 1, branch: 'feature', author: 'test' },
      checks: [{ name: 'test', result: 'success', appId: 15368 }],
      reviews: [{ reviewer: 'alice', sha: 'abc123', state: 'APPROVED' }],
      merged: false,
      mergeable: true,
      protected: true,
      files,
      at: new Date().toISOString(),
      scopeFiles: files.map(path => ({
        path,
        status: 'added' as const,
        sha: 'sha1',
        additions: 1,
        deletions: 0,
        binary: false,
      })),
    },
    evidence: [],
    violations: [],
    reworkRequested: false,
    scenarioRequirements: [],
    dependencies: [],
    submission: { pr: 1, epoch: 1 },
    revision: 1,
    policyRevision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stageEnteredAt: new Date().toISOString(),
  } as unknown as Work);

  const now = new Date();

  // Test low-lane speed target
  const lowWork = createWork(['tests/unit.test.ts']);
  const lowResult = evaluate(lowWork, [lowWork], now, [15368]);
  assert.equal(lowResult.lane, 'low');
  assert.equal(lowResult.speedTarget, defaultSpeedTargets.low);
  assert.equal(lowResult.speedTarget, 30 * 60 * 1000, 'Low-lane should have 30 min speed target');

  // Test medium-lane speed target
  const mediumWork = createWork(['src/model/policy.ts', 'src/cli/main.ts']);
  const mediumResult = evaluate(mediumWork, [mediumWork], now, [15368]);
  assert.equal(mediumResult.lane, 'medium');
  assert.equal(mediumResult.speedTarget, defaultSpeedTargets.medium);
  assert.equal(mediumResult.speedTarget, 60 * 60 * 1000, 'Medium-lane should have 60 min speed target');

  // Test high-lane speed target
  const highWork = createWork(['migrations/schema/001.sql']);
  const highResult = evaluate(highWork, [highWork], now, [15368]);
  assert.equal(highResult.lane, 'high');
  assert.equal(highResult.speedTarget, defaultSpeedTargets.high);
  assert.equal(highResult.speedTarget, 4 * 60 * 60 * 1000, 'High-lane should have 4 hour speed target');

  // Verify speed targets are numeric and positive
  assert.ok(defaultSpeedTargets.low > 0);
  assert.ok(defaultSpeedTargets.medium > 0);
  assert.ok(defaultSpeedTargets.high > 0);
  assert.ok(defaultSpeedTargets.low < defaultSpeedTargets.medium);
  assert.ok(defaultSpeedTargets.medium < defaultSpeedTargets.high);
});
