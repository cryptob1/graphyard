import { test } from 'node:test';
import { equal, ok } from 'node:assert';
import type { EscalationTrigger } from '../src/model/work.js';
import { followOwnRevision, followPrecedent, requirementRevisions, type EscalationContext, type LedgerRow, type PrecedentEntry, type RequirementRevision } from '../src/model/escalation-context.js';

const at = '2026-09-27T00:00:00Z';

const precedentOf = (entry: Partial<PrecedentEntry>): PrecedentEntry => ({
  id: 'dec-001', work: 'GY-118', trigger: 'requirement-weakening', state: 'applied', requestedBy: 'graphyard-master', requestedAt: at,
  reason: 'GY-118 retired AC-4 and moved AC-1 through AC-3 intact to GY-123', approvedBy: 'approver', approvalReason: 'approved',
  outcome: 'approved', refusals: 0, precedent: [], context: 'abc123', ...entry,
});

/** An escalation on this item whose only applied precedent is another item's, with this item's own requirements history. */
function escalationContext(overrides: {
  trigger?: EscalationTrigger; precedent?: PrecedentEntry[]; revisions?: RequirementRevision[]; key?: string; revision?: number; epoch?: number; reason?: string;
} = {}): EscalationContext {
  const key = overrides.key ?? 'GY-868';
  const trigger = overrides.trigger ?? 'requirement-weakening';
  const escalation = { trigger, reason: overrides.reason ?? 'Requirement revision retires AC-2 and narrows proofs for AC-4', at, actor: 'graphyard-master' };
  return {
    version: 1,
    repository: 'graphyard',
    key,
    action: 'resolve',
    escalation,
    rules: { source: { path: 'docs/rules', ref: 'main', sha: null }, text: null, unavailable: null, policy: { checks: ['test'], review: true } },
    goals: { priority: 1, intents: [], graph: [], graphOmitted: [], dependencies: [], dependents: [] },
    item: {
      key, title: 'Test item', type: 'bug', description: '', stage: 'review', ready: true,
      revision: overrides.revision ?? 5, policyRevision: 1, epoch: overrides.epoch ?? 1, createdAt: at,
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
      retiredCriterionIds: ['AC-2'],
      plannedFiles: [], producerProofs: [], exclusiveResources: [], dependencies: [],
      refusal: { escalation, standing: [escalation], gates: [], blocker: null, violations: [] },
      candidate: null, submission: null, lease: null, implementers: [],
      history: { total: 10, kinds: [], recent: [], omitted: 0 },
      ...(overrides.revisions ? { requirementRevisions: overrides.revisions } : {}),
    },
    precedent: {
      action: 'resolve', total: overrides.precedent?.length ?? 1, matching: overrides.precedent?.length ?? 1,
      detail: overrides.precedent ?? [precedentOf({})], summary: [], omitted: 0,
    },
    budget: { limit: 32000, level: { recent: 40, detail: 20 }, exceeded: null, assembled: null, omitted: [] },
    fingerprint: 'abc123def456',
  };
}

test('AC-1: requirement-weakening is judged on this item\'s own revision, never on another item\'s reason', () => {
  // The only applied precedent of the trigger is another item's decision.
  const otherItem = precedentOf({
    id: 'dec-001', work: 'GY-118',
    reason: 'GY-118 retired AC-4 and moved AC-1 through AC-3 intact to GY-123',
  });
  const context = escalationContext({
    precedent: [otherItem],
    revisions: [{ seq: '42', at, actor: 'graphyard-master', decision: '9f2c1a34-1111-4222-8333-444444444444', changed: [
      { id: 'AC-2', before: { text: 'Audited', proofs: ['manual:audit', 'e2e:audit'] }, after: { text: 'Audited', proofs: ['manual:audit'] } },
      { id: 'AC-4', before: { text: 'Legacy export check', proofs: ['unit:legacy-export'] }, after: null },
    ] }],
  });

  // The generated reason names this item's changed criteria, before and after, and the decision that applied them.
  const judgement = followPrecedent(context);
  ok(judgement !== null, 'the built-in judgement resolves the requirement-weakening escalation');
  ok(judgement.reason.includes('GY-868 revision 5'), 'the reason names this item and its own revision');
  ok(judgement.reason.includes("AC-2 from 'Audited' to 'Audited'"), 'the reason states the narrowed criterion before and after');
  ok(judgement.reason.includes('(proofs manual:audit, e2e:audit to manual:audit)'), 'the reason states the narrowed proofs before and after');
  ok(judgement.reason.includes("AC-4 retired (was 'Legacy export check')"), 'the reason states the retired criterion as it was');
  ok(judgement.reason.includes('decision 9f2c1a34-1111-4222-8333-444444444444'), 'the reason names the decision that applied the revision');
  // No judgement copies the precedent's reason: the precedent is cited as the rule followed only.
  ok(judgement.reason.includes('dec-001'), 'the reason cites the precedent by id');
  ok(judgement.reason.includes('GY-118'), 'the reason cites the precedent by item');
  equal(judgement.reason.includes(otherItem.reason), false, 'the precedent reason is never copied');
  equal(judgement.reason.includes('GY-123'), false, 'no claim about the precedent item rides along');
  equal(judgement.precedent.length, 1); equal(judgement.precedent[0], 'dec-001');
  equal(judgement.followed!.work, 'GY-118');
  // The same judgement comes from the requirement-weakening judge itself.
  const own = followOwnRevision(context);
  ok(own !== null); equal(own.reason, judgement.reason);
});

test('AC-1: security-concern follows no judgement at all, so a judging session decides it', () => {
  const otherItem = precedentOf({
    id: 'dec-002', work: 'GY-800', trigger: 'security-concern',
    reason: 'GY-800 has a SQL injection vulnerability in the auth module',
  });
  const context = escalationContext({ key: 'GY-900', trigger: 'security-concern', precedent: [otherItem] });

  equal(followPrecedent(context), null, 'followPrecedent should return null for security-concern trigger');
});

test('AC-1: with no applied requirement-weakening decision to cite, the built-in judgement declines rather than invents one', () => {
  const requested = precedentOf({ id: 'dec-009', state: 'refused' });
  const context = escalationContext({ precedent: [requested] });
  equal(followPrecedent(context), null);
  equal(followOwnRevision(context), null, 'nothing applied of the trigger is no line to follow');
});

test('AC-1: without recorded revisions the judgement falls back to the standing escalation\'s own facts, never the precedent\'s', () => {
  const context = escalationContext({ reason: 'Requirement revision retires AC-2 and narrows proofs for AC-4' });
  const judgement = followPrecedent(context);
  ok(judgement !== null);
  ok(judgement.reason.includes('GY-868 revision 5'), 'the reason states this item\'s revision');
  ok(judgement.reason.includes('retires AC-2 and narrows proofs for AC-4'), 'the reason names this item\'s changed criteria');
  equal(judgement.reason.includes("moved AC-1 through AC-3 intact to GY-123"), false, 'the precedent reason is never copied');
});

test('AC-1: the requirements history is read as the ledger records it — before and after, retired and added, and the decision that applied it', () => {
  const decisionId = '3f2a1b0c-1111-4222-8333-444444444444';
  const rows: LedgerRow[] = [
    // A decision-applied revision: after-criteria on the event, the decision id quoted in its reason.
    { seq: '12', at, actor: 'graphyard-master', kind: 'requirements', details: { before: { plannedFiles: [] }, criteria: [{ id: 'AC-1', text: 'Narrowed', proofs: ['unit:narrow'] }], reason: `Narrow the criterion [decision ${decisionId}, requested by m, approved by a: ok]` } },
    // A loop-applied revision: the prior document as `before`, the new intent as `after`.
    { seq: '8', at, actor: 'graphyard-master', kind: 'requirements', details: { before: { criteria: [{ id: 'AC-1', text: 'Full', proofs: ['unit:full', 'e2e:full'] }, { id: 'AC-2', text: 'Audited', proofs: ['manual:audit'] }] }, intent: { criteria: [{ id: 'AC-1', text: 'Full', proofs: ['unit:full'] }] }, reason: 'retire AC-2 and narrow AC-1 proofs' } },
    // A directly applied revision: after-criteria only, no decision named.
    { seq: '4', at, actor: 'operator', kind: 'requirements', details: { before: { plannedFiles: [] }, criteria: [{ id: 'AC-1', text: 'Full', proofs: ['unit:full', 'e2e:full'] }], reason: 'initial narrowing' } },
    // Routine rows never appear as revisions.
    { seq: '2', at, actor: 'worker', kind: 'heartbeat', details: { epoch: 1 } },
  ];
  const revisions = requirementRevisions(rows);
  equal(revisions.length, 3, 'only requirements events are revisions');
  equal(revisions[0].seq, '12', 'newest first');
  equal(revisions[0].decision, decisionId, 'the decision that applied it is read from the applied reason');
  equal(revisions[0].changed.length, 0, 'without a recorded before-state nothing is claimed to have changed');
  equal(revisions[1].decision, null, 'a direct application names no decision');
  equal(revisions[1].changed.length, 2, 'each criterion whose text or proofs changed is named');
  equal(revisions[1].changed[0].id, 'AC-1');
  equal(revisions[1].changed[0].before!.proofs.join(','), 'unit:full,e2e:full');
  equal(revisions[1].changed[0].after!.proofs.join(','), 'unit:full');
  equal(revisions[1].changed[1].id, 'AC-2');
  equal(revisions[1].changed[1].after, null, 'a retired criterion has no after side');
  equal(revisions[2].seq, '4');
  equal(revisions[2].decision, null);
});

test('AC-1: the requirements history is bounded — the newest revisions only', () => {
  const rows: LedgerRow[] = Array.from({ length: 7 }, (_, index) => ({ seq: String(7 - index), at, actor: 'operator', kind: 'requirements', details: { criteria: [{ id: 'AC-1', text: `Text ${index}`, proofs: [] }] } }));
  const revisions = requirementRevisions(rows);
  equal(revisions.length, 5);
  equal(revisions[0].seq, '7', 'the newest are kept');
  equal(revisions.at(-1)!.seq, '3');
});

test('AC-1: the judgement names the applying requirements event when no decision applied the revision', () => {
  const context = escalationContext({
    revisions: [{ seq: '42', at, actor: 'graphyard-master', decision: null, changed: [{ id: 'AC-2', before: { text: 'Audited', proofs: ['manual:audit'] }, after: null }] }],
  });
  const judgement = followPrecedent(context);
  ok(judgement !== null);
  ok(judgement.reason.includes('requirements 42 by graphyard-master'), 'the applying event is named');
  ok(judgement.reason.includes("AC-2 retired (was 'Audited')"));
});

test('AC-2: lease-loss precedent names this item\'s key and epoch', () => {
  const otherItemPrecedent: PrecedentEntry = {
    id: 'dec-003',
    work: 'GY-100',
    trigger: 'lease-loss',
    state: 'applied',
    requestedBy: 'worker',
    requestedAt: at,
    reason: 'GY-100 epoch 2 lost its lease and cannot proceed',
    approvedBy: 'approver',
    approvalReason: 'approved',
    outcome: 'approved',
    refusals: 0,
    precedent: [],
    context: 'abc123',
  };

  const context = escalationContext({ key: 'GY-200', trigger: 'lease-loss', epoch: 3, revision: 2, precedent: [otherItemPrecedent] });

  const result = followPrecedent(context);
  ok(result !== null, 'followPrecedent should return a judgement for lease-loss');
  ok(result.reason.includes('GY-200'), 'reason should name this item\'s key (GY-200)');
  ok(result.reason.includes('epoch 3'), 'reason should name this item\'s epoch (3)');
  ok(result.reason.includes('dec-003'), 'reason should cite the precedent id');
  ok(result.reason.includes('GY-100'), 'reason should cite the precedent\'s item (GY-100)');
  equal(result.reason.includes(otherItemPrecedent.reason), false, 'the precedent\'s own claims are never quoted');
});

test('AC-2: lease-loss precedent does not copy other item\'s claims', () => {
  const otherItemPrecedent: PrecedentEntry = {
    id: 'dec-004',
    work: 'GY-150',
    trigger: 'lease-loss',
    state: 'applied',
    requestedBy: 'worker',
    requestedAt: at,
    reason: 'GY-150 (epoch 5, AC-1, AC-2) lost lease to worker-instance-9',
    approvedBy: 'approver',
    approvalReason: 'approved',
    outcome: 'approved',
    refusals: 0,
    precedent: [],
    context: 'abc123',
  };

  const context = escalationContext({ key: 'GY-250', trigger: 'lease-loss', epoch: 2, precedent: [otherItemPrecedent] });

  const result = followPrecedent(context);
  ok(result !== null, 'followPrecedent should return a judgement for lease-loss');
  // Should not copy the other item's specific claim about its epoch/criteria
  equal(result.reason.includes('epoch 5'), false, 'reason should not claim GY-150\'s epoch (5)');
  equal(result.reason.includes('AC-1'), false, 'reason should not claim GY-150\'s criterion ids');
  equal(result.reason.includes('AC-2'), false, 'reason should not claim GY-150\'s criterion ids');
  // Should cite the precedent item but not copy its facts as claims about this item
  ok(result.reason.includes('GY-150'), 'reason should cite the precedent\'s item (GY-150)');
  // Should state this item's facts
  ok(result.reason.includes('GY-250'), 'reason should name this item\'s key');
  ok(result.reason.includes('epoch 2'), 'reason should name this item\'s epoch');
});
