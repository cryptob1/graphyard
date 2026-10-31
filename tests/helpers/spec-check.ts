import type { SpecCheck } from '../../src/model/spec-check.js';

/**
 * A standing ready spec check (GY-2992) for a fixture of a released feature item: the report the
 * item's check posted before it dispatched. A fixture without one is held at ready, exactly as a
 * released feature is until its spec check reports.
 */
export const readySpecCheck = (at: string, policyRevision = 1): SpecCheck =>
  ({ policyRevision, verdict: 'ready', paraphrase: 'The fixture builds what its criteria name; each is proven by its own proof.', gaps: [], reviewer: 'spec-checker', at });
