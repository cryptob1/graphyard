import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentOwner, type AttentionItem } from './master.js';
import { actionIdleMs, actionRetryDelay, type ActionRecord, type ActionRow } from './model/actions.js';
import { acceptedMergeAt, nearestRankPercentiles, pipelineSpeed, type Percentiles } from './pipeline-speed.js';
import type { Work } from './model.js';

/**
 * Post-deploy verification of GY-87's throughput claim (GY-99).
 *
 * GY-87 inverted coordination: the control plane computes a typed next action per item, durable
 * leased rows say whether anybody is running it, and stateless executors claim and run them. Its
 * throughput claim — a routine delivery submits to merge in at most half an hour at the median,
 * and nothing that has something to do waits longer than the idle bound for somebody to do it —
 * was demonstrated over a simulated fleet in `tests/action-queue.test.ts`. A simulation says the
 * arithmetic holds; it does not say the deployed release does.
 *
 * This module says whether it does, and it reads only what really happened: the deployed control
 * plane's own ledger, through the documents it serves. Every figure comes from the item's own
 * pipeline timeline and its own durable action rows — the same records master status reads, and
 * the same percentile estimator (`pipeline-speed.ts`), so the two can never disagree. Nothing
 * here is generated, seeded or stood in for: `realDelivery` refuses anything that is not a merged
 * pull request of the managed repository, and an item with no executed action row proves nothing
 * about an executor-driven pipeline and is never admitted.
 *
 * The population rule is the delicate part, so it is written to be audited rather than trusted.
 * A delivery is admitted only when the record shows executors drove it and no coordinator was
 * present (`coordinatorFingerprints`), and every excluded delivery is reported beside the
 * admitted ones **with its own figures and the reason it was excluded**. Narrowing a population
 * until it passes is the failure mode GY-99's AC-3 names; a report that shows the window as a
 * whole beside the admitted population (`all`, `populationEffect`) makes that narrowing visible
 * instead of silent. The budgets below are the claim's own and are never relaxed by anything in
 * this file: a miss is a finding with the measured values and a named follow-up.
 */

/** GY-87's claim, in its own numbers. Nothing in this module may loosen one. */
export const throughputClaim = {
  item: 'GY-87',
  statement: 'Stateless executors drive routine deliveries with no master session running: first-submit-to-merge p50 at most 30 minutes, and no item idle but actionable for longer than 5 minutes.',
  submitToMergeP50Ms: 30 * 60_000,
  /** The control plane's own idle bound, so the claim and the queue are judged against one number. */
  idleActionableMs: actionIdleMs,
  minimumDeliveries: 10,
} as const;

/** The release the measurement was taken against, as the deployed control plane reported itself. */
export interface DeployedRelease {
  /** The Git revision the running image was built from; `unknown` when the build never stamped one. */
  revision: string | null;
  /** Which field of the deployment named the revision (`deployedRevision`); absent on older reports. */
  revisionSource?: 'release.revision' | 'build.commit' | null;
  version: string | null;
  /** The origin the ledger and the release were read from, so a reader can repeat the read. */
  origin: string;
  observedAt: string;
  /**
   * Whether the deployed revision contains the claim's own merge commit — the check that makes
   * this a measurement of GY-87's executors rather than of whatever preceded them. `null` when
   * ancestry could not be established from where the measurement ran, with the reason.
   */
  containsClaim: boolean | null;
  reason: string | null;
}

/** One action row of a delivery, as the population rule reads it: who ran it, and how long it waited. */
export interface ActionExecution {
  id: string; kind: string; key: string;
  /** The executor that claimed the row and the host it ran on; null while nobody ever claimed it. */
  executor: string | null; host: string | null;
  attempts: number; requestedAt: string; claimedAt: string | null; settledAt: string | null;
  result: 'done' | 'failed' | null;
  /** True when the row was superseded before anybody executed it: something outside the queue moved the item on. */
  supersededUnexecuted: boolean;
  /** The longest this row was actionable with nobody running it, and when that wait started. */
  idleMs: number; idleSince: string | null;
  resolution: string | null;
}

/** One delivery as the report names it: its figures, its action rows, and why it is in or out. */
export interface DeliveryRecord {
  key: string; work: string; pr: number | null; mergeSha: string | null;
  mergedAt: string; submittedAt: string | null; submitToMergeMs: number | null;
  actions: ActionExecution[];
  /** Every executor that claimed one of this delivery's actions, so a reader can check who was present. */
  executors: string[];
  idle: { ms: number; action: string; kind: string; since: string | null } | null;
  admitted: boolean;
  /** Empty when admitted; otherwise every reason this delivery is not in the population. */
  exclusions: string[];
}

export interface ThroughputShortfall {
  measured: { deliveries: number; submitToMergeP50Ms: number | null; idleMaxMs: number | null };
  missed: { metric: 'deployed-release' | 'population' | 'submit-to-merge-p50' | 'idle-actionable'; measured: number | null; budget: number; by: number | null; text: string }[];
  finding: string;
  followUp: { title: string; description: string };
}

export interface ThroughputReport {
  measuredAt: string;
  claim: typeof throughputClaim;
  deployed: DeployedRelease;
  window: { since: string | null; until: string | null; basis: WindowBasis; reason: string };
  population: { rule: string; delivered: number; real: number; admitted: number; excluded: number };
  deliveries: DeliveryRecord[];
  excluded: DeliveryRecord[];
  submitToMerge: Percentiles;
  idle: { maxMs: number | null; key: string | null; action: string | null; kind: string | null };
  /** The same figures over every real delivery in the window, admitted or not: the check on the rule. */
  all: { count: number; submitToMerge: Percentiles; idleMaxMs: number | null };
  /** Set when the exclusions flatter the result, naming by how much; null when they do not. */
  populationEffect: string | null;
  met: boolean | null;
  verdict: 'verified' | 'unverified';
  reason: string;
  shortfall: ThroughputShortfall | null;
}

export type WindowBasis = 'deployment-observation' | 'merge-instant' | 'given' | 'unknown';

/**
 * The commit the deployed control plane runs, from its own status document. The release stamp
 * (`GRAPHYARD_BUILD_REVISION`) is read first; a build that never stamped one still carries the
 * build identity the platform injects (`build.commit`: `GRAPHYARD_BUILD_SHA`,
 * `RAILWAY_GIT_COMMIT_SHA` or `SOURCE_COMMIT`), which is the same fact `/healthz` serves as
 * `commit`. Both are what is serving, never the checkout the measurement runs in; when neither
 * names a commit the revision stays `unknown` and nothing can be verified against it.
 */
export function deployedRevision(status: { release?: { revision?: string | null } | null; build?: { commit?: string | null } | null } | null | undefined): { revision: string | null; source: DeployedRelease['revisionSource'] } {
  const stamped = status?.release?.revision;
  if (stamped && stamped !== 'unknown') return { revision: stamped, source: 'release.revision' };
  const commit = status?.build?.commit;
  if (commit && commit !== 'unknown') return { revision: commit, source: 'build.commit' };
  return { revision: stamped ?? null, source: null };
}

const time = (value: string | null | undefined) => { const parsed = value ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };
const minutes = (ms: number) => `${Math.round(ms / 6000) / 10} min`;
/** A percentile over no deliveries is not zero minutes; it is nothing measured. */
const measuredMinutes = (ms: number | null | undefined, count: number) => count > 0 && ms !== null && ms !== undefined ? minutes(ms) : 'n/a (no deliveries measured)';
const sha40 = /^[0-9a-f]{40}$/;

/**
 * When a release carrying the claim began serving, which is where a measurement *of that release*
 * can start. The coordinator's own deployment observation on the claim's delivery is the fact
 * that says so; without one the claim's merge instant is used and named as the weaker basis it
 * is, because a merge is not a deployment. Neither is ever moved later to improve a figure.
 */
export function claimWindow(claim: Work | undefined, given?: string | null): { since: string | null; basis: WindowBasis; reason: string } {
  if (given) return { since: given, basis: 'given', reason: `The window start was given as ${given}; deliveries merged before it are not counted` };
  const deployment = claim?.delivery?.deployment;
  if (deployment) return { since: deployment.observedAt, basis: 'deployment-observation',
    reason: `${claim!.key} was observed serving from ${deployment.sha.slice(0, 12)} at ${deployment.observedAt}; every delivery counted was merged after the release carrying it was serving` };
  const merged = claim ? acceptedMergeAt(claim) : null;
  if (merged) return { since: merged, basis: 'merge-instant',
    reason: `${claim!.key} carries no deployment observation, so the window starts at its merge (${merged}); a merge is not a deployment, so a delivery merged shortly after it may have been driven by the previous release` };
  return { since: null, basis: 'unknown', reason: `${claim?.key ?? throughputClaim.item} is not delivered, so no window of the release running its executors can be established` };
}

/**
 * Every idle span of one action row, from the row's own history.
 *
 * A row is actionable from the instant it is requested, reopened or reclaimed, and stops being
 * actionable when an executor claims it — or when something outside the queue supersedes it, which
 * ends the wait without anybody having run the action. Two waits are deliberate and are not idleness: the
 * backoff after a failed attempt (`actionRetryDelay`), and the settle window a completed row
 * holds before it is reopened — the first is subtracted here, the second never starts a span
 * because a completion closes the open one. What is left is exactly the wait GY-87 bounded: a row
 * anybody could have run and nobody did.
 *
 * Records are bounded (`actionRecordLimit`), so a long-lived row may have lost its `requested`
 * entry. The row's own `requestedAt` opens the walk for that case and is overwritten by the first
 * open marker in the records, which makes an untrimmed row read identically.
 */
export function actionIdleSpans(row: Pick<ActionRow, 'requestedAt' | 'history' | 'state'> & Partial<Pick<ActionRow, 'attempts'>>, now: number): { from: string; ms: number }[] {
  const spans: { from: string; ms: number }[] = [];
  const recordedClaims = (row.history ?? []).filter(record => record.event === 'claimed').length;
  // History is bounded, while attempts is not. Start before the retained claims so a failed span
  // still gets the same delay the engine assigned when older claim records have been trimmed.
  let openSince: string | null = row.requestedAt, deliberateMs = 0;
  let attempts = Math.max(0, (row.attempts ?? recordedClaims) - recordedClaims);
  const open = (at: string, deliberate = 0) => { openSince = at; deliberateMs = deliberate; };
  const close = (at: string) => {
    const from = openSince, start = time(from);
    openSince = null;
    if (from === null || start === null) return;
    const ms = Math.max(0, (time(at) ?? start) - start - deliberateMs);
    deliberateMs = 0;
    spans.push({ from, ms });
  };
  for (const record of row.history ?? ([] as ActionRecord[])) {
    if (record.event === 'requested' || record.event === 'reopened' || record.event === 'reclaimed') open(record.at);
    else if (record.event === 'claimed') { attempts += 1; close(record.at); }
    // The engine bases retryAt on claims (row.attempts), not failures: an expired claim consumes
    // an attempt too. Bind that deliberate delay to this span when it opens, so a later reopen or
    // reclaim cannot accidentally inherit it after the engine has cleared retryAt.
    else if (record.event === 'failed') open(record.at, actionRetryDelay(attempts));
    // A claim ends the wait, and so does a supersession: a row nobody claimed before something
    // else moved the item on was actionable and unrun for exactly that long, which is the wait
    // the bound is about. A completion never opens one, because the claim before it closed it.
    else if (record.event === 'cancelled') close(record.at);
    else if (record.event === 'completed') { openSince = null; deliberateMs = 0; }
  }
  // A row still open at the measurement is still waiting; a retired one stopped waiting when it
  // was retired, which the `cancelled` record above already closed.
  if (openSince && row.state === 'pending') close(new Date(now).toISOString());
  return spans;
}

/** One row as the report names it: the executor that claimed it, what it did, and its longest idle span. */
export function actionExecution(row: ActionRow, now: number): ActionExecution {
  const records = row.history ?? [];
  const claimed = records.find(record => record.event === 'claimed') ?? null;
  const settled = [...records].reverse().find(record => record.event === 'completed' || record.event === 'failed') ?? null;
  const spans = actionIdleSpans(row, now);
  const longest = spans.reduce((worst, span) => !worst || span.ms > worst.ms ? span : worst, null as { from: string; ms: number } | null);
  return {
    id: row.id, kind: row.kind, key: row.key,
    // Settling a row clears its claim, so a finished action's host is read from the words the
    // claim record itself wrote (`attempt N claimed by X on HOST`) rather than lost with the claim.
    executor: row.claim?.executor ?? claimed?.executor ?? null,
    host: row.claim?.host ?? (claimed ? /\bon (\S+)$/.exec(claimed.reason)?.[1] ?? null : null),
    attempts: row.attempts, requestedAt: row.requestedAt,
    claimedAt: claimed?.at ?? null, settledAt: settled?.at ?? row.resolvedAt ?? null,
    result: settled?.event === 'completed' ? 'done' : settled?.event === 'failed' ? 'failed' : null,
    supersededUnexecuted: records.some(record => record.event === 'cancelled') && claimed === null,
    idleMs: longest?.ms ?? 0, idleSince: longest?.from ?? null,
    resolution: row.resolution ?? null,
  };
}

/** Every action row this item recorded, retired and open alike, oldest request first. */
export function deliveryActions(work: Work, now: number): ActionExecution[] {
  const rows = [...(work.actionQueue?.history ?? []), ...(work.actionQueue?.actions ?? [])];
  return rows.map(row => actionExecution(row, now)).sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt) || a.id.localeCompare(b.id));
}

/**
 * Why this item is not a real delivery of the managed repository. A measurement of a live pipeline
 * admits nothing it cannot point at in the provider: a merged pull request, its merge commit, and
 * a worker that held it. Anything else — a fixture, a seeded row, an item created to exercise a
 * gate — is refused here rather than counted and explained away later.
 */
export function unrealReasons(work: Work): string[] {
  const reasons: string[] = [];
  if (work.stage !== 'done' || !work.delivery) reasons.push('the item is not delivered');
  else if (!sha40.test(String(work.delivery.mergeSha ?? '').toLowerCase())) reasons.push(`its delivery records no merge commit (${work.delivery.mergeSha ?? 'none'})`);
  const pr = work.submission?.pr ?? work.candidate?.pr ?? null;
  if (!pr || !Number.isInteger(pr) || pr <= 0) reasons.push('no pull request number is recorded for it');
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(work.key)) reasons.push(`its key ${work.key} is not a work-item key of this repository`);
  if (!(work.implementers?.length || work.workspaces?.length)) reasons.push('no worker ever held it, so nothing implemented it');
  return reasons;
}

/**
 * Every trace of a coordinator on this delivery.
 *
 * A master session leaves marks the item itself keeps. It moves an item past an action the queue
 * had open, which retires that row unexecuted — the queue's own record of somebody else deciding.
 * It records a coordination session handle. It takes the hand-offs the pipeline timeline counts:
 * a blocked report somebody had to clear, and a requirements revision of an item already under
 * way. None of these is a judgement about whether the delivery went well; each is a statement
 * that a coordinator was present for it, which is what the claim excludes.
 */
export function coordinatorFingerprints(work: Work, actions: ActionExecution[]): string[] {
  const marks: string[] = [];
  for (const action of actions.filter(entry => entry.supersededUnexecuted))
    marks.push(`its ${action.kind} action was superseded before any executor ran it (${action.resolution ?? 'no reason recorded'}), so something outside the queue moved the item on`);
  for (const handle of (work.sessions ?? []).filter(entry => entry.kind === 'coordination'))
    marks.push(`a coordination session (${handle.id} on ${handle.host}) was recorded on it`);
  const interventions = work.pipeline?.interventions;
  if (interventions?.blocked) marks.push(`${interventions.blocked} blocked report(s) handed it to a master or operator to clear`);
  if (interventions?.requirements) marks.push(`${interventions.requirements} requirements revision(s) were applied to it while it was under way`);
  return marks;
}

/** One delivery, measured and judged, whether or not it is admitted. */
export function deliveryRecord(work: Work, now: number): DeliveryRecord {
  const speed = pipelineSpeed(work, now);
  const actions = deliveryActions(work, now);
  const executed = actions.filter(action => action.executor && action.result === 'done');
  const idle = actions.reduce((worst, action) => !worst || action.idleMs > worst.idleMs ? action : worst, null as ActionExecution | null);
  const exclusions = [...unrealReasons(work), ...coordinatorFingerprints(work, actions)];
  if (speed.submitToMergeMs === null) exclusions.push(`its timeline records no submission (${speed.coverage}), so submit→merge cannot be measured for it`);
  // The claim is stated over routine deliveries, in the same words the speed target uses: at most
  // one rework round. A delivery that went round three times is a real delivery and is reported
  // with its figures; it is simply not the population the claim is about.
  if ((work.pipeline?.reworkRounds ?? 0) > 1) exclusions.push(`it took ${work.pipeline!.reworkRounds} rework rounds, so it is not one of the routine deliveries the claim is stated over`);
  if (!executed.length) exclusions.push('no executor completed an action on it, so it is no evidence about an executor-driven pipeline');
  return {
    key: work.key, work: work.id, pr: work.submission?.pr ?? work.candidate?.pr ?? null,
    mergeSha: work.delivery?.mergeSha ?? null, mergedAt: acceptedMergeAt(work) ?? work.updatedAt,
    submittedAt: speed.submittedAt, submitToMergeMs: speed.submitToMergeMs,
    actions, executors: [...new Set(actions.map(action => action.executor).filter((name): name is string => !!name))].sort(),
    idle: idle && idle.idleMs > 0 ? { ms: idle.idleMs, action: idle.id, kind: idle.kind, since: idle.idleSince } : null,
    admitted: exclusions.length === 0, exclusions,
  };
}

/** The population rule in one sentence, carried in every report so the reader judges the rule, not the number. */
export const populationRule = 'A delivery is counted when it is a merged pull request of this repository with a recorded submission, at most one rework round, at least one action an executor claimed and completed, and no trace of a coordinator on it: no action superseded before an executor ran it, no coordination session recorded, no blocked report and no requirements revision while it was under way. Every delivery the window holds is listed either way, with its own figures and, when it is excluded, the reason.';

/**
 * Verify GY-87's throughput claim against one deployed release, over the real deliveries of one
 * window. Pure over the documents and the clock: the script supplies the release and the ledger,
 * and the same function runs in a test over the same shapes.
 */
export function verifyThroughput(work: Work[], now: number, options: { deployed: DeployedRelease; since?: string | null; until?: string | null; claimKey?: string }): ThroughputReport {
  const claimKey = options.claimKey ?? throughputClaim.item;
  const window = claimWindow(work.find(item => item.key === claimKey), options.since);
  const since = time(window.since), until = time(options.until ?? null);
  const delivered = work.filter(item => item.stage === 'done' && item.delivery);
  const inWindow = delivered.filter(item => {
    const mergedAt = time(acceptedMergeAt(item));
    return mergedAt !== null && (since === null || mergedAt >= since) && (until === null || mergedAt < until);
  });
  const records = inWindow.map(item => deliveryRecord(item, now)).sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  // "Real" is judged before the coordinator rule, so the population line separates a fixture from
  // a delivery a master drove; both are excluded, and they are not the same fact.
  const real = records.filter(record => !unrealReasons(inWindow.find(item => item.id === record.work)!).length);
  const admitted = records.filter(record => record.admitted);
  const excluded = records.filter(record => !record.admitted);

  const submitToMerge = nearestRankPercentiles(admitted.map(record => record.submitToMergeMs!).filter((value): value is number => value !== null));
  const worstIdle = admitted.reduce((worst, record) => record.idle && (!worst?.idle || record.idle.ms > worst.idle.ms) ? record : worst, null as DeliveryRecord | null);
  const idleMaxMs = worstIdle?.idle?.ms ?? (admitted.length ? 0 : null);
  const allMeasured = real.filter(record => record.submitToMergeMs !== null);
  const all = { count: allMeasured.length, submitToMerge: nearestRankPercentiles(allMeasured.map(record => record.submitToMergeMs!)),
    idleMaxMs: allMeasured.length ? Math.max(0, ...allMeasured.map(record => record.idle?.ms ?? 0)) : null };

  const enough = admitted.length >= throughputClaim.minimumDeliveries;
  const p50 = submitToMerge.p50Ms, idleMs = idleMaxMs ?? 0;
  const missed: ThroughputShortfall['missed'] = [];
  if (!enough) missed.push({ metric: 'population', measured: admitted.length, budget: throughputClaim.minimumDeliveries, by: throughputClaim.minimumDeliveries - admitted.length,
    text: `${admitted.length} of the ${throughputClaim.minimumDeliveries} deliveries the claim is judged over were made with no master session running; ${throughputClaim.minimumDeliveries - admitted.length} more are needed` });
  if (enough && p50 > throughputClaim.submitToMergeP50Ms) missed.push({ metric: 'submit-to-merge-p50', measured: p50, budget: throughputClaim.submitToMergeP50Ms, by: p50 - throughputClaim.submitToMergeP50Ms,
    text: `submit→merge p50 ${minutes(p50)} exceeds ${minutes(throughputClaim.submitToMergeP50Ms)} by ${minutes(p50 - throughputClaim.submitToMergeP50Ms)}` });
  if (enough && idleMs > throughputClaim.idleActionableMs) missed.push({ metric: 'idle-actionable', measured: idleMs, budget: throughputClaim.idleActionableMs, by: idleMs - throughputClaim.idleActionableMs,
    text: `${worstIdle?.key ?? 'a delivery'} left its ${worstIdle?.idle?.kind ?? 'action'} actionable and unclaimed for ${minutes(idleMs)}, ${minutes(idleMs - throughputClaim.idleActionableMs)} past the ${minutes(throughputClaim.idleActionableMs)} bound` });

  // The release must be the one running the claim's executors; a measurement of anything else
  // verifies nothing, whatever its figures say.
  const releaseRefusal = !options.deployed.revision || options.deployed.revision === 'unknown'
    ? 'the deployed release reports no build revision, so what was measured cannot be named'
    : options.deployed.containsClaim === false ? `the deployed release ${options.deployed.revision.slice(0, 12)} does not contain ${claimKey}'s merge, so its executors are not the ones serving`
    : options.deployed.containsClaim === null ? `whether the deployed release ${options.deployed.revision.slice(0, 12)} contains ${claimKey}'s merge could not be established${options.deployed.reason ? `: ${options.deployed.reason}` : ''}`
    : null;
  const met = releaseRefusal ? null : enough ? missed.length === 0 : null;
  const verdict: ThroughputReport['verdict'] = met === true ? 'verified' : 'unverified';
  const measuredAt = new Date(now).toISOString();
  const where = `deployed release ${options.deployed.revision ?? 'unknown'}${options.deployed.version ? ` (${options.deployed.version})` : ''} at ${options.deployed.origin}`;
  const reason = releaseRefusal ? `${throughputClaim.item}'s throughput claim is unverified: ${[releaseRefusal, ...missed.map(entry => entry.text)].join('; ')}`
    : met ? `${throughputClaim.item}'s throughput claim holds on the ${where}: over ${admitted.length} deliveries made with no master session running, submit→merge p50 is ${minutes(p50)} against ${minutes(throughputClaim.submitToMergeP50Ms)} and the longest idle-but-actionable wait is ${minutes(idleMs)} against ${minutes(throughputClaim.idleActionableMs)}`
    : `${throughputClaim.item}'s throughput claim is unverified on the ${where}: ${missed.map(entry => entry.text).join('; ')}`;

  // Did the population rule flatter the result? If the window as a whole misses a budget the
  // admitted population meets, that is said here, with both figures, rather than left for a
  // reader to notice. The rule is not changed by it; it is reported.
  const effects = [
    all.count && all.submitToMerge.p50Ms > throughputClaim.submitToMergeP50Ms && (p50 <= throughputClaim.submitToMergeP50Ms)
      ? `submit→merge p50 over all ${all.count} real deliveries in the window is ${minutes(all.submitToMerge.p50Ms)}, past the budget, while the ${admitted.length} admitted deliveries measure ${measuredMinutes(p50, submitToMerge.count)}` : null,
    all.idleMaxMs !== null && all.idleMaxMs > throughputClaim.idleActionableMs && idleMs <= throughputClaim.idleActionableMs
      ? `the longest idle-but-actionable wait over all real deliveries in the window is ${minutes(all.idleMaxMs)}, past the bound, while the admitted deliveries measure ${measuredMinutes(idleMaxMs, admitted.length)}` : null,
  ].filter((entry): entry is string => !!entry);
  const populationEffect = effects.length ? `${effects.join('; ')}. The excluded deliveries are listed with their figures and reasons; the budgets are unchanged.` : null;

  const shortfall = met === true ? null : {
    measured: { deliveries: admitted.length, submitToMergeP50Ms: admitted.length ? p50 : null, idleMaxMs },
    // A release that cannot be named is a miss of its own, beside — never instead of — the
    // population and budget misses, so the follow-up says everything that fell short.
    missed: releaseRefusal ? [{ metric: 'deployed-release' as const, measured: null, budget: 1, by: null, text: releaseRefusal }, ...missed] : missed,
    finding: `${reason}. This is a finding about the design of ${throughputClaim.item}, recorded with the values measured against the ${where}: the budgets stay as ${throughputClaim.item} stated them and the population rule is not narrowed to make them pass.`,
    followUp: {
      title: `${throughputClaim.item}'s throughput claim is unverified against the deployed release`,
      description: [`Measured at ${measuredAt} against the ${where}, over the window ${window.since ?? 'from the first delivery'} to ${options.until ?? measuredAt} (${window.basis}: ${window.reason}).`,
        `${admitted.length} real deliveries were made with no master session running; ${excluded.length} were excluded, each with its reason, out of ${inWindow.length} in the window.`,
        `What missed, and by how much: ${[...(releaseRefusal ? [releaseRefusal] : []), ...missed.map(entry => entry.text)].join('; ')}.`,
        `Measured: submit→merge p50 ${measuredMinutes(p50, submitToMerge.count)} against ${minutes(throughputClaim.submitToMergeP50Ms)}; longest idle-but-actionable ${measuredMinutes(idleMaxMs, admitted.length)} against ${minutes(throughputClaim.idleActionableMs)}; over all ${all.count} real deliveries in the window, submit→merge p50 ${measuredMinutes(all.submitToMerge.p50Ms, all.count)} and longest idle ${measuredMinutes(all.idleMaxMs, all.count)}.`,
        populationEffect ? `Population effect: ${populationEffect}` : 'The admitted population is not faster than the window as a whole.',
        `Population rule: ${populationRule}`].join('\n'),
    },
  } satisfies ThroughputShortfall;

  return {
    measuredAt, claim: throughputClaim, deployed: options.deployed,
    window: { since: window.since, until: options.until ?? null, basis: window.basis, reason: window.reason },
    population: { rule: populationRule, delivered: inWindow.length, real: real.length, admitted: admitted.length, excluded: excluded.length },
    deliveries: admitted, excluded, submitToMerge,
    idle: { maxMs: idleMaxMs, key: worstIdle?.key ?? null, action: worstIdle?.idle?.action ?? null, kind: worstIdle?.idle?.kind ?? null },
    all, populationEffect, met, verdict, reason, shortfall,
  };
}

/** One line per counted delivery: what a reader checks the population against. */
export function renderDelivery(record: DeliveryRecord): string {
  const actions = record.actions.map(action => `${action.kind}→${action.executor ?? 'unclaimed'}${action.result ? `(${action.result})` : ''}`).join(', ');
  const speed = record.submitToMergeMs === null ? 'submit→merge unmeasured' : `submit→merge ${minutes(record.submitToMergeMs)}`;
  const idle = record.idle ? `longest idle ${minutes(record.idle.ms)} on ${record.idle.kind}` : 'never idle past a claim';
  return `${record.key} (PR ${record.pr ?? '?'}, merged ${record.mergedAt}): ${speed}; ${idle}; actions ${actions || 'none recorded'}${record.admitted ? '' : `; EXCLUDED — ${record.exclusions.join('; ')}`}`;
}

/** The whole report as a person reads it. Every line of it is also in the JSON. */
export function renderThroughput(report: ThroughputReport): string {
  const lines = [
    `${report.claim.item} throughput claim: ${report.verdict.toUpperCase()}`,
    `Deployed release: ${report.deployed.revision ?? 'unknown'}${report.deployed.revisionSource ? ` (from ${report.deployed.revisionSource})` : ''}${report.deployed.version ? ` (${report.deployed.version})` : ''} at ${report.deployed.origin}, observed ${report.deployed.observedAt}; contains ${report.claim.item}: ${report.deployed.containsClaim === null ? `unknown (${report.deployed.reason ?? 'not checked'})` : report.deployed.containsClaim}`,
    `Window: ${report.window.since ?? 'open'} → ${report.window.until ?? report.measuredAt} (${report.window.basis}) — ${report.window.reason}`,
    `Population: ${report.population.admitted} counted of ${report.population.real} real deliveries (${report.population.delivered} delivered in the window, ${report.population.excluded} excluded)`,
    `Measured: submit→merge p50 ${measuredMinutes(report.submitToMerge.p50Ms, report.submitToMerge.count)} p90 ${measuredMinutes(report.submitToMerge.p90Ms, report.submitToMerge.count)} against ${minutes(report.claim.submitToMergeP50Ms)}; longest idle-but-actionable ${measuredMinutes(report.idle.maxMs, report.population.admitted)} against ${minutes(report.claim.idleActionableMs)}`,
    `All real deliveries in the window: ${report.all.count}; submit→merge p50 ${measuredMinutes(report.all.submitToMerge.p50Ms, report.all.count)}; longest idle ${measuredMinutes(report.all.idleMaxMs, report.all.count)}`,
    report.reason,
  ];
  if (report.populationEffect) lines.push(`Population effect: ${report.populationEffect}`);
  lines.push('Counted:', ...report.deliveries.map(record => `  ${renderDelivery(record)}`));
  if (report.excluded.length) lines.push('Excluded:', ...report.excluded.map(record => `  ${renderDelivery(record)}`));
  if (report.shortfall) lines.push(`Finding: ${report.shortfall.finding}`, `Follow-up: ${report.shortfall.followUp.title}`);
  return lines.join('\n');
}

/**
 * Where the post-deploy throughput measurement records what it measured, and the command that
 * takes it. The measurement is a separate run — it reads the deployed release's own identity and
 * its whole ledger — so `master status` reports the last recorded one rather than re-measuring on
 * every status read.
 */
export const throughputMeasurementDirectory = '.graphyard/measurements/throughput';
export const throughputMeasurementCommand = `GRAPHYARD_URL=… GRAPHYARD_TOKEN_FILE=… node scripts/measure-throughput.mjs --record ${throughputMeasurementDirectory}`;

/** The newest recorded measurement, with the file it came from; null when none was ever taken. */
export async function readThroughputMeasurement(root: string, directory = throughputMeasurementDirectory): Promise<{ report: ThroughputReport; file: string } | null> {
  const path = join(root, directory);
  const files = (await readdir(path).catch(() => [] as string[])).filter(name => name.endsWith('.json')).sort();
  for (const name of [...files].reverse()) {
    try { return { report: JSON.parse(await readFile(join(path, name), 'utf8')) as ThroughputReport, file: join(directory, name) }; }
    catch { continue; }
  }
  return null;
}

/** How many recorded measurements are kept: the newest wins, and the history is bounded. */
export const retainedThroughputMeasurements = 30;

/**
 * Appends one report the way `scripts/measure-throughput.mjs --record` writes it — one timestamped
 * JSON file, which is what `master status` reads — and drops the oldest past the retention bound,
 * by exact path. This is the loop's own write path (GY-393): the measurement the loop takes itself
 * records through the same format and directory a manual run does, so a reader cannot tell them apart.
 */
export async function recordThroughputMeasurement(root: string, report: ThroughputReport, directory = throughputMeasurementDirectory, retain = retainedThroughputMeasurements): Promise<string> {
  const path = join(root, directory);
  await mkdir(path, { recursive: true });
  const name = `${report.measuredAt.replace(/[:.]/g, '-')}.json`;
  await writeFile(join(path, name), JSON.stringify(report, null, 2) + '\n');
  const files = (await readdir(path)).filter(entry => entry.endsWith('.json')).sort();
  for (const stale of files.slice(0, Math.max(0, files.length - retain))) await rm(join(path, stale));
  return join(directory, name);
}

/**
 * Whether the deployed release carries the claim's own merge commit — the fact that makes a
 * measurement of it a measurement of the claim's executors rather than of whatever ran before.
 * The daemon-loop twin of the measurement script's `claimContainment`: the same inputs, the same
 * answers, over an awaited child runner instead of a synchronous one, so the loop's measurement
 * and a manual one cannot disagree about whether the release was eligible.
 */
export async function claimContainmentFrom({ revision, mergeSha, claim, repository }: { revision: string | null; mergeSha: string | null; claim: string; repository: string },
  run: (command: string, args: string[]) => string | Promise<string>): Promise<{ contains: boolean | null; reason: string | null }> {
  if (!revision || revision === 'unknown') return { contains: null, reason: 'the deployed release reports no build revision' };
  if (!mergeSha) return { contains: null, reason: `${claim} records no merge commit to compare the deployed revision against` };
  if (mergeSha.toLowerCase() === revision.toLowerCase()) return { contains: true, reason: null };
  try { await run('git', ['-C', repository, 'merge-base', '--is-ancestor', mergeSha, revision]); return { contains: true, reason: null }; }
  catch (error: any) {
    if (error?.status === 1) return { contains: false, reason: `${mergeSha.slice(0, 12)} is not an ancestor of the deployed ${revision.slice(0, 12)}` };
    return { contains: null, reason: `git could not compare ${mergeSha.slice(0, 12)} with the deployed ${revision.slice(0, 12)} from ${repository}: ${(error?.stderr || error?.message || `exit ${error?.status}`).toString().trim().slice(0, 200)}` };
  }
}

export interface ThroughputVisibility {
  claim: typeof throughputClaim;
  verdict: 'verified' | 'unverified';
  reason: string;
  deployed: { revision: string | null; version: string | null };
  measurement: { at: string; deployedRevision: string | null; admitted: number; submitToMergeP50Ms: number | null; idleMaxMs: number | null; file: string } | null;
  shortfall: ThroughputReport['shortfall'];
  command: string;
  attention: AttentionItem | null;
}

/**
 * Whether GY-87's throughput claim is verified against the release that is serving right now.
 *
 * GY-87 was delivered on a simulated fleet; whether the deployed executors hold its budgets over
 * real deliveries is a separate fact, and one nothing else on this report would say. So the claim
 * is carried here in exactly three states, and never assumed: verified, when a recorded
 * measurement of the running revision met the budgets; unverified with the shortfall, when one
 * missed them; and unverified with the reason, when the last measurement was of another release
 * or when none was ever taken. A delivered-but-unproven claim is visible either way.
 *
 * The attention item is raised only once there is a delivery to measure: an installation that has
 * delivered nothing has nothing to verify, and an item nobody can act on is not attention.
 */
export function throughputClaimVisibility(measurement: { report: ThroughputReport; file: string } | null, deployed: { revision: string | null; version: string | null }, deliveries: number): ThroughputVisibility {
  const command = throughputMeasurementCommand;
  const base = { claim: throughputClaim, deployed, command,
    measurement: measurement ? { at: measurement.report.measuredAt, deployedRevision: measurement.report.deployed?.revision ?? null,
      admitted: measurement.report.population?.admitted ?? 0, submitToMergeP50Ms: measurement.report.submitToMerge?.p50Ms ?? null,
      idleMaxMs: measurement.report.idle?.maxMs ?? null, file: measurement.file } : null };
  const unverified = (reason: string, shortfall: ThroughputReport['shortfall'] = null): ThroughputVisibility => ({ ...base, verdict: 'unverified', reason, shortfall,
    attention: deliveries ? { subject: 'throughput', text: `${throughputClaim.item}'s throughput claim is unverified against the deployed release: ${reason}`, ...agentOwner('master', command) } : null });
  if (!measurement) return unverified(`no post-deploy measurement has ever been recorded under ${throughputMeasurementDirectory}, so the claim (${throughputClaim.statement}) is delivered but unproven`);
  const measured = measurement.report.deployed?.revision ?? null;
  if (!deployed.revision || deployed.revision === 'unknown') return unverified(`the control plane reports no build revision, so the last measurement (of ${measured ?? 'an unnamed release'} at ${measurement.report.measuredAt}) cannot be matched to what is serving`, measurement.report.shortfall ?? null);
  if (measured !== deployed.revision) return unverified(`the last measurement was taken against ${measured ?? 'an unnamed release'} at ${measurement.report.measuredAt}; the release now serving is ${deployed.revision.slice(0, 12)}`, measurement.report.shortfall ?? null);
  if (measurement.report.deployed?.containsClaim !== true) return unverified(`the last measurement did not establish that ${deployed.revision.slice(0, 12)} contains ${throughputClaim.item}'s merge${measurement.report.deployed?.reason ? `: ${measurement.report.deployed.reason}` : ''}`, measurement.report.shortfall ?? null);
  if (measurement.report.verdict !== 'verified') return unverified(measurement.report.reason, measurement.report.shortfall ?? null);
  return { ...base, verdict: 'verified', reason: measurement.report.reason, shortfall: null, attention: null };
}

/** The claim's visibility as master status reads it: the recorded measurement, the release the control plane says is serving, and the delivered items. */
export async function throughputStatus(root: string, coordinator: Parameters<typeof deployedRevision>[0] & { release?: { version?: string | null } | null }, work: Work[]): Promise<ThroughputVisibility> {
  return throughputClaimVisibility(await readThroughputMeasurement(root).catch(() => null),
    { revision: deployedRevision(coordinator).revision, version: coordinator?.release?.version ?? null },
    work.filter(item => item.stage === 'done' && item.delivery).length);
}
