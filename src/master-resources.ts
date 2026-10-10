import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { agentOwner, atomicPrivateWrite, closeHerdrPane, diskThresholdBytes, isProfileSession, neverStartedReason, privateFile, profileConcurrency, worktreesDirectory, type AttentionItem, type HerdrAgent, type MasterConfig } from './master.js';
import type { HerdrPane } from './master/herdr.js';
import { pinnedSessionRecords, readReviewLedger, sessionLedgerBound, SessionLedgerFullError, sessionLedgerRefusal, terminalSessionStates, updateReviewLedger, type ReviewRecord } from './reviewer.js';
import { readProducerLedger, saveProducerLedger, type ProducerRecord } from './producer.js';
import { agentScratchMinAgeMs, agentScratchPatterns, describeTmpReclaim, hostTmpRoots, reclaimTmpDirectories, testTempMinAgeMs, testTempPatterns, tmpInodeHeadroom, tmpReclaimEscalation, tmpReclaimLimitPerCycle, tmpReclaimMinAgeMs, tmpConsumersScanBound, tmpReclaimWorkMsPerCycle, tsxCacheName, type TmpConsumer, type TmpRootPressure, type TmpReclaimOptions, type TmpReclaimReport } from './tmp-reclaim.js';
import { alignKey, upgradeTouchesCode } from './daemon/upgrade.js';
import type { UpgradeStall } from './daemon/state.js';
import { workerReclaimBoundMs, workerSubmissionBoundMs } from './model/attempt-bound.js';
import { describePromotion, promotionHolds, promotionWait, type PromotionWait } from './master/release-lag.js';
import type { LoopState } from './daemon/liveness.js';
import type { Work } from './model.js';
import { runChild } from './child-runner.js';

/**
 * The control plane's own resources (GY-132).
 *
 * Graphyard gates every work item and, until this registry, observed none of what it consumes
 * itself. On 23 September 2026 the review ledger sat at its 200-record cap for hours: every review
 * launch was refused by the ledger's schema, and `master status` reported the downstream symptom —
 * "reviewer agent … is busy in Herdr" — while seven items starved. Finished panes held agent names
 * the next launch needed and were reported the same way. Nothing named either resource.
 *
 * Every bounded resource the loop and the plane consume is declared once, below: what bounds it,
 * where its usage is read, the component that owns it, how it is reclaimed and within what bound,
 * and what to do when it runs low. `master status` reports each one as used-of-bound with its
 * headroom and raises attention before exhaustion; a refusal caused by one is attributed to it;
 * the reclaim pass gives each one back; and `/healthz` reports the plane unhealthy while it cannot record.
 */

/** A duration as the registry and the tmp-inodes detail spell it: whole hours, else minutes. */
const minutes = (ms: number) => ms >= 3_600_000 ? `${ms / 3_600_000} hour${ms === 3_600_000 ? '' : 's'}` : `${ms / 60_000} minutes`;
export const resourceIds = ['review-ledger', 'producer-ledger', 'agent-names', 'session-slots', 'github-budget', 'executor-liveness', 'loaded-revision', 'database-capacity', 'worktree-disk', 'tmp-inodes'] as const;
export type ResourceId = typeof resourceIds[number];
export type ResourceState = 'ok' | 'low' | 'exhausted' | 'unknown';

/** One reading of one resource (or of one instance of it: a profile's namespace, a role's slots). */
export interface ResourceReading {
  id: string; resource: ResourceId; title: string; unit: string;
  used: number | null; bound: number | null; headroom: number | null;
  /** Headroom below which the reading is `low` and raises attention. */
  warnBelow: number;
  state: ResourceState; owner: string; reclaim: string; remedy: string; detail: string | null;
  /** Holders nothing live owns any more (a finished pane on a name, a settled record): what a reclaim gives back. */
  reclaimable: number;
  /** Reclaimable holders the reclaim paths have not given back within their bound (`nameReclaimBoundMs`): a reclaim that failed, not one under way. */
  overdue?: number;
  /** The bound is a default nobody configured (the plane's database): the reading is reported, but reaching it is not a resource at its bound. */
  advisory?: boolean;
  /**
   * The loop's own reclaim is current over the resource and what holds it lies outside its reach
   * (GY-1379): a low reading is reported, but raises nothing until it passes the resource's hard line.
   */
  answered?: boolean;
  /** Requests waiting on this resource; a full slot pool with nobody waiting is the fleet working, not a warning. */
  waiting?: number;
}

/** `advisory`: the bound is a default nobody configured, so reaching it warns but does not fail health. */
export interface PlaneReading { used: number | null; bound: number | null; detail?: string | null; advisory?: boolean; tables?: { table: string; bytes: number }[] }
/** What `/healthz` reports about the plane's own resources. */
export interface PlaneResources { writable: boolean; writeError: string | null; database: PlaneReading | null; github: PlaneReading | null }

/** Everything a reading is computed from; each field is null when it could not be read. */
type NamedProfile = { name: string; agentName: string; concurrency?: number };
/** The launch profiles whose sessions consume names and slots. */
export interface ProfileSet { workers: (NamedProfile & { principal: string; mode: string })[]; reviewers: NamedProfile[]; producers: NamedProfile[] }
export interface ResourceInputs {
  now: number;
  reviews: ReviewRecord[] | null; producers: ProducerRecord[] | null;
  profiles: ProfileSet;
  agents: HerdrAgent[] | null;
  work: Work[];
  plane: PlaneResources | null;
  /** The loop's liveness, with its own verdict (`state`): the executor-liveness reading faults only on a lag the verdict does not vouch for (GY-1317). */
  loop: { state: LoopState; lagMs: number | null; stalledAfterMs: number; detail: string;
    /** Read by the loop itself, mid-cycle (GY-1379): it is cycling, so whatever lag it reads is the cycle under way, never a stall. */
    self?: boolean } | null;
  /** `movedAt`: when the checkout first moved onto code the loop has not loaded (epoch ms), absent when it has not. */
  revision: { behind: number; loaded: string; checkout: string; movedAt?: number } | null;
  /**
   * The restart the loop's self-upgrade still owes, from the daemon cursor (state.upgrade.pending)
   * and the time of its latest attempt (GY-1198): absent or null when none is owed and the cursor
   * names no promotion wait, or the cursor is unread. With none owed, `to` is null and `code` false.
   * `promotion` is the cursor's promotion wait (GY-1400): what the verified release does not serve yet, and when the promotion that would serve it is due.
   * `stalled` is the cursor's named stall (GY-1445): why the owed restart cannot complete, since when, and its latest attempt.
   */
  upgrade?: { from: string | null; to: string | null; code: boolean; attemptedAt: number | null; promotion?: PromotionWait | null; stalled?: UpgradeStall | null } | null;
  /** The reclaim pass's seen-unowned map (pane → first seen), from .graphyard/resource-reclaims.json; absent or null when unread. */
  reclaimSeen?: Record<string, string> | null;
  disk: { path: string; totalBytes: number; freeBytes: number; thresholdBytes: number } | null;
  /**
   * The host temporary directories' inodes, and what the loop's last /tmp pass removed (GY-1074):
   * one per filesystem the pass scans (GY-1602), each read as its own row; absent or null when unread.
   */
  tmp?: TmpInodes | readonly TmpInodes[] | null;
}
/**
 * The latest finished /tmp pass: its count, when it was recorded and the directories it scanned
 * (GY-1081, GY-1368); the escalation steps it ran below the inode headroom and, when the bound
 * still stood at its end, the top consumers it named (GY-1597).
 */
export interface TmpPassRecord { removed: number; at: string; roots?: string[]; escalated?: TmpReclaimReport['escalated']; consumers?: TmpConsumer[]; pressure?: TmpRootPressure[] }
export interface TmpInodes {
  path: string; totalInodes: number; freeInodes: number;
  /** What the last /tmp pass to remove anything removed, and when it was recorded. */
  removed: number | null; removedAt: string | null;
  /** The latest finished /tmp pass's own count, often 0 (GY-1081); null before any pass is recorded. */
  latest?: TmpPassRecord | null;
  /** Whether the latest pass's roots include the directory measured here, by realpath; null when no pass named its roots (GY-1368). */
  measuredScanned?: boolean | null;
  /**
   * This user's own top-level entries in the directory, and how many carry a test temp name
   * (GY-1081): the per-user quota is not readable without quotactl, so this is what the reading can
   * show of this user's share. `capped` when the count stopped at `ownEntriesScanBound`. `tsxCache`
   * names this user's tsx compile cache and the entries under it, which `entries` includes (GY-1512):
   * one top-level directory that held 89,896 of them on 8 October 2026. `agentScratch` counts the
   * top-level entries carrying an agent scratch name the pass also reclaims (GY-1618), when any do.
   */
  own?: { entries: number; testTemp: number; capped: boolean; tsxCache?: { name: string; entries: number }; agentScratch?: number } | null;
  /**
   * The consumers the latest pass named in this directory's own census, and whether that census
   * stopped at its budget (GY-1602): another root's consumers never stand in for this one's.
   */
  consumers?: TmpConsumer[]; censusPartial?: boolean;
  /** Whether the latest pass measured this directory still below its headroom at its end (GY-1602). */
  belowAfterPass?: boolean;
}

export interface ResourceDefinition {
  id: ResourceId; title: string; unit: string;
  /** What bounds the resource, as configured or declared in code. */
  bound: string;
  /** Where its current usage is read. */
  usage: string;
  /** The component that consumes it and is answerable for it. */
  owner: string;
  /** How it is given back, and within what bound. */
  reclaim: string;
  /** What the master does when it runs low. */
  remedy: string;
  /** Headroom below which the resource warns, from its bound. */
  warnBelow: (bound: number) => number;
  /** Downstream refusals this resource causes when it is at its bound. */
  symptoms: RegExp[];
  /** The ledger schema whose array cap this resource is, when it is a ledger. */
  ledgerSchema?: string;
  /** A part's own `warnBelow` replaces the definition's line for that reading: a lag the loop's liveness verdict vouches for warns at none (GY-1317). */
  read: (input: ResourceInputs) => (Omit<ResourceReading, 'resource' | 'title' | 'unit' | 'owner' | 'reclaim' | 'remedy' | 'headroom' | 'state' | 'warnBelow'> & { warnBelow?: number })[];
}

/** Terminal ledger records are kept this long after they settle, then reaped. */
export const ledgerRetentionMs = 15 * 60_000;
/** A pending session blocked on a prompt this long, or absent from Herdr on every pass this long, releases its slot. */
export const stuckSessionMs = 10 * 60_000;
/** A finished session is closed once its record has been settled this long (the launcher's own close gets the first chance). */
export const finishedSessionGraceMs = 60_000;
/**
 * A finished session still holding a profile's name this long after it settled has outlasted every
 * path that gives names back — the reclaim pass's grace and two passes, the loop's close of a worker
 * pane once its lease ends — so the name is a fault; before it, the reclaim is under way (GY-1089).
 */
export const nameReclaimBoundMs = stuckSessionMs;
/**
 * How long a pane holding a name must have been seen unowned before the reclaim closes it on
 * Herdr's report alone — no settled record left on the name, or a status Herdr does not recognise
 * as finished (GY-1166). It equals the launcher's `launchAppearanceMs` (src/daemon/effects.ts): a
 * launch whose runtime has not yet appeared reads the same way, and is never taken for a leak.
 */
export const unownedPaneConfirmMs = 120_000;
/**
 * How long the loop may run behind code its checkout moved onto before that is a fault (GY-1196).
 * The checkout moves while the loop runs — the self-upgrade aligns it between cycles, and then
 * restarts the executors and the loop once their held claims settle — so a move read a moment
 * later is that upgrade under way, not a loop left on old code. Loaded cycles have run for up to
 * fifteen minutes, so the bound gives the upgrade two of them.
 */
export const selfUpgradeBoundMs = 30 * 60_000;
/**
 * Whether the loop's own liveness verdict vouches for its lag (GY-1317): running, with a lag inside
 * the stall bound — or read by the loop itself, which is the cycling it would vouch for (GY-1379).
 */
export const vouchedLag = (loop: NonNullable<ResourceInputs['loop']>) => loop.state === 'running' && (loop.self === true || (loop.lagMs !== null && loop.lagMs < loop.stalledAfterMs));
/**
 * The upgrade's bound for this loop (GY-1255): the upgrade runs between cycles, so a loop whose
 * `run` config spaces cycles further apart than the fixed bound allows gets its own stalled bound
 * (two intervals and any backoff) instead; it is never shorter than `selfUpgradeBoundMs`.
 */
export const upgradeBoundMs = (loop: ResourceInputs['loop']) => Math.max(selfUpgradeBoundMs, loop?.stalledAfterMs ?? 0);
/** The plane's database bound when GRAPHYARD_DATABASE_MAX_BYTES is unset. */
export const defaultDatabaseMaxBytes = 10 * 1024 ** 3;
/** The default warning line: a tenth of the bound, and at least one unit. */
export const tenthOf = (bound: number) => Math.max(1, Math.ceil(bound / 10));

// Both session ledgers share `sessionLedgerBound` (GY-131): a write keeps every live and pinned
// record and is refused only when those alone would pass it; other terminal records are reaped.
export const reviewLedgerBound = sessionLedgerBound;
export const producerLedgerBound = sessionLedgerBound;

const sameCommit = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
const settledAt = (record: { closedAt?: string; idleSince?: string; requestedAt: string }) => Date.parse(record.closedAt ?? record.idleSince ?? record.requestedAt);
const finished = ['idle', 'done', 'blocked'];
/**
 * A worker launch under way: an implementation session of the principal not yet ended that started
 * within `unownedPaneConfirmMs` — its pane can stand before the runtime reports or the lease lands.
 */
const launchingWorker = (principal: string | undefined, work: Work[], now: number) => work.some(item => (item.sessions ?? []).some(handle =>
  handle.kind === 'implementation' && handle.principal === principal && !handle.endedAt && now - Date.parse(handle.startedAt) < unownedPaneConfirmMs));
const reclaimableStatus = (agent: HerdrAgent) => agent.agent_status !== 'working';
/**
 * The gates the reclaim pass closes an unowned holder through. `reclaimable` is the status a holder
 * must report; `recordless` is how long a reviewer or producer pane with no ledger record on its name
 * must be seen that way before it closes, or null when it never does.
 *
 * A recordless pane that is idle or done finished, so it waits the grace. One `blocked` or `unknown`
 * may be a launch stuck on a prompt before its record landed: it waits `stuckSessionMs`, the bound a
 * pending session stuck on a prompt gets, and is closed as never started (GY-1192). A worker pane is
 * not given that bound: the launcher claims the item before it creates the pane, so a worker between
 * launch and claim already holds a live lease and is spared as owned.
 */
export interface ReclaimGates { reclaimable: (agent: HerdrAgent) => boolean; recordless: (agent: HerdrAgent) => number | null }
export const reclaimGates: ReclaimGates = {
  reclaimable: reclaimableStatus,
  recordless: agent => agent.agent_status === 'idle' || agent.agent_status === 'done' ? finishedSessionGraceMs : stuckSessionMs,
};
/**
 * The gates before GY-1165, kept so its reproduction runs the base's own pass rather than restating
 * it: a holder closed only when Herdr reported it finished, and a recordless pane never.
 */
export const baseReclaimGates: ReclaimGates = { reclaimable: agent => finished.includes(agent.agent_status ?? ''), recordless: () => null };
type Role = 'worker' | 'reviewer' | 'producer';
const roleProfiles = (input: Pick<ResourceInputs, 'profiles'>): { role: Role; name: string; agentName: string; concurrency?: number; principal?: string }[] => [
  ...input.profiles.workers.filter(profile => profile.mode === 'launch' && profile.agentName).map(profile => ({ role: 'worker' as const, name: profile.name, agentName: profile.agentName, principal: profile.principal })),
  ...input.profiles.reviewers.map(profile => ({ role: 'reviewer' as const, ...profile })),
  ...input.profiles.producers.map(profile => ({ role: 'producer' as const, ...profile })),
];
/** Live request ids: a record answering one of them is still counted by the relaunch rule and is never reaped. */
function liveRequests(work: Work[]) {
  const ids = new Set<string>();
  for (const item of work) {
    if (item.stage === 'done') continue;
    const review = item.autoDispatch?.review;
    if (review && review.state === 'requested') ids.add(review.id);
    for (const producer of item.autoDispatch?.producers ?? []) if (producer.state === 'requested') ids.add(producer.id);
  }
  return ids;
}
/** Whether a live session owns an agent name: a pending ledger record, or a worker's live lease. */
function liveOwner(profile: ReturnType<typeof roleProfiles>[number], name: string, input: Pick<ResourceInputs, 'reviews' | 'producers' | 'work' | 'now'>) {
  if (profile.role === 'worker') return input.work.some(item => !!item.lease && item.lease.owner === profile.principal && Date.parse(item.lease.expiresAt) > input.now);
  const records: { agentName: string; state: string }[] = profile.role === 'reviewer' ? input.reviews ?? [] : input.producers ?? [];
  return records.some(record => record.state === 'pending' && record.agentName === name);
}
/**
 * When the session last holding `name` settled: the newest ledger record on the name for a reviewer
 * or producer, the newest implementation session of the principal for a worker. Null when nothing
 * records one — a reviewer or producer record is written before its pane, so such a holder has none.
 * A worker session that names its pane settles that pane alone (GY-1547): a pane launched after
 * the snapshot was taken is named by no session in it, and the principal's sessions on other panes
 * settle their own, never the new one. A session naming no pane settles the name as before.
 */
function holderSettledAt(profile: ReturnType<typeof roleProfiles>[number], name: string, input: Pick<ResourceInputs, 'reviews' | 'producers' | 'work'>, pane?: string | null) {
  if (profile.role === 'worker') {
    const times = input.work.flatMap(item => (item.sessions ?? []).filter(handle => handle.kind === 'implementation' && handle.principal === profile.principal && (!pane || !handle.pane || handle.pane === pane))
      .map(handle => Date.parse(handle.endedAt ?? handle.updatedAt))).filter(Number.isFinite);
    return times.length ? Math.max(...times) : null;
  }
  const records: { agentName: string; closedAt?: string; idleSince?: string; requestedAt: string }[] = profile.role === 'reviewer' ? input.reviews ?? [] : input.producers ?? [];
  const last = records.filter(record => record.agentName === name).at(-1);
  return last ? settledAt(last) : null;
}
/** A terminal record nothing reads any more: not pinned by an open request or a verdict a pending review checks against (GY-131). */
const unpinnedTerminal = <T extends { state: string; requestedAt: string }>(records: T[]) => {
  const pinned = pinnedSessionRecords(records as any);
  return records.filter(record => (terminalSessionStates as readonly string[]).includes(record.state) && !pinned.has(record as any));
};
// Usage is what the bound applies to: live records and the terminal records still read (pinned).
// Other terminal records are retained diagnostics the next write gives up, so they never count.
const ledgerReading = (records: { state: string; requestId?: string; closedAt?: string; idleSince?: string; requestedAt: string }[] | null, bound: number, input: ResourceInputs, file: string) => {
  if (!records) return [{ id: '', used: null, bound, detail: `${file} could not be read`, reclaimable: 0 }];
  const live = liveRequests(input.work);
  const free = unpinnedTerminal(records);
  const pending = records.filter(record => !(terminalSessionStates as readonly string[]).includes(record.state)).length;
  const reapable = free.filter(record => !(record.requestId && live.has(record.requestId)) && input.now - settledAt(record) >= ledgerRetentionMs).length;
  return [{ id: '', used: records.length - free.length, bound, detail: `${pending} live, ${records.length - pending - free.length} pinned terminal, ${free.length} retained terminal (${reapable} past the ${ledgerRetentionMs / 60_000}-minute retention) in ${file}`, reclaimable: reapable }];
};
/** The refusal `SessionLedgerFullError` raises for one ledger (reviewer.ts). */
const ledgerRefused = (kind: 'review' | 'producer') => new RegExp(sessionLedgerRefusal.source.replace('(review|producer)', kind));

export const resourceRegistry: ResourceDefinition[] = [
  {
    id: 'review-ledger', title: 'Review ledger', unit: 'records', ledgerSchema: 'reviewLedgerSchema',
    bound: `sessionLedgerBound (${reviewLedgerBound} live and pinned records); a write past it is refused as SessionLedgerFullError, after retained terminal records are given up`,
    usage: 'records in .graphyard/reviews.json', owner: 'src/reviewer.ts — the review launcher and its reconciliation',
    reclaim: `the reclaim pass reaps terminal records ${ledgerRetentionMs / 60_000} minutes after they settle, unless they answer a live review request`,
    remedy: 'graphyard master run --once runs the reclaim pass now; while terminal records answer live requests, settle those requests first',
    warnBelow: tenthOf, symptoms: [ledgerRefused('review')],
    read: input => ledgerReading(input.reviews, reviewLedgerBound, input, '.graphyard/reviews.json'),
  },
  {
    id: 'producer-ledger', title: 'Producer ledger', unit: 'records', ledgerSchema: 'producerLedgerSchema',
    bound: `sessionLedgerBound (${producerLedgerBound} live and pinned records); a write past it is refused as SessionLedgerFullError, after retained terminal records are given up`,
    usage: 'records in .graphyard/producers.json', owner: 'src/producer.ts — the proof-producer launcher and its reconciliation',
    reclaim: `the reclaim pass reaps terminal records ${ledgerRetentionMs / 60_000} minutes after they settle, unless they answer a live producer request`,
    remedy: 'graphyard master run --once runs the reclaim pass now; while live or pinned records fill the bound, settle those sessions and requests first',
    warnBelow: tenthOf, symptoms: [ledgerRefused('producer')],
    read: input => ledgerReading(input.producers, producerLedgerBound, input, '.graphyard/producers.json'),
  },
  {
    id: 'agent-names', title: 'Herdr agent-name namespace', unit: 'names',
    bound: "each launch profile's concurrency: its fixed agent name at concurrency 1, or that many derived <agentName>-<8hex> names above it",
    usage: 'Herdr agent list: every agent whose name is one of the profile\'s session names', owner: 'Herdr, through the worker, reviewer and producer launchers in src/master.ts',
    reclaim: `the reclaim pass closes a finished pane on one of the names once its session has settled ${finishedSessionGraceMs / 1000}s and two passes that far apart saw it unowned; a pane whose status Herdr does not report as finished is closed on Herdr's report once two passes ${unownedPaneConfirmMs / 1000}s apart saw it unowned and not working, and a pane no record accounts for once two passes the grace apart (idle or done) or ${stuckSessionMs / 60_000} minutes apart (blocked or unknown, a launch that never started) saw it`,
    remedy: 'close the finished panes holding the names (graphyard master run --once, or herdr pane close PANE after confirming the session posted its result)',
    // A name held by a live session is the slot pool working; only names nothing live owns, and no
    // reclaim gave back within its bound, warn (GY-1089). A running session is never reclaimable: it
    // is a launch whose record or lease has not landed yet, or one winding down after it settled.
    warnBelow: () => 1, symptoms: [/\b(?:reviewer|producer) agent (\S+) is (?:busy|already visible) in Herdr/i, /agent_name_taken/],
    read: input => roleProfiles(input).map(profile => {
      if (!input.agents) return { id: profile.name, used: null, bound: profileConcurrency(profile), detail: 'Herdr could not be read', reclaimable: 0 };
      const held = input.agents.filter(agent => isProfileSession(profile, agent.name));
      const stale = held.filter(agent => agent.agent_status !== 'working' && !liveOwner(profile, agent.name!, input));
      // A pane the reclaim pass has seen unowned runs on the pass's own clock (GY-1198): it closes
      // the pane on a later pass, once per cycle, so the reclaim is under way until the pane has
      // stood seen-unowned for the bound. A holder the pass has not seen, or with no pane it could
      // close, keeps the settling clock.
      const seenAt = (agent: HerdrAgent) => { const first = agent.pane_id ? input.reclaimSeen?.[agent.pane_id] : undefined; const at = first ? Date.parse(first) : NaN; return Number.isFinite(at) ? at : null; };
      // A holder nothing in the snapshot settled — no record or session names it — whose status Herdr
      // does not report as finished is a launch the snapshot predates (its session and lease land in
      // the next one) or a pane only the reclaim pass judges, on its own clock, as a recordless launch
      // that may be stuck before its record lands (GY-1192): it is overdue once that clock has run the
      // bound, never at once (GY-1547). A finished holder nothing settled is still overdue at once.
      const unplaced = (agent: HerdrAgent) => holderSettledAt(profile, agent.name!, input, agent.pane_id) === null && agent.agent_status !== 'idle' && agent.agent_status !== 'done';
      const overdue = stale.filter(agent => {
        const seen = seenAt(agent);
        if (seen !== null) return input.now - seen >= nameReclaimBoundMs;
        if (unplaced(agent)) return false;
        const at = holderSettledAt(profile, agent.name!, input, agent.pane_id); return at === null || input.now - at >= nameReclaimBoundMs;
      });
      const late = (agent: HerdrAgent) => seenAt(agent) !== null ? `not reclaimed within ${nameReclaimBoundMs / 60_000} minutes of the reclaim pass first seeing it unowned` : `not reclaimed within ${nameReclaimBoundMs / 60_000} minutes of settling`;
      const underWay = (agent: HerdrAgent) => seenAt(agent) !== null ? ` (seen unowned since ${new Date(seenAt(agent)!).toISOString()})` : unplaced(agent) ? ' (no session of this snapshot names the pane; the reclaim pass judges it on its own clock)' : '';
      return { id: profile.name, used: held.length, bound: profileConcurrency(profile), reclaimable: stale.length, overdue: overdue.length,
        detail: held.length ? `${profile.role} profile ${profile.name}: ${held.map(agent => `${agent.name} (${agent.agent_status ?? 'unknown'}${overdue.includes(agent) ? `, no live session, ${late(agent)}` : stale.includes(agent) ? `, no live session, reclaim under way${underWay(agent)}` : ''}${agent.pane_id ? `, pane ${agent.pane_id}` : ''})`).join(', ')}` : `${profile.role} profile ${profile.name}: no name held` };
    }),
  },
  {
    id: 'session-slots', title: 'Session slots', unit: 'sessions',
    bound: 'the summed concurrency of the role\'s launch profiles in .graphyard/master.json',
    usage: 'pending reviewer and producer ledger records, and live worker leases held by launch-profile principals', owner: 'the master loop and its dispatcher (src/master-daemon.ts, src/auto-dispatch.ts)',
    reclaim: `a session settles when its request is answered or superseded; the reclaim pass fails a pending session finished or blocked on a prompt for ${stuckSessionMs / 60_000} minutes, or absent from Herdr on every pass for ${stuckSessionMs / 60_000} minutes, which releases its slot; a worker lease held past the ${workerSubmissionBoundMs / 60_000}-minute worker bound without a submission is a stalled-gate fault however it renews, and past ${workerReclaimBoundMs / 60_000} minutes with no submission progress the loop ends the attempt and stops its supervisor, which returns its slot`,
    remedy: 'raise concurrency on a profile of the role, or add a profile on another account, in .graphyard/master.json',
    warnBelow: () => 1, symptoms: [/every (?:reviewer|independent producer) profile is busy/, /is at its concurrency limit/],
    read: input => (['worker', 'reviewer', 'producer'] as const).map(role => {
      const profiles = roleProfiles(input).filter(profile => profile.role === role);
      const bound = profiles.reduce((sum, profile) => sum + profileConcurrency(profile), 0);
      const live = liveRequests(input.work);
      if (role === 'worker') {
        const used = input.work.filter(item => !!item.lease && Date.parse(item.lease.expiresAt) > input.now && profiles.some(profile => profile.principal === item.lease!.owner)).length;
        return { id: role, used, bound, detail: `${used} live worker lease(s) across ${profiles.length} launch profile(s)`, reclaimable: 0 };
      }
      const records: { state: string; requestId?: string; agentName: string; idleSince?: string; requestedAt: string }[] | null = role === 'reviewer' ? input.reviews : input.producers;
      if (!records) return { id: role, used: null, bound, detail: 'the ledger could not be read', reclaimable: 0 };
      const pending = records.filter(record => record.state === 'pending');
      const answered = new Set(pending.map(record => record.requestId).filter(Boolean));
      const waiting = input.work.flatMap(item => role === 'reviewer' ? [item.autoDispatch?.review?.id] : (item.autoDispatch?.producers ?? []).map(entry => entry.id)).filter((id): id is string => !!id && live.has(id) && !answered.has(id)).length;
      const stuck = pending.filter(record => stuckSession(record, input.agents, input.now)).length;
      return { id: role, used: pending.length, bound, waiting, reclaimable: stuck, detail: `${pending.length} ${role} session(s) pending across ${profiles.length} profile(s), ${waiting} request(s) waiting for a slot${stuck ? `, ${stuck} finished, stuck on a prompt or never started` : ''}` };
    }),
  },
  {
    id: 'github-budget', title: 'GitHub App request budget', unit: 'requests',
    bound: 'the installation token\'s hourly core rate limit, as GitHub reports it on GET /rate_limit',
    usage: '/healthz resources.github, read by the plane from GET /rate_limit (cached for a minute; that read costs nothing against the budget); while the client is paused after a rate-limit refusal its usage is unread (the pause is the remediation under way, counted once as an observation fault) until the pause ends, when the read resumes', owner: 'the control plane\'s GitHub client (src/github.ts) and its observation jobs',
    reclaim: 'GitHub restores the budget at the reset time it reports; the client pauses every request until then once it is spent',
    remedy: 'lower observation load (fewer open candidates, a longer job interval) until the reset; every merge waits on fresh observations',
    warnBelow: tenthOf, symptoms: [/GitHub requests paused until/, /rate limited; requests paused/],
    read: input => [{ id: '', used: input.plane?.github?.used ?? null, bound: input.plane?.github?.bound ?? null, detail: input.plane?.github?.detail ?? (input.plane ? 'the plane has no GitHub App configured' : 'the plane\'s /healthz could not be read'), reclaimable: 0 }],
  },
  {
    id: 'executor-liveness', title: 'Master loop liveness', unit: 'ms since last cycle',
    bound: 'two cycle intervals past the last completed cycle (plus any announced backoff): the loop\'s own stalled bound',
    usage: 'the daemon cursor (lastCycleAt, lock) the loop writes every cycle', owner: 'the master loop process (graphyard master run, supervised as graphyard-master)',
    reclaim: 'the supervisor restarts a loop whose watchdog stops hearing from it; graphyard master restart does the same by hand',
    remedy: 'graphyard master restart (a supervised deployment restarts it on its own: systemctl --user restart graphyard-master)',
    warnBelow: bound => Math.ceil(bound / 2), symptoms: [],
    // The loop's idle cadence waits a full interval between cycles by design, so its next reading
    // always lands just past the one-interval warn line (GY-1317). A lag the loop's own verdict
    // vouches for — running, within the stall bound — is within its bound; the detail keeps the true
    // lag and the verdict. A slow, stalled or absent verdict, or a lag past the bound, still warns.
    read: input => {
      const loop = input.loop;
      if (!loop) return [{ id: '', used: null, bound: null, detail: 'the daemon cursor could not be read', reclaimable: 0 }];
      const vouched = vouchedLag(loop);
      // Read by the loop itself, the lag may pass the bound (a long cycle, or the restart before it): the loop's cycling answers it (GY-1379).
      return [{ id: '', used: loop.lagMs, bound: loop.stalledAfterMs, reclaimable: 0, ...(vouched ? { warnBelow: 0 } : {}), ...(loop.self ? { answered: true } : {}),
        detail: `${loop.detail}; the loop's liveness verdict is ${loop.state}${loop.self ? ', read by the loop itself mid-cycle, so the lag is the cycle under way' : vouched ? ', which vouches for the lag within the stall bound' : ''}` }];
    },
  },
  {
    id: 'loaded-revision', title: 'Loop loaded-code revision', unit: 'commits behind',
    bound: 'zero: the loop must run the code its checkout holds',
    usage: 'commits the coordinator checkout moved past the one the running loop process loaded, from the checkout\'s HEAD reflog and the process start time; a move that touches no loaded code (src/, scripts/, bin/, package.json) counts none, as the self-upgrade restarts nothing for it', owner: 'the master loop process and the coordinator checkout',
    reclaim: `the between-cycles self-upgrade restarts the loop onto the checkout's revision; a move it has not loaded within ${selfUpgradeBoundMs / 60_000} minutes counts, unless the restart it owes onto that revision was attempted within the same bound (retried each cycle while an executor's claim refuses the fleet restart, whether or not production is verified; the loop re-executes onto it by itself once that refusal has stood ${selfUpgradeBoundMs / 2 / 60_000} minutes, the self-upgrade's fleet wait), or the loop runs the verified release production serves and what it has not loaded waits on a promotion not yet due or in validation`,
    remedy: 'graphyard master restart so the loop runs the code the checkout holds',
    warnBelow: () => 0, symptoms: [],
    // A move the self-upgrade is still within its bound for is the upgrade under way (GY-1196):
    // the upgrade itself moves the checkout, so a reading taken just after always saw it behind.
    read: input => {
      const revision = input.revision;
      if (!revision) return [{ id: '', used: null, bound: 0, detail: 'no running loop process, or its start could not be read', reclaimable: 0 }];
      const bound = upgradeBoundMs(input.loop);
      const pending = revision.behind > 0 && revision.movedAt !== undefined && input.now - revision.movedAt < bound;
      // A restart the self-upgrade owes onto this checkout and retried within the bound is the
      // upgrade under way too (GY-1198): a claim held across every cycle refuses it, and the
      // cursor keeps it owed until a quiet instant; only one not attempted within the bound counts.
      const owed = input.upgrade?.code === true && sameCommit(input.upgrade.to, revision.checkout) ? input.upgrade : null;
      const restarting = !pending && revision.behind > 0 && owed?.attemptedAt != null && input.now - owed.attemptedAt < bound;
      // The loop loaded the release production verifiably serves, so every commit past it is one no
      // verified release serves yet (GY-1400): while the promotion that would serve them is on
      // schedule, the loop could not have loaded them, and a restart would reload the same release.
      const wait = input.upgrade?.promotion ?? null;
      const promoting = !pending && !restarting && revision.behind > 0 && promotionHolds(wait, revision.loaded, input.now);
      // Why the owed restart cannot complete, beside the two revisions (GY-1445): a named cause and
      // its latest attempt, never a silent pin at the bound.
      const stalled = revision.behind > 0 ? input.upgrade?.stalled ?? null : null;
      const cause = stalled ? `; the self-upgrade's restart is stalled on ${stalled.cause} since ${stalled.since}, last attempted ${stalled.at}: ${stalled.reason}` : '';
      return [{ id: '', used: pending || restarting || promoting ? 0 : revision.behind, bound: 0, reclaimable: 0,
        detail: `the loop loaded ${revision.loaded.slice(0, 12)}; the checkout is at ${revision.checkout.slice(0, 12)}${pending ? ` (${revision.behind} commits behind since ${new Date(revision.movedAt!).toISOString()}; the self-upgrade has until ${new Date(revision.movedAt! + bound).toISOString()})`
          : promoting ? ` (${revision.behind} commits behind; the loop runs the verified release production serves, and ${wait!.pending.join(', ')} wait on ${describePromotion(wait!)}: no restart is owed, as one would reload the same release)`
          : restarting ? ` (${revision.behind} commits behind; the self-upgrade's owed restart onto it is under way, last attempted ${new Date(owed!.attemptedAt!).toISOString()} and retried each cycle until ${new Date(owed!.attemptedAt! + bound).toISOString()})`
          : owed ? ` (the self-upgrade owes a restart onto it, ${owed.attemptedAt === null ? 'with no attempt recorded' : `last attempted ${new Date(owed.attemptedAt).toISOString()}`})` : ''}${cause}` }];
    },
  },
  {
    id: 'database-capacity', title: 'Control-plane database', unit: 'bytes',
    bound: `GRAPHYARD_DATABASE_MAX_BYTES on the plane, else the database volume's size when the plane can read it, else ${defaultDatabaseMaxBytes / 1024 ** 3} GiB, which only warns; a configured or measured bound also fails health`,
    usage: '/healthz resources.database: pg_database_size of the plane\'s database', owner: 'the control plane (src/store)',
    reclaim: 'receipts past one day are pruned and routine ledger rows past the retention window compacted (store/compaction.ts); space returns to Postgres for reuse, to the volume only after VACUUM FULL; otherwise grow the volume, or restore a backup onto a larger one (docs/operations-reference.md)',
    remedy: 'grow the database volume and raise GRAPHYARD_DATABASE_MAX_BYTES to match before writes fail',
    warnBelow: tenthOf, symptoms: [/could not extend file|No space left on device|disk full/i],
    read: input => [{ id: '', used: input.plane?.database?.used ?? null, bound: input.plane?.database?.bound ?? null, detail: input.plane?.database?.detail ?? (input.plane ? null : 'the plane\'s /healthz could not be read'), reclaimable: 0,
      ...(input.plane?.database?.advisory ? { advisory: true } : {}) }],
  },
  {
    id: 'worktree-disk', title: 'Coordinator worktree disk', unit: 'bytes',
    bound: 'the size of the volume holding .graphyard/worktrees; it warns at run.diskThresholdGb free',
    usage: 'statfs of .graphyard/worktrees', owner: 'the worker launcher and the loop\'s worktree reclamation (src/master.ts)',
    reclaim: 'the loop reclaims dependency directories of finished worktrees every cycle while free space is below the threshold',
    remedy: 'graphyard master run --once reclaims now; lower run.reclaimIdleHours to make more worktrees disposable',
    warnBelow: bound => bound, symptoms: [/ENOSPC|No space left on device|Disk quota exceeded/],
    read: input => [input.disk ? { id: '', used: input.disk.totalBytes - input.disk.freeBytes, bound: input.disk.totalBytes, detail: `${input.disk.path}`, reclaimable: 0 } : { id: '', used: null, bound: null, detail: 'free space could not be read', reclaimable: 0 }],
  },
  {
    id: 'tmp-inodes', title: 'Host /tmp inodes', unit: 'inodes',
    // statfs reports the filesystem's free inodes, not what remains of this user's quota: a quota is
    // not readable without quotactl, so the reading warns early rather than claiming to track it.
    bound: 'the inode count of the filesystem holding the host temporary directory (filesystem-wide, not the per-user quota, which can break shells first), so it warns at a quarter free',
    usage: 'statfs of the host temporary directory (os.tmpdir() of the reading process)', owner: 'test runs and sessions on the coordinator host, and the loop\'s /tmp reclaim pass (src/tmp-reclaim.ts)',
    reclaim: `the loop's reclaim pass scans its own tmpdir and /tmp, each once, and removes this user's test temp entries (${testTempPatterns.map(pattern => `${pattern.source.slice(1)}*`).join(', ')}) older than ${testTempMinAgeMs / 3_600_000} hours, this user's agent scratch entries (${agentScratchPatterns.map(pattern => `${pattern.source.slice(1).replace('\\d+', '<n>')}*`).join(', ')}) whose whole tree, and a linked worktree's gitdir, went unwritten for ${agentScratchMinAgeMs / 3_600_000} hours, and the regular files in this user's tsx compile cache (tsx-<uid>) older than ${tmpReclaimMinAgeMs / 3_600_000} hours, that no live process holds open or names in its command line, at most ${tmpReclaimLimitPerCycle} per cycle; while /tmp stays below a quarter of its inodes free the same pass escalates (${tmpReclaimEscalation.map(step => `${step.limit} per cycle and cache files older than ${minutes(step.cacheAgeMs)}`).join(', then ')}) and, if the bound still stands, names the top /tmp consumers by path, entry count and owner`,
    remedy: 'graphyard master run --once reclaims now; find what else fills /tmp (ls /tmp | sort | uniq -c) and stop the process leaking it',
    warnBelow: tmpInodeHeadroom, symptoms: [],
    // The quarter-free line is an early warning on a filesystem-wide count every process on the host
    // fills (GY-1379): while the loop's latest pass is current and scanned the measured directory, it
    // has taken back all it may, so a reading above a tenth free is reported and raises nothing — unless
    // that pass itself left the directory below the headroom, whatever it removed (GY-1597, GY-1602).
    // One row per root the pass scans (GY-1602): a low /tmp raises its own attention, naming its own
    // consumers, whatever the loop's TMPDIR reads, even when both sit on one filesystem.
    read: input => {
      const roots = !input.tmp ? [] : Array.isArray(input.tmp) ? input.tmp as readonly TmpInodes[] : [input.tmp as TmpInodes];
      if (!roots.length) return [{ id: '', used: null, bound: null, detail: 'the host temporary directory\'s inodes could not be read', reclaimable: 0 }];
      return roots.map((tmp, index) => {
        const answered = tmpPassAnswers(tmp, input.now);
        return { id: index ? tmp.path : '', used: tmp.totalInodes - tmp.freeInodes, bound: tmp.totalInodes, reclaimable: 0, ...(answered ? { answered } : {}),
          detail: `${describeTmpInodes(tmp)}${answered ? `; that pass is current over ${tmp.path}, so what remains is outside its reach and only falling below a tenth free raises attention` : ''}` };
      });
    },
  },
];

/** How recent the loop's latest /tmp pass must be to answer a low tmp-inodes reading: two loaded cycles (GY-1379). */
export const tmpPassCurrentMs = 30 * 60_000;
/**
 * Whether the loop's own /tmp pass answers a low tmp-inodes reading (GY-1379): it finished within
 * `tmpPassCurrentMs`, scanned the measured directory, and the volume is still above a tenth free.
 * A pass that left this directory below its headroom at its end, so named its top consumers,
 * answers nothing, whatever it removed (GY-1597, GY-1602): what still fills it is outside the
 * pass's reach, and the attention must carry the consumers it named until someone stops the leaker.
 */
export function tmpPassAnswers(tmp: TmpInodes, now: number) {
  const at = tmp.latest ? Date.parse(tmp.latest.at) : Number.NaN;
  if (tmp.belowAfterPass || consumersOf(tmp).length) return false;
  return Number.isFinite(at) && now - at < tmpPassCurrentMs && tmp.measuredScanned === true && tmp.freeInodes >= tenthOf(tmp.totalInodes);
}
const entries = (count: number) => `${count} entr${count === 1 ? 'y' : 'ies'}`;
/** The consumers the latest pass named in this directory: its own census, or, from a record without one, those under its path. */
const consumersOf = (tmp: TmpInodes) => tmp.consumers ?? tmp.latest?.consumers?.filter(consumer => consumer.path.startsWith(`${tmp.path}/`)) ?? [];
/** The tmp-inodes detail: free inodes, this user's share, the latest pass's count and the last count that was not 0. */
function describeTmpInodes(tmp: TmpInodes) {
  const parts = [`measured ${tmp.path}: ${tmp.freeInodes} of ${tmp.totalInodes} inodes free`];
  if (tmp.own) parts.push(`${tmp.own.capped ? 'at least ' : ''}${entries(tmp.own.entries)} are this user's (${tmp.own.testTemp} top-level with test temp names${tmp.own.agentScratch ? `, ${tmp.own.agentScratch} with agent scratch names` : ''}${tmp.own.tsxCache ? `, ${entries(tmp.own.tsxCache.entries)} under its tsx compile cache ${tmp.own.tsxCache.name}` : ''}); the per-user quota itself is not readable`);
  if (tmp.latest) parts.push(`the loop's latest /tmp pass removed ${entries(tmp.latest.removed)} at ${tmp.latest.at}${tmp.latest.roots ? `, scanning ${tmp.latest.roots.join(' and ')}` : ''}`);
  // Below the headroom the pass escalated in the same run (GY-1597): say how far, and what it could not reach.
  const top = tmp.latest?.escalated?.at(-1);
  if (top) parts.push(`below the inode headroom it escalated to ${top.limit} per cycle and tsx cache files older than ${minutes(top.cacheAgeMs)} (${tmp.latest!.escalated!.map(step => step.removed).join(' + ')} removed by the escalated steps)`);
  const consumers = consumersOf(tmp);
  if (consumers.length) parts.push(`the bound still stood, so the top /tmp consumers are ${consumers.map(consumer => `${consumer.path} (${consumer.capped ? 'at least ' : ''}${entries(consumer.entries)}, owner ${consumer.owner})`).join(', ')}${tmp.censusPartial ? ` (a partial census: it stopped at its ${tmpConsumersScanBound}-entry budget)` : ''}`);
  // A pass over another directory than the one warned about removes nothing here: say so (GY-1368).
  if (tmp.measuredScanned === false) parts.push(`that pass did not scan ${tmp.path}`);
  if (tmp.removed === null) parts.push('the loop has recorded no /tmp pass that removed anything');
  else if (!tmp.latest || tmp.latest.at !== tmp.removedAt) parts.push(`the last pass to remove anything removed ${entries(tmp.removed)}${tmp.removedAt ? ` at ${tmp.removedAt}` : ''}`);
  return parts.join('; ');
}

/**
 * What the loop consumes that the registry does not declare: a capped ledger schema no entry
 * names, or a resource no entry reads. Empty when the registry is complete.
 */
export function registryGaps(consumed: { ledgers: string[]; resources: string[] }, registry: ResourceDefinition[] = resourceRegistry) {
  const ledgers = new Set(registry.map(entry => entry.ledgerSchema).filter(Boolean));
  const ids = new Set<string>(registry.map(entry => entry.id));
  return [...consumed.ledgers.filter(name => !ledgers.has(name)).map(name => `ledger ${name}`), ...consumed.resources.filter(id => !ids.has(id)).map(id => `resource ${id}`)];
}

function stuckSession(record: { state: string; agentName: string; idleSince?: string; requestedAt: string }, agents: HerdrAgent[] | null, now: number) {
  if (record.state !== 'pending' || !agents) return false;
  const agent = agents.find(candidate => candidate.name === record.agentName);
  if (!agent) return now - Date.parse(record.requestedAt) >= stuckSessionMs;
  if (agent.agent_status === 'blocked') return now - Date.parse(record.idleSince ?? record.requestedAt) >= stuckSessionMs;
  if (finished.includes(agent.agent_status ?? '')) return !!record.idleSince && now - Date.parse(record.idleSince) >= stuckSessionMs;
  return false;
}

const disk = new Set<ResourceId>(['worktree-disk', 'database-capacity']);
/** Every registered resource read from one set of inputs. */
export function readResources(input: ResourceInputs, registry = resourceRegistry): ResourceReading[] {
  return registry.flatMap(definition => definition.read(input).map(part => {
    const headroom = part.used === null || part.bound === null ? null : part.bound - part.used;
    const warnBelow = part.warnBelow ?? (definition.id === 'worktree-disk' && input.disk ? input.disk.thresholdBytes : part.bound === null ? 0 : definition.warnBelow(part.bound));
    const exhausted = headroom !== null && (headroom < 0 || (headroom === 0 && (part.bound ?? 0) > 0));
    const state: ResourceState = headroom === null ? 'unknown' : exhausted ? 'exhausted' : headroom < warnBelow ? 'low' : 'ok';
    return { ...part, id: part.id ? `${definition.id}:${part.id}` : definition.id, resource: definition.id, title: definition.title, unit: definition.unit, headroom, warnBelow, state,
      owner: definition.owner, reclaim: definition.reclaim, remedy: definition.remedy };
  }));
}

const amount = (reading: Pick<ResourceReading, 'unit' | 'resource'>, value: number | null) => value === null ? 'unknown'
  : disk.has(reading.resource) ? `${(value / 1e9).toFixed(1)} GB` : reading.unit.startsWith('ms') ? `${Math.round(value / 1000)}s` : `${value} ${reading.unit}`;
/** One sentence naming the resource, its usage against its bound, and its headroom. */
export const describeReading = (reading: ResourceReading) =>
  `${reading.title}${reading.id.includes(':') ? ` (${reading.id.split(':')[1]})` : ''} is ${reading.state === 'exhausted' ? 'at its bound' : 'low'}: ${amount(reading, reading.used)} used of ${amount(reading, reading.bound)}, ${amount(reading, reading.headroom === null ? null : Math.max(0, reading.headroom))} left${reading.detail ? ` — ${reading.detail}` : ''}`;

/**
 * Whether a reading raises attention. A low or exhausted resource does, before it is exhausted
 * where its threshold allows. Two resources are judged on what nothing live is using: a name held
 * by a running session, or a slot pool full with nobody waiting, is the fleet working; and a name a
 * finished session holds raises it only once its reclaim is overdue. A default bound nobody
 * configured (advisory) is reported but raises nothing: reaching a guess is not a bound (GY-1089);
 * nor does an early warning the loop's own reclaim already answers (GY-1379).
 */
export function needsAttention(reading: ResourceReading) {
  if (reading.state !== 'low' && reading.state !== 'exhausted') return false;
  if (reading.advisory || reading.answered) return false;
  if (reading.resource === 'agent-names') return (reading.overdue ?? 0) > 0;
  if (reading.resource === 'session-slots') return (reading.waiting ?? 0) > 0;
  return true;
}
/** One attention item per resource below its warning line: the resource, its bound, its usage and its remedy. */
export function resourceAttention(readings: ResourceReading[]): AttentionItem[] {
  return readings.filter(needsAttention).map(reading => ({ subject: `resource:${reading.id}`,
    text: `${describeReading(reading)}. It warns below ${amount(reading, reading.warnBelow)} of headroom; ${reading.reclaim}`, ...agentOwner('master', reading.remedy) }));
}

/** An error whose cause is a registered resource at its bound. */
export class ResourceExhaustedError extends Error {
  constructor(readonly reading: ResourceReading, cause?: string) {
    super(`${describeReading(reading)}. ${reading.remedy}${cause ? ` — ${cause}` : ''}`);
  }
}

/**
 * The reading a refusal is attributed to: an exhausted (or low) reading one of whose symptoms the
 * refusal matches. A namespace symptom names the agent, and only that agent's namespace takes it.
 */
export function attributionFor(reason: string, readings: ResourceReading[]): ResourceReading | null {
  for (const reading of readings) {
    if (reading.state !== 'exhausted') continue;
    const definition = resourceRegistry.find(entry => entry.id === reading.resource);
    for (const symptom of definition?.symptoms ?? []) {
      const match = symptom.exec(reason);
      if (!match) continue;
      if (reading.resource === 'agent-names' && match[1] && !(reading.detail ?? '').includes(`${match[1]} (`)) continue;
      return reading;
    }
  }
  return null;
}

/**
 * A ledger write refused by its own bound names the ledger, even where nothing read it first:
 * `SessionLedgerFullError` (reviewer.ts) names which ledger refused.
 */
export function ledgerExhaustion(error: unknown): ResourceReading | null {
  const text = error instanceof Error ? error.message : String(error);
  for (const [kind, resource, bound] of [['review', 'review-ledger', reviewLedgerBound], ['producer', 'producer-ledger', producerLedgerBound]] as const) {
    if (!(error instanceof SessionLedgerFullError ? error.spec.role === (kind === 'review' ? 'reviewer' : 'producer') : ledgerRefused(kind).test(text))) continue;
    const definition = resourceRegistry.find(entry => entry.id === resource)!;
    return { id: resource, resource, title: definition.title, unit: definition.unit, used: bound, bound, headroom: 0, warnBelow: definition.warnBelow(bound), state: 'exhausted',
      owner: definition.owner, reclaim: definition.reclaim, remedy: definition.remedy, detail: `a write of a further record was refused by its bound (SessionLedgerFullError)`, reclaimable: 0 };
  }
  return null;
}

/**
 * The reason a failed action records. A refusal caused by a registered resource at its bound
 * names the resource and its bound instead of the downstream effect; any other reason is kept.
 */
export function attributeRefusal(error: unknown, readings: ResourceReading[] = []): Error {
  if (error instanceof ResourceExhaustedError) return error;
  const text = error instanceof Error ? error.message : String(error);
  const ledger = ledgerExhaustion(error);
  // A ledger refusal keeps its own text after the resource: master status attributes a standing
  // ledger refusal from it (GY-131's `sessionLedgerRefusal`).
  if (ledger) return new ResourceExhaustedError(ledger, text);
  const reading = attributionFor(text, readings);
  return reading ? new ResourceExhaustedError(reading) : error instanceof Error ? error : new Error(text);
}

/** The agent-name readings of the given profiles against a Herdr inventory, for a launcher that has nothing else read. */
export function agentNameReadings(profiles: Partial<ProfileSet>, agents: HerdrAgent[], context: Partial<Pick<ResourceInputs, 'reviews' | 'producers' | 'work'>> = {}, now = Date.now()) {
  const names = resourceRegistry.find(entry => entry.id === 'agent-names')!;
  return readResources({ now, reviews: context.reviews ?? null, producers: context.producers ?? null, work: context.work ?? [], agents, plane: null, loop: null, revision: null, disk: null,
    profiles: { workers: profiles.workers ?? [], reviewers: profiles.reviewers ?? [], producers: profiles.producers ?? [] } }, [names]);
}

/**
 * Refuses a launch into an exhausted namespace before the runtime is asked: every name the
 * profile may take is held, so the launch would be refused as a name already taken.
 */
export function assertNameAvailable(role: 'reviewer' | 'producer', profile: { name: string; agentName: string; concurrency?: number }, agents: HerdrAgent[], context: Partial<Pick<ResourceInputs, 'reviews' | 'producers' | 'work'>> = {}) {
  const reading = agentNameReadings(role === 'reviewer' ? { reviewers: [profile] } : { producers: [profile] }, agents, context)[0];
  if (reading?.state === 'exhausted') throw new ResourceExhaustedError(reading);
}

// ---- Reading the inputs on the coordinator host ----------------------------------------------

/** The plane's own report of its resources, from its unauthenticated health endpoint. */
export async function readPlaneResources(url: string, fetcher: typeof fetch = fetch): Promise<PlaneResources | null> {
  try {
    const response = await fetcher(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { writable?: boolean; causes?: string[]; resources?: { database?: PlaneReading | null; github?: PlaneReading | null } };
    return { writable: body.writable !== false, writeError: body.writable === false ? body.causes?.[0] ?? 'writes are refused' : null, database: body.resources?.database ?? null, github: body.resources?.github ?? null };
  } catch { return null; }
}

/**
 * How far the checkout moved past the code a process loaded: the HEAD it had when the process
 * started (from the times of the checkout's reflog entries) against HEAD now. Null when the process is gone or the
 * reflog does not reach back to its start.
 */
type Run = (command: string, args: string[]) => string;
const runCommand: Run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
/**
 * Whether a move touches loaded code, per runner and by `root loaded..sha`: both ends are commits,
 * so the answer never changes, and a long-lived loop's readings diff only the moves new since the
 * last one rather than every move since it started (GY-1255). Each runner's cache is bounded.
 */
const touchesCodeCache = new WeakMap<Run, Map<string, boolean>>();
const touchesCodeCacheBound = 1_000;
/**
 * `measuredAt` is the instant `ps` is asked, which the age it answers counts back from: the host's
 * clock, never the instant a reading is judged at (GY-1547). A reading judges its snapshot at the
 * snapshot's own instant (GY-1379), tens of seconds before the faults step asks `ps`; an age
 * counted back from that earlier instant placed the loop's start before the checkout move its own
 * restart had followed, so the reading named the revision before the move as loaded.
 */
export function loadedRevision(root: string, pid: number, run: Run = runCommand, measuredAt = Date.now()) {
  try {
    const elapsed = Number(run('ps', ['-o', 'etimes=', '-p', String(pid)]).trim());
    if (!Number.isFinite(elapsed)) return null;
    const startedAt = Math.floor(measuredAt / 1000) - elapsed;
    const checkout = run('git', ['-C', root, 'rev-parse', 'HEAD']).trim();
    // The reflog entry's own time (`%gd` under --date=unix is HEAD@{<seconds>}), not the commit's:
    // a checkout that fast-forwards onto an older commit moved after the process started.
    const moves = run('git', ['-C', root, 'reflog', 'show', '--date=unix', '--format=%H %gd', '-n', '200', 'HEAD']).trim().split('\n')
      .map(line => { const [sha, selector] = line.split(' '); return [sha, /@\{(\d+)\}/.exec(selector ?? '')?.[1]] as const; }).filter(([sha, at]) => sha && at);
    const loaded = moves.find(([, at]) => Number(at) <= startedAt)?.[0] ?? (moves.length && moves.length < 200 ? moves.at(-1)![0] : null);
    if (!loaded) return null;
    if (loaded === checkout) return { loaded, checkout, behind: 0 };
    // A move that touches no code the loop loads leaves it running the checkout's code (GY-1089):
    // the self-upgrade restarts nothing for it, so it is never behind on it.
    const cache = touchesCodeCache.get(run) ?? new Map<string, boolean>();
    touchesCodeCache.set(run, cache);
    const touchesCode = (to: string) => {
      const key = `${root}\0${loaded}\0${to}`;
      const known = cache.get(key);
      if (known !== undefined) return known;
      const touches = upgradeTouchesCode(run('git', ['-C', root, 'diff', '--name-only', loaded, to]).split('\n').map(path => path.trim()).filter(Boolean));
      if (cache.size >= touchesCodeCacheBound) cache.delete(cache.keys().next().value!);
      cache.set(key, touches);
      return touches;
    };
    if (!touchesCode(checkout)) return { loaded, checkout, behind: 0 };
    // When the checkout first moved onto code the loop has not loaded: the oldest move since the
    // start whose revision differs from the loaded one in loaded code (GY-1196).
    const since = moves.filter(([, at]) => Number(at) > startedAt).reverse();
    const first = since.find(([sha]) => sha === checkout || touchesCode(sha!));
    return { loaded, checkout, behind: Number(run('git', ['-C', root, 'rev-list', '--count', `${loaded}..${checkout}`]).trim()) || 0, ...(first ? { movedAt: Number(first[1]) * 1000 } : {}) };
  } catch { return null; }
}

export async function readDisk(root: string, config: MasterConfig) {
  const path = worktreesDirectory(root);
  for (const candidate of [path, root]) {
    try { const info = await statfs(candidate); return { path, totalBytes: Number(info.blocks) * Number(info.bsize), freeBytes: Number(info.bavail) * Number(info.bsize), thresholdBytes: diskThresholdBytes(config) }; }
    catch { /* the worktree directory may not exist yet: the checkout's volume stands in */ }
  }
  return null;
}

/** The most top-level /tmp entries a reading stats for its owner: a status read stays bounded on a host with a backlog. */
export const ownEntriesScanBound = 20_000;
/** This user's own top-level entries in `path`, and how many carry a test temp name; null where there are no uids. */
export async function countOwnEntries(path: string, uid = process.getuid?.()): Promise<TmpInodes['own']> {
  if (uid === undefined) return null;
  const names = await readdir(path), cacheName = tsxCacheName(uid);
  let entries = 0, testTemp = 0, agentScratch = 0, tsxCache: { name: string; entries: number } | undefined;
  for (const name of names.slice(0, ownEntriesScanBound)) {
    let info;
    try { info = await lstat(resolve(path, name)); } catch { continue; }
    if (info.uid !== uid) continue;
    entries++;
    if (testTempPatterns.some(pattern => pattern.test(name))) testTemp++;
    else if (agentScratchPatterns.some(pattern => pattern.test(name))) agentScratch++;
    // The tsx cache is one top-level name over tens of thousands of inodes: its entries are counted
    // by name alone, so the reading names it when it is what fills the volume.
    if (name === cacheName && info.isDirectory()) {
      const inside = (await readdir(resolve(path, name), { recursive: true }).catch(() => [] as string[])).length;
      tsxCache = { name, entries: inside };
      entries += inside;
    }
  }
  return { entries, testTemp, capped: names.length > ownEntriesScanBound, ...(tsxCache ? { tsxCache } : {}), ...(agentScratch ? { agentScratch } : {}) };
}

type TmpVolume = (path: string) => Promise<{ files: number | bigint; ffree: number | bigint }>;
/**
 * The host temporary directory's inode headroom, this user's own entries in it, the latest /tmp
 * pass's count and the count the last pass to remove anything removed, from the reclaim record
 * (GY-1074, GY-1081). Null when the volume cannot be read, or reports no inode count (a filesystem
 * without fixed inodes).
 */
export async function readTmpInodes(root: string): Promise<TmpInodes[]>;
export async function readTmpInodes(root: string, path: string, volume?: TmpVolume, uid?: number): Promise<TmpInodes | null>;
export async function readTmpInodes(root: string, path?: string, volume: TmpVolume = statfs, uid = process.getuid?.()): Promise<TmpInodes | TmpInodes[] | null> {
  // Without a directory named, every root the loop's pass scans is read, each on its own filesystem (GY-1602).
  if (path === undefined) return readTmpRoots(root);
  try {
    const info = await volume(path);
    const totalInodes = Number(info.files), freeInodes = Number(info.ffree);
    if (!Number.isFinite(totalInodes) || totalInodes <= 0) return null;
    const file = await readReclaimFile(root);
    const last = file.reports.filter(report => report.tmp?.removed).at(-1);
    const own = await countOwnEntries(path, uid).catch(() => null);
    const latest = file.tmpLatest ?? null, real = (directory: string) => realpath(directory).catch(() => directory);
    const measured = await real(path);
    const measuredScanned = latest?.roots ? (await Promise.all(latest.roots.map(real))).includes(measured) : null;
    // This directory's own census from the pass, matched by realpath (GY-1602).
    let pressure: TmpRootPressure | undefined;
    for (const entry of latest?.pressure ?? []) if (!pressure && await real(entry.root) === measured) pressure = entry;
    // A pass that measured its roots but not this one named nothing here.
    const census = pressure ? { consumers: pressure.consumers ?? [], ...(pressure.partial ? { censusPartial: true } : {}), ...(pressure.below ? { belowAfterPass: true } : {}) } : latest?.pressure ? { consumers: [] } : {};
    return { path, totalInodes, freeInodes, removed: last ? last.tmp.removed : null, removedAt: last?.at ?? null, latest, measuredScanned, own, ...census };
  } catch { return null; }
}
/**
 * `readTmpInodes` for each directory the loop's pass scans (GY-1602): its own tmpdir and /tmp, by
 * default, each measured on its own filesystem. Directories that resolve to one path are read once;
 * distinct directories on one filesystem are each read, since each carries its own census, and an
 * unreadable one is left out.
 */
export async function readTmpRoots(root: string, paths: readonly string[] = hostTmpRoots(), volume: TmpVolume = statfs, uid = process.getuid?.()): Promise<TmpInodes[]> {
  const seen = new Set<string>(), readings: TmpInodes[] = [];
  for (const path of paths) {
    const real = await realpath(path).catch(() => path);
    if (seen.has(real)) continue;
    seen.add(real);
    const reading = await readTmpInodes(root, path, volume, uid);
    if (reading) readings.push(reading);
  }
  return readings;
}

// ---- The reclaim pass --------------------------------------------------------------------------

export interface ResourceReclaimReport {
  at: string;
  reaped: { review: number; producer: number };
  closed: { name: string; pane: string; reason: string }[];
  released: { name: string; ledger: 'review' | 'producer'; reason: string }[];
  /** The stale /tmp entries the pass removed and the bytes they freed (GY-421, GY-1074). */
  tmp: { removed: number; bytes: number };
  /**
   * What the finished /tmp pass scanned, kept and found of its volume (GY-1600): the roots, the
   * candidates it examined and kept, whether the inode bound still stood, its escalation steps and
   * the consumers it named. Absent when no pass finished this cycle.
   */
  tmpPass?: Pick<TmpReclaimReport, 'roots' | 'scanned' | 'kept' | 'boundStands' | 'escalated' | 'consumers'>;
  errors: string[];
}
/** How a /tmp pass's own errors are marked among a reclaim report's errors (GY-1600). */
export const tmpErrorPrefix = 'Tmp reclaim: ';
/** The errors of the report's /tmp pass alone, not its ledger, pane or persistence errors (GY-1600). */
export const tmpPassErrors = (report: Pick<ResourceReclaimReport, 'errors'>) => report.errors.filter(error => error.startsWith(tmpErrorPrefix));
export const resourceReportFile = (root: string) => resolve(root, '.graphyard/resource-reclaims.json');
const retainedReports = 50;

/** `tmpLatest`: the latest finished /tmp pass, recorded even when it removed nothing (GY-1081). */
interface ReclaimFile { version: 1; reports: ResourceReclaimReport[]; seen: Record<string, string>; tmpLatest?: TmpPassRecord | null }
async function readReclaimFile(root: string): Promise<ReclaimFile> {
  try { await privateFile(resourceReportFile(root)); const body = JSON.parse(await readFile(resourceReportFile(root), 'utf8')); return { version: 1, reports: body.reports ?? [], seen: body.seen ?? {}, tmpLatest: body.tmpLatest ?? null }; }
  catch { return { version: 1, reports: [], seen: {} }; }
}
/** A holder that has not released the reclaim file's lock in this long is dead or wedged; its lock is taken over. */
export const reclaimLockStaleMs = 60_000;
/**
 * The dispatcher tick's name pass and the cycle's full pass each read-modify-write the reclaim
 * file (GY-1255): the write happens under this lock (`FILE.lock`, a directory) from a fresh read,
 * so one pass never drops a sighting, a stuck-session clock or a report the other recorded.
 *
 * Each holder writes its own token into the lock (GY-1270). A stale lock is taken over by renaming
 * it aside — atomic, so of two waiters that both saw it stale only one moves it — and only when the
 * lock moved aside still carries the token seen stale; a fresh lock moved aside by mistake is put
 * back. A holder removes the lock on release only while it still carries its own token.
 */
const lockOwner = 'owner';
const lockToken = (lock: string) => readFile(resolve(lock, lockOwner), 'utf8').catch(() => null);
/** Moves the lock aside and removes it, while it still carries `token`; a lock moved aside that does not is put back. */
async function removeLock(lock: string, token: string | null) {
  const aside = `${lock}.${randomUUID()}`;
  try { await rename(lock, aside); } catch { return; }
  if (await lockToken(aside) === token) { await rm(aside, { recursive: true, force: true }); return; }
  // Another waiter took the lock over and acquired it between this look and this move: put the
  // live lock back. Where a newer lock already stands, the moved one's holder has lost it.
  await rename(aside, lock).catch(() => rm(aside, { recursive: true, force: true }));
}
export async function withReclaimLock<T>(root: string, body: () => Promise<T>, waitMs = 30_000, staleMs = reclaimLockStaleMs): Promise<T> {
  const lock = `${resourceReportFile(root)}.lock`, deadline = Date.now() + waitMs, token = randomUUID();
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = await stat(lock).then(entry => Date.now() - entry.mtimeMs, () => 0);
      if (held > staleMs) { await removeLock(lock, await lockToken(lock)); continue; }
      if (Date.now() > deadline) throw new Error(`another reclaim pass has held ${lock} for ${Math.round(held / 1000)}s`);
      await new Promise(done => setTimeout(done, 20 + Math.random() * 30));
      continue;
    }
    // Exclusive: a lock put back over this one's empty directory already carries its holder's token.
    try { await writeFile(resolve(lock, lockOwner), token, { mode: 0o600, flag: 'wx' }); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; await rm(lock, { recursive: true, force: true }); throw error; }
  }
  try { return await body(); } finally { if (await lockToken(lock) === token) await removeLock(lock, token); }
}
/**
 * The clocks one pass leaves, merged onto the file as it stands now. A key this pass read and
 * dropped (its pane closed, its session failed or back) goes, unless another pass has set it since;
 * a key this pass read and carried stands as the file has it when another pass changed or dropped
 * it since the read — that pass saw the condition clear after this one read, so the older time is
 * never brought back (GY-1270) — and is kept otherwise; a key this pass set new keeps the earlier
 * of its time and one another pass set meanwhile; a key this pass does not own — the `missing:`
 * clocks, for the name pass — and any key another pass added are kept as they stand.
 */
export function mergeReclaimSeen(fresh: Record<string, string>, read: Record<string, string>, mine: Record<string, string>, owns: (key: string) => boolean) {
  const merged = { ...fresh };
  for (const [key, at] of Object.entries(read)) if (owns(key) && !(key in mine) && merged[key] === at) delete merged[key];
  for (const [key, at] of Object.entries(mine)) {
    if (!owns(key)) continue;
    if (key in read && at === read[key]) continue;
    merged[key] = merged[key] !== undefined && Date.parse(merged[key]) < Date.parse(at) ? merged[key] : at;
  }
  return merged;
}
export async function readReclaimReports(root: string): Promise<ResourceReclaimReport[]> { return (await readReclaimFile(root)).reports; }
/** The reclaim pass's reports and its seen-unowned map, read once (GY-1198). */
export async function readReclaimState(root: string): Promise<{ reports: ResourceReclaimReport[]; seen: Record<string, string> }> { const file = await readReclaimFile(root); return { reports: file.reports, seen: file.seen }; }
/**
 * The restart the loop's self-upgrade owes, from the daemon cursor (GY-1198): its pending move and
 * the latest attempt the upgrade recorded (its `upgrade:<release>` action; a failure before any
 * restart, on `upgrade:align`, is no attempt), or null when none is owed.
 */
export function owedUpgrade(state: { upgrade?: { pending: { from: string | null; to: string; code: boolean } | null; alignedRelease?: string | null; stalled?: UpgradeStall | null } | null; actions?: Record<string, { at: string }> } & Parameters<typeof promotionWait>[0] | null): ResourceInputs['upgrade'] {
  const pending = state?.upgrade?.pending;
  // The promotion wait and the named stall ride along (GY-1400, GY-1445): the loaded-revision reading needs them with no restart owed.
  const promotion = promotionWait(state), stalled = state?.upgrade?.stalled ?? null;
  if (!pending) return promotion || stalled ? { from: null, to: null, code: false, attemptedAt: null, ...(promotion ? { promotion } : {}), ...(stalled ? { stalled } : {}) } : null;
  const attempts = Object.entries(state!.actions ?? {}).filter(([key]) => key.startsWith('upgrade:') && key !== 'upgrade:refused' && key !== 'upgrade:unit' && key !== alignKey)
    .map(([, action]) => Date.parse(action.at)).filter(Number.isFinite);
  return { from: pending.from, to: pending.to, code: pending.code, attemptedAt: attempts.length ? Math.max(...attempts) : null, ...(promotion ? { promotion } : {}), ...(stalled ? { stalled } : {}) };
}

/**
 * Gives every reclaimable resource back, and records what it took. Within the bounds the registry
 * documents: a terminal ledger record is reaped once it has been settled `ledgerRetentionMs` and
 * answers no live request; a finished pane holding a profile's name whose record settled
 * `finishedSessionGraceMs` ago, with no pending record on the name, is closed and its name
 * released once an earlier pass at least that long before saw it the same way; a pending session
 * finished or blocked on a prompt for `stuckSessionMs`, or absent from every pass for that long, is failed —
 * its slot released and the relaunch rule free to try again — and its pane closed. The ledger is
 * written from a fresh read once the panes are closed, so a launch recorded meanwhile survives.
 *
 * It runs every cycle of the loop and from `master run --once`. It removes nothing a live request
 * or a running session needs, and it closes finished worker panes once their lease has ended and
 * their session has settled.
 */
/**
 * The loop's bounds for one /tmp pass — at most `tmpReclaimLimitPerCycle` directories and
 * `tmpReclaimWorkMsPerCycle` of removal — over `tmpRoots`, or the host's temporary directories
 * (`hostTmpRoots`: this process's tmpdir and /tmp, each once, GY-1368) unless the caller names
 * others (a test's scratch roots, so it never sweeps the developer's real /tmp). Over the host's
 * roots the pass measures their volumes and escalates while one is below its inode headroom
 * (GY-1597); a caller's own roots keep the base bounds.
 */
export const loopTmpReclaimOptions = (tmpRoots?: readonly string[]): TmpReclaimOptions => ({ limit: tmpReclaimLimitPerCycle, workMs: tmpReclaimWorkMsPerCycle, tmpRoots: tmpRoots ?? hostTmpRoots(), ...(tmpRoots ? {} : { volume: statfs }) });
/** The loop's /tmp pass in flight, and the report of the last one to finish, not yet recorded. */
let tmpPass: Promise<void> | null = null;
let tmpFinished: TmpReclaimReport | null = null;
/**
 * Hand over the last finished /tmp pass's report, if one is waiting, and start the next pass when
 * none is running. The pass is never awaited here: its bounded work runs beside the cycle.
 */
export function takeTmpReclaim(run: () => Promise<TmpReclaimReport> = () => reclaimTmpDirectories(loopTmpReclaimOptions())): TmpReclaimReport | null {
  const finished = tmpFinished;
  tmpFinished = null;
  if (!tmpPass) {
    tmpPass = run()
      .then(report => { tmpFinished = report; })
      .catch(error => { tmpFinished = { at: new Date().toISOString(), scanned: 0, removed: [], bytes: 0, kept: 0, errors: [error instanceof Error ? error.message : String(error)] }; })
      .finally(() => { tmpPass = null; });
  }
  return finished;
}
/** Wait for the /tmp pass in flight, if any: for a caller that must see it finish. */
export const settleTmpReclaim = async () => { await tmpPass; };

/**
 * `namesOnly` runs just the name half — closing finished panes on profile names — for the
 * dispatcher's tick (GY-1196). The cycle runs this pass once per cycle, and a loaded cycle runs
 * for ten minutes and more, so the two passes the grace apart a close needs took two cycles: past
 * `nameReclaimBoundMs` every time. The tick runs every few seconds, so the name is given back
 * inside its bound however long the cycle takes. It fails, reaps and sweeps nothing, and keeps the
 * stuck-session clocks the full pass records.
 */
export async function reclaimResources(root: string, config: Pick<ProfileSet, 'reviewers' | 'producers'> & { workers?: ProfileSet['workers'] }, observed: { work: Work[]; agents: HerdrAgent[] | null }, options: { now?: number; closePane?: (pane: string) => void | Promise<void>; tmpRoot?: string; tmpRoots?: readonly string[]; tmpPass?: (options: TmpReclaimOptions) => Promise<TmpReclaimReport>; namesOnly?: boolean; gates?: ReclaimGates } = {}): Promise<ResourceReclaimReport> {
  const now = options.now ?? Date.now();
  const gates = options.gates ?? reclaimGates;
  const close = options.closePane ?? (pane => { closeHerdrPane(pane); });
  const report: ResourceReclaimReport = { at: new Date(now).toISOString(), reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: 0, bytes: 0 }, errors: [] };
  // A pane is closed only once it has been seen finished and unowned by an earlier pass at least
  // the grace ago: a session launched a moment ago holds its name before its record is written.
  // A pending session is failed as absent only once every pass for `stuckSessionMs` missed it: one
  // inventory that omits a working session is not its end.
  const file = await readReclaimFile(root);
  const namesOnly = !!options.namesOnly;
  const seen: Record<string, string> = namesOnly ? Object.fromEntries(Object.entries(file.seen).filter(([key]) => key.startsWith('missing:'))) : {};
  const live = liveRequests(observed.work);
  type Settleable = { id: string; state: string; agentName: string; pane: string | null; requestId?: string; closedAt?: string; idleSince?: string; requestedAt: string; resolution?: string; acknowledgedAt?: string };
  const identity = (record: Settleable) => record.id;
  /** Decides from one read what to fail, close and reap; the ledger is written from a fresh read afterwards. */
  const reclaimLedger = async (kind: 'review' | 'producer', records: Settleable[], profiles: { name: string; agentName: string; concurrency?: number }[]) => {
    const failed = new Map<string, { resolution: string }>();
    // 1. Pending sessions finished or stuck on a prompt, or absent from Herdr for the whole bound: failed, so their slot is released.
    for (const record of namesOnly ? [] : records) {
      if (!stuckSession(record, observed.agents, now)) continue;
      const agent = observed.agents?.find(candidate => candidate.name === record.agentName);
      if (!agent) {
        const key = `missing:${identity(record)}`;
        const first = file.seen[key] ?? report.at;
        if (now - Date.parse(first) < stuckSessionMs) { seen[key] = first; continue; }
      }
      const reason = agent
        ? (agent.agent_status === 'blocked' ? `blocked on a prompt in Herdr for over ${stuckSessionMs / 60_000} minutes without a result` : `finished (${agent.agent_status}) in Herdr for over ${stuckSessionMs / 60_000} minutes without a result`)
        : `absent from Herdr on every pass for ${stuckSessionMs / 60_000} minutes`;
      // A session never acknowledged and gone from Herdr never started: the launcher's retry policy for that case applies.
      const resolution = !agent && !record.acknowledgedAt
        ? `${neverStartedReason}: the session left Herdr without acting on its request (reclaimed; its slot is released and the request may be launched again)`
        : `Reclaimed: the session was ${reason}; its slot is released and the request may be launched again`;
      failed.set(identity(record), { resolution });
      report.released.push({ name: record.agentName, ledger: kind, reason });
    }
    // 2. Panes on a profile's names that nothing pending holds. A pane whose record settled and
    //    which Herdr reports finished waits out the grace; one whose record is gone (reaped, or never
    //    written) or whose status Herdr does not recognise is closed on Herdr's own report once two
    //    passes its bound apart saw it unowned (GY-1165, GY-1166): a reaped record or an unknown
    //    status otherwise pinned the name at its bound for good. A running session is never closed.
    const closedNames = new Set<string>();
    for (const agent of observed.agents ?? []) {
      if (!agent.pane_id || !agent.name || !profiles.some(profile => isProfileSession(profile, agent.name))) continue;
      if (records.some(record => record.state === 'pending' && record.agentName === agent.name && !failed.has(identity(record)))) continue;
      const settled = records.filter(record => record.agentName === agent.name).at(-1);
      // A session this pass just released is closed at once; any other waits out the grace, finished.
      // A holder with no record (reaped at retention, or never written) has no settle time of its
      // own: two passes its bound apart are its clock, so its name is never pinned (GY-1165). The
      // bound is the grace when it finished, and `stuckSessionMs` when it may be a launch stuck on a
      // prompt before its record landed (GY-1192). A holder whose record settled but whose status
      // Herdr does not report as finished waits `unownedPaneConfirmMs` (GY-1166).
      const released = report.released.some(entry => entry.name === agent.name);
      const wait = settled ? (finished.includes(agent.agent_status ?? '') ? finishedSessionGraceMs : unownedPaneConfirmMs) : gates.recordless(agent);
      if (!released && (!gates.reclaimable(agent) || wait === null || (settled && now - settledAt(settled) < finishedSessionGraceMs))) continue;
      const first = file.seen[agent.pane_id] ?? report.at;
      if (!released && now - Date.parse(first) < wait!) { seen[agent.pane_id] = first; continue; }
      // The sighting stands through the close (GY-1547): a close that fails leaves the pane held, and
      // the reading flags it once this clock has run the bound, instead of the clock starting over.
      seen[agent.pane_id] = first;
      // A recordless pane that never finished is closed as never started, the cause the launcher's
      // retry policy keys on, rather than as a session that merely left no record.
      const neverStarted = !settled && wait !== finishedSessionGraceMs;
      const state = !settled ? 'left no record' : failed.has(identity(settled)) ? 'failed' : settled.state;
      const resolution = settled ? failed.get(identity(settled))?.resolution ?? settled.resolution
        : neverStarted ? `${neverStartedReason}: ${agent.agent_status ?? 'unknown'} in Herdr for over ${stuckSessionMs / 60_000} minutes before any record of its launch landed` : undefined;
      const herdr = settled && !finished.includes(agent.agent_status ?? '') ? ` (Herdr reports ${agent.agent_status ?? 'no status'})` : '';
      try { await close(agent.pane_id); closedNames.add(agent.name); report.closed.push({ name: agent.name, pane: agent.pane_id, reason: `its ${kind} session ${state}${resolution ? `: ${resolution.slice(0, 160)}` : ''}${herdr}` }); }
      catch (error) { report.errors.push(`Closing ${agent.name} (pane ${agent.pane_id}): ${error instanceof Error ? error.message : String(error)}`); }
    }
    // 3. Terminal records past retention that answer no live request.
    // A pinned record (GY-131) is never reaped: an open request or a pending review still reads it.
    // Nor is the newest record on a name a pane still holds and this pass did not close (GY-1166):
    // it is the close decision's evidence, so retention never outruns the reclaim of its pane.
    const evidence = new Set((observed.agents ?? []).filter(agent => agent.pane_id && agent.name && !closedNames.has(agent.name))
      .map(agent => records.filter(record => record.agentName === agent.name).at(-1)).filter((record): record is Settleable => !!record).map(identity));
    const reap = new Set(namesOnly ? [] : unpinnedTerminal(records).filter(record => !(record.requestId && live.has(record.requestId)) && !evidence.has(identity(record)) && now - settledAt(record) >= ledgerRetentionMs).map(identity));
    return { failed, reap };
  };
  /**
   * Applies the decisions to the ledger as it is now, not as it was read before the panes were
   * closed: a launcher that appended a record meanwhile keeps it, and a record that settled
   * meanwhile is not failed over its own result.
   */
  const apply = <R extends Settleable>(kind: 'review' | 'producer', records: R[], decided: { failed: Map<string, { resolution: string }>; reap: Set<string> }) => {
    let changed = false;
    const kept = records.filter(record => {
      const fail = decided.failed.get(identity(record));
      if (fail && record.state === 'pending') { Object.assign(record, { state: 'failed', resolution: fail.resolution, closedAt: report.at }); changed = true; }
      return !(decided.reap.has(identity(record)) && record.state !== 'pending');
    });
    report.reaped[kind] = records.length - kept.length;
    return { records: kept, changed: changed || kept.length !== records.length };
  };
  try {
    const decided = await reclaimLedger('review', (await readReviewLedger(root)).reviews, config.reviewers);
    if (decided.failed.size || decided.reap.size) await updateReviewLedger(root, ledger => { ledger.reviews = apply('review', ledger.reviews, decided).records; });
  } catch (error) { report.errors.push(`Review ledger: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const decided = await reclaimLedger('producer', (await readProducerLedger(root)).producers, config.producers);
    if (decided.failed.size || decided.reap.size) {
      const ledger = await readProducerLedger(root);
      const result = apply('producer', ledger.producers, decided);
      if (result.changed) await saveProducerLedger(root, { ...ledger, producers: result.records });
    }
  } catch (error) { report.errors.push(`Producer ledger: ${error instanceof Error ? error.message : String(error)}`); }
  // 4. Worker panes on a launch profile's names whose session settled and no live lease holds the profile's principal.
  for (const worker of config.workers ?? []) {
    if (worker.mode !== 'launch') continue;
    const held = (observed.agents ?? []).filter(agent => agent.pane_id && agent.name && isProfileSession(worker, agent.name));
    for (const agent of held) {
      const profile = { role: 'worker' as const, name: worker.name, agentName: worker.agentName, principal: worker.principal };
      if (liveOwner(profile, agent.name!, { reviews: [], producers: [], work: observed.work, now })) continue;
      // A holder Herdr reports 'unknown' or with no status is closed too, once confirmed unowned for
      // `unownedPaneConfirmMs` and no launch of the principal is under way (GY-1166); only a running one is spared.
      const recognised = finished.includes(agent.agent_status ?? '');
      if (!gates.reclaimable(agent) || (!recognised && launchingWorker(worker.principal, observed.work, now))) continue;
      const settled = holderSettledAt(profile, agent.name!, { reviews: [], producers: [], work: observed.work }, agent.pane_id);
      if (settled !== null && now - settled < finishedSessionGraceMs) continue;
      const first = file.seen[agent.pane_id!] ?? report.at;
      if (now - Date.parse(first) < (recognised ? finishedSessionGraceMs : unownedPaneConfirmMs)) { seen[agent.pane_id!] = first; continue; }
      seen[agent.pane_id!] = first; // kept through the close attempt (GY-1547), as in step 2
      try {
        await close(agent.pane_id!);
        report.closed.push({ name: agent.name!, pane: agent.pane_id!, reason: recognised ? 'its worker session finished and holds no active assignment' : `its worker session holds no active assignment and Herdr reports it ${agent.agent_status ?? 'with no status'}` });
      } catch (error) {
        report.errors.push(`Closing ${agent.name} (pane ${agent.pane_id}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  // The host's own temporary directories (GY-421): a bounded pass removes what earlier runs left —
  // a live owner keeps its directory, a dead owner's goes whatever its age, and an ownerless one
  // goes once it is older than `tmpReclaimMinAgeMs` and no live process holds it open. Both bounds
  // (count and wall-clock work) hold per pass, and the pass runs beside the cycle rather than in
  // it: a host with thousands of leftovers never stalls a cycle, and each cycle records what the
  // last finished pass freed. Ages are judged on the host's real clock, never the cycle's `now`,
  // which a caller may set anywhere: a directory is old only when it truly is.
  // `tmpRoot` (one) or `tmpRoots` names the directories scanned and `tmpPass` the pass itself,
  // for a caller that must keep the sweep off the host's /tmp or watch it run; the loop passes
  // neither.
  const tmp = namesOnly ? null : takeTmpReclaim(() => (options.tmpPass ?? reclaimTmpDirectories)(loopTmpReclaimOptions(options.tmpRoots ?? (options.tmpRoot === undefined ? undefined : [options.tmpRoot]))));
  if (tmp) {
    report.tmp = { removed: tmp.removed.length, bytes: tmp.bytes };
    report.tmpPass = { roots: tmp.roots, scanned: tmp.scanned, kept: tmp.kept, boundStands: tmp.boundStands, escalated: tmp.escalated, consumers: tmp.consumers };
    report.errors.push(...tmp.errors.map(error => `${tmpErrorPrefix}${error}`));
  }
  const took = !!(report.reaped.review || report.reaped.producer || report.closed.length || report.released.length || report.tmp.removed || report.errors.length);
  // A finished pass is recorded as the latest even when it removed nothing, so status never shows an old count as current.
  const tmpLatest = tmp ? { removed: tmp.removed.length, at: report.at, ...(tmp.roots ? { roots: tmp.roots } : {}), ...(tmp.escalated ? { escalated: tmp.escalated } : {}), ...(tmp.consumers ? { consumers: tmp.consumers } : {}), ...(tmp.pressure ? { pressure: tmp.pressure } : {}) } : file.tmpLatest ?? null;
  if (took || tmp || JSON.stringify(seen) !== JSON.stringify(file.seen)) {
    try {
      await withReclaimLock(root, async () => {
        const fresh = await readReclaimFile(root);
        const merged = mergeReclaimSeen(fresh.seen, file.seen, seen, key => !namesOnly || !key.startsWith('missing:'));
        await atomicPrivateWrite(resourceReportFile(root), { version: 1, reports: (took ? [...fresh.reports, report] : fresh.reports).slice(-retainedReports), seen: merged, tmpLatest: tmp ? tmpLatest : fresh.tmpLatest ?? null });
      });
    }
    catch (error) { report.errors.push(`Recording the reclaim: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return report;
}

/** One line for the loop's action record: what the pass took back. */
export function describeReclaim(report: ResourceReclaimReport) {
  const parts = [
    report.reaped.review || report.reaped.producer ? `reaped ${report.reaped.review} review and ${report.reaped.producer} producer ledger record(s)` : '',
    report.closed.length ? `closed ${report.closed.length} finished session(s) and released their names (${report.closed.map(entry => entry.name).join(', ')})` : '',
    report.released.length ? `released ${report.released.length} stuck session slot(s) (${report.released.map(entry => entry.name).join(', ')})` : '',
    describeTmpReclaim(report.tmp.removed, report.tmp.bytes),
    report.errors.length ? `${report.errors.length} could not be reclaimed: ${report.errors[0]}` : '',
  ].filter(Boolean);
  return parts.length ? `Resource reclaim: ${parts.join('; ')}` : null;
}

/**
 * One line for the loop's action record when the finished /tmp pass removed 0 entries while a
 * scanned root's volume stayed below its inode headroom (GY-1600): what it scanned, why nothing
 * was eligible, how far it escalated and the consumers it named. Null for any other pass, so a
 * pass that took entries back, or one with the bound clear, records only what `describeReclaim` says.
 * Only what the pass measured is claimed: its counts are the last sweep's (an escalation step's
 * sweep covers only the roots still below headroom), and a tsx cache file it could not remove is
 * either younger than the final cache age or held open, which the pass does not tell apart. Only the
 * /tmp pass's own errors are named: another resource's failure in the same report is not this pass's.
 */
export function describeStandingTmpPass(report: ResourceReclaimReport) {
  const pass = report.tmpPass;
  if (!pass?.boundStands || report.tmp.removed) return null;
  const roots = pass.roots?.length ? pass.roots.join(' and ') : 'its temporary directories';
  const top = pass.escalated?.at(-1), errors = tmpPassErrors(report);
  const sweep = top ? `; its last step, over the roots still below headroom, examined` : ':';
  return [
    `/tmp reclaim removed 0 entries while the inode bound stands: scanned ${roots}${sweep} ${entries(pass.scanned)} with this user's test temp names, ${pass.kept} kept (younger than ${testTempMinAgeMs / 3_600_000} hours, a live owner or holder, or past the pass's bounds), and no tsx cache file of this user's it could remove (each younger than ${minutes(top?.cacheAgeMs ?? tmpReclaimMinAgeMs)} or held open by a live process)`,
    top ? `escalated to ${top.limit} per cycle and tsx cache files older than ${minutes(top.cacheAgeMs)} (${pass.escalated!.map(step => step.removed).join(' + ')} removed)` : '',
    pass.consumers?.length ? `what fills it is outside the pass's reach; top consumers: ${pass.consumers.map(consumer => `${consumer.path} (${consumer.capped ? 'at least ' : ''}${entries(consumer.entries)}, owner ${consumer.owner})`).join(', ')}` : '',
    errors.length ? `${errors.length} could not be reclaimed: ${errors[0]}` : '',
  ].filter(Boolean).join('; ');
}

// ---- The host's panes (GY-842) -----------------------------------------------------------------

/** The count of agentless panes standing in Graphyard worktrees past which attention is raised (GY-842). */
export const agentlessPaneAttentionBound = 20;

/**
 * The item key and attempt epoch a Graphyard worktree path names (…/.graphyard/worktrees/GY-N-EPOCH,
 * or anywhere beneath it), or null for any other directory. A worktree removed under its shell
 * reads with Linux's ` (deleted)` suffix, which is kept apart as `deleted`.
 */
export function graphyardWorktree(cwd: string | undefined): { key: string; epoch: number; deleted: boolean } | null {
  const match = /\/\.graphyard\/worktrees\/([A-Za-z][A-Za-z0-9]*-\d+)-(\d+)(?:\/[^]*?)?( \(deleted\))?\s*$/.exec(cwd ?? '');
  return match ? { key: match[1], epoch: Number(match[2]), deleted: !!match[3] } : null;
}

export interface PaneReclaimStatus {
  at: string;
  /** Panes the host's runtime reports (`herdr pane list`); null while it cannot be read. */
  panes: number | null;
  /** Panes a Graphyard launch opened: the pane ids its sessions recorded. */
  launched: number;
  /** Agentless panes standing in Graphyard worktrees, recorded by a session or not: what the sweep will close. */
  agentless: number;
  /** The longest-standing agentless pane, by its session's recorded start or, unrecorded, its first sighting. */
  oldest: { pane: string; work: string; kind: string; launchedAt: string } | null;
  /** One attention item once agentless panes pass the bound, naming the counts and the remedy. */
  attention: AttentionItem | null;
}

/**
 * The pane picture of this host (GY-842, GY-1533): how many panes the runtime holds, how many a
 * Graphyard launch recorded, and how many stand agentless in Graphyard worktrees — the runtime
 * exited and left its shell, which holds a pty, a process and memory whether or not anything runs
 * in it. Herdr held 621 panes on 26 September 2026, 584 of them Graphyard's, agentless; the host
 * throttled and every session and test run on it slowed. On 7 October 246 bare shells in deleted
 * worktrees stood for over a day while this reading said 6: it counted only the panes a session
 * recorded, and the agent inventory it read never carries a bare shell. The reading is now the
 * pane inventory's, exactly as the sweep's candidates are: every pane it reports with no agent
 * whose cwd is a Graphyard worktree (present or deleted), recorded or not, except one whose exact
 * item and epoch holds a live lease. A pane outside the worktrees is never counted, and never
 * closed. Only the handles `hostId` recorded count as launched: a remote handle naming the same
 * pane coordinate is another host's launch. The agentless count is 0 while the inventory cannot be
 * read, since nothing can be seen or closed on it.
 */
export function paneReclaimStatus(panes: HerdrPane[] | null, work: Work[], agents: HerdrAgent[] | null, now: number, hostId: string, sighted: Record<string, string> = {}): PaneReclaimStatus {
  const listed = new Set((panes ?? []).map(pane => pane.pane_id).filter((id): id is string => !!id));
  // A launch's own record of its pane (GY-172): the handle every launcher registers, whatever its role.
  const recorded = new Map<string, { work: Work; kind: string; launchedAt: string | null }>();
  for (const item of work) for (const handle of item.sessions ?? []) if (handle.pane && handle.host === hostId)
    recorded.set(handle.pane, { work: item, kind: handle.kind, launchedAt: Number.isFinite(Date.parse(handle.startedAt)) ? handle.startedAt : null });
  // A pane with an agent in it is a live session by either inventory, whatever its state.
  const withAgent = new Set((agents ?? []).filter(agent => !!agent.agent && !!agent.pane_id).map(agent => agent.pane_id!));
  const leased = (tree: { key: string; epoch: number }) => work.some(item => item.key === tree.key && !!item.lease && item.lease.epoch === tree.epoch && Date.parse(item.lease.expiresAt) > now);
  const agentless: { pane: string; work: string; kind: string; since: string | null }[] = [];
  for (const pane of panes ?? []) {
    if (!pane.pane_id || pane.agent || withAgent.has(pane.pane_id)) continue;
    const tree = graphyardWorktree(pane.cwd);
    if (!tree || leased(tree)) continue;
    const record = recorded.get(pane.pane_id);
    agentless.push({ pane: pane.pane_id, work: record?.work.key ?? tree.key, kind: record?.kind ?? 'unrecorded', since: record?.launchedAt ?? sighted[pane.pane_id] ?? null });
  }
  // The longest-standing: the earliest known start; a pane whose standing is undated ranks after every dated one.
  const standing = (entry: { since: string | null }) => entry.since === null ? Number.POSITIVE_INFINITY : Date.parse(entry.since);
  const oldest = agentless.length ? agentless.reduce((earliest, entry) => standing(entry) < standing(earliest) ? entry : earliest, agentless[0]) : null;
  const reading = { panes: panes === null ? null : listed.size, launched: recorded.size, agentless: agentless.length,
    oldest: oldest ? { pane: oldest.pane, work: oldest.work, kind: oldest.kind, launchedAt: oldest.since ?? 'an unrecorded time' } : null };
  const attention: AttentionItem[] = agentless.length > agentlessPaneAttentionBound ? [{ subject: 'agentless panes',
    text: `Herdr holds ${reading.panes ?? 'an unknown number of'} pane(s) on this host and ${agentless.length} of them stand agentless in Graphyard worktrees (past the ${agentlessPaneAttentionBound}-pane attention bound), the oldest pane ${reading.oldest!.pane} of ${reading.oldest!.work} (${reading.oldest!.kind}), standing since ${reading.oldest!.launchedAt}. Each is a shell holding a pty and memory, and enough of them slow every session and test run on the host`,
    ...agentOwner('master', 'the loop sweeps them itself, a bounded number per cycle, once agentless past its launch bound; graphyard master run --once runs a pass now') }] : [];
  return { ...reading, at: new Date(now).toISOString(), attention: attention[0] ?? null };
}

// ---- The plane's health ------------------------------------------------------------------------

/**
 * Whether the plane can record anything: a write in a transaction that is rolled back. A
 * read-only database, a standby, or a role without write privilege refuses it; a database that
 * cannot be reached refuses it too.
 */
export async function probeWrites(pool: { connect(): Promise<{ query(sql: string): Promise<unknown>; release(): void }> }): Promise<string | null> {
  let client: Awaited<ReturnType<typeof pool.connect>> | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    try {
      await client.query('UPDATE graphyard_schema SET version = version WHERE false');
      await client.query('SELECT pg_current_xact_id()');
    } finally { await client.query('ROLLBACK').catch(() => {}); }
    return null;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
  finally { client?.release(); }
}

/**
 * The size of the volume holding the database's data directory, when the plane can see it: the
 * directory is readable to the database role (`data_directory` needs pg_read_all_settings) and the
 * same path exists on this host — an embedded, compose or same-machine database. A database on its
 * own host (a managed service) answers null and the default bound stands.
 */
export async function readDatabaseVolumeBytes(pool: { query(sql: string): Promise<{ rows: any[] }> }): Promise<{ bytes: number; path: string } | null> {
  try {
    const path = String((await pool.query("SELECT current_setting('data_directory') AS path")).rows[0]?.path ?? '');
    if (!path) return null;
    const volume = await statfs(path);
    const bytes = Number(volume.blocks) * Number(volume.bsize);
    return Number.isFinite(bytes) && bytes > 0 ? { bytes, path } : null;
  } catch { return null; }
}

/**
 * The plane's database size against its bound: GRAPHYARD_DATABASE_MAX_BYTES when set, else the
 * size of the database's own volume when the plane can read it (GY-979: the fixed 10 GiB default
 * reported headroom a 19 GB volume did not have, or lacked), else the default. Only the default is
 * a guess at a volume nobody sized, so it alone is advisory: `master status` warns on it, but a
 * configured or measured bound fails health.
 */
export async function readDatabaseCapacity(pool: { query(sql: string): Promise<{ rows: any[] }> }, env: NodeJS.ProcessEnv = process.env): Promise<PlaneReading> {
  const configured = Number(env.GRAPHYARD_DATABASE_MAX_BYTES);
  const set = Number.isFinite(configured) && configured > 0;
  const volume = set ? null : await readDatabaseVolumeBytes(pool);
  const bound = set ? configured : volume?.bytes ?? defaultDatabaseMaxBytes;
  const advisory = !set && !volume;
  const against = set ? 'GRAPHYARD_DATABASE_MAX_BYTES' : volume ? `the size of the database volume at ${volume.path}` : 'the default bound (GRAPHYARD_DATABASE_MAX_BYTES unset and the database volume not readable from the plane; it warns but does not fail health)';
  try {
    const used = Number((await pool.query('SELECT pg_database_size(current_database()) AS size')).rows[0].size);
    // The largest tables, so growth is attributed from outside the database (a catalogue read, no scan).
    const tables = await pool.query(`SELECT relname AS table, pg_total_relation_size(c.oid) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 6`).then(r => r.rows.map(row => ({ table: String(row.table), bytes: Number(row.bytes) })), () => undefined);
    return { used, bound, advisory, ...(tables ? { tables } : {}), detail: `pg_database_size against ${against}` };
  } catch (error) { return { used: null, bound, advisory, detail: `pg_database_size could not be read: ${error instanceof Error ? error.message : String(error)}` }; }
}

const budgetCache = new WeakMap<object, { at: number; reading: PlaneReading }>();
/** The installation's documented minimum hourly limit: the bound shown for a pause before any budget read succeeded. */
const minimumInstallationLimit = 5000;
/**
 * The App installation's core budget, read at most once a minute; `/rate_limit` costs nothing
 * against it. The client pauses every request once a rate limit refuses one (src/github.ts) until
 * the reset GitHub reported: that pause is the remediation under way, healing itself at the reset,
 * and the observation class already counts it once. No request is made while it lasts, so its
 * usage is unread rather than fabricated at the bound (GY-1278): the reading names the pause and
 * its reset, faults nothing and leaves the plane healthy. Once the pause ends the real read
 * resumes, and a budget still spent then reads exhausted as before.
 */
export async function readGitHubBudget(github: object | null, now = Date.now()): Promise<PlaneReading | null> {
  if (!github) return null;
  const client = github as unknown as { blockedUntil?: number; apiRequest(path: string): Promise<any> };
  const paused = () => {
    const until = client.blockedUntil ?? 0;
    if (until <= now) return null;
    const bound = budgetCache.get(github)?.reading.bound ?? minimumInstallationLimit;
    return { used: null, bound, detail: `the GitHub client paused every request until ${new Date(until).toISOString()} after a rate-limit refusal; the budget is read again once the pause ends at that reset` };
  };
  const pause = paused();
  if (pause) return pause;
  const cached = budgetCache.get(github);
  if (cached && now - cached.at < 60_000) return cached.reading;
  let reading: PlaneReading;
  try {
    // The client's own authenticated request path; /rate_limit is not a repository route.
    const body = await client.apiRequest('/rate_limit');
    const core = body?.resources?.core ?? body?.rate;
    reading = { used: Number(core.limit) - Number(core.remaining), bound: Number(core.limit), detail: `${core.remaining} of ${core.limit} left; resets ${new Date(Number(core.reset) * 1000).toISOString()}` };
  } catch (error) {
    // The read itself may be the request a rate limit refused, which starts the pause.
    const started = paused();
    if (started) return started;
    reading = { used: null, bound: null, detail: `GET /rate_limit failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  budgetCache.set(github, { at: now, reading });
  return reading;
}

/**
 * The plane's own health: unhealthy while writes are refused or a resource it owns is exhausted,
 * each cause named. A plane that cannot record results must not be dispatched into. A database
 * at an advisory (default) bound is reported by `master status`, not here.
 */
export function planeVerdict(writeError: string | null, resources: { database: PlaneReading | null; github: PlaneReading | null }) {
  const causes: string[] = [];
  if (writeError) causes.push(`Writes are refused: ${writeError}`);
  const exhausted = (reading: PlaneReading | null) => !!reading && reading.used !== null && reading.bound !== null && reading.used >= reading.bound;
  if (exhausted(resources.database) && !resources.database!.advisory) causes.push(`Control-plane database is at its bound: ${resources.database!.used} of ${resources.database!.bound} bytes (${resources.database!.detail ?? 'pg_database_size'}); grow the volume and raise GRAPHYARD_DATABASE_MAX_BYTES`);
  if (exhausted(resources.github)) causes.push(`GitHub App request budget is at its bound: ${resources.github!.used} of ${resources.github!.bound} requests (${resources.github!.detail ?? ''}); observations stop until the reset`);
  return { healthy: causes.length === 0, writable: !writeError, causes };
}

/**
 * The loop's gate before it dispatches: the plane must be able to record what a launch produces.
 * Returns the reason not to dispatch, or null. An unreachable plane is a reason too.
 */
export async function dispatchRefusal(url: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({})) as { healthy?: boolean; causes?: string[] };
    if (response.ok && body.healthy !== false) return null;
    return `the control plane reports itself unhealthy (${(body.causes ?? [`HTTP ${response.status}`]).join('; ')}), so nothing is dispatched into a plane that cannot record the result`;
  } catch (error) { return `the control plane's /healthz could not be read (${error instanceof Error ? error.message : String(error)}), so nothing is dispatched into a plane that may not record the result`; }
}

/**
 * Host memory (GY-612). The loop launched sessions whatever the host had left: on 26 September 2026
 * a 62 GB host fell to one or two gigabytes available with nineteen verification runs live, and
 * agent runtimes were reaped mid-session. Before any worker, reviewer or producer launch the loop
 * reads the host's available memory; below the floor — 10% of total or 4 GB, whichever is larger —
 * it defers new launches on that host with the reason recorded, raises one `resources` attention
 * item naming the top memory consumers, and resumes launching once memory is back above the floor.
 * Sessions already running are never stopped for it.
 */
export interface MemoryConsumer { command: string; processes: number; rssBytes: number }
export interface HostMemoryReading { totalBytes: number; availableBytes: number; consumers?: MemoryConsumer[] }
export interface HostMemoryState { host: string | null; at: string; totalBytes: number; availableBytes: number; floorBytes: number; low: boolean; since: string | null; consumers: MemoryConsumer[] }
/** A deferral lifts only this far above the floor, so a host hovering at it does not flap launches. */
export const memoryFloorShare = 0.1, memoryFloorMinimumBytes = 4 * 2 ** 30, memoryRecoveryMarginBytes = 2 ** 30;
export const hostMemoryFloor = (totalBytes: number) => Math.max(totalBytes * memoryFloorShare, memoryFloorMinimumBytes);
const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

/** The largest resident-memory users on the host, summed by command name. */
export function memoryConsumers(listing: string, limit = 5): MemoryConsumer[] {
  const byCommand = new Map<string, MemoryConsumer>();
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const entry = byCommand.get(match[2]) ?? { command: match[2], processes: 0, rssBytes: 0 };
    entry.processes++; entry.rssBytes += Number(match[1]) * 1024;
    byCommand.set(match[2], entry);
  }
  return [...byCommand.values()].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, limit);
}

/** The variable the suite's runner sets on the runs it starts (tests/helpers/run-tests.ts, value `unreadable`): a run so marked reads nothing, so a busy host's real memory cannot flip launch behaviour inside tests that stub no reading of their own. Production never sets it. */
export const hostMemoryVariable = 'GRAPHYARD_HOST_MEMORY';

/** This host's memory from /proc/meminfo, with its top consumers when it is below the floor; null where it cannot be read. */
export async function readHostMemory(): Promise<HostMemoryReading | null> {
  if (process.env[hostMemoryVariable] === 'unreadable') return null;
  let meminfo: string;
  try { meminfo = await readFile('/proc/meminfo', 'utf8'); } catch { return null; }
  const field = (name: string) => { const match = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(meminfo); return match ? Number(match[1]) * 1024 : null; };
  const totalBytes = field('MemTotal'), availableBytes = field('MemAvailable');
  if (totalBytes === null || availableBytes === null) return null;
  if (availableBytes >= hostMemoryFloor(totalBytes)) return { totalBytes, availableBytes };
  let listing = '';
  try { listing = await runChild('ps', ['-eo', 'rss=,comm='], { timeoutMs: 5_000 }); } catch { /* the deferral stands without its consumers */ }
  return { totalBytes, availableBytes, consumers: memoryConsumers(listing) };
}

const describeConsumers = (consumers: MemoryConsumer[]) => consumers.map(entry => `${entry.command}${entry.processes > 1 ? ` ×${entry.processes}` : ''} ${gib(entry.rssBytes)}`).join(', ');
/** Why launches wait on this host, while its memory is below the floor. */
export const memoryDeferral = (state: HostMemoryState) =>
  `host ${state.host ?? 'this host'} has ${gib(state.availableBytes)} of ${gib(state.totalBytes)} memory available, below its ${gib(state.floorBytes)} floor, so new session launches on it are deferred until memory recovers${state.consumers.length ? `; top consumers: ${describeConsumers(state.consumers)}` : ''}`;

/**
 * Judge one reading against the last: the state the loop keeps, and the event to record when the
 * host crossed its floor — `deferred` on the way down, `resumed` once back above it by the margin.
 */
export function judgeHostMemory(previous: HostMemoryState | null, reading: HostMemoryReading, now: number, host: string | null = null): { state: HostMemoryState; event: 'deferred' | 'resumed' | null; detail: string } {
  const floorBytes = hostMemoryFloor(reading.totalBytes), at = new Date(now).toISOString();
  const low = reading.availableBytes < floorBytes + (previous?.low ? memoryRecoveryMarginBytes : 0);
  const state: HostMemoryState = { host, at, totalBytes: reading.totalBytes, availableBytes: reading.availableBytes, floorBytes, low,
    since: low ? previous?.low ? previous.since : at : null, consumers: low ? reading.consumers ?? previous?.consumers ?? [] : [] };
  if (low && !previous?.low) return { state, event: 'deferred', detail: `Launches deferred: ${memoryDeferral(state)}` };
  if (!low && previous?.low) return { state, event: 'resumed', detail: `Launches resumed: host ${host ?? 'this host'} has ${gib(reading.availableBytes)} of ${gib(reading.totalBytes)} memory available again, above its ${gib(floorBytes)} floor (deferred since ${previous.since})` };
  return { state, event: null, detail: low ? `Launches deferred: ${memoryDeferral(state)}` : '' };
}

/** The one `resources` attention item a host below its memory floor raises, naming its top consumers. */
export function hostMemoryAttention(state: HostMemoryState | null | undefined): AttentionItem[] {
  if (!state?.low) return [];
  return [{ subject: 'memory', text: `${memoryDeferral(state)}. Deferred since ${state.since}`,
    ...agentOwner('master', 'Let running verification finish or stop what holds the memory named here; master run resumes launches on its own once available memory is back above the floor, and GRAPHYARD_VERIFICATION_SLOTS on the host lowers how many full suites and type checks run at once') }];
}

/** Host memory rides the loop's cursor: `master status` judges it only while the loop runs. */
export function loopMemoryAttention(cycling: { running: boolean; memory?: HostMemoryState | null } | null): AttentionItem[] {
  return cycling?.running ? hostMemoryAttention(cycling.memory) : [];
}

/** Why no session may be launched on `host` now, or null: an executor's `launchHold` (GY-612). */
export async function hostMemoryHold(host: string | null, read: () => Promise<HostMemoryReading | null> = readHostMemory, now: () => number = Date.now): Promise<string | null> {
  const reading = await read();
  if (!reading) return null;
  const { state } = judgeHostMemory(null, reading, now(), host);
  return state.low ? memoryDeferral(state) : null;
}
