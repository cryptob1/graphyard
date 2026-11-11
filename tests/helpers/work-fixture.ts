import type { Work } from '../../src/model/work.js';

/**
 * A valid current Work document (src/model-boundary/work.ts `storedWorkSchema` accepts it): a
 * released feature at ready with no lease, candidate or observation.
 * Pass only what a test is about; `id` follows `key` unless given.
 */
export function workFixture(overrides: Partial<Work> & Record<string, unknown> = {}): Work {
  const at = new Date().toISOString(), key = overrides.key ?? 'GY-1';
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true },
    systemDriven: true, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
    ...overrides,
  } as Work;
}
