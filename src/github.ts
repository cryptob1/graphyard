import { MergeExecutionInProgress, ReconciliationRetry, Refusal, SpeculativeConflict, requireCurrent } from './model.js';
import { createSign, randomUUID } from 'node:crypto';
import { observeCodex } from './codex-review.js';
import { observeAgentReview } from './agent-review.js';
import { readFile } from 'node:fs/promises';
import type { Engine } from './engine.js';
import { CHECK_NAME, demand, nativeReviewRequired, parseReviewerApps, reviewerProfileFor, reviewProviderOf, type Observation, type ReviewerApp, type ReviewerProfile, type ScopeFile, type Work, type ReviewRequest } from './model.js';
import { inPlannedScope } from './regression-guard.js';
export { CHECK_NAME };
import { queuePlacement, queueRef, type QueuePlacement, type QueueSpeculation } from './merge-queue.js';
import { blockedFeatures, controlPlanePermissions, describeShortfall, permissionShortfalls, requiredPermissions, type PermissionFeature, type PermissionLevel, type PermissionShortfall } from './github-permissions.js';

/** Out-of-scope paths compared against the base tip per observation; the rest are refused as uncompared. */
export const scopeLookupBudget = 200;
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
  private preflightState: AppPermissionReport | null = null;
  private preflightDueAt = 0;
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
    if (response.status === 304 && cached) { this.rateFailures = 0; return structuredClone(cached.value); }
    const refused = await this.refusal(response, `${method} ${path}`);
    if (refused) throw refused;
    this.rateFailures = 0;
    const value = response.status === 204 ? null : await response.json();
    const etag = response.headers.get('etag');
    if (method === 'GET') {
      this.cache.delete(path);
      if (etag) {
        this.cache.set(path, { etag, value: structuredClone(value) });
        if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
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
   * The base a candidate is legitimately bound to. A published speculative tip carries the base it
   * was built on, and the managed branch advances underneath it while the entries ahead of it land,
   * so the live `pr.base.sha` is not that binding. Every other candidate binds to the live base.
   */
  private boundBase(work: Work, pr: any): string {
    const speculation = work.queue?.speculation;
    return speculation && speculation.tip === pr.head.sha && speculation.policyRevision === work.policyRevision ? speculation.base : pr.base.sha;
  }
  async observe(work: Work): Promise<Observation> {
    const startedAt = new Date().toISOString();
    const pr = await this.request(`/pulls/${work.submission!.pr}`);
    demand(pr.base.repo.full_name.toLowerCase() === this.config.repository.toLowerCase() && pr.head.repo?.full_name.toLowerCase() === this.config.repository.toLowerCase(), 'MVP requires same-repository pull requests');
    demand(pr.base.ref === this.config.base, 'Pull request targets an unmanaged branch');
    const [checks, reviews, protectedBranch, files] = await Promise.all([
      this.pages(`/commits/${pr.head.sha}/check-runs?filter=all`, 'check_runs'), this.pages(`/pulls/${pr.number}/reviews`), this.protection(nativeReviewRequired(work.policy)), this.pages(`/pulls/${pr.number}/files`),
    ]);
    const latest = new Map<string, any>();
    for (const r of reviews) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user.login, r);
    // A published speculative tip carries its own validated base. The candidate stays bound to
    // that exact commit while the managed branch advances underneath it through queue merges.
    const bound = this.boundBase(work, pr);
    // Out-of-scope files are compared with the bound base: the predicted base already contains
    // every queued predecessor, so their changes on a speculative tip are not this candidate's.
    const scopeFiles = await this.compareScope(work.plannedFiles ?? [], files, bound);
    const candidateBase = pr.merged && work.candidate && work.candidate.sha === pr.head.sha ? work.candidate.baseSha : bound;
    const baseTree = bound !== pr.base.sha ? await this.commitTree(pr.base.sha) : undefined;
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
      reviews: [...latest.values()].map(r => ({ id: r.id, reviewer: r.user.login, sha: r.commit_id, state: r.state, submittedAt: r.submitted_at })),
      prState: pr.state, draft: pr.draft, merged: pr.merged, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at, mergeable: pr.mergeable === true && !pr.draft && pr.state === 'open',
      protected: protectedBranch, files: files.map(f => f.filename), at: startedAt,
      baseTip: pr.base.sha, ...(baseTree ? { baseTree } : {}), scopeFiles,
    };
  }
  /**
   * The provider's PR diff is taken against the merge base. The regression guard needs every
   * file outside the planned scope compared with the commit the candidate is bound to (the base
   * branch tip, or the predicted base of a published speculative tip), so those paths are looked
   * up there by blob identity. Paths beyond the lookup budget stay uncompared, which the guard
   * refuses rather than passes.
   */
  private async compareScope(plannedFiles: string[], files: any[], base: string): Promise<ScopeFile[]> {
    const budget = { remaining: scopeLookupBudget };
    const lookup = async (path: string) => budget.remaining-- > 0 ? this.blobAt(path, base) : undefined;
    const compared: ScopeFile[] = [];
    for (const file of files) {
      const status: ScopeFile['status'] = ['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'].includes(file.status) ? file.status : 'modified';
      const previousPath = typeof file.previous_filename === 'string' && file.previous_filename !== file.filename ? file.previous_filename : undefined;
      const entry: ScopeFile = { path: file.filename, status, ...(previousPath ? { previousPath } : {}),
        sha: status !== 'removed' && typeof file.sha === 'string' && /^[a-f0-9]{40}$/.test(file.sha) ? file.sha : null,
        additions: Number.isSafeInteger(file.additions) ? file.additions : 0, deletions: Number.isSafeInteger(file.deletions) ? file.deletions : 0, binary: typeof file.patch !== 'string' };
      if (!inPlannedScope(plannedFiles, entry.path)) { const baseSha = await lookup(entry.path); if (baseSha !== undefined) entry.baseSha = baseSha; }
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
  async verify(work: Work): Promise<Observation> {
    const first = await this.observe(work);
    const second = await this.observe(work);
    const gates = (o: Observation) => JSON.stringify({ candidate: o.candidate, checks: o.checks, reviews: o.reviews, agentReview: o.agentReview, protected: o.protected, merged: o.merged, mergeable: o.mergeable, prState: o.prState, draft: o.draft, scopeFiles: o.scopeFiles });
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
  async requestAgentReview(work: Work, profile: ReviewerProfile, app: ReviewerApp, beforeWrite: () => Promise<void>): Promise<ReviewRequest> {
    demand(work.candidate && work.policy.review && reviewProviderOf(work.policy) === 'agent', 'Candidate with agent review policy required');
    demand(app.id === profile.reviewerApp && app.runtime === profile.runtime, 'Reviewer profile does not match its registered App identity');
    demand(app.appId !== this.config.appId, 'The Graphyard control-plane App cannot be dispatched as a reviewer');
    demand((work.policy.reviewerProfiles ?? []).some(configured => configured.name === profile.name && configured.reviewerApp === profile.reviewerApp), 'Reviewer profile is not configured on this policy');
    const pr = await this.request(`/pulls/${work.candidate.pr}`);
    requireCurrent(pr.head.sha === work.candidate.sha && this.boundBase(work, pr) === work.candidate.baseSha && pr.state === 'open' && pr.draft === false, 'PR changed before review dispatch; retry');
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
    const pr = await this.request(`/pulls/${work.candidate.pr}`);
    requireCurrent(pr.head.sha === work.candidate.sha && this.boundBase(work, pr) === work.candidate.baseSha && pr.state === 'open' && pr.draft === false, 'PR changed before review dispatch; retry');
    const body = `@codex review\n\n<!-- graphyard-review:${randomUUID()} head:${work.candidate.sha} base:${work.candidate.baseSha} policy:${work.policyRevision} -->`;
    await beforeWrite();
    const comment = await this.request(`/issues/${work.candidate.pr}/comments`, 'POST', { body });
    demand(comment.performed_via_github_app?.id === this.config.appId && comment.user?.type === 'Bot' && comment.body === body && Number.isSafeInteger(comment.id) && Number.isFinite(Date.parse(comment.created_at)), 'Review dispatch did not return an authenticated Graphyard comment', 502);
    return { commentId: comment.id, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision, body, createdAt: comment.created_at };
  }
  async commitTree(sha: string): Promise<string> {
    const commit = await this.request(`/commits/${sha}`);
    const tree = commit?.commit?.tree?.sha;
    demand(typeof tree === 'string' && /^[a-f0-9]{40}$/.test(tree), `GitHub did not return a readable tree for ${sha}`, 502);
    return tree;
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
   */
  async publishSpeculativeTip(work: Work, placement: QueuePlacement, beforeWrite: () => Promise<void> = async () => {}): Promise<QueueSpeculation> {
    demand(work.candidate && work.queue && placement.predictedBase, 'A queued candidate with a predicted base is required');
    const pr = await this.request(`/pulls/${work.candidate!.pr}`);
    requireCurrent(pr.head.sha === work.candidate!.sha && pr.base.ref === this.config.base && pr.state === 'open' && pr.draft === false,
      'Pull request changed before speculative prediction; retry');
    const baseTree = await this.commitTree(placement.predictedBase!);
    await beforeWrite();
    const merged = await this.mergeBranch(pr.head.ref, placement.predictedBase!, `Graphyard speculative tip for ${work.key} behind ${placement.predecessors.join(', ') || this.config.base}`);
    const tip = merged ?? pr.head.sha;
    const ref = queueRef(work.key);
    await this.publishRef(ref, tip);
    return { ref, tip, base: placement.predictedBase!, baseTree, predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date().toISOString() };
  }
  async publish(work: Work, forcedReason?: string, beforeWrite: () => Promise<void> = async () => {}) {
    if (!work.candidate) return;
    const reasons = [...work.gates.flatMap(g => g.reasons), ...work.violations, ...(forcedReason ? [forcedReason] : [])];
    const existing = (await this.pages(`/commits/${work.candidate.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`, 'check_runs')).find(c => c.app.id === this.config.appId);
    const body = { name: CHECK_NAME, head_sha: work.candidate.sha, status: 'completed', conclusion: reasons.length ? 'failure' : 'success', external_id: work.id,
      output: { title: reasons.length ? 'REFUSED' : 'All required gates passed', summary: (reasons.length ? reasons.map(r => `- ${r}`).join('\n') : `Candidate ${work.candidate.sha}; base ${work.candidate.baseSha}; policy ${work.policyRevision}`).slice(0, 60000) } };
    const pr = await this.request(`/pulls/${work.candidate.pr}`);
    if (!reasons.length || !forcedReason) requireCurrent(pr.head.sha === work.candidate.sha && this.boundBase(work, pr) === work.candidate.baseSha, 'PR changed before check publication; retry');
    if (!reasons.length) requireCurrent(pr.state === 'open' && !pr.draft && pr.base.ref === this.config.base, 'PR is closed, draft, or retargeted; refusing success');
    await beforeWrite();
    if (existing?.status === body.status && existing.conclusion === body.conclusion && existing.external_id === body.external_id
      && existing.output?.title === body.output.title && existing.output?.summary === body.output.summary) return;
    await this.request(existing ? `/check-runs/${existing.id}` : '/check-runs', existing ? 'PATCH' : 'POST', body);
  }
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
/** A held job waits this long before one bounded re-check, unless a preflight sees the installation change first. */
export const permissionHoldMs = 30 * 60_000;
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
    work = (await engine.store.list()).find(w => w.id === job.work_id);
    if (work?.submission && work.stage !== 'done') {
      held = hold('observation');
      if (held) { await engine.store.holdJob(job.work_id, job.token, held, permissionHoldMs, heldOn()); return; }
      const observation = await github.observe(work);
      work = await engine.observe(work.id, work.revision, observation, job.token);
      const provider = reviewProviderOf(work.policy);
      const dispatchable = !observation.merged && observation.prState === 'open' && observation.draft === false && work.policy.review;
      const unbound = (item: Work, profile?: string) => !item.reviewRequest || item.reviewRequest.sha !== item.candidate?.sha
        || item.reviewRequest.baseSha !== item.candidate?.baseSha || item.reviewRequest.policyRevision !== item.policyRevision
        || profile !== undefined && item.reviewRequest.profile !== profile;
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
    else await engine.store.finishJob(job.work_id, job.token);
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
