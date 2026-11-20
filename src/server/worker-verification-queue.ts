// Request/reply transport to the equipped host loop. Restarting the HTTP server
// drops its outstanding requests; workers retry, never reuse an unrecorded result.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { demand, type Principal, type Work } from '../model.js';
import { Refusal } from '../model/refusal.js';
import type { Services } from './routes.js';
import type { WorkerVerificationResult } from '../cli/worker-verification.js';
import { workerVerificationTimeoutMs, type WorkerVerificationInput } from '../merge-writer/worker-verification.js';
import type { WorkerCheckResult } from '../merge-writer/worker-check.js';

export interface WorkerVerificationJob {
  id: string; host: string; branch: string; work: Work; input: WorkerVerificationInput; baseBranch: string;
}
interface Pending {
  job: WorkerVerificationJob; executor?: string; requestedAt: number;
  /** The host's launcher lines so far (GY-3332): what the waiting worker's `complete` prints. */
  lines: string[];
  /** GY-3525: what every caller asking for this same verification awaits. */
  identity: string; result: Promise<WorkerVerificationResult | WorkerCheckResult>;
  resolve: (result: WorkerVerificationResult | WorkerCheckResult) => void; reject: (error: Error) => void;
}
const queues = new WeakMap<Services, Map<string, Pending>>();
function queue(services: Services) {
  let pending = queues.get(services);
  if (!pending) { pending = new Map(); queues.set(services, pending); }
  return pending;
}
/** How long a request waits for its verification; a field so a test can shorten it. */
export const verificationQueue = { waitMs: workerVerificationTimeoutMs };
/** GY-3537: the request's time ran out while its verification had not started: no host took it, or its last line is a wait for a slot. */
export class VerificationStillWaiting extends Refusal {}
const waitLine = /^waiting\b|^graphyard: .*\bwait(s|ing)\b/;
const stillWaiting = (pending: Pending) => !pending.executor || waitLine.test(pending.lines.at(-1) ?? '');
/** GY-3525: a repeated request for the same work, lease epoch, head and inputs joins the pending one; changed inputs run their own.
 * A caller whose time runs out leaves a running verification in place for its repeat to join; a queued one no host took is dropped. */
export async function dispatchWorkerVerification<Result extends WorkerVerificationResult | WorkerCheckResult = WorkerVerificationResult>(services: Services, job: Omit<WorkerVerificationJob, 'id'>): Promise<Result> {
  const pending = queue(services);
  const identity = JSON.stringify([job.work.id, job.work.criteria, job.host, job.branch, job.baseBranch, job.input]);
  let entry = [...pending.values()].find(candidate => candidate.identity === identity);
  if (!entry) {
    const id = randomUUID();
    let resolve!: Pending['resolve'], reject!: Pending['reject'];
    const result = new Promise<WorkerVerificationResult | WorkerCheckResult>((yes, no) => { resolve = yes; reject = no; });
    result.catch(() => undefined); // Every caller may have given up before it settles.
    entry = { job: { ...job, id }, requestedAt: Date.now(), lines: [], identity, result, resolve, reject };
    pending.set(id, entry);
  }
  const joined = entry;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    const error = stillWaiting(joined)
      ? new VerificationStillWaiting('Host worker verification is still waiting for a slot', 504)
      : new Refusal('Host worker verification timed out', 504);
    if (!joined.executor && pending.get(joined.job.id) === joined) { pending.delete(joined.job.id); joined.reject(error); }
    reject(error);
  }, verificationQueue.waitMs); });
  try { return await Promise.race([joined.result, timeout]) as Result; } finally { clearTimeout(timer!); }
}
/** A new loop rejects only its predecessor's assigned requests; queued work stays queued. */
export function restartWorkerVerifications(services: Services, actor: Principal, body: unknown) {
  demand(actor.role === 'coordinator', 'Only the host coordinator restarts worker verification', 403);
  const { host } = z.object({ host: z.string().min(1) }).strict().parse(body);
  let interrupted = 0;
  for (const [id, pending] of queue(services)) {
    if (pending.job.host !== host || pending.executor !== actor.id) continue;
    queue(services).delete(id);
    pending.reject(new Refusal(`Verification interrupted by coordinator restart; retry complete for ${pending.job.work.key} with the same head ${pending.job.input.head} and lease epoch ${pending.job.input.epoch}`, 409));
    interrupted++;
  }
  return { interrupted };
}

/** Explicit diagnostic fields only: never expose the job's work document or credentials. */
export function pendingWorkerVerifications(services: Services, actor: Principal, visible: { id: string }[], now = Date.now()) {
  if (!['coordinator', 'operator-agent', 'admin'].includes(actor.role)) return [];
  const ids = new Set(visible.map(work => work.id));
  return [...queue(services).values()].filter(pending => ids.has(pending.job.work.id)).map(pending => ({
    key: pending.job.work.key, head: pending.job.input.head, epoch: pending.job.input.epoch,
    host: pending.job.host, executor: pending.executor ?? null,
    requestedAt: new Date(pending.requestedAt).toISOString(), ageSeconds: Math.max(0, (now - pending.requestedAt) / 1000),
    state: pending.executor ? 'running' : 'queued', progress: [...pending.lines],
  }));
}
export function takeWorkerVerifications(services: Services, actor: Principal, body: unknown) {
  demand(actor.role === 'coordinator', 'Only the host coordinator runs worker verification', 403);
  const { host } = z.object({ host: z.string().min(1) }).strict().parse(body);
  const jobs: WorkerVerificationJob[] = [];
  for (const pending of queue(services).values()) {
    if (pending.job.host !== host || pending.executor) continue;
    pending.executor = actor.id;
    jobs.push(pending.job);
  }
  return jobs;
}
export function finishWorkerVerification(services: Services, actor: Principal, body: unknown) {
  demand(actor.role === 'coordinator', 'Only the host coordinator returns worker verification', 403);
  const input = z.object({ id: z.string().uuid(), result: z.custom<WorkerVerificationResult | WorkerCheckResult>().optional(), error: z.string().optional() }).strict().parse(body);
  const pending = queue(services).get(input.id);
  demand(pending && pending.executor === actor.id, 'No verification assigned to this coordinator', 409);
  demand(!!input.result !== !!input.error, 'Return a result or a runner error', 400);
  queue(services).delete(input.id);
  // The runner's own words (a refusal, a failing rerun) reach the worker, never a bare 500.
  if (input.error) pending!.reject(new Refusal(input.error, 422));
  else pending!.resolve(input.result!);
  return { accepted: true };
}
/** GY-3332: one launcher line from the host running a verification (waiting, starting, giving up). */
export function progressWorkerVerification(services: Services, actor: Principal, body: unknown) {
  demand(actor.role === 'coordinator', 'Only the host coordinator reports worker verification', 403);
  const input = z.object({ id: z.string().uuid(), line: z.string().max(2000) }).strict().parse(body);
  const pending = queue(services).get(input.id);
  demand(pending && pending.executor === actor.id, 'No verification assigned to this coordinator', 409);
  if (pending!.lines.length < 100) pending!.lines.push(input.line);
  return { accepted: true };
}
/** The launcher lines of the verifications pending for work item `id`, oldest first. */
export function workerVerificationLines(services: Services, actor: Principal, id: string) {
  demand(actor.role === 'worker', 'Only an implementation worker reads its verification progress', 403);
  return [...queue(services).values()].filter(pending => pending.job.work.id === id || pending.job.work.key === id).flatMap(pending => pending.lines);
}
