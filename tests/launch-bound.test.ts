import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import type { SessionHandleInput } from '../src/model/sessions.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { boundedLaunch, launchBoundMs, LaunchBoundError } from '../src/master/launch-bound.js';
import { planeWideFailure } from '../src/model/blocker-class.js';
import { planeUnavailableText } from '../src/model/refusal.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1373: on 6 October 2026 the claude runtime on vishrog dropped every session it was given. A
// launch on it was never acknowledged, and the dispatcher's tick waited on its launches, so no
// reviewer or producer launched for any item. A launch now fails on its own past its bound, naming
// the runtime, and the tick goes on to the next request.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const B = sha40('b1');
const at = '2026-10-06T13:41:00.000Z', clock = Date.parse(at);

function requested(key: string, sha: string): Work {
  const candidate = { sha, baseSha: B, pr: 64, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [{ path: 'src/a.ts', status: 'modified' as const, sha: sha40('s'), additions: 1, deletions: 1, binary: false }],
    at, prState: 'open', draft: false, baseTip: B, baseTree: sha40('7b'), baseTipContained: true } as Observation;
  const item = { id: `work-${key}`, key, title: key, description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [] } as unknown as Work;
  reconcileAutoDispatch(item, [item], new Date(clock));
  return item;
}

function config(credentialFile: string): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-project',
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: join(credentialFile, '..', 'reviewer.json'), boundAt: at },
    reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude', concurrency: 2 }], producers: [], run: { awaitReviewers: [] } });
}

test('unit:launch-bound — a launch its runtime never acknowledges fails on its own past the bound, naming the runtime and host, and is no plane-wide timeout', async () => {
  const hung = boundedLaunch(() => new Promise<never>(() => { /* the runtime answers nothing */ }), { runtime: 'claude', host: 'vishrog', subject: 'GY-64: review', boundMs: 50 });
  const error = await hung.then(() => null, failure => failure);
  assert.ok(error instanceof LaunchBoundError);
  assert.match(error.message, /^the claude runtime on vishrog did not acknowledge the launch of GY-64: review within its 50 ms launch bound/);
  assert.equal(planeWideFailure(error.message), false, 'a dead runtime is that runtime\'s fault, not the control plane\'s');
  assert.equal(planeUnavailableText(error.message), false);
  // A launch inside its bound is returned as it is, and a late failure past the bound is dropped, never unhandled.
  assert.equal(await boundedLaunch(async () => 'pane-1', { runtime: 'claude', host: 'vishrog', subject: 'x', boundMs: 1_000 }), 'pane-1');
  await assert.rejects(boundedLaunch(() => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 80)), { runtime: 'codex', host: 'h', subject: 'x', boundMs: 20 }), LaunchBoundError);
  await new Promise(resolve => setTimeout(resolve, 100));
  // The bound covers the runtime's own start ceiling and the steps around it.
  assert.equal(launchBoundMs({ run: {} }), 240_000);
  assert.equal(launchBoundMs({ run: { launchStartSeconds: 300 } }), 420_000);
});

test('unit:launch-bound — GY-1373: one reviewer launch on a dead runtime fails its own request and the tick launches the next and completes', async () => {
  const directory = await temporaryDirectory('launch-bound');
  try {
    const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const settings = config(token);
    const dead = requested('GY-1363', sha40('a1')), live = requested('GY-1364', sha40('a2'));
    const launched: string[] = [], records: SessionHandleInput[] = [];
    const effects: DispatchEffects = {
      snapshot: async () => ({ work: [dead, live], now: at }),
      agents: () => [],
      credentials: async () => ({}),
      reconcileReviews: async () => ({ reviews: [] }),
      reconcileProducers: async () => ({ producers: [] }),
      // The claude runtime takes GY-1363's session and never reports it again.
      launchReview: async item => { if (item.key === 'GY-1363') return new Promise(() => {}); launched.push(item.key); },
      launchProducer: async () => {},
      recordSession: async (_item, handle) => { records.push(handle); },
      persist: async () => {},
    };
    const cursor = emptyDispatchCursor(settings);
    const started = Date.now();
    const tick = await runDispatchTick(settings, cursor, effects, () => clock, undefined, undefined, 150);
    assert.ok(Date.now() - started < 5_000, 'the tick ends once the bound fails the hung launch');
    assert.deepEqual(launched, ['GY-1364'], 'the next request launched in the same tick');
    assert.deepEqual(tick.launched.map(entry => entry.work), ['GY-1364']);
    assert.equal(tick.refused.length, 1);
    assert.equal(tick.refused[0].work, 'GY-1363');
    assert.match(tick.refused[0].reason, /^the claude runtime on vishrog did not acknowledge the launch of GY-1363: review a1f+ \(PR #64\) within its 150 ms launch bound, so that runtime is taken as dead for this launch, which failed on its own while the tick went on$/);
    assert.equal(cursor.consecutiveFailures, 0, 'the tick itself succeeded: no "failed N ticks in a row"');
    assert.ok(cursor.lastSuccessAt);
    // The registered session is closed with the runtime named, rather than left running for the session report to lose.
    const closed = records.find(handle => handle.state === 'finished' && handle.subject?.startsWith('GY-1363'));
    assert.match(closed?.outcome ?? '', /the launch failed before the session started: the claude runtime on vishrog did not acknowledge/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
