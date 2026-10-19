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
 * the install adapter), `health` the served revision's /healthz, `e2e` every case under e2e/cases/
 * against the install's own URL. `schemas` reads, before the deploy, the commit's schema generation
 * and the database's; `pin` marks a deployed commit known good.
 */
export interface DeployPorts {
  deploy(commit: string): Promise<void>;
  health(commit: string): Promise<void>;
  e2e(commit: string): Promise<void>;
  schemas(commit: string): Promise<{ target: number | null; database: number | null }>;
  pin?(commit: string): Promise<unknown>;
}
type DeployFailure = NonNullable<PromotionState['deployFailed']>;

/** The cursor's release reading with `fields` set; a fresh one when the cursor holds none. */
export const promotionReading = (previous: PromotionState | null | undefined, at: string, fields: Partial<PromotionState>): PromotionState => ({
  mainSha: null, promotedSha: null, promotedAt: null, behind: null, ledgerReadAt: null, inFlight: false, runsReadAt: null, dispatchedAt: null, lastDispatchAt: null, nextDueAt: null, reason: null,
  ...previous, checkedAt: at, ...fields });

/** The one master status line about a failed deploy (GY-1982); null when none failed. */
export const deployLine = (failed: DeployFailure | null | undefined) => !failed ? null
  : `deploy of ${shortCommit(failed.sha)} failed at ${failed.step}: ${failed.reason}; ${failed.kept ? 'the release was kept because the database was migrated' : failed.rolledBackTo ? `rolled back to ${shortCommit(failed.rolledBackTo)}` : 'it was not rolled back'}`;

/**
 * GY-1982: one continuous deploy of the base tip, between cycles. The release already recorded is
 * no deploy, and a tip that failed twice waits for the base branch to move. Otherwise the checkout
 * moves onto the tip, which is deployed, health-checked and run end to end; passing, the release
 * reading names it, it is pinned known good, and 'deployed' has the alignment restart onto it. Failing,
 * the recorded release is redeployed the same way (end to end excepted), the checkout returned and
 * the failure recorded — unless the tip migrated the database past what the older release accepts:
 * then it is kept, and the restart onto it goes ahead.
 */
export async function deployTip(state: DaemonState, tip: string, from: string, ports: DeployPorts, ctx: { git: (...args: string[]) => Promise<string> | string; at: () => string; persist: () => Promise<void>; note: (detail: string, failure: boolean) => Promise<void> }): Promise<SelfUpgradeOutcome | 'deployed' | null> {
  const recorded = state.promotion?.promotedSha ?? state.release?.commit ?? null;
  if (sameCommit(recorded, tip)) return null;
  const prior = state.promotion?.deployFailed, attempts = prior && sameCommit(prior.sha, tip) ? prior.attempts + 1 : 1;
  if (attempts > 2) return { outcome: 'skipped', reason: `${deployLine(prior)}; it failed twice, so it waits for the base branch to move` };
  const sequence = async (commit: string, steps: readonly ('deploy' | 'health' | 'e2e')[]) => {
    try { await ctx.git('checkout', '--detach', '--quiet', commit); } catch (error) { return { step: 'checkout', reason: message(error) }; }
    for (const step of steps) try { await ports[step](commit); } catch (error) { return { step, reason: message(error) }; }
    return null;
  };
  const schemas = await ports.schemas(tip).catch(() => ({ target: null, database: null }));
  const failure = await sequence(tip, ['deploy', 'health', 'e2e']);
  if (!failure) {
    state.promotion = promotionReading(state.promotion, ctx.at(), { mainSha: tip, promotedSha: tip, promotedAt: ctx.at(), deployFailed: null });
    await ctx.persist();
    await ports.pin?.(tip).catch(() => {});
    await ctx.note(`Deployed base tip ${shortCommit(tip)}: health and end to end passed`, false);
    return 'deployed';
  }
  const kept = schemas.target !== null && schemas.database !== null && schemas.target > schemas.database;
  const back = kept || !recorded ? null : await sequence(recorded, ['deploy', 'health']);
  if (!kept) await Promise.resolve().then(() => ctx.git('checkout', '--detach', '--quiet', from)).catch(() => '');
  // GY-2217: the reason is never cut: an end-to-end failure names every failing case id and its failing step, and master status shows the whole list.
  const deployFailed: DeployFailure = { sha: tip, step: failure.step, reason: back ? `${failure.reason}; redeploying ${shortCommit(recorded)} failed at ${back.step}: ${back.reason}` : failure.reason,
    rolledBackTo: kept || back ? null : recorded, kept, attempts, at: ctx.at() };
  state.promotion = promotionReading(state.promotion, ctx.at(), { mainSha: tip, ...(kept ? { promotedSha: tip, promotedAt: ctx.at() } : {}), deployFailed });
  await ctx.persist();
  const line = deployLine(deployFailed)!;
  await ctx.note(line, true);
  return kept ? 'deployed' : { outcome: 'failed', reason: line };
}
