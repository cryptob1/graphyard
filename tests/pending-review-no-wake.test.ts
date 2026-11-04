import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ReviewSessionPending } from '../src/reviewer.js';
import { dispatchCauses } from '../src/daemon/master-stalled-delivery.js';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Evidence, Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance: the fixed `at`/clock is handed to reconcileAutoDispatch; the new Date() readings only stamp the stub's snapshot and review records.

// A review launch refused for a reviewer session already pending on the head waits while that session lives.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-09-25T10:00:00.000Z', clock = Date.parse(at);

function work(): Work {
  const candidate = { sha: H, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  const observation: Observation = { source: 'control-plane', candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/store/pools.ts'], scopeFiles: [], at, prState: 'open', draft: false,
    baseTip: B, baseTree: sha40('7b'), baseTipContained: true } as Observation;
  return { id: 'work-64', key: 'GY-64', title: 'No bot wait', description: '', type: 'feature', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Unit', proofs: ['unit:a'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [{ host: 'h', path: '/w/gy-64', branch: 'graphyard/gy-64-1', epoch: 1, owner: 'implementer' }],
    candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [] } as Work;
}
/** A head whose unit proof passed, so the control plane has raised its review request. */
function reviewRequested(): Work {
  const proven: Evidence = { id: 'ev-a', proof: 'unit:a', sha: H, baseSha: B, policyRevision: 1, producer: 'independent-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at } as Evidence;
  const item = work();
  item.evidence = [proven];
  reconcileAutoDispatch(item, [item], new Date(clock));
  assert.equal(item.autoDispatch?.review?.state, 'requested', 'the fixture raises a review request');
  return item;
}
function masterConfig(credentialFile: string): MasterConfig {
  // No reviewer App: the control-plane reviewer profile answers the head without one (GY-1525).
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    run: { awaitReviewers: ['chatgpt-codex-connector[bot]'], awaitReviewersMinutes: 60 },
    reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }], producers: [] });
}
function effects(item: Work, log: string[], live: boolean): DispatchEffects {
  const reviews: any[] = [];
  return {
    snapshot: async () => ({ work: [item], now: new Date().toISOString() }),
    agents: () => (live ? [{ name: 'review-codex-e417da64', pane_id: 'p1', status: 'working' }] : []) as any,
    credentials: async () => ({}),
    reconcileReviews: async () => ({ reviews }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async (launched, request) => { log.push(`review:${launched.key}`); throw new ReviewSessionPending(`A reviewer session for ${launched.key} is already pending on ${request.sha.slice(0, 7)} (review-codex-e417da64); one review request is answered by one session, so no second one is launched`, launched.key, { sha: request.sha, agentName: 'review-codex-e417da64' }); },
    launchProducer: async () => { throw new Error('no producer is requested in this fixture'); },
    persist: async () => {},
  };
}

test('integration:pending-review-no-wake — a refused review launch waits while its pending reviewer lives in Herdr and wakes the master once that session is gone', async () => {
  const root = await temporaryDirectory('pending-review'), secrets = await temporaryDirectory('pending-review-secrets');
  execFileSync('git', ['init', '-q', root]);
  try {
    const credentialFile = join(secrets, 'coordinator.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config = masterConfig(credentialFile);
    // (a) The pending reviewer is alive: the tick waits on it and no wake cause is raised.
    const item = reviewRequested(), log: string[] = [], cursor = emptyDispatchCursor(config);
    const tick = await runDispatchTick(config, cursor, effects(item, log, true), () => clock);
    assert.equal(log.length, 1);
    assert.match(tick.waiting.find(entry => entry.work === 'GY-64')?.reason ?? '', /review-codex-e417da64 is already pending/);
    assert.deepEqual(dispatchCauses([item], cursor), [], 'a live pending reviewer never wakes the master');
    // (b) The session is gone from Herdr: the refusal is counted and wakes the master as before.
    const gone = reviewRequested(), goneCursor = emptyDispatchCursor(config);
    await runDispatchTick(config, goneCursor, effects(gone, [], false), () => clock);
    const causes = dispatchCauses([gone], goneCursor);
    assert.equal(causes.length, 1);
    assert.match(causes[0].detail, /already pending on/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(secrets, { recursive: true, force: true }); }
});
