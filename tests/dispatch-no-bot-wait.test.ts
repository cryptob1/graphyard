import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Evidence, Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model-boundary/dispatch.js';
import { evaluate } from '../src/model-boundary/gates.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { dispatchCursorPath, emptyDispatchCursor, readDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { type DispatchEffects } from '../src/dispatch/effects.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';
// Time-bomb allowance: the fixed `at`/clock is handed to reconcileAutoDispatch; the new Date() readings only stamp the stub's snapshot and review records.

// GY-3007: exercise immediate dispatch and compatibility with settings and cursors from older loops.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-09-25T10:00:00.000Z', clock = Date.parse(at);

function work(): Work {
  const candidate = { sha: H, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  const observation: Observation = { source: 'control-plane', candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/store/pools.ts'], scopeFiles: [], at,
    baseTip: B, baseTree: sha40('7b'), baseTipContained: true } as Observation;
  return workFixture({ id: 'work-64', key: 'GY-64', title: 'No bot wait', priority: 0, criteria: [{ id: 'AC-1', text: 'Unit', proofs: ['unit:a'] }], stage: 'review', revision: 7,
    createdAt: at, updatedAt: at, stageEnteredAt: at, epoch: 1, workspaces: [{ host: 'h', path: '/w/gy-64', branch: 'graphyard/gy-64-1', epoch: 1, owner: 'implementer' }],
    candidate, submission: { epoch: 1, pr: 64 }, observation,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }] });
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
function effects(item: Work, log: string[]): DispatchEffects {
  const reviews: any[] = [];
  return {
    snapshot: async () => ({ work: [item], now: new Date().toISOString() }),
    agents: () => [],
    credentials: async () => ({}),
    reconcileReviews: async () => ({ reviews }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async (launched, request) => { log.push(`review:${launched.key}:${request.sha.slice(0, 4)}`); reviews.push({ requestId: request.id, state: 'pending', requestedAt: new Date().toISOString() }); },
    launchProducer: async () => { throw new Error('no producer is requested in this fixture'); },
    persist: async () => {},
  };
}

test('unit:dispatch-no-bot-wait — a head approved by the control-plane reviewer is dispatched to the next step on the same tick with no bot wait, and a dispatch cursor carrying botReviewers still loads', async () => {
  const root = await temporaryDirectory('no-bot-wait'), secrets = await temporaryDirectory('no-bot-wait-secrets');
  execFileSync('git', ['init', '-q', root]);
  try {
    const credentialFile = join(secrets, 'coordinator.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config = masterConfig(credentialFile);
    // The review request launches its control-plane reviewer on the very tick that first observes
    // it, and the tick records no wait: no automatic bot reviewer is awaited any more.
    const item = reviewRequested(), log: string[] = [];
    const cursor = emptyDispatchCursor(config), dispatch = effects(item, log);
    // A lingering adapter from an older caller must never be consulted for bot activity.
    Object.assign(dispatch, { headReviewers: async () => { throw new Error('retired bot-review read'); } });
    const tick = await runDispatchTick(config, cursor, dispatch, () => clock);
    assert.deepEqual(log, [`review:GY-64:${item.autoDispatch!.review!.sha.slice(0, 4)}`], 'the reviewer session launches on the request\'s first tick');
    assert.deepEqual(tick.launched.map(launch => [launch.kind, launch.work, launch.profile]), [['review', 'GY-64', 'claude-reviewer']]);
    assert.deepEqual(tick.waiting, [], 'no bot-review wait holds the head');
    assert.equal(evaluate(item, [item], new Date(clock)).stage, 'review', 'the sensitive head requires approval before proceeding');
    item.observation!.reviews.push({ reviewer: 'review-claude-1', sha: H, state: 'APPROVED', id: 1, submittedAt: at, source: 'control-plane' });
    reconcileAutoDispatch(item, [item], new Date(clock));
    const approved = evaluate(item, [item], new Date(clock));
    assert.equal(approved.gates.find(gate => gate.name === 'review')!.passed, true);
    assert.equal(approved.stage, 'test', 'approval advances the head immediately to the merge writer trial');
    assert.equal(item.autoDispatch!.review, null, 'the approved request is satisfied');
    const next = await runDispatchTick(config, cursor, dispatch, () => clock);
    assert.deepEqual(next.waiting, [], 'the same tick has no bot wait after approval');
    assert.equal(log.length, 1, 'approval launches no further reviewer');
    // A cursor an older loop wrote still loads: its bot-reviewer state is dropped on read.
    const retired = { ...emptyDispatchCursor(config), botReviewers: [{ login: 'chatgpt-codex-connector[bot]', state: 'exhausted', since: at, checkedAt: at }] };
    await writeFile(dispatchCursorPath(config), JSON.stringify(retired), { mode: 0o600 });
    const loaded = await readDispatchCursor(root, config);
    assert.equal('botReviewers' in loaded, false, 'the retired cursor field is dropped on read');
    assert.equal(loaded.ticks, 0, 'the rest of the cursor is read as it was written');
  } finally { await rm(root, { recursive: true, force: true }); await rm(secrets, { recursive: true, force: true }); }
});
