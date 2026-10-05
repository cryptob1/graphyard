import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { classifyAttention, faultClassItem, type FaultInstance } from '../src/model/fault-classes.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { clearDiagnoses, diagnosesSettled, type DiagnosticianEffects } from '../src/daemon/diagnosis.js';
// Namespace imports: on a tree without these exports each case still runs, and fails as a case.
import { maxDecisionRequests } from '../src/daemon/decisions.js';
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
