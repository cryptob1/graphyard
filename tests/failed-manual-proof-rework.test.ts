import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig, type MasterRun } from '../src/master.js';
import { neededDecision, proofRework, refusedAttestationWatch } from '../src/daemon/decisions.js';
import { reworkGround, laneApprover } from '../src/model/rework-ground.js';
import { foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { producerPrompt } from '../src/producer.js';
import { piProducerPrompt } from '../src/runner/roles.js';
import type { Evidence, Work } from '../src/model.js';

// GY-868. On 2026-09-27 seventeen follow-up items sat in acceptance for 6–10 hours: their trusted
// producer ran the producer-runnable proof manual:review-followups-triaged and recorded it FAILED
// on the head, but proofRework reads only mechanicalVerdicts, which excludes manual proofs, so no
// rework was requested; the shepherd then escalated "needs operator-witnessed proof", parking the
// items for a human. A failed proof on the head is the worker's to fix, like a failed unit proof.
// Only a record with executed = 0 judged nothing: that stays with attestationDecision (GY-523),
// and only a manual proof no producer may run waits for an operator witness.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-27T00:00:00.000Z';
const PROOF = 'manual:review-followups-triaged';
const WITNESS = 'manual:witness-only';

function item(evidence: Partial<Evidence>[] = [{}], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 901, branch: 'graphyard/gy-901-1', author: 'worker' };
  return {
    id: 'gy-901', key: 'GY-901', title: 'Follow-up triage', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Review follow-ups are triaged', proofs: [PROOF] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/'],
    stage: 'acceptance', revision: 4, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 901 }, reworkRequested: false, scenarioRequirements: [], blocker: null, gates: [], violations: [],
    producerProofs: [PROOF],
    evidence: evidence.map(entry => ({ id: 'e1', proof: PROOF, sha: head, baseSha: base, policyRevision: 1, result: 'fail' as const, executed: 0, skipped: 0, producer: 'trusted-producer', trusted: true, at, ...entry })),
    observation: { candidate, checks: [{ appId: 15368, name: 'test', result: 'success' }], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true, conversations: { required: true, unresolved: [] } },
    ...extra,
  } as unknown as Work;
}

test('unit:producer-prompt-manual-proof-judged — both producer prompts judge a manual proof and scope the title rule to unit/integration', () => {
  const binding = { key: 'GY-901', pr: 901, sha: head, baseSha: base, policyRevision: 1, group: 'manual', proofs: [PROOF], checkout: '/tmp/producer-session' };
  const prompts = [
    producerPrompt({ repository: 'owner/project', cliPath: '/bin/graphyard.mjs' }, binding, { principal: 'graphyard-producer-x' }),
    piProducerPrompt({ repository: 'owner/project' }, binding, [{ id: 'AC-1', text: 'Review follow-ups are triaged', proofs: [PROOF] }],
      { directory: '/tmp/producer-session', worktree: '/tmp/producer-session/checkout' }, '/repo'),
  ];
  for (const prompt of prompts) {
    // The manual-proof rule: judged by cases and checks run, with the exercise record it carries.
    for (const phrase of ['manual: proof is judged', 'number of test cases and checks', 'judge the criterion', 'exercise record'])
      assert.ok(prompt.includes(phrase), `the prompt tells the producer the manual-proof rule: ${phrase}`);
    // The title-prefix rule is scoped: it never counts a manual proof's cases.
    assert.ok(prompt.includes('applies to unit: and integration: proofs only'), 'the prompt scopes the title rule to unit/integration');
  }
  assert.ok(prompts[0].includes('never narrowed with --test-name-pattern'), 'the unit/integration rule keeps its anti-narrowing clause');
});

test('unit:zero-executed-manual-proof-attested — a manual fail with executed 0 is unexercised, answered by an attestation', () => {
  const work = item();
  // It is not the worker's: no rework is asked for a proof nothing ran on.
  assert.equal(proofRework(work), null);
  const needed = neededDecision(work, { autoMerge: true });
  assert.equal(needed?.action, 'attest');
  assert.deepEqual(needed?.input, { proof: PROOF });
  assert.equal(needed?.binding, `${head}:attest:${PROOF}`);
  assert.match(needed!.reason, /rework is the wrong remedy/);
  assert.match(needed!.reason, /no test case or check ran/);
  // A trusted pass recorded since answers the finding: nothing more is asked for.
  assert.equal(neededDecision(item([{ id: 'e2', result: 'pass', executed: 2, trusted: true }]), { autoMerge: true }), null);
  // An untrusted record judges nothing either way: no finding rides on it.
  assert.equal(neededDecision(item([{ trusted: false }]), { autoMerge: true }), null);
});

test('unit:producer-manual-proof-never-escalated — a judged manual failure reworks; an unrunnable one never reworks, and neither is parked for an operator', async () => {
  // A producer-runnable manual proof the producer judged and failed with cases executed:
  // the item returns to a worker through proofRework.
  const judged = item([{ executed: 3 }]);
  const rework = proofRework(judged);
  assert.ok(rework, 'a judged manual failure owes a rework round');
  assert.match(rework!.reason, new RegExp(PROOF));
  assert.match(rework!.reason, /returns to its worker/);
  assert.equal(rework!.binding, `${head}:proof:${PROOF}`);
  assert.equal(neededDecision(judged, { autoMerge: true })?.action, 'rework');
  // A manual proof no producer may run is never the worker's: the escalation stays, the rework does not come.
  const unrunnable = item([{ executed: 3 }], { producerProofs: [] });
  assert.equal(proofRework(unrunnable), null);

  // The shepherd never parks the producer-runnable proof as operator-witnessed. Since GY-1235 proofs
  // gate nothing and the shepherd raises no proof escalation at all (only exhausted producers), so
  // the proof no producer may run is no longer escalated either.
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/tmp/coordinator.token', cliPath: '/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true,
    mergeMethod: 'merge', workers: [], run: { intervalSeconds: 20, proofWorkflow: 'acceptance.yml', deploymentShaField: 'commit' } }) as MasterConfig;
  const candidate = { sha: head, baseSha: base, pr: 901, branch: 'graphyard/gy-901-1', author: 'worker' };
  const outstanding = item([{ trusted: false }], {
    id: 'acc-1', stage: 'merge', submission: { epoch: 1, pr: 901 }, candidate,
    criteria: [{ id: 'AC-1', text: 'Triaged', proofs: [PROOF] }, { id: 'AC-2', text: 'Witnessed', proofs: [WITNESS] }],
  });
  const log: string[] = [];
  const deps = {
    agents: () => [],
    credentials: async (profiles: { name: string }[]) => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [outstanding], now: at }),
    closeSession: (pane: string) => { log.push(`close:${pane}`); },
    dispatch: async (work: Work) => { log.push(`dispatch:${work.key}`); },
    requestProof: async (work: Work) => { log.push(`proof:${work.key}`); },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: async () => {},
    persist: async () => {},
  } as unknown as DaemonEffects;
  const result = await runCycle(config, emptyDaemonState(config), deps, () => Date.parse(at));
  assert.ok(!result.actions.some(action => action.kind === 'escalation' && /operator-witnessed/.test(action.detail ?? '')), 'no proof is parked for an operator witness');
  for (const action of result.actions)
    assert.doesNotMatch(action.detail ?? '', new RegExp(PROOF), 'a producer-runnable manual proof is never parked as operator-witnessed');
});

test('unit:producer-manual-proof-never-escalated — docs/operations.md states the rule within the word budget', () => {
  const page = readFileSync(fileURLToPath(new URL('../docs/operations.md', import.meta.url)), 'utf8');
  assert.match(page, /never to an operator escalation/);
  assert.match(page, /no producer may run/);
  assert.match(page, /operator witness/);
  assert.match(page, /an unexecuted one an attestation/);
  const words = page.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 1200, `docs/operations.md stays within the 1,200-word page budget (${words} words)`);
});

// GY-1394. 25 rework decisions at the acceptance stage in the week to 2026-10-07 each waited on an
// approver or a master although the record had already decided the question. Every instance, by
// its decision id, and the ground that now applies it with nobody stepping in:
// - proof: a trusted proof failed on the exact head (the loop's proofRework, or the same ground
//   restated by a master) — the server applies it on that ground (reworkGround);
// - attest: an approver refused the head's attestation — the loop requests the rework on the
//   refusal itself (refusedAttestationRework) and the server applies it on that ground;
//   GY-711's master judged the docs review itself before any attestation; the master instructions
//   now leave that judgement to the attestation, whose refusal returns the head;
// - lane: the risk lane already applied it with no approver (GY-883) — the fold no longer counts a
//   rework the control plane approved itself;
// - spent: every producer session never started on a spent quota; since GY-1153 the loop asks no
//   rework for such a head and relaunches the request once an eligible account exists.
const instances: [string, string, 'proof' | 'attest' | 'lane' | 'spent'][] = [
  ['GY-1190', '17911573', 'proof'], ['GY-717', 'd0573f13', 'proof'], ['GY-971', '924dfe75', 'lane'], ['GY-1098', 'c6358977', 'attest'],
  ['GY-711', 'ebccbd40', 'attest'], ['GY-1098', '9439a8f4', 'attest'], ['GY-1052', '62f1eeb8', 'spent'], ['GY-980', '8d431a81', 'lane'],
  ['GY-1107', '714832d0', 'lane'], ['GY-1048', 'c020f65d', 'proof'], ['GY-1039', 'afa1c1c4', 'proof'], ['GY-717', '6711eaba', 'proof'],
  ['GY-1048', '4485e840', 'proof'], ['GY-1052', 'fbd8c016', 'proof'], ['GY-1039', 'dd0c1b80', 'proof'], ['GY-1048', 'acdceb88', 'proof'],
  ['GY-1039', 'f69445c1', 'proof'], ['GY-1052', '3abd907e', 'proof'], ['GY-971', '6b56ae07', 'lane'], ['GY-1048', 'c14f480e', 'proof'],
  ['GY-1052', '5b3b9187', 'proof'], ['GY-717', '7cb58672', 'proof'], ['GY-1048', '7e8b07a5', 'proof'], ['GY-1039', 'd611f71b', 'proof'],
  ['GY-957', 'a3afe3bf', 'proof'],
];
const refusedAttest = (input: Record<string, unknown> = {}) => ({ id: 'a7e5f000-0000-4000-8000-000000000001', action: 'attest' as const, state: 'refused', refusal: { approver: 'graphyard-approver', reason: 'docs/github.md deletes shipped behaviour', at },
  input: { proof: 'manual:docs-review', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 1, skipped: 0, ...input } });

test('unit:rework-ground-recorded — a trusted failure, a refused attestation or a GitHub conflict on the exact head is the rework\u2019s ground', () => {
  assert.equal(instances.length, 25, 'every listed instance is classified');
  // proof: a trusted producer judged the head and failed it.
  assert.match(reworkGround(item([{ executed: 3 }]), [])!, new RegExp(`a trusted proof failed on candidate ${head.slice(0, 12)} \\(${PROOF}\\)`));
  // Nothing judged (executed 0), an untrusted record, or a pass is no ground: such a rework still waits for its approver.
  assert.equal(reworkGround(item(), []), null);
  assert.equal(reworkGround(item([{ executed: 3, trusted: false }]), []), null);
  assert.equal(reworkGround(item([{ result: 'pass', executed: 3 }]), []), null);
  // attest: the refusal binds exactly this head, base and policy revision.
  assert.match(reworkGround(item(), [refusedAttest()])!, /graphyard-approver refused the attestation of manual:docs-review/);
  for (const other of [{ sha: 'c'.repeat(40) }, { baseSha: 'c'.repeat(40) }, { policyRevision: 2 }, { result: 'fail' }])
    assert.equal(reworkGround(item(), [refusedAttest(other)]), null, `a refusal of another binding is no ground: ${JSON.stringify(other)}`);
  assert.equal(reworkGround(item(), [{ ...refusedAttest(), state: 'requested', refusal: null }]), null, 'an attestation still awaiting judgement is no ground');
  // conflict: GitHub reports the exact head conflicting.
  const conflicting = item();
  conflicting.observation = { ...conflicting.observation!, conflicting: true } as Work['observation'];
  assert.match(reworkGround(conflicting, [])!, /GitHub reports candidate .* conflicting with its base/);
  // A delivered head, or one no longer submitted, has no ground.
  assert.equal(reworkGround(item([{ executed: 3 }], { stage: 'done' }), []), null);
  assert.equal(laneApprover, 'graphyard-risk-lane');
});

test('unit:rework-ground-recorded — a refused attestation of the head returns it to a worker through the loop\u2019s routine rework', () => {
  const refusal = refusedAttestationWatch(refusedAttest())!;
  assert.deepEqual({ ...refusal, at: undefined }, { approver: 'graphyard-approver', reason: 'docs/github.md deletes shipped behaviour', at: undefined, proof: 'manual:docs-review', sha: head, baseSha: base, policyRevision: 1 });
  assert.equal(refusedAttestationWatch({ ...refusedAttest(), state: 'applied' }), null);
  assert.equal(refusedAttestationWatch({ ...refusedAttest(), action: 'rework' }), null);
  const passed = item([{ result: 'pass', executed: 3 }]);
  assert.equal(neededDecision(passed, { autoMerge: true }), null, 'nothing is asked without the refusal');
  const needed = neededDecision(passed, { autoMerge: true }, undefined, [], [], [{ decision: 'a7e5f000', refusal }]);
  assert.equal(needed?.action, 'rework');
  assert.equal(needed?.binding, `${head}:attest-refused:a7e5f000`);
  assert.match(needed!.reason, /refused the attestation of manual:docs-review on candidate .*"docs\/github.md deletes shipped behaviour"/);
  // A refusal of an earlier head asks for nothing on this one.
  assert.equal(neededDecision(passed, { autoMerge: true }, undefined, [], [], [{ decision: 'old', refusal: { ...refusal, sha: 'c'.repeat(40) } }]), null);
  assert.equal(neededDecision({ ...passed, reworkRequested: true } as Work, { autoMerge: true }, undefined, [], [], [{ decision: 'a7e5f000', refusal }]), null);
});

test('unit:rework-ground-recorded — a rework the control plane approved itself is no intervention; one an approver judged still is', () => {
  const work = 'f0f0f0f0-0000-4000-8000-000000000001', stamp = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
  const document = { key: 'GY-901', stage: 'acceptance', candidate: { sha: head, pr: 901 } };
  const rows = (approver: string): InterventionLedgerRow[] => [
    { seq: 1, workId: work, actor: 'graphyard-master', kind: 'decision.requested', at: stamp(1), details: null, payload: { id: 'd1', action: 'rework' }, work: null, stageBefore: 'acceptance' },
    { seq: 2, workId: work, actor: approver, kind: 'decision.approved', at: stamp(30), details: null, payload: { id: 'd1', action: 'rework' }, work: null, stageBefore: 'acceptance' },
    { seq: 3, workId: work, actor: 'graphyard-master', kind: 'rework', at: stamp(31), details: { reason: 'a trusted proof failed' }, work: document, stageBefore: 'acceptance' },
  ];
  assert.deepEqual(foldInterventions(rows(laneApprover), [], stamp(60)).interventions, [], 'a rework the record grounded waited on nobody');
  const judged = foldInterventions(rows('graphyard-approver-graphyard'), [], stamp(60)).interventions;
  assert.deepEqual(judged.map(entry => [entry.kind, entry.stage, entry.id]), [['rework', 'acceptance', `rework:${work}:d1`]]);
  // Approved by the control plane but not yet applied: it is not reported as waiting either.
  const open = foldInterventions(rows(laneApprover).slice(0, 2), [{ ...item(), id: work }], stamp(60)).interventions;
  assert.deepEqual(open.filter(entry => entry.kind === 'rework'), []);
});
