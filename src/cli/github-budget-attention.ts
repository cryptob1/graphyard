import { agentOwner, type AttentionItem } from '../master.js';

/**
 * Attention the GitHub request budget raises in `master status` (GY-117), read from the control
 * plane's own account of it in `GET /api/status`: `githubBudget` (the live budget, the pause in
 * force, what the last hour was spent on) and `webhooks` (whether deliveries are arriving).
 *
 * Three items, each the incident it is rather than the symptoms it produces:
 *
 * - **A pause** is one item over every job it stops. Twenty paused jobs used to be twenty
 *   identical errors, and the one thing they all meant — GitHub refused, until when, and what
 *   spent the budget — was said nowhere. The per-job errors stay in the ledger.
 * - **A projected exhaustion** is raised while the budget is still there to keep: the spend rate
 *   over the last ten minutes reaches zero before the reset does. It names the pace the
 *   observation workers are held to (GY-567), which is what brings the spend back under the reset.
 * - **A silent webhook** is a broken webhook, not a slower control plane: no delivery for an hour
 *   while pull requests are open, named with the App settings page that fixes it, instead of
 *   being compensated by polling without a word.
 */
export interface BudgetStatus {
  githubBudget?: {
    limit: number | null; remaining: number | null; resetAt: string | null; observedAt: string | null;
    perMinute: number; projectedExhaustionAt: string | null; exhaustsBeforeReset: boolean;
    reserve: number; belowReserve: boolean;
    paused: { since: string; until: string; reason: string } | null;
    lastHour: { requests: number; byKind: { kind: string; requests: number }[] };
    deferrals?: { work: string; until: string; reason: string }[];
    pace?: { tier: string; perMinute: number | null } | null;
  } | null;
  webhooks?: { lastDeliveryAt: string | null; lastHour: number; configured?: boolean; settingsUrl: string | null; openPullRequests: number } | null;
  jobs?: { work_id: string; error: string | null }[];
}

/** How long a wait is, in the unit the reader thinks in. */
const elapsed = (ms: number) => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${Math.floor(ms % 3_600_000 / 60_000)}m` : `${Math.max(0, Math.floor(ms / 60_000))}m`;
const spend = (lastHour: { requests: number; byKind: { kind: string; requests: number }[] }) =>
  `${lastHour.requests} request${lastHour.requests === 1 ? '' : 's'} in the last hour${lastHour.byKind.length ? ` (${lastHour.byKind.map(entry => `${entry.kind} ${entry.requests}`).join(', ')})` : ''}`;

/** The one item a rate-limit pause is, over however many jobs it stopped. */
export function pauseAttention(status: BudgetStatus): AttentionItem[] {
  const budget = status.githubBudget;
  if (!budget?.paused) return [];
  const pausedJobs = (status.jobs ?? []).filter(job => /rate limited|requests paused/.test(job.error ?? '')).length;
  return [{ subject: 'github',
    text: `GitHub requests are paused until ${budget.paused.until} (since ${budget.paused.since}): ${budget.paused.reason}. What exhausted the budget: ${spend(budget.lastHour)}${budget.limit !== null ? ` of an hourly limit of ${budget.limit}` : ''}. Every gate reads stale until the pause lifts; the merge gate refuses observations older than two minutes${pausedJobs ? `; ${pausedJobs} integration job${pausedJobs === 1 ? ' recorded' : 's recorded'} the refusal in the ledger` : ''}`,
    ...agentOwner('control plane', `Nothing to run: observation resumes at ${budget.paused.until}; graphyard status (githubBudget.lastHour) shows what spent it, and the merge-path reserve (${budget.reserve} requests) keeps merge-gate candidates observed before the next pause`) }];
}

/** The budget is going to run out before it resets: named with the projected time, while there is still budget to keep. */
export function exhaustionAttention(status: BudgetStatus): AttentionItem[] {
  const budget = status.githubBudget;
  if (!budget || budget.paused || !budget.exhaustsBeforeReset || !budget.projectedExhaustionAt) return [];
  return [{ subject: 'github',
    text: `GitHub budget: ${budget.remaining ?? '?'}${budget.limit !== null ? ` of ${budget.limit}` : ''} requests remain and the spend rate is ${budget.perMinute}/min over the last ten minutes; at that rate the budget is exhausted at ${budget.projectedExhaustionAt}, before it resets at ${budget.resetAt ?? 'an unknown time'}${budget.pace?.perMinute != null ? `; observation workers are paced to ${budget.pace.perMinute}/min (${budget.pace.tier}) so the spend above the reserve lasts until the reset` : ''}${budget.belowReserve ? `; it is already below the ${budget.reserve}-request merge-path reserve, so only merge-gate candidates and webhook wakes are observed` : ''}`,
    ...agentOwner('master', `graphyard status (githubBudget) names the spend by kind; below the ${budget.reserve}-request reserve non-merge observations yield on their own, so nothing needs stopping — reduce open candidates or wait for the reset if the spend is not observation`) }];
}

/** No webhook delivery for an hour while pull requests are open: a broken webhook, named as one. */
export function webhookAttention(status: BudgetStatus, now: number): AttentionItem[] {
  const webhooks = status.webhooks;
  if (!webhooks || webhooks.openPullRequests === 0) return [];
  const since = webhooks.lastDeliveryAt ? now - Date.parse(webhooks.lastDeliveryAt) : null;
  if (since !== null && since < 3_600_000) return [];
  const settings = webhooks.settingsUrl ?? 'https://github.com/settings/apps';
  const open = `${webhooks.openPullRequests} pull request${webhooks.openPullRequests === 1 ? ' is' : 's are'} open`;
  return [{ subject: 'github',
    text: `No GitHub webhook delivery has arrived ${since === null ? 'since the control plane started' : `for ${elapsed(since)} (last at ${webhooks.lastDeliveryAt})`} while ${open}${webhooks.configured === false ? '; GITHUB_WEBHOOK_SECRET is not set, so every delivery is refused' : ''}: polling is compensating at its safety-net cadence, so the webhook is broken rather than the control plane slow`,
    ...agentOwner('master', `Check the App webhook settings at ${settings} (URL https://YOUR-HOST/api/github/webhook, the secret matching GITHUB_WEBHOOK_SECRET, deliveries listed under ${settings}/advanced); a delivery that arrives clears this`) }];
}

/** Every budget item, in the order an operator reads them: the pause, the exhaustion ahead, the silent webhook. */
export function githubBudgetAttention(status: BudgetStatus | null | undefined, now = Date.now()): AttentionItem[] {
  if (!status) return [];
  return [...pauseAttention(status), ...exhaustionAttention(status), ...webhookAttention(status, now)];
}
