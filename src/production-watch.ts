import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Work } from './model.js';
import type { BuildIdentity } from './protocol-version.js';
import type { Application } from './model/project-applications.js';
import { posix } from 'node:path';

/**
 * Production deployment observation for the managed base branch.
 *
 * Graphyard marks work Done when it observes the merge; whether the merged commit ever
 * reached production is a separate fact that nothing used to record. The watch polls the
 * hosting provider's deployment list for the linked service after every merge, takes what
 * production serves from a fresh endpoint observation of the exact release, the provider's
 * newest successful deployment, or the running build, and records a failed deployment of a
 * merged commit as a delivery incident in the append-only ledger. It is an observation,
 * never a gate: a lagging or failed rollout stays visible as pending until the provider
 * serves the merge, at which point an incident is recorded as recovered. Containment is
 * equality alone — a delivery counts as deployed only when production serves its exact
 * merge commit — and nothing here rewrites a delivery snapshot.
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
 * a token the provider is not configured and the watch reports the build identity alone.
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

/**
 * The deployment list the watch reads: Railway's API when a Railway token is configured, else none
 * and the watch reports the build identity alone. GitHub deployments are no longer read (GY-2010).
 */
export function productionProvider(env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): DeploymentProvider | null {
  return railwayProvider(env, fetcher);
}

/** The startup log's account of where production observation comes from. */
export function observationLine(provider: DeploymentProvider | null, build: Pick<BuildIdentity, 'commit'>) {
  return `production observation ${provider ? `via ${provider.description}` : build.commit ? 'from the build identity only' : 'unavailable: set GRAPHYARD_BUILD_SHA or RAILWAY_GIT_COMMIT_SHA'}`;
}

export interface ProductionIncident {
  id: string; workId: string; key: string; mergeSha: string; status: 'failed' | 'missing';
  provider: string | null; deploymentId: string | null; serving: string | null; reason: string; since: string; at: string;
}
export interface ProductionReport {
  provider: string | null; providerDescription: string | null; observedAt: string | null; error: string | null;
  /** The commit this process was built from, when the deployment says. */
  running: string | null;
  /**
   * The commit production serves: a fresh endpoint observation of the exact release (`liveEndpointRelease`),
   * else the provider's newest successful deployment, else the running build.
   */
  serving: string | null; servingSource: 'endpoint' | 'provider' | 'build' | null;
  latest: ProviderDeployment | null;
  /** Why no branch lag is computed: GitHub comparisons are gone, so the watch names what it cannot tell. */
  aheadError: string | null;
  deployed: string[]; pending: string[];
  incidents: ProductionIncident[];
  attention: string[];
}
export const INCIDENT_EVENT = 'delivery.deployment-incident', RECOVERY_EVENT = 'delivery.deployment-recovered';
/** A delivery first observed inside the serving release; containment is never asked again for it. */
export const CONTAINED_EVENT = 'delivery.deployment-contained';
/** A merged commit not served within this long is a missing deployment. */
export const DEPLOYMENT_GRACE_MS = 5 * 60_000;
/** Deliveries older than this are not re-verified against the provider on every pass. */
export const DEPLOYMENT_WINDOW_MS = 14 * 86_400_000;
export const DEPLOYMENT_POLL_MS = 60_000;
/** How often the watch's own timer offers it a pass; the pass itself runs at most once per poll interval. */
export const PRODUCTION_WATCH_TIMER_MS = 5_000;

export interface ProductionWatchOptions {
  provider: DeploymentProvider | null;
  build: BuildIdentity; baseBranch: string;
  graceMs?: number; windowMs?: number; pollMs?: number; now?: () => number;
}

export class ProductionWatch {
  private incidents = new Map<string, ProductionIncident>();
  private loaded = false; private lastPass = 0;
  /**
   * Containment is monotonic: a delivery whose exact merge production served is deployed and is
   * never asked again (the record is in the ledger, so a restart — which every deploy is — keeps
   * it). There is no ancestry comparison: containment is equality alone.
   */
  private deployedIn = new Map<string, string>();
  private passing = false;
  private report: ProductionReport;
  constructor(private store: Store, private options: ProductionWatchOptions) {
    this.report = { provider: options.provider?.name ?? null, providerDescription: options.provider?.description ?? null, observedAt: null, error: null, running: options.build.commit, serving: null, servingSource: null, latest: null, aheadError: null, deployed: [], pending: [], incidents: [], attention: [] };
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
    this.loaded = true;
    this.report.incidents = this.openIncidents();
  }
  private openIncidents() { return [...this.incidents.values()].sort((a, b) => a.since.localeCompare(b.since)); }
  status(): ProductionReport { return structuredClone(this.report); }
  /** Whether a pass is running now. */
  get busy() { return this.passing; }

  /**
   * One pass, at most once per poll interval: read the provider, decide what production
   * serves, classify every recent delivery, and write incident or recovery events for what
   * changed. Provider failures are reported, never thrown. One pass runs at a time;
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
    report.aheadError = null;
    const delivered = (await this.store.fleet()).filter(item => item.stage === 'done' && item.delivery && now - Date.parse(item.delivery.mergedAt) <= (this.options.windowMs ?? DEPLOYMENT_WINDOW_MS))
      .sort((a, b) => Date.parse(a.delivery!.mergedAt) - Date.parse(b.delivery!.mergedAt));
    const live = liveEndpointRelease(delivered, deployments, newestSuccess, now);
    // The served build identity — the commit this deployment publishes as its own /healthz commit —
    // is what production serves when nothing else names a commit (GY-1421). A fresh endpoint
    // observation of the exact release outranks the provider's list, and the provider's newest
    // successful deployment outranks the build: the list explains why a deploy failed or is in
    // flight, and the build stands in only when it names nothing.
    report.serving = live ?? newestSuccess?.commit ?? this.options.build.commit;
    report.servingSource = live ? 'endpoint' : newestSuccess?.commit ? 'provider' : this.options.build.commit ? 'build' : null;
    if (!report.serving) report.aheadError = 'Production commit is unknown: no provider deployment list is configured and the build reports no commit (set GRAPHYARD_BUILD_SHA or RAILWAY_GIT_COMMIT_SHA)';
    else report.aheadError = 'Branch lag is not computed: GitHub comparisons are gone';

    report.deployed = []; report.pending = [];
    const inWindow = new Set(delivered.map(item => item.id));
    for (const id of this.deployedIn.keys()) if (!inWindow.has(id)) this.deployedIn.delete(id);
    for (const item of delivered) {
      const mergeSha = item.delivery!.mergeSha.toLowerCase();
      const mergedAt = Date.parse(item.delivery!.mergedAt);
      if (await this.containment(item, mergeSha, report.serving, at) === true) { report.deployed.push(item.key); await this.recover(item, report, at); continue; }
      // The newest attempt the provider made for this merge or anything after it: a failed
      // attempt is the incident's reason, an attempt still in flight is not yet a miss.
      const attempt = deployments.find(d => d.commit === mergeSha) ?? deployments.find(d => Date.parse(d.createdAt) >= mergedAt - 120_000);
      if (attempt && (attempt.status === 'failed' || attempt.status === 'crashed')) {
        await this.raise(item, report, at, 'failed', attempt.id, `${this.options.provider!.name} deployment ${attempt.id}${attempt.commit ? ` of ${attempt.commit.slice(0, 12)}` : ''} ${attempt.providerStatus}${attempt.url ? ` (${attempt.url})` : ''}; production still serves ${report.serving?.slice(0, 12) ?? 'an unknown commit'}${this.providerSaid(newestSuccess, report.latest)}`);
        report.pending.push(item.key); continue;
      }
      if (attempt && ['building', 'deploying', 'queued'].includes(attempt.status) && now - mergedAt <= this.grace * 3) { report.pending.push(item.key); continue; }
      // Containment is equality alone: a merge production does not serve exactly stays pending —
      // without ancestry comparison nothing can call it missing.
      report.pending.push(item.key);
    }
    report.incidents = this.openIncidents();
    report.attention = attentionLines(report);
    this.report = report;
    return this.status();
  }

  /** Whether production serves this delivery's exact merge; records the containment once it does. */
  private async containment(item: Work, mergeSha: string, serving: string | null, at: string): Promise<boolean | null> {
    if (this.deployedIn.has(item.id)) return true;
    if (!serving || mergeSha !== serving) return null;
    await this.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [item.id, 'graphyard', CONTAINED_EVENT, JSON.stringify({ key: item.key, mergeSha, serving, at })]);
    this.deployedIn.set(item.id, serving);
    return true;
  }

  private async raise(item: Work, report: ProductionReport, at: string, status: 'failed', deploymentId: string | null, reason: string) {
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
    // What verified the delivery: the served build identity (/healthz commit) when it decided, the provider's list or an endpoint observation otherwise.
    const verifiedBy = report.servingSource === 'build' ? 'served-identity' : report.servingSource;
    await this.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [item.id, 'graphyard', RECOVERY_EVENT, JSON.stringify({ incidentId: open.id, key: item.key, mergeSha: open.mergeSha, serving: report.serving, verifiedBy, since: open.since, at })]);
  }
  /** What the provider's list reported on the other side of a failed deployment. */
  private providerSaid(newestSuccess: ProviderDeployment | undefined, latest: ProviderDeployment | null) {
    const name = this.options.provider!.name;
    const reported = newestSuccess?.commit ? `its newest successful deployment is of ${newestSuccess.commit.slice(0, 12)}`
      : latest ? `its newest deployment ${latest.id}${latest.commit ? ` of ${latest.commit.slice(0, 12)}` : ''} is ${latest.providerStatus}` : 'it lists no deployment';
    return `; ${name} reported ${reported}`;
  }
}

/** How long an endpoint observation of the serving release outranks a provider list that has not caught up with it. */
export const ENDPOINT_FRESH_MS = 3 * DEPLOYMENT_GRACE_MS;

/**
 * The release production's own endpoint was observed serving (`master verify-deployment`, source
 * `endpoint`), when that observation outranks the provider list (GY-1420): a provider's deployment
 * status can lag a release that is already live. The observation counts only when it is fresh,
 * names a full 40-character SHA, is newer than the provider's newest success, and the provider's
 * newest deployment of that SHA, if it lists one, did not fail, crash or get removed. Anything
 * short of that proof leaves the provider's answer standing, so a failed or unserved release is
 * reported as before.
 */
export function liveEndpointRelease(delivered: Pick<Work, 'delivery'>[], deployments: ProviderDeployment[], newestSuccess: ProviderDeployment | undefined, now: number): string | null {
  const provided = newestSuccess ? Date.parse(newestSuccess.updatedAt ?? newestSuccess.createdAt) : -Infinity;
  let best: { sha: string; at: number } | null = null;
  for (const item of delivered) {
    const observed = item.delivery?.deployment;
    if (!observed || observed.source !== 'endpoint' || typeof observed.sha !== 'string') continue;
    const sha = observed.sha.toLowerCase(), at = Date.parse(observed.observedAt);
    if (!/^[0-9a-f]{40}$/.test(sha) || !Number.isFinite(at) || at > now + 60_000 || now - at > ENDPOINT_FRESH_MS || at <= provided) continue;
    if (best && best.at >= at) continue;
    best = { sha, at };
  }
  if (!best) return null;
  if (newestSuccess?.commit?.toLowerCase() === best.sha) return null;
  // The provider's newest attempt at that SHA decides whether it is running: a redeploy's older, removed attempt does not.
  const attempt = deployments.find(d => d.commit?.toLowerCase() === best!.sha);
  return attempt && ['failed', 'crashed', 'removed'].includes(attempt.status) ? null : best.sha;
}

/** The operator sentences: which merged items production does not serve, and why the watch cannot tell more. */
export function attentionLines(report: Pick<ProductionReport, 'serving' | 'incidents' | 'error'>): string[] {
  const lines: string[] = [];
  const failing = report.incidents.find(incident => incident.status === 'failed') ?? report.incidents[0];
  if (report.incidents.length && failing) lines.push(`Production has not deployed ${failing.key}: ${failing.reason}`);
  if (report.incidents.length) lines.push(`${report.incidents.length} delivered item${report.incidents.length === 1 ? ' has' : 's have'} an open deployment incident: ${report.incidents.map(incident => `${incident.key} (${incident.status})`).join(', ')}`);
  if (report.error) lines.push(report.error);
  return lines;
}

/**
 * Runs the watch on its own timer, outside the server's serial reconciliation tick: a provider read
 * that takes minutes (or never answers) holds only the watch, never engine.reconcile, the delivery
 * sweep or the job queue. A pass still running when the timer fires is not overlapped.
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

/** One declared application's observed release: the commit its versionUrl answers against main's tip (GY-3204). */
export interface ApplicationRelease {
  id: string; serving: string | null; main: string | null;
  /**
   * current: it serves main, or nothing on main since its commit touches its directory; deploying: a
   * change to its directory is on main for less than ENDPOINT_FRESH_MS; lagging: one has been longer
   * and it still does not serve it; failed: the endpoint is unreachable, unparseable or names a commit the checkout lacks.
   */
  state: 'current' | 'deploying' | 'lagging' | 'failed';
  reason: string | null;
}

/** The directory a change must touch to concern an application: a static site's directory, a Compose file's directory. */
const applicationDirectory = (application: Application) => application.kind === 'static' ? application.directory : posix.dirname(application.file);

/** The commit a version endpoint answers: JSON `commit` or `sha`, else the plain-text body. */
async function servedCommit(url: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const text = (await response.text()).trim();
  let value: unknown = text;
  if (text.startsWith('{')) { try { const body = JSON.parse(text); value = body?.commit ?? body?.sha; } catch { /* not JSON: the text is judged as is */ } }
  if (typeof value !== 'string' || !/^[0-9a-f]{7,40}$/i.test(value.trim())) throw new Error(`${url} names no commit (JSON commit or sha, or plain text)`);
  return value.trim().toLowerCase();
}

/**
 * What each application declaring a versionUrl serves, against main's tip in the managed checkout.
 * Railway (or any host) deploys each app from git on its own; Graphyard only reads the endpoint,
 * with no provider credential. A change to the app's directory counts as on main since its committer date.
 */
export async function observeApplications(applications: Application[], main: string | null, git: (args: readonly string[]) => Promise<string>, options: { fetcher?: typeof fetch; now?: number } = {}): Promise<ApplicationRelease[]> {
  const now = options.now ?? Date.now();
  return Promise.all(applications.filter(application => application.versionUrl).map(async (application): Promise<ApplicationRelease> => {
    let serving: string;
    try { serving = await servedCommit(application.versionUrl!, options.fetcher ?? fetch); }
    catch (error) { return { id: application.id, serving: null, main, state: 'failed', reason: error instanceof Error ? error.message : String(error) }; }
    try { serving = (await git(['rev-parse', '--verify', `${serving}^{commit}`])).trim(); }
    catch { return { id: application.id, serving, main, state: 'failed', reason: `serves ${serving.slice(0, 12)}, which the checkout does not hold` }; }
    if (!main || serving === main) return { id: application.id, serving, main, state: 'current', reason: null };
    const changes = (await git(['log', '--format=%H %ct', `${serving}..${main}`, '--', applicationDirectory(application)])).trim().split('\n').filter(Boolean)
      .map(line => { const [sha, at] = line.split(' '); return { sha, at: Number(at) * 1000 }; });
    if (!changes.length) return { id: application.id, serving, main, state: 'current', reason: null };
    const stale = changes.filter(change => now - change.at > ENDPOINT_FRESH_MS);
    if (!stale.length) return { id: application.id, serving, main, state: 'deploying', reason: null };
    const oldest = stale.at(-1)!;
    return { id: application.id, serving, main, state: 'lagging', reason: `serves ${serving.slice(0, 12)}; ${oldest.sha.slice(0, 12)} changed it on main ${Math.round((now - oldest.at) / 60_000)} minutes ago` };
  }));
}
