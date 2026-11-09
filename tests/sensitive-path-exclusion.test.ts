import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Work } from '../src/model.js';
import { resolveRepositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { classifyRisk } from '../src/model-boundary/risk-class.js';
import { evaluate } from '../src/model-boundary/gates.js';
import { defaultRepositoryPolicy, genericSensitiveRules } from '../src/model/repository-policy.js';

// GY-3203 AC-1: a `!glob` entry in risk.sensitive excludes its matches from every positive rule.

const H = 'a'.repeat(40), B = 'b'.repeat(40), at = '2026-11-09T12:00:00.000Z';
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
/** A head the merge writer observed with `files` as its delta, built and unapproved. */
const planeHead = (files: string[]): Work => {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  return { id: randomUUID(), key: 'GY-7', title: 'Item', description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 9, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'],
    observation: { source: 'control-plane', at, candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, files,
      scopeFiles: files.map(path => ({ path, status: 'modified', sha: sha(path), additions: 1, deletions: 0, binary: false })), baseTip: B, baseTipContained: true },
  } as unknown as Work;
};
const reviewGate = (files: string[]) => evaluate(planeHead(files), [planeHead(files)], new Date(at)).gates.find(gate => gate.name === 'review')!;

const excluding = resolveRepositoryPolicy({ risk: { sensitive: [{ rule: 'per-app manifests', glob: '!apps/*/package.json' }] } });

test('e2e:sensitive-path-exclusion — an exclusion keeps the generic positive list and removes only its matches: apps/pm/package.json is normal while root package.json and pnpm-lock.yaml stay sensitive', () => {
  assert.deepEqual(excluding.risk.sensitive.slice(0, genericSensitiveRules.length), [...genericSensitiveRules], 'a list of only exclusions keeps the generics');
  assert.deepEqual(classifyRisk([{ path: 'apps/pm/package.json' }], excluding), { risk: 'normal', reasons: [] });
  assert.deepEqual(classifyRisk([{ path: 'package.json' }], excluding), { risk: 'sensitive', reasons: ['package.json: dependencies'] });
  assert.deepEqual(classifyRisk([{ path: 'pnpm-lock.yaml' }], excluding), { risk: 'sensitive', reasons: ['pnpm-lock.yaml: dependencies'] });
  assert.equal(classifyRisk([{ path: 'apps/pm/nested/package.json' }], excluding).risk, 'sensitive', '* stays within one segment');
  // Exclusions are evaluated after declared positive entries too, wherever they sit in the list.
  const declared = resolveRepositoryPolicy({ risk: { sensitive: [{ rule: 'per-app manifests', glob: '!apps/*/package.json' }, { rule: 'manifests', glob: '**/package.json' }] } });
  assert.deepEqual(declared.risk.sensitive.map(entry => entry.glob), ['**/package.json', '!apps/*/package.json']);
  assert.equal(classifyRisk([{ path: 'apps/pm/package.json' }], declared).risk, 'normal');
  assert.equal(classifyRisk([{ path: 'pnpm-lock.yaml' }], declared).risk, 'normal', 'declared positives replace the generics');
  // A repository with no exclusions classifies exactly as today.
  assert.equal(classifyRisk([{ path: 'apps/pm/package.json' }], defaultRepositoryPolicy).risk, 'sensitive');
});

test('e2e:sensitive-path-exclusion — the merge gate decision: an excluded per-app manifest does not wait for approval, a root manifest still does', () => {
  setRepositoryPolicy(excluding);
  try {
    assert.deepEqual(reviewGate(['apps/pm/package.json']).reasons, [], 'a normal delta merges on its trial without waiting for approval');
    for (const path of ['package.json', 'pnpm-lock.yaml']) {
      const gate = reviewGate([path]);
      assert.equal(gate.passed, false, `${path} waits for approval`);
      assert.match(gate.reasons.join('\n'), new RegExp(`${path.replace('.', '\\.')}: dependencies`));
    }
  } finally { setRepositoryPolicy(null); }
});
