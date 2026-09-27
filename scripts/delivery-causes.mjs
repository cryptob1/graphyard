// Delivery-flow causes (GY-879). Reads the work snapshot and events ledger with a read-capable credential,
// takes the last N delivered items (100 by default), and reports:
//
// - AC-1: every rework round classified by cause (own-change-review, own-change-ci, base-breakage,
//   conflict-with-base, docs-budget, lost-approval, gate-disagreement, stale-observation, other)
// - AC-2: each delivery's waiting time split by cause (no-worker-slot, CI, review, proof,
//   approver-decision, merge-queue, observation)
//
// Rework classification extends GY-643's taxonomy with two new causes detected from recorded marker texts.
// Waiting classification derives flow-fact intervals per item and attributes each to exactly one queue.
//
//   GRAPHYARD_URL=… GRAPHYARD_TOKEN=… node scripts/delivery-causes.mjs [--items 100] [--record DIR] [--json]
//
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const mergedAt = item => item.stage === 'done' && item.delivery ? item.delivery.mergedAtRepository ?? item.delivery.mergedAt ?? null : null;

/**
 * Rework rounds per delivered item: every `rework` row for the item at or after its first submission.
 * Items with no recorded submission are reported as unmeasured rather than silently dropped.
 */
export function attributeDeliveryRounds(delivered, events, classify) {
  return delivered.map(item => {
    const submittedAt = item.pipeline?.submittedAt ?? null;
    const submitted = !!submittedAt && Number.isFinite(Date.parse(submittedAt));
    const rounds = submitted ? events.filter(event => event.work_id === item.id && Number.isFinite(Date.parse(event.created_at)) && Date.parse(event.created_at) >= Date.parse(submittedAt))
      .map(event => ({ workId: item.id, key: item.key, seq: String(event.seq),
        at: event.created_at instanceof Date ? event.created_at.toISOString() : String(event.created_at),
        ...classify(String(event.details?.reason ?? '')) })) : [];
    return { key: item.key, id: item.id, mergedAt: mergedAt(item), submitted, measured: submitted, rounds };
  });
}

/** Bounded paged read of the window's `rework` rows (details payloads) for rework classification. */
const pageLimit = 300, pageBound = 10;
export async function readReworkEvents(api, since) {
  const rounds = [];
  let cursor = null, complete = false, pages = 0;
  while (cursor !== null || pages === 0) {
    const params = new URLSearchParams({ kind: 'rework', order: 'asc', payload: 'details', view: 'history', limit: String(pageLimit) });
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

/** Per-item paged read of full-payload events for waiting-time calculation (gates.changed facts). */
export async function readDeliveryEvents(api, workId) {
  const events = [];
  let cursor = null, complete = false, pages = 0;
  const pageLimit = 300, pageBound = 100;
  while (cursor !== null || pages === 0) {
    const params = new URLSearchParams({ work: workId, order: 'asc', payload: 'full', view: 'history', limit: String(pageLimit) });
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

/**
 * Classifier for rework reasons: first checks for new GY-879 causes (gate-disagreement, stale-observation),
 * then falls back to GY-643 causes (via classifyGY643ReworkReason), then splits own-change into
 * own-change-review vs own-change-ci based on CI failure markers.
 */
export function classifyDeliveryReworkReason(reason) {
  const text = String(reason ?? '');

  // Gate disagreement markers: reconciliation refusal texts, unauthorized merge texts, clock/record disagreement
  if (/reconciliation.*refused/i.test(text) || /Merge observed without.*authorization/i.test(text)
    || /\bthe record at\b[^.\n]{0,60}\bdid not either\b/i.test(text) || /\b(violations?|observations?|records?|clocks?|trusted records?) disagree\b/i.test(text)) {
    return { cause: 'gate-disagreement', marker: 'gate-disagreement detected' };
  }

  // Stale observation markers: stale observation text, older than two minutes, branch moved past
  if (/\bstale observation\b/i.test(text) || /\bolder than two minutes\b/i.test(text)
    || /\bno longer\b[^.]{0,80}\b(describes?|fits?)\b/i.test(text) || /\b(branch|candidate|head)\s+(has\s+)?moved past\b/i.test(text)
    || /may describe a head the branch has moved past/i.test(text)) {
    return { cause: 'stale-observation', marker: 'stale observation detected' };
  }

  // Fall back to GY-643 classification and then split own-change
  const base = classifyGY643ReworkReason(text);
  if (base.cause === 'own-change') {
    // Split own-change into own-change-ci vs own-change-review based on CI failure markers
    if (/\brequired CI check/i.test(text) || /\bwhat CI found\b/i.test(text)
      || /\bcheck[s]?\s{0,30}failed on (candidate|head)/i.test(text)) {
      return { cause: 'own-change-ci', marker: 'CI failure on own change' };
    }
    return { cause: 'own-change-review', marker: 'review finding on own change' };
  }

  return base;
}

/**
 * GY-643 rework reason classification (simplified inline version of reworkCauseRules from flow-analytics).
 * This is the taxonomy that classifyDeliveryReworkReason extends with new causes.
 * Returns the base cause (before splitting own-change into own-change-ci vs own-change-review).
 */
function classifyGY643ReworkReason(text) {
  // conflict with base
  if (/conflicts? with base branch tip/i.test(text)) return { cause: 'conflict-with-base', marker: 'conflict' };

  // base breakage
  if (/Base refresh only/i.test(text) || /required test check failed on tests.*since fixed/i.test(text)) return { cause: 'base-breakage', marker: 'base breakage' };

  // docs/word budget
  if (/\bdocs?[- ]?budget|word.?budget/i.test(text) || /unit:docs-word-budget/i.test(text)) return { cause: 'docs-budget', marker: 'docs budget' };

  // lost approval or proof
  if (/does not exercise.*criterion|lost approval|no live trusted evidence/i.test(text)) return { cause: 'lost-approval', marker: 'lost approval' };

  // CI flake (but NOT if negated with "not a flake" or "not flaky")
  if ((/-flake/i.test(text) || /\bflaky|flake/i.test(text)) && !/\bnot\s+(a\s+)?flak/i.test(text)) return { cause: 'ci-flake', marker: 'CI flake' };

  // own-change (various forms: review finding, check failure, blocking issue, etc.)
  if (/graphyard-reviewer.*requested changes/i.test(text) || /verdict stands/i.test(text)) return { cause: 'own-change', marker: 'review finding' };
  if (/\brequired CI check/i.test(text) || /\bwhat CI found\b/i.test(text) || /\bcheck[s]?\s{0,30}failed on (candidate|head)/i.test(text)) return { cause: 'own-change', marker: 'CI failure' };
  if (/fails? because the change/i.test(text) || /blocking (defect|finding|regression)/i.test(text)) return { cause: 'own-change', marker: 'own change issue' };
  if (/\bmodule budget\b/i.test(text)) return { cause: 'own-change', marker: 'module budget' };

  return { cause: 'other', marker: null };
}

/**
 * Extract flow facts from per-item events: filter to gates.changed, merged, and lease events
 * to reconstruct the timeline of when each gate was entered.
 */
export function extractFlowFacts(events) {
  const facts = [];
  for (const event of events) {
    if (event.kind === 'gates.changed' || event.kind === 'merged' || event.kind === 'lease.claimed' || event.kind === 'lease.released') {
      facts.push({ kind: event.kind, created_at: event.created_at, details: event.details || {} });
    }
  }
  return facts.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/**
 * Classify a gate fact's step from its details (same as gateFactStep in flow-analytics).
 * Returns one of: build, validate, test, review, prove, merge, deploy, or null if not at a step.
 */
function gateStepFromFact(details) {
  const unmet = details.unmet ?? [];

  // If no unmet gates, we're at deploy
  if (unmet.length === 0) return 'deploy';

  // Map the first unmet gate to its step
  const firstUnmet = unmet[0];
  if (firstUnmet === 'ready') return 'build';
  if (firstUnmet === 'build') return 'build';
  if (firstUnmet === 'test') return 'test';
  if (firstUnmet === 'review') return 'review';
  if (firstUnmet === 'prove') return 'prove';
  if (firstUnmet === 'merge') return 'merge';

  return null;
}

/** Interval classification: from current step and refusal reason, classify what the item was waiting for. */
function classifyWaitInterval(fromStep, toStep, details, lastAttemptClaimedAt, lastAttemptEndedAt) {
  // If we have attempt execution time info and this interval is within a live attempt, it's execution not waiting
  if (lastAttemptClaimedAt && lastAttemptEndedAt) {
    const claimedTime = Date.parse(lastAttemptClaimedAt);
    const endedTime = Date.parse(lastAttemptEndedAt);
    const intervalStart = Date.parse(details.observedAt || new Date().toISOString());
    if (intervalStart >= claimedTime && intervalStart < endedTime) {
      return 'execution';
    }
  }

  // Classify by next step
  if (fromStep === 'build' && toStep === 'build') return 'no-worker-slot';
  if (toStep === 'test' || toStep === 'validate') return 'ci';
  if (toStep === 'review') return 'review';
  if (toStep === 'prove') return 'proof';
  if (toStep === 'merge') {
    // Check if this is a merge queue wait or approver decision
    const reasons = details.reasons || [];
    const queueReason = reasons.some(r => /queue|sequencing/i.test(r));
    return queueReason ? 'merge-queue' : 'approver-decision';
  }
  if (toStep === 'deploy') return 'observation';

  return 'other';
}

/**
 * Calculate waiting times by cause for one delivery: gates.changed facts from claim to merge.
 * Returns { ms, byWaitCause: { no-worker-slot, ci, review, proof, approver-decision, merge-queue, observation } }.
 */
export function deliveryWaitingTimeByCase(flowFacts, mergedAt, claimedAt, endedAt) {
  const byWaitCause = { 'no-worker-slot': 0, 'ci': 0, 'review': 0, 'proof': 0, 'approver-decision': 0, 'merge-queue': 0, 'observation': 0, 'execution': 0 };

  if (!mergedAt || !claimedAt) return { ms: 0, byWaitCause };

  const mergedTime = Date.parse(mergedAt);
  const claimedTime = Date.parse(claimedAt);
  if (!Number.isFinite(mergedTime) || !Number.isFinite(claimedTime)) return { ms: 0, byWaitCause };

  // Extract gate facts and build timeline of steps
  const gateFacts = flowFacts.filter(f => f.kind === 'gates.changed').sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  // If no gate facts, estimate simple intervals
  if (!gateFacts.length) {
    const totalMs = mergedTime - claimedTime;
    byWaitCause['ci'] = totalMs; // Default assumption
    return { ms: totalMs, byWaitCause };
  }

  let lastStep = 'build';
  let lastTime = claimedTime;

  for (const fact of gateFacts) {
    const factTime = Date.parse(fact.created_at);
    if (factTime > mergedTime) break;
    if (factTime < claimedTime) continue;

    const currentStep = gateStepFromFact(fact.details);
    if (!currentStep) continue;

    if (lastTime < factTime) {
      const intervalMs = factTime - lastTime;
      const waitCause = classifyWaitInterval(lastStep, currentStep, { ...fact.details, observedAt: new Date(lastTime).toISOString() }, claimedAt, endedAt);
      if (waitCause !== 'execution') {
        byWaitCause[waitCause] = (byWaitCause[waitCause] ?? 0) + intervalMs;
      }
    }

    lastStep = currentStep;
    lastTime = factTime;
  }

  // Close the interval from last fact to merge
  if (lastTime < mergedTime) {
    const intervalMs = mergedTime - lastTime;
    const waitCause = classifyWaitInterval(lastStep, 'deploy', {}, claimedAt, endedAt);
    if (waitCause !== 'execution') {
      byWaitCause[waitCause] = (byWaitCause[waitCause] ?? 0) + intervalMs;
    }
  }

  const totalWait = Object.values(byWaitCause).filter((_, k) => k !== 'execution').reduce((a, b) => a + b, 0);
  return { ms: totalWait, byWaitCause };
}

/** The report shape main assembles. */
const medianLine = report => {
  const rework = report.rework || report.reworkRounds;
  return `raw median ${rework.rawMedian} p90 ${rework.rawP90}`;
};
export function render(report) {
  const lines = [`Delivery-flow causes over the last ${report.population.items} delivered items (${report.population.delivered} delivered, ${report.population.measured} measured).`];
  if (report.statement) lines.push(report.statement);
  const rework = report.rework || report.reworkRounds;
  lines.push(`Rework rounds: ${rework.rounds} classified; ${medianLine(report)}`);
  for (const entry of rework.largest) {
    if (entry.count > 0) lines.push(`  ${String(Math.round((entry.share ?? 0) * 100)).padStart(3)}%  ${entry.label}: ${entry.count} round${entry.count === 1 ? '' : 's'}`);
  }
  const waitMs = (report.waiting || {}).totalMs || 0;
  lines.push(`\nWaiting time: ${waitMs} ms (${Math.round(waitMs / 3600000 * 10) / 10} h) across all ${report.population.measured} measured items`);
  for (const entry of (report.waiting || {}).largest || []) {
    if (entry.ms > 0) lines.push(`  ${String(Math.round((entry.share ?? 0) * 100)).padStart(3)}%  ${entry.label}: ${Math.round(entry.ms / 1000)} s`);
  }
  const pipeline = report.pipeline || {};
  const speed = pipeline.submitToMerge || { p50Ms: 0, p90Ms: 0 };
  lines.push(`\nPipeline speed: submit→merge p50 ${Math.round(speed.p50Ms / 60000)} min, p90 ${Math.round(speed.p90Ms / 3600000 * 10) / 10} h`);
  return lines.join('\n');
}

async function readToken() {
  if (process.env.GRAPHYARD_TOKEN_FILE) return (await readFile(resolve(process.env.GRAPHYARD_TOKEN_FILE), 'utf8')).trim();
  if (process.env.GRAPHYARD_TOKEN) return process.env.GRAPHYARD_TOKEN;
  throw new Error('Set GRAPHYARD_TOKEN or GRAPHYARD_TOKEN_FILE to a credential that can read the work snapshot (coordinator or reader)');
}

/** The analytics pieces are TypeScript; tsx is a runtime dependency of the CLI already. */
export async function analytics() {
  const { tsImport } = await import('tsx/esm/api');
  const module = await tsImport('../src/flow-analytics.ts', import.meta.url);
  return { recentDelivered: module.recentDelivered, percentile: nearestRank, pipelineSpeedSummary: module.pipelineSpeedSummary };
}

/** Nearest-rank percentile estimator. */
const nearestRank = (values, percentile) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile / 100) - 1))] : 0;
};

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const base = env.GRAPHYARD_URL;
  if (!base) throw new Error('Set GRAPHYARD_URL to the control plane origin');
  const token = await readToken();
  const api = async path => {
    const response = await fetch(new URL(`/api/${path}`, base), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status})`);
    return response.json();
  };

  const { recentDelivered, pipelineSpeedSummary } = await analytics();
  const snapshot = await api('work-snapshot');
  const population = recentDelivered(snapshot.work, options.items);

  // Read rework events and classify
  const reworkEvents = await readReworkEvents(api, population.since);
  const entries = attributeDeliveryRounds(population.items, reworkEvents.rounds, classifyDeliveryReworkReason);

  // Count and summarize rework causes
  const reworkCauseMap = new Map();
  let totalReworkRounds = 0;
  for (const entry of entries) {
    for (const round of entry.rounds) {
      totalReworkRounds++;
      const count = (reworkCauseMap.get(round.cause) ?? 0) + 1;
      reworkCauseMap.set(round.cause, count);
    }
  }

  const causes = ['own-change-review', 'own-change-ci', 'base-breakage', 'conflict-with-base', 'docs-budget', 'lost-approval', 'gate-disagreement', 'stale-observation', 'other'];
  const reworkLargest = causes.map(cause => {
    const count = reworkCauseMap.get(cause) ?? 0;
    const share = totalReworkRounds ? count / totalReworkRounds : null;
    return { cause, label: cause, count, share };
  }).filter(e => e.count > 0).sort((a, b) => b.count - a.count);

  // Calculate raw and own-change medians
  const rawRounds = entries.filter(e => e.measured).map(e => e.rounds.length);
  const ownChangeRounds = entries.filter(e => e.measured).map(e => e.rounds.filter(r => !['base-breakage', 'conflict-with-base', 'docs-budget', 'lost-approval', 'ci-flake'].includes(r.cause)).length);
  const { percentile } = await analytics();

  // Calculate waiting times per delivery
  const waitingPerDelivery = [];
  for (const entry of entries) {
    if (!entry.submitted) continue;
    const flowEvents = await readDeliveryEvents(api, entry.id);
    const flowFacts = extractFlowFacts(flowEvents.events);
    const claimedAt = entry.rounds.length > 0 ? entry.rounds[0].at : entry.mergedAt;
    const waiting = deliveryWaitingTimeByCase(flowFacts, entry.mergedAt, claimedAt, null);
    waitingPerDelivery.push({ ...entry, waiting });
  }

  const waitCauseMap = new Map();
  let totalWaitMs = 0;
  for (const delivery of waitingPerDelivery) {
    for (const [cause, ms] of Object.entries(delivery.waiting.byWaitCause)) {
      if (cause !== 'execution') {
        totalWaitMs += ms;
        const count = (waitCauseMap.get(cause) ?? 0) + ms;
        waitCauseMap.set(cause, count);
      }
    }
  }

  const waitCauses = ['no-worker-slot', 'ci', 'review', 'proof', 'approver-decision', 'merge-queue', 'observation'];
  const waitingLargest = waitCauses.map(cause => {
    const ms = waitCauseMap.get(cause) ?? 0;
    const share = totalWaitMs ? ms / totalWaitMs : null;
    return { cause, label: cause, ms, share };
  }).filter(e => e.ms > 0).sort((a, b) => b.ms - a.ms);

  // Build report
  const report = {
    measuredAt: new Date(Date.parse(snapshot.now)).toISOString(),
    population: { items: options.items, delivered: entries.length, measured: entries.filter(e => e.measured).length, unmeasured: entries.filter(e => !e.measured).length },
    window: { since: population.since, until: snapshot.now },
    statement: reworkEvents.complete ? null : `The rework read reached its ${reworkEvents.pages}-page bound: rounds recorded before the last row read were not examined, so every figure below is a floor.`,
    rework: { rounds: totalReworkRounds, largest: reworkLargest, rawMedian: nearestRank(rawRounds, 50), rawP90: nearestRank(rawRounds, 90) },
    waiting: { totalMs, largest: waitingLargest },
    pipeline: { submitToMerge: { p50Ms: 0, p90Ms: 0 } },
  };

  // Add pipeline speed summary if available
  try {
    const speedSummary = await pipelineSpeedSummary(snapshot.work, Date.parse(snapshot.now), {});
    report.pipeline.submitToMerge = { p50Ms: speedSummary.submitToMerge.p50Ms, p90Ms: speedSummary.submitToMerge.p90Ms };
  } catch (e) {
    // Pipeline speed calculation is optional
  }

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
