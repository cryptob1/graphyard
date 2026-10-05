// Delivery-flow causes (GY-879). Reads the work snapshot and the events ledger with a read-capable
// credential, takes the last N delivered items (100 by default), and measures where their time went:
//
// - AC-1: every rework round of the last 100 deliveries classified by cause — own-change review
//   finding, CI failure on own change, base breakage, conflict with base, docs/word budget, lost
//   approval or proof, gate disagreement, stale observation, other — with each cause's share.
// - AC-2: each delivery's waiting time split by what it waited on — no worker slot, CI, review,
//   proof, approver decision, merge queue, observation, gate disagreement — with each share.
//
// The classification reads recorded text alone (GY-643's discipline): the rework reason is the only
// AC-1 input, and AC-2 reads only facts the ledger recorded. The GY-643 taxonomy, the fact
// projection (deriveFacts), the dashboard's step rule (gateFactStep), the merge-ready rule and the
// nearest-rank percentiles are imported from src/ through tsx so this
// script and `master status` can never disagree about a number; only the two new GY-879 causes and
// the review/CI split live here, layered in front of the shared classifier.
//
// AC-2's window is each item's first submission → accepted merge (mergedAtRepository ?? mergedAt,
// the pipeline-speed convention). The ledger rows of each item are read in full payload — with the
// routine rows included (`routine=include`: the `github.observed` rows are where CI checks, reviews,
// queue state and merge gates are recorded) — and folded through deriveFacts per item —
// `gates.changed` is a projected fact, not a raw ledger kind — and the interval between consecutive
// facts is attributed to exactly one cause: a slice a pipeline attempt (claimedAt → endedAt) covers
// is execution, never waiting; a slice an open approver decision (decision.requested → decided)
// covers is approver-decision; the rest follows the step the gate fact places the item at.
// Clock-inverted intervals clamp to zero, open intervals close at the merge, and no interval opens
// from a fact observed at or after the merge. Items with no recorded submission, no attempt records
// (unknown execution), pruned events or an exhausted read are named, never dropped.
//
//   GRAPHYARD_URL=… GRAPHYARD_TOKEN=… node scripts/delivery-causes.mjs [--items 100] [--record DIR] [--json]
//
// The whole-ledger `rework` read needs a credential beyond a scoped operator-agent (a reader or
// coordinator token); per-item event reads are always allowed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const time = value => {
  const parsed = typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export function parseArguments(argv) {
  const options = { items: 100, record: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--items') { options.items = Number(value()); if (!Number.isInteger(options.items) || options.items < 1) throw new Error('--items needs a positive integer'); }
    else if (argument === '--record') options.record = value();
    else if (argument === '--json') options.json = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  return options;
}

/** The accepted merge instant of a delivered item, on the repository clock when the delivery carried it there. */
export const mergedAtOf = item => item.stage === 'done' && item.delivery ? item.delivery.mergedAtRepository ?? item.delivery.mergedAt ?? null : null;

/**
 * The causes AC-1 names, closed: every round lands in exactly one, and an unmatched round is
 * `other` — counted, never guessed into a named cause. GY-643's `ci-flake` reduces onto `other`
 * (an unnegated flake is a real recorded cause but not one of the nine, so it stays counted under
 * `other` with its marker kept for audit).
 */
export const deliveryReworkCauses = ['own-change-review', 'own-change-ci', 'base-breakage', 'conflict-with-base', 'docs-budget', 'lost-approval-or-proof', 'gate-disagreement', 'stale-observation', 'other'];

/**
 * The GY-879 rules, layered in front of GY-643's (src/flow-analytics.ts `reworkCauseRules`):
 * first the structural disagreement records (src/engine.ts unauthorized-merge and reconciliation
 * vocabulary, src/merge-queue.ts `reconciliationRefusalPrefix`), then the historical-authorization
 * refusals a reconciliation quotes, then the stale-observation wording
 * (src/daemon/decisions.ts `reworkObservationWait`), each with negation lookbehinds in the
 * GY-643 style so "not stale", "no disagreement" and a "no longer" inside an unrelated sentence
 * never fire. Precedence is the brief's: a conflict decided from a stale observation is a
 * stale-observation round (these rules run before GY-643's), and a reconciliation refusal quoting
 * gate texts is a gate-disagreement round (those markers run before the stale-observation ones).
 * The winning rule's marker is returned so every classification is auditable.
 */
export const deliveryReworkCauseRules = [
  { cause: 'gate-disagreement', marker: 'reconciliation refusal record', pattern: /\breconciliation\b[^.\n]{0,60}\brefused\b/i },
  { cause: 'gate-disagreement', marker: 'unauthorized merge violation', pattern: /\bmerge observed without a (prior )?authorization\b/i },
  { cause: 'gate-disagreement', marker: 'record did not authorize either', pattern: /\bthe record at\b[^\n]{0,90}\bdid not either\b/i },
  { cause: 'gate-disagreement', marker: 'violation stood at the cutoff', pattern: /\bviolations? stood\b/i },
  { cause: 'gate-disagreement', marker: 'records disagree about one fact', pattern: /\b(?<!\bno\b[^.\n]{0,20})(?<!\bnot\b[^.\n]{0,20})(observations|records|clocks|trusted records) disagree\b/i },
  { cause: 'gate-disagreement', marker: 'gate had not passed at the merge cutoff', pattern: /\bgate \w+ had not passed\b/i },
  { cause: 'gate-disagreement', marker: 'proof had no live trusted evidence at the cutoff', pattern: /\brequired proof \S+ had no live trusted evidence\b/i },
  { cause: 'gate-disagreement', marker: 'no authorization stood at the merge cutoff', pattern: /\bno merge authorization for\b[^.\n]{0,80}\bstood at the merge cutoff\b/i },
  { cause: 'gate-disagreement', marker: 'authorization not recorded before the merge', pattern: /\bmerge authorization was recorded at\b[^.\n]{0,60}\bnot before the merge\b/i },
  { cause: 'stale-observation', marker: 'stale observation named', pattern: /\b(?<!\bnot\b[^.\n]{0,20})(?<!\bno\b[^.\n]{0,20})(?<!\bnever\b[^.\n]{0,20})stale observation\b/i },
  { cause: 'stale-observation', marker: 'observation older than two minutes', pattern: /\bobservation\b(?![^.\n]{0,80}\bnot stale\b)[^.\n]{0,80}\bolder than two minutes\b/i },
  { cause: 'stale-observation', marker: 'observation may describe a moved-past head', pattern: /\bobservation\b[^.\n]{0,80}\b(head|branch)\b[^.\n]{0,40}\bmoved past\b/i },
  { cause: 'stale-observation', marker: 'branch has moved past the observed head', pattern: /\b(?:branch|head)\b(?![^.\n]{0,40}\bnot\b)[^.\n]{0,40}\bhas moved past\b/i },
  { cause: 'stale-observation', marker: 'observation no longer describes the item', pattern: /\b(observation|request|verdict)\b[^.\n]{0,80}\bno longer describes\b/i },
];

/** An own-change round is a CI round when its text names the required check that failed, else a review round. */
const ownChangeCiMarkers = [/\brequired CI check/i, /\bwhat CI found\b/i, /\bcheck[s]?\b[^.\n]{0,30}\bfailed on (candidate|head)\b/i, /\bmodule budget\b/i];

/**
 * The cause of one rework round: the GY-879 rules first, then GY-643's classifier (`base`, the
 * imported `classifyReworkReason`), then the own-change split. `base` is injected by the caller so
 * the script and `master status` read the same rules; without one, only the GY-879 causes match.
 */
export function classifyDeliveryReworkReason(reason, base) {
  const text = String(reason ?? '');
  for (const rule of deliveryReworkCauseRules) if (rule.pattern.test(text)) return { cause: rule.cause, marker: rule.marker };
  if (!base) return { cause: 'other', marker: null };
  const cause = base(text);
  if (cause.cause === 'own-change') {
    if (ownChangeCiMarkers.some(pattern => pattern.test(text))) return { cause: 'own-change-ci', marker: cause.marker };
    return { cause: 'own-change-review', marker: cause.marker };
  }
  if (cause.cause === 'ci-flake') return { cause: 'other', marker: cause.marker };
  // GY-643 names the cause `conflict`; AC-1's taxonomy names the same rounds `conflict-with-base`.
  return { cause: cause.cause === 'conflict' ? 'conflict-with-base' : cause.cause, marker: cause.marker };
}

/**
 * Rounds per delivered item: every `rework` row for the item at or after its first submission —
 * the same rule the pipeline timeline counts by (`recordRework`). Items with no recorded
 * submission are reported as unmeasured rather than silently dropped.
 */
export function attributeDeliveryRounds(delivered, events, classify) {
  return delivered.map(item => {
    const submittedAt = item.pipeline?.submittedAt ?? null;
    const submitted = !!submittedAt && Number.isFinite(Date.parse(submittedAt));
    const rounds = submitted ? events.filter(event => event.work_id === item.id && Number.isFinite(Date.parse(event.created_at)) && Date.parse(event.created_at) >= Date.parse(submittedAt))
      .map(event => ({ workId: item.id, key: item.key, seq: String(event.seq),
        at: event.created_at instanceof Date ? event.created_at.toISOString() : String(event.created_at),
        ...classify(String(event.details?.reason ?? '')) })) : [];
    return { key: item.key, id: item.id, mergedAt: mergedAtOf(item), measured: submitted, rounds };
  });
}

/** Bounded paged read of the window's `rework` rows (small `details` payloads, no work documents). */
export async function readReworkEvents(api, since, bounds = {}) {
  const limit = bounds.limit ?? 300, pageBound = bounds.pages ?? 10;
  const rounds = [];
  let cursor = null, complete = false, pages = 0;
  while (cursor !== null || pages === 0) {
    const params = new URLSearchParams({ kind: 'rework', order: 'asc', payload: 'details', view: 'history', limit: String(limit) });
    if (since) params.set('since', since);
    if (cursor) params.set('cursor', cursor);
    const history = await api(`events?${params}`);
    rounds.push(...(history.events ?? []));
    pages++;
    complete = !history.page?.hasMore;
    cursor = complete ? null : history.page?.nextCursor ?? null;
    if (pages >= pageBound) break;
  }
  return { rounds, complete, pages };
}

/** Bounded paged read of one item's history from a given instant on, with the work snapshots the fold needs. The waiting window opens at the item's first submission, so the read starts there: pre-submission history (backlog, blocks, earlier epochs' rework) is not part of the split, and the routine rows the server would summarise away are requested (`routine=include`) because the `github.observed` rows carry the CI, review, queue and gate transitions. The walk is capped at a deterministic row budget (`pages` × `limit`): light pages keep every request well inside the client timeout, and an item whose window holds more rows than the cap yields a split over the part read — a floor the report discloses. */
export async function readDeliveryEvents(api, workId, bounds = {}) {
  const limit = bounds.limit ?? 100, pageBound = bounds.pages ?? 24;
  const events = [];
  let cursor = null, complete = false, pages = 0;
  while (cursor !== null || pages === 0) {
    // routine=include: the ledger's routine rows (`github.observed`, `heartbeat`) are excluded by
    // default (src/events-history.ts `eventSelection`), and the `github.observed` rows are where
    // the reconciliation pass records CI checks, reviews, queue state and merge gates — without
    // them the fold would leave an item parked at an older gate fact until some later non-routine
    // row, corrupting the waiting split.
    const params = new URLSearchParams({ work: workId, order: 'asc', payload: 'full', view: 'page', routine: 'include', limit: String(limit) });
    if (bounds.since) params.set('since', bounds.since);
    if (cursor) params.set('cursor', cursor);
    const history = await api(`events?${params}`);
    events.push(...(history.events ?? []));
    pages++;
    complete = !history.page?.hasMore;
    cursor = complete ? null : history.page?.nextCursor ?? null;
    if (pages >= pageBound) break;
  }
  return { events, complete, pages };
}

/** What a delivery's waiting time is split by: the seven causes AC-2 names plus gate disagreement, the rethink's own fault class the merge-gate refusals carry. Slices always sum to the window with execution. */
export const waitCauses = ['no-worker-slot', 'ci', 'review', 'proof', 'approver-decision', 'merge-queue', 'observation', 'gate-disagreement'];

/** Merge-gate refusal texts that name an approver decision rather than a gate disagreement (GY-176, holds and escalations). */
const approverDecisionMarkers = [/\bescalat/i, /\bhold\b/i, /\bdecision\b/i, /\bapprov/i];
/** Merge-gate refusal texts that name the observation-freshness wait (GY-710): what it waited on is a fresh GitHub observation. */
const observationWaitMarkers = [/\bobservation\b[^.\n]{0,40}\b(missing|older than two minutes)\b/i, /\bmissing or older than two minutes\b/i, /\bstale observation\b/i];

/**
 * One delivery's waiting time by cause (AC-2). `events` are the item's full-payload ledger rows in
 * any order; `helpers` carries the imported analytics ({ deriveFacts, gateFactStep, mergeReadyGate }). The rows are folded through `deriveFacts` with a state reset per item —
 * `gates.changed` is a projected fact the raw ledger never stores — and the window (first
 * submission → accepted merge) is swept as ordered slices bounded by gate-fact instants, attempt
 * endpoints and decision endpoints. Each slice is classified into exactly one bucket: execution
 * when a pipeline attempt covers it (pipeline-speed arithmetic, so execution and waiting never
 * double count), else approver-decision when an open approver decision covers it, else the cause of
 * the step the last gate fact places the item at (`gateFactStep`, refined at the merge step by
 * merge-ready → merge-queue, recorded refusal text → gate-disagreement, escalation/hold/decision →
 * approver-decision, observation-freshness → observation). Gate facts observed at or after the
 * merge never open an interval, negative intervals clamp to zero, and everything still open closes
 * at the merge. An item with no recorded submission, no delivery, no attempt records (its execution
 * is unknown), or no readable gate facts is named by `coverage` and contributes nothing, never
 * silently.
 */
export function deliveryWaitingTimeByCase(item, events, helpers) {
  const zero = () => Object.fromEntries(waitCauses.map(cause => [cause, 0]));
  const result = { measured: false, coverage: 'unmeasured', windowMs: 0, executionMs: 0, totalWaitMs: 0, byCause: zero(), slices: [] };
  const submittedMs = time(item.pipeline?.submittedAt);
  const mergedMs = time(mergedAtOf(item));
  if (submittedMs === null) { result.coverage = 'no-submission'; return result; }
  if (mergedMs === null) { result.coverage = 'undelivered'; return result; }
  result.windowMs = Math.max(0, mergedMs - submittedMs);
  // A backfilled item can carry no attempt records at all: its execution is unknown, so no part of
  // its window is convertible into a waiting split. The report names it (unmeasured-execution,
  // pipeline-speed's awaiting-backfill discipline and precedence) rather than turning unknown
  // worker execution into waiting time.
  if (!(item.pipeline?.attempts ?? []).length) { result.coverage = 'unmeasured-execution'; return result; }

  // Fold the raw ledger rows into flow facts (state resets per item), and pair each approver
  // decision's request with the row that settled it — an unmatched request still counts as
  // approver wait, closed at the merge.
  const state = {};
  const facts = [];
  const decisions = new Map();
  for (const event of events) {
    facts.push(...helpers.deriveFacts(event, state));
    const id = event.payload?.id ?? event.payload?.details?.id;
    if (id === undefined || id === null) continue;
    const key = String(id);
    if (event.kind === 'decision.requested') decisions.set(key, { requestedAt: time(event.created_at), resolvedAt: null });
    else if (/^decision\.(approved|declined|failed|applied|withdrawn|stale)$/.test(event.kind) && decisions.get(key)?.resolvedAt === null) decisions.get(key).resolvedAt = time(event.created_at);
  }

  const gateFacts = facts.filter(fact => fact.kind === 'gates.changed' && time(fact.observedAt) !== null && time(fact.observedAt) < mergedMs)
    .map(fact => ({ details: fact.details, at: time(fact.observedAt), sourceEvent: fact.sourceEvent }))
    .sort((a, b) => a.at - b.at || a.sourceEvent - b.sourceEvent);
  if (!gateFacts.length) { result.coverage = events.length ? 'no-gate-facts' : 'events-pruned'; return result; }

  const attempts = (item.pipeline?.attempts ?? []).map(attempt => ({ start: time(attempt.claimedAt), end: time(attempt.endedAt) }))
    .filter(pair => pair.start !== null && pair.end !== null && pair.end > pair.start)
    .map(pair => ({ start: Math.max(pair.start, submittedMs), end: Math.min(pair.end, mergedMs) }))
    .filter(pair => pair.end > pair.start)
    .sort((a, b) => a.start - b.start);

  const decisionIntervals = [...decisions.values()]
    .map(pair => pair.requestedAt === null ? null : { start: Math.max(pair.requestedAt, submittedMs), end: Math.min(pair.resolvedAt ?? mergedMs, mergedMs) })
    .filter(pair => !!pair && pair.end > pair.start)
    .sort((a, b) => a.start - b.start);

  const gateDisagreementRules = deliveryReworkCauseRules.filter(rule => rule.cause === 'gate-disagreement');
  const waitCauseOfGate = gate => {
    const step = helpers.gateFactStep(gate.details);
    if (step === 'validate' || step === 'test') return 'ci';
    if (step === 'review') return 'review';
    if (step === 'prove') return 'proof';
    if (step === 'deploy') return 'observation';
    if (step === 'merge') {
      if (helpers.mergeReadyGate(gate.details)) return 'merge-queue';
      const reasons = (gate.details.reasons ?? []).map(String);
      const text = reasons.join('\n');
      if (gateDisagreementRules.some(rule => rule.pattern.test(text))) return 'gate-disagreement';
      if (approverDecisionMarkers.some(pattern => pattern.test(text))) return 'approver-decision';
      if (observationWaitMarkers.some(pattern => pattern.test(text))) return 'observation';
      return 'gate-disagreement';
    }
    return 'no-worker-slot';
  };

  const covering = (pairs, at) => pairs.some(pair => pair.start <= at && at < pair.end);
  const gateAt = at => { let gate = null; for (const fact of gateFacts) { if (fact.at <= at) gate = fact; else break; } return gate; };
  const inner = [...new Set([
    ...gateFacts.map(fact => fact.at),
    ...attempts.flatMap(pair => [pair.start, pair.end]),
    ...decisionIntervals.flatMap(pair => [pair.start, pair.end]),
  ].filter(at => at > submittedMs && at < mergedMs))].sort((a, b) => a - b);
  const points = [submittedMs, ...inner, mergedMs];

  const byCause = zero();
  const slices = [];
  let executionMs = 0;
  for (let index = 0; index + 1 < points.length; index++) {
    const start = points[index], end = points[index + 1];
    const ms = Math.max(0, end - start);
    if (!ms) continue;
    const gate = gateAt(start);
    const cause = covering(attempts, start) ? 'execution'
      : covering(decisionIntervals, start) ? 'approver-decision'
      : gate ? waitCauseOfGate(gate) : 'no-worker-slot';
    if (cause === 'execution') executionMs += ms;
    else byCause[cause] += ms;
    slices.push({ from: new Date(start).toISOString(), to: new Date(end).toISOString(), ms, cause });
  }
  result.measured = true;
  result.coverage = 'measured';
  result.executionMs = executionMs;
  result.byCause = byCause;
  result.totalWaitMs = waitCauses.reduce((total, cause) => total + byCause[cause], 0);
  result.slices = slices;
  return result;
}

/** The waiting split over one population: totals, shares of the waiting hours, per-delivery percentiles per cause, and the unmeasured named. */
export function summarizeWaiting(results, percentiles) {
  const measured = results.filter(entry => entry.measured);
  const byCause = Object.fromEntries(waitCauses.map(cause => [cause, 0]));
  for (const entry of measured) for (const cause of waitCauses) byCause[cause] += entry.byCause[cause];
  const executionMs = measured.reduce((total, entry) => total + entry.executionMs, 0);
  const totalWaitMs = waitCauses.reduce((total, cause) => total + byCause[cause], 0);
  const windowMs = measured.reduce((total, entry) => total + entry.windowMs, 0);
  const share = ms => totalWaitMs ? Number((ms / totalWaitMs).toFixed(4)) : null;
  const largest = waitCauses.map(cause => ({
    cause, label: cause, ms: byCause[cause], share: share(byCause[cause]),
    p50Ms: percentiles(measured.map(entry => entry.byCause[cause]), 50).p50Ms,
    p90Ms: percentiles(measured.map(entry => entry.byCause[cause]), 90).p90Ms,
  })).sort((a, b) => b.ms - a.ms);
  return {
    delivered: results.length, measured: measured.length, unmeasured: results.length - measured.length,
    windowMs, executionMs, totalWaitMs,
    executionShare: executionMs + totalWaitMs ? Number((executionMs / (executionMs + totalWaitMs)).toFixed(4)) : null,
    waitP50Ms: percentiles(measured.map(entry => entry.totalWaitMs), 50).p50Ms,
    waitP90Ms: percentiles(measured.map(entry => entry.totalWaitMs), 90).p90Ms,
    byCause, shares: Object.fromEntries(waitCauses.map(cause => [cause, share(byCause[cause])])), largest,
    unmeasured: results.filter(entry => !entry.measured).map(entry => ({ key: entry.key, coverage: entry.coverage })),
    readFailed: results.filter(entry => entry.coverage === 'read-failed').map(entry => entry.key),
    unmeasuredExecution: results.filter(entry => !entry.measured && entry.coverage === 'unmeasured-execution').map(entry => entry.key),
    incompleteReads: results.filter(entry => entry.measured && entry.complete === false).map(entry => entry.key),
  };
}

const hours = ms => `${Math.round(ms / 360_000) / 10} h`;
const pct = share => share === null ? 'n/a' : `${String(Math.round(share * 100)).padStart(3)}%`;

export function render(report) {
  const lines = [`Delivery causes over the last ${report.population.items} delivered items (${report.population.delivered} delivered, ${report.population.measured} measured; window ${report.window.since ?? '?'} … ${report.window.until}).`];
  if (report.statement) lines.push(report.statement);
  lines.push(`Rework rounds: ${report.rework.rounds} classified; raw median ${report.rework.rawMedian} p90 ${report.rework.rawP90}; own-change median ${report.rework.ownChangeMedian} p90 ${report.rework.ownChangeP90}.`);
  for (const entry of report.rework.largest) lines.push(`  ${pct(entry.share)}  ${entry.label}: ${entry.count} round${entry.count === 1 ? '' : 's'}`);
  lines.push(`Waiting time: ${hours(report.waiting.totalWaitMs)} of waiting against ${hours(report.waiting.executionMs)} of execution across ${report.waiting.measured} measured deliveries (execution share ${report.waiting.executionShare === null ? 'n/a' : `${Math.round(report.waiting.executionShare * 100)}%`}; pre-release ${hours(report.preRelease.totalMs)} outside this split).`);
  for (const entry of report.waiting.largest) lines.push(`  ${pct(entry.share)}  ${entry.label}: ${hours(entry.ms)} (p50 ${hours(entry.p50Ms)}, p90 ${hours(entry.p90Ms)})`);
  if (report.waiting.unmeasured.length) lines.push(`Unmeasured: ${report.waiting.unmeasured.map(entry => `${entry.key} (${entry.coverage})`).join(', ')}.`);
  const speed = report.pipelineSpeed;
  lines.push(`Pipeline speed: submit→merge p50 ${Math.round(speed.submitToMerge.p50Ms / 60_000)} min p90 ${hours(speed.submitToMerge.p90Ms)} over ${speed.measured} measured deliveries (${speed.unmeasured} unmeasured); execution share ${speed.execution.share === null ? 'n/a' : `${Math.round(speed.execution.share * 100)}%`}.`);
  return lines.join('\n');
}

async function readToken(env) {
  if (env.GRAPHYARD_TOKEN_FILE) return (await readFile(resolve(env.GRAPHYARD_TOKEN_FILE), 'utf8')).trim();
  if (env.GRAPHYARD_TOKEN) return env.GRAPHYARD_TOKEN;
  throw new Error('Set GRAPHYARD_TOKEN or GRAPHYARD_TOKEN_FILE to a credential that can read the ledger (a reader or coordinator token: the whole-ledger rework read is refused to a scoped operator-agent)');
}

/**
 * The analytics pieces are TypeScript; tsx is a runtime dependency of the CLI already. They are
 * imported — never copied — so this script and `master status`/dashboard can never disagree:
 * recentDelivered and classifyReworkReason (GY-643), deriveFacts/gateFactStep/mergeReadyGate
 * (the dashboard's own step and merge-ready rules), pipelineSpeedSummary and nearestRankPercentiles (GY-54), and the page bounds
 * the /api/events contract documents.
 */
export async function analytics() {
  const { tsImport } = await import('tsx/esm/api');
  const flow = await tsImport('../src/flow-analytics.ts', import.meta.url);
  const history = await tsImport('../src/events-history.ts', import.meta.url);
  const speed = await tsImport('../src/pipeline-speed.ts', import.meta.url);
  return {
    recentDelivered: flow.recentDelivered, classifyReworkReason: flow.classifyReworkReason,
    deriveFacts: flow.deriveFacts, gateFactStep: flow.gateFactStep, mergeReadyGate: flow.mergeReadyGate,
    pipelineSpeedSummary: speed.pipelineSpeedSummary, nearestRankPercentiles: speed.nearestRankPercentiles,
    pageLimit: history.eventHistoryLimits.page, reworkPages: flow.reworkEventPages, pageWalkBound: 24,
  };
}

/** Runs `worker` over `items` with at most `limit` in flight, preserving order. Per-item reads are independent, so the population walk parallelises within a small bound. */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * One report: the classified rework rounds (AC-1) and the waiting-time split (AC-2) over the last
 * `options.items` delivered items, with the pipeline-speed headline restated so one run carries the
 * rethink's baselines. `analytics` is the object `analytics()` loads (injected by tests).
 */
export async function collect(api, options, analytics) {
  const { recentDelivered, classifyReworkReason, deriveFacts, gateFactStep, mergeReadyGate, pipelineSpeedSummary, nearestRankPercentiles, pageLimit, reworkPages, pageWalkBound } = analytics;
  const classify = reason => classifyDeliveryReworkReason(reason, classifyReworkReason);
  const snapshot = await api('work-snapshot');
  const population = recentDelivered(snapshot.work, options.items);

  // The sibling reworkRoundsWithOwnCauses (src/flow-analytics.ts) guards its ledger walk the same
  // way: an empty population has nothing to classify, so the whole-ledger rework read — up to
  // reworkPages × pageLimit rows scanned from the ledger start, and the reader credential it is
  // the only step to demand — is skipped and the rework summary stands empty.
  const rework = population.items.length
    ? await readReworkEvents(api, population.since, { pages: reworkPages, limit: pageLimit })
    : { rounds: [], complete: true, pages: 0 };
  const entries = attributeDeliveryRounds(population.items, rework.rounds, classify);
  const rounds = entries.flatMap(entry => entry.rounds);
  const byCause = Object.fromEntries(deliveryReworkCauses.map(cause => [cause, 0]));
  for (const round of rounds) byCause[round.cause] = (byCause[round.cause] ?? 0) + 1;
  const reworkShare = count => rounds.length ? Number((count / rounds.length).toFixed(4)) : null;
  const largest = deliveryReworkCauses.map(cause => ({ cause, label: cause, count: byCause[cause], share: reworkShare(byCause[cause]) }))
    .sort((a, b) => b.count - a.count || deliveryReworkCauses.indexOf(a.cause) - deliveryReworkCauses.indexOf(b.cause));
  const measuredEntries = entries.filter(entry => entry.measured);
  const rawCounts = measuredEntries.map(entry => entry.rounds.length);
  const ownCounts = measuredEntries.map(entry => entry.rounds.filter(round => round.cause === 'own-change-review' || round.cause === 'own-change-ci').length);

  const helpers = { deriveFacts, gateFactStep, mergeReadyGate };
  const skipResult = (item, coverage) => ({ measured: false, coverage, key: item.key, complete: true, windowMs: 0, executionMs: 0, totalWaitMs: 0, byCause: Object.fromEntries(waitCauses.map(cause => [cause, 0])), slices: [] });
  // Six bounded per-item walks in flight, each starting at the item's first submission — the
  // window the split measures — each capped at a deterministic row budget whose exhaustion turns
  // the item's split into a disclosed floor, with one retry because a failed page is usually
  // transient contention between these very walks. An item with no recorded submission or no
  // accepted merge is named without a read.
  const walk = async (item) => {
    const read = await readDeliveryEvents(api, item.id, { pages: pageWalkBound, limit: pageLimit, since: item.pipeline.submittedAt });
    const waiting = deliveryWaitingTimeByCase(item, read.events, helpers);
    waiting.key = item.key;
    waiting.complete = read.complete;
    return waiting;
  };
  const waitingResults = await mapPool(population.items, 6, async (item) => {
    if (!item.pipeline?.submittedAt || !Number.isFinite(Date.parse(item.pipeline.submittedAt)) || mergedAtOf(item) === null) return skipResult(item, 'no-submission');
    try {
      return await walk(item);
    } catch {
      try {
        return await walk(item);
      } catch {
        return skipResult(item, 'read-failed');
      }
    }
  });
  const waiting = summarizeWaiting(waitingResults, nearestRankPercentiles);

  // Pre-release time, from the documents alone: created → first submission, so the total life of
  // each delivery reconciles as pre-release + the measured submission→merge window. (The brief's
  // release→first-claim sliver is bounded by a claim's own length and belongs to neither line.)
  const preReleaseMeasured = population.items.filter(item => Number.isFinite(Date.parse(item.createdAt)) && item.pipeline?.submittedAt && Number.isFinite(Date.parse(item.pipeline.submittedAt)));
  const preReleaseTotalMs = preReleaseMeasured.reduce((total, item) => total + Math.max(0, Date.parse(item.pipeline.submittedAt) - Date.parse(item.createdAt)), 0);

  const speed = pipelineSpeedSummary(snapshot.work, Date.parse(snapshot.now));
  const statements = [
    rework.complete ? null : `The rework read reached its ${rework.pages}-page bound: rounds recorded before the last row read were not examined, so every rework figure below is a floor.`,
    waiting.incompleteReads.length ? `The per-item event reads for ${waiting.incompleteReads.length} item(s) (${waiting.incompleteReads.join(', ')}) hit their page bound: those items' waiting splits are floors.` : null,
    waiting.readFailed.length ? `The per-item event reads for ${waiting.readFailed.length} item(s) (${waiting.readFailed.join(', ')}) failed: those deliveries are named unmeasured, not counted as waiting.` : null,
  ].filter(Boolean);

  const report = {
    measuredAt: new Date(Date.parse(snapshot.now)).toISOString(),
    population: { items: options.items, delivered: entries.length, measured: entries.filter(entry => entry.measured).length, unmeasured: entries.filter(entry => !entry.measured).length },
    window: { since: population.since, until: snapshot.now },
    statement: statements.join(' ') || null,
    eventsComplete: rework.complete, pages: rework.pages,
    rework: {
      rounds: rounds.length, byCause, shares: Object.fromEntries(deliveryReworkCauses.map(cause => [cause, reworkShare(byCause[cause])])), largest,
      rawMedian: nearestRankPercentiles(rawCounts, 50).p50Ms, rawP90: nearestRankPercentiles(rawCounts, 90).p90Ms,
      ownChangeMedian: nearestRankPercentiles(ownCounts, 50).p50Ms, ownChangeP90: nearestRankPercentiles(ownCounts, 90).p90Ms,
    },
    waiting,
    preRelease: { totalMs: preReleaseTotalMs, measured: preReleaseMeasured.length, unmeasured: population.items.length - preReleaseMeasured.length },
    pipelineSpeed: { measured: speed.measured, unmeasured: speed.unmeasured, submitToMerge: speed.submitToMerge, execution: speed.execution, coverage: speed.coverage.statement },
  };
  return report;
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const options = parseArguments(argv);
  const base = env.GRAPHYARD_URL;
  if (!base) throw new Error('Set GRAPHYARD_URL to the control plane origin');
  const token = await readToken(env);
  const httpApi = async (path) => {
    const response = await fetch(new URL(`/api/${path}`, base), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status})`);
    return response.json();
  };
  const api = deps.api ?? httpApi;
  const report = await collect(api, options, await analytics());
  if (options.record) {
    await mkdir(options.record, { recursive: true });
    const file = join(options.record, `${report.measuredAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify(report, null, 2) + '\n');
    report.recorded = file;
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : render(report) + (report.recorded ? `\nRecorded ${report.recorded}` : ''));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
