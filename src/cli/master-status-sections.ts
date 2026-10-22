// Concern: report section assembly, service profiles, ledgers and runtime environment formatting for the master status report.
import { directMergeLine, mergeWriterLine } from './status-attention.js';
import { masterBoard } from '../model/board.js';
import { humanOnlyStatusRow, type HumanRequestRow } from '../model/human-request.js';
import { mergeProtocolSkew, profileConcurrency, type AttentionItem, type MasterConfig } from '../master.js';
import { launchStartMs, readSessionScreen } from '../master/launch.js';
import { reviewLedgerSpec, sessionLedgerHeadroom } from '../reviewer.js';
import { producerLedgerSpec } from '../producer.js';
import { actionReport, sessionReport } from './loop-report.js';
import { needsHumanActions } from './owed-report.js';
import type { Work } from '../model/work.js';
import { agentRequestReport } from './loop-report.js';
import { derivedAttention } from '../master-status.js';
import { workerLaunchStatus } from '../master/dispatch.js';
import type { ReportSections } from '../master/sections.js';
import type { releaseLagStatus } from '../master/release-lag.js';

export async function assembleStatusSections<
  TStatus extends { work: any[] },
  TManagedRoot extends { health: any },
>(inputs: {
  master: MasterConfig;
  snapshot: any;
  coordinator: any;
  cli: { commit: string | null };
  probe: any;
  observation: any;
  setup: any;
  administration: any;
  daemon: any;
  dispatch: any;
  reviewRecords: any[];
  producerRecords: any[];
  owed: { rows: any[] };
  lag: Awaited<ReturnType<typeof releaseLagStatus>>;
  status: TStatus;
  managedRoot: TManagedRoot;
  runtime: { available: boolean; reason: string | null };
  reviewRuntime: { available: boolean; reason: string | null };
  humanOnly: HumanRequestRow[];
  masterApi: any;
}) {
  const {
    master, snapshot, coordinator, cli, probe, observation,
    setup, administration, daemon, dispatch, reviewRecords, producerRecords,
    owed, lag, status, managedRoot,
    runtime, reviewRuntime, humanOnly, masterApi,
  } = inputs;

  return {
    ...directMergeLine(coordinator),
    ...mergeWriterLine(coordinator),
    board: await masterBoard(masterApi, snapshot, coordinator),
    humanOnly: humanOnly.map(humanOnlyStatusRow),
    // GY-1927: what the plane enforces, from its recorded setting; a plane that records none merges on gates alone.
    autoMerge: coordinator?.autoMerge?.autoMerge !== false,
    mergeApproval: coordinator?.autoMerge?.line ?? 'routine merges permitted after gates pass',
    conflictProbe: probe,
    observationThroughput: observation,
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
    sessions: sessionReport(snapshot),
    releaseLag: lag.report,
    requests: agentRequestReport(snapshot),
    disk: { worktreeRoot: managedRoot.health },
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
  context: { sections: ReportSections; generatedFiles: AttentionItem[] },
) {
  const { sections, generatedFiles } = context;
  const derived = await derivedAttention(root, master, masterApi, coordinator, snapshot, { ...observed, reviews: observed.reviews ?? [], producers: observed.producers ?? [], runtime: { available: observed.runtime.available, agents: observed.runtime.available ? observed.runtime.agents : [] } });
  const launches = await workerLaunchStatus(root, master);
  const items = [...generatedFiles, ...derived.items, ...launches.items];
  return { generatedFiles, derived, items, unavailable: sections.unavailable };
}
