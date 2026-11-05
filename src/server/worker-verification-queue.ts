// Request/reply transport to the equipped host loop. Restarting the HTTP server
// drops its outstanding requests; workers retry, never reuse an unrecorded result.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { demand, type Principal, type Work } from '../model.js';
import { Refusal } from '../model/refusal.js';
import type { Services } from './routes.js';
import type { WorkerVerificationResult } from '../cli/worker-verification.js';
import { workerVerificationTimeoutMs, type WorkerVerificationInput } from '../merge-writer/worker-verification.js';

export interface WorkerVerificationJob {
  id: string; host: string; branch: string; work: Work; input: WorkerVerificationInput; baseBranch: string;
}
interface Pending {
  job: WorkerVerificationJob; executor?: string;
  resolve: (result: WorkerVerificationResult) => void; reject: (error: Error) => void;
}
const queues = new WeakMap<Services, Map<string, Pending>>();
function queue(services: Services) {
  let pending = queues.get(services);
  if (!pending) { pending = new Map(); queues.set(services, pending); }
  return pending;
}
export async function dispatchWorkerVerification(services: Services, job: Omit<WorkerVerificationJob, 'id'>): Promise<WorkerVerificationResult> {
  const pending = queue(services), id = randomUUID();
  let timer: NodeJS.Timeout;
  try {
    return await new Promise<WorkerVerificationResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Refusal('Host worker verification timed out', 504)), workerVerificationTimeoutMs);
      pending.set(id, { job: { ...job, id }, resolve, reject });
    });
  } finally { clearTimeout(timer!); pending.delete(id); }
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
  const input = z.object({ id: z.string().uuid(), result: z.custom<WorkerVerificationResult>().optional(), error: z.string().optional() }).strict().parse(body);
  const pending = queue(services).get(input.id);
  demand(pending && pending.executor === actor.id, 'No verification assigned to this coordinator', 409);
  demand(!!input.result !== !!input.error, 'Return a result or a runner error', 400);
  queue(services).delete(input.id);
  // The runner's own words (a refusal, a failing rerun) reach the worker, never a bare 500.
  if (input.error) pending!.reject(new Refusal(input.error, 422));
  else pending!.resolve(input.result!);
  return { accepted: true };
}
