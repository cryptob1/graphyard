import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { ChildProcessError } from '../src/child-runner.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import type { Work } from '../src/model.js';

/**
 * GY-1756 (review). The loop's widening on a review finding reads GitHub each cycle for each open
 * item whose ask the rule refused. A rate limit or the runner's timeout on that read says nothing
 * about the item's scope, yet GY-1746 and GY-1748 were each filed as action:scope. The loop runs
 * here for one simulated day over four items whose findings read fails differently: the runner's
 * timeout once, a rate limit once, a rate limit then a timeout back to back (the second consecutive
 * failure is a scope fault by design, GY-1293), and one that never fails. Every read recovers
 * afterwards. After every cycle every system invariant holds. At the end: every item widened on its
 * finding exactly once, never per cycle; the only scope fault is the back-to-back item's second
 * failure; and nothing more asked once all were widened.
 */
const minute = 60_000, hour = 60 * minute, start = Date.parse('2026-10-12T00:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const timeout = () => new ChildProcessError('gh', ['api', '--paginate', 'repos/owner/project/pulls/1/reviews'], { stdout: '', stderr: '', status: null, signal: 'SIGTERM', timedOut: true, timeoutMs: 90_000 });
const limited = () => new Error('Command failed: gh api --paginate repos/owner/project/pulls/1/reviews\ngh: API rate limit exceeded for user ID 1.');

test('unit:soak-github-read-failures — over a simulated day GitHub read failures in the finding widening are retried on a fresh read and file no scope fault on one occurrence, with every invariant holding and each item widened once', { timeout: 300_000 }, async () => {
  let now = start;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], producers: [], run: { intervalSeconds: 600 } }) as MasterConfig;
  const plans: Record<string, (() => Error)[]> = { 'GY-1800': [timeout], 'GY-1801': [limited], 'GY-1802': [limited, timeout], 'GY-1803': [] };
  const keys = Object.keys(plans), planned = new Map(keys.map(key => [key, ['src/daemon/cycle-scope.ts']])), widened: string[] = [], reads = new Map<string, number>();
  const request = (key: string) => ({ epoch: 1, at: iso(start - 10 * minute), paths: ['src/daemon/cycle-dispatch.ts'], reason: 'the change needs it', requestedBy: 'worker',
    decision: { state: 'refused' as const, reason: 'No rule implies it', at: iso(start - 9 * minute), decidedBy: 'graphyard', paths: ['src/daemon/cycle-dispatch.ts'], requestedBy: 'worker', requestedAt: iso(start - 10 * minute), epoch: 1 } });
  const view = (key: string, number: number): Work => {
    const done = widened.includes(key);
    return { id: `work-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], plannedFiles: [...planned.get(key)!],
      criteria: [{ id: 'AC-1', text: 'The behaviour changes as described', proofs: ['unit:behaviour-changes'] }], policy: { checks: ['test'], review: true },
      stage: 'build', ready: true, epoch: 1, revision: 10 + number, policyRevision: 2 + (done ? 1 : 0), createdAt: iso(start - hour), updatedAt: iso(now), stageEnteredAt: iso(start - hour),
      lease: { owner: 'worker', epoch: 1, expiresAt: iso(now + 10 * minute) }, workspaces: [], submission: null, candidate: null, scenarioRequirements: [], blocker: null, violations: [], evidence: [], observation: null,
      scopeRequest: done ? null : request(key), scopeDecision: null, gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] } as unknown as Work;
  };
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: keys.map(view), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    reviewFindings: async (item: Work) => {
      const count = reads.get(item.key) ?? 0; reads.set(item.key, count + 1);
      const failure = plans[item.key][count]; if (failure) throw failure();
      return [{ ground: 'review thread PRRT_soak', text: 'src/daemon/cycle-dispatch.ts:40 still dispatches the stale item' }];
    },
    basePaths: async (paths: string[]) => new Set(paths),
    widenScope: async (item: Work, _request: unknown, paths: string[]) => {
      assert.ok(!widened.includes(item.key), `${item.key} was widened twice`);
      widened.push(item.key); planned.set(item.key, [...planned.get(item.key)!, ...paths]); return view(item.key, 0);
    },
    persist: async () => {},
  } as unknown as DaemonEffects;

  const state: DaemonState = emptyDaemonState(config), violations: string[] = [], faultsAt: string[] = [];
  for (let cycle = 0; now < start + 24 * hour; cycle++, now += 2 * minute) {
    await runCycle(config, state, effects, () => now);
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`cycle ${cycle}: ${check.line}`);
    for (const instance of state.faults.instances.filter(entry => entry.kind === 'action:scope')) if (!faultsAt.includes(instance.subject)) faultsAt.push(instance.subject);
  }
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual([...widened].sort(), keys, 'every item was widened on its finding once its read recovered');
  assert.deepEqual(faultsAt, ['GY-1802'], 'only the back-to-back failure is a scope fault; one occurrence never is');
  assert.deepEqual(keys.map(key => reads.get(key)), [2, 2, 3, 1], 'each failed read was retried once on a fresh read, never per cycle');
});
