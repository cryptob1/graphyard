// Concern: observing the deployed release and which deliveries it serves.
import { ciReportingEnvironment } from '../install/ci-proofs.js';
import { productionEnvironmentFromEnv } from '../flow-analytics.js';
import type { ChildRun } from '../child-runner.js';
import type { Work } from '../model.js';
import type { MasterConfig } from '../master.js';
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

// ——— Promotion (GY-1302): the loop, not GitHub's cron, moves production along. ———

/** The workflow the loop dispatches with `promote=true`: it cuts main's tip, validates it in UAT, then promotes it. */
export const promotionWorkflow = 'release-candidate.yml';
/** How often, at most, the loop dispatches a promotion when main has moved; `run.promoteEveryMinutes`, 0 turns it off. */
export const defaultPromoteEveryMinutes = 120;
/** How long a read of the workflow's runs is reused, so a candidate in UAT for hours costs one GitHub request a minute, not one a cycle. */
export const promotionRunsReadMs = 60_000;
/**
 * How long a read of the base branch tip and the last promotion record is reused. That read fetches
 * from the remote, so it runs once in this window rather than every cycle (at the default 20-second
 * interval, that would be about 4,300 fetches a day). A promotion waits at most this long for a move
 * of main, and `behind` in `master status` is at most this old.
 */
export const promotionLedgerReadMs = 5 * 60_000;
/** Run states of a release candidate still being cut or validated. */
const runningStates = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

export interface PromotionLedger { mainSha: string | null; promotedSha: string | null; promotedAt: string | null; behind: number | null }
/** One run of the release-candidate workflow as `gh run list --json status,createdAt,event` lists it. */
export interface PromotionRun { status: string; createdAt: string; event: string }
export interface PromotionReads {
  /** The base branch's tip, the newest `rc-production/` record and the first-parent merges between them. */
  ledger: () => Promise<PromotionLedger>;
  /** The workflow's recent runs, newest first. */
  runs: () => Promise<PromotionRun[]>;
  dispatch: () => Promise<void>;
}

const later = (...times: (string | null | undefined)[]) => times.filter((time): time is string => !!time && Number.isFinite(Date.parse(time)))
  .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

/**
 * One cycle of the promotion drive. The workflow is dispatched with `promote=true` exactly when the
 * base branch differs from the last promoted SHA, no release candidate is in validation, and
 * `everyMinutes` have passed since the last dispatch — the loop's own or a run GitHub lists (a
 * scheduled run that does fire counts too, so the cadence never doubles). Runs a pushed `rc-*` tag
 * starts validate one pinned commit and promote nothing, so they never hold a promotion back.
 */
export async function promotionCycle(previous: PromotionState | null, reads: PromotionReads, options: { now: number; everyMinutes: number }): Promise<{ state: PromotionState; dispatched: boolean }> {
  const at = new Date(options.now).toISOString(), everyMs = options.everyMinutes * 60_000;
  const settle = (state: Omit<PromotionState, 'nextDueAt' | 'reason'>, reason: string, due: boolean) => ({ ...state, reason,
    nextDueAt: due && state.lastDispatchAt ? new Date(Math.max(options.now, Date.parse(state.lastDispatchAt) + everyMs)).toISOString() : due ? at : null });
  const kept = { mainSha: previous?.mainSha ?? null, promotedSha: previous?.promotedSha ?? null, promotedAt: previous?.promotedAt ?? null, behind: previous?.behind ?? null, ledgerReadAt: previous?.ledgerReadAt ?? null };
  const carried = { inFlight: previous?.inFlight ?? false, runsReadAt: previous?.runsReadAt ?? null, dispatchedAt: previous?.dispatchedAt ?? null, lastDispatchAt: previous?.lastDispatchAt ?? null };
  // Off reads nothing at all: no fetch, no GitHub request.
  if (options.everyMinutes <= 0) return { state: settle({ checkedAt: at, ...kept, ...carried }, 'Promotion by the loop is off (run.promoteEveryMinutes is 0)', false), dispatched: false };
  const fresh = kept.ledgerReadAt && options.now - Date.parse(kept.ledgerReadAt) < promotionLedgerReadMs;
  const ledger = fresh ? kept : { ...await reads.ledger(), ledgerReadAt: at };
  const base = { checkedAt: at, ...ledger, ...carried };
  if (!ledger.mainSha) return { state: settle(base, 'The base branch tip could not be read, so nothing is promoted', false), dispatched: false };
  if (ledger.mainSha === ledger.promotedSha) return { state: settle(base, 'Production runs the base branch tip; nothing to promote', false), dispatched: false };
  const sinceLast = base.lastDispatchAt ? options.now - Date.parse(base.lastDispatchAt) : Number.POSITIVE_INFINITY;
  if (sinceLast < everyMs) return { state: settle(base, `The last promotion was dispatched ${Math.round(sinceLast / 60_000)} minute(s) ago; the next is due ${options.everyMinutes} minute(s) after it`, true), dispatched: false };
  let state = base;
  if (!base.runsReadAt || options.now - Date.parse(base.runsReadAt) >= promotionRunsReadMs) {
    const cuts = (await reads.runs()).filter(run => run.event === 'workflow_dispatch' || run.event === 'schedule');
    state = { ...base, runsReadAt: at, inFlight: cuts.some(run => runningStates.has(run.status)), lastDispatchAt: later(base.dispatchedAt, ...cuts.map(run => run.createdAt)) };
    const since = state.lastDispatchAt ? options.now - Date.parse(state.lastDispatchAt) : Number.POSITIVE_INFINITY;
    if (since < everyMs) return { state: settle(state, `A release candidate was started ${Math.round(since / 60_000)} minute(s) ago; the next promotion is due ${options.everyMinutes} minute(s) after it`, true), dispatched: false };
  }
  if (state.inFlight) return { state: settle(state, 'A release candidate is still in validation; the next promotion waits for it to conclude', true), dispatched: false };
  await reads.dispatch();
  const dispatched = { ...state, dispatchedAt: at, lastDispatchAt: at, inFlight: true, runsReadAt: at };
  return { state: settle(dispatched, `Dispatched ${promotionWorkflow} with promote=true to carry ${ledger.mainSha.slice(0, 12)} to production`, true), dispatched: true };
}

/** What `master status` reports of the promotion drive: the last promoted SHA, how far production is behind, and when the next promotion is due. */
export function promotionStatus(state: PromotionState | null | undefined) {
  if (!state) return { lastPromotedSha: null, promotedAt: null, behind: null, nextDueAt: null, inFlight: false, checkedAt: null, reason: 'The loop has not checked promotion yet' };
  return { lastPromotedSha: state.promotedSha, promotedAt: state.promotedAt, behind: state.behind, nextDueAt: state.nextDueAt, inFlight: state.inFlight, checkedAt: state.checkedAt, reason: state.reason };
}

/** The promotion reads over the managed checkout and GitHub; null when the repository has no release-candidate workflow to dispatch. */
export function promotionReads(config: MasterConfig, root: string, run: ChildRun, workflowExists: boolean): PromotionReads | null {
  if (!workflowExists) return null;
  const git = (...args: string[]) => run('git', ['-C', root, ...args]);
  return {
    ledger: async () => {
      await git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${config.baseBranch}:refs/remotes/origin/${config.baseBranch}`, '+refs/tags/rc-production/*:refs/tags/rc-production/*');
      const mainSha = (await git('rev-parse', `refs/remotes/origin/${config.baseBranch}^{commit}`)).trim().toLowerCase() || null;
      let promotedSha: string | null = null, promotedAt: string | null = null;
      try {
        const record = JSON.parse((await git('for-each-ref', '--sort=-refname', '--count=1', '--format=%(contents)', 'refs/tags/rc-production/')).trim());
        promotedSha = typeof record?.sha === 'string' ? record.sha.toLowerCase() : null;
        promotedAt = typeof record?.at === 'string' ? record.at : null;
      } catch { /* no production record yet */ }
      let behind: number | null = null;
      if (mainSha && promotedSha) {
        try { behind = Number((await git('rev-list', '--first-parent', '--count', `${promotedSha}..${mainSha}`)).trim()); } catch { behind = null; }
        if (!Number.isInteger(behind)) behind = null;
      }
      return { mainSha, promotedSha, promotedAt, behind };
    },
    runs: async () => {
      const listed = JSON.parse(await run('gh', ['run', 'list', '--repo', config.repository, '--workflow', promotionWorkflow, '--limit', '50', '--json', 'status,createdAt,event']));
      return Array.isArray(listed) ? listed.filter(entry => typeof entry?.status === 'string' && typeof entry?.createdAt === 'string' && typeof entry?.event === 'string') : [];
    },
    dispatch: async () => { await run('gh', ['workflow', 'run', promotionWorkflow, '--repo', config.repository, '--ref', config.baseBranch, '-f', 'promote=true']); },
  };
}
