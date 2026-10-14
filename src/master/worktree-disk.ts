// Concern: the worktree volume's readings — disk pressure, its answered gate, hard line and recovery band.
import { agentOwner, type AttentionItem } from './attention.js';
import type { WorktreeReclaimCandidate } from './worktrees.js';

/*
 * GY-1784: the warn line is a knife edge on a shared volume. On 14 October 2026 the host's root
 * volume (952 GB, 99% full of the operator's own data) sat within a few hundred MB of the 10 GB line;
 * host writes pushed it under and MB-scale recoveries lifted it back, and each crossing opened a
 * fresh resources fault — three in 33 minutes — while the loop's reclaim had nothing left to take
 * (0 of 239 worktrees reclaimable, 0 bytes freed). Three rules, shared by the registry reading
 * (master-resources.ts), the `disk` line of master status and the loop's derived fault (daemon/faults.ts):
 *  - answered: while the loop's latest worktree-reclaim pass is current (`worktreePassCurrentMs`) and
 *    drained — it removed nothing, left no reclaimable worktrees, took no unowned managed checkout,
 *    met no error, and nothing is disposable now over the current plan, which the caller computes
 *    beside the reading (a plan it cannot read never answers) — and the reading's own fault does not
 *    stand, a low reading is reported and raises nothing: what holds the volume is outside the loop's
 *    reach, which is the operator's to decide;
 *  - hard line: at or below the exhaustion floor (`diskExhaustionFloorBytes`, half the warn line) the
 *    reading raises attention whatever the pass answered, as a write failing ENOSPC/EDQUOT always did;
 *  - recovery band: a low reading whose fault stands recovers only `diskRecoveryBandBytes` (a tenth of
 *    the warn line) above it, and is never answered while it stands — a fresh drained pass that catches
 *    it partway into the band ends it only for the next stale pass to open another — so one wobble across
 *    the line is one fault, not an instance per crossing.
 */
/** The loop's latest worktree-reclaim pass as the disk readings judge it: the cursor's reclaim summary, projected. */
export interface WorktreePass { at: string; removed: number; trees: number; treeBacklog: number; checkouts: number; errors: number; freeBytes: number | null }
/** The pass the cursor's reclaim summary records, or null when none is recorded. */
export const worktreePassOf = (summary: { at: string; removed: number; trees?: number; treeBacklog?: number; checkouts?: number; errors?: string[]; freeBytes?: number | null } | null | undefined): WorktreePass | null =>
  summary ? { at: summary.at, removed: summary.removed, trees: summary.trees ?? 0, treeBacklog: summary.treeBacklog ?? 0, checkouts: summary.checkouts ?? 0, errors: summary.errors?.length ?? 0, freeBytes: summary.freeBytes ?? null } : null;
/** How recent the loop's latest worktree-reclaim pass must be to answer a low reading: three reclaim intervals, the /tmp pass's bound (tmpPassCurrentMs). */
export const worktreePassCurrentMs = 30 * 60_000;
/** The recovery band above the warn line: a low reading whose fault stands is still low until it recovers past it. */
export const diskRecoveryBandBytes = (thresholdBytes: number) => thresholdBytes / 10;
/** The exhaustion floor, the reading's hard line: at or below it attention is raised whatever the reclaim pass answered. */
export const diskExhaustionFloorBytes = (thresholdBytes: number) => thresholdBytes / 2;
/** The subjects the two disk lines fault on, by kind: the registry reading and master status's `disk` line. */
export const diskLineSubjects = { 'resource-bound': 'resource:worktree-disk', 'disk-pressure': 'disk' } as const;
/** Whether a fault of `kind` on its disk subject stands in the loop's record (`faults.open`, keyed kind|subject|wording). */
export const standingDiskLine = (open: Record<string, string> | null | undefined, kind: keyof typeof diskLineSubjects) =>
  !!open && Object.keys(open).some(key => key.startsWith(`${kind}|${diskLineSubjects[kind]}|`));
/** What a drained pass leaves the operator: the three choices that move the number. */
export const outsideReachRemedy = 'free host data on the volume, raise run.diskThresholdGb in .graphyard/master.json, or move the worktree root (.graphyard/worktrees, and run.worktreeRoot for the managed checkouts) to a dedicated volume';
export interface WorktreeDiskInputs {
  freeBytes: number | null; thresholdBytes: number;
  /** The loop's latest worktree-reclaim pass; null or absent when none is recorded or the cursor is unread. */
  pass?: WorktreePass | null;
  /** Whether this line's fault stands in the loop's record: the recovery band applies, and the reading is not answered while it does (GY-1784 review: a fresh drained pass must not end a standing fault inside the band). */
  standing?: boolean;
  /** What is disposable now, by the plan over the current inventory: a number when the caller computed it, null when the plan could not be read (a drained pass is then not enough — the reading is never answered on a plan it does not know), absent when the caller judges from the pass alone. */
  reclaimable?: number | null;
}
export interface WorktreeDiskJudgement {
  /** The headroom below which the reading is low: the warn line, raised by the recovery band while its fault stands. */
  warnBelow: number; bandBytes: number; floorBytes: number;
  low: boolean; atFloor: boolean; current: boolean; drained: boolean;
  /** Low, above the floor, and the pass current and drained: reported, raising nothing. */
  answered: boolean;
  /** Why the reading stands as it does, for the detail of each line; null when it is simply within its line. */
  detail: string | null;
}
const passParts = (pass: WorktreePass, reclaimable: number) => [
  [pass.removed, 'dependency directories removed'], [pass.trees, 'worktrees removed'], [pass.treeBacklog, 'reclaimable worktrees left for the next cycle'],
  [pass.checkouts, 'unowned managed checkouts removed'], [pass.errors, 'errors'], [reclaimable, 'worktrees disposable now'],
].filter(([count]) => count).map(([count, what]) => `${count} ${what}`).join(', ');
/** One judgement of the worktree volume, shared by every line that reports it, at the instant `now`. */
export function judgeWorktreeDisk(input: WorktreeDiskInputs, now: number): WorktreeDiskJudgement {
  const bandBytes = diskRecoveryBandBytes(input.thresholdBytes), floorBytes = diskExhaustionFloorBytes(input.thresholdBytes);
  const warnBelow = input.standing ? input.thresholdBytes + bandBytes : input.thresholdBytes;
  const free = input.freeBytes, low = free !== null && free < warnBelow, atFloor = free !== null && free <= floorBytes;
  const pass = input.pass ?? null, at = pass ? Date.parse(pass.at) : Number.NaN, reclaimable = input.reclaimable ?? 0;
  const current = Number.isFinite(at) && now - at < worktreePassCurrentMs;
  // Drained needs the plan too: a pass that removed nothing can still have reach now, over worktrees that turned disposable after it ran (GY-1784 review) — and when the plan could not be read (null) the reading is never answered on it.
  const drained = !!pass && input.reclaimable !== null && pass.removed === 0 && pass.trees === 0 && pass.treeBacklog === 0 && pass.checkouts === 0 && pass.errors === 0 && reclaimable === 0;
  // A standing fault is never answered: the recovery band is its recovery line, and a fresh drained pass that catches the reading partway into the band closes it only for the next stale pass to open another (GY-1784 review, AC-4).
  const answered = low && !atFloor && current && drained && !input.standing;
  // The detail every line carries: the band it stands in, the pass's reach, and why it is raised or answered.
  const band = input.standing && free !== null && free >= input.thresholdBytes ? `within the ${gigabytes(bandBytes)} recovery band above the ${gigabytes(input.thresholdBytes)} line, so the low reading whose fault stands is this same one` : null;
  const reach = !pass ? 'the loop has recorded no worktree-reclaim pass'
    : input.reclaimable === null ? 'what is disposable now could not be read beside the reading, so it stands until the next plan over the inventory'
    : drained ? `the loop's latest worktree-reclaim pass at ${pass.at} found nothing reclaimable (no disposable dependency directories, reclaimable worktrees or unowned managed checkouts), so the volume's remaining holders are outside its reach: ${outsideReachRemedy}`
    : `the loop's latest worktree-reclaim pass at ${pass.at} still has reach (${passParts(pass, reclaimable)})`;
  const why = atFloor ? `at or below the ${gigabytes(floorBytes)} exhaustion floor, which raises attention whatever that pass answered`
    : answered ? `that pass is current, so only free space at or below the ${gigabytes(floorBytes)} floor raises attention`
    : pass && !current ? `that pass is past its ${worktreePassCurrentMs / 60_000}-minute currency bound, so the reading stands until the next pass`
    : input.standing ? `the reading's fault stands, so it holds until free space recovers past the ${gigabytes(bandBytes)} band above the ${gigabytes(input.thresholdBytes)} line, whatever that pass answered` : null;
  const detail = low ? [band, reach, why].filter(Boolean).join('; ') : null;
  return { warnBelow, bandBytes, floorBytes, low, atFloor, current, drained, answered, detail };
}

export interface DiskPressure {
  path: string; freeBytes: number | null; thresholdBytes: number; low: boolean; reclaimable: number; worktrees: number; unavailable: string | null;
  /** GY-1784: low, but the loop's current pass is drained and the volume is above its floor — reported, raising nothing. */
  answered: boolean;
  /** Nothing is reclaimable: no worktree holds a disposable dependency directory and the recorded pass (if any) left nothing. */
  drained: boolean;
  /** The headroom the line warns below: the configured threshold, or that plus the recovery band while its fault stands. */
  warnBelow: number;
  detail: string | null;
}
/**
 * Free space beside what a reclaim would give back, in the shape `master status` reports it. The
 * loop's latest pass and whether the line's fault stands (`context`, from the daemon cursor) decide
 * whether a low reading is answered and where it recovers (GY-1784).
 */
export function diskPressure(path: string, free: number | null, thresholdBytes: number, plan: WorktreeReclaimCandidate[], context: { pass?: WorktreePass | null; standing?: boolean; now?: number } = {}): DiskPressure {
  const reclaimable = plan.filter(entry => entry.disposable).length;
  const judged = judgeWorktreeDisk({ freeBytes: free, thresholdBytes, pass: context.pass, standing: context.standing, reclaimable }, context.now ?? Date.now());
  const pass = context.pass ?? null;
  return { path, freeBytes: free, thresholdBytes, low: judged.low, reclaimable, worktrees: plan.length,
    unavailable: free === null ? `Free space on ${path} could not be read` : null,
    answered: judged.answered, drained: reclaimable === 0 && (!pass || judged.drained), warnBelow: judged.warnBelow, detail: judged.detail };
}
const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
/**
 * The attention item that has to arrive before the volume fills: how much room is left, how much
 * of it finished worktrees are holding, and the one command that gives it back. It is raised on
 * the configured threshold rather than on the first failed write, so the master acts while
 * writes still succeed.
 */
export function diskPressureAttention(pressure: DiskPressure): AttentionItem[] {
  if (!pressure.low || pressure.freeBytes === null || pressure.answered) return [];
  const reading = `${gigabytes(pressure.freeBytes)} free on ${pressure.path}, below the configured ${gigabytes(pressure.thresholdBytes)} threshold`;
  // Nothing reclaimable (GY-1784): the volume's holders are outside the loop's reach, and only the operator's choices move the number.
  if (pressure.drained) return [{ subject: 'disk', text: `${reading}; ${pressure.reclaimable} of ${pressure.worktrees} assignment worktree(s) hold dependency directories a fresh install recreates${pressure.detail ? ` (${pressure.detail})` : ''}. The volume's remaining holders are outside the loop's reach: ${outsideReachRemedy}`,
    ...agentOwner('master', `${outsideReachRemedy}; graphyard master run --once reclaims immediately when no loop is running, and daemon.reclaim in master status says what the last pass took back`) }];
  return [{ subject: 'disk', text: `${reading}; ${pressure.reclaimable} of ${pressure.worktrees} assignment worktree(s) hold dependency directories a fresh install recreates${pressure.detail ? ` (${pressure.detail})` : ''}. Reclaim them before the volume fills`,
    ...agentOwner('master', 'graphyard master run reclaims every cycle while free space is low (daemon.reclaim in master status says what it took back); lower run.reclaimIdleHours in .graphyard/master.json to make more of them disposable, and graphyard master run --once reclaims immediately when no loop is running') }];
}
