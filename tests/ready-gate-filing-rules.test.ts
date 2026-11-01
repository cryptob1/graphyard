import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { evaluate } from '../src/model/gates.js';
import { nextAction } from '../src/model/next-action.js';
import { plainReason, plainStatus } from '../src/model/plain-status.js';
import { defaultRepositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';
import { setProjectDelivery } from '../src/project-applications.js';
import { e2eProofRefusal, type Work } from '../src/model.js';

// GY-2981: open items catch up to the filing rules an upgrade adds. An item written straight to
// the store before GY-3037 enforced them keeps its filed criteria forever, so the ready gate
// re-runs create's filing validation against its current criteria and the install's current
// policy: what today's rules would refuse is refused here with create's own message, the master
// answers it with master requirements, and the item dispatches once the proof is added. A claimed
// item keeps its lease and is not refused, and a submitted one is not touched either.

const now = new Date('2026-10-30T06:00:00.000Z');
const serve = { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 };
// The filing validation reads the policy in force; these tests pin it, so the ready gate's reading is deterministic.
setRepositoryPolicy({ ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking', serve } });
setProjectDelivery(null);

/** An item of the shape the store held before the e2e rule was enforced: filed, released, unclaimed. */
const item = (fields: Record<string, unknown> = {}): Work => ({
  id: randomUUID(), key: 'GY-9901', title: 'Filed before the e2e rule', description: '', type: 'feature', priority: 1, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
  stage: 'ready', revision: 1, policyRevision: 1, createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z', stageEnteredAt: '2026-10-23T00:00:00.000Z',
  ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
  scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], ...fields,
} as unknown as Work);

const graded = (work: Work): Work => ({ ...work, ...evaluate(work, [work], now) });
const readyGate = (work: Work) => evaluate(work, [work], now).gates.find(gate => gate.name === 'ready')!;

test('unit:ready-gate-applies-filing-rules — an unclaimed item filed before the e2e rule is refused at the ready gate with the message master create gives, of every type', () => {
  for (const type of ['feature', 'bug', 'chore'] as const) {
    const gate = readyGate(item({ type }));
    assert.equal(gate.passed, false, `an unclaimed ${type} is refused at the ready gate`);
    assert.match(gate.reasons[0], new RegExp(`a ${type} item owes an end-to-end proof`));
    assert.match(gate.reasons[0], /e2e\/cases\/NAME\.json/, 'the refusal names the case format');
    assert.doesNotMatch(gate.reasons[0], /No user-facing change/, 'no opt-out is named: there is none');
    // The same message create words, word for word.
    assert.equal(gate.reasons[0], e2eProofRefusal({ type, description: '', criteria: item().criteria as readonly { proofs: readonly string[] }[] }));
  }
  // The opt-out sentence with a reason excuses nothing either.
  assert.equal(readyGate(item({ type: 'chore', description: 'No user-facing change: the rule is control-plane internal' })).passed, false, 'the opt-out does not excuse the item');
});

test('unit:ready-gate-applies-filing-rules — a claimed item keeps its lease and is not refused, and a submitted one is not touched', () => {
  const lease = { owner: 'graphyard-claude-1', epoch: 1, expiresAt: new Date(now.getTime() + 60_000).toISOString() };
  const claimed = item({ epoch: 1, lease, stage: 'build' });
  assert.equal(readyGate(claimed).passed, true, 'a live lease is not refused mid-flight');
  assert.equal(readyGate(item({ submission: { epoch: 1, pr: 7 } })).passed, true, 'a submitted item is not touched');
  assert.equal(readyGate(item({ lease: { ...lease, expiresAt: new Date(now.getTime() - 60_000).toISOString() } })).passed, false, 'a lease that lapsed leaves the item unclaimed, and it is refused again');
});

test('unit:ready-gate-applies-filing-rules — the item dispatches once master requirements adds an e2e: criterion, and until then no worker is offered it', () => {
  const refused = graded(item());
  const action = nextAction(refused, [refused], now);
  assert.equal(action?.kind, 'attention', 'the loop dispatches nothing while the filing refusal stands');
  assert.match(action?.refusal ?? '', /owes an end-to-end proof/);
  assert.match(action?.needsHuman?.resolve ?? '', /graphyard master requirements GY-9901/, 'the attention names the command that answers it');

  const fixed = item({ criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:home-shows-change'] }] });
  assert.equal(readyGate(fixed).passed, true, 'with the criterion added, the ready gate passes');
  const dispatch = nextAction(graded(fixed), [fixed], now);
  assert.equal(dispatch?.kind, 'dispatch', 'the item dispatches');
});

test('unit:ready-gate-applies-filing-rules — the refusal reads plainly, and an item it holds is never shown waiting for a worker', () => {
  const status = plainStatus(graded(item()), now.getTime());
  assert.match(status.sentence, /Stuck: the change owes an end-to-end proof/i);
  assert.equal(status.tone, 'stuck');
  for (const reason of [readyGate(item()).reasons[0], 'e2e:home-shows-change has no way to serve a head: declare "e2e": { "serve": { "command", "url", "readySeconds" } } in graphyard.json, or declare a previewable application in delivery.applications']) {
    const plain = plainReason(reason, 'ready', now.getTime());
    assert.equal(plain.known, true, `no plain reading for "${reason}"`);
    assert.equal(plain.stuck, true, `"${reason}" clears only when somebody answers it`);
  }
});
