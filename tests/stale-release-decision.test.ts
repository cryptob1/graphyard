import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { classifyAttention, faultClassItem, type FaultInstance } from '../src/model/fault-classes.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { clearDiagnoses, diagnosesSettled, type DiagnosticianEffects } from '../src/daemon/diagnosis.js';
// Namespace imports: on a tree without these exports each case still runs, and fails as a case.
import { maxDecisionRequests, neededDecision } from '../src/daemon/decisions.js';
import { cycleFaults } from '../src/daemon/faults.js';
import { decisionKey } from '../src/daemon/reconcile.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import { approverWait } from '../src/daemon/metrics.js';
import * as owedReport from '../src/cli/owed-report.js';
import { terminalDecisions } from '../src/cli/decision-report.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';

// GY-1294: five diagnosed P1 root-cause fixes sat in backlog for hours. The diagnostician filed each
// fix and requested its release, bound to the item revision it read; the loop's own writes moved that
// revision before the approver read it, the server settled the release `stale` ("Task revision
// changed; reload and request again; the decision was not applied"), and nothing ever asked again.
// The loop now requests a stale diagnosis decision again within the cycle (the diagnosis step's
// re-request, GY-1296, is the one path that does), and a stale release still standing is named as
// owed decision attention. Each test is named for its proof.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const minute = 60_000, hour = 60 * minute;
const iso = (at: number) => new Date(at).toISOString();
const policy = { threshold: 3, windowHours: 24 };
const settings = diagnosticianSettings({});
const staleOutcome = 'Task revision changed; reload and request again; the decision was not applied';

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/x.ts'], stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: iso(clock - hour), updatedAt: iso(clock), stageEnteredAt: iso(clock - hour), ready: false, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}
function runner(respond: () => unknown): Runner {
  return {
    name: 'pi',
    start<T>(_prompt: string, options: RunOptions<T>) {
      const parsed = options.validate(respond());
      const result: RunResult<T> = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] };
      return { id: 'run', events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
    },
  };
}
const fix = { title: 'Stop the observation race', description: 'The gate waits on an observation nobody refreshes.', type: 'bug' as const, priority: 1,
  criteria: [{ id: 'AC-1', text: 'The observation is refreshed within a cycle, by a test', proofs: ['unit:observation-refreshed'] }], plannedFiles: ['src/merge-queue.ts', 'tests/refresh.test.ts'] };

/**
 * A control plane in miniature: the work graph, and a decision ledger that judges a release the way
 * server/decision-ledger.ts does — the decision binds the revision it was requested against, and an
 * approval against a moved revision settles it stale.
 */
function world() {
  const state = emptyDaemonState(config());
  const instances: FaultInstance[] = ['GY-1', 'GY-2', 'GY-3'].map((subject, index) => ({ id: `blocker|${subject}|${iso(clock - index * minute)}`, kind: 'blocker', faultClass: 'stalled-gate',
    subject, text: `${subject} waits on the merge of PR #77`, at: iso(clock - index * minute), lastSeenAt: iso(clock), linkedTo: 'GY-101' }));
  state.faults.instances.push(...instances);
  const recurringInput = faultClassItem({ faultClass: 'stalled-gate', recent: instances }, policy, clock);
  const work: Work[] = [item('GY-101', { title: recurringInput.title, description: recurringInput.description, origin: recurringInput.origin } as Partial<Work>)];
  const ledger: { id: string; work: string; action: string; state: string; input: Record<string, unknown>; requestedAt: string; outcome: string | null; approvedBy: string | null }[] = [];
  const approvers: { work: string; decision: string }[] = [];
  let now = clock, sequence = 0;
  const find = (key: string) => work.find(entry => entry.key === key)!;
  const diagnostician: DiagnosticianEffects = {
    settings, cwd: '/checkout/project',
    runner: async () => ({ runner: runner(() => ({ subject: 'GY-101', cause: 'The merge queue never re-reads a CLEAN pull request after its base moves',
      evidence: { logLines: ['merge GY-1 waiting'], commands: ['gh pr view 77'] }, faultClass: 'stalled-gate', fix })), runtime: 'pi', model: settings.model }),
    context: async () => ({ journal: [], serverLog: [], pullRequests: [] }),
    file: async input => { const filed = item('GY-201', { title: input.title, priority: input.priority, criteria: input.criteria, plannedFiles: input.plannedFiles } as Partial<Work>); work.push(filed); return filed; },
    // decisionInput binds a release to the revision of the item it is handed (src/master/autonomy.ts).
    decide: async (target, action, reason, input) => {
      const id = `decision-${++sequence}`;
      ledger.push({ id, work: target.key, action, state: 'requested', input: action === 'release' ? { expectedRevision: target.revision, ...input } : { expectedRevision: target.revision, ...input, reason }, requestedAt: iso(now), outcome: null, approvedBy: null });
      return { id };
    },
  };
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: work.map(entry => ({ ...entry })), now: iso(now) }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, persist: async () => {},
    fileFaultClass: async () => find('GY-101'),
    diagnostician,
    approver: async (target: Work, decision: string) => { approvers.push({ work: target.key, decision }); return { agentName: `approver-${decision}`, pane: null }; },
    decisions: async (target: Work) => ({ decisions: ledger.filter(entry => entry.work === target.key).map(entry => ({ ...entry })) }),
  } as unknown as DaemonEffects;
  return {
    state, work, ledger, approvers, find,
    at: (offset: number) => { now = clock + offset; },
    async cycle() { await runCycle(config(), state, effects, () => now); await diagnosesSettled(); },
    /** The loop's own write — an attention line, a diagnosis note — moves the item revision. */
    touch(key: string) { const entry = find(key); entry.revision += 1; },
    /** The approver approves the decision; the server applies it, or settles it stale on a revision race. */
    approve(id: string) {
      const decision = ledger.find(entry => entry.id === id)!, target = find(decision.work);
      if (decision.input.expectedRevision !== target.revision) Object.assign(decision, { state: 'stale', outcome: staleOutcome });
      else {
        Object.assign(decision, { state: 'applied', approvedBy: 'approver-agent', outcome: decision.action === 'release' ? 'Released to ready' : 'Closed' });
        if (decision.action === 'release') Object.assign(target, { ready: true, stage: 'ready', revision: target.revision + 1 });
        else Object.assign(target, { stage: 'done', revision: target.revision + 1 });
      }
    },
  };
}
/** Run the loop until the diagnostician has filed the fix and requested its release. */
async function filedAndRequested(w: ReturnType<typeof world>) {
  w.at(0); await w.cycle();
  w.at(minute); await w.cycle();
  const release = w.ledger.find(entry => entry.action === 'release');
  assert.ok(release, `the release of the filed fix is requested: ${JSON.stringify(w.ledger)}`);
  assert.equal(release.work, 'GY-201');
  assert.equal(w.state.diagnoses['GY-101'].state, 'releasing');
  return release;
}
const staleReleaseAttention: typeof owedReport.staleReleaseAttention = (...args) => owedReport.staleReleaseAttention(...args);
const releases = (w: ReturnType<typeof world>) => w.ledger.filter(entry => entry.action === 'release' && entry.work === 'GY-201');

afterEach(() => clearDiagnoses());

test('unit:stale-release-decision-re-requested-within-a-cycle — a release that went stale on a revision race is requested again against the current revision in the next cycle, and its approver launched', async () => {
  const w = world();
  const first = await filedAndRequested(w);
  // The item revision changes mid-request: the loop writes to the fix item before the approver reads it.
  w.touch('GY-201');
  w.approve(first.id);
  assert.equal(first.state, 'stale');

  // Within one cycle the loop asks again, bound to the revision the item now has, and the approver is launched for it.
  w.at(2 * minute); await w.cycle();
  const asked = releases(w);
  assert.equal(asked.length, 2, `the stale release is requested again within the cycle: ${JSON.stringify(w.ledger)}`);
  const again = asked[1];
  assert.equal(again.input.expectedRevision, w.find('GY-201').revision, 'bound to the current revision, not the one that went stale');
  assert.equal(w.state.diagnoses['GY-101'].decision?.id, again.id, 'the diagnosis follows the new request');
  assert.ok(w.approvers.some(entry => entry.decision === again.id), `an approver is launched for the new request: ${JSON.stringify(w.approvers)}`);
  assert.equal(asked.filter(entry => entry.state === 'requested').length, 1, 'asked once, not by two paths');

  // This time no write races it: the release applies, and the diagnosis goes on to close the recurring item.
  w.approve(again.id);
  assert.equal(again.state, 'applied');
  w.at(3 * minute); await w.cycle();
  assert.ok(w.ledger.some(entry => entry.action === 'close' && entry.work === 'GY-101'), 'the recurring item is closed as answered by the released fix');
});

test('unit:stale-release-decision-re-requested-within-a-cycle — the re-request is bounded: past the bound the diagnosis fails with the race named, and nothing more is asked', async () => {
  const w = world();
  await filedAndRequested(w);
  for (let round = 0; round < maxDecisionRequests; round += 1) {
    const latest = releases(w).at(-1)!;
    w.touch('GY-201'); w.approve(latest.id);
    w.at((2 + round) * minute); await w.cycle();
  }
  assert.equal(releases(w).length, maxDecisionRequests, 'maxDecisionRequests requests in all, each settled stale');
  assert.equal(w.state.diagnoses['GY-101'].state, 'failed');
  assert.match(w.state.diagnoses['GY-101'].detail, /settled stale: Task revision changed/);
  w.at(20 * minute); await w.cycle();
  assert.equal(releases(w).length, maxDecisionRequests, 'nothing more is requested once the bound is spent');
  // The stale release still stands as owed attention, so the fix does not sit silent.
  const owed = staleReleaseAttention(w.find('GY-201'), w.ledger.filter(entry => entry.work === 'GY-201'), clock + 20 * minute);
  assert.ok(owed, 'the stale release is owed attention');
});

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
  // It is classed as owed decision attention, the decision fault class, not an unclassified line.
  const [classified] = classifyAttention([owed]);
  assert.equal(classified.kind, 'owed-decision');
  assert.equal(classified.faultClass, 'decision');

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
  assert.equal(classifyAttention([owed])[0].kind, 'owed-decision');
  assert.match(owed.text, /has been owed for 2h/);
  assert.equal(report.attentionItems.filter(entry => entry.subject === 'GY-1289').length, 1, 'named once');
  assert.equal(classifyAttention([report.attentionItems.find(entry => entry.subject === 'GY-7')!])[0].kind, 'decision-stale');
});

/**
 * The recurrence evidence (2026-10-04/05): each diagnosed P1 fix whose release went stale and sat in
 * backlog until the pipeline doctor released it by hand at 2026-10-05T12:21Z.
 */
const recurrences = [
  { key: 'GY-1198', decision: '2a12346e', staleAt: '2026-10-04T13:23Z', parked: '23h' },
  { key: 'GY-1209', decision: '5d4c9afa', staleAt: '2026-10-04T18:42Z', parked: '17.5h' },
  { key: 'GY-1257', decision: '1b50bf71', staleAt: '2026-10-05T05:44Z', parked: '6.5h' },
  { key: 'GY-1278', decision: 'd9446140', staleAt: '2026-10-05T06:57Z', parked: '5.4h' },
  { key: 'GY-1289', decision: 'b16ccd28', staleAt: '2026-10-05T10:29Z', parked: '2h' },
];

test('unit:stale-release-decision-recurrence-reproduced — diagnosis files a P1 fix, its release goes stale on a revision race, and hours of cycles no longer pass without it being asked again', async () => {
  assert.equal(recurrences.length, 5);
  for (const recurrence of recurrences) {
    clearDiagnoses();
    const w = world();
    const first = await filedAndRequested(w);
    assert.equal(w.find('GY-201').priority, 1, `${recurrence.key}: a P1 fix`);
    w.touch('GY-201'); w.approve(first.id);
    // The shape that recurred: an hour of cycles. Before the re-request nothing asked again and the fix stayed in backlog.
    for (let cycle = 1; cycle <= 6; cycle += 1) {
      w.at(minute + cycle * 10 * minute); await w.cycle();
      const latest = releases(w).at(-1)!;
      if (latest.state === 'requested') w.approve(latest.id);
    }
    assert.ok(releases(w).length >= 2, `${recurrence.key} (stale ${recurrence.staleAt}, parked ${recurrence.parked}): the stale release ${recurrence.decision} is requested again`);
    assert.equal(w.find('GY-201').stage, 'ready', `${recurrence.key}: the diagnosed fix is released, not parked in backlog`);
    assert.equal(staleReleaseAttention(w.find('GY-201'), w.ledger.filter(entry => entry.work === 'GY-201'), clock + 2 * hour), null, `${recurrence.key}: nothing left owed`);
  }
});

// GY-1315: four decision faults in 24 hours, each a decision the loop was itself still carrying,
// counted as a fault before the loop's own next step. Each case replays one listed instance.
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
type Row = { id: string; work: string; action: string; state: string; input: Record<string, unknown>; requestedAt: string; outcome: string | null; approvedBy: string | null; approvedAt?: string | null; reason?: string };
/** A loop with no diagnostician over the given items and decision ledger: what a release or closure requested any other way meets. */
function plainWorld(work: Work[], ledger: Row[], start: number) {
  const state = emptyDaemonState(config());
  const approvers: string[] = [];
  let now = start, sequence = 0;
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: work.map(entry => ({ ...entry })), now: iso(now) }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, persist: async () => {},
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
const owedFaults = (key: string, line: ReturnType<typeof staleReleaseAttention>, work: Work[], at: number) =>
  cycleFaults(emptyDaemonState(config()), work, at, { config: config(), reported: line ? [line] : [] }).filter(fault => fault.kind === 'owed-decision' && fault.subject === key);

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

  test(`unit:stale-release-in-motion-not-a-fault — ${release.key} (${release.instance}): the owed line of a stale release the loop is still re-requesting is shown, not counted, until the wait bound or the request bound is spent`, () => {
    const fixItem = item(release.key, { revision: 6, priority: 1 } as Partial<Work>);
    const at = Date.parse(release.instance), ledger = [staleRow(release)];
    const line = staleReleaseAttention(fixItem, ledger, at);
    assert.ok(line, 'master status still names the stale release as owed');
    assert.match(line.text, /has been owed for 5m/);
    assert.deepEqual(owedFaults(release.key, line, [fixItem], at), [], 'the instance does not recur: the loop is asking again');
    // Past the wait bound it counts.
    const bound = owedReport.staleReleaseWaitBoundMs ?? 30 * minute, late = Date.parse(release.requestedAt) + bound + minute;
    assert.equal(owedFaults(release.key, staleReleaseAttention(fixItem, ledger, late), [fixItem], late).length, 1, 'a stale release owed past the bound is a fault');
    // Once every request is spent the loop asks no more, and it counts at once.
    const spent = Array.from({ length: maxDecisionRequests }, (_, index) => ({ ...staleRow(release), id: `${release.decision}-${index}` }));
    assert.equal(owedFaults(release.key, staleReleaseAttention(fixItem, spent, at), [fixItem], at).length, 1, 'a release the loop stopped asking for is a fault');
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
  assert.deepEqual(w.state.faults.instances.filter(fault => fault.kind === 'action:decision' && fault.subject === 'GY-949'), [], 'no decision fault is noted for it');
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
  const waits = Object.entries(w.state.silence.subjects).filter(([, entry]) => entry.work === 'GY-949' && entry.kind === 'decision');
  assert.ok(waits.length, JSON.stringify(w.state.silence.subjects));
  for (const [key, entry] of waits) assert.equal(approverWait({ kind: entry.kind, detail: entry.detail }), false, `${key}: ${entry.detail}`);
  assert.deepEqual(w.state.faults.instances.filter(fault => fault.kind === 'decision-unanswered' && fault.subject === 'GY-949'), []);
});
