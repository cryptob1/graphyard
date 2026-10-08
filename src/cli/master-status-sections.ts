// Concern: report section assembly, service profiles, ledgers and runtime environment formatting for the master status report.
import { directMergeLine, docsBudgetAttention, mergeWriterLine } from './status-attention.js';
import { masterBoard } from '../model/board.js';
import { humanOnlyStatusRow, type HumanRequestRow } from '../model/human-request.js';
import { branchReport, mergeProtocolSkew, profileConcurrency, reclaimIdleMs, type AttentionItem, type MasterConfig } from '../master.js';
import { reviewLedgerSpec, sessionLedgerHeadroom } from '../reviewer.js';
import { producerLedgerSpec } from '../producer.js';
import { actionReport, sessionReport } from './loop-report.js';
import { needsHumanActions } from './owed-report.js';
import { loopAttestations } from './hand-actions.js';
import { impliedScopeRequests, type Work } from '../model/work.js';
import { agentRequestReport } from './loop-report.js';
import { timedStep } from '../master/timings.js';
import { slowReportReader } from '../master/report-cache.js';
import { interventionSummary, interventionSummaryRoute } from './intervention-status.js';
import { executorFleetReport, readCommit, readExecutorRegistrations } from '../executor-fleet.js';
import { terminalDecisions } from './decision-report.js';
import { throughputStatus } from '../throughput.js';
import { attributeAttention, derivedAttention, ledgerRefusalAttention, resourceStatus } from '../master-status.js';
import { workerLaunchStatus } from '../master/dispatch.js';
import type { ReportSections } from '../master/sections.js';
import type { releaseLagStatus } from '../master/release-lag.js';

export async function assembleStatusSections<
  TStatus extends { work: any[] },
  TExecutors extends { attention: AttentionItem[] },
  TDisk extends Record<string, any>,
  TManagedRoot extends { health: any },
>(inputs: {
  master: MasterConfig;
  snapshot: any;
  coordinator: any;
  cli: { commit: string | null };
  probe: any;
  observation: any;
  health: any;
  hs: { report: unknown };
  merger: any;
  setup: any;
  administration: any;
  daemon: any;
  dispatch: any;
  reviewRecords: any[];
  producerRecords: any[];
  owed: { rows: any[] };
  executors: TExecutors;
  releases: ReturnType<typeof executorFleetReport>;
  lag: Awaited<ReturnType<typeof releaseLagStatus>>;
  status: TStatus;
  disk: TDisk;
  managedRoot: TManagedRoot;
  inventory: { at: any; cached: boolean };
  reclaimPlan: Array<{ disposable: boolean; path: string; key: string | null; epoch: number | null; disposition: string; detail: string }>;
  runtime: { available: boolean; reason: string | null };
  reviewRuntime: { available: boolean; reason: string | null };
  humanOnly: HumanRequestRow[];
  masterApi: any;
  decisions: any;
  approvals: Parameters<typeof loopAttestations>[1];
}) {
  const {
    master, snapshot, coordinator, cli, probe, observation, health, hs,
    merger, setup, administration, daemon, dispatch, reviewRecords, producerRecords,
    owed, executors, releases, lag, status, disk, managedRoot, inventory, reclaimPlan,
    runtime, reviewRuntime, humanOnly, masterApi, decisions, approvals,
  } = inputs;

  return {
    ...directMergeLine(coordinator),
    ...mergeWriterLine(coordinator),
    board: await timedStep('board', () => masterBoard(masterApi, snapshot, coordinator, decisions.unanswered)),
    humanOnly: humanOnly.map(humanOnlyStatusRow),
    conflictHotspots: hs.report,
    merger: { merger: merger.merger, detail: merger.detail },
    autoMerge: master.autoMerge,
    mergeApproval: master.autoMerge ? 'routine merges permitted after gates pass' : 'each merge needs an approved merge decision: graphyard master decide GY-N merge REASON, approved by the approver agent',
    conflictProbe: probe,
    observationThroughput: observation,
    leaseHealth: health.report,
    versionSkew: mergeProtocolSkew(coordinator, cli),
    cli,
    reviewer: master.reviewer ? {
      identity: `${master.reviewer.slug}[bot]`,
      appId: master.reviewer.appId,
      profiles: master.reviewers.map(profile => profile.name),
      automatic: master.run.reviewerProfile ?? (master.reviewers.length === 1 ? master.reviewers[0].name : null),
      concurrency: master.reviewers.map(profile => ({ name: profile.name, agentName: profile.agentName, concurrency: profileConcurrency(profile) })),
    } : null,
    producerProfiles: master.producers.map(profile => ({
      name: profile.name,
      principal: profile.principal,
      kind: profile.kind,
      agentName: profile.agentName,
      concurrency: profileConcurrency(profile),
    })),
    setup,
    administration,
    daemon,
    dispatch,
    ledgers: {
      reviews: sessionLedgerHeadroom(reviewRecords, reviewLedgerSpec),
      producers: sessionLedgerHeadroom(producerRecords, producerLedgerSpec),
    },
    actions: needsHumanActions(actionReport(snapshot), owed.rows),
    // Decisions the loop requests itself, never a person (GY-521).
    loopDecisions: { attestations: loopAttestations(snapshot, approvals) },
    executors: { ...executors, ...releases, attention: [...executors.attention, ...releases.attention] },
    sessions: sessionReport(snapshot),
    releaseLag: lag.report,
    branches: branchReport(status.work),
    requests: agentRequestReport(snapshot),
    impliedScopeRequests: impliedScopeRequests(snapshot.work),
    disk: {
      ...disk,
      worktreeRoot: managedRoot.health,
      idleMs: reclaimIdleMs(master),
      inventory: { at: inventory.at, cached: inventory.cached },
      reclaimable: reclaimPlan.filter(entry => entry.disposable).map(entry => ({
        path: entry.path,
        key: entry.key,
        epoch: entry.epoch,
        disposition: entry.disposition,
        detail: entry.detail,
      })),
    },
    runtime: {
      herdr: { available: runtime.available, reason: runtime.reason },
      reviews: reviewRuntime,
    },
  };
}

export async function assembleReportedAttention(
  root: string,
  master: MasterConfig,
  masterApi: (path: string, credential?: string, timeoutMs?: number) => Promise<any>,
  coordinator: any,
  snapshot: { work: Work[]; now: string },
  observed: any,
  context: { sections: ReportSections; generatedFiles: AttentionItem[]; overflow: any[] },
) {
  const { sections, generatedFiles, overflow } = context;
  const reports = slowReportReader(master, masterApi, observed.reports, observed.reportBoundMs);
  const summarized = await timedStep('attention: interventions', () => interventionSummary(reports.read));
  if (summarized.summary.error) sections.mark('interventions', interventionSummaryRoute, summarized.summary.error);
  const interventions = { ...summarized, summary: { ...summarized.summary, ...reports.freshness() } };
  const releases = executorFleetReport(await readExecutorRegistrations(master).catch(() => []), { commit: observed.commit ?? readCommit(root) }, { hostId: master.hostId });
  const decisions = await timedStep('attention: decisions', () => sections.optional('decisions', 'GET /api/work/:id/decisions', () => terminalDecisions(masterApi, snapshot.work, { approvals: observed.approvals, runtime: observed.runtime, now: Date.now() }),
    () => ({ listed: [], attentionItems: [] as AttentionItem[], unanswered: [], refused: 0 })));
  const throughput = await timedStep('attention: throughput', () => throughputStatus(root, coordinator, snapshot.work));
  // The readings judge the snapshot's leases and sessions at the snapshot's own instant (GY-1379): the
  // loop reads this at the end of a cycle that can run ten minutes, and a two-minute lease taken at its
  // start read against the wall clock then is a live worker misread as gone.
  const at = Date.parse(snapshot.now);
  const resources = await timedStep('attention: resources', () => resourceStatus(root, master, { reviews: observed.reviews, producers: observed.producers, agents: observed.runtime.available ? observed.runtime.agents : null, work: snapshot.work, loop: observed.loop }, Number.isFinite(at) ? { now: at } : {}));
  const derived = await timedStep('attention: derived', () => derivedAttention(root, master, masterApi, coordinator, snapshot, { ...observed, reviews: observed.reviews ?? [], producers: observed.producers ?? [], runtime: { available: observed.runtime.available, agents: observed.runtime.available ? observed.runtime.agents : [] } }));
  if (!derived.executors.presence.available && /^GET \/api\/actions failed/.test(derived.executors.presence.reason)) sections.mark('executors', 'GET /api/actions', derived.executors.presence.reason);
  const docs = await timedStep('docs budget', () => docsBudgetAttention(root, master.baseBranch, generatedFiles));
  const launches = await timedStep('attention: launches', () => workerLaunchStatus(root, master));
  const items = [...resources.attention, ...generatedFiles, ...overflow, ...interventions.attentionItems, ...releases.attention, ...(throughput.attention ? [throughput.attention] : []), ...decisions.attentionItems, ...derived.items, ...launches.items];
  const attribute = (status: { work: any[]; attentionItems: AttentionItem[] }) => attributeAttention(ledgerRefusalAttention(status, snapshot.work).attentionItems, resources.readings);
  return { generatedFiles, docs, overflow, interventions, releases, decisions, throughput, resources, derived, items, attribute, unavailable: sections.unavailable };
}
