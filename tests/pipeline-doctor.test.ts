import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { Launcher, type Cycle } from '../src/daemon/cycle.js';
import { Timings } from '../src/master/timings.js';
import { approverSessionName } from '../src/master/autonomy.js';
import { clearDoctorRuns, clearCoveredBlockers, doctorBounds, doctorDue, doctorIntervalMs, doctorPrompt, doctorRunsSettled, doctorSanctionedCommands, doctorStep, relaunchUnansweredApprovers, settleSubmittedContainment, unansweredDecisionMs, type DoctorEffects } from '../src/daemon/doctor.js';
import { doctorSettingsSchema, type DoctorRunRecord } from '../src/runner/roles.js';
import { doctorTool } from '../src/runner/roles.js';
import { doctorSanctionedCommands as piSanctioned, doctorSegmentAllowed, graphyardTools as piTools } from '../integrations/pi/index.js';
import type { Runner } from '../src/runner/types.js';
import type { Work } from '../src/model.js';

// Each test is named for the proof it produces (GY-711): unit:doctor-scheduled-and-scoped,
// unit:doctor-run-recorded and unit:loop-applies-routine-remedies.

const observedAt = '2030-01-01T12:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(observedAt) + offsetMs).toISOString();

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/tmp/coordinator.token', cliPath: '/usr/lib/graphyard/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
}

function item(overrides: Partial<Work> = {}): Work {
  return { id: 'id-GY-74', key: 'GY-74', title: 'Item', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/item.ts'], stage: 'build', revision: 3, policyRevision: 1, createdAt: observedAt, updatedAt: observedAt,
    stageEnteredAt: observedAt, ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [], ...overrides } as Work;
}

function cycle(work: Work[], overrides: Partial<Omit<Cycle, 'effects'>> & { doctor?: DoctorEffects | null; effects?: Partial<DaemonEffects> } = {}): Cycle {
  const { effects: effectOverrides, doctor, ...cycleOverrides } = overrides;
  const master = config();
  const clock = Date.parse(observedAt);
  const base: DaemonEffects = {
    agents: () => overrides.agents ?? [],
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: observedAt }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: observedAt, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  };
  const state: DaemonState = overrides.state ?? emptyDaemonState(master);
  const effects = { ...base, ...effectOverrides, ...(doctor === null || doctor === undefined ? {} : { doctor }) } as DaemonEffects;
  return {
    config: master, state, effects, now: () => clock, snapshot: { work, now: observedAt }, clock, clockOffset: { min: 0, max: 0 },
    performed: [], agents: overrides.agents ?? [], credentials: {}, open: work.filter(entry => entry.stage !== 'done'),
    owns: () => false, heldBy: () => null, timings: new Timings(() => clock),
    launcher: new Launcher(Number.POSITIVE_INFINITY),
    launch: () => false, detached: false,
    isolate: async (_kind, _item, _name, body) => await body(),
    ...cycleOverrides,
  } as Cycle;
}

const words = (...values: string[]) => values.map(value => ({ value, dynamic: false, glob: false }));
const liveAgent = (name: string) => ({ name, agent_status: 'working', pane_id: 'p1' } as any);
const summary = (at_: string, runState: 'reported' | 'running' = 'reported'): DoctorRunRecord => ({ at: at_, state: runState, runs: [], findings: [], actions: [], filed: [], detail: '' });

test('unit:doctor-scheduled-and-scoped — the doctor runs every ten minutes by default on a configurable interval, its session holds only the sanctioned commands with a refusal recorded rather than run, and the shipped template names every fault bound', async () => {
  const settings = doctorSettingsSchema.parse({});
  assert.equal(settings.enabled, true, 'the doctor is on by default');
  assert.equal(settings.intervalMinutes, 10, 'the doctor runs every ten minutes by default');
  assert.notEqual(settings.fallbackModel, settings.model, 'the fallback model is stronger than the default model');
  const master = config();
  const state = emptyDaemonState(master);
  // The schedule: never run, it is due; nine minutes after a run it is not; at ten it is.
  state.doctor.runs = [summary(at(0))];
  assert.equal(doctorDue(state, Date.parse(at(9 * 60_000)), settings), false, 'nine minutes after the last run the doctor is not due');
  assert.equal(doctorDue(state, Date.parse(at(10 * 60_000)), settings), true, 'ten minutes after the last run the doctor is due');
  // A run still in flight is never overlapped, whatever the interval.
  state.doctor.runs.push(summary(at(10 * 60_000), 'running'));
  assert.equal(doctorDue(state, Date.parse(at(30 * 60_000)), settings), false, 'a run in flight is not overlapped');
  // The interval is the operator's: run.doctor.intervalMinutes=30 moves the bound.
  const slower = doctorSettingsSchema.parse({ intervalMinutes: 30 });
  assert.equal(doctorIntervalMs(slower), 30 * 60_000);
  assert.equal(doctorDue({ doctor: { runs: [summary(at(0))] } }, Date.parse(at(10 * 60_000)), slower), false, 'on a 30-minute interval a ten-minute-old run is not due');

  // The role's command allowlist: the sanctioned master commands run; merge, dispatch, evidence
  // and lease commands are refused with a reason that says the refusal is recorded, not run.
  assert.deepEqual([...piSanctioned].sort(), [...doctorSanctionedCommands].sort(), 'the integration and the loop agree on the sanctioned commands');
  for (const command of doctorSanctionedCommands) {
    assert.deepEqual(doctorSegmentAllowed(words('graphyard', 'master', command, 'GY-74', 'reason')), { allow: true }, `master ${command} is sanctioned`);
  }
  for (const segments of [['graphyard', 'master', 'merge', 'GY-74'], ['graphyard', 'master', 'dispatch', 'GY-74', 'profile'], ['graphyard', 'evidence', 'GY-74'], ['graphyard', 'claim', 'GY-74'], ['graphyard', 'complete', 'GY-74', '3', '1'], ['graphyard', 'heartbeat', 'GY-74'], ['git', 'push', 'origin', 'main'], ['npm', 'install'], ['rm', '-rf', 'src']]) {
    const verdict = doctorSegmentAllowed(words(...segments));
    assert.equal(verdict.allow, false, `${segments.join(' ')} is outside the allowlist`);
    if (!verdict.allow) assert.match(verdict.reason, /was not run|Record the refused command/, `${segments.join(' ')} is refused as recorded, not run`);
  }
  // Reads run: the status commands, and the read-only programs.
  for (const segments of [['graphyard', 'status', 'GY-74'], ['graphyard', 'master', 'status'], ['graphyard', 'master', 'decisions', 'GY-74'], ['git', 'log', '-5'], ['gh', 'pr', 'view', '12'], ['cat', 'README.md']]) {
    assert.deepEqual(doctorSegmentAllowed(words(...segments)), { allow: true }, `${segments.join(' ')} is read-only`);
  }
  // The doctor session launched through the headless runner gets exactly the doctor tool.
  assert.deepEqual(piTools('doctor').map(tool => tool.name), [doctorTool]);

  // The shipped template names every check bound, the sanctioned commands and the unactionable rule.
  const prompt = doctorPrompt({ repository: master.repository, cliPath: `node ${master.cliPath}` }, { items: [], faults: [] });
  for (const [bound, minutes] of Object.entries(doctorBounds)) assert.ok(prompt.includes(`${minutes} min`), `the template names the ${bound} bound (${minutes} min)`);
  assert.ok(prompt.includes('lapsed containment') && prompt.includes('refusal') && prompt.includes('overdue'), 'the template names the non-minute checks: lapsed containment, stale refusal text, overdue items');
  for (const command of doctorSanctionedCommands) assert.ok(prompt.includes(`master ${command}`), `the template names the sanctioned command master ${command}`);
  for (const never of ['never merge', 'dispatch', 'evidence', 'lease']) assert.ok(prompt.includes(never), `the template refuses ${never}`);
  assert.ok(prompt.includes('human-only'), 'the template names the human-only decisions a finding cannot act on');
});

test('unit:doctor-run-recorded — a doctor run records one event per item it found or acted on, one run summary on the cursor and the control plane, and files a fault item only when no open item already covers its class', async () => {
  clearDoctorRuns();
  const work = [item(), item({ id: 'id-GY-75', key: 'GY-75' })];
  const filed: { title: string; priority: number }[] = [];
  const posted: { at: string; findings: unknown[] }[] = [];
  const report = {
    findings: [
      { subject: 'GY-74', check: 'blocked' as const, detail: 'blocked 14 min on a scope refusal', unactionable: false },
      { subject: 'installation', check: 'overdue' as const, detail: 'every human-only park', unactionable: true },
    ],
    actions: [{ subject: 'GY-75', command: 'graphyard master unblock GY-75 because scope is granted', outcome: 'applied' as const, detail: 'blocker cleared' }],
    filed: [
      { faultClass: 'decision' as const, title: 'Decision faults recur', description: 'evidence', priority: 1, criteria: [{ id: 'AC-1', text: 'Fixed', proofs: ['unit:x'] }], plannedFiles: ['src/x.ts'] },
      { faultClass: 'containment' as const, title: 'Lapsed fences pile up', description: 'evidence', priority: 0, criteria: [{ id: 'AC-1', text: 'Fixed', proofs: ['unit:y'] }], plannedFiles: ['src/y.ts'] },
    ],
  };
  // 'decision' has an open item standing for it (filed through the same origin), so it is deduplicated.
  work.push(item({ id: 'id-GY-90', key: 'GY-90', stage: 'ready', origin: { faultClass: { class: 'decision', threshold: 1, windowHours: 1, count: 1, detectedAt: observedAt, instances: [] } } }));
  const doctor: DoctorEffects = {
    settings: doctorSettingsSchema.parse({}) as DoctorEffects['settings'], cwd: '/tmp', env: {},
    runner: () => Promise.resolve({ runtime: 'pi', model: 'test/model', release: async () => {}, runner: {
      name: 'pi', start: (_prompt: string, options: { tool: string }) => ({
        id: 'run', events: [], onEvent: () => () => {}, cancel: () => {},
        result: async () => ({ ok: true as const, tool: options.tool, payload: report, payloads: [report] }),
      }) } as unknown as Runner }),
    file: async input => { filed.push({ title: input.title, priority: input.priority }); return item({ id: 'id-GY-91', key: 'GY-91', title: input.title }); },
    recordRun: async run => { posted[0] = { at: run.at, findings: run.findings }; },
  };
  const first = cycle(work, { doctor });
  await doctorStep(first);
  assert.equal(first.state.doctor.runs.length, 1, 'the run was scheduled at once from an empty cursor');
  await doctorRunsSettled();
  const run = first.state.doctor.runs[0];
  assert.equal(run.state, 'reported');
  assert.deepEqual([run.findings.length, run.actions.length], [2, 1]);
  assert.deepEqual(posted.length && [posted[0].at, posted[0].findings.length], [run.at, 2], 'the run summary was posted to the control plane');
  // One event per item the run found or acted on, plus one summary event.
  const events = Object.values(first.state.actions).filter(action => action.kind === 'fault');
  assert.deepEqual(events.filter(action => action.work).map(action => action.work).sort(), ['GY-74', 'GY-75'], 'one event per item with a finding or an action');
  assert.ok(events.some(action => action.work === null && /2 finding\(s\), 1 action\(s\)/.test(action.detail)), 'one run summary event names what was stuck, what it did and what it filed');
  // Dedup: the covered class is not filed; the uncovered one is filed through master create's checks.
  assert.deepEqual(filed, [{ title: 'Lapsed fences pile up', priority: 0 }], 'only the fault class with no open item is filed, at P0/P1');
  assert.deepEqual(run.filed.map(entry => entry.work), ['GY-91']);
  assert.ok(events.some(action => /already covered by an open item/.test(action.detail)), 'the deduplicated filing is recorded, not silently dropped');

  // The next run is due one interval later, not on the next cycle.
  const second = cycle(work, { doctor, state: first.state });
  await doctorStep(second);
  assert.equal(second.state.doctor.runs.length, 1, 'the doctor does not run again inside its interval');
  clearDoctorRuns();
});

test('unit:loop-applies-routine-remedies — the loop settles a lapsed containment whose attempt submitted, requests the unblock decision for a blocker whose named scope plannedFiles already covers, and relaunches an approver for a decision unanswered past ten minutes', async () => {
  // Remedy 1: a lapsed fence on a submitted attempt settles without the supervisor probe.
  const settled: string[] = [];
  const submitted = item({ submission: { epoch: 1, pr: 12 },
    containmentQuarantine: { owner: 'worker-a', epoch: 1, at: at(-3_600_000), settlementHash: 'a'.repeat(64), leaseExpiresAt: at(-600_000) } });
  const unsubmitted = item({ id: 'id-GY-76', key: 'GY-76',
    containmentQuarantine: { owner: 'worker-a', epoch: 1, at: at(-3_600_000), settlementHash: 'b'.repeat(64), leaseExpiresAt: at(-600_000) } });
  const remedied = cycle([submitted, unsubmitted], { effects: { settleContainment: async (target, assessment) => {
    settled.push(target.key);
    assert.equal(assessment.settleable, true);
  } } });
  await settleSubmittedContainment(remedied);
  assert.deepEqual(settled, ['GY-74'], 'only the fence whose attempt submitted is settled');
  assert.ok(Object.values(remedied.state.actions).some(action => action.kind === 'settle' && action.state === 'done' && action.work === 'GY-74'));

  // Remedy 2: a scope-refusal blocker whose paths a widening already planned is asked unblocked.
  const decided: { key: string; action: string }[] = [];
  const covered = item({ id: 'id-GY-77', key: 'GY-77', blocker: 'Scope request refused: GY-77 needs src/item.ts/extra and tests/extra outside plannedFiles', plannedFiles: ['src/item.ts', 'src/item.ts/extra', 'tests/extra'] });
  const stillUnplanned = item({ id: 'id-GY-78', key: 'GY-78', blocker: 'Scope request refused: GY-78 needs src/other.ts outside plannedFiles', plannedFiles: [] });
  const unblocked = cycle([covered, stillUnplanned], { effects: { decide: async (target, action) => { decided.push({ key: target.key, action }); return { id: `d-${target.key}` }; } } });
  await clearCoveredBlockers(unblocked);
  assert.deepEqual(decided, [{ key: 'GY-77', action: 'unblock' }], 'only the blocker whose every named path is planned is unblocked');

  // Remedy 3: a requested decision unanswered past ten minutes with no live approver gets one.
  const launched: string[] = [];
  const asked = at(-unansweredDecisionMs - 60_000), fresh = at(-60_000);
  const waiting = item({ id: 'id-GY-79', key: 'GY-79', stage: 'review', candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 9, branch: 'x', author: 'w' } });
  const approverCycle = cycle([waiting], {
    agents: [],
    effects: {
      decisions: async () => ({ decisions: [
        { id: 'd-old', action: 'unblock', state: 'requested', input: null, approvedBy: null, requestedAt: asked },
        { id: 'd-fresh', action: 'merge', state: 'requested', input: null, approvedBy: null, requestedAt: fresh },
      ] }),
      approver: async (_target, decision) => { launched.push(decision); return { agentName: 'approver-1', pane: null }; },
    },
  });
  await relaunchUnansweredApprovers(approverCycle);
  assert.deepEqual(launched, ['d-old'], 'the decision unanswered past ten minutes is relaunched; the fresh one is not');

  // A live approver session for the same decision is adopted, not doubled.
  const adopted = cycle([waiting], {
    agents: [liveAgent(approverSessionName(waiting, 'd-old'))],
    effects: {
      decisions: async () => ({ decisions: [{ id: 'd-old', action: 'unblock', state: 'requested', input: null, approvedBy: null, requestedAt: asked }] }),
      approver: async (_target, decision) => { launched.push(`again-${decision}`); return { agentName: 'approver-2', pane: null }; },
    },
  });
  await relaunchUnansweredApprovers(adopted);
  assert.deepEqual(launched, ['d-old'], 'a decision whose approver session is still live is left alone');
});
