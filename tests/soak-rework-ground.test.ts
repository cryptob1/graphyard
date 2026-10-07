import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { reworkGround, laneApprover } from '../src/model/rework-ground.js';
import { itemLane } from '../src/model/policy.js';
import type { Work } from '../src/model.js';

/**
 * GY-1394. Grounded rework over simulated days: the loop now returns a head an approver refused to
 * attest to a worker on that refusal, and the control plane applies a rework whose ground the record
 * shows (a trusted proof failed, an attestation refused) with no approver even on a high-lane item.
 * Both repeat per head and per item, so the loop runs here for three simulated days over one
 * high-lane item whose worker keeps pushing heads: some fail a trusted producer's proof, some have
 * their attestation refused (one of them after the loop lost its cursor), and the last is attested
 * and delivered. After every cycle: each refused or failed head is returned to a worker by exactly
 * one rework request, never repeated per cycle; a watch keeping a refusal binds only the current
 * head, so it retires once the head moves on; no approver is ever launched for a rework; and no
 * refusal is escalated to a master.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour, start = Date.parse('2026-10-07T00:00:00.000Z');
const MANUAL = 'manual:safety-attestation', PRODUCED = 'manual:producer-checked', base = 'b'.repeat(40);
const iso = (at: number) => new Date(at).toISOString();
const shaOf = (round: number) => round.toString(16).padStart(40, '0');

/** Each head's fate: its producer fails the produced proof, its attestation is refused, or (last) it is attested. */
type Fate = 'proof-failed' | 'attest-refused' | 'attest-refused-cursor-lost' | 'attested';
const fates: Fate[] = ['attest-refused', 'proof-failed', 'attest-refused', 'attest-refused-cursor-lost', 'proof-failed', 'attest-refused', 'proof-failed', 'attest-refused', 'attested'];

test('unit:soak-invariants-hold — over three simulated days a high-lane item’s refused and failed heads each return to a worker once, with no approver for the rework, no refusal escalated, and every refusal watch retired with its head', { timeout: 300_000 }, async () => {
  let now = start;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: iso(start - hour) },
    reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }], producers: [], run: { intervalSeconds: 600 } }) as MasterConfig;

  // The world: one item, its decisions as the control plane keeps them, and the head's round.
  let round = 0, pushedAt = start, reworkRequested = false, delivered = false, cursorLost = false;
  const decisions: { id: string; action: string; state: string; input: any; approvedBy: string | null; refusal: { approver: string; reason: string; at: string } | null; ground?: string }[] = [];
  const reworks = new Map<string, number>(), approvers: { action: string; sha: string }[] = [], attests = new Map<string, number>();
  const work = (): Work => {
    const sha = shaOf(round + 1), fate = fates[round], candidate = { sha, baseSha: base, pr: 1394, branch: 'graphyard/gy-1500-1', author: 'worker' };
    const produced = fate === 'proof-failed' ? { result: 'fail' as const, executed: 3 } : { result: 'pass' as const, executed: 3 };
    const attested = decisions.some(entry => entry.action === 'attest' && entry.state === 'applied' && entry.input.sha === sha);
    const reasons = [...(produced.result === 'fail' ? [`AC-2: ${PRODUCED} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`] : []),
      ...(attested ? [] : [`AC-1: ${MANUAL} needs trusted passing evidence, with skipped = 0, for this candidate and policy`])];
    return {
      id: 'work-GY-1500', key: 'GY-1500', title: 'High-lane change', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['src/server/auth.ts'],
      criteria: [{ id: 'AC-1', text: 'Safe', proofs: [MANUAL] }, { id: 'AC-2', text: 'Checked', proofs: [PRODUCED] }], policy: { checks: ['test'], review: true }, producerProofs: [PRODUCED],
      stage: delivered ? 'done' : reworkRequested ? 'build' : 'acceptance', ready: true, epoch: round + 1, revision: 10 + round, policyRevision: 1,
      createdAt: iso(start - hour), updatedAt: iso(now), stageEnteredAt: iso(pushedAt), lease: null, workspaces: [],
      submission: { epoch: round + 1, pr: 1394 }, candidate, reworkRequested, scenarioRequirements: [], blocker: null, violations: [],
      evidence: [{ id: `e${round}`, proof: PRODUCED, sha, baseSha: base, policyRevision: 1, skipped: 0, producer: 'trusted-producer', trusted: true, at: iso(pushedAt), ...produced }],
      observation: { candidate, checks: [{ appId: 15368, name: 'test', result: 'success' }], reviews: [{ reviewer: 'graphyard-reviewer', sha, state: 'APPROVED' }], merged: delivered, mergeSha: null,
        mergeable: true, protected: true, files: ['src/server/auth.ts'], scopeFiles: [{ path: 'src/server/auth.ts', status: 'modified', sha: 'f'.repeat(40), additions: 1, deletions: 1, binary: false }],
        at: iso(now), prState: 'open', draft: false, baseTip: base, baseTipContained: true, conversations: { required: true, unresolved: [] } },
      gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }, { name: 'test', passed: true, reasons: [] }, { name: 'acceptance', passed: !reasons.length, reasons }],
    } as unknown as Work;
  };
  assert.equal(itemLane(work()), 'high', 'the item rides the high lane, where a rework without a ground waits for its approver');

  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: [work()], now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    decisions: async () => ({ decisions }),
    decide: async (item: Work, action: string, _reason: string, input?: Record<string, unknown>) => {
      const id = randomUUID(), sha = item.candidate!.sha;
      if (action === 'attest') {
        attests.set(sha, (attests.get(sha) ?? 0) + 1);
        decisions.push({ id, action, state: 'requested', input: { ...input, sha, baseSha: base, policyRevision: 1, result: 'pass', executed: 1, skipped: 0 }, approvedBy: null, refusal: null });
        return { id };
      }
      assert.equal(action, 'rework', `only attest and rework decisions are asked for, not ${action}`);
      reworks.set(sha, (reworks.get(sha) ?? 0) + 1);
      // The control plane's applyLaneRework: a high-lane rework applies at once only on a recorded ground.
      const ground = reworkGround(item, decisions as Parameters<typeof reworkGround>[1]);
      decisions.push({ id, action, state: ground ? 'applied' : 'requested', input: { ...input, sha }, approvedBy: ground ? laneApprover : null, refusal: null, ...(ground ? { ground } : {}) });
      if (!ground) return { id };
      reworkRequested = true;
      return { id, state: 'applied', approvedBy: laneApprover };
    },
    withdraw: async (_item: Work, decision: string) => { const entry = decisions.find(each => each.id === decision); if (entry) entry.state = 'withdrawn'; },
    // The attest approver judges at once: it refuses every head but the last; the loop's cursor is lost after one refusal.
    approver: async (item: Work, decision: string) => {
      const entry = decisions.find(each => each.id === decision)!;
      approvers.push({ action: entry.action, sha: item.candidate!.sha });
      if (entry.action === 'attest') {
        const fate = fates[round];
        if (fate === 'attested') entry.state = 'applied';
        else { entry.state = 'refused'; entry.refusal = { approver: 'graphyard-approver', reason: `the head ${item.candidate!.sha.slice(0, 12)} does not hold AC-1`, at: iso(now) }; }
        if (fate === 'attest-refused-cursor-lost') cursorLost = true;
      }
      return { agentName: `gy-approver-${decision.slice(0, 8)}`, pane: null };
    },
    persist: async () => {},
  } as unknown as DaemonEffects;

  let state: DaemonState = emptyDaemonState(config);
  const escalations: string[] = [], failed: string[] = [];
  for (let cycle = 0; now < start + 3 * day; cycle++, now += 10 * minute) {
    // The worker pushes the next head two hours after its rework was applied; a delivered item stays.
    if (reworkRequested && now - pushedAt >= 2 * hour) { round++; reworkRequested = false; pushedAt = now; }
    if (!delivered && decisions.some(entry => entry.action === 'attest' && entry.state === 'applied' && entry.input.sha === shaOf(round + 1))) delivered = true;
    // A lost cursor (a restart, a recovered state) forgets every watch; the refusal survives only on the control plane.
    if (cursorLost) { state = emptyDaemonState(config); cursorLost = false; }
    const result = await runCycle(config, state, effects, () => now);
    for (const action of result.actions) {
      if (action.kind === 'escalation') escalations.push(action.detail ?? '');
      if (action.state === 'failed' && action.kind === 'decision') failed.push(action.detail ?? '');
    }
    // A watch keeping a refusal binds only the head it refused, which is the current one: it retires once the head moves on.
    for (const watch of Object.values(state.approvals))
      if (watch.refusal) assert.equal(watch.refusal.sha, shaOf(round + 1), `cycle ${cycle}: a refusal watch for ${watch.refusal.sha.slice(0, 12)} outlived its head`);
  }

  assert.equal(delivered, true, `every head but the last was returned and the last attested (round ${round + 1} of ${fates.length})`);
  assert.equal(round, fates.length - 1);
  for (const [index, fate] of fates.entries()) {
    const sha = shaOf(index + 1);
    // One rework per refused or failed head, never repeated per cycle; none for the attested head.
    assert.equal(reworks.get(sha) ?? 0, fate === 'attested' ? 0 : 1, `head ${index + 1} (${fate}): ${reworks.get(sha) ?? 0} rework request(s)`);
    // Each attestation is asked once per head, even after the cursor was lost: the refusal is rebuilt, never asked again.
    assert.equal(attests.get(sha) ?? 0, fate === 'proof-failed' ? 0 : 1, `head ${index + 1} (${fate}): ${attests.get(sha) ?? 0} attest request(s)`);
  }
  // Every rework applied on its recorded ground, with no approver launched for it.
  const applied = decisions.filter(entry => entry.action === 'rework');
  assert.ok(applied.length === fates.length - 1 && applied.every(entry => entry.state === 'applied' && entry.approvedBy === laneApprover && entry.ground), JSON.stringify(applied.map(entry => [entry.state, entry.ground])));
  assert.deepEqual(approvers.filter(entry => entry.action !== 'attest'), [], 'no approver session was launched for a grounded rework');
  assert.deepEqual(escalations.filter(detail => /refused|refusal/.test(detail)), [], 'no refusal was escalated to a master');
  assert.deepEqual(failed, [], 'no decision step failed');
  assert.deepEqual(Object.values(state.approvals).filter(watch => watch.refusal), [], 'no refusal watch is left once the item is delivered');
});
