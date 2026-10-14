// Concern: the main watch (GY-1519) — main's first-parent history classified against what Graphyard recorded (candidate reverts included, GY-1526), report-only attention, the promotion freeze.
import { z } from 'zod';
import type { ChildRun } from '../child-runner.js';
import type { MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import type { AttentionItem } from '../master/attention.js';
import { ledgerMergeShas, type MergeLedgerState } from '../model/merge-ledger.js';
import { candidateRevertsOf } from '../release-revert.js';
import { type DaemonState, storeAction } from './state.js';
import type { Cycle } from './cycle.js';

/**
 * The main watch reads the base branch's first-parent history from the coordinator checkout — as
 * the promotion ledger last fetched it, never through GitHub's API — since the last promoted
 * commit, and names every commit nothing Graphyard recorded explains: no delivery GitHub merged,
 * no merge ledger entry (model/merge-ledger.ts), no main guard revert, no candidate revert and no
 * direct-merge window. In report-only mode each such commit raises one attention item, once; with
 * the freeze on (`GRAPHYARD_MAIN_WATCH_FREEZE`), promotion is held until an admin acknowledges the
 * commit (`policy.main-watch.acknowledged`, routes/main-watch.ts). Nothing here reverts or reworks.
 *
 * An unknown commit stays in `unknown` until it is acknowledged or explained, whether or not the
 * history read still reaches it: the fallback window advancing past it, or a promotion moving the
 * production record past it, neither drops the commit nor releases its freeze. That retained list
 * is also what makes the report once per sha, across the cursor's action pruning and a restart.
 */
export const mainWatchStateSchema = z.object({
  checkedAt: z.string(),
  /** The newest base branch commit the verdict covers: the tip, or the newest commit below the ones still settling; null when the checkout holds no tip. */
  tip: z.string().max(64).nullable(),
  /** The commits nothing explains and no admin acknowledged, newest first; kept until acknowledged or explained. */
  unknown: z.array(z.object({ sha: z.string().max(64), subject: z.string().max(200), author: z.string().max(100), at: z.string().max(64) }).strict()),
  /** The newest unacknowledged unknown commit promotion is frozen on, and since when; null while nothing freezes it. */
  frozen: z.object({ sha: z.string().max(64), since: z.string() }).strict().nullable(),
}).strict();
export type MainWatchState = z.infer<typeof mainWatchStateSchema>;
export type MainWatchFreeze = NonNullable<MainWatchState['frozen']>;
export type UnknownMainCommit = MainWatchState['unknown'][number];

/** One commit of main's first-parent history, newest first; `at` is the committer date, when it reached the branch. */
export interface MainWatchCommit { sha: string; parents: string[]; subject: string; author: string; at: string }
export interface MainWatchHistory { tip: string | null; since: string | null; commits: MainWatchCommit[] }
/** What the control plane records about the watch: the admin acknowledgements and the direct-merge windows. */
export interface MainWatchPolicy { acknowledged: { sha: string; reason: string; by: string; at: string }[]; directMergeWindows: { since: string; until: string | null }[] }
export interface MainWatchReads {
  history(): Promise<MainWatchHistory>;
  policy(): Promise<MainWatchPolicy>;
  /** Whether the caller asked for the promotion freeze; off, the watch only reports. */
  freeze: boolean;
}

/** How many commits the watch reads when no `rc-production/` record bounds the history; past one it reads everything since the record. */
export const mainWatchHistoryLimit = 200;
/**
 * A commit younger than this is still settling: a merge GitHub just performed reaches the checkout
 * before the control plane records its delivery, so judging it at once would call every fresh
 * merge unknown. The verdict covers it once it is this old; until then promotion (with the freeze
 * on) waits for the verdict, as it does for any tip the watch has not classified.
 */
export const mainWatchSettleMs = 10 * 60_000;
export const mainWatchFreezeVariable = 'GRAPHYARD_MAIN_WATCH_FREEZE';
/** The freeze the deployment environment asks for: `GRAPHYARD_MAIN_WATCH_FREEZE=true` (or 1, yes, on). */
export const mainWatchFreezeFromEnv = (env: NodeJS.ProcessEnv = process.env) => ['1', 'true', 'yes', 'on'].includes((env[mainWatchFreezeVariable] ?? '').trim().toLowerCase());
export const mainWatchKey = (sha: string) => `main-watch:${sha.toLowerCase()}`;
/** The acknowledgement an admin runs: the control plane records it with an admin credential only, read from stdin. */
export const acknowledgeCommand = (sha: string) => `graphyard master main-watch acknowledge ${sha} --reason TEXT --admin-token-stdin`;

const fullSha = /^[0-9a-f]{40}$/i;
const parseLog = (log: string): MainWatchCommit[] => log.split('\x1e').flatMap(record => {
  const [sha = '', parents = '', subject = '', author = '', at = ''] = record.replace(/^\n/, '').split('\x1f');
  return fullSha.test(sha.trim()) ? [{ sha: sha.trim().toLowerCase(), parents: parents.trim().split(/\s+/).filter(Boolean).map(parent => parent.toLowerCase()), subject: subject.trim(), author: author.trim(), at: at.trim() }] : [];
});

/** The watch's reads over the coordinator checkout (git only; the policy read is the control plane's). */
export function mainWatchReads(config: Pick<MasterConfig, 'baseBranch'>, root: string, run: ChildRun, options: { policy: () => Promise<MainWatchPolicy>; freeze: boolean }): MainWatchReads {
  const git = async (...args: string[]) => String(await run('git', ['-C', root, ...args]));
  const format = '--format=%H%x1f%P%x1f%s%x1f%an%x1f%cI%x1e';
  return {
    freeze: options.freeze, policy: options.policy,
    history: async () => {
      let tip: string | null = null;
      // The remote-tracking tip is what the promotion ledger fetched; a checkout without one reads its own branch.
      for (const ref of [`refs/remotes/origin/${config.baseBranch}`, `refs/heads/${config.baseBranch}`]) {
        try { tip = (await git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)).trim().toLowerCase() || null; } catch { tip = null; }
        if (tip) break;
      }
      if (!tip) return { tip: null, since: null, commits: [] };
      let since: string | null = null;
      try {
        const record = JSON.parse((await git('for-each-ref', '--sort=-refname', '--count=1', '--format=%(contents)', 'refs/tags/rc-production/')).trim());
        since = typeof record?.sha === 'string' && fullSha.test(record.sha) ? record.sha.toLowerCase() : null;
      } catch { since = null; }
      // Bounded by the production record, the read is everything since it, however many commits
      // landed; only without a record is it the newest `mainWatchHistoryLimit` commits.
      let log = '';
      if (since) { try { log = await git('log', '--first-parent', format, `${since}..${tip}`); } catch { since = null; } }
      if (!since) log = await git('log', '--first-parent', `--max-count=${mainWatchHistoryLimit}`, format, tip);
      return { tip, since, commits: parseLog(log) };
    },
  };
}

export type MainCommitLabel = 'ledger' | 'github-delivery' | 'revert' | 'candidate-revert' | 'direct-merge' | 'unknown';
export interface ClassifiedMainCommit extends MainWatchCommit { label: MainCommitLabel; /** The item or record that explains it, when one does. */ by: string | null }
export interface MainWatchInputs {
  /** The folded merge ledger (`foldMergeLedger`), by item key. */
  ledger: Readonly<Record<string, Pick<MergeLedgerState, 'mergeSha'>>>;
  /** Every delivery GitHub merged: the item's merge commit, and its split children's. */
  deliveries: readonly { key?: string | null; mergeSha: string }[];
  /** The main guard's reverts, by the revert's merge commit once it merged. */
  mainGuardReverts: readonly { key?: string | null; revertSha: string | null }[];
  /** Reverts of release candidates the caller knows of. */
  candidateReverts: readonly { sha: string; id?: string | null }[];
  /** Direct-merge windows (direct-merge.ts): a commit authored inside one is the operator's. */
  directMergeWindows: readonly { since: string; until: string | null }[];
}

/**
 * Label every first-parent commit by what explains it, in this order: a delivery's merge commit
 * (`github-delivery`, whether or not the ledger names it too), a merge commit the ledger names, a
 * main guard revert, a candidate revert, a commit inside a direct-merge window; a commit nothing
 * explains is `unknown`.
 */
export function classifyMainCommits(history: readonly MainWatchCommit[], inputs: MainWatchInputs): ClassifiedMainCommit[] {
  const ledger = ledgerMergeShas(inputs.ledger);
  const ledgerKey = new Map(Object.entries(inputs.ledger).flatMap(([key, state]) => state.mergeSha ? [[state.mergeSha.toLowerCase(), key] as const] : []));
  const deliveries = new Map(inputs.deliveries.map(delivery => [delivery.mergeSha.toLowerCase(), delivery.key ?? null]));
  const reverts = new Map(inputs.mainGuardReverts.flatMap(revert => revert.revertSha ? [[revert.revertSha.toLowerCase(), revert.key ?? null] as const] : []));
  const candidateReverts = new Map(inputs.candidateReverts.map(revert => [revert.sha.toLowerCase(), revert.id ?? null]));
  const window = (at: string) => { const time = Date.parse(at); return Number.isFinite(time) ? inputs.directMergeWindows.find(entry => Date.parse(entry.since) <= time && (!entry.until || time < Date.parse(entry.until))) ?? null : null; };
  return history.map(commit => {
    const sha = commit.sha.toLowerCase();
    const label: MainCommitLabel = deliveries.has(sha) ? 'github-delivery' : ledger.has(sha) ? 'ledger' : reverts.has(sha) ? 'revert' : candidateReverts.has(sha) ? 'candidate-revert' : window(commit.at) ? 'direct-merge' : 'unknown';
    const by = label === 'github-delivery' ? deliveries.get(sha) ?? null : label === 'ledger' ? ledgerKey.get(sha) ?? null : label === 'revert' ? reverts.get(sha) ?? null
      : label === 'candidate-revert' ? candidateReverts.get(sha) ?? null : label === 'direct-merge' ? `direct-merge window since ${window(commit.at)!.since}` : null;
    return { ...commit, sha, label, by };
  });
}

/** The classifier's inputs as the loop's snapshot holds them: ledger states, deliveries, main guard reverts and candidate reverts (GY-1526) per item. */
export function mainWatchInputs(work: readonly Work[], directMergeWindows: MainWatchInputs['directMergeWindows']): MainWatchInputs {
  return {
    ledger: Object.fromEntries(work.flatMap(item => item.mergeLedger ? [[item.key, item.mergeLedger] as const] : [])),
    deliveries: work.flatMap(item => item.delivery ? [{ key: item.key, mergeSha: item.delivery.mergeSha }, ...(item.delivery.children ?? []).map(child => ({ key: child.key, mergeSha: child.mergeSha }))] : []),
    mainGuardReverts: work.flatMap(item => (item.mainGuardReverts ?? []).map(revert => ({ key: item.key, revertSha: revert.revertSha }))),
    // A revert the merge writer pushed for a failed release candidate (release-revert.ts) is explained by the item's record of it, labelled `candidate-revert`.
    candidateReverts: candidateRevertsOf(work),
    directMergeWindows,
  };
}

/** The attention line one unknown commit raises, naming its sha, subject and author, and what the watch does about it. */
export function mainWatchDetail(commit: Pick<MainWatchCommit, 'sha' | 'subject' | 'author' | 'at'>, baseBranch: string, freeze: boolean) {
  return `Main watch: commit ${commit.sha} on ${baseBranch} ("${commit.subject}" by ${commit.author} at ${commit.at}) is explained by no delivery, merge ledger entry, revert or direct-merge window. `
    + `${freeze ? 'Promotion is frozen until an admin acknowledges it' : 'Reported only: nothing is reverted or reworked'}; acknowledge it with ${acknowledgeCommand(commit.sha)}`;
}

/** A commit still inside the settling grace at `now`: too young for an unexplained one to be judged unknown. */
const settling = (commit: Pick<MainWatchCommit, 'at'>, now: number) => { const at = Date.parse(commit.at); return Number.isFinite(at) && now - at < mainWatchSettleMs; };

/**
 * The verdict over one read: every commit the history holds or the state still carries, labelled;
 * what is unknown (unacknowledged, settled) and the newest commit the verdict covers. An explained
 * commit is covered at once, however fresh; an unexplained one still settling is not judged yet, so
 * the verdict stops below it and promotion (with the freeze on) waits there, never for a merge the
 * control plane has already recorded. Pure, so the step and its tests share it.
 */
export function mainWatchVerdict(history: MainWatchHistory, carried: readonly UnknownMainCommit[], inputs: MainWatchInputs, acknowledged: ReadonlySet<string>, now: number) {
  const inHistory = new Set(history.commits.map(commit => commit.sha));
  // The commits the last verdict held unknown that this read no longer reaches: judged again against today's records, never forgotten.
  const retained = carried.filter(entry => !inHistory.has(entry.sha)).map(entry => ({ ...entry, parents: [] as string[] }));
  const classified = classifyMainCommits([...history.commits, ...retained], inputs);
  const pending = (commit: ClassifiedMainCommit) => commit.label === 'unknown' && !acknowledged.has(commit.sha) && settling(commit, now);
  const unknown = classified.filter(commit => commit.label === 'unknown' && !acknowledged.has(commit.sha) && !settling(commit, now));
  const judged = classified.slice(0, history.commits.length), newestPending = judged.findIndex(pending);
  const covered = newestPending < 0 ? history.tip : judged.slice(newestPending + 1).find(commit => !pending(commit))?.sha ?? history.since;
  return { classified, unknown, tip: covered };
}

/**
 * Cycle step 7f (after deployment verification): read, classify, report once per unknown commit,
 * and keep `state.mainWatch` current. The freeze is the newest unacknowledged unknown commit; the
 * promotion drive reads it from the state next cycle (`promotionCycle`'s `frozen`). The step makes
 * no GitHub request: the history is the checkout's, the policy the control plane's.
 */
export async function mainWatchStep(cycle: Cycle) {
  const { config, state, effects, now, snapshot, performed } = cycle;
  const reads = effects.mainWatch;
  if (!reads) return;
  const history = await reads.history();
  const inputs = mainWatchInputs(snapshot.work, []);
  const previous = state.mainWatch, carried = previous?.unknown ?? [], moment = now();
  // The policy — acknowledgements and direct-merge windows — is read only once something on main is
  // unexplained by the snapshot alone, so a quiet loop asks the control plane nothing each cycle.
  let verdict = mainWatchVerdict(history, carried, inputs, new Set(), moment);
  if (verdict.unknown.length) {
    const policy = await reads.policy();
    verdict = mainWatchVerdict(history, carried, { ...inputs, directMergeWindows: policy.directMergeWindows }, new Set(policy.acknowledged.map(entry => entry.sha.toLowerCase())), moment);
  }
  const unknown: UnknownMainCommit[] = verdict.unknown
    .map(commit => ({ sha: commit.sha, subject: commit.subject.slice(0, 200), author: commit.author.slice(0, 100), at: commit.at.slice(0, 64) }));
  const at = new Date(moment).toISOString();
  let changed = false;
  // Reported once per sha: a commit the last verdict already held is not raised again, whatever
  // the cursor's action pruning did to its row, and a restart reloads the same verdict.
  const reported = new Set(carried.map(entry => entry.sha));
  for (const commit of unknown) {
    const key = mainWatchKey(commit.sha);
    if (reported.has(commit.sha) || state.actions[key]) continue;
    performed.push(storeAction(state, key, { kind: 'escalation', work: null, principal: null, state: 'done', detail: mainWatchDetail(commit, config.baseBranch, reads.freeze), attempts: 1, epoch: null, cycle: state.cycle, at }));
    changed = true;
  }
  const newest = unknown[0] ?? null;
  // A standing freeze keeps the time it began, whichever unknown commit heads it now.
  const frozen = reads.freeze && newest ? { sha: newest.sha, since: previous?.frozen ? previous.frozen.since : at } : null;
  const next = mainWatchStateSchema.parse({ checkedAt: at, tip: verdict.tip, unknown, frozen });
  if (!previous || previous.tip !== next.tip || previous.unknown.map(entry => entry.sha).join() !== next.unknown.map(entry => entry.sha).join() || (previous.frozen?.sha ?? null) !== (next.frozen?.sha ?? null)) changed = true;
  state.mainWatch = next;
  if (changed) await effects.persist(state);
}

/**
 * The promotion drive's freeze inputs from the watch's state: with the freeze asked for, the commit
 * promotion is frozen on and the newest tip the verdict covers; off, nothing, and promotion runs as before.
 */
export function promotionFreeze(freeze: boolean, mainWatch: DaemonState['mainWatch']): { frozen?: MainWatchFreeze | null; watchedTip?: string | null } {
  return freeze ? { frozen: mainWatch?.frozen ?? null, watchedTip: mainWatch?.tip ?? null } : {};
}

/** What `master status` shows of the watch inside the daemon section: how many commits are unknown, the newest, and the freeze. */
export function mainWatchSummary(mainWatch: DaemonState['mainWatch']) {
  if (!mainWatch) return { checkedAt: null, tip: null, unknown: 0, newestUnknown: null, frozen: null };
  return { checkedAt: mainWatch.checkedAt, tip: mainWatch.tip, unknown: mainWatch.unknown.length, newestUnknown: mainWatch.unknown[0]?.sha ?? null, frozen: mainWatch.frozen };
}

/** One attention item per unknown commit the watch holds (none dropped), each naming its sha, subject and author and the acknowledge command. */
export function mainWatchAttention(mainWatch: DaemonState['mainWatch'], baseBranch: string): AttentionItem[] {
  if (!mainWatch?.unknown.length) return [];
  return mainWatch.unknown.map(commit => ({
    subject: 'main-watch', text: mainWatchDetail(commit, baseBranch, mainWatch.frozen?.sha === commit.sha),
    role: 'master' as const, approvedBy: null, human: false, humanOnly: null, next: `Explain the commit, then ${acknowledgeCommand(commit.sha)}`,
  }));
}
