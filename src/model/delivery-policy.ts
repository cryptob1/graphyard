import type { z } from 'zod';
import type { gateCheckSchema, mergeGateSchema, deliveryPolicySchema } from '../model-boundary/delivery-policy.js';
// ---------------------------------------------------------------------------
// The delivery model every installed repository gets (GY-1102).
//
// Graphyard delivers itself through a fast merge gate and release candidates (GY-1093, GY-1094):
// pull requests merge on build, typecheck and fast unit checks alone; the long suites — integration,
// E2E, soak — run against a pinned candidate SHA cut from main, which deploys to UAT and is promoted
// to production by that exact SHA only after UAT passed. `graphyard init` classifies a managed
// repository's checks into those two sets and records the result, with the deployment adapter and
// the candidate cadence, as `delivery` in the repository's committed graphyard.json. A repository
// opts out to the plain per-PR model with `"mode": "per-pr"`: every check stays required on pull
// requests and no candidate workflow is generated. `"mode": "local"` (GY-1901, the default a
// control-plane install proposes) is the rapid path the control plane runs itself: local previews
// of the declared applications, candidates of at most five changes and required verification of the
// exact live release, with no generated GitHub Actions workflow and no Railway adapter.
// ---------------------------------------------------------------------------

export const deliveryModes = ['local', 'release-candidate', 'per-pr'] as const;
export type DeliveryMode = (typeof deliveryModes)[number];
export const deploymentAdapters = ['railway', 'command'] as const;
export type GateCheck = z.infer<typeof gateCheckSchema>;
export type MergeGate = z.infer<typeof mergeGateSchema>;
export type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;

/** The default cadence, matching Graphyard's own release-candidate workflow. */
export const defaultCandidateSchedule = '0 */6 * * *';

/**
 * The checks branch protection requires on pull requests for a policy: the pre-merge set under
 * the candidate model, and every classified check under the per-PR opt-out.
 */
export const requiredPullRequestChecks = (policy: DeliveryPolicy) =>
  policy.mode === 'per-pr' ? [...policy.mergeGate.preMerge, ...policy.mergeGate.perCandidate].map(entry => entry.check) : policy.mergeGate.preMerge.map(entry => entry.check);

/** The rapid path's committed defaults (GY-1901): what normal onboarding writes for the local mode. */
export const localDeliveryDefaults = { previews: 'local', candidateMaxChanges: 5, productionVerification: true } as const;

/** The two workflow files `init --apply` generates under the candidate model. */
export const candidateWorkflowFile = '.github/workflows/graphyard-release-candidate.yml';
export const promotionWorkflowFile = '.github/workflows/graphyard-promotion.yml';
export const generatedWorkflowFiles = [candidateWorkflowFile, promotionWorkflowFile] as const;
