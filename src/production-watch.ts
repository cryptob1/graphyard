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
 * a token the provider is not configured and the watch falls back to the build identity.
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
  /** How far the base branch is ahead of what production serves. */
  ahead: { by: number; head: string | null; commits: { sha: string; message: string }[] } | null; aheadError: string | null;
  deployed: string[]; pending: string[];
  incidents: ProductionIncident[];
  attention: string[];
}
export const INCIDENT_EVENT = 'delivery.deployment-incident', RECOVERY_EVENT = 'delivery.deployment-recovered';
/** A delivery first observed inside the release production serves; containment is never asked again for it. */
export const CONTAINED_EVENT = 'delivery.deployment-contained';
/**
 * The deliveries known not to be in the serving release, with that release: a restart at an
 * unchanged serving SHA (a config-only restart, a failed rollout, a crash loop) restores them and
 * asks none again. A plane event (no work id), written only when the set changes.
 */
export const PENDING_EVENT = 'production.deployment-pending';
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
  github: { request(path: string): Promise<any>; contains?(base: string, head: string): Promise<boolean>; aheadBy?(base: string, head: string): Promise<number> } | null;
  build: BuildIdentity; baseBranch: string;
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
  private report: ProductionReport;
  constructor(private store: Store, private options: ProductionWatchOptions) {
    this.report = { provider: options.provider?.name ?? null, providerDescription: options.provider?.description ?? null, observedAt: null, error: null, running: options.build.commit, serving: null, servingSource: null, latest: null, ahead: null, aheadError: null, deployed: [], pending: [], incidents: [], attention: [] };
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
  private async aheadBy(serving: string): Promise<number> {
    const github = this.options.github!, base = this.options.baseBranch;
    if (github.aheadBy) return github.aheadBy(serving, base);
    const comparison = await github.request(`/compare/${serving}...${encodeURIComponent(base)}`);
    if (typeof comparison?.ahead_by !== 'number') throw new Error('GitHub did not report ahead_by');
    return comparison.ahead_by;
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
      try { deployments = (await this.options.provider.list()).filter(d => !d.branch || d.branch === this.options.baseBranch); }
      catch (error) { report.error = `${this.options.provider.name} deployment list is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const newestSuccess = deployments.find(d => d.status === 'success');
    report.latest = deployments[0] ?? null;
    report.serving = newestSuccess?.commit ?? this.options.build.commit;
    report.servingSource = newestSuccess?.commit ? 'provider' : this.options.build.commit ? 'build' : null;
    report.ahead = null; report.aheadError = null;
    if (report.serving && this.options.github) {
      try {
        report.ahead = { by: await this.aheadBy(report.serving), head: null, commits: [] };
      } catch (error) { report.aheadError = `Base branch comparison is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    } else if (!report.serving) report.aheadError = 'Production commit is unknown: no provider deployment list is configured and the build reports no commit (set GRAPHYARD_BUILD_SHA or RAILWAY_GIT_COMMIT_SHA)';
    else report.aheadError = 'Base branch comparison needs the GitHub App';

    const delivered = (await this.store.list()).filter(item => item.stage === 'done' && item.delivery && now - Date.parse(item.delivery.mergedAt) <= (this.options.windowMs ?? DEPLOYMENT_WINDOW_MS))
      .sort((a, b) => Date.parse(a.delivery!.mergedAt) - Date.parse(b.delivery!.mergedAt));
    report.deployed = []; report.pending = [];
    const inWindow = new Set(delivered.map(item => item.id));
    for (const map of [this.deployedIn, this.notIn]) for (const id of map.keys()) if (!inWindow.has(id)) map.delete(id);
    for (const item of delivered) {
      const mergeSha = item.delivery!.mergeSha.toLowerCase();
      const mergedAt = Date.parse(item.delivery!.mergedAt);
      const contained = await this.containment(item, mergeSha, report.serving, at);
      if (contained === true) { report.deployed.push(item.key); await this.recover(item, report, at); continue; }
      // The newest attempt the provider made for this merge or anything after it: a failed
      // attempt is the incident's reason, an attempt still in flight is not yet a miss.
      const attempt = deployments.find(d => d.commit === mergeSha) ?? deployments.find(d => Date.parse(d.createdAt) >= mergedAt - 120_000);
      if (attempt && (attempt.status === 'failed' || attempt.status === 'crashed')) {
        await this.raise(item, report, at, 'failed', attempt.id, `${this.options.provider!.name} deployment ${attempt.id}${attempt.commit ? ` of ${attempt.commit.slice(0, 12)}` : ''} ${attempt.providerStatus}${attempt.url ? ` (${attempt.url})` : ''}; production still serves ${report.serving?.slice(0, 12) ?? 'an unknown commit'}`);
        report.pending.push(item.key); continue;
      }
      if (attempt && ['building', 'deploying', 'queued'].includes(attempt.status) && now - mergedAt <= this.grace * 3) { report.pending.push(item.key); continue; }
      // Unknown containment (no serving commit, or GitHub could not compare) is not evidence
      // of a miss; only a serving commit known not to contain the merge is.
      if (now - mergedAt < this.grace || contained === null) { report.pending.push(item.key); continue; }
      await this.raise(item, report, at, 'missing', null, `no ${this.options.provider ? `${this.options.provider.name} deployment` : 'deployment'} of ${mergeSha.slice(0, 12)} was observed within ${Math.round(this.grace / 60_000)} minutes of the merge; production serves ${report.serving!.slice(0, 12)}, which does not contain it${this.options.provider ? '' : '. Configure RAILWAY_API_TOKEN (or RAILWAY_TOKEN) so the provider reports the failing deployment'}`);
      report.pending.push(item.key);
    }
    if (report.serving) await this.recordPending(report.serving, at);
    report.incidents = this.openIncidents();
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
export function attentionLines(report: Pick<ProductionReport, 'ahead' | 'aheadError' | 'serving' | 'incidents' | 'error' | 'latest' | 'provider'>): string[] {
  const lines: string[] = [];
  const failing = report.incidents.find(incident => incident.status === 'failed') ?? report.incidents[0];
  if (report.ahead && report.ahead.by > 0) {
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
