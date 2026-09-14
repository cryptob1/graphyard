import { z } from 'zod';

export const stages = ['backlog', 'ready', 'build', 'review', 'test', 'acceptance', 'merge', 'done'] as const;
export type Stage = typeof stages[number];
export const proofSchema = z.string().regex(/^(unit|integration|e2e|manual):[a-zA-Z0-9._/-]+$/);
export const criterionSchema = z.object({ id: z.string().regex(/^AC-\d+$/), text: z.string().min(1).max(2000), proofs: z.array(proofSchema).min(1).max(20) }).strict();
export const policySchema = z.object({
  checks: z.array(z.string().min(1).max(200)).min(1).max(30).default(['test', 'typecheck']),
  review: z.boolean().default(true),
  reviewProvider: z.enum(['github', 'codex']).optional(),
}).strict();
export const createSchema = z.object({
  title: z.string().min(1).max(200), description: z.string().max(20000).default(''),
  type: z.enum(['feature', 'bug', 'chore']).default('feature'),
  priority: z.number().int().min(0).max(4).default(2),
  dependencies: z.array(z.string().uuid()).max(50).default([]),
  criteria: z.array(criterionSchema).min(1).max(50),
  policy: policySchema.default({ checks: ['test', 'typecheck'], review: true }),
  plannedFiles: z.array(z.string().min(1).max(500)).max(100).default([]),
}).strict();
export type Create = z.infer<typeof createSchema>;
export interface Principal { id: string; role: 'admin' | 'worker' | 'producer' | 'reader'; proofs?: string[] }
export interface Lease { owner: string; epoch: number; expiresAt: string }
export interface Workspace { host: string; path: string; branch: string; epoch: number; owner: string }
export interface Candidate { sha: string; baseSha: string; pr: number; branch: string; author: string }
export interface Evidence {
  id: string; proof: string; sha: string; baseSha: string; policyRevision: number;
  producer: string; trusted: boolean; result: 'pass' | 'fail';
  executed: number; skipped: number; url?: string; at: string;
  scenarioRevision?: number; environment?: string;
}
export interface ReviewRequest { commentId: number; sha: string; baseSha: string; policyRevision: number; body: string; createdAt: string }
export interface AgentReview { provider: 'codex'; sha: string; approved: boolean; reason: string; summaryId?: number; resultId?: number; requestId?: number; reactionId?: number; completedAt?: string }
export interface Observation {
  agentReview?: AgentReview;
  candidate: Candidate; checks: { name: string; result: string; appId: number }[];
  reviews: { reviewer: string; sha: string; state: string }[];
  merged: boolean; mergeSha: string | null; mergedAt?: string | null; mergeable: boolean;
  protected: boolean; files: string[]; at: string;
}
export interface Gate { name: string; passed: boolean; reasons: string[] }
export interface Work extends Create {
  id: string; key: string; stage: Stage; revision: number; policyRevision: number;
  createdAt: string; updatedAt: string; stageEnteredAt: string; ready: boolean;
  epoch: number; lease: Lease | null; workspaces: Workspace[]; candidate: Candidate | null;
  submission: { epoch: number; pr: number } | null;
  reworkRequested: boolean;
  scenarioRequirements: { proof: string; revision: number; environment: string; hash: string }[];
  reviewRequest?: ReviewRequest | null;
  mergeAuthorization?: { sha: string; baseSha: string; policyRevision: number; at: string } | null;
  delivery?: { mergedAt: string; mergeSha: string; authorizationRevision: number };
  evidence: Evidence[]; observation: Observation | null; blocker: string | null;
  gates: Gate[]; violations: string[];
}
export class Refusal extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export class ReconciliationRetry extends Refusal {}
export function requireCurrent(value: unknown, message: string): asserts value {
  if (!value) throw new ReconciliationRetry(message, 409);
}
export function demand(value: unknown, message: string, status = 409): asserts value {
  if (!value) throw new Refusal(message, status);
}
export function admin(actor: Principal) { demand(actor.role === 'admin', 'Operator permission required', 403); }
export function activeLease(work: Work, actor: Principal, epoch: number, now: Date) {
  demand(work.lease && work.lease.owner === actor.id && work.lease.epoch === epoch && Date.parse(work.lease.expiresAt) > now.getTime(), 'Lease missing, expired, or superseded; claim the task again');
}

// Pure evaluation: neither worker assertions nor UI state can authorize progression.
export function evaluate(work: Work, all: Work[], now: Date, ciAppIds: number[]): { stage: Stage; gates: Gate[]; violations: string[] } {
  const gates: Gate[] = [];
  const add = (name: string, reasons: string[]) => gates.push({ name, passed: reasons.length === 0, reasons });
  const dependencies = work.dependencies.filter(id => all.find(w => w.id === id)?.stage !== 'done');
  add('ready', [...(!work.ready ? ['Not released from backlog'] : []), ...dependencies.map(id => `Dependency ${all.find(w => w.id === id)?.key ?? id} is unfinished`), ...(work.blocker ? [work.blocker] : [])]);
  const candidate = work.candidate;
  const obs = work.observation;
  const current = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha;
  const fresh = current && now.getTime() - Date.parse(obs!.at) < 120_000;
  add('build', [...(!work.submission || work.reworkRequested ? ['Worker has not submitted implementation for this attempt'] : []), ...(!candidate ? ['Pull request has not been independently observed'] : []), ...(!work.workspaces.length ? ['No workspace registered'] : [])]);
  const reviews = current ? obs!.reviews : [];
  const changesRequested = reviews.some(r => r.state === 'CHANGES_REQUESTED');
  const agentReview = current ? obs!.agentReview : undefined;
  const reviewPassed = work.policy.reviewProvider === 'codex'
    ? !!candidate && !!agentReview?.approved && agentReview.provider === 'codex' && agentReview.sha === candidate.sha && work.reviewRequest?.commentId === agentReview.requestId && work.reviewRequest?.sha === candidate.sha && work.reviewRequest?.baseSha === candidate.baseSha && work.reviewRequest?.policyRevision === work.policyRevision
    : !!candidate && reviews.some(r => r.sha === candidate.sha && r.state === 'APPROVED' && r.reviewer !== candidate.author);
  add('review', work.policy.review ? [
    ...(!reviewPassed ? [work.policy.reviewProvider === 'codex' ? agentReview?.reason ?? 'Verified clean Codex review of the current commit is required' : 'Independent approval of the current commit is required'] : []),
    ...(changesRequested ? ['Outstanding change requests must be resolved through a new review'] : []),
  ] : []);
  add('test', work.policy.checks.filter(name => {
    const checks = current ? obs!.checks.filter(c => c.name === name && ciAppIds.includes(c.appId)) : [];
    return !checks.length || checks.some(c => c.result !== 'success');
  }).map(name => `Required CI check ${name} has not passed on the current candidate`));
  const reasons: string[] = [];
  for (const ac of work.criteria) for (const proof of ac.proofs) {
    const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
    const evidence = work.evidence.filter(e => e.proof === proof && e.trusted && e.sha === candidate?.sha && e.baseSha === candidate?.baseSha && e.policyRevision === work.policyRevision && (!scenario || e.scenarioRevision === scenario.revision && e.environment === scenario.environment)).at(-1);
    if (!evidence || evidence.result !== 'pass' || evidence.executed < 1 || evidence.skipped !== 0) reasons.push(`${ac.id}: ${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy${scenario ? `; scenario v${scenario.revision} in ${scenario.environment}` : ''}`);
  }
  add('acceptance', reasons);
  add('merge', [...(!fresh ? ['GitHub observation missing or older than two minutes'] : []), ...(!obs?.protected ? ['Required Graphyard check and strict branch protection have not been verified'] : []), ...(!obs?.mergeable && !obs?.merged ? ['Pull request is not mergeable against the current base'] : [])]);
  const first = gates.find(g => !g.passed);
  const violations = [...work.violations];
  let stage: Stage = !work.ready ? 'backlog' : !work.submission ? (work.lease && Date.parse(work.lease.expiresAt) > now.getTime() ? 'build' : 'ready') : (first?.name === 'ready' ? 'build' : first?.name as Stage ?? 'merge');
  // Delivery history stays complete; later observations cannot rewrite it.
  if (work.stage === 'done') stage = 'done';
  return { stage, gates, violations };
}
