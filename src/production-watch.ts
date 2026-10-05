import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Work } from './model.js';
import type { BuildIdentity } from './protocol-version.js';

/**
 * Production deployment observation for the managed base branch.
 *
 * Graphyard marks work Done when it observes the merge; whether the merged commit ever
 * reached production is a separate fact that nothing used to record. The watch polls the
 * hosting provider's deployment list for the linked service after every merge, compares
 * what production serves with what the base branch holds, and records a failed or missing
 * deployment of a merged commit as a delivery incident in the append-only ledger within the
 * grace period. It is an observation, never a gate: a lagging or failed rollout stays
 * visible as lag until the provider serves the merge, at which point the incident is
 * recorded as recovered. Nothing here rewrites a delivery snapshot.
 *
 * When production tracks a release branch (`release/production`, moved only by `graphyard release
 * promote`; docs/delivery.md#release-candidates) the watch is measured against that branch, never
 * main (GY-1207): a merge no promoted release contains yet is pipeline lag, pending and never an
 * incident, and only a promoted release production has not served within the grace period is a
 * deployment fault. Without the branch, production deploys the base branch and main is the measure.
 */
export type ProviderDeploymentStatus = 'success' | 'failed' | 'crashed' | 'building' | 'deploying' | 'queued' | 'removed' | 'skipped' | 'unknown';
export interface ProviderDeployment {
  id: string; status: ProviderDeploymentStatus; providerStatus: string;
  commit: string | null; branch: string | null; createdAt: string; updatedAt: string | null; url: string | null;
}
/** One hosting provider's deployment list for the linked service, newest first. */
export interface DeploymentProvider { name: string; description: string; list(): Promise<ProviderDeployment[]> }

const railwayStatus: Record<string, ProviderDeploymentStatus> = {
  SUCCESS: 'success', SLEEPING: 'success', FAILED: 'failed', CRASHED: 'crashed',
  BUILDING: 'building', INITIALIZING: 'building', DEPLOYING: 'deploying', QUEUED: 'queued', WAITING: 'queued', NEEDS_APPROVAL: 'queued',
  REMOVED: 'removed', REMOVING: 'removed', SKIPPED: 'skipped',
};
const railwayQuery = `query graphyardDeployments($input: DeploymentListInput!, $first: Int) {
  deployments(input: $input, first: $first) { edges { node { id status createdAt updatedAt url meta } } }
}`;
/**
 * Railway's public GraphQL API for the service this control plane runs as. Railway injects
 * RAILWAY_SERVICE_ID, RAILWAY_ENVIRONMENT_ID and RAILWAY_PROJECT_ID into the container; the
 * only variable an operator adds is the token that may read the deployment list:
 * RAILWAY_API_TOKEN (an account or team token) or RAILWAY_TOKEN (a project token). Absent
 * a token the provider is not configured and the watch reads GitHub deployments instead
 * (`githubDeploymentsProvider`), or the build identity without the GitHub App.
 */
export function railwayProvider(env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): DeploymentProvider | null {
  const accountToken = env.RAILWAY_API_TOKEN?.trim(), projectToken = env.RAILWAY_TOKEN?.trim();
  const serviceId = (env.GRAPHYARD_RAILWAY_SERVICE_ID ?? env.RAILWAY_SERVICE_ID)?.trim(), environmentId = (env.GRAPHYARD_RAILWAY_ENVIRONMENT_ID ?? env.RAILWAY_ENVIRONMENT_ID)?.trim(), projectId = (env.GRAPHYARD_RAILWAY_PROJECT_ID ?? env.RAILWAY_PROJECT_ID)?.trim();
  if (!(accountToken || projectToken) || !serviceId || !environmentId) return null;
  const endpoint = env.GRAPHYARD_RAILWAY_API?.trim() || 'https://backboard.railway.com/graphql/v2';
  return {
    name: 'railway', description: `Railway service ${serviceId}, environment ${environmentId}`,
    async list() {
      const response = await fetcher(endpoint, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', ...(accountToken ? { Authorization: `Bearer ${accountToken}` } : { 'Project-Access-Token': projectToken! }) },
        body: JSON.stringify({ query: railwayQuery, variables: { input: { serviceId, environmentId, ...(projectId ? { projectId } : {}) }, first: 25 } }),
      });
      if (!response.ok) throw new Error(`Railway API answered ${response.status}`);
      const body: any = await response.json();
      if (Array.isArray(body?.errors) && body.errors.length) throw new Error(`Railway API refused the deployment list: ${body.errors[0]?.message ?? 'unknown error'}`);
      const edges = body?.data?.deployments?.edges;
      if (!Array.isArray(edges)) throw new Error('Railway API returned no deployment list');
      return edges.map(({ node }: any): ProviderDeployment => {
        const commit = typeof node?.meta?.commitHash === 'string' && /^[0-9a-f]{40}$/i.test(node.meta.commitHash) ? node.meta.commitHash.toLowerCase() : null;
        return { id: String(node?.id ?? ''), status: railwayStatus[String(node?.status)] ?? 'unknown', providerStatus: String(node?.status ?? 'UNKNOWN'), commit,
          branch: typeof node?.meta?.branch === 'string' ? node.meta.branch : null, createdAt: String(node?.createdAt ?? ''), updatedAt: typeof node?.updatedAt === 'string' ? node.updatedAt : null, url: typeof node?.url === 'string' ? node.url : null };
      }).filter((deployment: ProviderDeployment) => deployment.id);
    },
  };
}

const githubStatus: Record<string, ProviderDeploymentStatus> = {
  success: 'success', failure: 'failed', error: 'failed', in_progress: 'deploying', queued: 'queued', pending: 'queued', waiting: 'queued', inactive: 'removed',
};
/** Deployments whose latest status is read each pass; older ones keep the last status read, or are left out. */
const GITHUB_STATUS_READS = 5;
/**
 * The deployments Railway reports to GitHub for the connected repository (GY-1327): each deploy
 * is a GitHub deployment in the production environment carrying the commit sha and statuses
 * (queued, in_progress, success, failure, error, inactive), read with the control plane's GitHub
 * App credential. The fallback when no Railway token is set, since Railway issues API and project
 * tokens only from its dashboard. A concluded status (success, failure, error) is kept per
 * deployment and never read again — Railway marks a success inactive minutes later though
 * production still serves it — so a steady pass costs one listing request plus one status read
 * per deployment still in flight.
 */
export function githubDeploymentsProvider(github: { request(path: string): Promise<any>; config?: { repository?: string } }, environment = 'production'): DeploymentProvider {
  const concluded = new Map<string, { status: ProviderDeploymentStatus; providerStatus: string; url: string | null; updatedAt: string | null }>();
  return {
    name: 'github', description: `GitHub deployments to ${environment}${github.config?.repository ? ` of ${github.config.repository}` : ''}`,
    async list() {
      const listed = await github.request(`/deployments?environment=${encodeURIComponent(environment)}&per_page=10`);
      if (!Array.isArray(listed)) throw new Error('GitHub returned no deployment list');
      const deployments: ProviderDeployment[] = [];
      let reads = 0;
      for (const deployment of listed) {
        const id = String(deployment?.id ?? '');
        if (!id || deployment?.environment !== environment) continue;
        const sha = typeof deployment.sha === 'string' && /^[0-9a-f]{40}$/i.test(deployment.sha) ? deployment.sha.toLowerCase() : null;
        const ref = typeof deployment.ref === 'string' && deployment.ref.toLowerCase() !== sha ? deployment.ref : null;
        let state = concluded.get(id);
        if (!state) {
          if (reads >= GITHUB_STATUS_READS) continue;
          reads++;
          const latest = (await github.request(`/deployments/${encodeURIComponent(id)}/statuses?per_page=1`))?.[0];
          const raw = typeof latest?.state === 'string' ? latest.state : 'queued';
          state = { status: githubStatus[raw] ?? 'unknown', providerStatus: raw.toUpperCase(), url: typeof latest?.log_url === 'string' && latest.log_url ? latest.log_url : typeof latest?.target_url === 'string' && latest.target_url ? latest.target_url : null, updatedAt: typeof latest?.created_at === 'string' ? latest.created_at : null };
          if (['success', 'failure', 'error'].includes(raw)) concluded.set(id, state);
        }
        deployments.push({ id, ...state, commit: sha, branch: ref, createdAt: String(deployment.created_at ?? '') });
      }
      for (const id of concluded.keys()) if (!listed.some((deployment: any) => String(deployment?.id) === id)) concluded.delete(id);
      return deployments;
    },
  };
}

/**
 * The deployment list the watch reads: Railway's API when a Railway token is configured, else the
 * GitHub deployments Railway reports for the managed repository, read with the App credential.
 */
export function productionProvider(env: Record<string, string | undefined> = process.env, github: Parameters<typeof githubDeploymentsProvider>[0] | null = null, fetcher: typeof fetch = fetch): DeploymentProvider | null {
  return railwayProvider(env, fetcher) ?? (github ? githubDeploymentsProvider(github, env.GRAPHYARD_PRODUCTION_ENVIRONMENT?.trim() || 'production') : null);
}

/** The startup log's account of where production observation comes from. */
export function observationLine(provider: DeploymentProvider | null, build: Pick<BuildIdentity, 'commit'>) {
  return `production observation ${provider ? `via ${provider.description}` : build.commit ? 'from the build identity only; configure the GitHub App to read GitHub deployments' : 'unavailable: set GRAPHYARD_BUILD_SHA or RAILWAY_GIT_COMMIT_SHA'}`;
}

export interface ProductionIncident {
  id: string; workId: string; key: string; mergeSha: string; status: 'failed' | 'missing';
  provider: string | null; deploymentId: string | null; serving: string | null; reason: string; since: string; at: string;
}
export interface ProductionReport {
  provider: string | null; providerDescription: string | null; observedAt: string | null; error: string | null;
  /** The commit this process was built from, when the deployment says. */
  running: string | null;
  /** The commit production serves: the provider's newest successful deployment, else the running build. */
  serving: string | null; servingSource: 'provider' | 'build' | null;
  latest: ProviderDeployment | null;
  /** How far the branch production deploys (the release branch when there is one, else the base branch) is ahead of what production serves. */
  /**
   * Measured against the base branch, `unservedSince` is when the oldest delivered merge production
   * does not serve landed, and `rollingOut` says the lag is a rollout still inside its grace: every
   * unserved merge younger than the grace, or a provider attempt past serving still in flight (GY-1209).
   */
  ahead: { by: number; head: string | null; commits: { sha: string; message: string }[]; unservedSince?: string | null; rollingOut?: boolean } | null; aheadError: string | null;
  /**
   * The release branch production tracks, when the release pipeline owns production: its tip, since
   * when that tip has been observed unserved (null when production serves it), whether that is past
   * the grace period, and how many commits main holds that no promoted release does yet (pipeline lag, not a fault).
   */
  release?: ReleaseState | null;
  deployed: string[]; pending: string[];
  incidents: ProductionIncident[];
  attention: string[];
}
export interface ReleaseState { branch: string; tip: string; unservedSince: string | null; overdue: boolean; unreleased: number | null }
export const INCIDENT_EVENT = 'delivery.deployment-incident', RECOVERY_EVENT = 'delivery.deployment-recovered';
/** A delivery first observed inside the release production serves; containment is never asked again for it. */
export const CONTAINED_EVENT = 'delivery.deployment-contained';
/**
 * The deliveries known not to be in the serving release, with that release: a restart at an
 * unchanged serving SHA (a config-only restart, a failed rollout, a crash loop) restores them and
 * asks none again. A plane event (no work id), written only when the set changes.
 */
export const PENDING_EVENT = 'production.deployment-pending';
/**
 * The first observation of a release tip production tracks, with when it was made: the grace period
 * a promotion gets is measured from it, so a restart does not hand an already-overdue release a
 * fresh grace period (GY-1256). A plane event (no work id), written only when the tip moves.
 */
export const RELEASE_SEEN_EVENT = 'production.release-observed';
/** A merged commit not served within this long is a missing deployment. */
export const DEPLOYMENT_GRACE_MS = 5 * 60_000;
/** Deliveries older than this are not re-verified against the provider on every pass. */
export const DEPLOYMENT_WINDOW_MS = 14 * 86_400_000;
export const DEPLOYMENT_POLL_MS = 60_000;
/** How often the watch's own timer offers it a pass; the pass itself runs at most once per poll interval. */
export const PRODUCTION_WATCH_TIMER_MS = 5_000;

export interface ProductionWatchOptions {
  provider: DeploymentProvider | null;
  /**
   * The control plane's GitHub adapter, for containment and ahead-by; null leaves both unknown.
   * The adapter answers both with one-commit compares (`contains`, `aheadBy`); a client with only
   * `request` is asked the plain compare.
   */
  github: { request(path: string): Promise<any>; contains?(base: string, head: string): Promise<boolean>; aheadBy?(base: string, head: string): Promise<number>;
    /** The base branch's tip as the current observation cycle read it, shared with every observation; lets the watch compare exact SHAs it has already compared. */
    cycleBaseBranch?(): Promise<{ tip: string }> } | null;
  build: BuildIdentity; baseBranch: string;
  /**
   * The branch production deploys when it is not the base branch (`release/production`). Each pass
   * reads it; a repository without it is measured against the base branch as before.
   */
  releaseBranch?: string | null;
  graceMs?: number; windowMs?: number; pollMs?: number; now?: () => number;
}

export class ProductionWatch {
  private incidents = new Map<string, ProductionIncident>();
  private loaded = false; private lastPass = 0;
  /**
   * Containment is monotonic: a delivery recorded inside a serving release is deployed and is never
   * compared again (the record is in the ledger, so a restart — which every deploy is — keeps it).
   * A delivery known not to be in the serving release is not asked again until production serves
   * another commit, so an unchanged serving SHA costs no compares and a new one costs one per
   * delivery still pending. Keyed by work id.
   */
  private deployedIn = new Map<string, string>();
  private notIn = new Map<string, string>();
  /** The pending set last written to the ledger, so an unchanged one is not written again. */
  private recordedPending = '';
  private passing = false;
  /** Release containment, keyed by work id: positive answers are kept (a later release holds an earlier one), negatives only for the tip they were asked of. */
  private inRelease = new Map<string, number>();
  private notInRelease = new Map<string, string>();
  /** The release tip last read and when it was first observed unserved, so a promotion gets the grace period to deploy. */
  private releaseSeen: { tip: string; at: number } | null = null;
  /** Commit counts between two exact SHAs, which never change: each pair is asked of GitHub once (GY-1256). */
  private aheadMemo = new Map<string, number>();
  /** Whether the serving commit holds the release tip, for the last pair asked: a decided answer never changes for that pair. */
  private servedMemo: { tip: string; serving: string; served: boolean } | null = null;
  private report: ProductionReport;
  constructor(private store: Store, private options: ProductionWatchOptions) {
    this.report = { provider: options.provider?.name ?? null, providerDescription: options.provider?.description ?? null, observedAt: null, error: null, running: options.build.commit, serving: null, servingSource: null, latest: null, ahead: null, aheadError: null, release: null, deployed: [], pending: [], incidents: [], attention: [] };
  }
  private get now() { return (this.options.now ?? Date.now)(); }
  private get grace() { return this.options.graceMs ?? DEPLOYMENT_GRACE_MS; }

  /** Open incidents survive a restart: the ledger is the record, and the newest event per item decides. */
  async load() {
    const rows = (await this.store.pool.query('SELECT work_id, kind, payload FROM events WHERE kind IN ($1,$2) ORDER BY seq DESC LIMIT 1000', [INCIDENT_EVENT, RECOVERY_EVENT])).rows;
    const decided = new Set<string>();
    for (const row of rows) {
      if (!row.work_id || decided.has(row.work_id)) continue;
      decided.add(row.work_id);
      if (row.kind === INCIDENT_EVENT && row.payload?.incident) this.incidents.set(row.work_id, row.payload.incident as ProductionIncident);
    }
    const since = new Date(this.now - (this.options.windowMs ?? DEPLOYMENT_WINDOW_MS) - 86_400_000).toISOString();
    // Every containment record in the window, newest per item and with no cap: a record left out
    // would be compared and recorded again, and the duplicate could crowd out another on a later restart.
    // This runs before the server listens, so it reads only containment records, through their
    // partial index (events_deployment_contained), never the window's other events.
    const contained = (await this.store.pool.query('SELECT DISTINCT ON (work_id) work_id, payload FROM events WHERE kind=$1 AND created_at >= $2 AND work_id IS NOT NULL ORDER BY work_id, seq DESC', [CONTAINED_EVENT, since])).rows;
    for (const row of contained) if (row.work_id && typeof row.payload?.serving === 'string' && !this.deployedIn.has(row.work_id)) this.deployedIn.set(row.work_id, row.payload.serving);
    // The negative answers for the last serving commit: only the newest record matters, since a
    // record for an older serving commit would be asked again anyway. The read is a range on
    // insertion time over pending records only (events_deployment_pending) bounded by the window, so a ledger with no pending record —
    // the steady state — is not walked end to end at startup. Nothing is lost: a record older than
    // the window names only deliveries merged before it, which the watch no longer compares.
    const pending = (await this.store.pool.query('SELECT payload FROM events WHERE kind=$1 AND created_at >= $2 ORDER BY created_at DESC, seq DESC LIMIT 1', [PENDING_EVENT, since])).rows[0]?.payload;
    if (typeof pending?.serving === 'string' && Array.isArray(pending.workIds)) {
      for (const id of pending.workIds) if (typeof id === 'string' && !this.deployedIn.has(id)) this.notIn.set(id, pending.serving);
      this.recordedPending = pendingKey(pending.serving, pending.workIds.filter((id: unknown) => typeof id === 'string' && !this.deployedIn.has(id)));
    }
    if (this.options.releaseBranch) {
      // The newest release tip observation (events_kind_created), so the grace period runs from it across restarts.
      const seen = (await this.store.pool.query('SELECT payload FROM events WHERE kind=$1 ORDER BY created_at DESC, seq DESC LIMIT 1', [RELEASE_SEEN_EVENT])).rows[0]?.payload;
      const at = Date.parse(seen?.at);
      if (seen?.branch === this.options.releaseBranch && typeof seen.tip === 'string' && Number.isFinite(at)) this.releaseSeen = { tip: seen.tip, at };
    }
    this.loaded = true;
    this.report.incidents = this.openIncidents();
  }
  private openIncidents() { return [...this.incidents.values()].sort((a, b) => a.since.localeCompare(b.since)); }
  status(): ProductionReport { return structuredClone(this.report); }
  /** Whether a pass is running now. */
  get busy() { return this.passing; }

  /** Whether `serving` contains `mergeSha`: equal commits, or the provider reports it as an ancestor; null when unknown. */
  private async contains(mergeSha: string, serving: string): Promise<boolean | null> {
    if (mergeSha === serving) return true;
    const github = this.options.github;
    if (!github) return null;
    try {
      // The adapter answers ancestry with a one-commit compare, memoized and persisted across restarts.
      return github.contains ? await github.contains(mergeSha, serving)
        : await github.request(`/compare/${mergeSha}...${serving}`).then(comparison => comparison?.status === 'ahead' || comparison?.status === 'identical');
    } catch { return null; }
  }
  /** How far the base branch is ahead of `serving`: only the count is read, never the commit or file lists (the adapter's `aheadBy` skips the file-bearing first page). */
  private async aheadBy(serving: string, base = this.options.baseBranch): Promise<number> {
    const github = this.options.github!;
    if (github.aheadBy) return github.aheadBy(serving, base);
    const comparison = await github.request(`/compare/${serving}...${encodeURIComponent(base)}`);
    if (typeof comparison?.ahead_by !== 'number') throw new Error('GitHub did not report ahead_by');
    return comparison.ahead_by;
  }
  /** `aheadBy` memoized when both sides are exact SHAs: the answer for a pair never changes, so an unmoved pair costs no request. */
  private async aheadBetween(base: string, head: string): Promise<number> {
    const pinned = /^[0-9a-f]{40}$/.test(base) && /^[0-9a-f]{40}$/.test(head), key = `${base}...${head}`;
    if (pinned && this.aheadMemo.has(key)) return this.aheadMemo.get(key)!;
    const by = await this.aheadBy(base, head);
    if (pinned) {
      this.aheadMemo.set(key, by);
      if (this.aheadMemo.size > 256) this.aheadMemo.delete(this.aheadMemo.keys().next().value!);
    }
    return by;
  }
  /** How many commits the base branch holds past the release tip: against the observation cycle's shared base tip when the adapter has one, so an unmoved pair is not compared again. */
  private async unreleased(tip: string): Promise<number> {
    const github = this.options.github!;
    const head = github.cycleBaseBranch ? (await github.cycleBaseBranch()).tip?.toLowerCase() : undefined;
    return head && /^[0-9a-f]{40}$/.test(head) ? this.aheadBetween(tip, head) : this.aheadBy(tip);
  }

  /**
   * The release branch's tip, null when the repository has none (GitHub answers 404), so production
   * is measured against the base branch. Any other failure is thrown: a transient read never turns
   * pipeline lag back into missing deployments. Only the status decides, never wording: a scope or
   * repository error that says "not found" is a failure, not a missing branch (GY-1256).
   */
  private async releaseTip(): Promise<string | null> {
    const branch = this.options.releaseBranch, github = this.options.github;
    if (!branch || !github) return null;
    try {
      const sha = (await github.request(`/branches/${encodeURIComponent(branch)}`))?.commit?.sha;
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`GitHub reported no commit for ${branch}`);
      return sha.toLowerCase();
    } catch (error) {
      // The adapter's refusals carry the HTTP status as `failed (404)` in the message; a client error may carry it as `status`.
      if ((error as { status?: number })?.status === 404 || /\(404\)/.test(error instanceof Error ? error.message : String(error))) return null;
      throw error;
    }
  }

  /**
   * One pass, at most once per poll interval: read the provider, decide what production
   * serves, classify every recent delivery, and write incident or recovery events for what
   * changed. Provider and GitHub failures are reported, never thrown. One pass runs at a time;
   * the server runs it on its own timer (`startProductionWatch`), never inside the reconciliation tick.
   */
  async tick(force = false): Promise<ProductionReport> {
    const now = this.now;
    if (this.passing || (!force && now - this.lastPass < (this.options.pollMs ?? DEPLOYMENT_POLL_MS))) return this.status();
    this.lastPass = now;
    this.passing = true;
    try { return await this.pass(now); } finally { this.passing = false; }
  }

  private async pass(now: number): Promise<ProductionReport> {
    if (!this.loaded) await this.load();
    const at = new Date(now).toISOString();
    const report: ProductionReport = { ...this.report, observedAt: at, error: null, attention: [] };
    let deployments: ProviderDeployment[] = [];
    if (this.options.provider) {
      try { deployments = (await this.options.provider.list()).filter(d => !d.branch || d.branch === this.options.baseBranch || d.branch === this.options.releaseBranch); }
      catch (error) { report.error = `${this.options.provider.name} deployment list is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const newestSuccess = deployments.find(d => d.status === 'success');
    report.latest = deployments[0] ?? null;
    report.serving = newestSuccess?.commit ?? this.options.build.commit;
    report.servingSource = newestSuccess?.commit ? 'provider' : this.options.build.commit ? 'build' : null;
    report.ahead = null; report.aheadError = null; report.release = null;
    // The release branch production tracks, when there is one: a read that fails keeps the last tip
    // known, so a GitHub hiccup never measures production against main again.
    let tip: string | null = null, releaseUnknown = false;
    try { tip = await this.releaseTip(); if (!tip) this.releaseSeen = null; }
    catch (error) { tip = this.releaseSeen?.tip ?? null; releaseUnknown = !tip; report.aheadError = `Release branch ${this.options.releaseBranch} is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    if (tip) {
      if (this.releaseSeen?.tip !== tip) {
        this.releaseSeen = { tip, at: now };
        await this.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard', RELEASE_SEEN_EVENT, JSON.stringify({ branch: this.options.releaseBranch, tip, at })]);
      }
      const serving = report.serving?.toLowerCase() ?? null, memo = this.servedMemo;
      const served = !serving ? null : memo?.tip === tip && memo.serving === serving ? memo.served : await this.contains(tip, serving);
      if (serving && served !== null) this.servedMemo = { tip, serving, served };
      if (served === true) this.releaseSeen.at = now;
      let unreleased: number | null = null;
      try { unreleased = this.options.github ? await this.unreleased(tip) : null; } catch { unreleased = null; }
      report.release = { branch: this.options.releaseBranch!, tip, unservedSince: served === true ? null : new Date(this.releaseSeen.at).toISOString(), overdue: served === false && now - this.releaseSeen.at >= this.grace, unreleased };
      if (report.serving && served === true) report.ahead = { by: 0, head: tip, commits: [] };
      else if (report.serving && this.options.github) {
        // Against the tip just read, not the branch name: an exact pair is compared once while neither side moves.
        try { report.ahead = { by: await this.aheadBetween(report.serving.toLowerCase(), tip), head: tip, commits: [] }; }
        catch (error) { report.aheadError = `Release branch comparison is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
      }
    } else if (releaseUnknown) {
      // Neither branch can be trusted as the measure this pass; nothing is compared against main.
    } else if (report.serving && this.options.github) {
      try {
        report.ahead = { by: await this.aheadBy(report.serving), head: null, commits: [] };
      } catch (error) { report.aheadError = `Base branch comparison is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    } else if (!report.serving) report.aheadError = 'Production commit is unknown: no provider deployment list is configured and the build reports no commit (set GRAPHYARD_BUILD_SHA or RAILWAY_GIT_COMMIT_SHA)';
    else report.aheadError = 'Base branch comparison needs the GitHub App';

    const delivered = (await this.store.list()).filter(item => item.stage === 'done' && item.delivery && now - Date.parse(item.delivery.mergedAt) <= (this.options.windowMs ?? DEPLOYMENT_WINDOW_MS))
      .sort((a, b) => Date.parse(a.delivery!.mergedAt) - Date.parse(b.delivery!.mergedAt));
    report.deployed = []; report.pending = [];
    const inWindow = new Set(delivered.map(item => item.id));
    for (const map of [this.deployedIn, this.notIn, this.inRelease, this.notInRelease]) for (const id of map.keys()) if (!inWindow.has(id)) map.delete(id);
    // The oldest delivered merge production does not serve, measured against the base branch: read from the deliveries this pass already lists, no request of its own.
    let unservedSince: number | null = null;
    for (const item of delivered) {
      const mergeSha = item.delivery!.mergeSha.toLowerCase();
      const mergedAt = Date.parse(item.delivery!.mergedAt);
      const contained = await this.containment(item, mergeSha, report.serving, at);
      if (contained === true) { report.deployed.push(item.key); await this.recover(item, report, at); continue; }
      // Production deploys only promoted releases: a merge no promoted release holds yet is waiting
      // for the next cut and promotion, which is the pipeline working, not a missed deployment. Its
      // grace starts when a release first holds it. An unreadable release branch decides nothing.
      let since = mergedAt;
      if (releaseUnknown) { report.pending.push(item.key); continue; }
      if (!tip) unservedSince ??= mergedAt;
      if (tip) {
        const released = await this.releaseContainment(item, mergeSha, tip, now);
        if (released !== true) { report.pending.push(item.key); await this.recover(item, report, at); continue; }
        since = Math.max(mergedAt, this.inRelease.get(item.id)!);
      }
      // The newest attempt the provider made for this merge or anything after it: a failed
      // attempt is the incident's reason, an attempt still in flight is not yet a miss.
      const attempt = deployments.find(d => d.commit === mergeSha) ?? (tip ? deployments.find(d => d.commit === tip) : undefined) ?? deployments.find(d => Date.parse(d.createdAt) >= since - 120_000);
      if (attempt && (attempt.status === 'failed' || attempt.status === 'crashed')) {
        await this.raise(item, report, at, 'failed', attempt.id, `${this.options.provider!.name} deployment ${attempt.id}${attempt.commit ? ` of ${attempt.commit.slice(0, 12)}` : ''} ${attempt.providerStatus}${attempt.url ? ` (${attempt.url})` : ''}; production still serves ${report.serving?.slice(0, 12) ?? 'an unknown commit'}`);
        report.pending.push(item.key); continue;
      }
      if (attempt && ['building', 'deploying', 'queued'].includes(attempt.status) && now - since <= this.grace * 3) { report.pending.push(item.key); continue; }
      // Unknown containment (no serving commit, or GitHub could not compare) is not evidence
      // of a miss; only a serving commit known not to contain the merge is.
      if (now - since < this.grace || contained === null) { report.pending.push(item.key); continue; }
      await this.raise(item, report, at, 'missing', null, `no ${this.options.provider ? `${this.options.provider.name} deployment` : 'deployment'} of ${mergeSha.slice(0, 12)} was observed within ${Math.round(this.grace / 60_000)} minutes of ${tip ? `its promotion to ${this.options.releaseBranch} (${tip.slice(0, 12)})` : 'the merge'}; production serves ${report.serving!.slice(0, 12)}, which does not contain it${this.options.provider ? '' : '. Configure RAILWAY_API_TOKEN (or RAILWAY_TOKEN) or the GitHub App: either one reads a deployment list (Railway\'s, or the GitHub deployments Railway reports) that names the failing deployment'}`);
      report.pending.push(item.key);
    }
    if (report.serving) await this.recordPending(report.serving, at);
    report.incidents = this.openIncidents();
    if (report.ahead && !tip) {
      // A merge→deploy rollout in flight is not a deployment fault: the lag stands as attention only
      // once a delivered merge has gone unserved past the grace (a failed rollout, a rollback, a stall).
      // An open incident — a provider FAILED status inside the grace — is no rollout in flight.
      const latest = report.latest, servingCommit = report.serving?.toLowerCase();
      const attempting = !!latest && ['building', 'deploying', 'queued'].includes(latest.status) && !!latest.commit && latest.commit.toLowerCase() !== servingCommit && now - Date.parse(latest.createdAt) <= this.grace * 3;
      report.ahead.unservedSince = unservedSince === null ? null : new Date(unservedSince).toISOString();
      report.ahead.rollingOut = report.ahead.by > 0 && unservedSince !== null && !report.incidents.length && (now - unservedSince < this.grace || (attempting && now - unservedSince <= this.grace * 3));
    }
    report.attention = attentionLines(report);
    this.report = report;
    return this.status();
  }

  /** Containment of one delivery, asked of GitHub only when neither the record nor the last answer for this serving commit decides it. */
  private async containment(item: Work, mergeSha: string, serving: string | null, at: string): Promise<boolean | null> {
    if (this.deployedIn.has(item.id)) return true;
    if (!serving) return null;
    if (this.notIn.get(item.id) === serving) return false;
    const contained = await this.contains(mergeSha, serving);
    if (contained === false) this.notIn.set(item.id, serving);
    if (contained === true) {
      this.notIn.delete(item.id);
      await this.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [item.id, 'graphyard', CONTAINED_EVENT, JSON.stringify({ key: item.key, mergeSha, serving, at })]);
      this.deployedIn.set(item.id, serving);
    }
    return contained;
  }

  /** Whether the release tip holds a delivery; a negative answer is asked again only when the tip moves. */
  private async releaseContainment(item: Work, mergeSha: string, tip: string, now: number): Promise<boolean | null> {
    if (this.inRelease.has(item.id)) return true;
    if (this.notInRelease.get(item.id) === tip) return false;
    const released = await this.contains(mergeSha, tip);
    if (released === false) this.notInRelease.set(item.id, tip);
    if (released === true) { this.notInRelease.delete(item.id); this.inRelease.set(item.id, this.releaseSeen?.tip === tip ? this.releaseSeen.at : now); }
    return released;
  }

  /** Persists the deliveries known not to be in `serving`, when that set changed since the last record. */
  private async recordPending(serving: string, at: string) {
    const workIds = [...this.notIn].filter(([, release]) => release === serving).map(([id]) => id).sort();
    const key = pendingKey(serving, workIds);
    if (key === this.recordedPending) return;
    await this.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard', PENDING_EVENT, JSON.stringify({ serving, workIds, at })]);
    this.recordedPending = key;
  }

  private async raise(item: Work, report: ProductionReport, at: string, status: 'failed' | 'missing', deploymentId: string | null, reason: string) {
    const open = this.incidents.get(item.id);
    // The same open incident is not re-recorded on every pass; a changed status or reason is.
    if (open && open.status === status && open.reason === reason) return;
    const incident: ProductionIncident = { id: randomUUID(), workId: item.id, key: item.key, mergeSha: item.delivery!.mergeSha, status, provider: this.options.provider?.name ?? null, deploymentId, serving: report.serving, reason, since: open?.since ?? at, at };
    this.incidents.set(item.id, incident);
    await this.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [item.id, 'graphyard', INCIDENT_EVENT, JSON.stringify({ incident, at })]);
  }
  private async recover(item: Work, report: ProductionReport, at: string) {
    const open = this.incidents.get(item.id);
    if (!open) return;
    this.incidents.delete(item.id);
    await this.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [item.id, 'graphyard', RECOVERY_EVENT, JSON.stringify({ incidentId: open.id, key: item.key, mergeSha: open.mergeSha, serving: report.serving, since: open.since, at })]);
  }
}

function pendingKey(serving: string, workIds: string[]) { return workIds.length ? `${serving}:${[...workIds].sort().join(',')}` : ''; }

/** The operator sentences: how far main is ahead, why, and which merged items are not serving. */
export function attentionLines(report: Pick<ProductionReport, 'ahead' | 'aheadError' | 'serving' | 'incidents' | 'error' | 'latest' | 'provider'> & Pick<Partial<ProductionReport>, 'release'>): string[] {
  const lines: string[] = [];
  const failing = report.incidents.find(incident => incident.status === 'failed') ?? report.incidents[0];
  const release = report.release ?? null;
  if (release) {
    // Main ahead of the promoted release is the release pipeline's cadence, never a fault: only a
    // promoted release production has not served within the grace period, or an incident, is.
    if (release.overdue) {
      const by = report.ahead?.by;
      lines.push(`${release.branch} (${release.tip.slice(0, 12)}) is ${typeof by === 'number' && by > 0 ? `${by} commit${by === 1 ? '' : 's'} ` : ''}ahead of production (serving ${report.serving?.slice(0, 12) ?? 'unknown'}) since ${release.unservedSince}${failing ? `: ${failing.reason}` : ''}`);
    } else if (failing) lines.push(`Production has not deployed ${failing.key}: ${failing.reason}`);
  } else if (report.ahead && report.ahead.by > 0 && !(report.ahead.rollingOut && !report.incidents.length)) {
    lines.push(`main is ${report.ahead.by} commit${report.ahead.by === 1 ? '' : 's'} ahead of production (serving ${report.serving?.slice(0, 12) ?? 'unknown'})${failing ? `: ${failing.reason}` : ''}`);
  } else if (report.incidents.length && failing) lines.push(`Production has not deployed ${failing.key}: ${failing.reason}`);
  if (report.incidents.length) lines.push(`${report.incidents.length} delivered item${report.incidents.length === 1 ? ' has' : 's have'} an open deployment incident: ${report.incidents.map(incident => `${incident.key} (${incident.status})`).join(', ')}`);
  if (report.error) lines.push(report.error);
  return lines;
}

/**
 * Runs the watch on its own timer, outside the server's serial reconciliation tick: a provider or
 * GitHub read that takes minutes (or never answers) holds only the watch, never engine.reconcile,
 * the delivery sweep or the job queue. A pass still running when the timer fires is not overlapped.
 */
export function startProductionWatch(watch: ProductionWatch, options: { intervalMs?: number; announce?: (incident: ProductionIncident) => void; failed?: (error: unknown) => void } = {}) {
  let startedAt = 0, stallReportedAt = 0;
  const timer = setInterval(() => {
    if (watch.busy) {
      if (Date.now() - startedAt > 5 * 60_000 && Date.now() - stallReportedAt > 5 * 60_000) { stallReportedAt = Date.now(); console.error(`production watch pass running ${Math.round((Date.now() - startedAt) / 1000)}s; reconciliation is unaffected`); }
      return;
    }
    const before = new Set(watch.status().incidents.map(incident => incident.id));
    startedAt = Date.now();
    void watch.tick().then(report => { for (const incident of report.incidents) if (!before.has(incident.id)) options.announce?.(incident); }, error => options.failed?.(error));
  }, options.intervalMs ?? PRODUCTION_WATCH_TIMER_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
