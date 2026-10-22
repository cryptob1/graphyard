// Concern: report section assembly, service profiles, ledgers and runtime environment formatting for the master status report.
import { directMergeLine, mergeWriterLine } from './status-attention.js';
import { masterBoard } from '../model/board.js';
import { humanOnlyStatusRow, type HumanRequestRow } from '../model/human-request.js';
import { mergeProtocolSkew, profileConcurrency, reclaimIdleMs, type AttentionItem, type MasterConfig } from '../master.js';
import { launchStartMs, readSessionScreen } from '../master/launch.js';
import { reviewLedgerSpec, sessionLedgerHeadroom } from '../reviewer.js';
import { producerLedgerSpec } from '../producer.js';
import { actionReport, sessionReport } from './loop-report.js';
import { needsHumanActions } from './owed-report.js';
import type { Work } from '../model/work.js';
import { agentRequestReport } from './loop-report.js';
import { timedStep } from '../master/timings.js';
import { openThroughputOwner, throughputStatus } from '../throughput.js';
import { throughputEscalatedAt } from '../daemon/cycle-delivery.js';
import { readDaemonState } from '../daemon/state.js';
import { attributeAttention, derivedAttention, ledgerRefusalAttention, resourceStatus } from '../master-status.js';
import { workerLaunchStatus } from '../master/dispatch.js';
import type { ReportSections } from '../master/sections.js';
import type { releaseLagStatus } from '../master/release-lag.js';

export async function assembleStatusSections<
  TStatus extends { work: any[] },
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
  setup: any;
  administration: any;
  daemon: any;
  dispatch: any;
  reviewRecords: any[];
  producerRecords: any[];
  owed: { rows: any[] };
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
}) {
  const {
    master, snapshot, coordinator, cli, probe, observation, health,
    setup, administration, daemon, dispatch, reviewRecords, producerRecords,
    owed, lag, status, disk, managedRoot, inventory, reclaimPlan,
    runtime, reviewRuntime, humanOnly, masterApi,
  } = inputs;

  return {
    ...directMergeLine(coordinator),
    ...mergeWriterLine(coordinator),
    board: await timedStep('board', () => masterBoard(masterApi, snapshot, coordinator)),
    humanOnly: humanOnly.map(humanOnlyStatusRow),
    // GY-1927: what the plane enforces, from its recorded setting; a plane that records none merges on gates alone.
    autoMerge: coordinator?.autoMerge?.autoMerge !== false,
    mergeApproval: coordinator?.autoMerge?.line ?? 'routine merges permitted after gates pass',
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
    sessions: sessionReport(snapshot),
    releaseLag: lag.report,
    requests: agentRequestReport(snapshot),
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
  context: { sections: ReportSections; generatedFiles: AttentionItem[] },
) {
  const { sections, generatedFiles } = context;
  // GY-1609: the revision the loop raised the open owner's needs-decision at, from its cursor, so an
  // applied answer reads as answered rather than as the decision asked again. Read only while one is open. GY-1630: with
  // the operator-agent identity the loop requests that decision itself, so the attention names the loop, not a master.
  const escalations = openThroughputOwner(snapshot.work) ? (await readDaemonState(root, master).catch(() => null))?.actions ?? {} : {};
  const throughput = await timedStep('attention: throughput', () => throughputStatus(root, coordinator, snapshot.work, Date.now(), owner => throughputEscalatedAt(escalations, owner), !!master.operatorAgent));
  // The readings judge the snapshot's leases and sessions at the snapshot's own instant (GY-1379): the
  // loop reads this at the end of a cycle that can run ten minutes, and a two-minute lease taken at its
  // start read against the wall clock then is a live worker misread as gone.
  const at = Date.parse(snapshot.now);
  const resources = await timedStep('attention: resources', () => resourceStatus(root, master, { reviews: observed.reviews, producers: observed.producers, agents: observed.runtime.available ? observed.runtime.agents : null, work: snapshot.work, loop: observed.loop }, Number.isFinite(at) ? { now: at } : {}));
  const derived = await timedStep('attention: derived', () => derivedAttention(root, master, masterApi, coordinator, snapshot, { ...observed, reviews: observed.reviews ?? [], producers: observed.producers ?? [], runtime: { available: observed.runtime.available, agents: observed.runtime.available ? observed.runtime.agents : [] } }));
  const launches = await timedStep('attention: launches', () => workerLaunchStatus(root, master));
  const items = [...resources.attention, ...generatedFiles, ...(throughput.attention ? [throughput.attention] : []), ...derived.items, ...launches.items];
  const attribute = (status: { work: any[]; attentionItems: AttentionItem[] }) => attributeAttention(ledgerRefusalAttention(status, snapshot.work).attentionItems, resources.readings);
  return { generatedFiles, throughput, resources, derived, items, attribute, unavailable: sections.unavailable };
}
