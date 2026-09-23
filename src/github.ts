import { MergeExecutionInProgress, ReconciliationRetry, Refusal, SpeculativeConflict, requireCurrent } from './model.js';
import { createSign, randomUUID } from 'node:crypto';
import { observeCodex } from './codex-review.js';
import { observeAgentReview } from './agent-review.js';
import { readFile } from 'node:fs/promises';
import type { Engine } from './engine.js';
import { CHECK_NAME, carriedApproval, demand, nativeReviewRequired, parseReviewerApps, reviewerProfileFor, reviewProviderOf, type Observation, type ReviewerApp, type ReviewerProfile, type ScopeFile, type TipMerge, type Work, type ReviewRequest } from './model.js';
import { inPlannedScope } from './regression-guard.js';
export { CHECK_NAME };
import { baseRefreshNeeded, dismissedVerdict, ejectedTipRestore, heldBase, mergeBaseDismissalPattern, ownHeads, pendingRestore, queuePlacement, queueRef, treeIdenticalPrediction, type BaseRefresh, type BranchRestore, type CarriedCandidate, type ForeignCandidate, type LandingCheck, type QueuePlacement, type QueueSpeculation, type RevertedDelivery, type ReviewDismissal } from './merge-queue.js';
import { blockedFeatures, controlPlanePermissions, describeShortfall, permissionShortfalls, requiredPermissions, type PermissionFeature, type PermissionLevel, type PermissionShortfall } from './github-permissions.js';

/** Out-of-scope paths compared against the base tip per observation; the rest are refused as uncompared. */
export const scopeLookupBudget = 200;
/**
 * GitHub's compare endpoint reports changed files on its first page only and stops at this many,
 * so a list this long may be truncated: it is treated as incomplete and nothing is carried.
 */
export const compareFileCap = 300;
export interface GitHubConfig { repository: string; base: string; appId: number; installationId: number; privateKey: string; reviewerApps?: ReviewerApp[] }
/**
 * A 401 or a non-rate-limit 403. Retrying it does not help: the credentials or the installed
 * permissions have to change. It is classified apart from rate limiting so it never pauses the
 * whole client, and the job that hit it is held after a bounded number of attempts.
 */
export class GitHubPermissionRefusal extends Refusal {
  constructor(message: string, public kind: 'authentication' | 'permission', status = 502) { super(message, status); }
}
/** What the installed App can do, compared with what Graphyard declares it needs. */
export interface AppPermissionReport {
  appId: number; installationId: number; app: string; account: string | null; installationUrl: string;
  observedAt: string; verifiedAt: string | null; error: string | null; suspended: boolean;
  required: Record<string, PermissionLevel>; granted: Record<string, string> | null;
  missing: PermissionShortfall[]; blockedFeatures: PermissionFeature[]; attention: string[];
}
/**
 * The installation a hold was decided against: identity, suspension and the granted levels of
 * the last verified reading. A hold is released when a passing preflight reports a different
 * fingerprint, never because the same installation was read again. Null until a reading exists.
 */
export function installationFingerprint(report: AppPermissionReport | null): string | null {
  if (!report?.granted) return null;
  const granted = Object.fromEntries(Object.entries(report.granted).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ appId: report.appId, installationId: report.installationId, suspended: report.suspended, granted });
}
/** App-level endpoints authenticate with a short JWT signed by the App private key. */
export function appJwt(appId: number, privateKey: string, now = Date.now()) {
  const issued = Math.floor(now / 1000);
  const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: issued - 60, exp: issued + 540, iss: String(appId) })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
}
export const installationSettingsUrl = (installationId: number) => `https://github.com/settings/installations/${installationId}`;
export class GitHub {
  private token = '';
  private expires = 0;
  private permissions: Record<string, string> = {};
  private blockedUntil = 0;
  private rateFailures = 0;
  private authentication?: Promise<void>;
  private cache = new Map<string, { etag: string; value: any }>();
  private ancestry = new Map<string, boolean>();
  private preflightState: AppPermissionReport | null = null;
  private preflightDueAt = 0;
  private appSlug: string | null = null;
  // A rejected App credential is retried once a minute, not once per queued job: every request
  // needs the token, so this is the whole bound on credential-refusal traffic.
  private authenticationRefusal: { until: number; error: GitHubPermissionRefusal } | null = null;
  /** How often the installed permissions are re-read when nothing has gone wrong. */
  preflightIntervalMs = 5 * 60_000;
  constructor(public config: GitHubConfig) {}
  private backoff(response: Response) {
    const retry = Number(response.headers.get('retry-after'));
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + Math.min(3600_000, 60_000 * 2 ** Math.min(this.rateFailures++, 6)), Number.isFinite(retry) && retry > 0 ? Date.now() + retry * 1000 : 0,
      response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) ? reset : 0);
  }
  /**
   * Turns a failed response into the right refusal. Only a rate limit pauses the client; an
   * authentication or permission refusal is reported as such, and a permission refusal brings
   * the next permission preflight forward so the operator sees what is actually missing.
   */
  private async refusal(response: Response, context: string): Promise<Refusal | null> {
    if (response.ok) return null;
    let text = '';
    try { text = (await response.text()).slice(0, 2000); } catch { /* The status alone is classified. */ }
    const rateLimited = response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || !!response.headers.get('retry-after') || /rate limit/i.test(text));
    if (rateLimited) {
      this.backoff(response);
      return new Refusal(`GitHub ${context} failed (${response.status}): rate limited; requests paused until ${new Date(this.blockedUntil).toISOString()}`, 502);
    }
    if (response.status === 401) return new GitHubPermissionRefusal(`GitHub ${context} failed (401): the App credentials were rejected; check GITHUB_APP_ID, GITHUB_INSTALLATION_ID and the private key`, 'authentication');
    if (response.status === 403) {
      this.preflightDueAt = 0;
      return new GitHubPermissionRefusal(`GitHub ${context} failed (403): ${this.permissionHint()}`, 'permission');
    }
    return new Refusal(`GitHub ${context} failed (${response.status})`, 502);
  }
  private permissionHint() {
    const report = this.preflightState;
    if (report?.suspended) return `the App installation is suspended; restore it at ${report.installationUrl}`;
    if (report?.missing.length) return describeShortfall(report.missing[0], report.app, report.installationUrl);
    return `the installed App lacks a permission this request needs; compare its installation at ${report?.installationUrl ?? installationSettingsUrl(this.config.installationId)} with graphyard github-setup --update-permissions`;
  }
  private appHeaders() {
    return { Authorization: `Bearer ${appJwt(this.config.appId, this.config.privateKey)}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  }
  /**
   * Reads the installation's granted permissions with the App JWT and compares them with the
   * declared set. Never throws: an unreadable installation is itself reported, and the last
   * verified reading is retained so a transient outage does not silently lift a hold.
   */
  async preflight(now = Date.now()): Promise<AppPermissionReport> {
    const previous = this.preflightState;
    const required = requiredPermissions(controlPlanePermissions);
    const base = { appId: this.config.appId, installationId: this.config.installationId, app: previous?.app ?? String(this.config.appId), account: previous?.account ?? null,
      installationUrl: previous?.installationUrl ?? installationSettingsUrl(this.config.installationId), observedAt: new Date(now).toISOString(), required };
    try {
      demand(now >= this.blockedUntil, `GitHub requests paused until ${new Date(this.blockedUntil).toISOString()} after a rate limit`, 502);
      const response = await fetch(`https://api.github.com/app/installations/${this.config.installationId}`, { headers: this.appHeaders(), signal: AbortSignal.timeout(15_000) });
      const refused = await this.refusal(response, 'GET /app/installations');
      if (refused) throw refused;
      const installation: any = await response.json();
      demand(installation && typeof installation === 'object' && installation.permissions && typeof installation.permissions === 'object', 'GitHub returned an installation without permissions', 502);
      const granted: Record<string, string> = Object.fromEntries(Object.entries(installation.permissions).filter(([, level]) => typeof level === 'string')) as Record<string, string>;
      const missing = permissionShortfalls(granted, controlPlanePermissions);
      const app = typeof installation.app_slug === 'string' && installation.app_slug ? installation.app_slug : String(this.config.appId);
      const installationUrl = typeof installation.html_url === 'string' && /^https:\/\/github\.com\//.test(installation.html_url) ? installation.html_url : installationSettingsUrl(this.config.installationId);
      const suspended = !!installation.suspended_at;
      const attention = [...(suspended ? [`App ${app} installation is suspended; restore it at ${installationUrl}`] : []), ...missing.map(shortfall => describeShortfall(shortfall, app, installationUrl))];
      this.preflightState = { ...base, app, account: typeof installation.account?.login === 'string' ? installation.account.login : null, installationUrl, verifiedAt: base.observedAt, error: null, suspended, granted, missing, blockedFeatures: blockedFeatures(missing), attention };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GitHub App permissions could not be read';
      const retained = previous ? { granted: previous.granted, missing: previous.missing, blockedFeatures: previous.blockedFeatures, suspended: previous.suspended, verifiedAt: previous.verifiedAt } : { granted: null, missing: [], blockedFeatures: [] as PermissionFeature[], suspended: false, verifiedAt: null };
      const attention = [`GitHub App permissions could not be verified${retained.verifiedAt ? ` since ${retained.verifiedAt}` : ''}: ${message}`, ...(previous?.attention.filter(line => !line.startsWith('GitHub App permissions could not be verified')) ?? [])];
      this.preflightState = { ...base, ...retained, error: message, attention };
    }
    this.preflightDueAt = now + this.preflightIntervalMs;
    return this.preflightState;
  }
  /** Runs the periodic preflight when its interval elapsed or a permission refusal brought it forward. */
  async preflightIfDue(now = Date.now()): Promise<AppPermissionReport | null> {
    return now >= this.preflightDueAt ? this.preflight(now) : null;
  }
  permissionReport(): AppPermissionReport | null { return this.preflightState ? structuredClone(this.preflightState) : null; }
  /**
   * The reason a feature must wait, or null when the last preflight found the permissions it
   * needs. Before any preflight nothing is held: a hold is only ever placed on a verified fact.
   */
  permissionShortfall(feature: PermissionFeature): string | null {
    const report = this.preflightState;
    if (!report) return null;
    if (report.suspended) return `App ${report.app} installation is suspended; restore it at ${report.installationUrl}`;
    const shortfall = report.missing.find(entry => entry.features.includes(feature));
    return shortfall ? describeShortfall(shortfall, report.app, report.installationUrl) : null;
  }
  private async refreshToken() {
      const response = await fetch(`https://api.github.com/app/installations/${this.config.installationId}/access_tokens`, {
        method: 'POST', headers: this.appHeaders(), signal: AbortSignal.timeout(15_000),
      });
      const refused = await this.refusal(response, 'installation authentication');
      if (refused instanceof GitHubPermissionRefusal) this.authenticationRefusal = { until: Date.now() + 60_000, error: refused };
      if (refused) throw refused;
      this.authenticationRefusal = null;
      const result: any = await response.json();
      demand(typeof result.token === 'string' && result.token.length > 0 && Number.isFinite(Date.parse(result.expires_at)) && Date.parse(result.expires_at) > Date.now(), 'Invalid GitHub installation token response', 502);
      this.token = result.token; this.expires = Date.parse(result.expires_at);
      this.permissions = result.permissions && typeof result.permissions === 'object' ? result.permissions : {};
  }
  private async authenticate() {
    demand(Date.now() >= this.blockedUntil, `GitHub requests paused until ${new Date(this.blockedUntil).toISOString()} after a rate/access refusal`, 502);
    if (this.authenticationRefusal && Date.now() < this.authenticationRefusal.until) throw this.authenticationRefusal.error;
    if (this.expires < Date.now() + 60_000) {
      this.authentication ??= this.refreshToken().finally(() => { this.authentication = undefined; });
      await this.authentication;
    }
    demand(Date.now() >= this.blockedUntil, 'GitHub requests paused after a rate/access refusal', 502);
  }
  async reviewPermissions(): Promise<Record<string, string>> {
    try { await this.authenticate(); return { ...this.permissions }; } catch { return {}; }
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    return this.apiRequest(`/repos/${this.config.repository}${path}`, method, body);
  }
  private async apiRequest(path: string, method = 'GET', body?: unknown): Promise<any> {
    await this.authenticate();
    const cached = method === 'GET' ? this.cache.get(path) : undefined;
    const response = await fetch(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', ...(cached ? { 'If-None-Match': cached.etag } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    // A 304 costs no rate budget. Refresh the entry's recency so a full observation round stays cached.
    if (response.status === 304 && cached) { this.rateFailures = 0; this.cache.delete(path); this.cache.set(path, cached); return structuredClone(cached.value); }
    const refused = await this.refusal(response, `${method} ${path}`);
    if (refused) throw refused;
    this.rateFailures = 0;
    const value = response.status === 204 ? null : await response.json();
    const etag = response.headers.get('etag');
    if (method === 'GET') {
      this.cache.delete(path);
      if (etag) {
        this.cache.set(path, { etag, value: structuredClone(value) });
        if (this.cache.size > etagCacheEntries) this.cache.delete(this.cache.keys().next().value!);
      }
    }
    return value;
  }
  async reviewRepository(): Promise<{ id: number; fullName: string } | null> {
    try {
      // Membership in the token's installation is stronger than public repository readability.
      for (let page = 1; page <= 100; page++) {
        const response = await this.apiRequest(`/installation/repositories?per_page=100&page=${page}`);
        demand(Array.isArray(response.repositories), 'Invalid installation repository inventory', 502);
        const repo = response.repositories.find((r: any) => typeof r.full_name === 'string' && r.full_name.toLowerCase() === this.config.repository.toLowerCase());
        if (repo) return Number.isSafeInteger(repo.id) && repo.id > 0 ? { id: repo.id, fullName: repo.full_name } : null;
        if (response.repositories.length < 100) return null;
      }
    } catch { /* Unknown scope must not advertise dispatch support. */ }
    return null;
  }
  async pages(path: string, field?: string): Promise<any[]> {
    const result: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const rows = field ? response[field] : response;
      demand(Array.isArray(rows), 'Unexpected GitHub response', 502);
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw new Error('GitHub pagination exceeded safety limit; refusing incomplete evidence');
  }
  async protection(requireNativeReview = false) {
    try {
      const p = await this.request(`/branches/${encodeURIComponent(this.config.base)}/protection`);
      // `strict` must be off: a queued tip is deliberately behind the base branch, and the merge
      // queue supersedes that setting with a published tip that already contains its validated base.
      return (!requireNativeReview || p.required_pull_request_reviews?.required_approving_review_count >= 1 && p.required_pull_request_reviews?.dismiss_stale_reviews && p.required_pull_request_reviews?.require_last_push_approval) && p.required_status_checks?.strict === false && !!p.enforce_admins?.enabled && !p.allow_force_pushes?.enabled && !p.allow_deletions?.enabled
        && p.required_status_checks.checks?.some((c: any) => c.context === CHECK_NAME && c.app_id === this.config.appId);
    } catch { return false; }
  }
  /**
   * The managed branch's head and its tree, read from `refs/heads/<base>`. A pull request's
   * `base.sha` is GitHub's cached view of the same ref, refreshed only when it recomputes the
   * pull request, and it is never used for the base tip: a binding decided against it was the
   * root cause of approvals dismissed for a merge base that had not actually changed.
   */
  async baseBranch(): Promise<{ tip: string; tree: string }> {
    const ref = await this.request(`/git/ref/heads/${this.config.base.split('/').map(encodeURIComponent).join('/')}`);
    const tip = ref?.object?.sha;
    demand(ref?.object?.type === 'commit' && typeof tip === 'string' && /^[a-f0-9]{40}$/.test(tip), `GitHub did not return a readable head for refs/heads/${this.config.base}`, 502);
    return { tip, tree: await this.commitTree(tip) };
  }
  /** Whether `head` contains `base` by ancestry, as GitHub's compare reports it. Ancestry between two commit SHAs never changes, so it is asked once. */
  async contains(base: string, head: string): Promise<boolean> {
    if (base === head) return true;
    const key = `${base}...${head}`;
    const known = /^[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/.test(key) ? this.ancestry.get(key) : undefined;
    if (known !== undefined) return known;
    const comparison = await this.request(`/compare/${base}...${head}?per_page=1`);
    demand(typeof comparison?.status === 'string', `GitHub did not compare ${base.slice(0, 12)} with ${head.slice(0, 12)}`, 502);
    const contained = comparison.status === 'ahead' || comparison.status === 'identical';
    if (/^[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/.test(key)) {
      this.ancestry.set(key, contained);
      if (this.ancestry.size > ancestryEntries) this.ancestry.delete(this.ancestry.keys().next().value!);
    }
    return contained;
  }
  /** The base a published speculative tip was built on, when the head is that tip; otherwise null. */
  private speculativeBase(work: Work, headSha: string): string | null {
    const speculation = work.queue?.speculation;
    return speculation && speculation.tip === headSha && speculation.policyRevision === work.policyRevision ? speculation.base : null;
  }
  /**
   * The base a candidate is legitimately bound to, for the guards that run between observations.
   * A published speculative tip carries the base it was built on, and the managed branch advances
   * underneath it while the entries ahead of it land, so the live branch head is not that binding.
   * Neither is it the binding of a candidate whose head Graphyard has not yet brought onto a
   * branch that moved: somebody else's merge did not change the tree this one was reviewed and
   * proved on, so the bound base is held. Deciding that needs an ancestry comparison, so it is
   * decided in `observe` and only re-read here, for exactly the head and branch head it decided
   * on. Every other candidate binds to the live head.
   */
  private boundBase(work: Work, pr: any, branch: { tip: string }): string {
    const speculative = this.speculativeBase(work, pr.head.sha);
    if (speculative) return speculative;
    const observation = work.observation;
    const held = observation && observation.candidate.sha === pr.head.sha && observation.baseTip === branch.tip
      && heldBase(work, pr.head.sha, branch.tip) === observation.candidate.baseSha ? observation.candidate.baseSha : null;
    return held ?? branch.tip;
  }
  /**
   * `peers` is every work item as the caller read it. It is what lets the landing check see other
   * items' unlanded candidates in this head's history, and name the merge that took a delivery
   * off the base branch; without it those two answers are left out, never guessed.
   */
  async observe(work: Work, peers?: Work[]): Promise<Observation> {
    const startedAt = new Date().toISOString();
    const pr = await this.request(`/pulls/${work.submission!.pr}`);
    demand(pr.base.repo.full_name.toLowerCase() === this.config.repository.toLowerCase() && pr.head.repo?.full_name.toLowerCase() === this.config.repository.toLowerCase(), 'MVP requires same-repository pull requests');
    demand(pr.base.ref === this.config.base, 'Pull request targets an unmanaged branch');
    const [checks, reviews, protectedBranch, files, branch] = await Promise.all([
      this.pages(`/commits/${pr.head.sha}/check-runs?filter=all`, 'check_runs'), this.pages(`/pulls/${pr.number}/reviews`), this.protection(nativeReviewRequired(work.policy)), this.pages(`/pulls/${pr.number}/files`), this.baseBranch(),
    ]);
    const latest = new Map<string, any>();
    for (const r of reviews) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user.login, r);
    // A dismissed review is recorded with GitHub's reason for dismissing it and the head it was
    // given on (GY-127): the review list alone cannot tell a reviewer withdrawing a verdict from
    // GitHub withdrawing an approval because the merge base moved under an unchanged head.
    const dismissals = [...latest.values()].some(r => r.state === 'DISMISSED') ? await this.reviewDismissals(pr.number) : { read: new Map<number, ReviewDismissal>(), unread: null };
    const dismissalOf = (id: number): ReviewDismissal | undefined => dismissals.read.get(id) ?? (dismissals.unread ? { reason: null, mergeBase: false, verdict: null, commit: null, at: null, by: null, unread: dismissals.unread } : undefined);
    // A published speculative tip carries its own validated base. The candidate stays bound to
    // that exact commit while the managed branch advances underneath it through queue merges. A
    // head that already contains the branch tip is up to date and binds to it, as it always did.
    // A head that does not holds the base it was bound to while Graphyard brings it onto the new
    // one — but only while the managed branch still contains that commit. A rewind is not an
    // advance: the binding is given up and the candidate rebinds to the live head.
    const speculative = this.speculativeBase(work, pr.head.sha);
    const contained = pr.merged || await this.contains(branch.tip, pr.head.sha);
    const holding = speculative || contained ? null : heldBase(work, pr.head.sha, branch.tip);
    const bound = speculative ?? (holding && await this.contains(holding, branch.tip) ? holding : branch.tip);
    // Out-of-scope files are compared with the bound base: the predicted base already contains
    // every queued predecessor, so their changes on a speculative tip are not this candidate's.
    const scopeFiles = await this.compareScope(work.plannedFiles ?? [], files, bound);
    // The bound base is held while the head is unchanged, so the same comparison is made where
    // the merge would land, on every observation of an open candidate (GY-97). A merged pull
    // request is judged the other way round: whether the base branch still holds what it shipped.
    const budget = { remaining: scopeLookupBudget };
    const landing = pr.merged || pr.state !== 'open' ? undefined : await this.landingCheck(work, pr.head.sha, files, bound, speculative, branch, peers, budget);
    const revertedDelivery = pr.merged && work.stage !== 'done' ? await this.revertedDelivery(work, pr, files, branch, peers, budget) : undefined;
    const candidateBase = pr.merged && work.candidate && work.candidate.sha === pr.head.sha ? work.candidate.baseSha : bound;
    // A head contains the base tip by ancestry, or as a published tip whose bound base is the
    // tip's tree-identical predecessor, or as a published tip behind other queue entries, whose
    // chain rests on the base branch by publication; the placement reports whether it still does.
    const speculation = work.queue?.speculation;
    const publishedTip = !!speculation && speculation.tip === pr.head.sha && speculation.policyRevision === work.policyRevision;
    const baseTipContained = contained || publishedTip && (speculation!.baseTree === branch.tree || speculation!.predecessors.length > 0);
    const provider = reviewProviderOf(work.policy);
    const unready = !pr.merged && (pr.state !== 'open' || pr.draft !== false)
      ? pr.draft ? 'Pull request is draft; mark it ready to request code review' : 'Pull request is not open; reopen it to request code review' : null;
    const agentReview = !work.policy.review || provider === 'github' ? undefined
      : provider === 'codex' ? unready
        ? { provider: 'codex' as const, sha: pr.head.sha, approved: false, reason: unready }
        : await observeCodex(this, pr.number, pr.head.sha, reviews, pr.user.id, work.reviewRequest, candidateBase, work.policyRevision, this.config.appId)
      : await this.observeAgent(work, pr, reviews, candidateBase, unready);
    const confirmed = await this.request(`/pulls/${work.submission!.pr}`);
    demand(confirmed.head.sha === pr.head.sha && confirmed.base.sha === pr.base.sha && confirmed.base.ref === pr.base.ref && confirmed.head.ref === pr.head.ref
      && confirmed.state === pr.state && confirmed.draft === pr.draft && confirmed.merged === pr.merged, 'PR changed while collecting evidence; retry');
    return {
      candidate: { sha: pr.head.sha, baseSha: candidateBase, pr: pr.number, branch: pr.head.ref, author: pr.user.login, ...(Number.isFinite(Date.parse(pr.created_at)) ? { createdAt: pr.created_at } : {}) },
      // Canonical oldest-to-newest ordering makes legacy consumers deterministic;
      // gates also compare immutable run IDs rather than trusting response order.
      checks: checks.filter(c => c.name !== CHECK_NAME).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).map(c => ({ name: c.name, result: c.status === 'completed' ? c.conclusion : c.status, appId: c.app.id,
        ...(Number.isSafeInteger(c.id) ? { id: c.id } : {}), ...(Number.isSafeInteger(c.run_attempt) ? { attempt: c.run_attempt } : {}) })),
      ...(agentReview ? { agentReview } : {}),
      reviewIds: reviews.every(r => Number.isSafeInteger(r.id) && r.id > 0) ? reviews.map(r => r.id) : undefined,
      reviews: [...latest.values()].map(r => ({ id: r.id, reviewer: r.user.login, sha: r.commit_id, state: r.state, submittedAt: r.submitted_at,
        ...(r.state === 'DISMISSED' && dismissalOf(r.id) ? { dismissal: dismissalOf(r.id)! } : {}) })),
      prState: pr.state, draft: pr.draft, prCreatedAt: pr.created_at, merged: pr.merged, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at, mergeable: pr.mergeable === true && !pr.draft && pr.state === 'open',
      protected: protectedBranch, files: files.map(f => f.filename), at: startedAt,
      baseTip: branch.tip, baseTree: branch.tree, baseTipContained, scopeFiles,
      ...(landing ? { landing } : {}), ...(revertedDelivery ? { revertedDelivery } : {}),
    };
  }
  /**
   * The commit the candidate would land on, and what landing there would revert (see
   * merge-queue.ts LandingCheck). A tip published behind entries that have not landed lands on
   * its predicted base, which is its bound base; everything else lands on the live branch head.
   * A base that differs from the bound one only by commit, not by tree, needs no second
   * comparison. The answer about carried candidates is reused while the head, the landing commit
   * and every open candidate it was decided against are unchanged.
   */
  private async landingCheck(work: Work, head: string, files: any[], bound: string, speculative: string | null, branch: { tip: string; tree: string }, peers: Work[] | undefined, budget: { remaining: number }): Promise<LandingCheck> {
    const speculation = work.queue?.speculation;
    const predicted = !!speculative && speculative !== branch.tip && speculation!.baseTree !== branch.tree && speculation!.predecessors.length > 0 && await this.contains(branch.tip, speculative);
    const base = predicted ? speculative! : branch.tip;
    const sameTree = base === bound || !!speculative && speculation!.baseTree === branch.tree;
    // The pull request's own diff is taken against the live branch, which does not hold the
    // entries ahead yet: a file one of them adds and this head drops appears in it nowhere. What
    // landing on a predicted base does is that base compared with the head that contains it.
    const landed = predicted ? await this.landingDiff(base, head) : sameTree ? null : files;
    const landing: LandingCheck = { base, ...(landed ? { files: await this.compareScope(work.plannedFiles ?? [], landed, base, budget) } : {}) };
    if (!peers) return landing;
    const open = peers.filter(peer => peer.id !== work.id && peer.stage !== 'done' && !!peer.submission && !!peer.candidate && peer.candidate.sha !== head
      && !!peer.observation && !peer.observation.merged && peer.observation.prState !== 'closed' && peer.observation.candidate.sha === peer.candidate.sha);
    // A peer is in this head's history by its current head, or by the reviewed head under a tip
    // of its own: the tip a queue republishes changes, the reviewed head under it does not.
    landing.examined = open.map(peer => `${peer.key}@${ownHeads(peer).join('+')}`).sort();
    const previous = work.observation && work.observation.candidate.sha === head ? work.observation.landing : undefined;
    if (previous?.carried && previous.foreign && previous.base === base && JSON.stringify(previous.examined) === JSON.stringify(landing.examined) && !previous.carried.some(entry => entry.unverified)) return { ...landing, carried: previous.carried, foreign: previous.foreign };
    const carried: CarriedCandidate[] = [];
    const foreign: ForeignCandidate[] = [];
    // The entries ahead are in a predicted base by construction, so their files standing in this
    // head as they stand there is the ordinary state of a queued tip and says nothing: two entries
    // ahead that both change one file leave it merged in the tip behind them. What such a tip would
    // really take from them is a change to the base it lands on, which `files` compares above —
    // every drop of theirs is a removal or a modification in `base...head`. So they are judged
    // there, and `carried` judges the candidates the landing commit does not hold.
    const ahead = new Set(predicted ? speculation!.predecessors : []);
    // One compare per peer, asked a few at a time: asked in turn they held an observation past the
    // merge window's 25 seconds, so a candidate with many open peers could never be authorized in time.
    const containment = await boundedMap(open, peerContainmentConcurrency, async peer => {
      if (ahead.has(peer.key)) return false;
      for (const sha of ownHeads(peer)) if (await this.contains(sha, head)) return true;
      return false;
    });
    for (const [index, peer] of open.entries()) {
      if (!containment[index]) continue;
      foreign.push({ key: peer.key, pr: peer.candidate!.pr, head: peer.candidate!.sha });
      const entry: CarriedCandidate = { key: peer.key, pr: peer.candidate!.pr, head: peer.candidate!.sha, dropped: [] };
      for (const file of peer.observation!.scopeFiles ?? []) {
        // A file this item planned is its own to change, whoever else touched it.
        if (inPlannedScope(work.plannedFiles ?? [], file.path)) continue;
        if ((budget.remaining -= 2) < 0) { entry.unverified = true; break; }
        const held = await this.blobAt(file.path, head);
        if (file.status !== 'removed' && held === file.sha) continue;
        // Neither the owner's version nor anything new: exactly what the landing commit holds, so
        // the owner's change is in this head's history and absent from its tree.
        if (held !== await this.blobAt(file.path, base) || file.status === 'removed' && held === null) continue;
        entry.dropped.push({ path: file.path, detail: held === null ? 'the file is absent from this head and from the commit it would land on' : 'the file is held exactly as the commit it would land on holds it' });
      }
      if (entry.dropped.length || entry.unverified) carried.push(entry);
    }
    return { ...landing, carried, foreign };
  }
  /** True when the commit took the path from the content the pull request delivered: one of its parents still holds that exact blob. */
  private async revertsDelivered(commit: string, path: string, files: any[]): Promise<boolean> {
    const delivered = files.find(file => file.filename === path)?.sha;
    const detail = await this.request(`/commits/${commit}`);
    for (const parent of Array.isArray(detail?.parents) ? detail.parents : []) if (typeof parent?.sha === 'string' && await this.blobAt(path, parent.sha) === delivered) return true;
    return false;
  }
  /** The provider's file records for `base...head`; a list at the cap ends with a record nothing was compared for, which the guard refuses. */
  private async landingDiff(base: string, head: string): Promise<any[]> {
    const comparison = await this.request(`/compare/${base}...${head}`);
    demand(Array.isArray(comparison?.files), `GitHub did not list the files changed between ${base.slice(0, 12)} and ${head.slice(0, 12)}`, 502);
    return comparison.files.length < compareFileCap ? comparison.files
      : [...comparison.files, { filename: `(the comparison lists ${compareFileCap} files or more; the rest were not compared)`, status: 'unchanged', additions: 0, deletions: 0, uncompared: true }];
  }
  /**
   * Whether the base branch holds what a merged pull request shipped (GY-97). A file is missing
   * when the branch head holds it exactly as the base held it before the merge — or not at all —
   * rather than as the pull request left it; a file somebody changed afterwards is not. The merge
   * that removed it is found from the branch's own history of the path when the content was once
   * on the branch, accepted only if that commit took the path from the delivered content — a
   * parent of it holds that exact blob — and otherwise among the merged candidates whose head carried this one:
   * the merge that made the provider record this pull request merged. Asked again only when the
   * branch head moves.
   */
  private async revertedDelivery(work: Work, pr: any, files: any[], branch: { tip: string }, peers: Work[] | undefined, budget: { remaining: number }): Promise<RevertedDelivery | undefined> {
    const previous = work.observation && work.observation.candidate.sha === pr.head.sha && work.observation.merged ? work.observation.revertedDelivery : undefined;
    if (previous && previous.base === branch.tip && !previous.partial && (previous.removedBy || !peers)) return previous;
    const missing: RevertedDelivery['files'] = []; let partial = false;
    for (const file of files) {
      if (file.status === 'removed' || typeof file.sha !== 'string') continue;
      if ((budget.remaining -= 2) < 0) { partial = true; break; }
      const held = await this.blobAt(file.filename, branch.tip);
      if (held === file.sha || held !== await this.blobAt(file.filename, pr.base.sha)) continue;
      missing.push({ path: file.filename, detail: held === null ? 'absent from the base branch' : 'held as it was before this merge' });
    }
    if (!missing.length) return undefined;
    const owner = (number: number) => peers?.find(peer => peer.submission?.pr === number)?.key ?? null;
    let removedBy: RevertedDelivery['removedBy'] = null;
    // Naming the merge is naming a work item, so it is asked only by a caller that brought them.
    if (!peers) return { base: branch.tip, files: missing, removedBy: null, ...(partial ? { partial } : {}) };
    const history = await this.request(`/commits?sha=${branch.tip}&path=${encodeURIComponent(missing[0].path)}&per_page=1`);
    const commit = Array.isArray(history) && typeof history[0]?.sha === 'string' ? history[0].sha as string : null;
    if (commit && commit !== pr.head.sha && await this.revertsDelivered(commit, missing[0].path, files)) {
      const pulls = await this.request(`/commits/${commit}/pulls`);
      const merged = Array.isArray(pulls) ? pulls.find((entry: any) => entry?.merged_at && entry.number !== pr.number && entry.base?.ref === this.config.base) : null;
      if (merged) removedBy = { key: owner(merged.number), pr: merged.number, mergeSha: merged.merge_commit_sha ?? null, commit };
    }
    for (const peer of removedBy ? [] : peers ?? []) {
      if (peer.id === work.id || !peer.observation?.merged || !peer.candidate || peer.candidate.sha === pr.head.sha || !await this.contains(pr.head.sha, peer.candidate.sha)) continue;
      removedBy = { key: peer.key, pr: peer.candidate.pr, mergeSha: peer.observation.mergeSha ?? null, commit: null }; break;
    }
    return { base: branch.tip, files: missing, removedBy, ...(partial ? { partial } : {}) };
  }
  /**
   * The provider's PR diff is taken against the merge base. The regression guard needs every
   * file outside the planned scope compared with the commit the candidate is bound to (the base
   * branch tip, or the predicted base of a published speculative tip), so those paths are looked
   * up there by blob identity. Paths beyond the lookup budget stay uncompared, which the guard
   * refuses rather than passes.
   */
  private async compareScope(plannedFiles: string[], files: any[], base: string, budget = { remaining: scopeLookupBudget }): Promise<ScopeFile[]> {
    const lookup = async (path: string) => budget.remaining-- > 0 ? this.blobAt(path, base) : undefined;
    const compared: ScopeFile[] = [];
    for (const file of files) {
      const status: ScopeFile['status'] = ['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'].includes(file.status) ? file.status : 'modified';
      const previousPath = typeof file.previous_filename === 'string' && file.previous_filename !== file.filename ? file.previous_filename : undefined;
      const entry: ScopeFile = { path: file.filename, status, ...(previousPath ? { previousPath } : {}),
        sha: status !== 'removed' && typeof file.sha === 'string' && /^[a-f0-9]{40}$/.test(file.sha) ? file.sha : null,
        additions: Number.isSafeInteger(file.additions) ? file.additions : 0, deletions: Number.isSafeInteger(file.deletions) ? file.deletions : 0, binary: typeof file.patch !== 'string' };
      if (!file.uncompared && !inPlannedScope(plannedFiles, entry.path)) { const baseSha = await lookup(entry.path); if (baseSha !== undefined) entry.baseSha = baseSha; }
      if (previousPath && status === 'renamed' && !inPlannedScope(plannedFiles, previousPath)) { const previousBaseSha = await lookup(previousPath); if (previousBaseSha !== undefined) entry.previousBaseSha = previousBaseSha; }
      compared.push(entry);
    }
    return compared;
  }
  /** Blob identity of a path at a ref, or null when the ref holds no file there. */
  async blobAt(path: string, ref: string): Promise<string | null> {
    let entry: any;
    try { entry = await this.request(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`); }
    catch (error) { if (error instanceof Refusal && /\(404\)/.test(error.message)) return null; throw error; }
    if (Array.isArray(entry) || entry?.type === 'dir') return null;
    demand(typeof entry?.sha === 'string' && /^[a-f0-9]{40}$/.test(entry.sha), `GitHub did not return a readable blob for ${path} at ${ref}`, 502);
    return entry.sha;
  }
  async verify(work: Work, peers?: Work[]): Promise<Observation> {
    const first = await this.observe(work, peers);
    const second = await this.observe(work, peers);
    const gates = (o: Observation) => JSON.stringify({ candidate: o.candidate, checks: o.checks, reviews: o.reviews, agentReview: o.agentReview, protected: o.protected, merged: o.merged, mergeable: o.mergeable, prState: o.prState, draft: o.draft, scopeFiles: o.scopeFiles, landing: o.landing });
    demand(gates(first) === gates(second), 'GitHub gates changed during final verification; retry');
    return second;
  }
  async serverTime(): Promise<number> {
    await this.authenticate();
    const response = await fetch('https://api.github.com/rate_limit', { headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
    const time = Date.parse(response.headers.get('date') ?? '');
    const refused = await this.refusal(response, 'GET /rate_limit');
    if (refused) throw refused;
    demand(Number.isFinite(time), 'GitHub server time is unavailable', 502);
    await response.body?.cancel();
    return time;
  }
  /** Resolve a policy profile to the numeric App identity registered with this control plane. */
  reviewerAppFor(profile: ReviewerProfile | null | undefined): ReviewerApp | undefined {
    if (!profile) return undefined;
    const app = (this.config.reviewerApps ?? []).find(entry => entry.id === profile.reviewerApp && entry.runtime === profile.runtime);
    return app && app.appId !== this.config.appId ? app : undefined;
  }
  private async observeAgent(work: Work, pr: any, reviews: any[], candidateBase: string, unready: string | null) {
    const profile = reviewerProfileFor(work);
    const app = this.reviewerAppFor(profile);
    if (!profile) return { provider: 'agent' as const, sha: pr.head.sha, approved: false,
      reason: 'Every configured reviewer profile is exhausted for this candidate; add reviewer capacity or select another review provider' };
    if (!app) return { provider: 'agent' as const, sha: pr.head.sha, approved: false, profile: profile.name, reviewerApp: profile.reviewerApp,
      reason: `Reviewer App ${profile.reviewerApp} is not registered with this control plane as an independent ${profile.runtime} reviewer identity` };
    if (unready) return { provider: 'agent' as const, sha: pr.head.sha, approved: false, profile: profile.name, reviewerApp: app.id, reason: unready };
    return observeAgentReview(this, pr.number, pr.head.sha, reviews, pr.user.id, work.reviewRequest, candidateBase, work.policyRevision, this.config.appId, profile, app);
  }
  /**
   * A review is requested only for a head that contains the base tip; anything else is refused
   * before any write. This is a wait, not a rework round: the control plane brings the head onto
   * the moved base itself (see `refreshCandidateBase`) and the request is dispatched for the head
   * it republishes, unless the merge conflicts, which is the one case the worker still owns.
   */
  private reviewable(work: Work) {
    demand(work.observation?.baseTipContained !== false, `Candidate ${work.candidate?.sha.slice(0, 12)} does not contain the base branch tip ${work.observation?.baseTip?.slice(0, 12)}; a review of it would be dismissed when the merge base changes, so none is requested until the head contains the tip`);
  }
  async requestAgentReview(work: Work, profile: ReviewerProfile, app: ReviewerApp, beforeWrite: () => Promise<void>): Promise<ReviewRequest> {
    demand(work.candidate && work.policy.review && reviewProviderOf(work.policy) === 'agent', 'Candidate with agent review policy required');
    demand(app.id === profile.reviewerApp && app.runtime === profile.runtime, 'Reviewer profile does not match its registered App identity');
    demand(app.appId !== this.config.appId, 'The Graphyard control-plane App cannot be dispatched as a reviewer');
    demand((work.policy.reviewerProfiles ?? []).some(configured => configured.name === profile.name && configured.reviewerApp === profile.reviewerApp), 'Reviewer profile is not configured on this policy');
    this.reviewable(work);
    const pr = await this.request(`/pulls/${work.candidate.pr}`);
    requireCurrent(pr.head.sha === work.candidate.sha && this.boundBase(work, pr, await this.baseBranch()) === work.candidate.baseSha && pr.state === 'open' && pr.draft === false, 'PR changed before review dispatch; retry');
    demand(pr.user?.id !== app.botUserId, 'Reviewer identity must be independent of the pull request author');
    const marker = randomUUID();
    const body = `${profile.mention ? `${profile.mention} review\n\n` : ''}Graphyard requests an independent code review from reviewer profile \`${profile.name}\` (runtime \`${profile.runtime}\`).

Review head \`${work.candidate.sha}\` against base \`${work.candidate.baseSha}\` and post exactly one verdict comment through the registered reviewer GitHub App \`${app.id}\`, containing one line:

\`<!-- graphyard-verdict:${marker} head:${work.candidate.sha} verdict:approved -->\`

Use \`verdict:changes-requested\` with the findings, or \`verdict:usage-limit\` when the runtime has no remaining quota so Graphyard can fail over to the next configured profile.

<!-- graphyard-review:${marker} provider:agent profile:${profile.name} reviewer-app:${app.id} head:${work.candidate.sha} base:${work.candidate.baseSha} policy:${work.policyRevision} -->`;
    await beforeWrite();
    const comment = await this.request(`/issues/${work.candidate.pr}/comments`, 'POST', { body });
    demand(comment.performed_via_github_app?.id === this.config.appId && comment.user?.type === 'Bot' && comment.body === body && Number.isSafeInteger(comment.id) && Number.isFinite(Date.parse(comment.created_at)), 'Review dispatch did not return an authenticated Graphyard comment', 502);
    return { commentId: comment.id, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision, body,
      createdAt: comment.created_at, provider: 'agent', profile: profile.name, reviewerApp: app.id, marker };
  }
  async requestCodex(work: Work, beforeWrite: () => Promise<void>): Promise<ReviewRequest> {
    demand(work.candidate && work.policy.review && work.policy.reviewProvider === 'codex', 'Candidate with Codex review policy required');
    this.reviewable(work);
    const pr = await this.request(`/pulls/${work.candidate.pr}`);
    requireCurrent(pr.head.sha === work.candidate.sha && this.boundBase(work, pr, await this.baseBranch()) === work.candidate.baseSha && pr.state === 'open' && pr.draft === false, 'PR changed before review dispatch; retry');
    const body = `@codex review\n\n<!-- graphyard-review:${randomUUID()} head:${work.candidate.sha} base:${work.candidate.baseSha} policy:${work.policyRevision} -->`;
    await beforeWrite();
    const comment = await this.request(`/issues/${work.candidate.pr}/comments`, 'POST', { body });
    demand(comment.performed_via_github_app?.id === this.config.appId && comment.user?.type === 'Bot' && comment.body === body && Number.isSafeInteger(comment.id) && Number.isFinite(Date.parse(comment.created_at)), 'Review dispatch did not return an authenticated Graphyard comment', 502);
    return { commentId: comment.id, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision, body, createdAt: comment.created_at };
  }
  /**
   * The published tip's own tree, or undefined when it could not be read. Read after the tip is
   * published and never allowed to fail it: the tree is what lets the entry behind this one tell a
   * prediction that moved only in sha from one that brings content (GY-100), and an entry that
   * cannot be told either way is republished as it was before, which costs a review round rather
   * than a delivery.
   */
  private async tipTree(tip: string): Promise<string | undefined> {
    return this.commitTree(tip).catch(() => undefined);
  }
  /**
   * Why GitHub dismissed each dismissed review of a pull request, from the issue timeline's
   * `review_dismissed` events, keyed by review id. The verdict the dismissed review carried is
   * read from the event too (`dismissed_review.state`): the review list reports a dismissed
   * change request and a dismissed approval with the same `DISMISSED` state, and only the latter
   * is an approval anyone can restore. A timeline that cannot be read leaves the dismissal
   * recorded as unread rather than failing the observation: the review gate already refuses a
   * dismissed approval, and nothing is inferred from a reason nobody could read.
   */
  async reviewDismissals(pr: number): Promise<{ read: Map<number, ReviewDismissal>; unread: string | null }> {
    const read = new Map<number, ReviewDismissal>();
    try {
      for (const event of await this.pages(`/issues/${pr}/timeline`)) {
        if (event?.event !== 'review_dismissed' || !Number.isSafeInteger(event?.dismissed_review?.review_id)) continue;
        const reason = typeof event.dismissed_review.dismissal_message === 'string' ? event.dismissed_review.dismissal_message : null;
        read.set(event.dismissed_review.review_id, { reason, mergeBase: !!reason && mergeBaseDismissalPattern.test(reason), verdict: dismissedVerdict(event.dismissed_review.state),
          commit: typeof event.dismissed_review.dismissal_commit_id === 'string' ? event.dismissed_review.dismissal_commit_id : null,
          at: typeof event.created_at === 'string' ? event.created_at : null, by: typeof event.actor?.login === 'string' ? event.actor.login : null });
      }
    } catch (error) {
      return { read, unread: error instanceof Error ? error.message : 'the pull request timeline could not be read' };
    }
    return { read, unread: null };
  }
  /**
   * The item's own reviewed head under a branch head (GY-127): the last commit a worker pushed or
   * the control plane brought onto the base, found by walking first parents through this item's
   * own speculative-tip merges. The record names it for a tip the queue published; the walk reads
   * GitHub's account of each commit for a tip built before the record did, or over a tip. A base
   * refresh or a branch restore is landed content and is kept.
   *
   * A commit is stepped past only when it is provably one of this item's own tips: a tip the
   * queue history recorded, or a commit GitHub attributes to the control-plane App that carries
   * the tip message. A message alone proves nothing — any worker can write it — and a commit the
   * walk stops at is kept, so its content is in every tip built from it. The walk decides what a
   * tip is built from, never what carries onto it: the carry refuses an approval that was not
   * given on the head the walk returned (see Engine.decideTipCarry).
   */
  async ownReviewedHead(work: Work, head: string): Promise<string> {
    const speculation = work.queue?.speculation;
    let sha = speculation?.tip === head ? speculation.reviewedHead ?? speculation.merge?.from ?? head : head;
    const marker = new RegExp(`^Graphyard speculative tip for ${work.key.replace(/[^A-Za-z0-9-]/g, '')} behind `, 'i');
    const recorded = new Map((work.queueHistory ?? []).filter(entry => entry.event === 'predicted' && entry.tip && entry.from && entry.from !== entry.tip).map(entry => [entry.tip!, entry.from!]));
    const login = await this.controlPlaneLogin();
    for (let hops = 0; hops < 25; hops++) {
      const from = recorded.get(sha);
      if (from) { sha = from; continue; }
      const commit = await this.request(`/commits/${sha}`);
      const first = Array.isArray(commit?.parents) ? commit.parents[0]?.sha : undefined;
      if (!marker.test(typeof commit?.commit?.message === 'string' ? commit.commit.message : '') || !appAuthored(commit, login) || typeof first !== 'string' || !/^[a-f0-9]{40}$/.test(first)) return sha;
      sha = first;
    }
    return sha;
  }
  /** Moves a pull-request branch to a commit the control plane chose; the branch is unprotected and the move is deliberate. */
  async updateBranch(branch: string, sha: string) {
    await this.request(`/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, 'PATCH', { sha, force: true });
  }
  async commitTree(sha: string): Promise<string> {
    const commit = await this.request(`/commits/${sha}`);
    const tree = commit?.commit?.tree?.sha;
    demand(typeof tree === 'string' && /^[a-f0-9]{40}$/.test(tree), `GitHub did not return a readable tree for ${sha}`, 502);
    return tree;
  }
  /** The control-plane App's own bot login, the only author a carried tip may have. */
  async controlPlaneLogin(): Promise<string> {
    if (!this.appSlug) {
      const verified = this.preflightState?.verifiedAt ? this.preflightState.app : null;
      this.appSlug = verified && verified !== String(this.config.appId) ? verified : await this.appSlugFromApi();
    }
    return `${this.appSlug}[bot]`;
  }
  private async appSlugFromApi(): Promise<string> {
    const response = await fetch('https://api.github.com/app', { headers: this.appHeaders(), signal: AbortSignal.timeout(15_000) });
    const refused = await this.refusal(response, 'GET /app');
    if (refused) throw refused;
    const app: any = await response.json();
    demand(typeof app?.slug === 'string' && /^[a-z0-9-]+$/i.test(app.slug), 'GitHub did not return the control-plane App slug', 502);
    return app.slug;
  }
  /**
   * Every path that differs between two commits, including both ends of a rename, or null when
   * the list may be truncated: a carry decided on an incomplete list would be a guess. GitHub
   * paginates the comparison's commits only; the files come on the first page alone and stop at
   * compareFileCap, so a list that reaches the cap cannot be told from a longer one and is refused.
   */
  async changedFiles(from: string, to: string): Promise<string[] | null> {
    if (from === to) return [];
    const comparison = await this.request(`/compare/${from}...${to}`);
    const files = comparison?.files;
    demand(Array.isArray(files), `GitHub did not list the files changed between ${from.slice(0, 12)} and ${to.slice(0, 12)}`, 502);
    if (files.length >= compareFileCap) return null;
    const paths = (listed: any[]) => listed.flatMap((file: any) => [file.filename, ...(typeof file.previous_filename === 'string' ? [file.previous_filename] : [])]).filter((path: unknown): path is string => typeof path === 'string');
    // A comparison lists what `to` changed against the merge base. A predicted base that moved
    // backwards or sideways — the entry between this one and its new base was ejected — has changes
    // on the `from` side too, and a tip rebuilt onto it no longer holds them; both sides are listed.
    if (comparison.status === 'behind' || comparison.status === 'diverged') {
      const reverse = await this.request(`/compare/${to}...${from}`);
      demand(Array.isArray(reverse?.files), `GitHub did not list the files changed between ${to.slice(0, 12)} and ${from.slice(0, 12)}`, 502);
      if (reverse.files.length >= compareFileCap) return null;
      return [...new Set([...paths(files), ...paths(reverse.files)])];
    }
    return [...new Set(paths(files))];
  }
  /** How GitHub describes the tip Graphyard's merge produced: parents, author, and whether the author is this App. */
  private async describeMerge(from: string, tip: string, boundBase: string, predictedBase: string): Promise<TipMerge> {
    const commit = await this.request(`/commits/${tip}`);
    const parents = Array.isArray(commit?.parents) ? commit.parents.map((parent: any) => parent?.sha).filter((sha: unknown) => typeof sha === 'string') : [];
    const author = typeof commit?.author?.login === 'string' ? commit.author.login : null;
    const email = typeof commit?.commit?.author?.email === 'string' ? commit.commit.author.email : '';
    const authoredByApp = appAuthored(commit, await this.controlPlaneLogin());
    // The provider merge never resolves a conflict: a conflicting merge is refused with 409 and
    // ejects the entry (see mergeBranch), so a tip that exists was produced without one.
    return { from, parents, author: author ?? (email || null), authoredByApp, conflicts: false, baseChanges: await this.changedFiles(boundBase, predictedBase) };
  }
  /** Returns the new head, or null when the branch already contains the merged commit. */
  async mergeBranch(branch: string, head: string, message: string): Promise<string | null> {
    let result: any;
    try { result = await this.request('/merges', 'POST', { base: branch, head, commit_message: message }); }
    catch (error) {
      if (error instanceof Refusal && /\(409\)/.test(error.message)) throw new SpeculativeConflict(`Speculative merge of ${head.slice(0, 12)} into ${branch} conflicts and cannot be resolved by Graphyard`);
      throw error;
    }
    if (result === null) return null;
    demand(typeof result?.sha === 'string' && /^[a-f0-9]{40}$/.test(result.sha), 'GitHub returned an invalid speculative merge commit', 502);
    return result.sha;
  }
  async publishRef(ref: string, sha: string) {
    try { await this.request(`/git/${ref}`, 'PATCH', { sha, force: true }); }
    catch (error) {
      if (!(error instanceof Refusal) || !/\(404\)|\(422\)/.test(error.message)) throw error;
      await this.request('/git/refs', 'POST', { ref, sha });
    }
  }
  /**
   * Builds the commit the queued candidate will actually land: the predicted base (the base
   * branch plus every entry ahead of it) with this candidate merged in. The result is published
   * under a Graphyard-owned ref and pushed onto the candidate branch, so the PR head, the
   * required checks, the review, and every proof all bind to that one exact commit.
   *
   * Every tip is built from the item's own reviewed head, never from the tip it replaces (GY-127).
   * A tip merged over an earlier tip kept that tip's predecessor in the branch history for good:
   * when the predecessor was ejected, or this entry was, the branch went on carrying commits of an
   * item that had not landed, and no head the worker could push would pass. So a branch whose
   * head is a tip is first moved back to the reviewed head under it, and the predicted base is
   * merged onto that; the tip's parents are exactly the reviewed head and its predicted base, which
   * is also what lets the carry rule in model/carry.ts accept it.
   *
   * A published tip is never republished onto a predicted base whose tree it already lands
   * (GY-100). A tip push replaces the head, so GitHub dismisses its approval and withdraws every
   * verdict bound to it; when the predicted base moved only to a tree-identical commit — an entry
   * ahead republishing its own tip, a queue merge on the base branch — the merge would produce
   * the same tree under a new sha and cost a review round for content nobody changed. The advance
   * is recorded on the speculation instead (`carriedBase`, as the control plane already records a
   * tree-identical base-branch advance) and nothing is written: `predictQueue` binds the tip to
   * that prediction, and the approval, the proofs and the checks stand on the commit they were
   * given for.
   */
  async publishSpeculativeTip(work: Work, placement: QueuePlacement, beforeWrite: () => Promise<void> = async () => {}): Promise<QueueSpeculation> {
    demand(work.candidate && work.queue && placement.predictedBase, 'A queued candidate with a predicted base is required');
    const pr = await this.request(`/pulls/${work.candidate!.pr}`);
    requireCurrent(pr.head.sha === work.candidate!.sha && pr.base.ref === this.config.base && pr.state === 'open' && pr.draft === false,
      'Pull request changed before speculative prediction; retry');
    // A speculative tip always contains the real base tip: the chain of predictions rests on the
    // base-branch commit the observation saw, and the branch must still be that commit or a
    // tree-identical advance of it (an earlier queue merge) when the tip is built.
    const branch = await this.baseBranch();
    requireCurrent(!!placement.base && (branch.tip === placement.base.sha || branch.tree === placement.base.tree), `Base branch ${this.config.base} moved before speculative prediction; retry`);
    const baseTree = await this.commitTree(placement.predictedBase!);
    const ref = queueRef(work.key);
    // Re-binding a published tip to a tree-identical prediction: recorded, never republished.
    const rebound = treeIdenticalPrediction(work, placement.predictedBase!, baseTree);
    // The re-bound record keeps its carry (see keptTipCarry) and names the entries now ahead of it.
    if (rebound) return { ...rebound, ...(rebound.tipTree ? {} : { tipTree: await this.tipTree(rebound.tip) }), predecessors: placement.predecessors,
      carriedBase: { sha: placement.predictedBase!, tree: baseTree, at: new Date().toISOString() } };
    const reviewedHead = await this.ownReviewedHead(work, pr.head.sha);
    await beforeWrite();
    // The branch is moved by a forced ref update after the head was read above, not compared and
    // swapped in one request. A worker push landing in that window is overwritten; the window is
    // one request wide, the item is queued (a worker push at that point is a new head the queue
    // would eject for anyway), and the next observation reads the branch afresh, so the worker's
    // head is at worst reported as replaced rather than silently kept. Narrow, and accepted.
    if (reviewedHead !== pr.head.sha) await this.updateBranch(pr.head.ref, reviewedHead);
    const merged = await this.mergeBranch(pr.head.ref, placement.predictedBase!, `Graphyard speculative tip for ${work.key} behind ${placement.predecessors.join(', ') || this.config.base}`);
    const tip = merged ?? reviewedHead;
    await this.publishRef(ref, tip);
    // What the merge produced is recorded with the tip, so the binding carry (see model/carry.ts)
    // is decided on GitHub's own account of the commit, never on the fact that a merge was asked for.
    const merge = merged ? await this.describeMerge(reviewedHead, merged, work.candidate!.baseSha, placement.predictedBase!) : null;
    // A reviewed head that already contains its new predicted base is the tip itself, replacing
    // an earlier tip with no commit produced: the carry is then decided on the files that changed
    // between the replaced tip's bound base and the predicted base, listed here from GitHub.
    const baseChanges = merged || tip === work.candidate!.sha ? undefined : await this.changedFiles(work.candidate!.baseSha, placement.predictedBase!);
    return { ref, tip, tipTree: await this.tipTree(tip), base: placement.predictedBase!, baseTree, predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date().toISOString(), merge, reviewedHead,
      ...(baseChanges !== undefined ? { baseChanges } : {}) };
  }
  /**
   * Restores a pull-request branch that carries another item's unlanded commits (GY-127): moves it
   * back to the item's own reviewed head, then merges the base branch onto it exactly as a base
   * refresh does. The ejection of a queued tip runs this on its own; the coordinator requests it
   * for a branch found contaminated any other way. No worker pushes for it and nobody opens a
   * shell: the control-plane App moves the branch, and the record says what it did and why.
   */
  async restoreBranch(work: Work, restore: { contaminated: string; foreign: string[]; own: string | null; cause: BranchRestore['cause']; requested: BranchRestore['requested']; reason: string }, beforeWrite: () => Promise<void> = async () => {}): Promise<BaseRefresh> {
    const candidate = work.candidate;
    demand(candidate && !work.queue && restore.contaminated === candidate.sha, 'An unqueued candidate whose head is the contaminated one is required');
    const pr = await this.request(`/pulls/${candidate!.pr}`);
    requireCurrent(pr.head.sha === candidate!.sha && pr.base.ref === this.config.base && pr.state === 'open' && pr.draft === false, 'Pull request changed before the branch restore; retry');
    const branch = await this.baseBranch();
    const at = new Date().toISOString();
    const own = restore.own ?? await this.ownReviewedHead(work, pr.head.sha);
    const record = (fields: Partial<BaseRefresh>, outcome: BranchRestore['outcome'], own: string | null): BaseRefresh => ({
      from: { sha: own ?? candidate!.sha, baseSha: candidate!.baseSha }, base: branch.tip, baseTree: branch.tree, policyRevision: work.policyRevision, at,
      head: own ?? candidate!.sha, conflict: null, merge: null, carry: null, ...fields, restore: { ...restore, own, performedAt: at, outcome } });
    // A head that is not a tip of this item's own has the foreign commits under something a worker
    // pushed, or under nothing the record can name: nothing is moved, and the item says so.
    if (own === pr.head.sha) return record({}, 'unrepairable', null);
    await beforeWrite();
    // The same one-request window as in publishSpeculativeTip: a worker push between the head
    // check above and this forced update is overwritten by the restore. The head being restored
    // is one no worker may push over (a contaminated tip), the record names the head it moved
    // from, and the next observation reads the branch afresh.
    await this.updateBranch(pr.head.ref, own);
    let merged: string | null;
    try { merged = await this.mergeBranch(pr.head.ref, branch.tip, `Graphyard branch restore for ${work.key} onto ${this.config.base}`); }
    catch (error) {
      if (!(error instanceof SpeculativeConflict)) throw error;
      return record({ conflict: `Candidate ${candidate!.sha.slice(0, 12)} was restored to its own reviewed head ${own.slice(0, 12)}, which cannot be brought onto base branch tip ${branch.tip.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved: ${error.message}. Run graphyard sync ${work.key}, resolve it and push.` }, 'conflict', own);
    }
    return record({ head: merged ?? own, merge: merged ? await this.describeMerge(own, merged, own, branch.tip) : null }, 'restored', own);
  }
  /**
   * Brings one in-flight candidate onto a base branch that moved under it, without a rework round.
   *
   * Graphyard merges the new base into the candidate's own pull-request branch — the same
   * conflict-free provider merge the merge queue uses for a speculative tip — so the head, the
   * required checks, the review and every proof end up bound to one commit that already contains
   * the tip. What the merge produced is recorded from GitHub's own account of it, never from the
   * fact that a merge was asked for, and the binding carry is decided from that (see
   * model/carry.ts). A conflict writes nothing: the refusal names it and the candidate goes back
   * to the worker, exactly as a stale candidate always did.
   */
  async refreshCandidateBase(work: Work, beforeWrite: () => Promise<void> = async () => {}): Promise<BaseRefresh> {
    const candidate = work.candidate;
    demand(candidate && work.observation?.baseTip && !work.queue, 'An unqueued candidate observed behind the base branch is required');
    const pr = await this.request(`/pulls/${candidate!.pr}`);
    requireCurrent(pr.head.sha === candidate!.sha && pr.base.ref === this.config.base && pr.state === 'open' && pr.draft === false,
      'Pull request changed before the base refresh; retry');
    const branch = await this.baseBranch();
    requireCurrent(branch.tip === work.observation!.baseTip, `Base branch ${this.config.base} moved before the base refresh; retry`);
    const from = { sha: candidate!.sha, baseSha: candidate!.baseSha };
    const record = (fields: Partial<BaseRefresh>): BaseRefresh => ({ from, base: branch.tip, baseTree: branch.tree,
      policyRevision: work.policyRevision, at: new Date().toISOString(), head: null, conflict: null, merge: null, carry: null, ...fields });
    await beforeWrite();
    let merged: string | null;
    try { merged = await this.mergeBranch(pr.head.ref, branch.tip, `Graphyard base refresh for ${work.key} onto ${this.config.base}`); }
    catch (error) {
      if (!(error instanceof SpeculativeConflict)) throw error;
      return record({ conflict: `Candidate ${candidate!.sha.slice(0, 12)} cannot be brought onto base branch tip ${branch.tip.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved: ${error.message}. Run graphyard sync ${work.key}, resolve it and push; the approval and proofs bound to ${candidate!.sha.slice(0, 12)} do not survive the resolution.` });
    }
    // GitHub reports the branch already up to date as no merge at all. Nothing was republished, so
    // nothing is carried: the candidate rebinds to the live head on the next observation.
    if (!merged) return record({ head: candidate!.sha });
    return record({ head: merged, merge: await this.describeMerge(candidate!.sha, merged, candidate!.baseSha, branch.tip) });
  }
  async publish(work: Work, forcedReason?: string, beforeWrite: () => Promise<void> = async () => {}) {
    if (!work.candidate) return;
    const reasons = [...work.gates.flatMap(g => g.reasons), ...work.violations, ...(forcedReason ? [forcedReason] : [])];
    const existing = (await this.pages(`/commits/${work.candidate.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`, 'check_runs')).find(c => c.app.id === this.config.appId);
    const body = { name: CHECK_NAME, head_sha: work.candidate.sha, status: 'completed', conclusion: reasons.length ? 'failure' : 'success', external_id: work.id,
      output: { title: reasons.length ? 'REFUSED' : 'All required gates passed', summary: (reasons.length ? reasons.map(r => `- ${r}`).join('\n') : `Candidate ${work.candidate.sha}; base ${work.candidate.baseSha}; policy ${work.policyRevision}`).slice(0, 60000) } };
    const pr = await this.request(`/pulls/${work.candidate.pr}`);
    if (!reasons.length || !forcedReason) requireCurrent(pr.head.sha === work.candidate.sha && this.boundBase(work, pr, await this.baseBranch()) === work.candidate.baseSha, 'PR changed before check publication; retry');
    if (!reasons.length) requireCurrent(pr.state === 'open' && !pr.draft && pr.base.ref === this.config.base, 'PR is closed, draft, or retargeted; refusing success');
    await beforeWrite();
    if (existing?.status === body.status && existing.conclusion === body.conclusion && existing.external_id === body.external_id
      && existing.output?.title === body.output.title && existing.output?.summary === body.output.summary) return;
    await this.request(existing ? `/check-runs/${existing.id}` : '/check-runs', existing ? 'PATCH' : 'POST', body);
  }
}
/** Whether GitHub attributes a commit to the control-plane App's bot account: by the linked author, or by the App's noreply address. */
function appAuthored(commit: any, login: string): boolean {
  const author = typeof commit?.author?.login === 'string' ? commit.author.login : null;
  const email = typeof commit?.commit?.author?.email === 'string' ? commit.commit.author.email : '';
  return author !== null ? author.toLowerCase() === login.toLowerCase() && commit.author?.type === 'Bot'
    : new RegExp(`^\\d+\\+${login.replace(/[[\]]/g, '\\$&')}@users\\.noreply\\.github\\.com$`, 'i').test(email);
}
export async function githubFromEnv() {
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_REPOSITORY) return null;
  const privateKey = process.env.GITHUB_PRIVATE_KEY ?? await readFile(process.env.GITHUB_PRIVATE_KEY_FILE!, 'utf8');
  const reviewerApps = parseReviewerApps(process.env.GRAPHYARD_REVIEWER_APPS);
  return new GitHub({ repository: process.env.GITHUB_REPOSITORY, base: process.env.GITHUB_BASE_BRANCH ?? 'main', appId: Number(process.env.GITHUB_APP_ID), installationId: Number(process.env.GITHUB_INSTALLATION_ID), privateKey, reviewerApps });
}
/**
 * Moves one queued candidate onto the tip it is predicted to land. Entries publish head-first:
 * an entry with no predicted base yet simply waits for the one ahead of it to settle.
 */
async function advanceQueue(engine: Engine, github: GitHub, work: Work, job: { work_id: string; token: string }, guard: (snapshot: Work, success: boolean) => () => Promise<void>, hold: (feature: PermissionFeature) => string | null) {
  const all = await engine.store.list();
  const placement = queuePlacement(work, all.map(item => item.id === work.id ? work : item), Date.now());
  if (!placement || placement.current || !placement.publishable) return { work, published: false, held: null };
  // Publishing a tip writes a merge commit and a ref; without Contents: write the call can
  // only 403. The entry keeps its place and waits for the permission instead of retrying.
  const held = hold('merge-queue');
  if (held) return { work, published: false, held };
  try {
    const speculation = await github.publishSpeculativeTip(work, placement, guard(work, false));
    return { work: await engine.bindSpeculativeTip(work.id, work.revision, speculation, job.token), published: true, held: null };
  } catch (error) {
    if (!(error instanceof SpeculativeConflict)) throw error;
    return { work: await engine.ejectFromQueue(work.id, work.revision, error.message, job.token), published: false, held: null };
  }
}
/**
 * Brings one in-flight candidate onto the base branch tip it no longer contains. The queue owns
 * its own entries, so this is every other submitted candidate: the merge, the record of what it
 * produced, and the binding carry are all the control plane's, and no worker is asked for a round.
 */
async function refreshBase(engine: Engine, github: GitHub, work: Work, job: { work_id: string; token: string }, guard: (snapshot: Work, success: boolean) => () => Promise<void>, hold: (feature: PermissionFeature) => string | null) {
  // The refresh writes a merge commit onto the candidate's branch; without Contents: write the
  // call can only 403. The candidate keeps its held base and waits for the permission instead.
  const held = hold('merge-queue');
  if (held) return { work, published: false, held };
  const refresh = await github.refreshCandidateBase(work, guard(work, false));
  const updated = await engine.bindBaseRefresh(work.id, work.revision, refresh, job.token);
  return { work: updated, published: !!refresh.head && refresh.head !== refresh.from.sha, held: null };
}
/**
 * Restores one branch found carrying another item's unlanded commits, and records what the restore
 * did. The record's own answer decides the restore an ejection owes; a repair the coordinator
 * requested is already on the record and is run from it.
 */
async function restoreBranch(engine: Engine, github: GitHub, work: Work, owed: BranchRestore | ReturnType<typeof ejectedTipRestore>, job: { work_id: string; token: string }, guard: (snapshot: Work, success: boolean) => () => Promise<void>, hold: (feature: PermissionFeature) => string | null) {
  const held = hold('merge-queue');
  if (held) return { work, published: false, held };
  const request = 'cause' in owed! ? owed : { ...owed!, cause: 'ejection' as const, requested: null };
  const refresh = await github.restoreBranch(work, { contaminated: request.contaminated, foreign: request.foreign, own: request.own, cause: request.cause, requested: request.requested, reason: request.reason }, guard(work, false));
  const updated = await engine.bindBranchRestore(work.id, work.revision, refresh, job.token);
  return { work: updated, published: refresh.head !== null && refresh.head !== request.contaminated, held: null };
}
/** A held job waits this long before one bounded re-check, unless a preflight sees the installation change first. */
export const permissionHoldMs = 30 * 60_000;
/**
 * Conditional-request cache size. One observation round reads roughly ten paths per open PR; a cache
 * smaller than a round evicts every entry before its reuse, so no request earns a free 304.
 */
export const etagCacheEntries = 4096;
/** Commit-pair ancestry answers kept; each is immutable, so the bound only limits memory. */
export const ancestryEntries = 16384;
/** Peer containment compares one observation keeps in flight. */
export const peerContainmentConcurrency = 8;
async function boundedMap<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]); }
  }));
  return results;
}
/** Seconds between observations: a merge-stage candidate needs a fresh one to merge; webhooks wake the rest on change. */
export const mergeObservationSeconds = 20;
export const idleObservationSeconds = 90;
/** Consecutive permission refusals a job may retry at the normal cadence before it is held. */
export const permissionRefusalLimit = 3;
export async function processJob(engine: Engine, github: GitHub) {
  const job = await engine.store.takeJob();
  if (!job) return;
  let work: Work | undefined;
  const guard = (snapshot: Work, success: boolean) => async () => {
    const result = await engine.store.pool.query(`SELECT w.document,clock_timestamp() AS now FROM work_items w JOIN jobs j ON j.work_id=w.id
      WHERE w.id=$1 AND j.token=$2 AND j.locked_until>clock_timestamp()`, [job.work_id, job.token]);
    const row = result.rows[0];
    requireCurrent(row && row.document.revision === snapshot.revision, 'Work or job ownership changed before publication; retry');
    if (success) requireCurrent(snapshot.observation && row.now.getTime() - Date.parse(snapshot.observation.at) < 120_000, 'Observation expired before publication; retry');
  };
  // A feature whose permission the last preflight found missing is not attempted: the job is
  // held with the operator-facing reason instead of retrying into a 403. Adapters without a
  // preflight (test doubles) hold nothing.
  const hold = (feature: PermissionFeature) => github.permissionShortfall?.(feature) ?? null;
  // Every hold records the installation it was decided against, so a later preflight releases
  // it only when the installation actually changed (see Store.releaseHeldJobs).
  const heldOn = () => installationFingerprint(github.permissionReport?.() ?? null);
  let held: string | null = null;
  try {
    const all = await engine.store.list();
    work = all.find(w => w.id === job.work_id);
    if (work?.submission && work.stage !== 'done') {
      held = hold('observation');
      if (held) { await engine.store.holdJob(job.work_id, job.token, held, permissionHoldMs, heldOn()); return; }
      const observation = await github.observe(work, all);
      work = await engine.observe(work.id, work.revision, observation, job.token);
      // A branch carrying another item's unlanded commits is restored by the control plane (GY-127):
      // on its own for a tip the queue ejected, on the coordinator's request otherwise. The restored
      // head is a new candidate, so the job requeues onto it before anything else is dispatched.
      const owed = pendingRestore(work) ?? ejectedTipRestore(work, all);
      if (owed) {
        const restored = await restoreBranch(engine, github, work, owed, job, guard, hold);
        work = restored.work; held ??= restored.held;
        if (restored.published) { await engine.store.finishJob(job.work_id, job.token, undefined, true); return; }
      }
      // A base branch that moved under this candidate is Graphyard's to absorb, not the worker's.
      // The republished head is what the review, the checks and the proofs then bind to, so the
      // refresh runs before any review is dispatched and the job requeues onto the new head.
      if (baseRefreshNeeded(work)) {
        const refreshed = await refreshBase(engine, github, work, job, guard, hold);
        work = refreshed.work; held ??= refreshed.held;
        if (refreshed.published) { await engine.store.finishJob(job.work_id, job.token, undefined, true); return; }
      }
      const provider = reviewProviderOf(work.policy);
      // A head that does not contain the base tip is not reviewed: the request is deferred, and
      // diagnose reports why, until the refresh above republishes it, the queue publishes a tip
      // that contains it, or — when the merge conflicts — the worker resolves it and pushes.
      const dispatchable = !observation.merged && observation.prState === 'open' && observation.draft === false && work.policy.review && observation.baseTipContained !== false;
      // A request binds the exact candidate; an approval Graphyard carried onto its own authored
      // tip already stands for that candidate, so no new request is dispatched for it.
      const unbound = (item: Work, profile?: string) => !carriedApproval(item) && (!item.reviewRequest || item.reviewRequest.sha !== item.candidate?.sha
        || item.reviewRequest.baseSha !== item.candidate?.baseSha || item.reviewRequest.policyRevision !== item.policyRevision
        || profile !== undefined && item.reviewRequest.profile !== profile);
      if (dispatchable && provider === 'codex' && unbound(work)) {
        held ??= hold('review-dispatch');
        if (!held) {
          const request = await github.requestCodex(work, guard(work, false));
          work = await engine.bindReviewRequest(work.id, work.revision, request, job.token);
        }
      }
      if (dispatchable && provider === 'agent') {
        let current: Work = work;
        const review = current.observation?.agentReview;
        // Exhaustion of the dispatched profile releases the request so the next profile is selected.
        if (review?.exhausted && review.exhaustion && !unbound(current, review.profile) && review.sha === current.candidate?.sha) {
          current = await engine.failoverReviewRequest(current.id, current.revision, { exhaustion: review.exhaustion, reason: review.reason }, job.token);
        }
        const profile = reviewerProfileFor(current);
        const app = github.reviewerAppFor(profile);
        if (profile && app && unbound(current, profile.name)) {
          held ??= hold('review-dispatch');
          if (!held) {
            const request = await github.requestAgentReview(current, profile, app, guard(current, false));
            current = await engine.bindReviewRequest(current.id, current.revision, request, job.token);
          }
        }
        work = current;
      }
      if (!observation.merged && observation.prState === 'open' && observation.draft === false) {
        const advanced = await advanceQueue(engine, github, work, job, guard, hold);
        work = advanced.work; held ??= advanced.held;
        // A freshly published tip replaces the PR head; the next observation binds the gates to it.
        if (advanced.published) { await engine.store.finishJob(job.work_id, job.token, undefined, true); return; }
      }
      if (!observation.merged) {
        const unpublishable = hold('check');
        if (unpublishable) held ??= unpublishable;
        else await github.publish(work, undefined, guard(work, work.gates.every(g => g.passed) && !work.violations.length));
      }
    }
    if (work?.stage === 'done') await engine.store.pool.query('DELETE FROM jobs WHERE work_id=$1 AND token=$2', [job.work_id, job.token]);
    if (held) await engine.store.holdJob(job.work_id, job.token, held, permissionHoldMs, heldOn());
    else await engine.store.finishJob(job.work_id, job.token, undefined, false, work?.stage === 'merge' ? mergeObservationSeconds : idleObservationSeconds);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GitHub reconciliation failed';
    const current = (await engine.store.pool.query('SELECT document,clock_timestamp() AS now FROM work_items WHERE id=$1', [job.work_id])).rows[0];
    const latest = current?.document as Work | undefined;
    const execution = latest?.mergeExecution;
    const executionActive = !!execution && Date.parse(execution.expiresAt) > current.now.getTime();
    if (execution && (executionActive || error instanceof MergeExecutionInProgress)) {
      await engine.store.deferJob(job.work_id, job.token, execution.expiresAt); return;
    }
    if (latest?.candidate && latest.stage !== 'done' && !hold('check')) try { await github.publish(latest, 'Reconciliation failed; fresh verification required', guard(latest, false)); } catch { /* Durable retry follows. */ }
    // A permission refusal is not transient: after a bounded number of ordinary retries the
    // job is held with the reason, and the next preflight either confirms the shortfall or
    // releases it once the installation changed. A refusal the declaration does not explain
    // (the preflight already passes) therefore stays held for the bounded hold, one attempt
    // per hold, instead of being released into the same 403 by every passing preflight.
    if (error instanceof GitHubPermissionRefusal) { await engine.store.refuseJob(job.work_id, job.token, message, permissionRefusalLimit, permissionHoldMs, heldOn()); return; }
    await engine.store.finishJob(job.work_id, job.token, error instanceof ReconciliationRetry ? undefined : message, error instanceof ReconciliationRetry);
  }
}
