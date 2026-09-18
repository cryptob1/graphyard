import { createSign } from 'node:crypto';
import type { Transport } from './transport.js';

export const CHECK_NAME = 'Graphyard / merge';
export const VERIFICATION_CHECK = 'Graphyard / install verification';

export interface AppFacts { appId: number; slug: string; installationId: number; privateKey: string; webhookSecret: string }
export interface GitHubCli { (args: string[], options?: { input?: string; allowFailure?: boolean }): Promise<{ stdout: string; stderr: string; code: number }> }

export function githubCli(transport: Transport): GitHubCli {
  return (args, options = {}) => transport.exec('gh', args, { input: options.input, allowFailure: options.allowFailure, timeout: 180_000 });
}

export async function ghJson(gh: GitHubCli, args: string[], fallback: unknown = null) {
  const result = await gh(args, { allowFailure: true });
  if (result.code !== 0) return fallback;
  try { return JSON.parse(result.stdout); } catch { return fallback; }
}

/** App-level endpoints authenticate with a short JWT signed by the App private key. */
export function appJwt(appId: number, privateKey: string, now = Date.now()) {
  const issued = Math.floor(now / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: issued - 60, exp: issued + 540, iss: String(appId) })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
}

export interface AppClient { request(method: string, path: string, body?: unknown): Promise<any> }

export function appClient(facts: Pick<AppFacts, 'appId' | 'privateKey'>, fetcher: typeof fetch = fetch): AppClient {
  return {
    async request(method, path, body) {
      const response = await fetcher(`https://api.github.com${path}`, {
        method,
        headers: { Authorization: `Bearer ${appJwt(facts.appId, facts.privateKey)}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status})`);
      return response.status === 204 ? null : response.json();
    },
  };
}

export function installationClient(facts: AppFacts, fetcher: typeof fetch = fetch): AppClient {
  let token = ''; let expires = 0;
  return {
    async request(method, path, body) {
      if (expires < Date.now() + 60_000) {
        const response = await fetcher(`https://api.github.com/app/installations/${facts.installationId}/access_tokens`, { method: 'POST', headers: { Authorization: `Bearer ${appJwt(facts.appId, facts.privateKey)}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`GitHub installation authentication failed (${response.status})`);
        const result: any = await response.json();
        token = result.token; expires = Date.parse(result.expires_at);
      }
      const response = await fetcher(`https://api.github.com${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status})`);
      return response.status === 204 ? null : response.json();
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook configuration and delivery proof
// ---------------------------------------------------------------------------

export const webhookUrlFor = (origin: string) => `${origin.replace(/\/$/, '')}/api/github/webhook`;

export async function readWebhookConfig(app: AppClient) {
  try { return await app.request('GET', '/app/hook/config'); } catch { return null; }
}

/** Repairs the webhook URL and rotates the shared secret to the value the server holds. */
export async function configureWebhook(app: AppClient, origin: string, secret: string) {
  return app.request('PATCH', '/app/hook/config', { url: webhookUrlFor(origin), content_type: 'json', insecure_ssl: '0', secret });
}

/**
 * Publishing a neutral check run is the cheapest event that exercises the whole chain:
 * App permissions, GitHub's delivery, the server's signature check, and its 202 reply.
 */
export async function triggerDelivery(installation: AppClient, repository: string, sha: string) {
  return installation.request('POST', `/repos/${repository}/check-runs`, { name: VERIFICATION_CHECK, head_sha: sha, status: 'completed', conclusion: 'neutral', output: { title: 'Graphyard installation verification', summary: 'Published by graphyard install to confirm webhook delivery. It is not a required check.' } });
}

export async function recentDeliveries(app: AppClient) {
  try { const deliveries = await app.request('GET', '/app/hook/deliveries?per_page=30'); return Array.isArray(deliveries) ? deliveries : []; }
  catch { return []; }
}

export interface DeliveryProof { delivered: boolean; statusCode: number | null; event: string | null; at: string | null; detail: string }

export async function verifyDelivery(app: AppClient, since: number, wait: (ms: number) => Promise<void>, attempts = 10): Promise<DeliveryProof> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const deliveries = await recentDeliveries(app);
    const fresh = deliveries.filter((delivery: any) => Date.parse(delivery?.delivered_at ?? '') >= since - 5_000);
    const accepted = fresh.find((delivery: any) => Number(delivery.status_code) >= 200 && Number(delivery.status_code) < 300);
    if (accepted) return { delivered: true, statusCode: Number(accepted.status_code), event: String(accepted.event ?? ''), at: String(accepted.delivered_at ?? ''), detail: 'GitHub delivered a signed event and the server accepted it' };
    const rejected = fresh.find((delivery: any) => Number(delivery.status_code) === 401);
    // A 401 is a real answer, not a slow one: the secrets differ on the two sides.
    if (rejected) return { delivered: false, statusCode: 401, event: String(rejected.event ?? ''), at: String(rejected.delivered_at ?? ''), detail: 'The server rejected the signature: GITHUB_WEBHOOK_SECRET does not match the App webhook secret' };
    if (attempt < attempts - 1) await wait(3_000);
  }
  return { delivered: false, statusCode: null, event: null, at: null, detail: 'No webhook delivery was observed; check the App webhook URL and that the server is reachable from GitHub' };
}

// ---------------------------------------------------------------------------
// Branch protection and CI identity
// ---------------------------------------------------------------------------

export interface ProtectionInputs { repository: string; branch: string; requiredChecks: string[]; graphyardAppId: number | null; reviewCount: number }
export interface ProtectionState { strict: boolean; checks: { context: string; app_id: number | null }[]; reviewCount: number; enforceAdmins: boolean; conversationResolution: boolean }

export async function readProtection(gh: GitHubCli, repository: string, branch: string): Promise<any | null> {
  return ghJson(gh, ['api', `repos/${repository}/branches/${branch}/protection`], null);
}

/**
 * The repository may already require more than Graphyard asks for. Its own setting wins:
 * the installer raises a weaker count to what the review policy needs and never lowers a
 * stronger one, so `--review-policy agent` cannot turn a two-reviewer branch into zero.
 */
export function effectiveReviewCount(inputs: ProtectionInputs, current: any | null) {
  const existing = Number(current?.required_pull_request_reviews?.required_approving_review_count ?? 0);
  return Math.max(Number.isSafeInteger(existing) && existing > 0 ? existing : 0, inputs.reviewCount);
}

/**
 * Read-modify-write. The installer adds what Graphyard requires and never removes a check,
 * reviewer restriction, or bypass rule the repository already chose, and never relaxes a
 * protection the repository already applies.
 */
export function protectionPayload(inputs: ProtectionInputs, current: any | null) {
  const existing: { context: string; app_id: number | null }[] = (current?.required_status_checks?.checks ?? []).map((check: any) => ({ context: String(check.context), app_id: check.app_id ?? null }));
  const checks = [...existing];
  const upsert = (context: string, appId: number | null) => {
    const found = checks.findIndex(check => check.context === context);
    if (found < 0) checks.push({ context, app_id: appId });
    else if (appId !== null) checks[found] = { context, app_id: appId };
  };
  for (const context of inputs.requiredChecks) upsert(context, null);
  // The merge gate is bound to Graphyard's App: another producer cannot publish it.
  if (inputs.graphyardAppId) upsert(CHECK_NAME, inputs.graphyardAppId);
  const reviews = current?.required_pull_request_reviews;
  const reviewCount = effectiveReviewCount(inputs, current);
  const dismissal = reviews?.dismissal_restrictions;
  return {
    required_status_checks: { strict: true, checks },
    enforce_admins: true,
    required_pull_request_reviews: {
      required_approving_review_count: reviewCount,
      dismiss_stale_reviews: reviews?.dismiss_stale_reviews ?? true,
      require_code_owner_reviews: reviews?.require_code_owner_reviews ?? false,
      require_last_push_approval: reviews?.require_last_push_approval ?? reviewCount > 0,
      // Who may dismiss a review is the repository's decision; re-send it or GitHub drops it.
      ...(dismissal ? { dismissal_restrictions: { users: (dismissal.users ?? []).map((user: any) => user.login), teams: (dismissal.teams ?? []).map((team: any) => team.slug), apps: (dismissal.apps ?? []).map((app: any) => app.slug) } } : {}),
    },
    restrictions: current?.restrictions
      ? { users: (current.restrictions.users ?? []).map((user: any) => user.login), teams: (current.restrictions.teams ?? []).map((team: any) => team.slug), apps: (current.restrictions.apps ?? []).map((app: any) => app.slug) }
      : null,
    required_conversation_resolution: true,
    allow_force_pushes: false,
    allow_deletions: false,
    required_linear_history: current?.required_linear_history?.enabled ?? false,
    block_creations: current?.block_creations?.enabled ?? false,
    lock_branch: current?.lock_branch?.enabled ?? false,
    allow_fork_syncing: current?.allow_fork_syncing?.enabled ?? false,
  };
}

/**
 * True when the branch already enforces everything `protectionPayload` would write, so a
 * re-apply can skip the write. It has to test every term of that payload the installer
 * insists on: a branch that can still be force-pushed or deleted is not protected, however
 * many checks and reviewers it requires, because the commit evidence is bound to can be
 * replaced underneath it.
 */
export function protectionSatisfied(inputs: ProtectionInputs, current: any | null) {
  if (!current) return false;
  const checks: any[] = current.required_status_checks?.checks ?? [];
  const has = (context: string, appId: number | null) => checks.some(check => check.context === context && (appId === null || Number(check.app_id) === appId));
  return !!current.required_status_checks?.strict
    && inputs.requiredChecks.every(context => has(context, null))
    && (!inputs.graphyardAppId || has(CHECK_NAME, inputs.graphyardAppId))
    && !!current.enforce_admins?.enabled
    && !!current.required_conversation_resolution?.enabled
    && !current.allow_force_pushes?.enabled
    && !current.allow_deletions?.enabled
    // A repository that requires more reviewers than the policy asks for already satisfies it.
    && Number(current.required_pull_request_reviews?.required_approving_review_count ?? -1) >= inputs.reviewCount;
}

export async function applyProtection(gh: GitHubCli, inputs: ProtectionInputs) {
  const current = await readProtection(gh, inputs.repository, inputs.branch);
  const payload = protectionPayload(inputs, current);
  const result = await gh(['api', '--method', 'PUT', `repos/${inputs.repository}/branches/${inputs.branch}/protection`, '--input', '-'], { input: JSON.stringify(payload), allowFailure: true });
  if (result.code !== 0) throw new Error(`Branch protection could not be applied; run "gh auth status" and confirm the account administers ${inputs.repository}`);
  return payload;
}

/** CI identities are discovered from the checks GitHub actually published on the base branch. */
export async function detectCiAppIds(gh: GitHubCli, repository: string, branch: string, exclude: number | null) {
  const runs = await ghJson(gh, ['api', `repos/${repository}/commits/${branch}/check-runs?per_page=100`], null) as any;
  const found = new Map<number, string>();
  for (const run of runs?.check_runs ?? []) {
    const id = Number(run?.app?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || id === exclude) continue;
    if (String(run?.name ?? '') === VERIFICATION_CHECK) continue;
    found.set(id, String(run?.app?.slug ?? run?.app?.name ?? 'unknown'));
  }
  return [...found].map(([appId, slug]) => ({ appId, slug })).sort((left, right) => left.appId - right.appId);
}

export async function headSha(gh: GitHubCli, repository: string, branch: string) {
  const reference = await ghJson(gh, ['api', `repos/${repository}/commits/${branch}`], null) as any;
  const sha = String(reference?.sha ?? '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Cannot read the head commit of ${repository}@${branch}`);
  return sha;
}
