// Concern: GY-1982 — the install's continuous deploy: the ports a deploy runs a commit through,
// the cursor's promotion reading and failed-deploy line, and the one deploy of the base tip the
// alignment performs before anything restarts onto it. Split out of upgrade.ts, which re-exports
// the public pieces, so every existing import keeps working.
import { shortCommit } from './held-cli.js';
import { message, type DaemonState, type PromotionState } from './state.js';
import { sameCommit } from './held-cli.js';
import type { SelfUpgradeOutcome } from './upgrade.js';

/** GY-1982: the action every continuous deploy is recorded on. */
export const deployKey = 'upgrade:deploy';
/**
 * GY-1982: what continuous deploy runs a commit through, each throwing its failure's reason:
 * `deploy` the upgrade sequence after the checkout move (npm ci, database backup, redeploy through
 * the install adapter), `health` the served revision's /healthz reporting the deployed commit.
 * `schemas` reads the commit's schema generation and the database's, before the deploy and again after a failed one; `pin`
 * marks a deployed commit known good.
 */
export interface DeployPorts {
  deploy(commit: string): Promise<void>;
  health(commit: string): Promise<void>;
  schemas(commit: string): Promise<{ target: number | null; database: number | null }>;
  pin?(commit: string): Promise<unknown>;
}
type DeployFailure = NonNullable<PromotionState['deployFailed']>;
/** The alignment context a deploy runs with: git in the code root, the clock, persistence and the action note. */
type DeployCtx = Parameters<typeof deployTip>[4];

/** GY-1982: the line for a tip whose two deploy attempts are spent: it waits for the base branch to move. */
export const spentTipLine = (prior: DeployFailure) => `${deployLine(prior)}; it failed twice, so it waits for the base branch to move`;

/** The cursor's release reading with `fields` set; a fresh one when the cursor holds none. */
export const promotionReading = (previous: PromotionState | null | undefined, at: string, fields: Partial<PromotionState>): PromotionState => ({
  mainSha: null, promotedSha: null, promotedAt: null, behind: null, reason: null,
  ...previous, checkedAt: at, ...fields });

/** The one master status line about a failed deploy (GY-1982); null when none failed. */
export const deployLine = (failed: DeployFailure | null | undefined) => !failed ? null
  : `deploy of ${shortCommit(failed.sha)} failed at ${failed.step}: ${failed.reason}; ${failed.kept ? 'the release was kept because the database was migrated' : failed.rolledBackTo ? `rolled back to ${shortCommit(failed.rolledBackTo)}` : 'it was not rolled back'}`;

/**
 * GY-1982: one continuous deploy of the base tip, between cycles. The release already recorded is
 * no deploy, and a tip that failed twice waits for the base branch to move. Otherwise the checkout
 * moves onto the tip, which is deployed and health-checked; passing, the release reading names it,
 * it is pinned known good, and 'deployed' has the alignment restart onto it. Failing, the recorded
 * release is redeployed the same way, the checkout returned and the failure recorded — unless the
 * failed deploy migrated the database (its schema read after the failure is past the one read before): then it is kept, and the restart
 * onto it goes ahead.
 */
export async function deployTip(state: DaemonState, tip: string, from: string, ports: DeployPorts, ctx: { git: (...args: string[]) => Promise<string> | string; at: () => string; persist: () => Promise<void>; note: (detail: string, failure: boolean) => Promise<void> }): Promise<SelfUpgradeOutcome | 'deployed' | null> {
  const recorded = state.promotion?.promotedSha ?? state.release?.commit ?? null;
  if (sameCommit(recorded, tip)) return null;
  const prior = state.promotion?.deployFailed, attempts = prior && sameCommit(prior.sha, tip) ? prior.attempts + 1 : 1;
  if (attempts > 2) return { outcome: 'skipped', reason: spentTipLine(prior!) };
  const sequence = async (commit: string) => {
    try { await ctx.git('checkout', '--detach', '--quiet', commit); } catch (error) { return { step: 'checkout', reason: message(error) }; }
    for (const step of ['deploy', 'health'] as const) try { await ports[step](commit); } catch (error) { return { step, reason: message(error) }; }
    return null;
  };
  const before = await ports.schemas(tip).then(read => read.database, () => null);
  const failure = await sequence(tip);
  if (!failure) {
    // GY-2844: the deploy is recorded with its commit's committer date, so merged→production counts every merge it contains as served from now.
    const committedAt = await Promise.resolve().then(() => ctx.git('show', '-s', '--format=%cI', tip)).then(out => out.trim(), () => '');
    const deploys = committedAt ? { deploys: [...state.promotion?.deploys ?? [], { sha: tip, committedAt, at: ctx.at() }].slice(-200) } : {};
    state.promotion = promotionReading(state.promotion, ctx.at(), { mainSha: tip, promotedSha: tip, promotedAt: ctx.at(), deployFailed: null, ...deploys });
    await ctx.persist();
    await ports.pin?.(tip).catch(() => {});
    await ctx.note(`Deployed base tip ${shortCommit(tip)}: health passed`, false);
    return 'deployed';
  }
  // Kept only when the database itself moved during the failed deploy: a tip that merely declares a newer schema but failed before migrating is rolled back.
  const after = await ports.schemas(tip).then(read => read.database, () => null);
  const kept = before !== null && after !== null && after > before;
  const back = kept || !recorded ? null : await sequence(recorded);
  if (!kept) await Promise.resolve().then(() => ctx.git('checkout', '--detach', '--quiet', from)).catch(() => '');
  const deployFailed: DeployFailure = { sha: tip, step: failure.step, reason: back ? `${failure.reason}; redeploying ${shortCommit(recorded)} failed at ${back.step}: ${back.reason}` : failure.reason,
    rolledBackTo: kept || back ? null : recorded, kept, attempts, at: ctx.at() };
  state.promotion = promotionReading(state.promotion, ctx.at(), { mainSha: tip, ...(kept ? { promotedSha: tip, promotedAt: ctx.at() } : {}), deployFailed });
  await ctx.persist();
  const line = deployLine(deployFailed)!;
  await ctx.note(line, true);
  return kept ? 'deployed' : { outcome: 'failed', reason: line };
}

/** GY-2344: the deploy of a base tip that is running off the cycle, with the commit its checkout was moved from. */
let running: { tip: string; from: string } | null = null;

/**
 * GY-2344: the base tip a deploy is running off the cycle, or null. The coordinator checkout guard
 * reads it, so the deploy's own checkout moves — onto the tip, and back to the recorded release on
 * a rollback — are never the HEAD drift the guard refuses.
 */
export const deployInFlight = (): { tip: string; from: string } | null => running;

/**
 * GY-2344: starts the deploy of the base tip off the cycle and answers at once the line the
 * alignment's pass reports while it runs: deploy and health — and the rollback on failure —
 * proceed while the loop keeps cycling, instead of holding every dispatch, merge and heartbeat
 * behind them for as long as the build takes. While a deploy runs, no second
 * is started: every pass until it settles reports the one in flight. Null when `deployTip` has
 * nothing to run — the recorded release already names the tip — so the pass proceeds as before,
 * and the spent line when the tip failed its two attempts, so the pass never checks it out. The
 * settled result is recorded by `deployTip` itself: the promotion reading and the `upgrade:deploy`
 * action, persisted, land on the cursor when the deploy ends.
 */
export function deployTipOffCycle(state: DaemonState, tip: string, from: string, ports: DeployPorts, ctx: DeployCtx): string | null {
  const recorded = state.promotion?.promotedSha ?? state.release?.commit ?? null;
  if (sameCommit(recorded, tip)) return null;
  const prior = state.promotion?.deployFailed;
  if (prior && sameCommit(prior.sha, tip) && prior.attempts + 1 > 2) return spentTipLine(prior);
  if (running) return `a deploy of base tip ${shortCommit(running.tip)} is running off the cycle: the loop keeps cycling meanwhile and starts no second deploy`;
  running = { tip, from };
  void deployTip(state, tip, from, ports, ctx).finally(() => { running = null; }).catch(() => {});
  return `deploying base tip ${shortCommit(tip)} off the cycle: deploy and health proceed while the loop keeps cycling, and the result is recorded when it settles`;
}
