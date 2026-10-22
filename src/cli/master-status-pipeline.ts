// Concern: candidate session status, conflict probe and timing failure qualification for the master status report.
import { dataDirectory } from '../install/worktree-root.js';
import { probeCandidateConflictsWithBudget } from '../conflicts.js';
import { agentOwner, buildMasterStatus, type MasterConfig } from '../master.js';
import { nameOrphanSupervisors } from './status-attention.js';
import { leadTimeReport, speedSections } from '../flow-analytics.js';
import { timedStep } from '../master/timings.js';
import { withPipelineTimelines } from '../pipeline-speed.js';
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
  // The coordination view drops every timeline, so speed would measure nothing (GY-1489): read them
  // on their own and attach them first; a failed read marks the section and leaves speed unmeasured.
  await timedStep('timelines', () => withPipelineTimelines(snapshot.work, masterApi)).catch(error => sections.mark('speed', 'GET /api/pipeline-timelines', error));
  const probe = await timedStep('conflicts', () => probeCandidateConflictsWithBudget(root, snapshot.work, dataDirectory()));
  const sessions = await timedStep('build status', async () => nameOrphanSupervisors(buildMasterStatus(snapshot, master.workers, runtime.agents, credentials, containment, reviews, master.baseBranch, coordinator, { producers, failures, retries }, probe, { reviewers: master.reviewers, producers: master.producers }, master.cliPath, daemonState, { mode: master.supervision, operatorLogin: master.operatorLogin }),
    snapshot.work, master.workers, runtime, Date.parse(snapshot.now), daemonState && 'orphans' in daemonState ? daemonState : null));
  // Each item's review round against the configured cap (GY-1118). No check-run annotation is read back (GY-2010).
  const status = { ...sessions, work: withReviewRounds(sessions.work, snapshot.work, reviewRoundCapOf(master)) };
  for (const worker of status.workers) Object.assign(worker, launches.rows[worker.profile] ?? {});
  // Rework rounds by cause (GY-643, GY-725) onto `speed`, delivery speed on the GitHub path with its
  // breach attention (GY-1232) and the stage holding each item's time (GY-1382); a failed read marks its section.
  const delivery = await speedSections(status.speed, masterApi, snapshot, { root, targets: master.deliverySpeed, deploys: daemonState?.promotion?.deploys, sections });
  // The one speed number (GY-1989): median released→merged over the last 10 merges with the previous
  // 10 beside it, read from the items' own release records; a failed read marks its section and the
  // report carries no line, rather than a figure guessed from what did read.
  const lead = await timedStep('lead time', () => leadTimeReport(snapshot.work, masterApi))
    .catch(error => { sections.mark('lead time', 'GET /api/events?kind=ready', error); return null; });
  return { probe, sessions, status, delivery, lead };
}
