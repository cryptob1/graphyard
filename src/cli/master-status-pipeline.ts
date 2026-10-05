// Concern: candidate session status, conflict probe, merge queue and timing failure qualification for the master status report.
import { dataDirectory } from '../install/worktree-root.js';
import { mergeQueueStatus } from '../master/profiles.js';
import { probeCandidateConflictsWithBudget } from '../conflicts.js';
import { agentOwner, buildMasterStatus, type MasterConfig } from '../master.js';
import { nameOrphanSupervisors } from './status-attention.js';
import { nameUnresolvedThreads } from '../merge-queue.js';
import { qualifyTimingFailures, ghCheckAnnotations } from './timing-failures.js';
import { routedScopeStatus } from './owed-report.js';
import { speedSections } from '../flow-analytics.js';
import { timedStep } from '../master/timings.js';
import type { ReportSections } from '../master/sections.js';
import { readReviewLedger, reconcileReviews, summarizeReviews } from '../reviewer.js';
import { readProducerLedger, reconcileProducers, sessionRetries, summarizeProducers } from '../producer.js';

export async function reconcileLedgers(root: string, master: MasterConfig, snapshot: any, runtime: any) {
  let reviewRecords = (await readReviewLedger(root)).reviews, reviewRuntime = { available: true, reason: null as string | null };
  try { reviewRecords = (await timedStep('reconcile reviews', () => reconcileReviews(root, master, { work: snapshot.work, agents: runtime.available ? runtime.agents : null }))).reviews; }
  catch (error) { reviewRuntime = { available: false, reason: `Reviewer verdicts could not be reconciled with GitHub: ${error instanceof Error ? error.message : 'unknown reason'}` }; }
  let producerRecords = (await readProducerLedger(root)).producers;
  try { producerRecords = (await timedStep('reconcile producers', () => reconcileProducers(root, master, snapshot.work, runtime.available ? runtime.agents : null))).producers; } catch { /* the ledger as last written stands */ }
  const reviews = summarizeReviews(reviewRecords), producers = summarizeProducers(producerRecords);
  const retries = [...sessionRetries(reviewRecords, Date.now()), ...sessionRetries(producerRecords, Date.now())];
  return { reviewRecords, reviewRuntime, producerRecords, reviews, producers, retries };
}

export async function buildPipelineStatus(
  root: string,
  master: MasterConfig,
  snapshot: any,
  coordinator: any,
  runtime: any,
  credentials: any,
  containment: any,
  reviews: any,
  producers: any,
  failures: any[],
  retries: any[],
  daemonState: any,
  cycling: any,
  launches: { rows: Record<string, any> },
  masterApi: (path: string, credential?: string, timeoutMs?: number) => Promise<any>,
  sections: ReportSections,
) {
  const mergeQueue = mergeQueueStatus(master, snapshot, coordinator);
  const probe = await timedStep('conflicts', () => probeCandidateConflictsWithBudget(root, snapshot.work, dataDirectory()));
  const sessions = await timedStep('build status', async () => nameOrphanSupervisors(nameUnresolvedThreads(buildMasterStatus(snapshot, master.workers, runtime.agents, credentials, containment, reviews, master.baseBranch, coordinator, { producers, failures, retries }, probe, { reviewers: master.reviewers, producers: master.producers }, master.cliPath, mergeQueue, daemonState), snapshot.work, agentOwner),
    snapshot.work, master.workers, runtime, Date.parse(snapshot.now)));
  // A check failed on the clock says so, against its budget; a routed scope request, its approver.
  const status = routedScopeStatus(await timedStep('timing failures', () => qualifyTimingFailures(sessions, snapshot.work, master.repository, ghCheckAnnotations(master.repository))), snapshot.work, cycling?.approvals, master);
  for (const worker of status.workers) Object.assign(worker, launches.rows[worker.profile] ?? {});
  // Rework rounds by cause (GY-643, GY-725) onto `speed`, delivery speed on the GitHub path with its
  // breach attention (GY-1232); a failed read marks its section.
  const delivery = await speedSections(status.speed, masterApi, snapshot, { root, targets: master.deliverySpeed, sections });
  return { mergeQueue, probe, sessions, status, delivery };
}
