// Concern: observing the deployed release and which deliveries it serves.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { productionEnvironmentFromEnv } from '../flow-analytics.js';
import type { ChildRun } from '../child-runner.js';
import type { Work } from '../model.js';
import type { MasterConfig } from '../master.js';
import { actionableIntervalMs } from './liveness.js';
import { boundDeployment, type ContainmentRetention, type DeploymentObservation, deploymentObservationSchema, message, retainedContainments } from './state.js';
import { staleContainmentReasonPrefix } from '../model/action-kinds.js';

export function deploymentDetail(observation: DeploymentObservation) {
  if (observation.source === 'unavailable') return `Deployment SHA is unverified: ${observation.reason ?? 'no deployment observation is configured or available'}`;
  return `Deployed SHA ${observation.sha?.slice(0, 12) ?? 'unknown'} from ${observation.source}; verified ${observation.deployed.length} delivered item(s), ${observation.pending.length} not yet serving${observation.reason ? `; ${observation.reason}` : ''}`;
}

/**
 * The deployed commit, taken from a configured endpoint that reports it; nothing is read from GitHub. A delivered item counts as deployed when the serving commit is its merge commit
 * or a descendant of it, so later merges do not make earlier ones look undeployed.
 *
 * Containment is derived from git, not from the forge: one fetch of the base branch and
 * `git merge-base --is-ancestor` per delivery whose containment this loop has not already
 * established. What it has established is retained with the release it was verified against, and
 * one ancestry check carries the whole retained set onto a release that descends from it — so a
 * steady cycle derives containment only for deliveries newer than the last observed release, and
 * the cost stays flat however long the delivery history grows.
 * `root` is the managed repository's checkout, which every caller must name: the Graphyard
 * launcher's directory may be a checkout of another repository, or no checkout at all, and
 * ancestry asked there would leave every delivery pending without saying why.
 * A release that does not descend from the retained one (a rollback, an unrelated commit) drops
 * the retention and every delivery is derived again.
 */
/**
 * GY-1753 AC-3: the production environment deployments are read under: the run's
 * `productionEnvironment`, else an explicit GRAPHYARD_PRODUCTION_ENVIRONMENT, else `github-pages` when the
 * repository deploys with GitHub Pages (GY-1954: any workflow; explicit settings win over the workflows).
 */
export function deploymentEnvironmentName(config: Pick<MasterConfig, 'run'>, root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (config.run.productionEnvironment) return config.run.productionEnvironment;
  if (env.GRAPHYARD_PRODUCTION_ENVIRONMENT === undefined && repositoryDeploysWithPages(root)) return 'github-pages';
  return productionEnvironmentFromEnv(env);
}

/** GY-1954: any workflow running `actions/deploy-pages` names github-pages, whatever its file; pages-deploy.yml also counts. */
const repositoryDeploysWithPages = (root: string) => {
  const workflows = join(root, '.github', 'workflows');
  if (existsSync(join(workflows, 'pages-deploy.yml'))) return true;
  try { return readdirSync(workflows).some(name => { try { return /\.ya?ml$/.test(name) && readFileSync(join(workflows, name), 'utf8').includes('actions/deploy-pages'); } catch { return false; } }); } catch { return false; }
};

export async function observeDeployment(config: MasterConfig, delivered: Work[], run: ChildRun, fetcher: typeof fetch = fetch, now = () => Date.now(),
  options: { root: string; retained?: ContainmentRetention | null }): Promise<DeploymentObservation> {
  const at = new Date(now()).toISOString();
  const requests = 0;
  const unavailable = (reason: string): DeploymentObservation => boundDeployment({ source: 'unavailable', sha: null, at, reason, deployed: [], pending: delivered.map(item => item.key), requests, derived: 0, retained: 0, containment: options.retained ?? null });
  if (!delivered.length) return { source: 'unavailable', sha: null, at, reason: 'No delivered work is awaiting deployment verification', deployed: [], pending: [], requests, derived: 0, retained: 0, containment: options.retained ?? null };
  let sha: string | null = null, source: DeploymentObservation['source'] = 'unavailable';
  if (config.run.deploymentUrl) {
    let payload: any;
    try {
      const response = await fetcher(config.run.deploymentUrl, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return unavailable(`Deployment endpoint answered ${response.status}`);
      payload = await response.json();
    } catch (error) { return unavailable(`Deployment endpoint is unreachable: ${message(error)}`); }
    const value = config.run.deploymentShaField.split('.').reduce((node: any, part) => node?.[part], payload);
    if (typeof value !== 'string' || !/^[0-9a-f]{7,40}$/i.test(value)) return unavailable(`Deployment endpoint did not report a commit at ${config.run.deploymentShaField}`);
    sha = value.toLowerCase(); source = 'endpoint';
  } else return unavailable('No deployment endpoint is configured: name one with graphyard master init --deployment-url, or record the release with graphyard master verify-deployment');
  const ancestry = localAncestry(options.root, config.baseBranch, run);
  // The retained set is carried forward whole, on one ancestry check, or dropped whole.
  const retention = options.retained ?? null;
  const carried = retention && (retention.release === sha || await ancestry.contains(retention.release, sha) === true) ? retention : null;
  const deployed: string[] = [], pending: string[] = [];
  const settled: Record<string, string> = {};
  let derived = 0, retainedCount = 0;
  for (const item of delivered) {
    const mergeSha = item.delivery!.mergeSha.toLowerCase();
    const established = carried?.settled[item.key];
    // Already shown to be served by a release this one descends from: nothing to ask git again.
    if (established) { deployed.push(item.key); settled[item.key] = established; retainedCount++; continue; }
    // Everything else is derived this pass, so `derived + retained` is always the delivery count.
    // The release's own merge needs no ancestry; every other delivery asks git once.
    derived++;
    if (mergeSha === sha || await ancestry.contains(mergeSha, sha) === true) { deployed.push(item.key); settled[item.key] = sha; }
    else pending.push(item.key);
  }
  const keep = Object.entries(settled).slice(-retainedContainments);
  // A base branch this checkout could not fetch is said out loud: containment was then derived
  // from whatever objects are here, and a delivery git could not place stays pending, never deployed.
  const stale = ancestry.fetchFailure;
  const reasons = [stale ? `${staleContainmentReasonPrefix}${stale}` : null].filter(Boolean);
  return deploymentObservationSchema.parse({ source, sha, at, reason: reasons.length ? reasons.join('; ') : null, deployed: deployed.slice(-200), pending: pending.slice(-200),
    requests, derived, retained: retainedCount, containment: { release: sha, settled: Object.fromEntries(keep) } });
}

// ——— The step's per-cycle budget (GY-1354) ———

/**
 * What the deployment step's reads — the release observation and the promotion check — may spend in
 * one cycle before the step moves on: on 2026-10-06 the inline reads ran for 381.9s of cycle 12621's
 * 450s, past the two-interval liveness bound. Like the decisions step (GY-1286) and the faults
 * step's observation (GY-1345), a fifth of the interval and never under the 30s actionable cadence:
 * a read still running at the bound is left in flight, the last verified observation stands, and a
 * later cycle takes the answer once it lands.
 */
export const deploymentStepBudgetMs = (intervalMs: number) => Math.max(actionableIntervalMs, Math.round(intervalMs * 0.2));
/** A read the budget cut: its verification goes on in flight and a later cycle takes its answer. */
export const stillVerifying = Symbol('still verifying');
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
/**
 * The step's reads in flight, per loop state and read. One left behind by the budget keeps running
 * — that is the verification's progress — so a cycle finding it here starts no other and does not
 * wait on it again: it takes the answer if it has landed and moves on otherwise. A slow window then
 * costs only the cycle that asked its budget, and never stacks reads on the source too slow to answer one.
 */
const verifying = new WeakMap<object, Map<string, Promise<Settled<unknown>>>>();
/** How many of the deployment step's reads `owner` has in flight or answered but not yet taken. */
export function deploymentReadsPending(owner: object) { return verifying.get(owner)?.size ?? 0; }
/**
 * `read()`'s outcome, settled so a read left behind rejects nowhere, or `stillVerifying` once
 * `deadline` passes — at once for a read an earlier cycle started that has not landed. Single-flight
 * per owner and name across cycles; an answer taken frees its slot for the next cycle's read.
 */
export async function withinDeploymentBudget<T>(owner: object, name: string, read: () => Promise<T>, deadline: number, now: () => number): Promise<Settled<T> | typeof stillVerifying> {
  let reads = verifying.get(owner);
  if (!reads) verifying.set(owner, reads = new Map());
  let pending = reads.get(name) as Promise<Settled<T>> | undefined;
  const started = !pending;
  if (!pending) {
    // Started before the remaining budget is judged, as the faults step's reads are: what the read spends synchronously counts against it.
    let asked: Promise<T>;
    try { asked = read(); } catch (error) { asked = Promise.reject(error); }
    pending = asked.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    reads.set(name, pending);
  }
  const remaining = started ? deadline - now() : 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof stillVerifying>(resolve => { timer = setTimeout(() => resolve(stillVerifying), Math.max(0, remaining)); });
  try {
    const answer = await Promise.race([pending, expired]);
    if (answer !== stillVerifying && reads.get(name) === pending) reads.delete(name);
    return answer;
  } finally { clearTimeout(timer); }
}

// ——— Reusing the last verified observation (GY-1398) ———

/** How long a verified release observation is reused when nothing awaits it; `run.deploymentReuseMinutes` overrides. */
export const defaultDeploymentReuseMinutes = 15;
/**
 * Whether the step may stand on the last observation rather than read GitHub again. At a 300s
 * interval the live read cost ~9-14s of gh/git child-wait every cycle for an answer that almost
 * never changed, holding cycle p90 over its 30s bound. The last observation is reused only when it
 * verified a release (not unavailable), is younger than the window, left nothing pending, and
 * already places every delivered item — in its deployed set or its retained containment, which
 * records each delivery that release lineage serves. Anything else — an expired window, a delivery
 * landed since, a pending one, an unavailable observation — reads live exactly as before.
 */
export function reusableDeployment(last: DeploymentObservation | null | undefined, delivered: Work[], now: number, windowMs: number) {
  if (!last || last.source === 'unavailable' || !last.sha || last.pending.length || windowMs <= 0) return false;
  const age = now - Date.parse(last.at);
  if (!Number.isFinite(age) || age < 0 || age >= windowMs) return false;
  const deployed = new Set(last.deployed), settled = last.containment?.release === last.sha ? last.containment.settled : {};
  return delivered.every(item => deployed.has(item.key) || Object.hasOwn(settled, item.key));
}

/**
 * Local ancestry over this checkout's own object store, which is what "does the release contain
 * this merge" actually asks. The base branch is fetched once, lazily: an observation that answers
 * every delivery from the retained containment fetches nothing at all.
 */
export function localAncestry(root: string, baseBranch: string, run: ChildRun) {
  let fetched: string | null | undefined;
  const git = (...args: string[]) => run('git', ['-C', root, ...args]);
  const fetchBase = async () => {
    if (fetched !== undefined) return fetched;
    try { await git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`); fetched = null; }
    catch (error) { fetched = message(error).split('\n')[0]; }
    return fetched;
  };
  const held = async (ancestor: string, descendant: string): Promise<boolean | null> => {
    try { await git('merge-base', '--is-ancestor', ancestor, descendant); return true; }
    // Exit 1 is git's "not an ancestor". Anything else — a commit this checkout does not hold,
    // a broken repository — is unknown, and unknown containment is never read as deployed.
    catch (error: any) { return error?.status === 1 ? false : null; }
  };
  return {
    get fetchFailure() { return fetched || null; },
    /** `true`/`false` when git could answer, `null` when this checkout does not hold both commits. */
    async contains(ancestor: string, descendant: string): Promise<boolean | null> {
      if (ancestor === descendant) return true;
      await fetchBase();
      return held(ancestor, descendant);
    },
    /** GY-1831: `contains` over the commits the checkout already holds, fetching nothing — the
     * caller has just read a release whose observation fetched the base branch, or answers null. */
    containsHeld(ancestor: string, descendant: string): Promise<boolean | null> {
      if (ancestor === descendant) return Promise.resolve(true);
      return held(ancestor, descendant);
    },
  };
}
