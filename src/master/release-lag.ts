// Concern: GY-437 — how far what runs lags the base tip, and the attention that names it.
//
// The loop upgrades itself between cycles and `master executors restart` brings the fleet along,
// but an upgrade that cannot run (a dirty checkout, a refused restart, a loop nothing supervises)
// used to be invisible: every component went on running the release it had loaded. This module
// says, per component, what it loaded against the base tip, and names any component that stays
// more than one delivery behind for over ten minutes — one delivery behind is the ordinary gap
// between a merge and its verified deployment, and is never named.
import { agentOwner, type AttentionItem } from './attention.js';
import { shortCommit } from '../executor-fleet.js';
import { defaultChildRun, type ChildRun } from '../child-runner.js';

/** How long a component may stay more than one delivery behind before it is named (GY-437). */
export const releaseLagGraceMs = 10 * 60_000;

export interface LagDelivery { key: string; mergeSha: string; mergedAt: string }
export interface LagComponent {
  name: string;
  label: string;
  /** The release the component loaded. */
  release: { commit: string | null; dirty: boolean | null };
  /** When the component started on that release, so a young component is not blamed for history older than it. */
  startedAt: string | null;
  /** What brings it back to the tip, when the component does not upgrade itself. */
  restart: string | null;
}

/** The base tip this checkout last fetched; a checkout that never fetched reads as unknown, never as a guess. */
export async function readBaseTip(root: string, baseBranch: string, run: ChildRun = defaultChildRun): Promise<string | null> {
  try { return (await run('git', ['-C', root, 'rev-parse', `refs/remotes/origin/${baseBranch}^{commit}`])).trim() || null; } catch { return null; }
}

export interface ReleaseLagRow {
  component: string; label: string;
  release: { commit: string | null; dirty: boolean | null };
  baseTip: string | null;
  /** Delivered items the loaded release does not contain, oldest first; ancestry git cannot place is never counted. */
  behind: { key: string; mergedAt: string }[];
  /** When being more than one delivery behind began: the second-oldest missing delivery's merge, or the component's start, whichever is later. */
  since: string | null;
  /** More than one delivery behind for over the grace window: this component is named. */
  late: boolean;
  restart: string | null;
}

export interface ReleaseLagReport { baseTip: string | null; components: ReleaseLagRow[]; attention: AttentionItem[] }

/**
 * Per component, the release it loaded against the base tip. A delivery counts as behind when
 * git answers and answers no — a commit this checkout does not hold, or a component with no
 * readable release, reads as unknown and is never counted, so attention is raised only on what
 * is known.
 */
export async function releaseLag(baseTip: string | null, deliveries: readonly LagDelivery[], components: readonly LagComponent[],
  deps: { root: string; run?: ChildRun; now: number; graceMs?: number }): Promise<ReleaseLagReport> {
  const run = deps.run ?? defaultChildRun;
  const graceMs = deps.graceMs ?? releaseLagGraceMs;
  const contains = async (commit: string, mergeSha: string): Promise<boolean> => {
    if (commit === mergeSha) return true;
    try { await run('git', ['-C', deps.root, 'merge-base', '--is-ancestor', mergeSha, commit]); return true; }
    catch (error: any) { return error?.status !== 1; }
  };
  const rows = components.map(async (component): Promise<ReleaseLagRow> => {
    const commit = component.release.commit;
    const missing = async (delivery: LagDelivery) => commit ? !(await contains(commit, delivery.mergeSha.toLowerCase())) : false;
    const behind: LagDelivery[] = [];
    for (const delivery of deliveries) if (await missing(delivery)) behind.push(delivery);
    // The count of missing deliveries reaches two when the second-oldest of them merged — later
    // ones only push it further — or when the component started, if that is later, so a fresh
    // process is not blamed for history older than it.
    const began = [behind.length >= 2 ? Date.parse(behind[1].mergedAt) : Number.NaN,
      component.startedAt ? Date.parse(component.startedAt) : Number.NaN].filter(Number.isFinite);
    const since = behind.length >= 2 && began.length ? new Date(Math.max(...began)).toISOString() : null;
    const late = behind.length > 1 && !!since && deps.now - Date.parse(since) > graceMs;
    return { component: component.name, label: component.label, release: component.release, baseTip,
      behind: behind.map(({ key, mergedAt }) => ({ key, mergedAt })), since, late, restart: component.restart };
  });
  const settled = await Promise.all(rows);
  const attention: AttentionItem[] = settled.filter(row => row.late).map(row => ({
    subject: row.component === 'loop' ? 'loop' : row.component,
    text: `${row.label} runs ${shortCommit(row.release.commit)}${row.release.dirty ? ' (dirty)' : ''}, more than one delivery behind the base tip ${shortCommit(baseTip)} since ${row.since}: ${row.behind.map(entry => entry.key).join(', ')} merged and are not in what it loads`,
    ...agentOwner('master', row.restart ?? `The loop upgrades itself between cycles once a delivery is verified deployed; a dirty or non-detached coordinator checkout holds it back, and master status names it under upgrade`) }));
  return { baseTip, components: settled, attention };
}

/** The attention a refused upgrade raises, until the checkout clears: the loop stays on its loaded release and says why. */
export function upgradeRefusalAttention(refused: { at: string; reason: string; commit: string | null } | null | undefined, root: string, baseBranch: string): AttentionItem[] {
  if (!refused) return [];
  return [{ subject: 'upgrade', text: `The loop left the coordinator checkout at ${shortCommit(refused.commit)} untouched: ${refused.reason} (seen ${refused.at}). It aligns the checkout with ${baseBranch} between cycles once it is a clean, detached checkout of ${baseBranch}.`,
    ...agentOwner('master', `Clear the coordinator checkout at ${root} — git -C ${root} status --porcelain names what is in it, and git -C ${root} checkout --detach "origin/${baseBranch}" returns it to what the loop upgrades onto`) }];
}

/** The loop-side facts `master status` feeds the lag report: what the cursor and the fleet recorded. */
export interface LagStatusInputs {
  /** The CLI checkout's commit, when the cursor holds no recorded release. */
  cliCommit: string | null;
  /** The daemon summary's loop facts: its loaded release, its lock, its upgrade state. */
  loop: { release: { commit: string | null; dirty: boolean | null } | null; lock: { startedAt: string } | null; upgrade: { refused: { at: string; reason: string; commit: string | null } | null } | null } | null;
  /** The live fleet rows (running or standing down): each executor's release and how it comes back. */
  executors: { name: string; state: string; release: { commit: string | null; dirty: boolean | null }; startedAt: string; restart: string }[];
}

/**
 * What `master status` reports for GY-437: the delivered work each loaded release does not
 * contain, against the base tip, plus the attention for what lags past the grace window and for
 * a checkout the loop's own upgrade refused to touch.
 */
export async function releaseLagStatus(root: string, baseBranch: string, work: readonly { stage: string; key: string; delivery?: { mergedAt: string; mergeSha: string } | null }[], inputs: LagStatusInputs) {
  const deliveries = work.filter(item => item.stage === 'done' && item.delivery)
    .sort((a, b) => Date.parse(a.delivery!.mergedAt) - Date.parse(b.delivery!.mergedAt))
    .map(item => ({ key: item.key, mergeSha: item.delivery!.mergeSha, mergedAt: item.delivery!.mergedAt }));
  const lag = await releaseLag(await readBaseTip(root, baseBranch), deliveries, [
    { name: 'loop', label: 'The master loop', release: inputs.loop?.release ?? { commit: inputs.cliCommit, dirty: null }, startedAt: inputs.loop?.lock?.startedAt ?? null,
      restart: 'systemctl --user restart graphyard-master (the loop also upgrades itself between cycles once a delivery is verified deployed)' },
    ...inputs.executors.filter(row => row.state === 'running' || row.state === 'standing-down')
      .map(row => ({ name: row.name, label: `Executor ${row.name}`, release: row.release, startedAt: row.startedAt, restart: row.restart })),
  ], { root, now: Date.now() });
  return { lag, refusal: upgradeRefusalAttention(inputs.loop?.upgrade?.refused, root, baseBranch) };
}
