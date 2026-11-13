import { z } from 'zod';
import { workspacePath, validBranch } from '../../workspace.js';
import { createSchema } from '../../model-boundary/work.js';
import { criteriaSchema, resourcesSchema } from '../../model-boundary/policy.js';
import { proofExerciseSchema } from '../../model-boundary/evidence.js';
import { proofSchema } from '../../model-boundary/proof.js';
import { filingRefusal } from '../../model-boundary/user-facing.js';
import { physicalCheckRefusal } from '../../model/human-proof.js';
import { agentRequestSchema } from '../../model-boundary/agent-requests.js';
import { sessionHandleSchema } from '../../model-boundary/sessions.js';
import { partialWorkSchema } from '../../model-boundary/capacity.js';

const epoch = z.number().int().positive();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
// GY-3037: the e2e proof every item carries at create, and the serve declaration an e2e: proof
// needs in the repository it is created in. Both refuse at parse time, before any scenario is
// resolved; the same validation is `filingRefusal` (model/user-facing.ts).
const filingCreateRefusal = filingRefusal;
const publicArtifactUrl = z.url().max(2000).refine(value => {
  const parsed = new URL(value);
  return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
}, 'Artifact URLs must be HTTP(S) and contain no credentials');
const evidenceArtifact = z.object({
  kind: z.enum(['log', 'report', 'screenshot', 'trace', 'other']), label: z.string().trim().min(1).max(200),
  mediaType: z.string().trim().min(1).max(200).optional(), size: z.number().int().min(0).optional(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), expiresAt: z.iso.datetime().optional(),
  availability: z.enum(['available', 'expired', 'redacted', 'missing', 'upload-failed', 'external']), url: publicArtifactUrl.optional(),
}).strict().refine(value => value.availability === 'external' ? !!value.url : !value.url, 'Only external artifacts may carry a public URL');
// Retired scope-permission fields remain accepted for old intents.
const retiredField = z.unknown().transform(() => undefined).optional();
// GY-2968: one failing case a rerun set aside — where the run located it and the timing it gave.
const rerunCase = z.object({ case: z.string().trim().min(1).max(500), file: z.string().trim().min(1).max(500).nullable(), line: z.number().int().positive().nullable(), durationMs: z.number().int().min(0).nullable() }).strict();
export const commands = {
  create: createSchema.extend({ reason: z.string().trim().min(1).max(2000).optional() })
    .superRefine((data, ctx) => { const refusal = data.criteria.length ? filingCreateRefusal(data) ?? physicalCheckRefusal(data.criteria) : null; if (refusal) ctx.addIssue({ code: 'custom', message: refusal }); }),
  priority: z.union([
    z.object({ priority: z.number().int().min(0).max(3), reason: z.string().trim().min(1).max(2000) }).strict(),
    z.object({ priority: z.number().int().min(0).max(3), source: z.literal('dashboard') }).strict(),
  ]),
  ready: z.object({ expectedRevision: z.number().int().positive().optional(), reason: z.string().trim().min(1).max(2000).optional(), by: z.literal('loop').optional() }).strict(),
  requirements: z.object({ owner: createSchema.shape.owner, description: createSchema.shape.description.optional(), expectedPolicyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000), criteria: criteriaSchema(50), dependencies: z.array(z.string().uuid()).max(50), plannedFiles: createSchema.shape.plannedFiles, answers: retiredField, rule: retiredField, exclusiveResources: resourcesSchema, producerProofs: createSchema.shape.producerProofs }).strict(),
  unblock: z.object({ reason: z.string().trim().min(1).max(2000), expectedRevision: z.number().int().positive().optional() }).strict(),
  // GY-3298: hold a released item out of dispatch (release clears it), and message its worker.
  hold: z.object({ reason: z.string().trim().min(1).max(2000), expectedRevision: z.number().int().positive().optional() }).strict(),
  message: z.object({ text: z.string().trim().min(1).max(4000) }).strict(),
  rework: z.object({ reason: z.string().trim().min(1).max(2000), previousWorkerStopped: z.literal(true), binding: z.string().min(1).max(500).optional() }).strict(),
  claim: z.object({}).strict(),
  // GY-3266: a heartbeat may carry the policy revision the worker has synced — the worker's sync
  // sends it to acknowledge a requirements revision recorded under its live lease, which complete
  // refuses until then.
  heartbeat: z.object({ epoch, syncedPolicyRevision: z.number().int().positive().optional(), acknowledgedMessages: z.array(z.string().min(1).max(20)).max(200).optional() }).strict(),
  // GY-860 AC-2: `failure` releases a claim whose worktree the host could not create. The attempt
  // is undone — the epoch returns, the untouched reservation and timeline entry go, the lease is
  // released — and the ledger keeps the git message, so the failure is on the item without
  // consuming an attempt or cooling off the profile.
  // `cause` is why the attempt ended, for a release its watch supervisor makes after the session is
  // gone (GY-1008): it is kept on the release event and never stands as a blocker on the item.
  release: z.object({ epoch, cause: z.string().trim().min(1).max(2000).optional(), failure: z.object({ message: z.string().trim().min(1).max(2000) }).strict().optional() }).strict(),
  // GY-860: what this allocation released before it could create its worktree — an earlier
  // attempt's worktree that still held the branch, with the refs and uncommitted diff it carried.
  // The record is the item's preserved-attempt history, kept on the ledger.
  workspace: z.object({ epoch, host: z.string().trim().min(1).max(200), path: z.string().startsWith('/').max(1000).refine(p => !/[\u0000-\u001f]/.test(p), 'Invalid path').transform(workspacePath), branch: z.string().max(255).refine(validBranch, 'Invalid Graphyard branch name'),
    preserved: z.object({ path: z.string().min(1).max(1000), head: z.string().regex(/^[0-9a-f]{40}$/i), branchTip: z.string().regex(/^[0-9a-f]{40}$/i), op: z.enum(['rebase', 'merge', 'cherry-pick']).nullable(), refs: z.string().max(20000), diff: z.string().max(100000), at: z.iso.datetime() }).strict().optional() }).strict(),
  // GY-1523: exactly one of `pr` (accepted only where GitHub observed it) or `head` (the control plane's own observation).
  // GY-2968: what complete's automatic rerun set aside when it accepted the head — the failing
  // cases outside the item's proofs that passed on their immediate retry (`flaked`), and those the
  // base fails too (`baseFailures`), each named where the run located it, with the runner's timing.
  // GY-2980: the note a rerun fault records — the reason the rerun could not judge the head, with
  // the run's last 20 lines. A fact on the item's history; the merge trial judges the head.
  submit: z.object({ epoch, pr: z.number().int().positive().optional(), head: sha.optional(),
    flaked: z.array(rerunCase).max(50).optional(), baseFailures: z.array(rerunCase).max(50).optional(),
    rerunUnjudged: z.object({ note: z.string().trim().min(1).max(500), output: z.string().max(20000) }).strict().optional() }).strict()
    .superRefine((data, ctx) => { if ((data.pr === undefined) === (data.head === undefined)) ctx.addIssue({ code: 'custom', message: 'A submission names exactly one of pr (a pull request number) or head (a 40-hex commit)' }); }),
  // `partialWork` is how the worker's CLI kept what the attempt had not committed before the
  // blocker ended it (GY-1008): the same record an interrupted attempt carries.
  blocked: z.object({ epoch, reason: z.string().max(2000).nullable(), partialWork: partialWorkSchema.optional() }).strict(),
  // GY-1726: a post-deploy follow-up whose reading cannot exist before `notBefore` ends its attempt
  // and waits for that instant, with no blocker and no intervention: the loop dispatches it then.
  defer: z.object({ epoch, notBefore: z.string().datetime({ offset: true }), reason: z.string().trim().min(1).max(2000) }).strict(),
  // GY-1740: the master's (or the loop's) hold of an unleased post-deploy follow-up on the instant its
  // reading can first exist: the observation window `defer` sets, with no lease, and the recorded blocker cleared.
  window: z.object({ notBefore: z.string().datetime({ offset: true }), reason: z.string().trim().min(1).max(2000), expectedRevision: z.number().int().positive() }).strict(),
  // `scopeFiles` is the producer's declaration of what the proof depends on, in the planned-files
  // scope syntax; a base refresh carries a proof across its own authored merge only inside it.
  evidence: z.object({ proof: proofSchema, sha, baseSha: sha, policyRevision: z.number().int().positive(), result: z.enum(['pass', 'fail']), executed: z.number().int().min(0), skipped: z.number().int().min(0), url: publicArtifactUrl.optional(),
    // GY-3238: why the master attests a manual: proof, recorded on the evidence and the ledger.
    reason: z.string().trim().min(1).max(2000).optional(), artifacts: z.array(evidenceArtifact).max(30).optional(), scenarioRevision: z.number().int().positive().optional(), environment: z.string().min(1).max(100).optional(),
    scopeFiles: z.array(z.string().min(1).max(500)).min(1).max(100).optional(), provenance: z.object({
    provider: z.literal('github-actions'), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), workflowCommit: sha,
    runId: z.string().regex(/^[1-9]\d*$/), runAttempt: z.number().int().positive(),
    artifact: z.object({ id: z.number().int().positive(), name: z.string().min(1).max(200), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), url: publicArtifactUrl, createdAt: z.iso.datetime() }).strict(),
  }).strict().optional(),
    // GY-135: the same proof run against a tree with its criterion's behaviour removed.
    exercise: proofExerciseSchema.optional() }).strict(),
  // GY-1779: the loop's own reading of a loop-owned observation item's proof on the serving release,
  // recorded through the coordinator by its deployment-verification step: `sha` is the release the
  // control plane observed serving the parent delivery's merge `baseSha`; `detail` names the measured values.
  reading: z.object({ proof: proofSchema, sha, baseSha: sha, policyRevision: z.number().int().positive(), result: z.enum(['pass', 'fail']), detail: z.string().trim().min(1).max(2000) }).strict(),
  revoke: z.object({ proof: proofSchema, sha, baseSha: sha, policyRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) }).strict(),
  // The durable handle a launched session records on the item: its runtime and host, the runtime's
  // own workspace, tab and pane, and the transcript it writes. A fact, never authority; see model/sessions.ts.
  session: sessionHandleSchema,
  // A typed ask recorded instead of blocking on a prose question. The decider is derived, the
  // attempt ends in the same transaction, and the item is free again; see model/agent-requests.ts.
  request: agentRequestSchema,
  // The coordinator — the master loop's operator-agent identity — asking the control plane to merge
  // the base tip it names into a candidate a repaired base failure held (GY-528). The reconciliation
  // job runs it and records it on `baseRefresh`, where the binding carry decides what the head keeps.
  // No `mergerefused`: GitHub merges on every passing gate (GY-1235) and Graphyard keeps no guarded
  // merge (GY-1236), so nothing reports a merge refusal and none sends a candidate back (GY-1391).
} as const;
const executorName = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
// A resync names the instant its claim was made, so the answer says whether an observation saved
// since then satisfies it; `wake: false` only reads, for an executor waiting on the job it woke.
export const resyncSchema = z.object({ since: z.string().datetime({ offset: true }).optional(), wake: z.boolean().optional(), prioritized: z.boolean().optional(), wait: z.boolean().optional() }).strict();
export const pullAssignmentSchema = z.object({ host: executorName.optional(), work: z.string().min(1).max(200).optional() }).strict();
/** The refusal a replay of one idempotency key with different input earns; read back by the pull. */
export const idempotencyMismatch = 'Idempotency key reused with different input';
export type Command = keyof typeof commands;
/** What the master's operator-agent identity applies directly, at once, under its own name. */
export const operatorCommands = new Set<Command>(['create', 'ready', 'hold', 'message', 'priority', 'unblock', 'window', 'requirements', 'rework', 'evidence']);
