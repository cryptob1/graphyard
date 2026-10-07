import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentOwner, humanOwner, type AttentionItem } from './master.js';
import { appendThroughputLedger, failedEntry, readThroughputLedger, recordedEntry, throughputPursuit, type ThroughputPursuit } from './throughput-ledger.js';
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
 * Every trace of a coordinator on this delivery, under the admission rule the approvers settled
 * (GY-1449 revision 48a9e55a, GY-1454 AC-1; applied here by GY-1455).
 *
 * A master or operator session leaves marks the item itself keeps: a coordination session handle
 * whose role is not the approver's (or that records no role at all), a blocked report somebody had
 * to clear, and a requirements revision of an item already under way. Each is a statement that a
 * coordinator was present for it, which is what the claim excludes. Two marks are not: an action
 * row the control plane retired unexecuted (escalate, request-rework, resync, request-review,
 * dispatch, approve-scope, reclaim, merge) is the queue's own cycle moving on, and an approver
 * session is the independent two-party decision the pipeline requests for itself.
 */
export function coordinatorFingerprints(work: Work): string[] {
  const marks: string[] = [];
  for (const handle of (work.sessions ?? []).filter(entry => entry.kind === 'coordination' && entry.role !== 'approver'))
    marks.push(`${handle.role ? `${/^[aeiou]/i.test(handle.role) ? 'an' : 'a'} ${handle.role}` : 'a'} coordination session (${handle.id} on ${handle.host}${handle.role ? '' : ', no role recorded'}) was recorded on it`);
  const interventions = work.pipeline?.interventions;
  if (interventions?.blocked) marks.push(`${interventions.blocked} blocked report(s) handed it to a master or operator to clear`);
  if (interventions?.requirements) marks.push(`${interventions.requirements} requirements revision(s) were applied to it while it was under way`);
  return marks;
}

/**
 * The class of one exclusion reason, so a window of hundreds of deliveries reads as a few counted
 * reasons (GY-1438). A coordinator fingerprint (`coordinatorFingerprints`) names its class with
 * `coordinator: true`; any other reason keeps its own words up to its first detail, digits folded.
 */
export function exclusionClass(exclusion: string): { reason: string; coordinator: boolean } {
  if (/^an? (?:\S+ )?coordination session \(.*\) was recorded on it$/.test(exclusion)) return { reason: 'a coordination session other than an approver\'s was recorded on it', coordinator: true };
  if (/^\d+ blocked report\(s\) handed it to a master or operator to clear$/.test(exclusion)) return { reason: 'a blocked report handed it to a master or operator to clear', coordinator: true };
  if (/^\d+ requirements revision\(s\) were applied to it while it was under way$/.test(exclusion)) return { reason: 'a requirements revision was applied to it while it was under way', coordinator: true };
  return { reason: exclusion.split(' (')[0]!.replace(/\d+/g, 'N').trim(), coordinator: false };
}

/** One delivery, measured and judged, whether or not it is admitted. */
export function deliveryRecord(work: Work, now: number): DeliveryRecord {
  const speed = pipelineSpeed(work, now);
  const actions = deliveryActions(work, now);
  const executed = actions.filter(action => action.executor && action.result === 'done');
  const idle = actions.reduce((worst, action) => !worst || action.idleMs > worst.idleMs ? action : worst, null as ActionExecution | null);
  const exclusions = [...unrealReasons(work), ...coordinatorFingerprints(work)];
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

/** The delivered items whose accepted merge falls in `[since, until)`: everything a window holds, and nothing else. */
export function windowDeliveries(work: Work[], since: string | null, until?: string | null): Work[] {
  const from = time(since), to = time(until ?? null);
  return work.filter(item => {
    const mergedAt = time(acceptedMergeAt(item));
    return mergedAt !== null && (from === null || mergedAt >= from) && (to === null || mergedAt < to);
  });
}

/** The population rule in one sentence, carried in every report so the reader judges the rule, not the number. */
export const populationRule = 'A delivery is counted when it is a merged pull request of this repository (delivered with a merge commit, a pull request number, a work-item key and a worker that held it) with a recorded submission, at most one rework round and at least one action an executor claimed and completed, and is excluded for a coordination session whose role is master, operator or anything but approver (or that records no role), a blocked report, or a requirements revision applied while it was under way, while a control-plane action (escalate, request-rework, resync, request-review, dispatch, approve-scope, reclaim, merge) superseded before any executor ran it and an approver session never exclude it. Every delivery the window holds is listed either way, with its own figures and, when it is excluded, the reason.';

/**
 * Verify GY-87's throughput claim against one deployed release, over the real deliveries of one
 * window. Pure over the documents and the clock: the script supplies the release and the ledger,
 * and the same function runs in a test over the same shapes.
 */
export function verifyThroughput(work: Work[], now: number, options: { deployed: DeployedRelease; since?: string | null; until?: string | null; claimKey?: string }): ThroughputReport {
  const claimKey = options.claimKey ?? throughputClaim.item;
  const window = claimWindow(work.find(item => item.key === claimKey), options.since);
  const inWindow = windowDeliveries(work, window.since, options.until);
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
 * takes it by hand. The loop takes it itself once per release after it verifies a deployment
 * (`loopThroughputMeasurement`), so `master status` reports the last recorded one rather than
 * re-measuring on every status read.
 */
export const throughputMeasurementDirectory = '.graphyard/measurements/throughput';
export const throughputMeasurementCommand = `GRAPHYARD_URL=… GRAPHYARD_TOKEN_FILE=… node scripts/measure-throughput.mjs --record ${throughputMeasurementDirectory}`;

/**
 * The open item that owns verifying the claim on the serving release (GY-1438). The loop files it
 * itself (`throughputOwnerItem`) once a measurement of the serving release leaves the claim
 * unverified and no such item is open, and it closes it itself (`throughputOwnerClosure`) only once
 * a recorded measurement of the serving release verifies the claim or the item's needs-decision is
 * answered. It is filed in the backlog and never released: there is nothing for a worker to build,
 * and its open stage is what keeps the verification owned. The attention names it with its progress.
 */
export const throughputOwnerTitle = `Verify ${throughputClaim.item}'s throughput claim on the serving release`;

/** The open owner item, if any: a closed or delivered one owns nothing. */
export const openThroughputOwner = <W extends Pick<Work, 'title' | 'stage'> & { closure?: unknown }>(work: readonly W[]) =>
  work.find(item => item.title.startsWith(throughputOwnerTitle) && item.stage !== 'done' && !item.closure) ?? null;

/**
 * Whether the owner's needs-decision was answered: the loop raised it (`raisedAt`, the owner's
 * requirements revision when the loop recorded `escalation:throughput:GY-N:REVISION`) and a
 * requirements revision was applied to the owner after that (`master decide GY-N requirements`,
 * then its approver). A revision with no needs-decision raised, or one applied before it, answers
 * nothing: a scope or criteria edit alone never closes the owner.
 */
export const throughputOwnerAnswered = (owner: Pick<Work, 'policyRevision'>, raisedAt: number | null) => raisedAt !== null && owner.policyRevision > raisedAt;

/**
 * The owner's one criterion, carrying the population rule settled by requirements revision
 * 48a9e55a-646b-4847-9dff-5d10a11a928b (GY-1449's AC-1), so an owner filed after that decision asks
 * the master to verify under it rather than to decide it again (GY-1465).
 */
export const throughputOwnerCriterion = `A recorded measurement of the release the control plane serves verifies the ${throughputClaim.item} claim (at least ${throughputClaim.minimumDeliveries} admitted deliveries within its submit-to-merge p50 and idle-but-actionable budgets), a delivery counting as session-free when it is a merged pull request with a recorded submission, at most one rework round, at least one action an executor claimed and completed, and no master or operator session drove it: no coordination session other than an approver's recorded on it (one recording no role excludes), no blocked report handing it to a master or operator, and no requirements revision applied while it was under way; superseded control-plane actions (dispatch, escalate, rework, resync, review, merge, approve-scope, reclaim) are the loop machinery of record and do not exclude a delivery. Or the needs-decision the loop raised on this item is answered`;

/** The item the loop files to own the verification, naming the release it found unverified and its progress. */
export function throughputOwnerItem(revision: string, admitted: number | null) {
  return {
    title: `${throughputOwnerTitle}: ${revision.slice(0, 12)}`.slice(0, 200), type: 'bug' as const, priority: 1,
    description: [
      `The master loop filed this item itself (GY-1438): ${throughputClaim.item}'s throughput claim (${throughputClaim.statement}) is unverified on the release the control plane serves, ${revision}${admitted === null ? '' : `, with ${admitted} of the ${throughputClaim.minimumDeliveries} session-free deliveries it is judged over admitted`}. It owns that verification so it can only end, never age.`,
      `There is nothing to build here, so it stays in the backlog and is never released to a worker. The loop re-measures the serving release while its newest measurement is unverified (at most every ${Math.round(throughputRemeasureMs / 60_000)} min; the budgets are never relaxed) and closes this item itself once a recorded measurement of the serving release verifies the claim. When session-free deliveries cannot accumulate it raises a needs-decision on this item instead; an approved requirements revision of this item applied after that answers it, and the loop closes the item then too.`,
    ].join('\n\n'),
    criteria: [{ id: 'AC-1', text: throughputOwnerCriterion, proofs: ['manual:throughput-claim-verified'] }],
    reason: `${throughputClaim.item}'s throughput claim is unverified on the serving release ${revision.slice(0, 12)} and no open item owns its verification`,
  };
}

/**
 * Why the loop closes the owner now, or null while it must stay open: the newest answer for the
 * serving release verified the claim, or its needs-decision was answered. Nothing else closes it,
 * so a release that is still unverified always has an open owner.
 */
export function throughputOwnerClosure(owner: Pick<Work, 'key' | 'policyRevision'>, serving: { revision: string; verdict: ThroughputReport['verdict'] | null }, raisedAt: number | null): string | null {
  if (serving.verdict === 'verified') return `${throughputClaim.item}'s throughput claim verified on the serving release ${serving.revision}; the loop closes ${owner.key}, which owned that verification`;
  if (throughputOwnerAnswered(owner, raisedAt)) return `${owner.key}'s needs-decision (raised at its requirements revision ${raisedAt}) was answered by its requirements revision ${owner.policyRevision}; the loop closes it, and files a second owner for ${serving.revision.slice(0, 12)} only while a measurement of it under the applied rule still shows a needs-decision standing: the next release it measures unverified files a new one`;
  return null;
}

/**
 * When session-free deliveries cannot accumulate (GY-1438): a measured window of at least this many
 * deliveries, none admitted and every one carrying a coordinator fingerprint. No number of further
 * deliveries made the same way can reach the claim's ten, so the loop escalates rather than ages.
 */
export const throughputStallBound = 2 * throughputClaim.minimumDeliveries;

/** The typed needs-decision a stalled population raises: the rule, and every exclusion reason counted. */
export interface ThroughputStall {
  kind: 'needs-decision';
  /** The open owner item the decision is asked on; null while none is filed. */
  owner: string | null;
  revision: string | null;
  measuredAt: string;
  rule: string;
  admitted: number;
  delivered: number;
  bound: number;
  /** Every exclusion reason in the window, with how many deliveries carry it, most first. */
  reasons: { reason: string; deliveries: number; coordinator: boolean }[];
  /** The finding alone — rule, counts and reasons, no timestamp — so a re-measure that finds the same is the same finding. */
  finding: string;
  text: string;
}

/**
 * Whether a measurement shows the session-free population cannot accumulate: the measured release
 * was shown to contain the claim, at least `throughputStallBound` deliveries are in the window, none
 * is admitted, and every one is excluded for a coordinator fingerprint (whatever else it was
 * excluded for). Null otherwise — a release not shown to contain the claim is unverified for that
 * reason, and a window still short of the bound, or one where some delivery was excluded for another
 * reason alone, may yet accumulate. A report judged under a population rule since revised and applied
 * (`throughputRuleSuperseded`, GY-1458) is no stall either: its question was answered, and only a
 * measurement under the applied rule says whether that rule's population accumulates. Pure over the recorded report, so master status and the loop judge it alike.
 */
export function throughputStall(report: ThroughputReport, owner: string | null = null): ThroughputStall | null {
  if (report.deployed?.containsClaim !== true || throughputRuleSuperseded(report)) return null;
  const excluded = report.excluded ?? [], delivered = report.population?.delivered ?? 0, admitted = report.population?.admitted ?? 0;
  if (admitted > 0 || delivered < throughputStallBound || excluded.length !== delivered) return null;
  // GY-1465: each recorded exclusion is re-judged under the settled rule, so a delivery excluded
  // only for control-plane actions superseded before an executor ran them counts as admitted here,
  // whatever rule the recording binary wrote: such a window can accumulate and asks no decision.
  const settled = excluded.map(record => settledExclusions(record.exclusions));
  if (settled.some(exclusions => !exclusions.length)) return null;
  const classes = settled.map(exclusions => exclusions.map(exclusionClass));
  if (!classes.every(entries => entries.some(entry => entry.coordinator))) return null;
  const counted = new Map<string, { reason: string; deliveries: number; coordinator: boolean }>();
  for (const entries of classes) for (const entry of new Map(entries.map(item => [item.reason, item])).values()) {
    const held = counted.get(entry.reason) ?? { ...entry, deliveries: 0 };
    held.deliveries += 1; counted.set(entry.reason, held);
  }
  const reasons = [...counted.values()].sort((a, b) => b.deliveries - a.deliveries || a.reason.localeCompare(b.reason));
  const revision = report.deployed?.revision ?? null, rule = report.population?.rule ?? populationRule;
  const finding = `session-free deliveries cannot accumulate on ${revision?.slice(0, 12) ?? 'the measured release'} — ${admitted} admitted of ${delivered} deliveries in the window (bound ${throughputStallBound}), every one carrying a coordinator fingerprint, so no further delivery made the same way reaches the claim's ${throughputClaim.minimumDeliveries}. `
    + `Exclusions: ${reasons.map(entry => `${entry.deliveries} × ${entry.reason}`).join('; ')}. Population rule: ${rule}`;
  const stall = { kind: 'needs-decision' as const, owner, revision, measuredAt: report.measuredAt, rule, admitted, delivered, bound: throughputStallBound, reasons, finding };
  return { ...stall, text: throughputStallText(stall) };
}

/**
 * Whether a recorded report was judged under a population rule other than the one this code applies
 * (GY-1458): the rule was revised, approved and merged after it was measured (GY-1449's revision,
 * applied by GY-1455), so the decision its stall asked for is answered and the loop's next
 * re-measure judges the window under the applied rule. A report that names no rule is not superseded.
 */
export const throughputRuleSuperseded = (report: Pick<ThroughputReport, 'population'>) => Boolean(report.population?.rule) && report.population.rule !== populationRule;

/**
 * The control-plane action family the settled rule admits (requirements revision
 * 48a9e55a-646b-4847-9dff-5d10a11a928b, applied by GY-1455): a row superseded before an executor ran
 * it is the loop machinery of record, never a coordinator's trace. A report recorded by a binary
 * that predates the rule still names them as exclusions, in these words.
 */
export const supersededActionExclusion = /^its \S+ action was superseded before any executor ran it\b/;

/** A delivery's exclusions as the settled rule judges them: the superseded control-plane family dropped (GY-1465). */
export const settledExclusions = (exclusions: readonly string[]) => exclusions.filter(exclusion => !supersededActionExclusion.test(exclusion));

/** The needs-decision as the escalation and the attention word it, asked on the owner item it names. */
export function throughputStallText(stall: Omit<ThroughputStall, 'text'>) {
  return `needs decision on ${stall.owner ?? 'the item that owns the verification (the loop files it)'}: ${stall.finding}. `
    + `Decide whether the population rule or the coordination that leaves these fingerprints changes; the budgets stay as ${throughputClaim.item} stated them (measured ${stall.measuredAt})`;
}

/**
 * Whether the serving release's newest measurement is re-taken (GY-1437, GY-1438): it is unverified
 * and `throughputRemeasureMs` has passed since it was taken. A verified measurement is final for its
 * release. Between re-measures the loop's step asks on its failure backoff and is answered `current`,
 * one status read per ask, so the bounded read of the window is taken at most once per spacing.
 */
export function throughputRemeasureDue(report: Pick<ThroughputReport, 'verdict' | 'measuredAt'>, now: number): boolean {
  const taken = time(report.measuredAt);
  return report.verdict !== 'verified' && taken !== null && now - taken >= throughputRemeasureMs;
}

/** When an unverified measurement taken at `measuredAt` is next re-taken: `throughputRemeasureMs` after it. */
export const throughputRemeasureFrom = (measuredAt: string) => new Date(Date.parse(measuredAt) + throughputRemeasureMs).toISOString();

/**
 * The re-measure time an unverified answer names (`measured again from …`, GY-1458), or null when it
 * names none. The loop asks again at that time whatever its failure backoff has grown to, so the
 * serving release is measured at most every `throughputRemeasureMs` and never left standing past it.
 */
export function throughputRemeasureAt(detail: string): number | null {
  const named = /measured again from (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(detail);
  return named ? Date.parse(named[1]!) : null;
}

/** How many whole delivery documents the bounded measurement reads at once. */
export const throughputReadConcurrency = 4;

/**
 * The bounded measurement (GY-1385). The window is chosen from documents the reader already holds —
 * the loop's coordination snapshot, or the default snapshot, both of which carry each settled
 * delivery's summary (key, stage, delivery) — and only the deliveries inside it are then read
 * whole, one `GET /api/work/:id` each, for the action rows and sessions the population rule judges.
 * Nothing reads the full work snapshot of every item: the cost grows with the window, not the ledger.
 * `read` names every item read whole, so a caller can see exactly what was asked.
 */
export async function measureThroughput(summaries: Work[], readItem: (id: string) => Promise<Work>, now: number,
  options: { deployed: DeployedRelease; since?: string | null; until?: string | null; claimKey?: string }): Promise<{ report: ThroughputReport; read: string[] }> {
  const claimKey = options.claimKey ?? throughputClaim.item;
  const claim = summaries.find(item => item.key === claimKey);
  const window = claimWindow(claim, options.since);
  // No established window means no release of the claim to measure: nothing is read.
  const wanted = window.since === null && window.basis === 'unknown' ? [] : windowDeliveries(summaries, window.since, options.until);
  const whole = new Map<string, Work>(), queue = [...wanted];
  await Promise.all(Array.from({ length: Math.min(throughputReadConcurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) whole.set(next.id, await readItem(next.id));
  }));
  const work = [...(claim && !whole.has(claim.id) ? [claim] : []), ...wanted.map(item => whole.get(item.id)!)];
  return { report: verifyThroughput(work, now, { ...options, claimKey }), read: wanted.map(item => item.id) };
}

/** How many recorded measurements the directory keeps: one per release, so a long-lived loop's record stays bounded. */
export const throughputMeasurementRetention = 30;

/** The names this recorder writes: the `measuredAt` stem, then the `_N` a later record in the same millisecond takes. */
const measurementName = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:_(\d+))?\.json$/;

/**
 * Measurement files in recorded order: by the `measuredAt` stem, then by the `_N` sequence a
 * later record in the same millisecond takes (GY-1414), the unsuffixed first. Only names this
 * recorder writes count, so retention and the read never touch another file in the directory.
 */
function measurementOrder(names: string[]): string[] {
  const key = (name: string) => { const match = measurementName.exec(name)!; return { stem: match[1]!, sequence: Number(match[2] ?? 0) }; };
  return names.filter(name => measurementName.test(name)).sort((a, b) => {
    const left = key(a), right = key(b);
    return left.stem < right.stem ? -1 : left.stem > right.stem ? 1 : left.sequence - right.sequence;
  });
}

/**
 * Writes one report as a timestamped JSON file under `directory`, returning the path relative to
 * `root`, and retires the oldest recorded files past `retention`: `master status` reads only the newest.
 * A file is never overwritten: a second record in the same millisecond takes a suffix above every
 * `_N` already recorded for it, so it always orders newest even after retention retired the first.
 */
export async function recordThroughputMeasurement(root: string, report: ThroughputReport, directory = throughputMeasurementDirectory, retention = throughputMeasurementRetention): Promise<string> {
  await mkdir(join(root, directory), { recursive: true });
  const stem = report.measuredAt.replace(/[:.]/g, '-');
  const body = JSON.stringify(report, null, 2) + '\n';
  const taken = (await readdir(join(root, directory))).map(name => measurementName.exec(name)).filter(match => match?.[1] === stem);
  let file = '';
  for (let sequence = taken.length ? Math.max(...taken.map(match => Number(match![2] ?? 0))) + 1 : 0; ; sequence++) {
    file = join(directory, `${stem}${sequence ? `_${sequence}` : ''}.json`);
    try { await writeFile(join(root, file), body, { flag: 'wx' }); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const kept = measurementOrder(await readdir(join(root, directory)));
  for (const name of kept.slice(0, Math.max(0, kept.length - retention))) await unlink(join(root, directory, name)).catch(() => undefined);
  return file;
}

/**
 * How long an unverified measurement of the serving release stands before the loop measures it
 * again (GY-1437, GY-1438): session-free deliveries accumulate while one release serves, so a claim
 * short of its population is re-read as they land rather than frozen at the first read's count, and
 * each re-measure reads the whole window, so it is re-taken at most this often, never on every merge.
 */
export const throughputRemeasureMs = 60 * 60_000;

export interface LoopThroughputOutcome {
  /** `recorded`: measured now; `current`: the serving release is already measured and not due again; `waiting`: the plane does not serve the observed release yet; `skipped`: nothing to measure. */
  outcome: 'recorded' | 'current' | 'waiting' | 'skipped';
  /** False while the serving release's measurement is unverified: the loop asks again on its backoff (GY-1437). */
  settled?: boolean;
  revision: string | null;
  /** The verdict of the release's newest measurement, when there is one (`recorded` or `current`). */
  verdict?: ThroughputReport['verdict'];
  /** Set when that measurement shows session-free deliveries cannot accumulate (`throughputStall`). */
  stall?: ThroughputStall | null;
  detail: string;
  file?: string;
  report?: ThroughputReport;
  /** The ids read whole for the measurement. */
  read?: string[];
}

/**
 * The loop's own post-deploy measurement (GY-1385), taken after it verifies a deployment of
 * `observedSha`: at most one per release the control plane reports serving, read with the loop's
 * coordinator credential. The release identity comes from the plane's own status, never from this
 * checkout; whether it contains the claim's merge is asked of git (`contains`). The measurement is
 * of the release the deployment verified and no other: while the plane reports serving a different
 * revision — it lags the deployment record, or it still runs a release that was never measured —
 * the outcome is `waiting` and nothing is recorded, so a release is never marked measured on the
 * strength of another's figures. A release measured verified is not measured again; one measured
 * unverified is measured again once its record is `throughputRemeasureMs` old (`throughputRemeasureDue`,
 * GY-1437, GY-1438), so a 0-of-10 record refreshes as deliveries accumulate, and every attempt,
 * recorded or failed, is appended to the ledger (`throughput-ledger.ts`).
 * `claimKey` names the delivered claim whose release opens the window; it is GY-87 everywhere
 * but a simulated ledger.
 */
export async function loopThroughputMeasurement(root: string, input: {
  work: Work[]; observedSha: string; now: () => number; origin: string;
  status: () => Promise<Parameters<typeof deployedRevision>[0] & { now?: string; release?: { version?: string | null } | null }>;
  readItem: (id: string) => Promise<Work>;
  contains: (ancestor: string, descendant: string) => Promise<boolean | null>;
  claimKey?: string;
}): Promise<LoopThroughputOutcome> {
  const claimKey = input.claimKey ?? throughputClaim.item;
  const claim = input.work.find(item => item.key === claimKey);
  if (!claim || claim.stage !== 'done' || !claim.delivery) return { outcome: 'skipped', revision: null, detail: `${claimKey} is not delivered here, so there is no throughput claim to measure` };
  // Every read that can fail — the plane's status, the ancestry check, the measurement itself — is
  // inside one boundary, so a bad credential or an unreachable plane is ledgered with its blocker
  // and starts the pursuit clock rather than retrying unseen (GY-1437).
  const ledger = join(root, throughputMeasurementDirectory);
  let revision: string | null = null, remeasure = false, measurement: Awaited<ReturnType<typeof measureThroughput>>;
  try {
    const status = await input.status();
    const served = deployedRevision(status);
    if (!served.revision || served.revision === 'unknown') return { outcome: 'skipped', revision: null, detail: `The control plane reports no build revision, so ${claimKey}'s throughput cannot be measured against the release serving` };
    revision = served.revision;
    const previous = await readThroughputMeasurement(root).catch(() => null);
    const measured = previous?.report.deployed?.revision === revision;
    if (revision.toLowerCase() !== input.observedSha.toLowerCase()) return { outcome: 'waiting', revision,
      detail: `The control plane serves ${revision.slice(0, 12)}${measured ? ' (already measured)' : ', not yet measured'} while the verified deployment is ${input.observedSha.slice(0, 12)}; ${input.observedSha.slice(0, 12)} is measured once it serves` };
    const now = input.now();
    remeasure = measured;
    // A verified release is never measured again; an unverified one once its record is an hour old.
    if (measured && !throughputRemeasureDue(previous!.report, now)) {
      const verified = previous!.report.verdict === 'verified';
      return { outcome: 'current', settled: verified, revision, file: previous!.file, verdict: previous!.report.verdict, stall: throughputStall(previous!.report),
        detail: `${claimKey}'s throughput is already measured for ${revision.slice(0, 12)} (${previous!.report.verdict}, ${previous!.file})${verified ? '' : `; measured again from ${throughputRemeasureFrom(previous!.report.measuredAt)} as deliveries accumulate`}` };
    }
    const mergeSha = claim.delivery.mergeSha;
    let containsClaim: boolean | null = null, reason: string | null = null;
    if (!mergeSha) reason = `${claimKey} records no merge commit to compare the deployed revision against`;
    else {
      containsClaim = mergeSha.toLowerCase() === revision.toLowerCase() ? true : await input.contains(mergeSha, revision);
      if (containsClaim === false) reason = `${mergeSha.slice(0, 12)} is not an ancestor of the deployed ${revision.slice(0, 12)}`;
      else if (containsClaim === null) reason = `git could not compare ${mergeSha.slice(0, 12)} with the deployed ${revision.slice(0, 12)} from the loop's checkout`;
    }
    const deployed: DeployedRelease = { revision, revisionSource: served.source, version: status?.release?.version ?? null, origin: input.origin,
      observedAt: status?.now ?? new Date(now).toISOString(), containsClaim, reason };
    measurement = await measureThroughput(input.work, input.readItem, now, { deployed, claimKey });
  } catch (error) {
    await appendThroughputLedger(ledger, failedEntry(error, { source: 'loop', revision, needed: throughputClaim.minimumDeliveries, at: new Date(input.now()).toISOString() })).catch(() => undefined);
    throw error;
  }
  const { report, read } = measurement;
  const file = await recordThroughputMeasurement(root, report);
  await appendThroughputLedger(ledger, recordedEntry(report, { source: 'loop', file, output: renderThroughput(report) }));
  return { outcome: 'recorded', settled: report.verdict === 'verified', revision: revision!, file, report, read, verdict: report.verdict, stall: throughputStall(report),
    detail: `${remeasure ? 'Re-measured' : 'Recorded'} ${claimKey}'s throughput measurement for ${revision!.slice(0, 12)} in ${file}, reading ${read.length} deliveries whole: ${report.verdict}: ${report.reason}${report.verdict === 'verified' ? '' : `; measured again from ${throughputRemeasureFrom(report.measuredAt)} as deliveries accumulate`}` };
}

/** The newest recorded measurement, with the file it came from; null when none was ever taken. */
export async function readThroughputMeasurement(root: string, directory = throughputMeasurementDirectory): Promise<{ report: ThroughputReport; file: string } | null> {
  const path = join(root, directory);
  const files = measurementOrder(await readdir(path).catch(() => [] as string[]));
  for (const name of [...files].reverse()) {
    try { return { report: JSON.parse(await readFile(join(path, name), 'utf8')) as ThroughputReport, file: join(directory, name) }; }
    catch { continue; }
  }
  return null;
}

export interface ThroughputVisibility {
  claim: typeof throughputClaim;
  verdict: 'verified' | 'unverified';
  reason: string;
  deployed: { revision: string | null; version: string | null };
  measurement: { at: string; deployedRevision: string | null; admitted: number; submitToMergeP50Ms: number | null; idleMaxMs: number | null; file: string } | null;
  shortfall: ThroughputReport['shortfall'];
  command: string;
  /** The open item that owns the verification (null while none is filed), and its progress from the newest recorded measurement (GY-1438). */
  owner: { item: string | null; admitted: number; needed: number; measuredAt: string | null };
  /** The typed needs-decision, when the newest measurement of the serving release shows the population cannot accumulate. */
  stall: ThroughputStall | null;
  attention: AttentionItem | null;
  /** The standing pursuit from the ledger (GY-1437): when it opened, when it escalates, and the blocker. */
  pursuit: ThroughputPursuit | null;
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
 * delivered nothing has nothing to verify, and an item nobody can act on is not attention. It
 * names the item that owns the verification and its progress (admitted of ten, from the newest
 * recorded measurement), and retires once a recorded measurement of the serving release verifies.
 * When that measurement shows session-free deliveries cannot accumulate (`throughputStall`) it is
 * the typed needs-decision instead, owned by the master and its approver on the owner item (GY-1438).
 * A measurement judged under a population rule since revised raises no decision (GY-1458): the line
 * states that none remains and names the loop's re-measure, never `master decide` for the answered one.
 */
export function throughputClaimVisibility(measurement: { report: ThroughputReport; file: string } | null, deployed: { revision: string | null; version: string | null }, deliveries: number,
  pursuit: ThroughputPursuit | null = null, ownerItem: Pick<Work, 'key'> | null = null): ThroughputVisibility {
  const command = throughputMeasurementCommand;
  const admitted = measurement?.report.population?.admitted ?? 0, ownerKey = ownerItem?.key ?? null;
  const owner = { item: ownerKey, admitted, needed: throughputClaim.minimumDeliveries, measuredAt: measurement?.report.measuredAt ?? null };
  const progress = `${ownerKey ? `${ownerKey} owns the verification` : 'No open item owns the verification yet (the loop files one on its next unverified measurement of a release whose owner has not closed on an answered needs-decision, and within one cycle while a needs-decision stands)'}: ${admitted} admitted of ${throughputClaim.minimumDeliveries}${measurement ? ` in the newest recorded measurement (${measurement.report.measuredAt}, of ${measurement.report.deployed?.revision?.slice(0, 12) ?? 'an unnamed release'})` : ', nothing measured yet'}`;
  const serving = Boolean(measurement && deployed.revision && deployed.revision !== 'unknown' && measurement.report.deployed?.revision === deployed.revision);
  const stall = serving ? throughputStall(measurement!.report, ownerKey) : null, decideOn = ownerKey ?? 'GY-N';
  // GY-1458: a measurement judged under a population rule since revised and applied asks no decision —
  // that one is answered — so the line says none remains and when the loop re-measures under the applied rule.
  const superseded = serving && throughputRuleSuperseded(measurement!.report)
    ? `. No population-rule decision remains: the newest measurement was judged under a population rule since revised, approved and applied, so the loop re-measures the serving release under the applied rule from ${throughputRemeasureFrom(measurement!.report.measuredAt)}`
    : '';
  // The ledger's pursuit (GY-1437): inside its bound the loop carries the claim, so the line is in
  // motion until it is due; past the bound it escalates to the operator, naming the blocker. A
  // population shown unable to accumulate is the typed needs-decision on the owner item (GY-1438).
  const attention = (reason: string): AttentionItem => {
    if (stall) return { subject: 'throughput', kind: 'throughput', text: `${throughputClaim.item}'s throughput claim is unverified against the deployed release and ${stall.text}`,
      ...agentOwner('master', `graphyard master decide ${decideOn} requirements @revision.json "REASON" with a revision that settles the population rule ${throughputClaim.item}'s claim is judged over or the coordination that leaves these fingerprints, then graphyard master approver ${decideOn} DECISION; the loop closes ${decideOn} once it is applied`, 'approver') };
    const text = `${throughputClaim.item}'s throughput claim is unverified against the deployed release: ${reason}. ${progress}${superseded}`;
    if (!pursuit) return { subject: 'throughput', kind: 'throughput', text: `${text}; the loop re-measures the serving release at most every ${Math.round(throughputRemeasureMs / 60_000)} min while it stays unverified`, ...agentOwner('master', command) };
    if (!pursuit.escalated) return { subject: 'throughput', kind: 'throughput', text: `${text}; ${pursuit.text}`, inMotionUntil: pursuit.dueAt, ...agentOwner('master', command) };
    // Past the bound the line names the blocker. Only two blockers are a human's to remove (AGENTS.md):
    // a credential for the measurement, or whether deliveries may run with no master session at all.
    // An unreachable plane, an unconfirmed release or a failed or missed measurement stays the master's.
    const escalated = `${text}; escalated: ${pursuit.text}`;
    if (pursuit.blocker === 'missing-credentials') return { subject: 'throughput', kind: 'throughput', text: escalated,
      ...humanOwner('issuing credentials to people', `Issue the measurement a coordinator or reader credential for the control plane, then run ${command}`) };
    if (pursuit.blocker === 'no-session-free-deliveries') return { subject: 'throughput', kind: 'throughput', text: escalated,
      ...humanOwner('goals and priorities', `Decide whether to let routine deliveries run with no master session until ${throughputClaim.minimumDeliveries} accumulate, or to accept ${throughputClaim.item}'s claim as unverified`) };
    return { subject: 'throughput', kind: 'throughput', text: escalated, ...agentOwner('master', command) };
  };
  const base = { claim: throughputClaim, deployed, command, owner, stall, pursuit,
    measurement: measurement ? { at: measurement.report.measuredAt, deployedRevision: measurement.report.deployed?.revision ?? null,
      admitted: measurement.report.population?.admitted ?? 0, submitToMergeP50Ms: measurement.report.submitToMerge?.p50Ms ?? null,
      idleMaxMs: measurement.report.idle?.maxMs ?? null, file: measurement.file } : null };
  const unverified = (reason: string, shortfall: ThroughputReport['shortfall'] = null): ThroughputVisibility => ({ ...base, verdict: 'unverified', reason, shortfall,
    attention: deliveries ? attention(reason) : null });
  if (!measurement) return unverified(`no post-deploy measurement has ever been recorded under ${throughputMeasurementDirectory}, so the claim (${throughputClaim.statement}) is delivered but unproven; the loop records one after it next verifies a deployment`);
  const measured = measurement.report.deployed?.revision ?? null;
  if (!deployed.revision || deployed.revision === 'unknown') return unverified(`the control plane reports no build revision, so the last measurement (of ${measured ?? 'an unnamed release'} at ${measurement.report.measuredAt}) cannot be matched to what is serving`, measurement.report.shortfall ?? null);
  if (measured !== deployed.revision) return unverified(`the last measurement was taken against ${measured ?? 'an unnamed release'} at ${measurement.report.measuredAt}; the release now serving is ${deployed.revision.slice(0, 12)}`, measurement.report.shortfall ?? null);
  if (measurement.report.deployed?.containsClaim !== true) return unverified(`the last measurement did not establish that ${deployed.revision.slice(0, 12)} contains ${throughputClaim.item}'s merge${measurement.report.deployed?.reason ? `: ${measurement.report.deployed.reason}` : ''}`, measurement.report.shortfall ?? null);
  if (measurement.report.verdict !== 'verified') return unverified(measurement.report.reason, measurement.report.shortfall ?? null);
  return { ...base, pursuit: null, verdict: 'verified', reason: measurement.report.reason, shortfall: null, attention: null };
}

/** The claim's visibility as master status reads it: the recorded measurement, the release the control plane says is serving, and the delivered items. */
export async function throughputStatus(root: string, coordinator: Parameters<typeof deployedRevision>[0] & { release?: { version?: string | null } | null }, work: Work[], now = Date.now()): Promise<ThroughputVisibility> {
  return throughputClaimVisibility(await readThroughputMeasurement(root).catch(() => null),
    { revision: deployedRevision(coordinator).revision, version: coordinator?.release?.version ?? null },
    work.filter(item => item.stage === 'done' && item.delivery).length,
    throughputPursuit(await readThroughputLedger(join(root, throughputMeasurementDirectory)), now), openThroughputOwner(work));
}
