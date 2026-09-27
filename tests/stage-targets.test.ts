import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSpeed, stageTargets, sparseSampleSize, computeFlow, type FlowDataset, type FlowFact, type DeploymentObservation } from '../src/flow-analytics.js';
import type { Work } from '../src/model.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, writeDaemonState } from '../src/master-daemon.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const day = 86_400_000;
const min = 60_000;

function at(offset: number): string {
  const base = Date.parse('2026-09-20T00:00:00.000Z');
  return new Date(base + offset).toISOString();
}

const item = (key: string): Work => ({
  id: `00000000-0000-4000-8000-${key.padStart(12, '0')}`,
  key, title: `Fixture ${key}`, type: 'feature', stage: 'done', priority: 1, plannedFiles: ['src/'],
  createdAt: at(-3 * day), updatedAt: at(-1 * min), stageEnteredAt: at(-1 * min),
  criteria: [], evidence: [], gates: [], violations: [], workspaces: [], sessions: [], dependencies: [],
  submission: { epoch: 1, pr: 400 }, delivery: { pr: 400, mergeSha: key.padEnd(40, 'f'), mergedAt: at(0), mergedAtRepository: at(0) },
  policy: { checks: ['test', 'typecheck'], review: true }, observation: null,
});

function fact(workId: string, key: string, kind: string, at_ms: number, details: any = {}): FlowFact {
  return {
    workId, workKey: key, kind: kind as FlowFact['kind'], observedAt: at(at_ms), recordedAt: at(at_ms),
    source: 'graphyard', sourceEvent: at_ms, stage: 'done', workType: 'feature', slices: ['src'], details, dedupe: `${kind}:${at_ms}`,
  };
}

const dataset = (facts: FlowFact[], works: Work[] = [item('a')], deployments: DeploymentObservation[] = []): FlowDataset => {
  const latest: FlowFact[] = [];
  const kindsToKeep = new Set(['work.created', 'work.released', 'lease.claimed', 'candidate.observed', 'check.observed', 'review.submitted', 'review.completed', 'merged', 'delivered']);
  const byKey = new Map<string, FlowFact[]>();
  for (const fact of facts) {
    if (kindsToKeep.has(fact.kind)) {
      (byKey.get(`${fact.workId}:${fact.kind}`) ?? byKey.set(`${fact.workId}:${fact.kind}`, []).get(`${fact.workId}:${fact.kind}`)!).push(fact);
    }
  }
  for (const kindFacts of byKey.values()) {
    latest.push(kindFacts.sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())[0]);
  }

  // Create a scanEnd that encompasses all facts
  const lastFact = facts.length > 0 ? facts[facts.length - 1] : null;
  const scanEnd = lastFact ? { observedAt: lastFact.observedAt, id: (lastFact.id ?? 0) + 1 } : undefined;

  return {
    observedAt: at(0), from: at(-30 * day), to: at(0), days: 30 as const,
    work: works, included: works, facts, latest, carryIn: [], deployments, mergedForDeployments: [],
    scanned: facts.length, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false,
    scanEnd,
    projection: { lastEvent: 0, updatedAt: at(0), pendingEvents: 0, pendingCapped: false },
  };
};

// Simplified single-stage test verifying core logic
test('unit:stage-percentiles-computed — ready-to-claim duration computed and met judged', () => {
  const a = item('a');
  const facts = [
    fact(a.id, a.key, 'work.created', -3 * day),
    fact(a.id, a.key, 'work.released', -3 * day + 5 * min, {}),
    fact(a.id, a.key, 'lease.claimed', -3 * day + 7 * min, { epoch: 1 }),
    fact(a.id, a.key, 'candidate.observed', -3 * day + 37 * min, { sha: 'a'.padEnd(40, 'f'), pr: 400, prCreatedAt: at(-3 * day + 37 * min) }),
    fact(a.id, a.key, 'check.observed', -3 * day + 57 * min, { sha: 'a'.padEnd(40, 'f'), name: 'test', result: 'success', pending: false }),
    fact(a.id, a.key, 'check.observed', -3 * day + 58 * min, { sha: 'a'.padEnd(40, 'f'), name: 'typecheck', result: 'success', pending: false }),
    fact(a.id, a.key, 'review.submitted', -3 * day + 68 * min, { sha: 'a'.padEnd(40, 'f'), reviewState: 'APPROVED' }),
    fact(a.id, a.key, 'merged', -3 * day + 78 * min, { sha: 'a'.padEnd(40, 'f'), mergeSha: 'a'.padEnd(40, 'f') }),
    fact(a.id, a.key, 'delivered', -3 * day + 78 * min, {}),
  ];

  const deployment: DeploymentObservation = {
    id: 'deploy-1', provider: 'test', externalId: 'ext-1', environment: 'production',
    sha: 'a'.padEnd(40, 'f'), containedMergeShas: ['a'.padEnd(40, 'f')], state: 'succeeded',
    startedAt: at(-3 * day + 93 * min), finishedAt: at(-3 * day + 95 * min), recordedAt: at(-3 * day + 95 * min), details: {},
  };

  const result = stageSpeed(dataset(facts, [a], [deployment]), 'production');

  assert.equal(result.stages.length, 6);
  assert.equal(result.stages[0].id, 'ready-to-claim');
  assert.equal(result.stages[0].n, 1);
  assert.equal(result.stages[0].p50Ms, 2 * min); // 7 - 5 = 2
  assert.equal(result.stages[0].p90Ms, 2 * min);
  assert.equal(result.stages[0].targetMs, stageTargets.readyToClaimMs);
  assert.equal(result.stages[0].met, true);
  assert.equal(result.stages[0].sparse, true, 'n=1 is below sparseSampleSize');

  assert.equal(result.stages[1].id, 'claim-to-first-push');
  assert.equal(result.stages[1].n, 1);
  assert.equal(result.stages[1].p50Ms, 30 * min); // 37 - 7 = 30
  assert.equal(result.stages[1].targetMs, stageTargets.claimToFirstPushMs);
  assert.equal(result.stages[1].met, true);

  assert.equal(result.stages[2].id, 'push-to-ci-green');
  assert.equal(result.stages[2].n, 1);
  assert.equal(result.stages[2].p50Ms, 21 * min); // 58 - 37 = 21 (latest terminal check)
  assert.equal(result.stages[2].p90Ms, 21 * min);
  assert.equal(result.stages[2].targetMs, stageTargets.pushToCiGreenMs);
  assert.equal(result.stages[2].met, false, 'p90 21 min exceeds target 20 min');

  assert.equal(result.stages[3].id, 'ci-green-to-review-verdict');
  assert.equal(result.stages[3].n, 1);
  assert.equal(result.stages[3].p50Ms, 10 * min); // 68 - 58 = 10 (ciGreen is max of all terminal checks)
  assert.equal(result.stages[3].p90Ms, 10 * min);
  assert.equal(result.stages[3].targetMs, stageTargets.ciGreenToReviewVerdictMs);
  assert.equal(result.stages[3].met, true);

  assert.equal(result.stages[4].id, 'review-to-merge');
  assert.equal(result.stages[4].n, 1);
  assert.equal(result.stages[4].p50Ms, 10 * min); // 78 - 68 = 10
  assert.equal(result.stages[4].targetMs, stageTargets.reviewToMergeMs);
  assert.equal(result.stages[4].met, true);

  assert.equal(result.stages[5].id, 'merge-to-deployed');
  assert.equal(result.stages[5].n, 1);
  assert.equal(result.stages[5].p50Ms, 15 * min); // 93 - 78 = 15
  assert.equal(result.stages[5].targetMs, stageTargets.mergeToDeployedMs);
  assert.equal(result.stages[5].met, true);

  assert.equal(result.bottleneck, null, 'all stages met target');
});

test('unit:stage-percentiles-computed — rework fixture (first never green, second lands) proves first push stays first and later stages bind landed sha', () => {
  const a = item('a');
  const facts = [
    fact(a.id, a.key, 'work.created', -3 * day),
    fact(a.id, a.key, 'work.released', -3 * day + 5 * min, {}),
    fact(a.id, a.key, 'lease.claimed', -3 * day + 7 * min, { epoch: 1 }),
    // First candidate never goes green
    fact(a.id, a.key, 'candidate.observed', -3 * day + 37 * min, { sha: 'aaa'.padEnd(40, 'f'), pr: 400, prCreatedAt: at(-3 * day + 37 * min) }),
    fact(a.id, a.key, 'check.observed', -3 * day + 57 * min, { sha: 'aaa'.padEnd(40, 'f'), name: 'test', result: 'failed', pending: false }),
    // Second candidate lands
    fact(a.id, a.key, 'candidate.observed', -3 * day + 100 * min, { sha: 'bbb'.padEnd(40, 'f'), pr: 400, prCreatedAt: at(-3 * day + 100 * min), supersedes: 'aaa'.padEnd(40, 'f') }),
    fact(a.id, a.key, 'check.observed', -3 * day + 120 * min, { sha: 'bbb'.padEnd(40, 'f'), name: 'test', result: 'success', pending: false }),
    fact(a.id, a.key, 'check.observed', -3 * day + 121 * min, { sha: 'bbb'.padEnd(40, 'f'), name: 'typecheck', result: 'success', pending: false }),
    fact(a.id, a.key, 'review.submitted', -3 * day + 131 * min, { sha: 'bbb'.padEnd(40, 'f'), reviewState: 'APPROVED' }),
    fact(a.id, a.key, 'merged', -3 * day + 141 * min, { sha: 'bbb'.padEnd(40, 'f'), mergeSha: 'bbb'.padEnd(40, 'f') }),
    fact(a.id, a.key, 'delivered', -3 * day + 141 * min, {}),
  ];

  const deployment: DeploymentObservation = {
    id: 'deploy-1', provider: 'test', externalId: 'ext-1', environment: 'production',
    sha: 'bbb'.padEnd(40, 'f'), containedMergeShas: ['bbb'.padEnd(40, 'f')], state: 'succeeded',
    startedAt: at(-3 * day + 156 * min), finishedAt: at(-3 * day + 157 * min), recordedAt: at(-3 * day + 157 * min), details: {},
  };

  const result = stageSpeed(dataset(facts, [a], [deployment]), 'production');

  // claim-to-first-push uses first candidate's observed time (aaa at 37 min) regardless of rework
  assert.equal(result.stages[1].n, 1);
  assert.equal(result.stages[1].p50Ms, 30 * min); // 37 - 7 = 30 (first candidate)

  // push-to-ci-green, verdict, merge, deploy all use the landed sha (bbb at 100 min)
  assert.equal(result.stages[2].n, 1);
  assert.equal(result.stages[2].p50Ms, 21 * min); // 121 - 100 = 21 (from bbb first push to CI green, max of terminal checks)

  assert.equal(result.stages[3].n, 1);
  assert.equal(result.stages[3].p50Ms, 10 * min); // 131 - 121 = 10 (from CI green to verdict, ciGreen is max of terminal checks)
});

test('unit:stage-percentiles-computed — staging-only deployment leaves merge→deployed unavailable (never zero)', () => {
  const a = item('a');
  const facts = [
    fact(a.id, a.key, 'work.created', -3 * day),
    fact(a.id, a.key, 'work.released', -3 * day + 5 * min, {}),
    fact(a.id, a.key, 'lease.claimed', -3 * day + 7 * min, { epoch: 1 }),
    fact(a.id, a.key, 'candidate.observed', -3 * day + 37 * min, { sha: 'a'.padEnd(40, 'f'), pr: 400, prCreatedAt: at(-3 * day + 37 * min) }),
    fact(a.id, a.key, 'check.observed', -3 * day + 57 * min, { sha: 'a'.padEnd(40, 'f'), name: 'test', result: 'success', pending: false }),
    fact(a.id, a.key, 'check.observed', -3 * day + 58 * min, { sha: 'a'.padEnd(40, 'f'), name: 'typecheck', result: 'success', pending: false }),
    fact(a.id, a.key, 'review.submitted', -3 * day + 68 * min, { sha: 'a'.padEnd(40, 'f'), reviewState: 'APPROVED' }),
    fact(a.id, a.key, 'merged', -3 * day + 78 * min, { sha: 'a'.padEnd(40, 'f'), mergeSha: 'a'.padEnd(40, 'f') }),
    fact(a.id, a.key, 'delivered', -3 * day + 78 * min, {}),
  ];

  // Only staging deployment, no production
  const stagingDeploy: DeploymentObservation = {
    id: 'deploy-1', provider: 'test', externalId: 'ext-1', environment: 'staging',
    sha: 'a'.padEnd(40, 'f'), containedMergeShas: ['a'.padEnd(40, 'f')], state: 'succeeded',
    startedAt: at(-3 * day + 93 * min), finishedAt: at(-3 * day + 95 * min), recordedAt: at(-3 * day + 95 * min), details: {},
  };

  const result = stageSpeed(dataset(facts, [a], [stagingDeploy]), 'production');

  // merge-to-deployed has no samples (staging doesn't count)
  assert.equal(result.stages[5].n, 0);
  assert.equal(result.stages[5].met, null, 'met is null for zero samples, never false');
});

test('unit:stage-percentiles-computed — empty dataset gives n=0, met null, bottleneck null', () => {
  const result = stageSpeed(dataset([]), []);

  for (const stage of result.stages) {
    assert.equal(stage.n, 0);
    assert.equal(stage.met, null);
  }
  assert.equal(result.bottleneck, null);
});

test('unit:worst-stage-named — bottleneck is largest p90 excess among stages meeting sparse threshold', () => {
  // Create 5 items with all exceeding target on claim→push to meet sparseSampleSize
  const items = Array.from({ length: 5 }, (_, i) => item(String.fromCharCode(97 + i)));
  const facts: FlowFact[] = [];

  for (let i = 0; i < 5; i++) {
    let item_i = items[i];
    const baseSha = String.fromCharCode(97 + i).padEnd(40, 'f');

    facts.push(
      fact(item_i.id, item_i.key, 'work.created', -3 * day),
      fact(item_i.id, item_i.key, 'work.released', -3 * day + 5 * min, {}),
      fact(item_i.id, item_i.key, 'lease.claimed', -3 * day + 7 * min, { epoch: 1 }),
      // claim→push: all slow by 88 min (118 total, 30 target)
      fact(item_i.id, item_i.key, 'candidate.observed', -3 * day + (7 + 118) * min, { sha: baseSha, pr: 400, prCreatedAt: at(-3 * day + (7 + 118) * min) }),
      fact(item_i.id, item_i.key, 'check.observed', -3 * day + (125 + 20) * min, { sha: baseSha, name: 'test', result: 'success', pending: false }),
      fact(item_i.id, item_i.key, 'check.observed', -3 * day + (126 + 20) * min, { sha: baseSha, name: 'typecheck', result: 'success', pending: false }),
      fact(item_i.id, item_i.key, 'review.submitted', -3 * day + (146 + 20) * min, { sha: baseSha, reviewState: 'APPROVED' }),
      fact(item_i.id, item_i.key, 'merged', -3 * day + (166 + 20) * min, { sha: baseSha, mergeSha: baseSha }),
      fact(item_i.id, item_i.key, 'delivered', -3 * day + (166 + 20) * min, {}),
    );
  }

  // Add deployments for all items
  const deployments = items.map((_, i) => {
    const baseSha = String.fromCharCode(97 + i).padEnd(40, 'f');
    return {
      id: `deploy-${i}`, provider: 'test', externalId: `ext-${i}`, environment: 'production',
      sha: baseSha, containedMergeShas: [baseSha], state: 'succeeded' as const,
      startedAt: at(-3 * day + (186 + 20) * min),
      finishedAt: at(-3 * day + (188 + 20) * min),
      recordedAt: at(-3 * day + (188 + 20) * min), details: {},
    };
  });

  const result = stageSpeed(dataset(facts, items, deployments), 'production');

  // claim→push (stage 1) should have 5 items with p90 118 min, target 30 min, excess 88 min
  assert.equal(result.stages[1].n, 5);
  assert.equal(result.stages[1].p90Ms, 118 * min);
  assert.equal(result.stages[1].met, false);
  assert.equal(result.stages[1].sparse, false);

  // Bottleneck should name claim→push as it's the only stage with excess
  assert.equal(result.bottleneck?.id, 'claim-to-first-push');
  assert.equal(result.bottleneck?.excessMs, 88 * min);
  assert.equal(result.bottleneck?.p90Ms, 118 * min);
});

test('unit:worst-stage-named — sparse sample (n < 5) does not name bottleneck', () => {
  // Only 3 items, below sparseSampleSize threshold
  const items = Array.from({ length: 3 }, (_, i) => item(String.fromCharCode(97 + i)));
  const facts: FlowFact[] = [];

  for (let i = 0; i < 3; i++) {
    let item_i = items[i];
    const baseSha = String.fromCharCode(97 + i).padEnd(40, 'f');

    facts.push(
      fact(item_i.id, item_i.key, 'work.created', -3 * day),
      fact(item_i.id, item_i.key, 'work.released', -3 * day + 5 * min, {}),
      fact(item_i.id, item_i.key, 'lease.claimed', -3 * day + 100 * min, { epoch: 1 }), // huge excess
      fact(item_i.id, item_i.key, 'candidate.observed', -3 * day + 130 * min, { sha: baseSha, pr: 400, prCreatedAt: at(-3 * day + 130 * min) }),
      fact(item_i.id, item_i.key, 'check.observed', -3 * day + 150 * min, { sha: baseSha, name: 'test', result: 'success', pending: false }),
      fact(item_i.id, item_i.key, 'check.observed', -3 * day + 151 * min, { sha: baseSha, name: 'typecheck', result: 'success', pending: false }),
      fact(item_i.id, item_i.key, 'review.submitted', -3 * day + 161 * min, { sha: baseSha, reviewState: 'APPROVED' }),
      fact(item_i.id, item_i.key, 'merged', -3 * day + 171 * min, { sha: baseSha, mergeSha: baseSha }),
      fact(item_i.id, item_i.key, 'delivered', -3 * day + 171 * min, {}),
    );
  }

  const deployments = items.map((_, i) => {
    const baseSha = String.fromCharCode(97 + i).padEnd(40, 'f');
    return {
      id: `deploy-${i}`, provider: 'test', externalId: `ext-${i}`, environment: 'production',
      sha: baseSha, containedMergeShas: [baseSha], state: 'succeeded' as const,
      startedAt: at(-3 * day + 186 * min), finishedAt: at(-3 * day + 188 * min),
      recordedAt: at(-3 * day + 188 * min), details: {},
    };
  });

  const result = stageSpeed(dataset(facts, items, deployments), 'production');

  assert.equal(result.stages[0].sparse, true);
  assert.equal(result.stages[0].n, 3);
  assert.equal(result.stages[0].p90Ms, 95 * min); // (100-5 = 95 min, exceeds 2 min target)
  assert.equal(result.bottleneck, null, 'sparse sample does not name bottleneck');
});

test('integration:master-status-with-stage-targets — stageSpeed is embedded in flow report', async () => {
  const a = item('test');
  const facts = [
    fact(a.id, a.key, 'work.created', -3 * day),
    fact(a.id, a.key, 'work.released', -3 * day + 5 * min, {}),
    fact(a.id, a.key, 'lease.claimed', -3 * day + 7 * min, { epoch: 1 }),
    fact(a.id, a.key, 'candidate.observed', -3 * day + 37 * min, { sha: 'test'.padEnd(40, 'f'), pr: 400, prCreatedAt: at(-3 * day + 37 * min) }),
    fact(a.id, a.key, 'check.observed', -3 * day + 57 * min, { sha: 'test'.padEnd(40, 'f'), name: 'test', result: 'success', pending: false }),
    fact(a.id, a.key, 'check.observed', -3 * day + 58 * min, { sha: 'test'.padEnd(40, 'f'), name: 'typecheck', result: 'success', pending: false }),
    fact(a.id, a.key, 'review.submitted', -3 * day + 68 * min, { sha: 'test'.padEnd(40, 'f'), reviewState: 'APPROVED' }),
    fact(a.id, a.key, 'merged', -3 * day + 78 * min, { sha: 'test'.padEnd(40, 'f'), mergeSha: 'test'.padEnd(40, 'f') }),
    fact(a.id, a.key, 'delivered', -3 * day + 78 * min, {}),
  ];
  const deploy: DeploymentObservation = {
    id: 'deploy-1', provider: 'test', externalId: 'ext-1', environment: 'production',
    sha: 'test'.padEnd(40, 'f'), containedMergeShas: ['test'.padEnd(40, 'f')], state: 'succeeded',
    startedAt: at(-3 * day + 93 * min), finishedAt: at(-3 * day + 95 * min), recordedAt: at(-3 * day + 95 * min), details: {},
  };
  const ds = dataset(facts, [a], [deploy]);
  const result = computeFlow(ds, { days: 30 });

  assert.ok(result.stageSpeed, 'stageSpeed exists in flow report');
  assert.ok(result.stageSpeed.stages, 'stageSpeed.stages exists');
  assert.equal(result.stageSpeed.stages.length, 6, 'has 6 stages');
  assert.ok(result.stageSpeed.stages.every((s: any) => s.id && s.label && typeof s.n === 'number'), 'all stage rows have required fields');
  assert.ok(result.stageSpeed.stages.every((s: any) => typeof s.p50Ms === 'number' && typeof s.p90Ms === 'number'), 'all stages have percentiles');
  assert.ok(result.stageSpeed.bottleneck === null || (result.stageSpeed.bottleneck.id && typeof result.stageSpeed.bottleneck.p90Ms === 'number'), 'bottleneck is properly formed');
});
