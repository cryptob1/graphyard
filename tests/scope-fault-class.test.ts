import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { recurringClasses, scopeRequestState, trackFaults, workFaults, type FaultInstance } from '../src/model/fault-classes.js';
import { scopeBlockedBudgetMs, scopeRefusalBlocker } from '../src/model/scope.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { scopeRequestAttention } from '../src/cli/owed-report.js';

// GY-543: four scope faults in 24 hours, each a worker asking for a file its plan did not name and
// each answered well inside the GY-85 bound — GY-402 refused by the rule in 31s, GY-415, GY-426 and
// GY-486 granted by the approver in 101s, 82s and 88s. Three of the four were loop-filed fault-class
// items, which plan no files at all, so every attempt on one has to ask. The base counted a scope
// request as a fault the moment it stood on a live lease, so the ordinary path of deciding it fed the
// scope class and filed this item. The candidate counts a request only once it outlasts the bound.
// The test is named for the proof it produces: manual:fault-class-scope.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const minute = 60_000;
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

/** Each instance as the item record showed it: the request, the worker's live lease and when the loop observed it. */
const instances = [
  { key: 'GY-402', owner: 'graphyard-cursor-2', epoch: 7, requestedAt: '2026-09-26T07:39:32.035Z', observedAt: '2026-09-26T07:39:59.301Z', decidedAt: '2026-09-26T07:40:02.694Z', state: 'refused' as const,
    plannedFiles: ['src/review-threads.ts', 'src/daemon/', 'docs/master-agent.md'], criteria: [{ id: 'AC-1', text: 'Review follow-ups are one item per parent', proofs: ['unit:x'] }],
    paths: ['tests/auto-dispatch.test.ts'] },
  { key: 'GY-415', owner: 'graphyard-cursor-1', epoch: 1, requestedAt: '2026-09-26T07:46:42.039Z', observedAt: '2026-09-26T07:47:30.142Z', decidedAt: '2026-09-26T07:48:22.581Z', state: 'approved' as const,
    plannedFiles: [], criteria: [{ id: 'AC-1', text: 'The shared cause of the recurring unclassified faults is found and removed at the candidate', proofs: ['manual:fault-class-unclassified'] }],
    paths: ['src/producer.ts', 'src/executor.ts', 'src/auto-dispatch.ts', 'docs/master-agent.md', 'tests/producer-already-pending.test.ts'] },
  { key: 'GY-426', owner: 'graphyard-claude-1', epoch: 1, requestedAt: '2026-09-26T07:54:01.977Z', observedAt: '2026-09-26T07:54:41.039Z', decidedAt: '2026-09-26T07:55:23.550Z', state: 'approved' as const,
    plannedFiles: [], criteria: [{ id: 'AC-1', text: 'The shared cause of the recurring loop faults is found and removed at the candidate', proofs: ['manual:fault-class-loop'] }],
    paths: ['src/daemon/metrics.ts', 'tests/loop-silence-owner.test.ts'] },
  { key: 'GY-486', owner: 'graphyard-cursor-2', epoch: 1, requestedAt: '2026-09-26T07:53:57.299Z', observedAt: '2026-09-26T07:54:41.039Z', decidedAt: '2026-09-26T07:55:25.284Z', state: 'approved' as const,
    plannedFiles: [], criteria: [{ id: 'AC-1', text: 'The shared cause of the recurring review-convergence faults is found and removed at the candidate', proofs: ['manual:fault-class-review-convergence'] }],
    paths: ['src/github.ts', 'src/model/work.ts', 'src/model/review-conflict.ts', 'src/model/fault-classes.ts', 'src/model/fault-wording.ts', 'tests/review-convergence-faults.test.ts', 'docs/master-agent-reference.md'] },
];
type Instance = typeof instances[number];

function asked(entry: Instance, requestedAt = entry.requestedAt, refused = false): Work {
  const at = Date.parse(requestedAt);
  return {
    id: `work-${entry.key}`, key: entry.key, title: entry.key, description: '', type: 'bug', priority: 1, dependencies: [], criteria: entry.criteria,
    policy: { checks: ['test'], review: true }, plannedFiles: entry.plannedFiles, stage: 'build', revision: 3, policyRevision: 1,
    createdAt: new Date(at - 30 * minute).toISOString(), updatedAt: requestedAt, stageEnteredAt: new Date(at - 10 * minute).toISOString(), ready: true, epoch: entry.epoch,
    lease: { owner: entry.owner, epoch: entry.epoch, expiresAt: new Date(at + 60 * minute).toISOString() }, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, gates: [], violations: [],
    blocker: refused ? `${scopeRefusalBlocker}: ${entry.paths.join(', ')} is outside what this item's own criteria imply` : null,
    documentation: { paths: ['docs/', 'AGENTS.md', 'README.md'], changelog: null },
    scopeRequest: { epoch: entry.epoch, paths: entry.paths, reason: 'the fix needs these files', requestedBy: entry.owner, at: requestedAt,
      decision: refused ? { state: 'refused', reason: 'outside the implied scope', at: new Date(at + 30_000).toISOString(), decidedBy: 'graphyard', waitedMs: 30_000, paths: entry.paths, requestedBy: entry.owner, requestedAt, epoch: entry.epoch } : null },
  } as unknown as Work;
}

/** One loop cycle's scope faults over the four items, as cycleFaults sees them with master status's scope-request lines. */
function scopeFaults(work: Work[], now: number) {
  const reported = scopeRequestAttention({ work, now: new Date(now).toISOString() });
  return cycleFaults(emptyDaemonState(config()), work, now, { config: config(), reported }).filter(fault => fault.faultClass === 'scope');
}

test('manual:fault-class-scope — each listed scope-request instance stood on a live lease inside the decision bound, and is no fault', () => {
  for (const entry of instances) {
    const now = Date.parse(entry.observedAt), work = asked(entry);
    // Against the base: a request on the attempt holding a live lease was a scope fault as soon as it was seen.
    assert.notEqual(scopeRequestState(work, now), 'moot', `${entry.key}: the base observed its request on a live lease`);
    assert.ok(Date.parse(entry.decidedAt) - Date.parse(entry.requestedAt) < scopeBlockedBudgetMs, `${entry.key} was decided inside the bound`);
    // Against the candidate: the request is being decided, so the item's record and master status's line add nothing.
    assert.equal(scopeRequestState(work, now), 'deciding');
    assert.deepEqual(workFaults(work, now).map(fault => fault.kind), [], `${entry.key}: no scope fault while it is decided`);
    assert.deepEqual(scopeFaults([work], now), [], `${entry.key}: nor does a derived line count it`);
  }
  // GY-402's rule refusal, seen before the approver or the worker answered it: its blocker restates the request, which is still being decided.
  const refused = asked(instances[0], instances[0].requestedAt, true), after = Date.parse(instances[0].decidedAt) + minute;
  assert.equal(scopeRequestAttention({ work: [refused], now: new Date(after).toISOString() }).length, 1, 'master status names the rule refusal');
  assert.deepEqual(workFaults(refused, after), []);
  assert.deepEqual(scopeFaults([refused], after), [], 'the refusal line is not a second way to count it');

  // The loop's record, cycling every 30 seconds over the same window with each request open until it was decided, opens no scope instance, so the class files nothing.
  const record = { instances: [] as FaultInstance[], open: {} as Record<string, string>, failing: {} as Record<string, string> };
  for (let now = Date.parse('2026-09-26T07:39:00Z'); now <= Date.parse('2026-09-26T07:56:00Z'); now += 30_000) {
    const open = instances.filter(entry => Date.parse(entry.requestedAt) <= now && now < Date.parse(entry.decidedAt)).map(entry => asked(entry));
    trackFaults(record, scopeFaults(open, now), new Date(now).toISOString());
  }
  assert.deepEqual(record.instances, []);
  assert.deepEqual(recurringClasses(record.instances, [], { threshold: 3, windowHours: 24 }, Date.parse('2026-09-26T08:00:00Z')), []);
});

test('manual:fault-class-scope — a request still standing past the decision bound is the scope fault, and three of them file the class', () => {
  const late = (entry: Instance) => new Date(Date.parse(entry.observedAt) - scopeBlockedBudgetMs - minute).toISOString();
  const work = instances.map(entry => asked(entry, late(entry), entry.state === 'refused'));
  const now = Date.parse('2026-09-26T07:54:41.039Z');
  for (const item of work) assert.equal(scopeRequestState(item, Date.parse(instances.find(entry => entry.key === item.key)!.observedAt)), 'fault');
  const faults = scopeFaults(work, now);
  assert.deepEqual(faults.map(fault => [fault.subject, fault.kind]), instances.map(entry => [entry.key, 'scope-request']), 'one fault per stuck request, the refusal line not counted twice');
  const record = { instances: [] as FaultInstance[], open: {} as Record<string, string>, failing: {} as Record<string, string> };
  trackFaults(record, faults, new Date(now).toISOString());
  assert.deepEqual(recurringClasses(record.instances, [], { threshold: 3, windowHours: 24 }, now).filter(entry => entry.file).map(entry => entry.faultClass), ['scope']);
  // A request from an attempt whose lease lapsed stays moot however old it is.
  assert.equal(scopeRequestState({ ...work[1], lease: { ...work[1].lease!, expiresAt: new Date(now - 1).toISOString() } }, now), 'moot');
});
