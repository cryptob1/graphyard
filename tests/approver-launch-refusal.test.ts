import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverSessionName, loadMasterConfig, setupMaster, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { handWatchPrefix, transientLaunchRefusal } from '../src/daemon/cycle-decisions.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import type { Work } from '../src/model.js';

// GY-706: the follow-ups the independent review of GY-551 left. Every non-capacity approver launch
// error used to be taken back, so a permanent refusal — a misconfigured approver profile, a bad
// credential — was retried every cycle without bound and never escalated. Only a transient refusal
// is taken back now; any other spends its launch and is named when the decision is escalated past
// the bound. The hand-watch relaunch and the loop's own now share one step, so both are covered here.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const decision = '5b1e0c2d-4cb5-4f21-9b0e-0f2a6c8d4e15';

function item(key: string): Work {
  return {
    id: `work-${key}`, key, title: 'Approver launch refused', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Bounded', proofs: ['unit:approver-launch-refusal'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'ready', revision: 4, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}

test('unit:transient-launch-refusal — timeouts, unreachable services, 408/429/5xx and an unreadable Herdr inventory are transient; a missing runtime, a bad credential or a 4xx is not', () => {
  const coded = (code: string) => Object.assign(new Error('connect failed'), { code });
  const status = (value: number) => Object.assign(new Error('refused'), { status: value });
  for (const error of [
    new Error('the agent registry for the approver role is unreachable: timeout'),
    new Error('request timed out after 30000 ms'),
    coded('ECONNREFUSED'),
    new Error('fetch failed', { cause: coded('UND_ERR_CONNECT_TIMEOUT') }),
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
    status(503), status(429), status(408),
    new Error('registry answered HTTP 502 Bad Gateway'),
    new Error("Herdr's session inventory could not be read, so no approver session for GY-1 is launched into it; the launch is made again once Herdr answers"),
  ]) assert.equal(transientLaunchRefusal(error), true, message(error));
  for (const error of [
    new Error('No runtime is configured for the approver: name accounts for the approver role'),
    new Error('the approver credential file could not be read: ENOENT'),
    status(401), status(403), status(404),
    new Error('Approver session graphyard-approver-gy-1-x is already visible in Herdr; let it finish or close it first'),
    new Error('No healthy agent account for approver profile approver: every account is refused'),
  ]) assert.equal(transientLaunchRefusal(error), false, message(error));
});
/** The escalation of a decision no approver session judged — not the dispatch escalations an unstaffed test fleet raises. */
const unjudged = (action: { kind: string; detail: string }) => action.kind === 'escalation' && action.detail.includes('have not produced a judgement');
const message = (error: Error) => `${error.message}${error.cause ? ` (cause ${(error.cause as Error).message})` : ''}`;

async function harness(refusal: () => Error) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-approver-launch-refusal-'));
  const credentials = await mkdtemp(join(tmpdir(), 'graphyard-approver-launch-refusal-credentials-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };
  const work = item('GY-706'), name = approverSessionName(work, decision);
  const agents: HerdrAgent[] = [], closed: string[] = [], calls = { launches: 0 }, tick = { at: clock };
  const effects: DaemonEffects = {
    agents: () => agents,
    credentials: async () => ({}),
    snapshot: async () => ({ work: [work], now: new Date(tick.at).toISOString() }),
    closeSession: pane => { closed.push(pane); },
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({ result: 'merged', merged: true }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    decisions: async () => ({ decisions: [{ id: decision, action: 'release', state: 'requested', requestedAt: iso(), input: {}, approvedBy: null }] }),
    approver: async () => { calls.launches += 1; throw refusal(); },
    approverLaunches: async () => [],
  };
  const state = emptyDaemonState(config);
  // A `master approver` session the loop is already watching; it vanishes without judging.
  state.approvals[`${handWatchPrefix}${decision}`] = approvalWatchSchema.parse({ work: work.key, action: 'release', decision, requestedAt: iso(), agentName: name, launchedAt: iso(), launches: 1 });
  const cycle = (at: number) => { tick.at = at; return runCycle(config, state, effects, () => tick.at); };
  const watch = () => state.approvals[`${handWatchPrefix}${decision}`];
  const cleanup = async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); };
  return { name, closed, calls, cycle, watch, cleanup };
}

test('unit:approver-launch-refusal-bounded — a permanent approver launch refusal spends the launch bound and escalates the decision naming each refusal, rather than being retried every cycle without end', async () => {
  const refused = 'No runtime is configured for the approver: name accounts for the approver role';
  const { name, calls, cycle, watch, cleanup } = await harness(() => new Error(refused));
  try {
    // Cycle 1: the session is gone, so its replacement — launch 2 of 3 — is made and refused.
    const first = await cycle(clock + 30_000);
    assert.equal(calls.launches, 1);
    assert.equal(watch().launches, 2, 'a permanent refusal spends its launch');
    assert.equal(watch().agentName, null);
    assert.ok(!watch().exhaustedAt);
    assert.ok(first.actions.some(action => action.kind === 'decision' && action.state === 'failed' && action.detail.includes(refused)), 'the refusal is recorded');
    const gone = `session 1: release decision ${decision} on GY-706: approver session ${name} is gone without judging it`;
    assert.deepEqual(watch().ended, [gone, `launch 2 refused: ${refused}`]);

    // Cycle 2: the last launch of the bound, refused the same way.
    await cycle(clock + 60_000);
    assert.equal(calls.launches, 2);
    assert.equal(watch().launches, 3);
    assert.ok(!watch().exhaustedAt);

    // Cycle 3: the bound is spent on refusals. No further launch; the decision is escalated with each reason.
    const third = await cycle(clock + 90_000);
    assert.equal(calls.launches, 2, 'no launch is made past the bound');
    assert.ok(watch().exhaustedAt, 'the decision is marked spent');
    assert.deepEqual(watch().ended, [gone, `launch 2 refused: ${refused}`, `launch 3 refused: ${refused}`], 'a spent bound records no ended session of its own');
    const escalation = third.actions.find(unjudged);
    assert.ok(escalation, 'the unanswered decision is escalated');
    assert.ok(escalation.detail.includes(`launch 3 refused: ${refused}`), 'the escalation names the refusal');

    // Cycle 4: nothing more is launched or escalated.
    const fourth = await cycle(clock + 120_000);
    assert.equal(calls.launches, 2);
    assert.ok(!fourth.actions.some(unjudged), 'the decision is not escalated again');
  } finally { await cleanup(); }
});

test('unit:approver-launch-refusal-transient — a transient approver launch refusal is taken back and retried next cycle, and never escalates the decision', async () => {
  const { calls, cycle, watch, cleanup } = await harness(() => new Error('the agent registry for the approver role is unreachable: timeout'));
  try {
    for (let round = 1; round <= 5; round += 1) {
      const result = await cycle(clock + round * 30_000);
      assert.equal(calls.launches, round, 'each cycle makes the launch again');
      assert.equal(watch().launches, 1, 'a transient refusal never spends the bound');
      assert.ok(!watch().exhaustedAt);
      assert.ok(!result.actions.some(unjudged), 'the decision is not escalated');
    }
    assert.equal(watch().ended.length, 1, 'only the session that ran has an end reason');
  } finally { await cleanup(); }
});
