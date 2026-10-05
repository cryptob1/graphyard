import { z } from 'zod';
import { deploySmokeProof, proofSchema } from './proof.js';
import { postMergeProofRefusal } from './post-merge-proofs.js';
import { distinct, reviewProviders, reviewerProfileSchema } from './review.js';

// ---- Risk lanes (GY-883) -------------------------------------------------------------------------

/**
 * The ceremony an item runs is decided by the risk of what it changes, not by one high-ceremony
 * path for everything. `low` lands with its required CI checks green and one approving review —
 * catch-and-revert suits it; `medium` adds its producer-run proofs; `high` keeps the full path,
 * producer proofs, manual attestations and approver decisions alike (`laneRequirements`).
 */
export const lanes = ['low', 'medium', 'high'] as const;
export type Lane = typeof lanes[number];

/**
 * The shipped high-risk path policy: any changed path under one of these makes the change high.
 * The installation and deployment surfaces are the repository's own: installation changes go
 * through `src/install/` and deployment through the `deploy/` tree, the Dockerfile and
 * compose.yaml. The schema and credential surfaces are the repository's real ones: the database
 * schema and its persistence layer under `src/store/`, authentication and principals under
 * `src/server/`, beside the public-API routes and the assembler that wires them
 * (`src/server/index.ts`); the server bootstrap that loads credentials (`src/server/main.ts`), the
 * operator agent's credential handling (`src/operator-agent.ts`) and the proof-authority grants
 * (`src/proof-grants.ts`).
 */
export const highRiskPaths = [
  /^migrations\/schema/, /^auth\/credentials/,
  /^src\/store\//, /^src\/server\/(routes|auth|principals|index|main)/,
  /^src\/operator-agent\.ts$/, /^src\/proof-grants\.ts$/,
  /^src\/install\//, /^deploy\//, /^Dockerfile(\.|$)/, /^compose\.ya?ml$/,
] as const;

/** The shipped low-risk path policy: a change only of tests or of docs is low. */
export const testOnlyPaths = /(^|\/)(tests?|__tests__)\/|\.test\.[A-Za-z]+$|\.spec\.[A-Za-z]+$/;
export const docsOnlyPaths = /^docs\/|(^|\/)README\.md$|^AGENTS\.md$|\.mdx?$/;

/**
 * The lane one change rides in, from the shipped path policy: any high-risk path makes the change
 * high; a change only of tests or only of docs is low; a change kept inside one module — every
 * path sharing the same leading segments, such as `src/model/` — is low; everything else is
 * medium. An unknown change (no paths at all) is high: until the policy can see what a change
 * touches, it keeps the full path — no proof, attestation or approver is waived for it. The shared prefix counts only up to the first segment
 * where the paths diverge: `src/model/index.ts` and `src/cli/index.ts` share `src/` and nothing
 * past it, so they are two modules, not one.
 */
export function determineLane(paths: readonly string[]): Lane {
  const changed = [...new Set(paths)];
  if (!changed.length) return 'high';
  if (changed.some(path => highRiskPaths.some(pattern => pattern.test(path)))) return 'high';
  if (changed.every(path => testOnlyPaths.test(path) || docsOnlyPaths.test(path))) return 'low';
  const segments = changed.map(path => path.split('/').filter(Boolean));
  const first = segments[0];
  let shared = 0;
  while (shared < first.length && segments.every(parts => parts[shared] === first[shared])) shared++;
  return shared >= 2 ? 'low' : 'medium';
}

/**
 * The shipped per-lane speed targets: the submit→merge p50 each lane is expected to meet, in
 * milliseconds, reported beside its lane. They split the pipeline target (GY-54) by lane: the
 * smaller the change, the faster it is expected to land.
 */
export const laneSpeedTargets: Record<Lane, number> = { low: 30 * 60_000, medium: 60 * 60_000, high: 4 * 60 * 60_000 };

/**
 * What each lane's landability asks for beyond the gates every lane keeps (ready, build, review,
 * test, merge): which proof families the verdict requires of the change, and whether a rework
 * round waits for an approved two-party decision. Low lands with its required CI checks green and
 * one approving review — the producer-run proofs and manual attestations its criteria name are not
 * required of it, and its reworks are applied without an approver; medium adds its producer-run
 * proofs; high keeps the full path: producer proofs, manual attestations and approver decisions.
 */
export interface LaneRequirements { producerProofs: boolean; manualAttestations: boolean; reworkApprover: boolean }
export function laneRequirements(lane: Lane): LaneRequirements {
  return lane === 'low' ? { producerProofs: false, manualAttestations: false, reworkApprover: false }
    : lane === 'medium' ? { producerProofs: true, manualAttestations: false, reworkApprover: false }
    : { producerProofs: true, manualAttestations: true, reworkApprover: true };
}

/**
 * GY-1101: the automatable proof families collected against a release candidate rather than per
 * pull request. A merged item's `integration:` and `e2e:` proofs run once against the first release
 * candidate that contains its merge commit (model/release.ts); they never hold its merge. Only
 * `unit:` proofs (GY-1093's pre-merge set) and `manual:` attestations stay pre-merge.
 */
export const releaseCandidateFamilies = ['integration', 'e2e'] as const;
export const proofFamily = (proof: string) => proof.slice(0, Math.max(0, proof.indexOf(':')));
export const releaseCandidateProof = (proof: string) => (releaseCandidateFamilies as readonly string[]).includes(proofFamily(proof));

/**
 * Whether the lane requires one proof family of the change before it merges: producer-run `unit:`
 * proofs from medium and `manual:` attestations only in high. `integration:` and `e2e:` are never
 * merge requirements in any lane (GY-1101): they are release-candidate proofs.
 */
export function laneRequiresFamily(lane: Lane, family: string): boolean {
  const requirements = laneRequirements(lane);
  return family === 'unit' ? requirements.producerProofs
    : family === 'manual' ? requirements.manualAttestations
    : !(releaseCandidateFamilies as readonly string[]).includes(family);
}
export const laneRequiresProof = (lane: Lane, proof: string) => laneRequiresFamily(lane, proofFamily(proof));

/**
 * The changed paths an item's lane is decided from: every observed scope file's path and, for a
 * rename, both of its endpoints — a rename out of a high-risk tree is a change to the high-risk
 * surface whatever its destination, so the source rides beside it. The observation's file list is
 * the diff when no scope was read at all; an empty scope list is no paths, the unknown change that
 * keeps the full (high) path.
 */
export function observedPaths(observation: { scopeFiles?: readonly { path: string; previousPath?: string }[] | null; files?: readonly string[] } | null | undefined): string[] {
  if (!observation) return [];
  return observation.scopeFiles
    ? observation.scopeFiles.flatMap(file => file.previousPath && file.previousPath !== file.path ? [file.path, file.previousPath] : [file.path])
    : [...(observation.files ?? [])];
}

/** The lane of the change an item carries: the diff its observation holds; an unknown change rides high. */
export function itemLane(work: { observation?: Parameters<typeof observedPaths>[0] }): Lane {
  return determineLane(observedPaths(work.observation));
}

/**
 * Whether a rework round on this item waits for an independent approver (GY-883 AC-2): only in the
 * high lane. A low or medium item's rework decision is applied as soon as it is requested, with the
 * lane recorded as its ground — the requester's own authority to request it is checked as ever. A
 * change nobody has observed rides high, so it keeps its approver.
 */
export const reworkNeedsApprover = (work: Parameters<typeof itemLane>[0]) => laneRequirements(itemLane(work)).reworkApprover;

// Bootstrap mode: an operator may defer a criterion's proofs for the single change that
// introduces the harness those proofs depend on. The proof is never dropped. It becomes a
// standing obligation on the named contract paths, and the next change touching those paths
// inherits it as a required proof. Workers can never declare it.
export const bootstrapDeclarationSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  contractPaths: z.array(z.string().trim().min(1).max(500)).min(1).max(20)
    .refine(paths => new Set(paths).size === paths.length, 'Bootstrap contract paths must be unique'),
}).strict();
export type BootstrapDeclaration = z.infer<typeof bootstrapDeclarationSchema>;
export const criterionSchema = z.object({ id: z.string().regex(/^AC-\d+$/), text: z.string().min(1).max(2000), proofs: z.array(proofSchema).min(1).max(20), bootstrap: bootstrapDeclarationSchema.optional() }).strict()
  .refine(criterion => !criterion.proofs.includes(deploySmokeProof), `${deploySmokeProof} runs after delivery; require it with policy.deploySmoke instead of an acceptance criterion`)
  // Any other proof that can only pass after merge is refused the same way (GY-188).
  .superRefine((criterion, context) => { const refusal = postMergeProofRefusal(criterion); if (refusal) context.addIssue({ code: 'custom', message: refusal, path: ['proofs'] }); });
/** Stored declaration. The audit fields are stamped by the control plane, never by the client. */
export interface BootstrapMode extends BootstrapDeclaration { declaredBy: string; declaredAt: string; policyRevision: number }
export interface Criterion { id: string; text: string; proofs: string[]; bootstrap?: BootstrapMode }
export const policySchema = z.object({
  checks: z.array(z.string().min(1).max(200)).min(1).max(30).default(['test', 'typecheck']),
  review: z.boolean().default(true),
  reviewProvider: z.enum(reviewProviders).optional(),
  reviewerProfiles: z.array(reviewerProfileSchema).min(1).max(10).optional(),
  // Optional second confidence layer after trunk: a trusted producer smoke-tests the live
  // deployment once it serves this item's merge commit. It never gates the merge itself.
  deploySmoke: z.boolean().optional(),
}).strict().superRefine((policy, context) => {
  if (policy.reviewProvider !== 'agent') {
    if (policy.reviewerProfiles) context.addIssue({ code: 'custom', message: 'Reviewer profiles require reviewProvider "agent"', path: ['reviewerProfiles'] });
    return;
  }
  if (!policy.review) context.addIssue({ code: 'custom', message: 'Agent review requires review: true', path: ['review'] });
  const profiles = policy.reviewerProfiles ?? [];
  if (!profiles.length) context.addIssue({ code: 'custom', message: 'Agent review requires at least one reviewer profile', path: ['reviewerProfiles'] });
  if (!distinct(profiles.map(profile => profile.name))) context.addIssue({ code: 'custom', message: 'Reviewer profile names must be unique', path: ['reviewerProfiles'] });
  // One identity per profile keeps a verdict attributable to exactly one profile.
  if (!distinct(profiles.map(profile => profile.reviewerApp))) context.addIssue({ code: 'custom', message: 'Each reviewer profile must name a distinct registered reviewer App', path: ['reviewerProfiles'] });
});
export const resourcesSchema = z.array(z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/).max(200)).max(30).refine(v => new Set(v).size === v.length, 'Resource names must be unique');
