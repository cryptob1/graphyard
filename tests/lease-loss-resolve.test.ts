import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonEffects, emptyDaemonState, idleLeaseLoss, routineDecision, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { settleableLeaseLoss, type Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-161, 2026-09-24: the first worker (epoch 1) exited five minutes in, its lease lapsed and the
// control plane raised a lease-loss; the loop dispatched epoch 2, but nothing settled the standing
// escalation, so the merge gate would refuse until a master session asked for the resolution.
// GY-1390, 2026-10-07: the loop's two-party resolve for every superseded lease-loss was 227 of the
// 298 build-stage escalation interventions in a week. Reconciliation now settles a superseded one,
// and the loop asks only for a lost epoch between attempts that no dispatch is due to take.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const lost = { at: iso(-10 * 60_000), actor: 'graphyard', trigger: 'lease-loss', reason: 'Worker graphyard-claude-2 lost lease epoch 1' };

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-161', key: 'GY-161', title: 'Dashboard', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['web/'], stage: 'build', revision: 51, policyRevision: 3,
    createdAt: iso(-60 * 60_000), updatedAt: iso(0), stageEnteredAt: iso(-5 * 60_000), ready: true, epoch: 2,
    lease: { owner: 'graphyard-opencode-1', epoch: 2, expiresAt: iso(5 * 60_000) }, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
    containmentQuarantine: { owner: 'graphyard-opencode-1', epoch: 2, at: iso(-5 * 60_000), settlementHash: 'a'.repeat(64) },
    escalation: lost, escalations: [lost], ...overrides,
  } as unknown as Work;
}
const decide = (work: Work) => routineDecision(work, { autoMerge: true }, clock);

test('unit:lease-loss-resolve-routine — a control-plane lease-loss a newer attempt superseded is settled by reconciliation, never asked of an approver', () => {
  // Epoch 2 holds the lease and its own fence: the control plane settles epoch 1's loss, the loop asks nothing.
  assert.equal(decide(item()), null);
  assert.equal(idleLeaseLoss(item()), null);
  const [settled] = settleableLeaseLoss(item());
  assert.equal(settled?.cause, 'superseded');
  assert.equal(settled?.epoch, 1);
  assert.match(settled!.note, /^auto-settled: superseded — epoch 2 is held by graphyard-opencode-1, so nothing from epoch 1 can act or merge$/);

  // The lost epoch's own fence still stands: it has not been shown stopped, so nothing settles it.
  const fenced = item({ containmentQuarantine: { owner: 'graphyard-claude-2', epoch: 1, at: iso(-9 * 60_000), settlementHash: 'b'.repeat(64) } } as Partial<Work>);
  assert.deepEqual(settleableLeaseLoss(fenced), []);
  assert.equal(decide(fenced), null);
  // Its own epoch still holds the lease: the lease-loss is not the current attempt's to settle.
  const held = item({ epoch: 1, lease: { owner: 'graphyard-claude-2', epoch: 1, expiresAt: iso(60_000) }, containmentQuarantine: null } as Partial<Work>);
  assert.deepEqual(settleableLeaseLoss(held), []);
  assert.equal(decide(held), null);

  // Only the latest attempt's own submission shows supersession. Epoch 2 submitted, rework moved the
  // item to epoch 3, and epoch 3 lapsed unexplained: the epoch-2 submission vouches for nothing after it.
  const submission = { epoch: 2, pr: 157, sha: 'c'.repeat(40) };
  assert.deepEqual(settleableLeaseLoss(item({ epoch: 3, lease: null, containmentQuarantine: null, submission } as Partial<Work>)), []);
  assert.match(settleableLeaseLoss(item({ epoch: 2, lease: null, containmentQuarantine: null, submission } as Partial<Work>))[0]?.note ?? '', /epoch 2 submitted PR #157/);
  // A later attempt holding the lease still supersedes every earlier one.
  assert.equal(settleableLeaseLoss(item({ epoch: 3, lease: { owner: 'graphyard-opencode-1', epoch: 3, expiresAt: iso(60_000) }, containmentQuarantine: null, submission } as Partial<Work>))[0]?.cause, 'superseded');

  // Between attempts, with the dispatch that will supersede it due, the claim does the decision's work.
  const dispatch = { kind: 'dispatch', work: 'work-161', key: 'GY-161', gate: 'build', refusal: null, reason: 'GY-161 is ready and unassigned', inputs: { kind: 'dispatch', target: 'implementation', epoch: 1, priority: 1, plannedFiles: ['web/'] }, llmRole: null, binding: 'dispatch:1' };
  assert.equal(decide(item({ epoch: 1, lease: null, containmentQuarantine: null, nextAction: dispatch } as unknown as Partial<Work>)), null);
  // Between attempts with nothing due to take the item: this host's stopped-worker verification is the grounds.
  const idle = decide(item({ epoch: 1, lease: null, containmentQuarantine: null } as Partial<Work>));
  assert.equal(idle?.action, 'resolve');
  assert.deepEqual(idle?.input, { trigger: 'lease-loss' });
  assert.equal(idle?.binding, `lease-loss:1:${lost.at}`, 'one request per escalation, stable across cycles and heartbeats');
  assert.match(idle!.reason, /No newer attempt holds the item and none is due: it has no next action/);
  assert.match(idle!.reason, /The previous worker is stopped/);
  assert.match(idle!.reason, /decides no gate and ships nothing/);

  // Other triggers, and a lease-loss a lead raised, stay for the master.
  for (const other of [{ ...lost, trigger: 'security-concern', reason: 'a credential' }, { ...lost, actor: 'slice-lead' }]) {
    const work = item({ escalation: other, escalations: [other] } as Partial<Work>);
    assert.deepEqual(settleableLeaseLoss(work).filter(entry => entry.cause === 'superseded'), [], `${other.trigger} by ${other.actor}`);
    assert.equal(idleLeaseLoss({ ...work, epoch: 1, lease: null, containmentQuarantine: null }), null);
    assert.equal(decide(work), null);
  }
  // Delivered work is immutable: nothing settles or asks there.
  assert.deepEqual(settleableLeaseLoss(item({ stage: 'done' } as Partial<Work>)), []);
  assert.equal(idleLeaseLoss(item({ stage: 'done', epoch: 1, lease: null, containmentQuarantine: null } as Partial<Work>)), null);
});

const idleItem = (overrides: Partial<Work> = {}) => item({ epoch: 1, lease: null, containmentQuarantine: null, ...overrides } as Partial<Work>);
function loopEffects(work: Work, decided: { action: string; reason: string; input?: Record<string, unknown> }[], approvers: string[], standing: () => unknown[]) {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [work], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work: Work, action: string, reason: string, input?: Record<string, unknown>) => { decided.push({ action, reason, input }); return { id: '5d8a8b9e-0000-4000-8000-0000000001a1' }; },
    decisions: async () => ({ decisions: standing() }),
    approver: async (_work: Work, decision: string) => { approvers.push(decision); return { agentName: 'graphyard-approver-gy-161', pane: 'pane-1' }; },
    persist: async () => {},
  } as unknown as DaemonEffects;
}

test('unit:lease-loss-resolve-requested — the loop requests the resolve with its trigger and launches an approver, once', async () => {
  const decided: { action: string; reason: string; input?: Record<string, unknown> }[] = [], approvers: string[] = [];
  const work = idleItem();
  // The server lists the request as standing until an approver judges it.
  const effects = loopEffects(work, decided, approvers, () => decided.map(entry => ({ id: '5d8a8b9e-0000-4000-8000-0000000001a1', action: entry.action, state: 'requested', input: { ...entry.input, expectedRevision: 51 }, approvedBy: null })));
  const state = emptyDaemonState(config());
  await runCycle(config(), state, effects, () => clock);
  assert.equal(decided.length, 1);
  assert.equal(decided[0].action, 'resolve');
  assert.deepEqual(decided[0].input, { trigger: 'lease-loss' });
  assert.deepEqual(approvers, ['5d8a8b9e-0000-4000-8000-0000000001a1']);
  // The next cycle supervises the same request rather than asking again.
  await runCycle(config(), state, effects, () => clock + 30_000);
  assert.equal(decided.length, 1);
});

test('unit:lease-loss-resolve-requested — a standing resolve for another escalation is never adopted as the lease-loss one', async () => {
  const decided: { action: string; reason: string; input?: Record<string, unknown> }[] = [], approvers: string[] = [];
  const other = { id: '5d8a8b9e-0000-4000-8000-0000000001b2', action: 'resolve', state: 'requested', input: { trigger: 'security-concern', expectedRevision: 50 }, approvedBy: null };
  const state = emptyDaemonState(config());
  const performed = await runCycle(config(), state, loopEffects(idleItem(), decided, approvers, () => [other]), () => clock);
  assert.equal(decided.length, 0, 'the control plane holds one resolve at a time; this one waits for it');
  assert.deepEqual(approvers, [], 'a security-concern resolve is not put to an approver as this lease-loss');
  assert.ok(!Object.values(state.approvals).some(watch => watch.decision === other.id), 'no watch settles on the other decision');
  assert.match(JSON.stringify(performed), /requested for security-concern, not the lease-loss raised at/);

  // A lease-loss resolve pinned to an earlier raising of the trigger is not this one either.
  const earlier = { ...other, input: { trigger: 'lease-loss', expectedRevision: 50 }, pin: { escalations: [{ trigger: 'lease-loss', at: iso(-40 * 60_000) }] } };
  const again = emptyDaemonState(config());
  await runCycle(config(), again, loopEffects(idleItem(), decided, approvers, () => [earlier]), () => clock);
  assert.deepEqual(approvers, []);
  // The one requested for this very escalation is adopted, not asked twice.
  const same = { ...earlier, pin: { escalations: [{ trigger: 'lease-loss', at: lost.at }] } };
  const adopted = emptyDaemonState(config());
  await runCycle(config(), adopted, loopEffects(idleItem(), decided, approvers, () => [same]), () => clock);
  assert.equal(decided.length, 0);
  assert.deepEqual(approvers, [same.id]);
});

test('unit:lease-loss-resolve-requested — a request refused on a moved revision is asked again only on the same grounds', async () => {
  const root = await temporaryDirectory('lease-loss-root'), secrets = await temporaryDirectory('lease-loss-secrets');
  try {
    execFileSync('git', ['init', '-q', root]);
    const token = join(secrets, 'operator.token');
    await writeFile(token, 'operator-token-'.padEnd(48, 'x'), { mode: 0o600 });
    const master = { ...config(), operatorAgent: { id: 'graphyard-master-operator', credentialFile: token } } as MasterConfig;
    const posted: any[] = [];
    let current: Work = idleItem({ revision: 52 } as Partial<Work>);
    const fetcher = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      if (body.input.expectedRevision !== current.revision) return new Response(JSON.stringify({ error: `Task revision changed (now ${current.revision}); reload and request again` }), { status: 409 });
      return new Response(JSON.stringify({ id: 'decision-1' }), { status: 200 });
    }) as typeof fetch;
    const effects = daemonEffects(root, master, { snapshot: async () => ({ work: [current], now: iso(0) }), mutate: async () => { throw new Error('not used'); }, fetcher });
    const stale = idleItem();
    const needed = decide(stale)!;

    // A heartbeat moved the revision: the same grounds hold, so it is asked at the new revision.
    assert.deepEqual(await effects.decide!(stale, 'resolve', needed.reason, needed.input), { id: 'decision-1' });
    assert.deepEqual(posted.map(body => body.input.expectedRevision), [51, 52]);
    assert.equal(posted[1].input.trigger, 'lease-loss');

    // The lease-loss was settled and another raised in between: the old reason would describe the
    // wrong incident, so the refusal stands and the next cycle decides afresh.
    posted.length = 0;
    const raised = { ...lost, at: iso(-2 * 60_000), reason: 'Worker graphyard-claude-2 lost lease epoch 1' };
    current = idleItem({ revision: 53, escalation: raised, escalations: [raised] } as Partial<Work>);
    await assert.rejects(effects.decide!(stale, 'resolve', needed.reason, needed.input), /Task revision changed \(now 53\).*now needs the resolve on other grounds/);
    assert.equal(posted.length, 1);
    // The escalation is gone altogether: nothing is asked again.
    posted.length = 0;
    current = idleItem({ revision: 54, escalation: null, escalations: [] } as Partial<Work>);
    await assert.rejects(effects.decide!(stale, 'resolve', needed.reason, needed.input), /no longer needs this resolve/);
    assert.equal(posted.length, 1);
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(secrets, { recursive: true, force: true })]); }
});
