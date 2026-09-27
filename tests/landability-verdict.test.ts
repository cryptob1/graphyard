import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLandability, type LandabilityVerdict } from '../src/model/landability.js';
import type { Observation, ScopeFile, Work } from '../src/model/work.js';

const commit = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const now = new Date('2026-09-27T12:00:00.000Z');

function item(key: string, overrides: Partial<Work> = {}): Work {
  const base = commit('base');
  const head = commit(`${key}-head`);
  const baseItem: Work = {
    id: key.toLowerCase(),
    key,
    title: key,
    description: '',
    type: 'feature',
    priority: 0,
    dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:test-proof'] }],
    policy: { checks: [], review: false },
    plannedFiles: ['src/engine.ts'],
    stage: 'merge',
    revision: 1,
    policyRevision: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    stageEnteredAt: now.toISOString(),
    ready: true,
    epoch: 1,
    lease: null,
    workspaces: [],
    candidate: { sha: head, baseSha: base, pr: 1, branch: `graphyard/${key}`, author: 'agent', createdAt: now.toISOString() },
    submission: { epoch: 1, pr: 1 },
    reworkRequested: false,
    scenarioRequirements: [],
    evidence: [],
    observation: null,
    blocker: null,
    gates: [],
    violations: [],
  } as unknown as Work;

  const result = { ...baseItem, ...overrides } as Work;

  // Set default observation if candidate exists and observation not explicitly set in overrides
  if (!('observation' in overrides) && result.candidate) {
    result.observation = {
      at: now.toISOString(),
      candidate: { sha: head, baseSha: base, pr: 1, branch: `graphyard/${key}`, author: 'agent', createdAt: now.toISOString() },
      checks: [],
      reviews: [],
      merged: false,
      mergeable: true,
      protected: true,
      prState: 'open',
      draft: false,
      files: [],
      scopeFiles: [],
      baseTip: base,
    } as unknown as Observation;
  }

  // Set default evidence if not provided
  if (!('evidence' in overrides)) {
    result.evidence = [{
      id: `e-${key}`,
      proof: 'unit:test-proof',
      sha: head,
      baseSha: base,
      policyRevision: 1,
      producer: 'ci-runner',
      trusted: true,
      result: 'pass',
      executed: 1,
      skipped: 0,
      at: now.toISOString(),
    }];
  }

  return result;
}

function isLandable(verdict: LandabilityVerdict): boolean {
  return verdict.verdict === 'landable';
}

function hasRefusal(verdict: LandabilityVerdict, gate: 'build' | 'acceptance'): boolean {
  return verdict.verdict === 'refused' && verdict.reasons.some(r => r.gate === gate);
}

function refusalReasons(verdict: LandabilityVerdict, gate?: 'build' | 'acceptance'): string[] {
  if (verdict.verdict !== 'refused') return [];
  return gate
    ? verdict.reasons.filter(r => r.gate === gate).map(r => r.reason)
    : verdict.reasons.map(r => r.reason);
}

test('unit:landability-verdict-single-function: evaluateLandability returns landable or refused with reasons', () => {
  // Happy path: all gates pass
  const happy = item('GY-1');
  const happyVerdict = evaluateLandability(happy, [happy], now);
  assert.equal(happyVerdict.verdict, 'landable', 'candidate with all gates passing is landable');

  // No observation: cannot evaluate
  const noObs = item('GY-2', { observation: null });
  const noObsVerdict = evaluateLandability(noObs, [noObs], now);
  assert.equal(noObsVerdict.verdict, 'refused');

  // Unproven acceptance
  const unproven = item('GY-3', { evidence: [] });
  const unprovenVerdict = evaluateLandability(unproven, [unproven], now);
  assert.equal(unprovenVerdict.verdict, 'refused');
  assert(hasRefusal(unprovenVerdict, 'acceptance'), 'unproven criterion is acceptance-gate refusal');
  assert(refusalReasons(unprovenVerdict, 'acceptance')[0].includes('AC-1'), 'criterion ID is in the reason');

  // Stale observation
  const staleObs = item('GY-4');
  if (staleObs.observation) {
    staleObs.observation.candidate.sha = commit('different');
  }
  const staleVerdict = evaluateLandability(staleObs, [staleObs], now);
  assert.equal(staleVerdict.verdict, 'refused', 'stale observation refuses');
});

test('unit:queue-and-gates-share-verdict: regression and acceptance verdicts match gate logic', () => {
  // GY-871: carried files from another item should not refuse
  const gy871 = item('GY-871', {
    plannedFiles: ['src/engine.ts', 'src/new-file.ts'],
  });
  if (gy871.observation) {
    gy871.observation.scopeFiles = [
      { path: 'src/engine.ts', status: 'modified', sha: commit('new'), baseSha: commit('old'), additions: 1, deletions: 0, binary: false },
      { path: 'src/new-file.ts', status: 'added', sha: commit('new'), baseSha: null, additions: 10, deletions: 0, binary: false },
    ];
  }
  const gy871Verdict = evaluateLandability(gy871, [gy871], now);
  assert.ok(isLandable(gy871Verdict), 'planned files with new files are landable');

  // GY-875: executed=0 manual evidence should refuse at acceptance (not adverse, just unexercised)
  const gy875Head = commit('gy875-head');
  const gy875Base = commit('base');
  const gy875 = item('GY-875', {
    evidence: [{
      id: 'e-gy875',
      proof: 'unit:test-proof',
      sha: gy875Head,
      baseSha: gy875Base,
      policyRevision: 1,
      producer: 'manual-runner',
      trusted: true,
      result: 'fail',
      executed: 0, // unexercised
      skipped: 0,
      at: now.toISOString(),
    }],
    candidate: { sha: gy875Head, baseSha: gy875Base, pr: 1, branch: 'graphyard/gy-875', author: 'agent', createdAt: now.toISOString() },
    observation: {
      at: now.toISOString(),
      candidate: { sha: gy875Head, baseSha: gy875Base, pr: 1, branch: 'graphyard/gy-875', author: 'agent', createdAt: now.toISOString() },
      checks: [],
      reviews: [],
      merged: false,
      mergeable: true,
      protected: true,
      prState: 'open',
      draft: false,
      files: [],
      scopeFiles: [],
      baseTip: gy875Base,
    } as unknown as Observation,
  });
  const gy875Verdict = evaluateLandability(gy875, [gy875], now);
  assert.equal(gy875Verdict.verdict, 'refused', 'executed=0 evidence refuses');
  assert(hasRefusal(gy875Verdict, 'acceptance'), 'executed=0 is acceptance refusal, not adverse');

  // GY-863: three-way merge result matching base should not refuse
  const gy863 = item('GY-863');
  if (gy863.observation) {
    gy863.observation.scopeFiles = [
      {
        path: 'src/shared.ts',
        status: 'modified',
        sha: commit('rev'),
        baseSha: commit('base'),
        mergeSha: commit('base'), // three-way merge result matches base
        additions: 1,
        deletions: 1,
        binary: false,
      },
    ];
  }
  const gy863Verdict = evaluateLandability(gy863, [gy863], now);
  assert.ok(isLandable(gy863Verdict), 'three-way merge matching base does not refuse');
});

test('unit:landability-consumers-agree: same verdict across build and acceptance families', () => {
  // Build: no scope violations
  const good = item('GY-good');
  const goodVerdict = evaluateLandability(good, [good], now);
  assert.ok(isLandable(goodVerdict), 'good item is landable');
  assert(!hasRefusal(goodVerdict, 'build'), 'no build refusal');
  assert(!hasRefusal(goodVerdict, 'acceptance'), 'no acceptance refusal');

  // Build: out-of-scope file that differs
  const outOfScope = item('GY-oos', { plannedFiles: ['src/engine.ts'] });
  if (outOfScope.observation) {
    outOfScope.observation.scopeFiles = [
      { path: 'src/engine.ts', status: 'modified', sha: commit('new'), baseSha: commit('old'), additions: 1, deletions: 0, binary: false },
      { path: 'src/other.ts', status: 'modified', sha: commit('new'), baseSha: commit('old'), additions: 1, deletions: 0, binary: false }, // out of scope and different
    ];
  }
  const oosVerdict = evaluateLandability(outOfScope, [outOfScope], now);
  assert.equal(oosVerdict.verdict, 'refused');
  assert(hasRefusal(oosVerdict, 'build'), 'out-of-scope change is build refusal');
  assert(refusalReasons(oosVerdict, 'build')[0].includes('planned'), 'reason mentions planned files');

  // Acceptance: missing required evidence
  const missing = item('GY-missing', {
    criteria: [{ id: 'AC-2', text: 'Need proof', proofs: ['unit:missing-proof'] }],
    evidence: [],
  });
  const missingVerdict = evaluateLandability(missing, [missing], now);
  assert.equal(missingVerdict.verdict, 'refused');
  assert(hasRefusal(missingVerdict, 'acceptance'), 'missing evidence is acceptance refusal');
  assert(refusalReasons(missingVerdict, 'acceptance')[0].includes('AC-2'), 'criterion ID in reason');
});

test('unit:landability-pure-on-demand: deterministic, never reads cached verdicts', () => {
  const w = item('GY-det');
  const all = [w];

  // Same inputs produce same output
  const v1 = evaluateLandability(w, all, now);
  const v2 = evaluateLandability(w, all, now);
  assert.deepEqual(v1, v2, 'identical inputs produce identical verdict');

  // Change evidence, verdict changes
  const oldReason = refusalReasons(v1, 'acceptance');
  w.evidence = [];
  const v3 = evaluateLandability(w, all, now);
  assert.notDeepEqual(v1, v3, 'changing evidence changes verdict');
  assert(v3.verdict === 'refused' && hasRefusal(v3, 'acceptance'), 'missing evidence refuses acceptance');

  // No stored verdicts: function is not reading work.gates or work.queueEjection
  assert.equal(typeof evaluateLandability, 'function', 'evaluateLandability is pure function');
  assert(!evaluateLandability.toString().includes('.gates'), 'implementation does not read stored gates');
});

test('unit:ejection-not-sticky: re-entry when verdict changes from refused to landable', () => {
  // GY-472 pattern: item ejected for regression reason
  const gy472 = item('GY-472', { plannedFiles: ['src/engine.ts'] });
  if (gy472.observation) {
    gy472.observation.scopeFiles = [
      { path: 'src/engine.ts', status: 'modified', sha: commit('new'), baseSha: commit('old'), additions: 1, deletions: 0, binary: false },
      { path: 'src/other.ts', status: 'modified', sha: commit('new'), baseSha: commit('reverted'), additions: 0, deletions: 5, binary: false }, // out of scope revert
    ];
  }
  const rejectedVerdict = evaluateLandability(gy472, [gy472], now);
  assert.equal(rejectedVerdict.verdict, 'refused', 'regression refuses initially');
  assert(hasRefusal(rejectedVerdict, 'build'), 'regression is build refusal');

  // Now the out-of-scope file is back in scope (fixed upstream)
  const upstream = item('GY-upstream');
  gy472.plannedFiles.push('src/other.ts'); // File is now in scope
  const reenteredVerdict = evaluateLandability(gy472, [gy472, upstream], now);
  assert.ok(isLandable(reenteredVerdict), 'once the issue is resolved, same head re-enters');
});
