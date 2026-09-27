import { test } from 'node:test';
import { equal, ok } from 'node:assert';
import { followPrecedent, type EscalationContext, type PrecedentEntry } from '../src/model/escalation-context.js';

test('AC-1: requirement-weakening does not copy another item\'s reason', () => {
  // Build a context where a requirement-weakening precedent exists from another item
  const otherItemPrecedent: PrecedentEntry = {
    id: 'dec-001',
    work: 'GY-118',
    trigger: 'requirement-weakening',
    state: 'applied',
    requestedBy: 'approver',
    requestedAt: '2026-09-27T00:00:00Z',
    reason: 'GY-118 retired AC-4 and moved AC-1 through AC-3 intact to GY-123',
    approvedBy: 'approver',
    approvalReason: 'approved',
    outcome: 'approved',
    refusals: 0,
    precedent: [],
    context: 'abc123',
  };

  const context: EscalationContext = {
    version: 1,
    repository: 'graphyard',
    key: 'GY-868',
    action: 'resolve',
    escalation: { trigger: 'requirement-weakening', standing: true },
    rules: { source: { path: 'docs/rules', ref: 'main', sha: null }, text: null, unavailable: null, policy: { checks: ['test'], review: true } },
    goals: { priority: 1, intents: [], graph: [], graphOmitted: [], dependencies: [], dependents: [] },
    item: {
      key: 'GY-868',
      title: 'Test item',
      type: 'bug',
      description: '',
      stage: 'review',
      ready: true,
      revision: 5,
      policyRevision: 1,
      epoch: 1,
      createdAt: '2026-09-27T00:00:00Z',
      criteria: [{ id: 'AC-1', text: 'Something changed', proofs: [] }],
      retiredCriterionIds: [],
      plannedFiles: [],
      producerProofs: [],
      exclusiveResources: [],
      dependencies: [],
      refusal: { escalation: { trigger: 'requirement-weakening', standing: true }, standing: [], gates: [], blocker: null, violations: [] },
      candidate: null,
      submission: null,
      lease: null,
      implementers: [],
      history: { total: 10, kinds: [], recent: [], omitted: 0 },
    },
    precedent: {
      action: 'resolve',
      total: 1,
      matching: 1,
      detail: [otherItemPrecedent],
      summary: [],
      omitted: 0,
    },
    budget: { limit: 32000, level: { recent: 40, detail: 20 }, exceeded: null, assembled: null, omitted: [] },
    fingerprint: 'abc123def456',
  };

  const result = followPrecedent(context);
  equal(result, null, 'followPrecedent should return null for requirement-weakening trigger');
});

test('AC-1: security-concern does not copy another item\'s reason', () => {
  const otherItemPrecedent: PrecedentEntry = {
    id: 'dec-002',
    work: 'GY-800',
    trigger: 'security-concern',
    state: 'applied',
    requestedBy: 'approver',
    requestedAt: '2026-09-27T00:00:00Z',
    reason: 'GY-800 has a SQL injection vulnerability in the auth module',
    approvedBy: 'approver',
    approvalReason: 'approved',
    outcome: 'approved',
    refusals: 0,
    precedent: [],
    context: 'abc123',
  };

  const context: EscalationContext = {
    version: 1,
    repository: 'graphyard',
    key: 'GY-900',
    action: 'resolve',
    escalation: { trigger: 'security-concern', standing: true },
    rules: { source: { path: 'docs/rules', ref: 'main', sha: null }, text: null, unavailable: null, policy: { checks: ['test'], review: true } },
    goals: { priority: 1, intents: [], graph: [], graphOmitted: [], dependencies: [], dependents: [] },
    item: {
      key: 'GY-900',
      title: 'Test item',
      type: 'bug',
      description: '',
      stage: 'review',
      ready: true,
      revision: 3,
      policyRevision: 1,
      epoch: 1,
      createdAt: '2026-09-27T00:00:00Z',
      criteria: [{ id: 'AC-1', text: 'Something security-related', proofs: [] }],
      retiredCriterionIds: [],
      plannedFiles: [],
      producerProofs: [],
      exclusiveResources: [],
      dependencies: [],
      refusal: { escalation: { trigger: 'security-concern', standing: true }, standing: [], gates: [], blocker: null, violations: [] },
      candidate: null,
      submission: null,
      lease: null,
      implementers: [],
      history: { total: 5, kinds: [], recent: [], omitted: 0 },
    },
    precedent: {
      action: 'resolve',
      total: 1,
      matching: 1,
      detail: [otherItemPrecedent],
      summary: [],
      omitted: 0,
    },
    budget: { limit: 32000, level: { recent: 40, detail: 20 }, exceeded: null, assembled: null, omitted: [] },
    fingerprint: 'xyz789abc',
  };

  const result = followPrecedent(context);
  equal(result, null, 'followPrecedent should return null for security-concern trigger');
});

test('AC-2: lease-loss precedent names this item\'s key and epoch', () => {
  const otherItemPrecedent: PrecedentEntry = {
    id: 'dec-003',
    work: 'GY-100',
    trigger: 'lease-loss',
    state: 'applied',
    requestedBy: 'worker',
    requestedAt: '2026-09-27T00:00:00Z',
    reason: 'GY-100 epoch 2 lost its lease and cannot proceed',
    approvedBy: 'approver',
    approvalReason: 'approved',
    outcome: 'approved',
    refusals: 0,
    precedent: [],
    context: 'abc123',
  };

  const context: EscalationContext = {
    version: 1,
    repository: 'graphyard',
    key: 'GY-200',
    action: 'resolve',
    escalation: { trigger: 'lease-loss', standing: true },
    rules: { source: { path: 'docs/rules', ref: 'main', sha: null }, text: null, unavailable: null, policy: { checks: ['test'], review: true } },
    goals: { priority: 1, intents: [], graph: [], graphOmitted: [], dependencies: [], dependents: [] },
    item: {
      key: 'GY-200',
      title: 'Test item',
      type: 'feature',
      description: '',
      stage: 'build',
      ready: true,
      revision: 2,
      policyRevision: 1,
      epoch: 3,
      createdAt: '2026-09-27T00:00:00Z',
      criteria: [{ id: 'AC-1', text: 'Something', proofs: [] }],
      retiredCriterionIds: [],
      plannedFiles: [],
      producerProofs: [],
      exclusiveResources: [],
      dependencies: [],
      refusal: { escalation: { trigger: 'lease-loss', standing: true }, standing: [], gates: [], blocker: null, violations: [] },
      candidate: null,
      submission: null,
      lease: null,
      implementers: [],
      history: { total: 8, kinds: [], recent: [], omitted: 0 },
    },
    precedent: {
      action: 'resolve',
      total: 1,
      matching: 1,
      detail: [otherItemPrecedent],
      summary: [],
      omitted: 0,
    },
    budget: { limit: 32000, level: { recent: 40, detail: 20 }, exceeded: null, assembled: null, omitted: [] },
    fingerprint: 'def456ghi789',
  };

  const result = followPrecedent(context);
  ok(result !== null, 'followPrecedent should return a judgement for lease-loss');
  ok(result.reason.includes('GY-200'), 'reason should name this item\'s key (GY-200)');
  ok(result.reason.includes('epoch 3'), 'reason should name this item\'s epoch (3)');
  ok(result.reason.includes('dec-003'), 'reason should cite the precedent id');
  ok(result.reason.includes('GY-100'), 'reason should cite the precedent\'s item (GY-100)');
});

test('AC-2: lease-loss precedent does not copy other item\'s claims', () => {
  const otherItemPrecedent: PrecedentEntry = {
    id: 'dec-004',
    work: 'GY-150',
    trigger: 'lease-loss',
    state: 'applied',
    requestedBy: 'worker',
    requestedAt: '2026-09-27T00:00:00Z',
    reason: 'GY-150 (epoch 5, AC-1, AC-2) lost lease to worker-instance-9',
    approvedBy: 'approver',
    approvalReason: 'approved',
    outcome: 'approved',
    refusals: 0,
    precedent: [],
    context: 'abc123',
  };

  const context: EscalationContext = {
    version: 1,
    repository: 'graphyard',
    key: 'GY-250',
    action: 'resolve',
    escalation: { trigger: 'lease-loss', standing: true },
    rules: { source: { path: 'docs/rules', ref: 'main', sha: null }, text: null, unavailable: null, policy: { checks: ['test'], review: true } },
    goals: { priority: 1, intents: [], graph: [], graphOmitted: [], dependencies: [], dependents: [] },
    item: {
      key: 'GY-250',
      title: 'Test item',
      type: 'feature',
      description: '',
      stage: 'build',
      ready: true,
      revision: 1,
      policyRevision: 1,
      epoch: 2,
      createdAt: '2026-09-27T00:00:00Z',
      criteria: [{ id: 'AC-5', text: 'Something else', proofs: [] }],
      retiredCriterionIds: [],
      plannedFiles: [],
      producerProofs: [],
      exclusiveResources: [],
      dependencies: [],
      refusal: { escalation: { trigger: 'lease-loss', standing: true }, standing: [], gates: [], blocker: null, violations: [] },
      candidate: null,
      submission: null,
      lease: null,
      implementers: [],
      history: { total: 3, kinds: [], recent: [], omitted: 0 },
    },
    precedent: {
      action: 'resolve',
      total: 1,
      matching: 1,
      detail: [otherItemPrecedent],
      summary: [],
      omitted: 0,
    },
    budget: { limit: 32000, level: { recent: 40, detail: 20 }, exceeded: null, assembled: null, omitted: [] },
    fingerprint: 'ghi789jkl012',
  };

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
