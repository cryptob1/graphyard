// Concern: observing the deployed release and which deliveries it serves.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ciReportingEnvironment } from '../install/ci-proofs.js';
import { productionEnvironmentFromEnv } from '../flow-analytics.js';
import type { ChildRun } from '../child-runner.js';
import type { Work } from '../model.js';
import type { MasterConfig } from '../master.js';
import type { MergerMode } from '../merger-mode.js';
import { localPromotionCycle, type LocalReleasePorts, type LocalRunOutcome } from './promotion-local.js';
import { actionableIntervalMs } from './liveness.js';
import { pinningVerify, retryPendingPin } from '../master/known-good.js';
import { installDirectory } from '../install/secrets.js';
import { installIdFor } from '../install/types.js';
import { boundDeployment, type ContainmentRetention, type DeploymentObservation, deploymentObservationSchema, message, type PromotionState, retainedContainments } from './state.js';

export function deploymentDetail(observation: DeploymentObservation) {
  if (observation.source === 'unavailable') return `Deployment SHA is unverified: ${observation.reason ?? 'no deployment observation is configured or available'}`;
  return `Deployed SHA ${observation.sha?.slice(0, 12) ?? 'unknown'} from ${observation.source}; verified ${observation.deployed.length} delivered item(s), ${observation.pending.length} not yet serving, from ${observation.requests ?? 0} GitHub request(s)${observation.reason ? `; ${observation.reason}` : ''}`;
}

/**
 * How many listing pages of `deploymentPageSize` the observation reads to find the release, and
 * therefore how many GitHub requests one observation may make: per page, the listing and at most
 * one batched read of its release candidates' latest statuses. Records that are not releases (the
 * CI reporting environment, other branches) are never asked about: on 2026-09-24 a single 20-entry
 * page could be filled by reporting records, hiding the release behind them. The statuses are read
 * a page at a time rather than one attempt at a time, so failed and pending production attempts
 * newer than the release production serves cost nothing extra and never stop the read short of it
 * (a per-attempt read bound left deliveries pending behind 20 failed attempts). Nothing below this
 * bound scales with how much has been delivered — containment is derived locally — so the cycle's
 * deployment step costs the same on the first delivery as on the five hundredth. The listing is the
 * production environment's alone; when it is empty, one unfiltered page is read to name a
 * misconfigured environment, inside the same bound. A configured `--deployment-url` costs zero
 * GitHub requests.
 */
export const deploymentPageSize = 100;
export const deploymentListingPages = 5;
export const maxDeploymentRequests = deploymentListingPages * 2;

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
  return {
    get fetchFailure() { return fetched || null; },
    /** `true`/`false` when git could answer, `null` when this checkout does not hold both commits. */
    async contains(ancestor: string, descendant: string): Promise<boolean | null> {
      if (ancestor === descendant) return true;
      await fetchBase();
      try { await git('merge-base', '--is-ancestor', ancestor, descendant); return true; }
      // Exit 1 is git's "not an ancestor". Anything else — a commit this checkout does not hold,
      // a broken repository — is unknown, and unknown containment is never read as deployed.
      catch (error: any) { return error?.status === 1 ? false : null; }
    },
  };
}

/**
 * The deployed commit, taken from a configured endpoint that reports it or from the provider's own
 * deployment record. A delivered item counts as deployed when the serving commit is its merge commit
 * or a descendant of it, so later merges do not make earlier ones look undeployed.
 *
 * Containment is derived from git, not from the forge: one fetch of the base branch and
 * `git merge-base --is-ancestor` per delivery whose containment this loop has not already
 * established. What it has established is retained with the release it was verified against, and
 * one ancestry check carries the whole retained set onto a release that descends from it — so a
 * steady cycle derives containment only for deliveries newer than the last observed release, and
 * the GitHub requests stay under `maxDeploymentRequests` however long the delivery history grows.
 * `root` is the managed repository's checkout, which every caller must name: the Graphyard
 * launcher's directory may be a checkout of another repository, or no checkout at all, and
 * ancestry asked there would leave every delivery pending without saying why.
 * A release that does not descend from the retained one (a rollback, an unrelated commit) drops
 * the retention and every delivery is derived again.
 */
/**
 * Whether a GitHub deployment's environment is the configured production environment (the master
 * run's `productionEnvironment`, else GRAPHYARD_PRODUCTION_ENVIRONMENT, else `production`), compared as the provider's whole
 * identity. Railway names the GitHub environment `<project> / <environment>`, and one repository can
 * deploy several Railway projects: `staging-copy / production` is not the managed installation's
 * release, so a Railway installation configures the full name (`graphyard / production`), as the
 * flow analytics' production phase already requires.
 */
export const productionEnvironmentRecord = (environment: unknown, production: string) => environment === production;

/** GitHub's node ids are opaque base64-like tokens; anything else is not sent inside a query. */
const deploymentNodeId = /^[A-Za-z0-9_=-]{1,200}$/;
/**
 * How many of a deployment's statuses the batched read asks for at each end of its history, to tell
 * whether it ever reached success: the earliest and the latest, GitHub's connection maximum each, so
 * the success is seen whichever order the connection lists them in and however many statuses were
 * added after it. Only a deployment with more than twice this many statuses, its success in the
 * middle, is unseen, and that one fails closed.
 */
const deploymentStatusHistory = 100;
/** States of a deployment still on its way: it does not serve yet, so it supersedes nothing. */
const inFlightStates = new Set(['pending', 'queued', 'in_progress', 'waiting']);
/**
 * How long a deployment may stay in flight and still not supersede the release behind it. A
 * deployment that never concludes — abandoned, or a `waiting` one held by a protection rule nobody
 * approves, or one with no status at all, which reads as `pending` — would otherwise keep an older
 * inactive release asserted as served indefinitely. Past this age, from its `created_at`, it counts
 * as a newer production record like any other; one whose age cannot be read never shadows.
 */
export const inFlightShadowBound = 60 * 60_000;
/**
 * The latest status of each listed deployment, in listing order, in one GraphQL read: the REST API
 * has only a per-deployment status listing. A deployment whose status could not be read has no
 * entry (`undefined`); one with no status yet is `pending`. `succeeded` says whether any of its
 * statuses is `success`: Railway marks each production deployment `inactive` minutes after it
 * succeeds, even while it is still the newest one and so the release production serves.
 */
async function deploymentStates(repository: string, deployments: any[], run: ChildRun): Promise<{ states: (string | undefined)[]; succeeded: boolean[]; failure: string | null }> {
  const ids = deployments.map(deployment => typeof deployment?.node_id === 'string' && deploymentNodeId.test(deployment.node_id) ? deployment.node_id : null);
  const readable = ids.filter((id): id is string => id !== null);
  if (!readable.length) return { states: [], succeeded: [], failure: 'GitHub listed it without a node id' };
  let nodes: any[];
  try {
    const query = `query { nodes(ids: ${JSON.stringify(readable)}) { ... on Deployment { databaseId latestStatus { state } statuses(first: ${deploymentStatusHistory}) { nodes { state } } recent: statuses(last: ${deploymentStatusHistory}) { nodes { state } } } } }`;
    const answer = JSON.parse(await run('gh', ['api', 'graphql', '-f', `query=${query}`]));
    nodes = Array.isArray(answer?.data?.nodes) ? answer.data.nodes : [];
  } catch (error) { return { states: [], succeeded: [], failure: message(error) }; }
  const byId = new Map(readable.map((id, index) => [id, nodes[index]]));
  // A node that answers for another deployment is not this one's status.
  const answers = deployments.map((deployment, index) => {
    const node = ids[index] === null ? undefined : byId.get(ids[index]!);
    return !node || (node.databaseId !== undefined && node.databaseId !== deployment.id) ? undefined : node;
  });
  return {
    failure: null,
    states: answers.map(node => node === undefined ? undefined : typeof node.latestStatus?.state === 'string' ? node.latestStatus.state.toLowerCase() : 'pending'),
    succeeded: answers.map(node => [node?.statuses?.nodes, node?.recent?.nodes].some(history => Array.isArray(history)
      && history.some((status: any) => typeof status?.state === 'string' && status.state.toLowerCase() === 'success'))),
  };
}

/** How long ago a listed deployment was created; never within the bound when GitHub gave no readable time. */
const inFlightAge = (deployment: any, at: number) => {
  const created = typeof deployment?.created_at === 'string' ? Date.parse(deployment.created_at) : Number.NaN;
  return Number.isFinite(created) ? at - created : Number.POSITIVE_INFINITY;
};

export async function observeDeployment(config: MasterConfig, delivered: Work[], run: ChildRun, fetcher: typeof fetch = fetch, now = () => Date.now(),
  options: { root: string; retained?: ContainmentRetention | null }): Promise<DeploymentObservation> {
  const at = new Date(now()).toISOString();
  let requests = 0;
  const unavailable = (reason: string): DeploymentObservation => boundDeployment({ source: 'unavailable', sha: null, at, reason, deployed: [], pending: delivered.map(item => item.key), requests, derived: 0, retained: 0, containment: options.retained ?? null });
  if (!delivered.length) return { source: 'unavailable', sha: null, at, reason: 'No delivered work is awaiting deployment verification', deployed: [], pending: [], requests, derived: 0, retained: 0, containment: options.retained ?? null };
  let sha: string | null = null, source: DeploymentObservation['source'] = 'unavailable', inactive: string | null = null;
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
  } else {
    // Filtered by environment, not by ref: a platform that deploys the base branch (Railway) records
    // each release with its commit SHA as the ref, so `ref=main` saw only the CI reporting
    // environment's records, and on 2026-09-24 GY-159 stayed pending behind a release production had
    // already served. Unfiltered, the reporting environment's per-branch records (100+ an hour) pushed
    // every production record past the read bound, and on 2026-10-02 a release production had served
    // for minutes was refused. The production environment's listing is read page by page, newest
    // first, until a release answers or a bound is reached.
    const releaseAncestry = localAncestry(options.root, config.baseBranch, run);
    let production: string;
    try { production = config.run.productionEnvironment ?? productionEnvironmentFromEnv(); } catch (error) { return unavailable(message(error)); }
    let listed = 0, exhausted = false;
    // Whether a production deployment newer than the one being read has been listed: a release
    // Railway marked inactive is served only while nothing newer was deployed to production.
    let newerProduction = false;
    // Environments named like production under another identity, reported when the production
    // environment records nothing so an unconfigured Railway installation is told the name to
    // configure rather than left pending. Only the unfiltered page below can list them.
    const namesake = new Set<string>();
    for (let page = 1; page <= deploymentListingPages && !sha && !exhausted; page++) {
      let deployments: any[];
      requests++;
      try { deployments = JSON.parse(await run('gh', ['api', `repos/${config.repository}/deployments?environment=${encodeURIComponent(production)}&per_page=${deploymentPageSize}&page=${page}`])); }
      catch (error) {
        if (page === 1) return unavailable(`No deployment endpoint is configured and GitHub deployments are unavailable: ${message(error)}`);
        return unavailable(`No release was found in the first ${listed} GitHub deployment(s), and page ${page} of the listing could not be read: ${message(error)}`);
      }
      if (!Array.isArray(deployments)) deployments = [];
      listed += deployments.length;
      exhausted = deployments.length < deploymentPageSize;
      const candidates: any[] = [];
      // The production records in listing order, each marked as a release candidate or not.
      const records: { deployment: any; candidate: boolean }[] = [];
      for (const deployment of deployments) {
        // CI proof reporting records deployments too; it is never a release.
        if (deployment?.environment === ciReportingEnvironment) continue;
        // The base branch and its commits are deployed to staging and previews as readily as to
        // production, whether the ref names the branch or the commit; only the production
        // environment's record says what production serves.
        if (!productionEnvironmentRecord(deployment?.environment, production)) continue;
        // A release is the base branch or a commit on it; another branch's deployment is not.
        const ref = typeof deployment?.ref === 'string' ? deployment.ref : null;
        let candidate = true;
        if (ref && ref !== config.baseBranch) {
          candidate = typeof deployment.sha === 'string' && ref.toLowerCase() === deployment.sha.toLowerCase()
            && await releaseAncestry.contains(deployment.sha.toLowerCase(), `refs/remotes/origin/${config.baseBranch}`) === true;
        }
        records.push({ deployment, candidate });
        if (candidate) candidates.push(deployment);
      }
      if (!candidates.length) { newerProduction ||= records.length > 0; continue; }
      requests++;
      const states = await deploymentStates(config.repository, candidates, run);
      // Newest first: the first success is the release. An attempt whose status cannot be read may
      // be the newest success, so no older release is taken past it: the observation is
      // unavailable, and every delivery stays pending. A deployment that reached success and was
      // later marked inactive is the release only when it is the newest production deployment of
      // all: Railway deactivates it minutes after success though production still serves it, while
      // GitHub deactivates it when a newer deployment succeeds. Behind any newer production record
      // — a successful one, a failed attempt, one whose status is unread or not a release — an
      // inactive deployment is never taken, so a superseded or rolled-back release is not served.
      // A newer release still pending, queued, in progress or waiting is the exception: production
      // keeps serving the release until it concludes, so a deploy window leaves no delivery pending.
      // The exception lasts `inFlightShadowBound` from the deployment's creation, so one that never
      // concludes stops shadowing the supersession. A newer record that is not a release is not
      // read, so it supersedes whatever its state: conservative, the delivery only stays pending.
      for (const { deployment, candidate } of records) {
        if (candidate) {
          const index = candidates.indexOf(deployment);
          const state = states.states[index];
          if (state === undefined) return unavailable(`The status of ${production} deployment ${deployment.id} could not be read, so no older release is taken to be the one production serves${states.failure ? `: ${states.failure}` : ''}`);
          if (typeof deployment.sha === 'string' && (state === 'success' || (state === 'inactive' && states.succeeded[index] && !newerProduction))) {
            sha = deployment.sha.toLowerCase(); source = 'github-deployment';
            if (state === 'inactive') inactive = `${production} deployment ${deployment.id} reached success and was later marked inactive with no newer ${production} deployment, so it is the release production serves`;
            break;
          }
          if (inFlightStates.has(state) && inFlightAge(deployment, now()) <= inFlightShadowBound) continue;
        }
        newerProduction = true;
      }
    }
    if (!listed) {
      // The production environment records nothing: one unfiltered page names any environment
      // called production under another identity, so an unconfigured Railway installation is told
      // the name to configure rather than left pending.
      requests++;
      try {
        const recent = JSON.parse(await run('gh', ['api', `repos/${config.repository}/deployments?per_page=${deploymentPageSize}&page=1`]));
        for (const deployment of Array.isArray(recent) ? recent : []) {
          if (typeof deployment?.environment === 'string' && deployment.environment !== production && deployment.environment.endsWith(` / ${production}`) && namesake.size < 5) namesake.add(deployment.environment);
        }
      } catch { /* the names are only a hint; the observation is unavailable either way */ }
      if (!namesake.size) return unavailable(`No deployment endpoint is configured and the repository records no GitHub deployment to the ${production} environment`);
    }
    // What lies past the listing bound is unread — a rollback to an older release included — so no
    // release is asserted, the last one observed neither: the observation is unavailable and says why.
    if (!sha && !exhausted) return unavailable(`None of the newest ${listed} GitHub deployment(s) is a successful ${production} release of the managed base branch, and older ones are past the ${deploymentListingPages}-page read bound, so the release production serves is not known`);
    if (!sha) return unavailable(`No GitHub deployment of the managed base branch to the ${production} environment reports a successful status${namesake.size
      ? `; deployments to ${[...namesake].map(name => `'${name}'`).join(', ')} are not the '${production}' environment — name the one production serves with graphyard master config productionEnvironment='${[...namesake][0]}' (or GRAPHYARD_PRODUCTION_ENVIRONMENT)`
      : ''}`);
  }
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
  const reasons = [inactive, stale ? `Containment was derived without a fresh base branch: ${stale}` : null].filter(Boolean);
  return deploymentObservationSchema.parse({ source, sha, at, reason: reasons.length ? reasons.join('; ') : null, deployed: deployed.slice(-200), pending: pending.slice(-200),
    requests, derived, retained: retainedCount, containment: { release: sha, settled: Object.fromEntries(keep) } });
}

// ——— The step's per-cycle budget (GY-1354) ———

/**
 * What the deployment step's reads — the release observation and the promotion check — may spend in
 * one cycle before the step moves on. While the plane and GitHub answered slowly on 2026-10-06 the
 * observation's listing pages, status reads and ancestry checks ran inline for 381.9s of cycle
 * 12621's 450s and 587.1s of cycle 12624's 781s, past the two-interval liveness bound. Like the
 * decisions step (GY-1286) and the faults step's observation (GY-1345), a fifth of the interval and
 * never under the 30s actionable cadence: a read still running at the bound is left in flight, the
 * last verified observation stands, and a later cycle takes the answer once it lands.
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

// ——— Promotion (GY-1302): the loop, not GitHub's cron, moves production along. ———

/** The workflow the loop dispatches with `promote=true`: it cuts a candidate of at most 10 merges (GY-1491), validates it in UAT, then promotes it. */
export const promotionWorkflow = 'release-candidate.yml';
/**
 * GY-1513: the advisory soak and timing-budget suites each candidate's run dispatches. Its runs are
 * never read as a candidate in validation, so the next candidate is cut while one soaks; they are
 * read only so `master status` shows each candidate's soak, running or concluded.
 */
export const soakWorkflow = 'release-candidate-soak.yml';
/** How many soak runs the loop keeps, newest first. */
export const promotionSoaksListed = 10;
/**
 * GY-1488: the minimum gap between two promotions the loop dispatches; `run.promoteEveryMinutes`, 0
 * turns promotion by the loop off. The loop cuts the next candidate as soon as none is in flight and
 * main has moved past both the last promoted SHA and the last cut, so this only spaces candidates
 * that conclude fast without promoting (a cut that fails early), rather than setting a fixed cadence;
 * a candidate that promoted is followed as soon as its run concludes (GY-1513).
 */
export const defaultPromoteEveryMinutes = 10;
/**
 * How long a read of the workflow's runs is reused while no candidate is in validation, so a gap or a
 * moving main costs one GitHub request a minute, not one a cycle. While one is in validation the runs
 * are read once an interval instead (GY-1513): its conclusion is what the next dispatch waits for, and
 * a candidate that promoted is followed within one loop interval of its run concluding.
 */
export const promotionRunsReadMs = 60_000;
/**
 * How long a read of the base branch tip and the last promotion record is reused. That read fetches
 * from the remote, so it runs once in this window rather than every cycle (at the default 20-second
 * interval, that would be about 4,300 fetches a day). A promotion waits at most this long for a move
 * of main, and `behind` in `master status` is at most this old.
 */
export const promotionLedgerReadMs = 5 * 60_000;
/**
 * GY-1398: the promotion reads' reuse windows at a loop interval. A window at or under the interval
 * is no window at all — every cycle reads — so at 300s both reads ran each cycle. The ledger is
 * reused for max(5 min, 3 intervals) and the run list for max(60 s, one interval) while nothing is in
 * validation; a promotion then waits at most three intervals for a move of main.
 */
export function promotionReadWindows(intervalMs: number) {
  return { ledgerMs: Math.max(promotionLedgerReadMs, 3 * intervalMs), runsMs: Math.max(promotionRunsReadMs, intervalMs) };
}
/**
 * GY-1513: while a candidate is in validation the run list is reused for one interval only, so the
 * conclusion the next dispatch waits for is seen within one interval of it, whatever the interval.
 */
export function promotionInFlightReadMs(intervalMs: number) {
  return intervalMs;
}
/**
 * GY-1488: how long the loop's own dispatch that GitHub does not list yet counts as a candidate in
 * flight. GitHub lists a dispatched run within seconds; past this a dispatch GitHub accepted but never
 * ran no longer holds promotion back.
 */
export const promotionUnlistedMs = 15 * 60_000;
/** Run states of a release candidate still being cut or validated. */
const runningStates = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

/** GY-1513: a candidate's recorded soak verdict (`rc-soak/ID`): passed, failed or cancelled, when, and the soak run that recorded it. */
export interface CandidateSoak { result: string; at: string; run: string | null }
/** GY-1491: one release candidate as the loop reads it: the merges it carries, those on main behind it now and its recorded soak verdict, if any (GY-1513). */
export interface PromotionCandidate { id: string; sha: string; cutAt: string; prs: number | null; queued: number | null; soak?: CandidateSoak | null }
/** How many of the newest candidates the loop reads and `master status` lists. */
export const promotionCandidatesListed = 5;
export interface PromotionLedger { mainSha: string | null; promotedSha: string | null; promotedAt: string | null; behind: number | null; candidates?: PromotionCandidate[] }
/** One run of the release-candidate workflow as `gh run list --json status,createdAt,event,headSha` lists it. */
export interface PromotionRun { status: string; createdAt: string; event: string; headSha?: string }
/** One run of the soak workflow: the SHA it soaks (from its run name), its status and, once concluded, its conclusion. */
export interface SoakRun { sha: string; status: string; conclusion: string | null; createdAt: string; url: string | null }
export interface PromotionReads {
  /** The base branch's tip, the newest `rc-production/` record, the first-parent merges between them and the newest `rc/` candidates. */
  ledger: () => Promise<PromotionLedger>;
  /** The workflow's recent runs, newest first. */
  runs: () => Promise<PromotionRun[]>;
  dispatch: () => Promise<void>;
  /** The soak workflow's recent runs, newest first; absent where the repository has no soak workflow. */
  soaks?: () => Promise<SoakRun[]>;
  /** GY-1526: the install's recorded merger; absent, or failing to read (an older server), the drive runs in github mode. */
  merger?: () => Promise<MergerMode>;
  /** GY-1526: the local port set control-plane mode runs candidates through (promotion-local.ts); null where the loop's environment names no UAT. */
  local?: LocalReleasePorts | null;
}
/** The reason control-plane mode reports when the loop's environment gives it no local release ports. */
export const noLocalPortsReason = 'The recorded merger is control-plane, so the loop cuts and promotes candidates itself, but its environment names no UAT: set GRAPHYARD_UAT_URL, GRAPHYARD_UAT_TOKEN and GRAPHYARD_PRODUCTION_URL for the loop';
/** The mode the drive runs in: control-plane only when the merger reads so; an unreadable merger is github's, as it is for an older server. */
export async function promotionMode(reads: Pick<PromotionReads, 'merger'>): Promise<MergerMode> {
  if (!reads.merger) return 'github';
  try { return await reads.merger(); } catch { return 'github'; }
}

/**
 * GY-1519: `frozen` is the main watch's freeze — the commit on main nothing Graphyard recorded
 * explains — and while it stands nothing is dispatched; the reason names the commit and the
 * acknowledgement that lifts it. `watchedTip` is the tip the watch last classified: given, a tip
 * the watch has not seen yet is not promoted either, so a foreign commit fetched this cycle waits
 * for the watch's verdict next cycle rather than riding a candidate before it. Both are left out
 * by a caller that did not ask for the freeze, and promotion runs as before.
 */
export interface PromotionOptions { now: number; everyMinutes: number; intervalMs?: number; frozen?: { sha: string; since: string } | null; watchedTip?: string | null }
export const promotionFrozenReason = (frozen: { sha: string; since: string }) =>
  `Promotion is frozen since ${frozen.since}: commit ${frozen.sha} on the base branch is explained by no merge ledger entry, delivery, revert or direct-merge window; an admin lifts it with graphyard master main-watch acknowledge ${frozen.sha} --reason TEXT --admin-token-stdin`;

const later = (...times: (string | null | undefined)[]) => times.filter((time): time is string => !!time && Number.isFinite(Date.parse(time)))
  .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

/**
 * One cycle of the promotion drive (GY-1488: continuous, not on a fixed cadence). The workflow is
 * dispatched with `promote=true` as soon as the base branch differs from the last promoted SHA and
 * from the SHA the last candidate cut, no release candidate is in validation, and `everyMinutes` (a
 * minimum gap) have passed since the last dispatch — the loop's own or a run GitHub lists (a
 * scheduled fallback run that does fire counts too). A candidate that concluded without promoting
 * is never cut again: the next waits until main moves past it. When a candidate concludes, the
 * ledger is re-read at once, so a promotion it just recorded or a merge since is seen without
 * waiting out the read window. Runs a pushed `rc-*` tag starts validate one pinned commit and
 * promote nothing, so they never hold a promotion back. A candidate carries at most 10 merges
 * (GY-1491): when the last run's candidate left merges queued behind it, the next is dispatched as
 * soon as it concludes, even though main has not moved since that dispatch.
 *
 * It never throws. A failed read or dispatch comes back as `failure` with the cycle's stamps kept:
 * a failed ledger read waits out its window and a failed run read its own (`promotionReadWindows`)
 * like a successful one, and a dispatch attempt is stamped before it is made, so a dispatch that
 * fails (or that GitHub accepted before `gh` failed) counts toward the gap and is never
 * repeated cycle after cycle.
 */
export async function promotionCycle(previous: PromotionState | null, reads: PromotionReads, options: PromotionOptions): Promise<{ state: PromotionState; dispatched: boolean; failure: string | null; /** GY-1526: what the local run did, in control-plane mode. */ run?: LocalRunOutcome }> {
  const at = new Date(options.now).toISOString(), everyMs = options.everyMinutes * 60_000, windows = promotionReadWindows(options.intervalMs ?? 0);
  const settle = (state: Omit<PromotionState, 'nextDueAt' | 'reason'>, reason: string, due: boolean) => ({ ...state, reason: reason.slice(0, 500),
    nextDueAt: due && state.lastDispatchAt ? new Date(Math.max(options.now, Date.parse(state.lastDispatchAt) + everyMs)).toISOString() : due ? at : null });
  const done = (state: Omit<PromotionState, 'nextDueAt' | 'reason'>, reason: string, due: boolean, dispatched = false) => ({ state: settle(state, reason, due), dispatched, failure: null });
  const failed = (state: Omit<PromotionState, 'nextDueAt' | 'reason'>, failure: string) => ({ state: settle(state, failure, true), dispatched: false, failure });
  const kept = { mainSha: previous?.mainSha ?? null, promotedSha: previous?.promotedSha ?? null, promotedAt: previous?.promotedAt ?? null, behind: previous?.behind ?? null, candidates: previous?.candidates ?? [], ledgerReadAt: previous?.ledgerReadAt ?? null };
  const readLedger = async () => { const read = await reads.ledger(); return { ...read, candidates: read.candidates ?? [] }; };
  const carried = { ...(previous?.soaks ? { soaks: previous.soaks } : {}), ...(previous?.soaksReadAt ? { soaksReadAt: previous.soaksReadAt } : {}), inFlight: previous?.inFlight ?? false, runsReadAt: previous?.runsReadAt ?? null, dispatchedAt: previous?.dispatchedAt ?? null, lastDispatchAt: previous?.lastDispatchAt ?? null, cutSha: previous?.cutSha ?? null,
    ...(previous?.candidateAtDispatch !== undefined ? { candidateAtDispatch: previous.candidateAtDispatch } : {}) };
  // Off reads nothing at all: no fetch, no GitHub request.
  if (options.everyMinutes <= 0) return done({ checkedAt: at, ...kept, ...carried }, 'Promotion by the loop is off (run.promoteEveryMinutes is 0)', false);
  // GY-1526: under a control-plane merger the loop runs the candidate itself through its local ports; the workflow is neither read nor dispatched.
  if (await promotionMode(reads) === 'control-plane') {
    if (!reads.local) return done({ checkedAt: at, ...kept, ...carried }, noLocalPortsReason, false);
    return localPromotionCycle(previous, { ...reads, local: reads.local }, options);
  }
  let ledger = kept;
  if (!kept.ledgerReadAt || options.now - Date.parse(kept.ledgerReadAt) >= windows.ledgerMs) {
    try { ledger = { ...await readLedger(), ledgerReadAt: at }; } catch (error) {
      return failed({ checkedAt: at, ...kept, ledgerReadAt: at, ...carried }, `The base branch and the promotion record could not be read: ${message(error)}`);
    }
  }
  const base = { checkedAt: at, ...ledger, ...carried, ...await soakRefresh(carried, ledger.candidates ?? [], reads, options.now, windows.runsMs) };
  if (!ledger.mainSha) return done(base, 'The base branch tip could not be read, so nothing is promoted', false);
  if (ledger.mainSha === ledger.promotedSha) return done(base, 'Production runs the base branch tip; nothing to promote', false);
  // GY-1519: the main watch's freeze holds every dispatch; a tip it has not classified waits for it.
  if (options.frozen) return done(base, promotionFrozenReason(options.frozen), false);
  if (options.watchedTip !== undefined && options.watchedTip !== ledger.mainSha) return done(base, `The main watch has not classified the base branch tip ${ledger.mainSha.slice(0, 12)} yet; promotion waits for its verdict`, true);
  const sinceLast = base.lastDispatchAt ? options.now - Date.parse(base.lastDispatchAt) : Number.POSITIVE_INFINITY;
  const gapReason = (since: number) => `The last promotion was dispatched ${Math.round(since / 60_000)} minute(s) ago; the next is due no sooner than ${options.everyMinutes} minute(s) after it`;
  // GY-1513: in flight, the runs are read once an interval, so the conclusion the next dispatch waits for is seen within one.
  const runsDue = !base.runsReadAt || options.now - Date.parse(base.runsReadAt) >= (base.inFlight ? promotionInFlightReadMs(options.intervalMs ?? 0) : windows.runsMs);
  // While a candidate is in flight its runs are still read, so a promotion it made inside the gap is seen (GY-1513).
  if (sinceLast < everyMs && !(base.inFlight && runsDue)) return done(base, gapReason(sinceLast), true);
  let state = base;
  if (runsDue) {
    let listed: PromotionRun[];
    try { listed = await reads.runs(); } catch (error) {
      return failed({ ...base, runsReadAt: at }, `The ${promotionWorkflow} runs could not be read: ${message(error)}`);
    }
    const cuts = listed.filter(run => run.event === 'workflow_dispatch' || run.event === 'schedule');
    const newest = [...cuts].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    // The newest listed cut names the SHA it covered, unless the loop's own later dispatch is not listed yet.
    const listedCut = newest?.headSha && (!base.dispatchedAt || Date.parse(newest.createdAt) >= Date.parse(base.dispatchedAt)) ? newest.headSha.toLowerCase() : null;
    const unlisted = !!base.dispatchedAt && (!newest || Date.parse(newest.createdAt) < Date.parse(base.dispatchedAt)) && options.now - Date.parse(base.dispatchedAt) < promotionUnlistedMs;
    state = { ...base, runsReadAt: at, inFlight: unlisted || cuts.some(run => runningStates.has(run.status)), lastDispatchAt: later(base.dispatchedAt, ...cuts.map(run => run.createdAt)), cutSha: listedCut ?? base.cutSha };
    const since = state.lastDispatchAt ? options.now - Date.parse(state.lastDispatchAt) : Number.POSITIVE_INFINITY;
    if (base.inFlight && !state.inFlight && state.ledgerReadAt !== at) {
      // The candidate just concluded: what it promoted, and any merge since, is read now rather than a window later.
      try { state = { ...state, ...await readLedger(), ledgerReadAt: at }; } catch (error) {
        return failed({ ...state, ledgerReadAt: at }, `The base branch and the promotion record could not be read: ${message(error)}`);
      }
      if (!state.mainSha) return done(state, 'The base branch tip could not be read, so nothing is promoted', false);
      if (state.mainSha === state.promotedSha) return done(state, 'Production runs the base branch tip; nothing to promote', false);
    }
    // GY-1513: the gap spaces candidates that fail fast; one that promoted since the last dispatch (about 8 minutes in, the soak no longer in its run) is followed at once.
    const promotedSince = !state.inFlight && !!state.promotedAt && !!state.lastDispatchAt && Date.parse(state.promotedAt) >= Date.parse(state.lastDispatchAt);
    if (since < everyMs && !promotedSince && state.lastDispatchAt === base.lastDispatchAt) return done(state, gapReason(since), true);
    if (since < everyMs && !promotedSince) return done(state, `A release candidate was started ${Math.round(since / 60_000)} minute(s) ago; the next promotion is due no sooner than ${options.everyMinutes} minute(s) after it`, true);
  }
  if (state.inFlight) return done(state, 'A release candidate is still in validation; the next promotion is dispatched as soon as it concludes', true);
  // The candidate the last run cut, when it stopped short of main's tip at the PR cap: the merges queued behind it need no new merge to go out.
  // It is told by its id differing from the newest candidate at the loop's last dispatch, not by clocks, so a run that cut nothing re-dispatches nothing.
  const newest = state.candidates?.[0];
  const queued = newest && state.candidateAtDispatch !== undefined && newest.id !== state.candidateAtDispatch && newest.sha !== state.mainSha && (newest.queued ?? 0) > 0 ? newest : null;
  if (state.cutSha && state.cutSha === state.mainSha && !queued) return done(state, `The last release candidate cut ${state.cutSha.slice(0, 12)} and did not promote it; the next is dispatched as soon as main moves past it`, false);
  const mainSha = state.mainSha!;
  // The attempt is stamped before it is made: whatever the dispatch's outcome, the next waits out the gap.
  // A refused dispatch keeps the cut and the candidate it would have followed, so merges queued behind that candidate are retried after the gap.
  const attempted = { ...state, dispatchedAt: at, lastDispatchAt: at, runsReadAt: at };
  try { await reads.dispatch(); } catch (error) {
    return failed(attempted, `Dispatching ${promotionWorkflow} with promote=true failed; the next attempt is due ${options.everyMinutes} minute(s) after this one: ${message(error)}`);
  }
  return done({ ...attempted, cutSha: mainSha, candidateAtDispatch: newest?.id ?? null, inFlight: true }, queued ? `Dispatched ${promotionWorkflow} with promote=true for the ${queued.queued} merge(s) queued behind candidate ${queued.id}`
    : `Dispatched ${promotionWorkflow} with promote=true to carry ${mainSha.slice(0, 12)} to production`, true, true);
}

/**
 * What `master status` reports of the promotion drive: the last promoted SHA, how far production is
 * behind, when the next promotion is due, and the newest candidates with each one's PR count, the
 * merges queued behind it and its advisory soak (GY-1513): `running` while its run is, else the
 * run's conclusion; null when no soak run of that SHA has been read.
 */
export function promotionStatus(state: PromotionState | null | undefined) {
  if (!state) return { lastPromotedSha: null, promotedAt: null, behind: null, nextDueAt: null, inFlight: false, checkedAt: null, candidates: [], reason: 'The loop has not checked promotion yet' };
  return { lastPromotedSha: state.promotedSha, promotedAt: state.promotedAt, behind: state.behind, nextDueAt: state.nextDueAt, inFlight: state.inFlight, checkedAt: state.checkedAt,
    candidates: (state.candidates ?? []).map(candidate => ({ id: candidate.id, sha: candidate.sha, prs: candidate.prs, queued: candidate.queued, soak: soakOf(state.soaks, candidate) })), reason: state.reason };
}

/**
 * GY-1513: the soak runs, re-read once a run-read window while one is running or the newest
 * candidate, cut within `soakAwaitedMs`, has none listed yet — so a soak that outlives its promotion
 * is seen to conclude while the loop otherwise reads nothing. A failed read keeps the last one: the
 * soak is advisory and never holds promotion back.
 */
async function soakRefresh(carried: Pick<PromotionState, 'soaks' | 'soaksReadAt'>, candidates: PromotionCandidate[], reads: PromotionReads, now: number, windowMs: number) {
  if (!reads.soaks || (carried.soaksReadAt && now - Date.parse(carried.soaksReadAt) < windowMs)) return {};
  const newest = candidates[0], soaks = carried.soaks ?? [];
  const awaited = !!newest && !newest.soak && now - Date.parse(newest.cutAt) < soakAwaitedMs && !soaks.some(run => run.sha === newest.sha);
  if (!awaited && !soaks.some(run => runningStates.has(run.status))) return {};
  const soaksReadAt = new Date(now).toISOString();
  try { return { soaks: (await reads.soaks()).slice(0, promotionSoaksListed), soaksReadAt }; } catch { return { soaksReadAt }; }
}
/** How long after its cut a candidate's soak is looked for before the loop stops reading for it. */
export const soakAwaitedMs = 90 * 60_000;

/**
 * A candidate's soak as `master status` shows it: `running` while its newest soak run is, else the
 * verdict its record carries (passed, failed, cancelled), else that run's conclusion in the same words.
 */
function soakOf(soaks: PromotionState['soaks'], candidate: PromotionCandidate) {
  const run = soaks?.find(entry => entry.sha === candidate.sha.toLowerCase());
  if (run && runningStates.has(run.status)) return { state: 'running', startedAt: run.createdAt, url: run.url };
  if (candidate.soak) return { state: candidate.soak.result, at: candidate.soak.at, url: candidate.soak.run };
  return run ? { state: soakVerdict(run.conclusion ?? run.status), startedAt: run.createdAt, url: run.url } : null;
}
/** A soak run's conclusion in the record's words: success is passed, failure failed; the rest stand. */
const soakVerdict = (conclusion: string) => conclusion === 'success' ? 'passed' : conclusion === 'failure' ? 'failed' : conclusion;

/** The promotion reads over the managed checkout and GitHub; null when the repository has no release-candidate workflow to dispatch and no local ports (GY-1526). */
export function promotionReads(config: MasterConfig, root: string, run: ChildRun, workflowExists: boolean, soakExists = existsSync(join(root, '.github', 'workflows', soakWorkflow)),
  options: { merger?: () => Promise<MergerMode>; local?: LocalReleasePorts | null } = {}): PromotionReads | null {
  // GY-1526: without the workflow there is nothing to dispatch in github mode, but control-plane mode needs only the local ports.
  if (!workflowExists && !options.local) return null;
  // GY-1529: production verified serving the promoted SHA is what moves the known-good coordinator pin; a failed verify pins nothing.
  const known = { installDir: installDirectory(installIdFor(config.repository)), repository: root };
  const local = options.local ? { ...options.local, verify: pinningVerify(known, run, options.local.verify) } : options.local;
  const git = (...args: string[]) => run('git', ['-C', root, ...args]);
  return {
    ...(options.merger ? { merger: options.merger } : {}), ...(local !== undefined ? { local } : {}),
    ledger: async () => {
      await git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${config.baseBranch}:refs/remotes/origin/${config.baseBranch}`, '+refs/tags/rc-production/*:refs/tags/rc-production/*', '+refs/tags/rc/*:refs/tags/rc/*', '+refs/tags/rc-soak/*:refs/tags/rc-soak/*');
      const mainSha = (await git('rev-parse', `refs/remotes/origin/${config.baseBranch}^{commit}`)).trim().toLowerCase() || null;
      let promotedSha: string | null = null, promotedAt: string | null = null;
      try {
        const record = JSON.parse((await git('for-each-ref', '--sort=-refname', '--count=1', '--format=%(contents)', 'refs/tags/rc-production/')).trim());
        promotedSha = typeof record?.sha === 'string' ? record.sha.toLowerCase() : null;
        promotedAt = typeof record?.at === 'string' ? record.at : null;
      } catch { /* no production record yet */ }
      // GY-1529: a pin that failed after verification is retried here, every cycle, without repeating the promotion.
      await retryPendingPin(known, run, promotedSha).catch(() => null);
      let behind: number | null = null;
      if (mainSha && promotedSha) {
        try { behind = Number((await git('rev-list', '--first-parent', '--count', `${promotedSha}..${mainSha}`)).trim()); } catch { behind = null; }
        if (!Number.isInteger(behind)) behind = null;
      }
      const candidates: PromotionCandidate[] = [];
      // GY-1513: the recorded soak verdicts, by candidate; the soak workflow records one per candidate once its run concludes.
      const soaked = new Map<string, CandidateSoak>();
      for (const record of await tagRecords(git, 'refs/tags/rc-soak/', 2 * promotionCandidatesListed))
        if (typeof record?.id === 'string' && typeof record?.result === 'string') soaked.set(record.id, { result: record.result, at: typeof record.at === 'string' ? record.at : '', run: typeof record.run === 'string' ? record.run : null });
      for (const record of await tagRecords(git, 'refs/tags/rc/', promotionCandidatesListed)) {
        if (typeof record?.id !== 'string' || typeof record?.sha !== 'string' || typeof record?.cutAt !== 'string') continue;
        const sha = record.sha.toLowerCase();
        let queued: number | null = null;
        if (mainSha) try { queued = Number((await git('rev-list', '--first-parent', '--count', `${sha}..${mainSha}`)).trim()); } catch { queued = null; }
        candidates.push({ id: record.id, sha, cutAt: record.cutAt, prs: Number.isInteger(record.prs) ? record.prs : null, queued: Number.isInteger(queued) ? queued : null, soak: soaked.get(record.id) ?? null });
      }
      return { mainSha, promotedSha, promotedAt, behind, candidates };
    },
    runs: async () => {
      const listed = JSON.parse(await run('gh', ['run', 'list', '--repo', config.repository, '--workflow', promotionWorkflow, '--limit', '50', '--json', 'status,createdAt,event,headSha']));
      return Array.isArray(listed) ? listed.filter(entry => typeof entry?.status === 'string' && typeof entry?.createdAt === 'string' && typeof entry?.event === 'string') : [];
    },
    dispatch: async () => { await run('gh', ['workflow', 'run', promotionWorkflow, '--repo', config.repository, '--ref', config.baseBranch, '-f', 'promote=true']); },
    ...(soakExists ? { soaks: async () => soakRuns(JSON.parse(await run('gh', ['run', 'list', '--repo', config.repository, '--workflow', soakWorkflow, '--limit', '20', '--json', 'status,conclusion,createdAt,displayTitle,url']))) } : {}),
  };
}

/** The newest `count` records under a ledger tag prefix, as the annotated tags' JSON messages; unparsable ones are skipped. */
async function tagRecords(git: (...args: string[]) => string | Promise<string>, prefix: string, count: number): Promise<any[]> {
  let listed = '';
  try { listed = await git('for-each-ref', '--sort=-refname', `--count=${count}`, '--format=%(contents)%00', prefix); } catch { /* no record yet */ }
  return listed.split('\0').flatMap(body => { try { return [JSON.parse(body.trim())]; } catch { return []; } });
}

/** Soak runs as `gh run list` lists them, newest first, each with the SHA its run name (`Soak ID SHA`) carries; a run naming none is skipped. */
export function soakRuns(listed: unknown): SoakRun[] {
  if (!Array.isArray(listed)) return [];
  return listed.flatMap(entry => {
    const sha = typeof entry?.displayTitle === 'string' ? entry.displayTitle.match(/\b[0-9a-f]{40}\b/i)?.[0]?.toLowerCase() : undefined;
    if (!sha || typeof entry.status !== 'string' || typeof entry.createdAt !== 'string') return [];
    return [{ sha, status: entry.status, conclusion: typeof entry.conclusion === 'string' && entry.conclusion ? entry.conclusion : null, createdAt: entry.createdAt, url: typeof entry.url === 'string' ? entry.url : null }];
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
