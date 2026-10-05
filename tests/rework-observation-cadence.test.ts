import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationBand, observationCadence, observationCadenceMs } from '../src/github.js';
import { randomUUID } from 'node:crypto';
import { emptyDaemonState, observedFrom, reworkObservationMaxAgeMs, reworkObservationWait, runCycle, type DaemonAction, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';
import type { NextAction } from '../src/model/action-kinds.js';

/**
 * 2026-09-25: GY-173, GY-177 and GY-182 were ejected from the merge queue for conflicts and sat
 * there for over an hour. The loop asks for their rework only from an observation under two
 * minutes old (GY-144), but an item needing a rework was observed on the idle band — or the
 * steady one once unchanged — never less than two minutes apart, so every cycle read "rework
 * waits for a fresh GitHub observation". The cadence of such an item must stay under that bound.
 */
const observation = { at: '2026-09-25T12:00:00.000Z', candidate: { sha: 'a'.repeat(40) }, merged: false, prState: 'open', checks: [], reviews: [] } as unknown as Observation;
const work = { key: 'GY-1', candidate: { sha: 'a'.repeat(40), pr: 1 }, observation, gates: [{ name: 'review', passed: false }] } as unknown as Work;
const next = (kind: NextAction['kind']) => ({ kind }) as unknown as NextAction;
const now = new Date('2026-09-25T12:00:30.000Z');

test('unit:rework-observed-within-decision-bound — an item whose next action is a rework is observed faster than the loop\'s rework freshness bound, even when unchanged and under a stretched fleet bound', () => {
  assert.equal(observationBand(work, [work], now, next('request-rework')).band, 'active');
  for (const steadyMs of [observationCadenceMs.steady, 600_000]) {
    const cadence = observationCadence(work, [work], now, observation, steadyMs, next('request-rework'));
    assert.equal(cadence.band, 'active', 'an unchanged rework-bound item is not settled to the steady band');
    assert.ok(cadence.ms < reworkObservationMaxAgeMs, `observed every ${cadence.ms}ms, inside the ${reworkObservationMaxAgeMs}ms bound the rework decision needs`);
  }
  // Dispatch and escalation stay idle: nothing observed on GitHub moves them.
  for (const kind of ['dispatch', 'escalate'] as const) assert.equal(observationBand(work, [work], now, next(kind)).band, 'idle');
  // Any other active item that came back unchanged still settles to the steady band.
  assert.equal(observationCadence(work, [work], now, observation, observationCadenceMs.steady, next('request-review')).band, 'steady');
});

/**
 * GY-1257. The loop asked for a rework only from an observation under two minutes old on its own
 * cycle clock, but a cycle took ~412s, so the observation its wake brought in was stale by the
 * time the decisions step read it: GY-1168, GY-1244, GY-1238, GY-1062 and GY-1124 stood owed a
 * rework the loop itself never requested. The woken observation of the candidate head is decided
 * from whatever its age; currency is enforced when the decision is applied.
 */
const minute = 60_000, clock = Date.parse('2026-10-05T05:30:00.000Z'), headX = 'a'.repeat(40), headY = 'c'.repeat(40), baseSha = 'b'.repeat(40);
const iso = (at: number) => new Date(at).toISOString();
const loopConfig = () => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
  githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
  reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: iso(clock - 60 * minute) },
  reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }], producers: [], run: { intervalSeconds: 300 } }) as MasterConfig;
/** A submitted head a changes-requested verdict stands against: it needs rework. The observation may read another head than the candidate. */
function reworkHead(observedAt: number, { candidateSha = headX, observedSha = headX, verdict = 'CHANGES_REQUESTED' } = {}): Work {
  const branch = 'graphyard/gy-1257-1', candidate = { sha: candidateSha, baseSha, pr: 42, branch, author: 'worker' };
  return {
    id: 'work-GY-1257', key: 'GY-1257', title: 'Owed rework', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', ready: true, epoch: 1,
    revision: 1, policyRevision: 1, createdAt: iso(clock - 180 * minute), updatedAt: iso(observedAt), stageEnteredAt: iso(clock - 60 * minute), lease: null, workspaces: [],
    submission: { epoch: 1, pr: 42 }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    observation: { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, sha: observedSha }, checks: [{ name: 'test', result: 'success', appId: 15368 }],
      reviews: [{ reviewer: 'independent-reviewer', sha: observedSha, state: verdict }], protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [],
      at: iso(observedAt), prState: 'open', draft: false, baseTip: baseSha, baseTipContained: true },
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
  } as unknown as Work;
}
/** A loop with the decision effects, over a fixed snapshot; `wokenAt` is the item's landed wake:observation entry, if any. */
function loop(work: () => Work, { wokenAt, pausedUntil }: { wokenAt?: number; pausedUntil?: number } = {}) {
  const config = loopConfig(), state = emptyDaemonState(config);
  if (wokenAt !== undefined) state.actions[`wake:observation:${work().id}`] = { kind: 'wake', work: work().key, principal: null, state: 'done', detail: 'woke', at: iso(wokenAt), attempts: 1, cycle: 0 } as unknown as DaemonAction;
  const requested: { action: string; reason: string; sha: string | undefined }[] = [], wakes: string[] = [], withdrawn: { decision: string; reason: string }[] = [];
  const decisions: { id: string; action: string; state: string; input: unknown; approvedBy: null }[] = [];
  const jobs = pausedUntil ? [{ error: `GitHub requests paused until ${iso(pausedUntil)}` }] : [];
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: [work()], now: iso(clock), jobs }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(clock), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    wakeObservation: async (item: Work) => { wakes.push(item.key); },
    decide: async (item: Work, action: string, reason: string, input?: Record<string, unknown>) => {
      requested.push({ action, reason, sha: item.candidate?.sha }); const id = randomUUID();
      decisions.push({ id, action, state: 'requested', input: input ?? {}, approvedBy: null }); return { id };
    },
    decisions: async () => ({ decisions }),
    withdraw: async (_item: Work, decision: string, reason: string) => { withdrawn.push({ decision, reason }); const entry = decisions.find(each => each.id === decision); if (entry) entry.state = 'withdrawn'; },
    approver: async () => ({ agentName: 'graphyard-approver-gy-1257', pane: 'pane-1' }),
    persist: async () => {},
  } as unknown as DaemonEffects;
  return { state, requested, wakes, withdrawn, run: () => runCycle(config, state, effects, () => clock) };
}
const waitLine = (state: DaemonState) => state.actions['wait:rework:work-GY-1257'];

test('unit:rework-requested-from-wake-answered-observation — a rework is requested from the observation its wake brought in, whatever its age on the cycle clock, with no wait:rework line', async () => {
  // The wake was sent; the observation it answered with landed after it; a slow cycle reads it minutes later.
  for (const age of [3 * minute, 9 * minute, 40 * minute]) {
    const observedAt = clock - age, harness = loop(() => reworkHead(observedAt), { wokenAt: observedAt - 30_000 });
    await harness.run();
    assert.deepEqual(harness.requested.map(entry => entry.action), ['rework'], `an observation ${age / minute} minutes old answered the wake, so the rework is requested`);
    assert.equal(waitLine(harness.state), undefined, 'no wait:rework line is recorded');
    assert.deepEqual(harness.wakes, [], 'and the observation is not woken again');
  }
});

test('unit:rework-waits-without-observation-or-during-pause — with no wake outstanding, no observation, or a GitHub pause, the request is withheld and the wait names why', async () => {
  // No wake outstanding: a stale observation is not decided from, and its observation is woken.
  const unwoken = loop(() => reworkHead(clock - 9 * minute));
  await unwoken.run();
  assert.deepEqual(unwoken.requested, []);
  assert.match(waitLine(unwoken.state)?.detail ?? '', /rework waits for a fresh GitHub observation — the last GitHub observation \(taken at .* of head aaaaaaaaaaaa\) is a stale observation, older than two minutes/);
  assert.deepEqual(unwoken.wakes, ['GY-1257']);
  // A wake whose observation has not landed is no answer: the observation predates the wake.
  const pending = loop(() => reworkHead(clock - 9 * minute), { wokenAt: clock - 8 * minute });
  await pending.run();
  assert.deepEqual(pending.requested, []);
  assert.match(waitLine(pending.state)?.detail ?? '', /stale observation/);
  // A standing GitHub pause withholds even a wake-answered observation, and names the pause.
  const paused = loop(() => reworkHead(clock - 9 * minute), { wokenAt: clock - 10 * minute, pausedUntil: clock + 10 * minute });
  await paused.run();
  assert.deepEqual(paused.requested, []);
  assert.match(waitLine(paused.state)?.detail ?? '', new RegExp(`GitHub requests are paused until ${iso(clock + 10 * minute).replace(/[.]/g, '\\.')}`));
  // The same 40-minute-old reading, once the wake it answered stands, is decided from: the wake, not the age, is what was withheld on.
  const stale = clock - 40 * minute, unanswered = loop(() => reworkHead(stale)), answered = loop(() => reworkHead(stale), { wokenAt: stale - 30_000 });
  await unanswered.run(); await answered.run();
  assert.deepEqual([unanswered.requested.length, answered.requested.length], [0, 1]);
  assert.match(waitLine(unanswered.state)?.detail ?? '', /stale observation/);
  assert.equal(waitLine(answered.state), undefined);
  // No observation at all: there is none to decide from.
  const unobserved = { ...reworkHead(clock), observation: null } as Work;
  assert.equal(reworkObservationWait(unobserved, clock, null, iso(clock - minute)), 'GY-1257: rework waits for a GitHub observation of the item; there is none to decide from');
});

test('unit:rework-request-names-current-head — no rework is requested from an observation of another head, and the request cites the observation it was decided from', async () => {
  // The woken observation read a head the candidate has moved past.
  const other = reworkHead(clock - 40 * minute, { candidateSha: headY, observedSha: headX });
  assert.match(reworkObservationWait(other, clock, null, iso(clock - 41 * minute)) ?? '', /stale observation/);
  const moved = loop(() => other, { wokenAt: clock - 41 * minute });
  await moved.run();
  assert.deepEqual(moved.requested, [], 'a rework is never requested from an observation of another head');
  // On the current head the request cites observedFrom(...), naming the observation's time and head.
  const current = reworkHead(clock - 40 * minute), harness = loop(() => current, { wokenAt: clock - 41 * minute });
  await harness.run();
  assert.equal(harness.requested.length, 1);
  assert.equal(harness.requested[0].sha, headX);
  assert.ok(harness.requested[0].reason.includes(observedFrom(current)), harness.requested[0].reason);
  assert.match(harness.requested[0].reason, new RegExp(`Decided from the GitHub observation taken at ${iso(clock - 40 * minute).replace(/[.]/g, '\\.')} of candidate ${headX}`));
});

test('unit:overtaken-rework-decision-withdrawn — a requested rework the candidate moved past is withdrawn, not left to apply', async () => {
  // Requested from a woken observation 40 minutes old: request time no longer bounds its age, so apply time must catch a moved head.
  let work = reworkHead(clock - 40 * minute);
  const harness = loop(() => work, { wokenAt: clock - 41 * minute });
  await harness.run();
  assert.equal(harness.requested.length, 1, 'the rework was requested on the woken observation of head X');
  // Before any approver judged it, the worker pushed head Y and the reviewer approved it: no rework is called for.
  work = reworkHead(clock - minute, { candidateSha: headY, observedSha: headY, verdict: 'APPROVED' });
  await harness.run();
  assert.equal(harness.withdrawn.length, 1, `the decision for the moved-past head is withdrawn: ${JSON.stringify(harness.withdrawn)}`);
  assert.match(harness.withdrawn[0].reason, /moved past the rework this decision asked for/);
  assert.equal(harness.requested.length, 1, 'and nothing new is requested for head Y');
});
