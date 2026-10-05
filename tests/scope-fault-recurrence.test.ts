import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { liveScopeWidening } from '../src/model/scope.js';
import { successorWidening } from '../src/model/successors.js';
import { scopeRefusalFault, transientScopeRefusal } from '../src/daemon/cycle-scope.js';
import type { Work } from '../src/model.js';

// GY-1293: three scope faults in one day. Two were the loop's own additive scope revisions refused
// for reasons that judged nothing about scope: GY-1235's successor re-plan was posted from the
// snapshot the same cycle's partial widening had just outdated (409), and GY-1290's widening met a
// control-plane internal error the next cycle did not (500). The partial widening that outdated
// GY-1235's snapshot also kept its request from the approver, one companion hop per cycle, for 14
// minutes. Each test reproduces one instance as the ledger recorded it.

const clock = Date.parse('2030-01-03T12:00:00Z');
const iso = (offset = 0) => new Date(clock + offset).toISOString();
const config = () => masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: join(tmpdir(), 'scope-fault-recurrence.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository: 'owner/scope-faults', baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-scope-faults', workers: [] }) as MasterConfig;

const lease = { epoch: 3, owner: 'worker', expiresAt: iso(600_000) };
const asked = iso(-300_000);
const refusedRequest = (paths: string[]) => ({ epoch: 3, paths, reason: 'The delivery change reaches these files', requestedBy: 'worker', at: asked,
  decision: { state: 'refused', reason: 'outside what the criteria imply', at: iso(-200_000), decidedBy: 'graphyard', waitedMs: 100_000, paths, requestedBy: 'worker', requestedAt: asked, epoch: 3 } });

function item(extra: Partial<Work> = {}): Work {
  return {
    id: '00000000-0000-4000-8000-000000001235', key: 'GY-1235', title: 'Remove the guarded merge', description: '', type: 'chore', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'GitHub merges are delivery', proofs: ['unit:github-merge-is-delivery'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/master/merge.ts', 'src/engine.ts'], stage: 'build', revision: 10, policyRevision: 2, createdAt: iso(-86_400_000), updatedAt: iso(-60_000),
    stageEnteredAt: iso(-3_600_000), ready: true, epoch: 3, lease, workspaces: [], submission: null, candidate: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], exclusiveResources: [], producerProofs: [],
    containmentQuarantine: { epoch: 3, owner: 'worker', at: iso(-3_600_000), settlementHash: 'e'.repeat(64), leaseExpiresAt: lease.expiresAt },
    ...extra,
  } as unknown as Work;
}

/**
 * The control plane's requirements command as far as these instances need it: a revision of the
 * current policy revision that only widens is applied under the live lease and quarantine; a stale
 * one is refused. `fail` answers the next posts with an error instead, as the plane did for GY-1290.
 */
function plane(initial: Work) {
  let current = structuredClone(initial);
  const posted: { via: string; expectedPolicyRevision: number; plannedFiles: string[] }[] = [];
  const fail: Error[] = [];
  const requirements = (via: string, revision: { expectedPolicyRevision: number; criteria: unknown[]; dependencies: readonly string[]; plannedFiles: readonly string[]; exclusiveResources?: readonly string[]; producerProofs?: readonly string[] }) => {
    posted.push({ via, expectedPolicyRevision: revision.expectedPolicyRevision, plannedFiles: [...revision.plannedFiles] });
    if (fail.length) throw fail.shift();
    if (revision.expectedPolicyRevision !== current.policyRevision) throw new Error(`Graphyard refused work/${current.id}/requirements (409): Policy revision changed; reload before revising`);
    if (!liveScopeWidening({ criteria: current.criteria, dependencies: current.dependencies, plannedFiles: current.plannedFiles ?? [], exclusiveResources: current.exclusiveResources, producerProofs: current.producerProofs }, revision as never))
      throw new Error(`Graphyard refused work/${current.id}/requirements (409): Task is quarantined by unverified containment from epoch 3; requirements remain immutable until settlement or stopped-worker recovery`);
    current = { ...current, plannedFiles: [...revision.plannedFiles], policyRevision: current.policyRevision + 1, revision: current.revision + 1 };
    return structuredClone(current);
  };
  return { posted, fail, read: () => structuredClone(current), requirements };
}

function effects(control: ReturnType<typeof plane>, overrides: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => [], credentials: async () => ({}),
    snapshot: async () => ({ work: [control.read()], now: iso() }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'no deployment in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    reviewFindings: async () => [],
    // Every requested path exists on the base; nothing reads their text, so only the rules decide.
    basePaths: async paths => new Set(paths),
    // The base renamed a planned file since the item was planned: src/master/merge.ts → src/merge/execute.ts.
    baseSuccessions: async () => ({ tip: 'f'.repeat(40), successions: [{ from: 'src/master/merge.ts', to: 'src/merge/execute.ts', commit: 'c'.repeat(40), similarity: 90 }], files: new Set(['src/merge/execute.ts']) }),
    widenScope: async (work, request, paths, reason) => control.requirements('widen', { expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies,
      plannedFiles: [...new Set([...(work.plannedFiles ?? []), ...paths])], exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], answers: { epoch: request.epoch, at: request.at }, reason } as never),
    replan: async (work, paths, reason) => control.requirements('replan', successorWidening(work, paths, reason)),
    ...overrides,
  } as DaemonEffects;
}

const scopeFaults = (state: DaemonState) => state.faults.instances.filter(instance => instance.kind === 'action:scope');
const cycle = (state: DaemonState, effect: DaemonEffects, at = clock) => runCycle(config(), state, effect, () => at);

test('manual:fault-class-scope — GY-1235: a successor re-plan in the cycle a partial widening moved the item reads the widened item, and is applied rather than refused', async () => {
  // The worker asked for a documentation page (which the item implies) and a file nothing grounds:
  // the finding rule widens by the page and leaves the file to the approver, moving the revision.
  const control = plane(item({ scopeRequest: refusedRequest(['docs/delivery.md', 'src/unrelated.ts']) } as Partial<Work>));
  const state = emptyDaemonState(config());
  await cycle(state, effects(control));

  const [widen, replan] = control.posted;
  assert.equal(widen?.via, 'widen');
  assert.ok(widen.plannedFiles.includes('docs/delivery.md') && !widen.plannedFiles.includes('src/unrelated.ts'), 'the partial widening grants only what the rules ground');
  assert.equal(replan?.via, 'replan', 'the successor step re-plans the item in the same cycle');
  // On the base the re-plan was posted from the snapshot: revision 2, without the page, and refused.
  assert.equal(replan.expectedPolicyRevision, 3, 'it is posted against the revision the widening made, not the snapshot\'s');
  assert.ok(replan.plannedFiles.includes('docs/delivery.md'), 'and keeps what the widening granted');
  assert.deepEqual(control.read().plannedFiles, ['src/master/merge.ts', 'src/engine.ts', 'docs/delivery.md', 'src/merge/execute.ts'], 'both revisions are applied');
  assert.ok(Object.values(state.actions).some(action => action.work === 'GY-1235' && action.state === 'done' && /^Re-planned GY-1235 with 1 file \(src\/merge\/execute\.ts\)/.test(action.detail)));
  assert.deepEqual(scopeFaults(state), [], 'no scope fault is noted');
});

test('manual:fault-class-scope — GY-1235: the rest of a partly widened request goes to the approver in the same cycle, and the findings are not read again while the approver judges it', async () => {
  const control = plane(item({ scopeRequest: refusedRequest(['docs/delivery.md', 'src/unrelated.ts']) } as Partial<Work>));
  const decided: { key: string; plannedFiles: string[]; expectedPolicyRevision?: number }[] = [];
  const effect = effects(control, {
    baseSuccessions: undefined, replan: undefined,
    decide: async (work, action, _reason, input = {}) => { decided.push({ key: work.key, plannedFiles: (input as { plannedFiles: string[] }).plannedFiles, expectedPolicyRevision: work.policyRevision }); assert.equal(action, 'requirements'); return { id: `decision-${decided.length}` }; },
    approver: async (work, decision) => ({ agentName: `approver-${work.key}-${decision}`, pane: 'pane-1' }),
    decisions: async () => ({ decisions: [] }),
  } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  await cycle(state, effect);
  // On the base the decision step read no judgement for the widened revision and asked no approver;
  // the next cycle read the findings again at that revision, so the approver waited cycle after cycle.
  assert.equal(control.posted.length, 1, 'one partial widening');
  assert.deepEqual(decided.map(entry => entry.key), ['GY-1235'], 'the approver is asked about the rest in the cycle that widened');
  assert.ok(decided[0].plannedFiles.includes('docs/delivery.md') && decided[0].plannedFiles.includes('src/unrelated.ts'), 'against the widened plannedFiles');
  assert.equal(decided[0].expectedPolicyRevision, 3);

  await cycle(state, effect, clock + 600_000);
  assert.equal(control.posted.length, 1, 'while the approver judges the rest, the findings are not read again and the revision does not move');
});

test('manual:fault-class-scope — GY-1290: a widening the control plane answers with an internal error is retried next cycle and noted as no scope fault; a second in a row is one', async () => {
  const control = plane(item({ key: 'GY-1290', scopeRequest: refusedRequest(['docs/delivery.md']) } as Partial<Work>));
  control.fail.push(new Error(`Graphyard refused work/${control.read().id}/requirements (500): Internal error; consult server logs`));
  const state = emptyDaemonState(config());
  const effect = effects(control, { baseSuccessions: undefined, replan: undefined, reviewFindings: async () => [], baseText: async () => null });
  await cycle(state, effect);
  const failed = Object.values(state.actions).find(action => action.work === 'GY-1290' && action.state === 'failed');
  assert.match(failed?.detail ?? '', /the control plane answered 5xx, so it is retried next cycle on a fresh read/);
  // On the base this failure opened an action:scope instance at once.
  assert.deepEqual(scopeFaults(state), [], 'one transient refusal is no scope fault');
  await cycle(state, effect, clock + 60_000);
  assert.deepEqual(control.read().plannedFiles, ['src/master/merge.ts', 'src/engine.ts', 'docs/delivery.md'], 'the next cycle widens it');
  assert.deepEqual(scopeFaults(state), []);

  // The plane failing the retry too is a fault the loop cannot clear on its own: it is counted.
  const again = plane(item({ key: 'GY-1290', scopeRequest: refusedRequest(['docs/delivery.md']) } as Partial<Work>));
  for (let n = 0; n < 2; n++) again.fail.push(new Error(`Graphyard refused work/${again.read().id}/requirements (500): Internal error; consult server logs`));
  const twice = emptyDaemonState(config());
  const failing = effects(again, { baseSuccessions: undefined, replan: undefined });
  await cycle(twice, failing);
  await cycle(twice, failing, clock + 60_000);
  assert.deepEqual(scopeFaults(twice).map(instance => [instance.kind, instance.subject]), [['action:scope', 'GY-1290']]);
});

test('unit:transient-scope-refusal — only a 5xx or a stale revision is transient; a refusal that judged the scope always counts', () => {
  assert.equal(transientScopeRefusal(new Error('Graphyard refused work/x/requirements (500): Internal error; consult server logs')), 'the control plane answered 5xx');
  assert.equal(transientScopeRefusal(new Error('Graphyard refused work/x/requirements (502): Application failed to respond')), 'the control plane answered 5xx');
  assert.equal(transientScopeRefusal(new Error('Graphyard refused work/x/requirements (409): Policy revision changed; reload before revising')), 'the item moved past the revision the loop read');
  assert.equal(transientScopeRefusal(new Error('Graphyard refused work/x/requirements (409): Task is quarantined by unverified containment from epoch 3; requirements remain immutable until settlement or stopped-worker recovery')), null);
  assert.equal(transientScopeRefusal(new Error('Graphyard refused work/x/requirements (409): Operator agents cannot remove planned-file containment')), null);
  assert.equal(scopeRefusalFault('the control plane answered 5xx', undefined), null);
  assert.equal(scopeRefusalFault('the control plane answered 5xx', { state: 'failed', detail: 'Could not widen GY-1 (the control plane answered 5xx, so it is retried next cycle on a fresh read): …' }), undefined);
  assert.equal(scopeRefusalFault(null, undefined), undefined);
});
