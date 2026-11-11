import { saveReviewLedger } from '../src/reviewer.js';
import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster, type MasterConfig } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { readReviewLedger, reconcileReviews, reviewRecordSchema, reviewVerdictReminderMs, saveReviewerProfile, silentReviewReason, type ReviewLedger, type ReviewRecord } from '../src/reviewer.js';
import { reconcileAutoDispatch } from '../src/model-boundary/dispatch.js';
import type { Observation, Work } from '../src/model.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { type DispatchEffects } from '../src/dispatch/effects.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3164 AC-2: a review session that has posted no verdict and changed no output for
// run.reviewSilenceMinutes (default 10) is ended and relaunched once on another reviewer profile;
// the relaunch is logged with the silent minutes. The cases here name the bound's edges: the
// silent-running session itself (the one the idle grace never reaches, since a running agent never
// arms idleSince), the output that resets the bound, the done/idle/blocked session that keeps its
// GY-193 reminder-and-grace path, and the verdict that settles a session however silent it looked.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const iso = (at: number) => new Date(at).toISOString();
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));

async function boundMaster(twoProfiles = false) {
  const root = await temporaryDirectory('silent-reviewer'), credentialDirectory = await temporaryDirectory('silent-reviewer-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude', agentArgs: ['--setting-sources', 'user'] });
  if (twoProfiles) await saveReviewerProfile(root, { name: 'codex-reviewer', agentName: 'review-codex-1', kind: 'codex' });
  return { root, credentialDirectory, config: await loadMasterConfig(root), cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  const observation: Observation = { candidate: { ...candidate, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: B, baseTree: sha40('7b'), baseTipContained: true };
  return { id: 'work-64', key: 'GY-64', title: 'Silent reviewer', description: '', type: 'feature', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:silent-reviewer-relaunched'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 7, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as unknown as Work;
}

/** A Herdr run stub whose `agent read` answers the screen the test controls: the session's own output. */
const herdrRun = (calls: string[][], screen: () => string | null) => (_command: string, args: string[]) => {
  calls.push(args);
  if (args[0] === 'agent' && args[1] === 'read') return screen() ?? '';
  return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
};

/**
 * The ledger a launch would have left: one pending control-plane session of the claude profile,
 * acknowledged (it took up its request) and now reporting `status` to Herdr, whose screen `screen` answers.
 */
async function session(root: string, credentialDirectory: string, fields: Partial<ReviewRecord> = {}) {
  const start = Date.now();
  const record = reviewRecordSchema.parse({
    id: randomUUID(), key: 'GY-64', pr: 64, sha: H, baseSha: B, policyRevision: 1,
    profile: 'claude-reviewer', agentName: 'review-claude-1', pane: 'pane-review', sessionDirectory: join(credentialDirectory, 'session'),
    requestedAt: iso(start), tokenExpiresAt: iso(start + 60 * 60_000), state: 'pending',
    mode: 'control-plane', launch: 'fixture-launch', acknowledgedAt: iso(start + 1000), ...fields,
  });
  const ledger: ReviewLedger = { version: 1, reviews: [record] };
  await saveReviewLedger(root, ledger);
  return { record, start };
}

test('unit:silent-reviewer-relaunched — a session that reports running but has posted no verdict and changed no output for run.reviewSilenceMinutes is ended with the silent minutes on its record and its pane closed, and its request relaunches on another reviewer profile', async () => {
  const { root, credentialDirectory, config, cleanup } = await boundMaster(true);
  try {
    const silent = { ...config, run: { ...config.run, reviewSilenceMinutes: 1, reviewerProfile: 'claude-reviewer' } } as MasterConfig;
    const calls: string[][] = [];
    let screen: string | null = 'reviewing GY-64 the diff has not moved';
    const run = herdrRun(calls, () => screen);
    // GY-115: the review request follows the head's mechanical proofs, so the head is proven first.
    const item = work({ evidence: [{ id: 'ev-1', proof: 'unit:silent-reviewer-relaunched', sha: H, baseSha: B, policyRevision: 1, producer: 'proof-runner', trusted: true, result: 'pass', executed: 1, skipped: 0, at: new Date().toISOString() }] });
    reconcileAutoDispatch(item, [item], new Date());
    const { start } = await session(root, credentialDirectory, { requestId: item.autoDispatch!.review!.id });
    const working = [{ name: 'review-claude-1', pane_id: 'pane-review', agent_status: 'working' }];
    // The first pass past the bound arms the baseline: a screen as first read is no change to build on.
    const armed = await reconcileReviews(root, silent, { run, observe: () => null, work: [item], agents: working, now: () => new Date(start + 61_000) });
    assert.equal(armed.reviews[0].state, 'pending', 'the first sight alone ends nothing');
    assert.ok(armed.reviews[0].silentSince, 'the baseline is armed');
    // The screen still shows the same words: the bound has passed, the session is ended and the minutes recorded.
    const settled = await reconcileReviews(root, silent, { run, observe: () => null, work: [item], agents: working, now: () => new Date(start + 130_000) });
    const failed = settled.reviews[0];
    assert.equal(failed.state, 'failed');
    assert.equal(failed.resolution, silentReviewReason(1), 'the settle names the silent minutes and the relaunch');
    assert.ok(calls.some(args => args[0] === 'pane' && args[1] === 'close' && args[2] === 'pane-review'), 'the silent session is ended, pane and all');
    // The dispatcher relaunches the request once the retry wait has passed — on another reviewer profile, the one this request never ran on; a single-profile install reuses its only one.
    let clock = start + 200_000;
    const launches: string[] = [];
    const effects: DispatchEffects = {
      snapshot: async () => ({ work: [item], now: new Date(clock).toISOString() }),
      agents: () => [],
      credentials: async () => ({}),
      reconcileReviews: async (given, agents) => reconcileReviews(root, silent, { run, work: given, agents, observe: () => null, now: () => new Date(clock) }),
      reconcileProducers: async () => ({ producers: [] }),
      launchReview: async (_work, _request, profile) => { launches.push(profile.name); },
      launchProducer: async () => { throw new Error('no producer session is expected in this scenario'); },
      persist: async () => {},
    };
    const tick = await runDispatchTick(silent, emptyDispatchCursor(silent), effects, () => clock);
    assert.deepEqual([tick.launched.map(launch => launch.profile), launches], [['codex-reviewer'], ['codex-reviewer']], 'the relaunch goes to another reviewer profile');
    assert.match((await readReviewLedger(root)).reviews[0].resolution!, /^silent for 1 minute/, 'the failed attempt the relaunch answers carries the silent minutes');
  } finally { await cleanup(); }
});

test('unit:silent-reviewer-relaunched — output resets the bound: a session whose screen changed is not ended, and only the minutes since the last change count', async () => {
  const { root, credentialDirectory, config, cleanup } = await boundMaster();
  try {
    const silent = { ...config, run: { ...config.run, reviewSilenceMinutes: 1 } } as MasterConfig;
    const calls: string[][] = [];
    let screen: string | null = 'first screen';
    const run = herdrRun(calls, () => screen);
    const item = work();
    const { start } = await session(root, credentialDirectory);
    const working = [{ name: 'review-claude-1', pane_id: 'pane-review', agent_status: 'working' }];
    const pass = (at: number) => reconcileReviews(root, silent, { run, observe: () => null, work: [item], agents: working, now: () => new Date(start + at) });
    await pass(61_000);
    screen = 'the reviewer read the diff and printed findings'; // output changed: the bound starts afresh
    const reset = await pass(100_000);
    assert.equal(reset.reviews[0].state, 'pending');
    assert.equal(reset.reviews[0].silentSince, iso(start + 100_000), 'the bound runs from the change');
    const stillWorking = await pass(150_000);
    assert.equal(stillWorking.reviews[0].state, 'pending', 'fifty quiet seconds end nothing');
    const ended = await pass(170_000);
    assert.equal(ended.reviews[0].state, 'failed', 'a full silence bound since the last output ends the session');
    assert.match(ended.reviews[0].resolution!, /^silent for 1 minute/);
  } finally { await cleanup(); }
});

test('unit:silent-reviewer-relaunched — a session Herdr reports done, idle or blocked keeps its idle-grace path: it is prompted once and settled by the grace, never by the silence bound', async () => {
  const { root, credentialDirectory, config, cleanup } = await boundMaster();
  try {
    const silent = { ...config, run: { ...config.run, reviewSilenceMinutes: 1 } } as MasterConfig;
    const prompts: string[] = [];
    const run = herdrRun([], () => 'the reviewer finished its reading');
    const item = work();
    const { start } = await session(root, credentialDirectory);
    const idle = [{ name: 'review-claude-1', pane_id: 'pane-review', agent_status: 'idle' }];
    const pass = (at: number) => reconcileReviews(root, silent, { run, observe: () => null, work: [item], agents: idle, now: () => new Date(start + at), retry: (_record, message) => { prompts.push(message); } });
    // Past the whole silence bound, an idle session is still only prompted: its grace is the GY-193 path's own.
    const prompted = await pass(61_000);
    assert.equal(prompted.reviews[0].state, 'pending');
    assert.equal(prompted.reviews[0].idleSince, iso(start + 61_000), 'the idle grace runs, not the silence bound');
    assert.equal(prompted.reviews[0].silentSince, undefined, 'the silence bound never arms for a session the idle path owns');
    assert.equal(prompts.length, 1, 'the verdict reminder is prompted once');
    // The reminder's bound (the session acknowledged) settles it as finished without posting.
    const settled = await pass(61_000 + reviewVerdictReminderMs + 1_000);
    assert.equal(settled.reviews[0].state, 'failed');
    assert.match(settled.reviews[0].resolution!, /^the reviewer session finished \(idle\) without posting a verdict/);
    assert.equal(prompts.length, 1, 'the failed session is not prompted again');
  } finally { await cleanup(); }
});

test('unit:silent-reviewer-relaunched — a verdict settles the session however silent it looked: the silence bound never displaces a posted verdict', async () => {
  const { root, credentialDirectory, config, cleanup } = await boundMaster();
  try {
    const silent = { ...config, run: { ...config.run, reviewSilenceMinutes: 1 } } as MasterConfig;
    const run = herdrRun([], () => 'the reviewer decided long ago and the screen never moved');
    const item = work();
    const { start } = await session(root, credentialDirectory);
    const working = [{ name: 'review-claude-1', pane_id: 'pane-review', agent_status: 'working' }];
    const settled = await reconcileReviews(root, silent, { run, observe: () => ({ state: 'CHANGES_REQUESTED', reviewer: 'graphyard-reviewer[bot]', reviewId: 77, submittedAt: iso(start + 120_000) }), work: [item], agents: working, now: () => new Date(start + 130_000) });
    assert.equal(settled.reviews[0].state, 'completed');
    assert.equal(settled.reviews[0].verdict!.state, 'CHANGES_REQUESTED');
    assert.equal(settled.reviews[0].resolution, undefined);
  } finally { await cleanup(); }
});
