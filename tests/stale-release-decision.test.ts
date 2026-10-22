import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
// Namespace imports: on a tree without these exports each case still runs, and fails as a case.
import { maxDecisionRequests, neededDecision } from '../src/daemon/decisions.js';
import { decisionKey } from '../src/daemon/reconcile.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import * as owedReport from '../src/cli/owed-report.js';
import { terminalDecisions } from '../src/cli/decision-report.js';

// GY-1294: five P1 root-cause fixes sat in backlog for hours. A release requested against one item
// revision was settled `stale` ("Task revision changed; reload and request again; the decision was
// not applied") when the loop's own writes moved that revision before the approver read it, and
// nothing ever asked again. The loop now requests a stale release again within the cycle, and a
// stale release still standing is named as owed decision attention. Each test is named for its
// proof. (The diagnostician that filed those five fixes is retired by GY-2186; a release any
// requester left stale meets the same re-request.)

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const minute = 60_000, hour = 60 * minute;
const iso = (at: number) => new Date(at).toISOString();
const staleReleaseAttention: typeof owedReport.staleReleaseAttention = (...args) => owedReport.staleReleaseAttention(...args);
const staleOutcome = 'Task revision changed; reload and request again; the decision was not applied';

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: iso(clock - hour), updatedAt: iso(clock), stageEnteredAt: iso(clock - hour), ready: false, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}



test('unit:stale-release-stands-as-owed-attention — an item in backlog whose latest release went stale is named as owed decision attention', () => {
  const now = clock + 3 * hour;
  const fixItem = item('GY-1209');
  const stale = { id: '5d4c9afa-0000-4000-8000-000000000000', action: 'release', state: 'stale', requestedAt: iso(clock), outcome: staleOutcome };
  const owed = staleReleaseAttention(fixItem, [stale], now);
  assert.ok(owed, 'a backlog item behind a stale release is named');
  assert.equal(owed.subject, 'GY-1209');
  assert.match(owed.text, /release decision 5d4c9afa-\S+, which went stale: Task revision changed/);
  assert.match(owed.text, /owed for 3h/);
  assert.equal(owed.role, 'master');
  assert.match(owed.next, /graphyard master release GY-1209/);

  // Nothing owed once a later release stands, the item left backlog, or the latest release applied.
  assert.equal(staleReleaseAttention(fixItem, [stale, { id: 'later', action: 'release', state: 'requested', requestedAt: iso(now) }], now), null);
  assert.equal(staleReleaseAttention({ ...fixItem, ready: true, stage: 'ready' } as Work, [stale], now), null);
  assert.equal(staleReleaseAttention(fixItem, [{ ...stale, state: 'applied' }], now), null);
  assert.equal(staleReleaseAttention(fixItem, [{ ...stale, action: 'close' }], now), null, 'only a release is owed this way');
});

test('unit:stale-release-stands-as-owed-attention — master status reads the decision history and names the stale release as owed, not as a generic stale line', async () => {
  const now = clock + 2 * hour;
  const histories: Record<string, unknown[]> = {
    'work-GY-1289': [{ id: 'b16ccd28', action: 'release', state: 'stale', requestedAt: iso(clock), outcome: staleOutcome }],
    // An item past backlog keeps the generic stale line: its release is not what it waits on.
    'work-GY-7': [{ id: 'unblock-1', action: 'unblock', state: 'stale', requestedAt: iso(clock), outcome: staleOutcome }],
  };
  const api = async (path: string) => ({ decisions: histories[path.split('/')[1]] ?? [] });
  const report = await terminalDecisions(api, [{ ...item('GY-1289') }, { ...item('GY-7', { stage: 'build' } as Partial<Work>) }], { approvals: [], runtime: { available: false, agents: [] }, now });
  const owed = report.attentionItems.find(entry => entry.subject === 'GY-1289');
  assert.ok(owed, JSON.stringify(report.attentionItems));
  assert.match(owed.text, /has been owed for 2h/);
  assert.equal(report.attentionItems.filter(entry => entry.subject === 'GY-1289').length, 1, 'named once');
  assert.doesNotMatch(report.attentionItems.find(entry => entry.subject === 'GY-7')?.text ?? '', /has been owed/);
});

type Row = { id: string; work: string; action: string; state: string; input: Record<string, unknown>; requestedAt: string; outcome: string | null; approvedBy: string | null; approvedAt?: string | null; reason?: string };
// GY-1315: decisions the loop was itself still carrying. Each case replays one listed instance.
const gy1315 = {
  // GY-1313 and GY-1314: diagnosed fixes whose releases went stale at 16:19:54; the owed lines counted at
  // 16:22:57 and the releases were asked again at 16:26.
  releases: [
    { key: 'GY-1313', decision: 'efd30d69-627a-4e27-9e4e-a44f868b25e8', requestedAt: '2026-10-05T16:17:42.347Z', instance: '2026-10-05T16:22:57.340Z' },
    { key: 'GY-1314', decision: '2bf920df-3a47-4e7c-ae9e-3da9ab50c99a', requestedAt: '2026-10-05T16:17:52.767Z', instance: '2026-10-05T16:22:57.340Z' },
  ],
  staleOutcome: 'Task revision changed (now 4); reload and request again; the decision was not applied',
  // GY-949: rework 8b62b40b, approved 2026-10-03 for head 5d78667000f3 and never applied, then superseded at 15:32:40.
  superseded: { decision: '8b62b40b-0f3d-4cd6-b3c0-3920340a512b', session: 'graphyard-approver-gy-949-8b62b4', instance: '2026-10-05T15:37:28.035Z', unanswered: '2026-10-05T15:23:42.185Z',
    outcome: 'Superseded: approved for head 5d78667000f3 on base d378f5d0cec4, but GY-949 is now at head c7c93c895f68 on base a17bcee6c866, so it can never apply to what it judged; a rework request is judged afresh for the current candidate' },
};

/** A loop with no diagnostician over the given items and decision ledger: what a release or closure requested any other way meets. */
function plainWorld(work: Work[], ledger: Row[], start: number) {
  const state = emptyDaemonState(config());
  const approvers: string[] = [];
  let now = start, sequence = 0;
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: work.map(entry => ({ ...entry })), now: iso(now) }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    persist: async () => {},
    decide: async (target: Work, action: string, reason: string, input: Record<string, unknown> = {}) => {
      const id = `requested-${++sequence}`;
      ledger.push({ id, work: target.key, action, state: 'requested', input: { expectedRevision: target.revision, ...input }, requestedAt: iso(now), outcome: null, approvedBy: null, reason });
      return { id };
    },
    approver: async (_target: Work, decision: string) => { approvers.push(decision); return { agentName: `approver-${decision}`, pane: null }; },
    // A control plane that cannot apply the approval yet: it stays approved, unapplied.
    resume: async (_target: Work, decision: string) => ({ ...ledger.find(entry => entry.id === decision)!, state: 'approved' }),
    decisions: async (target: Work) => ({ decisions: ledger.filter(entry => entry.work === target.key).map(entry => ({ ...entry })) }),
  } as unknown as DaemonEffects;
  return { state, approvers, effects, at: (instant: number) => { now = instant; }, cycle: () => runCycle(config(), state, effects, () => now) };
}
const staleRow = (release: typeof gy1315.releases[number]): Row => ({ id: release.decision, work: release.key, action: 'release', state: 'stale', input: { expectedRevision: 1 }, requestedAt: release.requestedAt,
  outcome: gy1315.staleOutcome, approvedBy: null, reason: `Release ${release.key}, the root-cause fix the diagnostician found, at priority 1.` });

for (const release of gy1315.releases) {
  test(`unit:stale-release-re-requested-by-the-loop — ${release.key} (${release.instance}): a stale release requested outside a diagnosis is asked again against the current revision, and its approver launched`, async () => {
    const fixItem = item(release.key, { revision: 6, priority: 1 } as Partial<Work>);
    const ledger = [staleRow(release)];
    const w = plainWorld([fixItem], ledger, Date.parse(release.instance));
    await w.cycle();
    const again = ledger.filter(entry => entry.action === 'release' && entry.state === 'requested');
    assert.equal(again.length, 1, `the stale release is requested again within the cycle: ${JSON.stringify(ledger)}`);
    assert.equal(again[0].input.expectedRevision, 6, 'bound to the revision the item has now');
    assert.match(again[0].reason!, new RegExp(`Requested again by the master loop against revision 6: release decision ${release.decision} on ${release.key} was settled stale`));
    assert.deepEqual(w.approvers, [again[0].id], 'its independent approver is launched');
    assert.equal(staleReleaseAttention(fixItem, ledger, Date.parse(release.instance)), null, 'nothing is owed once it is asked again');
    // Asked once: the next cycle finds a release standing, not a stale one.
    w.at(Date.parse(release.instance) + minute); await w.cycle();
    assert.equal(ledger.filter(entry => entry.action === 'release').length, 2);
  });
}

test('unit:stale-release-re-requested-by-the-loop — the loop\'s re-request is bounded: past maxDecisionRequests stale releases it escalates once and asks nothing more', async () => {
  const release = gy1315.releases[0], fixItem = item(release.key, { revision: 9 } as Partial<Work>);
  const ledger = Array.from({ length: maxDecisionRequests }, (_, index) => ({ ...staleRow(release), id: `${release.decision}-${index}` }));
  const w = plainWorld([fixItem], ledger, Date.parse(release.instance));
  await w.cycle();
  w.at(Date.parse(release.instance) + minute); await w.cycle();
  assert.equal(ledger.length, maxDecisionRequests, 'nothing more is requested');
  const escalations = Object.values(w.state.actions).filter(action => action.kind === 'escalation' && action.work === release.key);
  assert.equal(escalations.length, 1, JSON.stringify(w.state.actions));
  assert.match(escalations[0].detail, /graphyard master release GY-1313/);
});

test('unit:stale-release-re-requested-by-the-loop — a re-request the control plane refuses is asked again on the widening backoff, not every cycle', async () => {
  const release = gy1315.releases[0], fixItem = item(release.key, { revision: 6 } as Partial<Work>);
  const ledger = [staleRow(release)];
  const w = plainWorld([fixItem], ledger, Date.parse(release.instance));
  const asked: number[] = [];
  const refusing = { ...w.effects, decide: async () => { asked.push(w.state.cycle); throw new Error('Simulated: the control plane refused the request'); } } as unknown as DaemonEffects;
  for (let round = 0; round < 8; round += 1) { w.at(Date.parse(release.instance) + round * minute); await runCycle(config(), w.state, refusing, () => Date.parse(release.instance) + round * minute); }
  assert.ok(asked.length >= 2 && asked.length <= 4, `retried, but on the backoff: asked in cycles ${asked.join(', ')}`);
  for (const [index, cycleNo] of asked.entries()) if (index) assert.ok(cycleNo - asked[index - 1] >= 2 ** (index - 1), `each retry waits out its widening interval: ${asked.join(', ')}`);
  assert.equal(w.state.actions[`release:stale:${release.decision}`]?.state, 'failed');
});

test(`unit:superseded-decision-re-request-not-a-fault — GY-949 (${gy1315.superseded.instance}): a decision the server superseded and the loop asks again is noted as a step, not a failed decision action`, async () => {
  const triagedAt = '2026-10-03T16:45:18.274Z';
  const subject = item('GY-949', { revision: 40, triage: { judgement: { outcome: 'close', ref: 'GY-1', reason: 'Already delivered by GY-1' }, state: 'proposed', by: 'triage', at: triagedAt } } as Partial<Work>);
  const decision = neededDecision(subject, config(), undefined)!;
  assert.equal(decision.action, 'close');
  const { decision: id, session, instance, outcome } = gy1315.superseded;
  const ledger: Row[] = [{ id, work: 'GY-949', action: 'close', state: 'superseded', input: decision.input ?? {}, requestedAt: '2026-10-03T16:46:20.601Z', outcome, approvedBy: 'graphyard-approver-graphyard', approvedAt: '2026-10-03T16:47:22.985Z' }];
  const w = plainWorld([subject], ledger, Date.parse(instance));
  w.state.approvals[decisionKey(subject, decision)] = approvalWatchSchema.parse({ work: 'GY-949', action: 'close', decision: id, agentName: session, requestedAt: '2026-10-03T16:46:20.601Z', launchedAt: '2026-10-03T16:46:21.000Z', launches: 1 });
  await w.cycle();
  const ended = w.state.actions[`approver:${id}:ended`];
  assert.ok(ended, JSON.stringify(Object.keys(w.state.actions)));
  assert.match(ended.detail, /ended superseded \(Superseded: approved for head 5d78667000f3.*still needs it, so it is requested again/);
  assert.equal(ended.state, 'done', 'the re-request is the loop\'s next step, not a failed action');
  assert.equal(ledger.filter(entry => entry.action === 'close' && entry.state === 'requested').length, 1, 'and it is requested again in the same cycle');
});

test(`unit:approved-unapplied-not-an-approver-wait — GY-949 (${gy1315.superseded.unanswered}): an approved decision awaiting its apply, approver gone, is never named as waiting for an approver to judge it`, async () => {
  // The instance read "rework decision 8b62b40b… is requested and waiting for approver session graphyard-approver-gy-949-8b62b4 to judge it for 34 minutes":
  // the decision had been approved two days before and only its application was owed. GY-1298/GY-1300 name that wait for what it is;
  // this replays the instance against the candidate so it stays removed.
  const triagedAt = '2026-10-03T16:45:18.274Z';
  const subject = item('GY-949', { revision: 40, triage: { judgement: { outcome: 'close', ref: 'GY-1', reason: 'Already delivered by GY-1' }, state: 'proposed', by: 'triage', at: triagedAt } } as Partial<Work>);
  const decision = neededDecision(subject, config(), undefined)!;
  const { decision: id, session, unanswered } = gy1315.superseded;
  const ledger: Row[] = [{ id, work: 'GY-949', action: 'close', state: 'approved', input: decision.input ?? {}, requestedAt: '2026-10-03T16:46:20.601Z', outcome: null, approvedBy: 'graphyard-approver-graphyard', approvedAt: '2026-10-03T16:47:22.985Z' }];
  const start = Date.parse(unanswered) - 34 * minute;
  const w = plainWorld([subject], ledger, start);
  w.state.approvals[decisionKey(subject, decision)] = approvalWatchSchema.parse({ work: 'GY-949', action: 'close', decision: id, agentName: session, requestedAt: '2026-10-03T16:46:20.601Z', launchedAt: '2026-10-03T16:46:21.000Z', launches: 1 });
  for (let at = start; at <= Date.parse(unanswered); at += 2 * minute) { w.at(at); await w.cycle(); }
  // The approved decision's own watch names the apply owed, never an approver's judgement; the
  // subject detail the loop keeps (actionableSubjects) words it the same way. (GY-1980 removed the
  // silence measure the instance was filed under.)
  const watch = Object.values(w.state.approvals)[0];
  assert.ok(watch?.approvedAt && watch.approvedBy, JSON.stringify(watch));
});
