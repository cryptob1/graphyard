// Concern: observing the deployed release and which deliveries it serves.
import { ciReportingEnvironment } from '../install/ci-proofs.js';
import { productionEnvironmentFromEnv } from '../flow-analytics.js';
import type { ChildRun } from '../child-runner.js';
import type { Work } from '../model.js';
import type { MasterConfig } from '../master.js';
import { boundDeployment, type ContainmentRetention, type DeploymentObservation, deploymentObservationSchema, message, retainedContainments } from './state.js';

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
 * deployment step costs the same on the first delivery as on the five hundredth. A configured
 * `--deployment-url` costs zero GitHub requests.
 */
export const deploymentPageSize = 100;
export const deploymentListingPages = 5;
export const maxDeploymentRequests = deploymentListingPages * 2;

/**
 * Local ancestry over this checkout's own object store, which is what "does the release contain
 * this merge" actually asks. The base branch is fetched once, lazily: an observation that answers
 * every delivery from the retained containment fetches nothing at all.
 */
function localAncestry(root: string, baseBranch: string, run: ChildRun) {
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
 * The latest status of each listed deployment, in listing order, in one GraphQL read: the REST API
 * has only a per-deployment status listing. A deployment whose status could not be read has no
 * entry (`undefined`); one with no status yet is `pending`.
 */
async function deploymentStates(repository: string, deployments: any[], run: ChildRun): Promise<{ states: (string | undefined)[]; failure: string | null }> {
  const ids = deployments.map(deployment => typeof deployment?.node_id === 'string' && deploymentNodeId.test(deployment.node_id) ? deployment.node_id : null);
  const readable = ids.filter((id): id is string => id !== null);
  if (!readable.length) return { states: [], failure: 'GitHub listed it without a node id' };
  let nodes: any[];
  try {
    const query = `query { nodes(ids: ${JSON.stringify(readable)}) { ... on Deployment { databaseId latestStatus { state } } } }`;
    const answer = JSON.parse(await run('gh', ['api', 'graphql', '-f', `query=${query}`]));
    nodes = Array.isArray(answer?.data?.nodes) ? answer.data.nodes : [];
  } catch (error) { return { states: [], failure: message(error) }; }
  const byId = new Map(readable.map((id, index) => [id, nodes[index]]));
  return {
    failure: null,
    states: deployments.map((deployment, index) => {
      const node = ids[index] === null ? undefined : byId.get(ids[index]!);
      // A node that answers for another deployment is not this one's status.
      if (!node || (node.databaseId !== undefined && node.databaseId !== deployment.id)) return undefined;
      return typeof node.latestStatus?.state === 'string' ? node.latestStatus.state.toLowerCase() : 'pending';
    }),
  };
}

export async function observeDeployment(config: MasterConfig, delivered: Work[], run: ChildRun, fetcher: typeof fetch = fetch, now = () => Date.now(),
  options: { root: string; retained?: ContainmentRetention | null }): Promise<DeploymentObservation> {
  const at = new Date(now()).toISOString();
  let requests = 0;
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
  } else {
    // Not filtered by ref: a platform that deploys the base branch (Railway) records each release
    // with its commit SHA as the ref, so `ref=main` saw only the CI reporting environment's records,
    // and on 2026-09-24 GY-159 stayed pending behind a release production had already served. The
    // listing is read page by page, newest first, until a release answers or a bound is reached.
    const releaseAncestry = localAncestry(options.root, config.baseBranch, run);
    let production: string;
    try { production = config.run.productionEnvironment ?? productionEnvironmentFromEnv(); } catch (error) { return unavailable(message(error)); }
    let listed = 0, exhausted = false;
    // Environments named like production under another identity, reported when no release is found
    // so an unconfigured Railway installation is told the name to configure rather than left pending.
    const namesake = new Set<string>();
    for (let page = 1; page <= deploymentListingPages && !sha && !exhausted; page++) {
      let deployments: any[];
      requests++;
      try { deployments = JSON.parse(await run('gh', ['api', `repos/${config.repository}/deployments?per_page=${deploymentPageSize}&page=${page}`])); }
      catch (error) {
        if (page === 1) return unavailable(`No deployment endpoint is configured and GitHub deployments are unavailable: ${message(error)}`);
        return unavailable(`No release was found in the first ${listed} GitHub deployment(s), and page ${page} of the listing could not be read: ${message(error)}`);
      }
      if (!Array.isArray(deployments)) deployments = [];
      listed += deployments.length;
      exhausted = deployments.length < deploymentPageSize;
      const candidates: any[] = [];
      for (const deployment of deployments) {
        // CI proof reporting records deployments too; it is never a release.
        if (deployment?.environment === ciReportingEnvironment) continue;
        // The base branch and its commits are deployed to staging and previews as readily as to
        // production, whether the ref names the branch or the commit; only the production
        // environment's record says what production serves.
        if (!productionEnvironmentRecord(deployment?.environment, production)) {
          if (typeof deployment?.environment === 'string' && deployment.environment.endsWith(` / ${production}`) && namesake.size < 5) namesake.add(deployment.environment);
          continue;
        }
        // A release is the base branch or a commit on it; another branch's deployment is not.
        const ref = typeof deployment?.ref === 'string' ? deployment.ref : null;
        if (ref && ref !== config.baseBranch) {
          if (typeof deployment.sha !== 'string' || ref.toLowerCase() !== deployment.sha.toLowerCase()) continue;
          if (await releaseAncestry.contains(deployment.sha.toLowerCase(), `refs/remotes/origin/${config.baseBranch}`) !== true) continue;
        }
        candidates.push(deployment);
      }
      if (!candidates.length) continue;
      requests++;
      const states = await deploymentStates(config.repository, candidates, run);
      // Newest first: the first success is the release. An attempt whose status cannot be read may
      // be the newest success, so no older release is taken past it: the observation is
      // unavailable, and every delivery stays pending.
      for (const [index, deployment] of candidates.entries()) {
        const state = states.states[index];
        if (state === undefined) return unavailable(`The status of ${production} deployment ${deployment.id} could not be read, so no older release is taken to be the one production serves${states.failure ? `: ${states.failure}` : ''}`);
        if (state === 'success' && typeof deployment.sha === 'string') { sha = deployment.sha.toLowerCase(); source = 'github-deployment'; break; }
      }
    }
    if (!listed) return unavailable('No deployment endpoint is configured and the repository records no GitHub deployment for the managed base branch');
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
  return deploymentObservationSchema.parse({ source, sha, at, reason: stale ? `Containment was derived without a fresh base branch: ${stale}` : null, deployed: deployed.slice(-200), pending: pending.slice(-200),
    requests, derived, retained: retainedCount, containment: { release: sha, settled: Object.fromEntries(keep) } });
}
