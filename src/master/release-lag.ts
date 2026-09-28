// Concern: GY-437 — how far what runs lags the base tip, and the attention that names it.
//
// The loop upgrades itself between cycles and `master executors restart` brings the fleet along,
// but an upgrade that cannot run (a dirty checkout, a refused restart, a loop nothing supervises)
// used to be invisible: every component went on running the release it had loaded. This module
// says, per component, what it loaded against the base tip, and names any component that stays
// more than one delivery behind for over ten minutes — one delivery behind is the ordinary gap
// between a merge and its verified deployment, and is never named. A delivery whose merge changed
// no code the loop or the executors load holds nothing back — the upgrade moves the checkout for
// it and restarts nothing — so it is never counted. The ancestry scan is bounded: what a release
// holds is a prefix of the merge-ordered deliveries, so each component scans from the newest back
// and stops at the first delivery its release contains, however long the delivered history is.
import { agentOwner, type AttentionItem } from './attention.js';
import { shortCommit } from '../executor-fleet.js';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { upgradeTouchesCode } from '../daemon/upgrade.js';

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

/** Whether git places `ancestor` inside `descendant`: yes, no, or unknown when git cannot answer. */
async function isAncestor(root: string, run: ChildRun, ancestor: string, descendant: string): Promise<boolean | null> {
  try { await run('git', ['-C', root, 'merge-base', '--is-ancestor', ancestor, descendant]); return true; }
  catch (error: any) { return error?.status === 1 ? false : null; }
}

export interface ReleaseLagRow {
  component: string; label: string;
  release: { commit: string | null; dirty: boolean | null };
  baseTip: string | null;
  /** Delivered items the loaded release does not contain whose merge changed loaded code, oldest first; ancestry git cannot place is never counted. */
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
 * is known — and when its merge changed code the loop or the executors load: a docs-only merge
 * moves the checkout and restarts nothing, so it holds no component back (GY-490). The scan runs
 * from the newest delivery back: deliveries are ordered by merge, so what a release holds is a
 * prefix of them, and the first delivery git places inside the release ends the scan — a
 * component k deliveries behind costs k + 1 ancestry reads and k diffs, however long the
 * delivered history is. Provider timestamps can tie and the snapshot holds no order within a
 * tie, so an equal-timestamp group is placed whole before the scan may stop: a contained
 * delivery never ends the scan ahead of a tied delivery merged after it (GY-490).
 */
export async function releaseLag(baseTip: string | null, deliveries: readonly LagDelivery[], components: readonly LagComponent[],
  deps: { root: string; run?: ChildRun; now: number; graceMs?: number }): Promise<ReleaseLagReport> {
  const run = deps.run ?? defaultChildRun;
  const graceMs = deps.graceMs ?? releaseLagGraceMs;
  const newestFirst = [...deliveries].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt)).reverse();
  /** Whether the delivery's merge changed code the loop or the executors load; a merge git cannot diff reads as code, never as docs-only. */
  const touchesCode = async (mergeSha: string): Promise<boolean> => {
    try {
      const paths = (await run('git', ['-C', deps.root, 'diff', '--name-only', `${mergeSha}^..${mergeSha}`])).split('\n').map(path => path.trim()).filter(Boolean);
      return upgradeTouchesCode(paths);
    } catch { return true; }
  };
  const rows = components.map(async (component): Promise<ReleaseLagRow> => {
    const commit = component.release.commit;
    const behind: LagDelivery[] = [];
    if (commit) for (let start = 0; start < newestFirst.length;) {
      let end = start;
      while (end < newestFirst.length && Date.parse(newestFirst[end].mergedAt) === Date.parse(newestFirst[start].mergedAt)) end++;
      let contained = false;
      for (const delivery of newestFirst.slice(start, end)) {
        const mergeSha = delivery.mergeSha.toLowerCase();
        const placed = mergeSha === commit ? true : await isAncestor(deps.root, run, mergeSha, commit);
        if (placed === true) { contained = true; continue; }
        if (placed === false && await touchesCode(mergeSha)) behind.push(delivery);
      }
      if (contained) break;
      start = end;
    }
    behind.reverse();
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

/** The attention a refused upgrade raises, until the checkout clears: the loop stays on its loaded release and says why. A refusal over the package manifest or lockfile names the install that clears it, since the checkout it refused is already clean and detached. */
export function upgradeRefusalAttention(refused: { at: string; reason: string; commit: string | null } | null | undefined, root: string, baseBranch: string): AttentionItem[] {
  if (!refused) return [];
  const dependency = /package(-lock)?\.json/.test(refused.reason);
  return [{ subject: 'upgrade', text: dependency
    ? `The loop left the coordinator checkout at ${shortCommit(refused.commit)} untouched: ${refused.reason} (seen ${refused.at}). It moves the checkout once the dependencies the changed manifest or lockfile needs are installed at ${root}.`
    : `The loop left the coordinator checkout at ${shortCommit(refused.commit)} untouched: ${refused.reason} (seen ${refused.at}). It aligns the checkout with ${baseBranch} between cycles once it is a clean, detached checkout of ${baseBranch}.`,
    ...agentOwner('master', dependency
      ? `Put the checkout on the base tip and install there: git -C ${root} checkout --detach "origin/${baseBranch}" && cd ${root} && npm ci; the loop then aligns the release and the fleet and the loop restart onto the installed code`
      : `Clear the coordinator checkout at ${root} — git -C ${root} status --porcelain names what is in it, and git -C ${root} checkout --detach "origin/${baseBranch}" returns it to what the loop upgrades onto`) }];
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
  // The lag and a checkout the loop's upgrade refused are attention; the report is what status prints.
  return { attention: [...lag.attention, ...upgradeRefusalAttention(inputs.loop?.upgrade?.refused, root, baseBranch)],
    report: { baseTip: lag.baseTip, graceMs: releaseLagGraceMs, components: lag.components } };
}
