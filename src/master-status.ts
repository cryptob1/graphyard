import { agentOwner, buildMasterStatus, concurrencyAttention, inventoryWorktrees, roleConcurrency, type AttentionItem, type HerdrAgent, type MasterConfig } from './master.js';
import type { ActionRow } from './model/actions.js';
import { classified, classifyAttention, groupFaults } from './model/fault-classes.js';
import type { Work } from './model.js';
import { producerLedgerSpec, sessionRetries, summarizeProducers, type ProducerRecord } from './producer.js';
import { reviewLedgerSpec, sessionLedgerRefusal, sessionLedgerRemedy, summarizeReviews, type ReviewRecord } from './reviewer.js';
import { reviewConflictAttention } from './model/review-conflict.js';
import type { SettledReviewSession } from './model/dispatch.js';
import { dispatchFailureAttention, dispatchSummary, readDispatchCursor } from './auto-dispatch.js';
import { agentRequestAttention } from './cli/loop-report.js';
import { owedAttention, scopeRequestAttention } from './cli/owed-report.js';
import { executorFleet } from './cli/executor-report.js';
import { stuckRequestReport } from './cli/stuck-requests.js';
import { stalledItemAttention } from './cli/status-attention.js';
import { stalledActionAttention } from './cli/stalled-actions.js';
import { overlongSessionAttention } from './cli/overlong-sessions.js';
import { githubBudgetAttention } from './cli/github-budget-attention.js';
import { unansweredRequestAttention, unobtainableReviewAttention } from './cli/unanswered-requests.js';
import { consentHoldItems } from './cli/consent-holds.js';
import { setupHealth } from './cli/master-setup.js';
import { attributionFor, describeReading, loadedRevision, readDisk, readPlaneResources, readReclaimReports, readResources, resourceAttention, type ResourceReading } from './master-resources.js';

/**
 * A launch refused by a full session ledger is attributed to that ledger (GY-131).
 *
 * The refusal is local state: `.graphyard/reviews.json` or `.graphyard/producers.json` could not
 * take another record. On 2026-09-23 the review ledger was full and `master status` showed each
 * starved item as `reviewer agent review-claude-1 is busy in Herdr` — reviewer capacity — while
 * the real fault was the file. Every row whose review or producer launch carries a ledger refusal
 * (a dispatch failure, or a failed action row) gets one attention item naming the ledger, its bound,
 * the live count and the remedy, and every other attention for that item that blamed capacity or
 * repeated the raw refusal is replaced by it. The row's own attention is replaced only when it is
 * about a launch; one ranked above it (quarantine, a human-only park, a merge violation) stays,
 * with its owner, and the ledger item is listed beside it. Only a refusal that stands now counts:
 * a dispatch failure, or an action back in the queue whose latest event is a failure — an action
 * that failed once on a full ledger and has since been claimed again or completed says nothing
 * about the file.
 * `counts.attention`, when given, is moved by exactly the items removed and added, so it keeps
 * matching the list.
 */
export function ledgerRefusalAttention<T extends { work: any[]; attentionItems: AttentionItem[]; counts?: { attention: number } }>(status: T, work: Work[]): T {
  // Per item, one standing refusal per ledger: a refused review and a refused producer launch are separate faults.
  const refusals = new Map<string, Map<LedgerKind, RegExpMatchArray>>();
  // What an action says now: its failed resolution, its stall, or a latest event that is a failure.
  // A reclaimed row keeps its last failure and stall while the new attempt runs, so only a row
  // back in the queue with a failure as its latest event is still refused.
  const standing = (action: ActionRow) => action.state !== 'pending' || action.history.at(-1)?.event !== 'failed' ? []
    : [action.resolution, action.stall?.reason, action.history.at(-1)!.reason];
  for (const row of status.work as { key: string; dispatch?: { review: { failure?: { reason: string } | null } | null; producers: { failure?: { reason: string } | null }[] } | null }[]) {
    const item = work.find(candidate => candidate.key === row.key);
    const reasons = [row.dispatch?.review?.failure?.reason, ...(row.dispatch?.producers ?? []).map(request => request.failure?.reason), ...(item?.actionQueue?.actions ?? []).flatMap(standing)];
    const byKind = new Map<LedgerKind, RegExpMatchArray>();
    for (const match of reasons.map(reason => reason?.match(sessionLedgerRefusal))) if (match && !byKind.has(match[1] as LedgerKind)) byKind.set(match[1] as LedgerKind, match);
    if (byKind.size) refusals.set(row.key, byKind);
  }
  if (!refusals.size) return status;
  const items: AttentionItem[] = [], replaced = new Map<string, string | null>();
  const rows = status.work.map((row: { key: string; attention: string | null }) => {
    const byKind = refusals.get(row.key);
    if (!byKind) return row;
    const own = [...byKind.values()].map(([, kind, path, bound, live]) => {
      const spec = kind === 'review' ? reviewLedgerSpec : producerLedgerSpec;
      const text = `${row.key}'s ${kind === 'review' ? 'review' : 'proof producer'} cannot be requested because the ${spec.name} (${path}) refused the write: its bound is ${bound} records and ${live} are live sessions. This is local state, not ${spec.role} capacity`;
      return { subject: row.key, text, ...agentOwner('master', `${sessionLedgerRemedy(spec)}; master status reports the ledger's headroom under ledgers`) } as AttentionItem;
    });
    items.push(...own);
    // A row reporting something ranked above a launch — quarantine, a human-only park, an
    // unauthorized or reverted merge, an offline worker — keeps it; the ledger item is listed beside it.
    if (!aboutLaunch(row)) return row;
    replaced.set(row.key, row.attention);
    const { subject, text: attention, ...owner } = own[0];
    return { ...row, attention, attentionOwner: owner };
  });
  // What the item used to say about a refused launch — its row's attention, the busy agent, the raw
  // launch refusal, a stalled row repeating it — gives way to that ledger's item. Supersession is
  // per launch: a review ledger refusal never hides a stalled or refused producer launch, nor the reverse.
  const superseded = (entry: AttentionItem) => {
    const byKind = refusals.get(entry.subject);
    if (!byKind) return false;
    if (replaced.has(entry.subject) && entry.text === replaced.get(entry.subject)) return true;
    const kind = attentionLaunchKind(entry.text);
    return !!kind && byKind.has(kind);
  };
  const attentionItems = [...status.attentionItems.filter(entry => !superseded(entry)), ...items];
  const counts = status.counts && { ...status.counts, attention: status.counts.attention + attentionItems.length - status.attentionItems.length };
  return { ...status, work: rows, attentionItems, ...(counts ? { counts } : {}) };
}

type LedgerKind = 'review' | 'producer';

/**
 * Whether a row's attention is the item's launch, or nothing ranked above it: no attention, the
 * gate or dwell fallback, a refused, retried, unacknowledged or exhausted review or producer launch.
 */
function aboutLaunch(row: { attention: string | null; refusal?: { reason: string } | null }): boolean {
  const text = row.attention;
  if (!text || text === row.refusal?.reason || /^Work has remained at \S+ for more than one hour$/.test(text)) return true;
  if (/^Every configured reviewer profile is exhausted/.test(text)) return true;
  if (/^(Reviewer session|Producer session for \S+ proofs) of \S+ ((failed|expired) after attempt|\(\S+\) is awaiting acknowledgement)/.test(text)) return true;
  return !!attentionLaunchKind(text);
}

/** Which launch an attention text is about, when it is about a launch at all. */
function attentionLaunchKind(text: string): LedgerKind | null {
  const refusal = text.match(sessionLedgerRefusal);
  if (refusal) return refusal[1] as LedgerKind;
  if (/reviewer agent \S+ is busy in Herdr|request-review action|review launch for \S+ refused/i.test(text)) return 'review';
  if (/producer profile is busy|producer launch for \S+ refused/i.test(text)) return 'producer';
  return null;
}

/**
 * The resource picture `master status` reports (GY-132): every registered resource as used of
 * bound with its headroom, one attention item per resource below its warning line, and the last
 * reclaim the loop recorded. It reads what the report already holds — the ledgers, Herdr, the
 * work snapshot, the loop's liveness — and adds the plane's own report from `/healthz`, the
 * worktree volume and the revision the running loop loaded.
 */
export async function resourceStatus(root: string, master: MasterConfig, observed: {
  reviews: ReviewRecord[] | null; producers: ProducerRecord[] | null; agents: HerdrAgent[] | null; work: Work[];
  loop: { lagMs: number | null; stalledAfterMs: number; detail: string; lock: { pid: number; host: string } | null } | null;
}, deps: { fetcher?: typeof fetch; run?: (command: string, args: string[]) => string; now?: number } = {}) {
  const now = deps.now ?? Date.now();
  const lock = observed.loop?.lock;
  const revision = lock && lock.host === master.hostId ? loadedRevision(root, lock.pid, deps.run, now) : null;
  const readings = readResources({ now, reviews: observed.reviews, producers: observed.producers, agents: observed.agents, work: observed.work,
    profiles: { workers: master.workers, reviewers: master.reviewers, producers: master.producers },
    plane: await readPlaneResources(master.url, deps.fetcher), loop: observed.loop, revision, disk: await readDisk(root, master) });
  const attention = resourceAttention(readings);
  return { readings, attention, report: resourceReport(readings, (await readReclaimReports(root)).at(-1) ?? null) };
}

/** The `resources` block of `master status`: one row per reading, with a one-line summary. */
export function resourceReport(readings: ResourceReading[], lastReclaim: unknown) {
  const pressed = readings.filter(reading => reading.state === 'low' || reading.state === 'exhausted');
  return {
    summary: `${readings.length} resource reading(s): ${pressed.length ? pressed.map(reading => `${reading.id} ${reading.state}`).join(', ') : 'all within their warning lines'}${readings.some(reading => reading.state === 'unknown') ? `; unread: ${readings.filter(reading => reading.state === 'unknown').map(reading => reading.id).join(', ')}` : ''}`,
    readings: readings.map(({ id, title, unit, used, bound, headroom, warnBelow, state, detail, owner, reclaim, reclaimable, waiting }) => ({ id, title, unit, used, bound, headroom, warnBelow, state, detail, owner, reclaim, reclaimable, ...(waiting === undefined ? {} : { waiting }) })),
    lastReclaim,
  };
}

/**
 * Names the resource in place of the symptom. An attention item whose text is the downstream
 * effect of a resource at its bound — a reviewer "busy in Herdr" on a name a finished pane holds,
 * a launch refused by a full ledger, a stalled action repeating either — is rewritten to name the
 * resource, its bound and its usage, and keeps its subject; its next step becomes the resource's remedy.
 */
export function attributeAttention(items: AttentionItem[], readings: ResourceReading[]): AttentionItem[] {
  return items.map(item => {
    if (item.subject.startsWith('resource:')) return item;
    const reading = attributionFor(item.text, readings);
    if (!reading) return item;
    return { ...item, text: `${item.subject} is held by a registered resource at its bound: ${describeReading(reading)}. ${reading.remedy}`, next: reading.remedy, kind: 'resource-bound' };
  });
}

/**
 * The final attention list with every item's fault kind and class (GY-173), and the open problems
 * grouped by class with a count. It runs on the list as `master status` reports it — after the
 * ledger and resource attribution — so an item rewritten to name a resource is counted as one.
 */
export function faulted(items: AttentionItem[]) {
  const attentionItems = classifyAttention(items);
  return { attentionItems, faults: groupFaults(attentionItems) };
}

/**
 * The lines `master status` builds from the snapshot, the session ledgers and the host after
 * `buildMasterStatus` (GY-173): scope and agent requests, consent holds, review conflicts, stuck and
 * unanswered requests, reviews no session can obtain, stalled items and actions, overlong sessions, the
 * GitHub budget, unserved executors and owed judgments. The report and the loop both read them from
 * here, so every class the report shows is one the loop counts. The report passes the rows and
 * checkouts it already has; the loop, reading them `standalone`, has them derived here and also reads
 * the setup and the dispatcher, which the report reads before everything else.
 */
export async function derivedAttention(root: string, master: MasterConfig, masterApi: (path: string) => Promise<any>, coordinator: any, snapshot: { work: Work[]; now: string },
  observed: { reviews: ReviewRecord[]; producers: ProducerRecord[]; runtime: { available: boolean; agents: HerdrAgent[] }; rows?: ReturnType<typeof buildMasterStatus>['work']; trees?: (string | { path: string })[]; standalone?: boolean }) {
  const reviews = summarizeReviews(observed.reviews), now = Date.parse(snapshot.now);
  const rows = observed.rows ?? buildMasterStatus(snapshot, master.workers, observed.runtime.available ? observed.runtime.agents : [], {}, {}, reviews, master.baseBranch, coordinator ?? undefined,
    { producers: summarizeProducers(observed.producers), failures: [], retries: [] }).work;
  const scopeRequests = [...scopeRequestAttention(snapshot), ...agentRequestAttention(snapshot), ...consentHoldItems(observed.trees ?? await inventoryWorktrees(root).catch(() => []), snapshot)];
  const unobtainable = unobtainableReviewAttention(rows, reviews.completed as SettledReviewSession[]);
  const unanswered = unansweredRequestAttention(rows);
  const stalledItems = stalledItemAttention(snapshot);
  // An action no live executor can claim is not queued behind other work (GY-105); it is named with its wait and the unit to start.
  const executors = await executorFleet(root, masterApi, snapshot);
  // A request two verdicts answered (GY-124): neither is acted on until a fresh review resolves it.
  const conflicted = reviewConflictAttention(snapshot.work, observed.reviews).map(({ next, ...item }) => ({ ...item, ...agentOwner('control plane', next) }));
  // A row that keeps failing for the same reason: owed, attempted, and going nowhere.
  const stalled = stalledActionAttention(snapshot);
  // What waits on a judgment rather than on capacity, named once and counted apart (GY-104).
  const owed = owedAttention(snapshot, rows as { key: string; attention: string | null }[], scopeRequests);
  // The GitHub budget (GY-117): a pause as one incident, an exhaustion ahead, a silent webhook.
  const budget = githubBudgetAttention(coordinator);
  const overlong = overlongSessionAttention(snapshot, { ...observed.runtime, hostId: master.hostId }, { proof: master.run.producerTimeoutMinutes * 60_000 });
  const stuck = stuckRequestReport({ reviews: observed.reviews, producers: observed.producers }, now).attentionItems;
  const host: AttentionItem[] = [];
  if (observed.standalone) {
    const cursor = await readDispatchCursor(root, master, () => {}).catch(error => ({ error: error instanceof Error ? error.message : 'Master dispatch cursor is unreadable' }));
    const dispatch = 'error' in cursor ? cursor : dispatchSummary(cursor, now, master.run.dispatchIntervalSeconds * 1000);
    host.push(...dispatchFailureAttention(dispatch), ...(await setupHealth(root, master)).attention);
    // A starved reviewer or producer role (GY-107), which the report's own buildMasterStatus raises from the role profiles.
    const sessions = { producers: summarizeProducers(observed.producers), failures: 'error' in dispatch ? [] : dispatch.failures, retries: [...sessionRetries(observed.reviews, now), ...sessionRetries(observed.producers, now)] };
    host.push(...concurrencyAttention([roleConcurrency('reviewer', master.reviewers, snapshot.work, observed.runtime.agents, reviews, sessions, now), roleConcurrency('producer', master.producers, snapshot.work, observed.runtime.agents, sessions.producers, sessions, now)])
      .map(item => ({ ...item, ...classified('concurrency-starved') })));
  }
  return { scopeRequests, unobtainable, unanswered, stalledItems, executors, conflicted, stalled, owed, budget, overlong,
    items: [...host, ...executors.attention, ...scopeRequests, ...unanswered, ...unobtainable, ...conflicted, ...stuck, ...stalledItems, ...stalled, ...overlong, ...budget, ...owed.items] };
}
