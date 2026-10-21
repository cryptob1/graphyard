import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { recurringFaultAttention, faultRecurrenceReport } from '../src/daemon/faults.js';
import { faultClassPolicyDefaults, faultClassPolicyFromEnv, type FaultClass } from '../src/model/fault-classes.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';

// GY-2186 AC-1: a fault class whose instances in the policy window reach the policy threshold reads
// as exactly one master-status attention line naming the class, the count, the window and the latest
// instance; below the threshold it reads as none; and the faults step makes no work-item request for
// any class, whatever the count.

const clock = Date.parse('2030-01-01T12:00:00Z');
const minute = 60_000, hour = 3_600_000;
const iso = (offset: number) => new Date(clock + offset).toISOString();
const policy = faultClassPolicyDefaults;

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function stateWith(faultClass: FaultClass, count: number, latestOffset = 0): DaemonState {
  const state = emptyDaemonState(config());
  for (let index = count - 1; index >= 0; index--)
    state.faults.instances.push({ id: `blocker|GY-${index}|${iso(latestOffset - index * minute)}`, kind: 'blocker', faultClass, subject: `GY-${index}`,
      text: `GY-${index} waits on the merge of PR #77`, at: iso(latestOffset - index * minute), lastSeenAt: iso(latestOffset), linkedTo: null });
  return state;
}

test('unit:recurring-fault-attention-not-items — recurringFaultAttention returns exactly one line per class at or above the threshold, naming the class, the count, the window and the latest instance', () => {
  const state = stateWith('stalled-gate', policy.threshold);
  const lines = recurringFaultAttention(state, policy, clock);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  const line = lines[0]!;
  assert.equal(line.subject, 'fault:stalled-gate');
  assert.match(line.text, new RegExp(`^stalled-gate recurred ${policy.threshold} times in the last ${policy.windowHours} hours, latest at ${iso(0)}: GY-0 waits on the merge of PR #77$`));
  assert.equal(line.role, 'master');
  assert.match(line.next, /the loop files no item for a recurring class/);

  // Every class past the threshold gets its own line, largest first.
  const both = stateWith('stalled-gate', policy.threshold + 1);
  for (let index = 0; index < policy.threshold; index++)
    both.faults.instances.push({ id: `held-jobs|installation|${iso(-index * minute)}`, kind: 'held-jobs', faultClass: 'configuration', subject: 'installation',
      text: 'a shortfall', at: iso(-index * minute), lastSeenAt: iso(0), linkedTo: null });
  const lines2 = recurringFaultAttention(both, policy, clock);
  assert.deepEqual(lines2.map(line => line.subject), ['fault:stalled-gate', 'fault:configuration'], JSON.stringify(lines2.map(line => line.text)));
});

test('unit:recurring-fault-attention-not-items — a class below the threshold, or whose instances fall outside the window, reads as no line', () => {
  assert.deepEqual(recurringFaultAttention(stateWith('stalled-gate', policy.threshold - 1), policy, clock), [], 'below the threshold');
  assert.deepEqual(recurringFaultAttention(stateWith('stalled-gate', policy.threshold, -25 * hour - minute), policy, clock), [], 'outside the window');
  // The window is the policy's: a wider window counts the same instances.
  const wide = { ...policy, windowHours: policy.windowHours * 2 };
  assert.equal(recurringFaultAttention(stateWith('stalled-gate', policy.threshold, -25 * hour - minute), wide, clock).length, 1);
});

test('unit:recurring-fault-attention-not-items — the faults step makes no work-item request for any class, whatever the count, and the line rides master status', async () => {
  const posted: string[] = [];
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, persist: async () => {},
    faultClassPolicy: policy,
    // Any work-item write the step attempted would go through the operator-agent; record and refuse none silently.
    controlPlane: async () => { posted.push('status'); return { github: true }; },
    reportedAttention: async () => { posted.push('attention'); return { items: [] }; },
  } as unknown as DaemonEffects;
  const state = stateWith('stalled-gate', policy.threshold + 2);
  const master = config();
  await runCycle(master, state, effects, () => clock);
  assert.deepEqual(posted, ['status', 'attention'], 'the observation reads its sources and nothing else');
  // No filing rows: the loop's action history holds no fault filing, started or done.
  const filings = Object.entries(state.actions).filter(([key, action]) => action.kind === 'fault' && /filed|filing/i.test(action.detail));
  assert.deepEqual(filings, [], `no work item is filed for the class: ${JSON.stringify(filings)}`);
  // The recurrence is served as the attention line and the daemon report, computed from the record.
  assert.equal(recurringFaultAttention(state, policy, clock).length, 1);
  const report = faultRecurrenceReport(state, faultClassPolicyFromEnv(process.env), clock);
  assert.deepEqual(report.classes.find(entry => entry.faultClass === 'stalled-gate'), { faultClass: 'stalled-gate', instances: policy.threshold + 2, latest: iso(0) });
});
