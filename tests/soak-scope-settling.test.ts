import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import type { Work } from '../src/model.js';

/**
 * GY-1757. The scope class counts only what the loop is not itself settling. The loop runs here for
 * three simulated hours over four items with a live lease each: A's widening throws once on a timeout and D's once on a gh rate limit,
 * each applying on the next cycle; B's ask is refused by the approver
 * with a narrower re-request direction and the worker re-asks inside the bound; C's identical refusal
 * is never re-asked, so it stands once the 15-minute bound passes. After every cycle every system
 * invariant holds. At the end: A and B opened no scope instance, C opened exactly one (past the bound),
 * and A's widening was attempted once per cycle until it applied.
 */
const minute = 60_000, hour = 60 * minute, start = Date.parse('2030-01-03T12:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const rateLimit = () => new Error('Command failed: gh api repos/o/r/pulls/1/reviews\ngh: API rate limit exceeded for user ID 1.');

test('unit:soak-scope-settling — over three simulated hours transport failures and a live narrower re-request open no scope instance, and an unanswered refusal opens one past the bound', { timeout: 300_000 }, async () => {
  let now = start;
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: join(tmpdir(), 'soak-scope-settling.token'), cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 4242, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] }) as MasterConfig;
  const asked = iso(start - 5 * minute);
  const narrower = 'Refused as filed; re-request narrower. The ask names files the criteria do not need.';
  const ask = (paths: string[], decision: Record<string, unknown>) => ({ epoch: 1, at: asked, paths, reason: 'AC-1 reaches these files', requestedBy: 'worker', decision: { reason: 'x', at: iso(start - 4 * minute), waitedMs: 60_000, paths, requestedBy: 'worker', requestedAt: asked, epoch: 1, ...decision } });
  const planned: Record<string, string[]> = { 'GY-1701': ['src/a.ts'], 'GY-1702': ['src/b.ts'], 'GY-1703': ['src/c.ts'], 'GY-1704': ['src/d.ts'] };
  const requests: Record<string, any> = {
    'GY-1701': ask(['docs/a.md'], { state: 'refused', decidedBy: 'graphyard', reason: 'outside what the criteria imply' }),
    'GY-1704': ask(['docs/d.md'], { state: 'refused', decidedBy: 'graphyard', reason: 'outside what the criteria imply' }),
    'GY-1702': ask(['src/b2.ts', 'src/b3.ts'], { state: 'refused', decidedBy: 'graphyard-approver-graphyard', reason: narrower }),
    'GY-1703': ask(['src/c2.ts', 'src/c3.ts'], { state: 'refused', decidedBy: 'graphyard-approver-graphyard', reason: narrower }),
  };
  const widenCalls: string[] = [];
  const work = (key: string, number: number): Work => ({
    id: `work-${key}`, key, title: key, description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: [...planned[key]],
    criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true },
    stage: 'build', ready: true, epoch: 1, revision: 10 + number, policyRevision: 2, createdAt: iso(start - hour), updatedAt: iso(now), stageEnteredAt: iso(start - hour),
    lease: { owner: 'worker', epoch: 1, expiresAt: iso(now + 10 * minute) }, workspaces: [], submission: null, candidate: null, scenarioRequirements: [], blocker: null, violations: [],
    evidence: [], observation: null, exclusiveResources: [], producerProofs: [], scopeRequest: requests[key] ?? null,
    gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  } as unknown as Work);
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: Object.keys(planned).map((key, index) => work(key, index)), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
    persist: async () => {}, reviewFindings: async () => [], basePaths: async (paths: string[]) => new Set(paths), baseSuccessions: undefined, replan: undefined,
    widenScope: async (item: Work, request: { epoch: number; at: string }, paths: string[]) => {
      widenCalls.push(`${item.key}@${(now - start) / minute}`);
      const earlier = widenCalls.filter(call => call.startsWith(item.key)).length;
      if (item.key === 'GY-1701' && earlier === 1) throw timeout();
      if (item.key === 'GY-1704' && earlier === 1) throw rateLimit();
      planned[item.key] = [...planned[item.key], ...paths]; requests[item.key] = null;
      return { ...work(item.key, 0), plannedFiles: planned[item.key] };
    },
  } as unknown as DaemonEffects;

  const state: DaemonState = emptyDaemonState(config);
  const violations: string[] = [], scopeInstances = new Map<string, string[]>();
  for (let step = 0; now < start + 3 * hour; step++, now += 2 * minute) {
    // B's worker re-asks narrower four minutes in, and the approver's route accepts it: the ask is gone.
    if (now === start + 4 * minute) requests['GY-1702'] = null;
    await runCycle(config, state, effects, () => now);
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`cycle ${step}: ${check.line}`);
    for (const instance of state.faults.instances.filter(entry => entry.kind === 'action:scope' || (entry.kind === 'scope-request' && ['GY-1702', 'GY-1703'].includes(entry.subject)))) {
      const seen = scopeInstances.get(instance.subject) ?? [];
      if (!seen.includes(instance.id)) scopeInstances.set(instance.subject, [...seen, instance.id]);
    }
    // C's lease is renewed by its worker's heartbeats; before the bound nothing stands for it.
    if (now - start < 10 * minute) assert.equal(scopeInstances.get('GY-1703')?.length ?? 0, 0, `cycle ${step}: C stands only past the bound`);
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.equal(scopeInstances.get('GY-1701')?.length ?? 0, 0, 'A: a timeout, then applied, opened no instance');
  assert.equal(scopeInstances.get('GY-1702')?.length ?? 0, 0, 'B: a narrower re-request inside the bound opened no instance');
  assert.equal(scopeInstances.get('GY-1703')?.length ?? 0, 1, 'C: the unanswered refusal stood once past the bound, as one instance');
  assert.equal(scopeInstances.get('GY-1704')?.length ?? 0, 0, 'D: a gh rate limit, then applied, opened no instance');
  assert.deepEqual(planned['GY-1704'], ['src/d.ts', 'docs/d.md']);
  assert.deepEqual(planned['GY-1701'], ['src/a.ts', 'docs/a.md'], 'A applied on the second try');
  assert.deepEqual(widenCalls.filter(call => call.startsWith('GY-1701')).length, 2, 'A was tried once per cycle until it applied');
});
