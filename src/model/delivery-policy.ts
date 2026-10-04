import { z } from 'zod';

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
// requests and no candidate workflow is generated.
// ---------------------------------------------------------------------------

export const deliveryModes = ['release-candidate', 'per-pr'] as const;
export type DeliveryMode = (typeof deliveryModes)[number];
export const deploymentAdapters = ['railway', 'command'] as const;
export type DeploymentAdapterName = (typeof deploymentAdapters)[number];

/** One classified check: its name, the command that runs it when one is known, and why it sits where it does. */
export const gateCheckSchema = z.object({
  check: z.string().trim().min(1).max(100),
  command: z.string().max(500).nullable(),
  source: z.enum(['script', 'workflow', 'framework']),
  reason: z.string().max(300),
}).strict();
export type GateCheck = z.infer<typeof gateCheckSchema>;

export const mergeGateSchema = z.object({
  /** Required on every pull request: build, typecheck, lint and fast unit checks only. */
  preMerge: z.array(gateCheckSchema).max(20),
  /** Run once per release candidate against its pinned SHA, never as a pull-request requirement. */
  perCandidate: z.array(gateCheckSchema).max(20),
}).strict();
export type MergeGate = z.infer<typeof mergeGateSchema>;

const cron = z.string().trim().regex(/^\S+(?: \S+){4}$/, 'candidateSchedule is a five-field cron expression, or null for on-demand candidates only');

export const deliveryPolicySchema = z.object({
  mode: z.enum(deliveryModes),
  mergeGate: mergeGateSchema,
  /** When the candidate workflow cuts main's tip; null cuts on demand (workflow_dispatch) only. */
  candidateSchedule: cron.nullable(),
  deploy: z.object({
    adapter: z.enum(deploymentAdapters),
    /** Railway only: the existing project whose uat and production environments the adapter uses; null plans a new one. */
    project: z.string().trim().min(1).max(200).nullable().default(null),
    /** Command adapter only: the command that deploys $GRAPHYARD_CANDIDATE_SHA to UAT, and to production. Never guessed. */
    uat: z.string().trim().min(1).max(1000).nullable().default(null),
    production: z.string().trim().min(1).max(1000).nullable().default(null),
  }).strict(),
}).strict();
export type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;

/** The default cadence, matching Graphyard's own release-candidate workflow. */
export const defaultCandidateSchedule = '0 */6 * * *';

/**
 * The checks branch protection requires on pull requests for a policy: the pre-merge set under
 * the candidate model, and every classified check under the per-PR opt-out.
 */
export const requiredPullRequestChecks = (policy: DeliveryPolicy) =>
  policy.mode === 'per-pr' ? [...policy.mergeGate.preMerge, ...policy.mergeGate.perCandidate].map(entry => entry.check) : policy.mergeGate.preMerge.map(entry => entry.check);

/** The two workflow files `init --apply` generates under the candidate model. */
export const candidateWorkflowFile = '.github/workflows/graphyard-release-candidate.yml';
export const promotionWorkflowFile = '.github/workflows/graphyard-promotion.yml';
export const generatedWorkflowFiles = [candidateWorkflowFile, promotionWorkflowFile] as const;
