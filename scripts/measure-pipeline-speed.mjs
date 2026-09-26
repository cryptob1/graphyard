// The periodic pipeline-speed measurement (GY-54). Reads the work snapshot with a read-capable
// credential, summarizes submit→merge p50/p90, rework rounds, hand-offs and execution versus wait
// over every delivery whose timeline recorded a submission, judges the target, and — with
// `--split` — reports the same figures for the deliveries merged before and after each named item
// landed, so the effect of a change is measured rather than asserted. `--record DIR` appends the
// report as one timestamped JSON file per run; the master's 3-hourly measurement points it at
// `.graphyard/measurements/pipeline-speed`.
//
//   GRAPHYARD_URL=… GRAPHYARD_TOKEN=… node scripts/measure-pipeline-speed.mjs [--since ISO] [--until ISO]
//     [--split GY-55,GY-64] [--claim GY-115] [--baseline-median N] [--record DIR] [--json]
//
// With `--claim` (default GY-115) the run also verifies another item's post-merge claim (GY-136):
// whether the median rework rounds over the deliveries merged after the claim's merge commit is
// lower than the recorded pre-merge median of 2, and which causes the ledger attributes the
// window's rework rounds to — mechanically checkable findings (proofs, required CI) versus review
// findings — so a reduction that came from somewhere else is not credited to the change. It
// relaxes nothing: a miss is printed as a finding with the measured values and a named follow-up,
// the window is never narrowed, no delivery is dropped, and the exit status of a missed claim is
// 2. A claim run records to `.graphyard/measurements/rework-claim`, beside — never inside — the
// routine speed reports, and its recorded JSON names the merge commit it measured after, the
// window basis, the exact command line and the ledger provenance of every counted figure.
//
// The arithmetic is the same module master status uses (src/pipeline-speed.ts), loaded through
// tsx so the two can never disagree.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** GY-136's subject: the claim of GY-115, in its own numbers. Nothing here may loosen one. */
export const reworkClaim = {
  item: 'GY-115',
  statement: 'Running a candidate\'s mechanically checkable proofs before review removes rework rounds: over at least ten items delivered after GY-115\'s merge commit, the median rework rounds reported by master status under speed.reworkRounds is lower than the pre-merge median of 2.',
  baselineMedian: 2,
  minimumItems: 10,
};
const claimStatement = key => key === reworkClaim.item ? reworkClaim.statement
  : `Over at least ${reworkClaim.minimumItems} items delivered after ${key}'s merge commit, the median rework rounds reported by master status under speed.reworkRounds is lower than the baseline median (GY-136's own subject is ${reworkClaim.item}).`;

export function parseArguments(argv) {
  const options = { since: null, until: null, split: [], claim: reworkClaim.item, baselineMedian: reworkClaim.baselineMedian, record: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--since') options.since = value();
    else if (argument === '--until') options.until = value();
    else if (argument === '--split') options.split.push(...value().split(',').map(key => key.trim()).filter(Boolean));
    else if (argument === '--claim') options.claim = value();
    else if (argument === '--baseline-median') options.baselineMedian = Number(value());
    else if (argument === '--record') options.record = value();
    else if (argument === '--json') options.json = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  for (const stamp of [options.since, options.until]) if (stamp !== null && !Number.isFinite(Date.parse(stamp))) throw new Error(`Not an ISO 8601 timestamp: ${stamp}`);
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(options.claim)) throw new Error(`--claim takes a work-item key such as ${reworkClaim.item}, not ${options.claim}`);
  if (!Number.isInteger(options.baselineMedian) || options.baselineMedian < 0) throw new Error(`--baseline-median takes a non-negative integer of rework rounds, not ${options.baselineMedian}`);
  return options;
}

/** The accepted merge instant of a delivered item, on the repository clock when the delivery carried it there. */
const mergedAt = item => item.stage === 'done' && item.delivery ? item.delivery.mergedAtRepository ?? item.delivery.mergedAt : null;

/**
 * Where the post-change window starts, with the basis named — the same hierarchy as
 * `claimWindow` in src/throughput.ts, applied to this claim (mirrored here so `measure` stays a
 * synchronous fold over the snapshot, as its callers and tests use it). A deployment observation
 * that a release carrying the change was serving is the strong basis; without one the claim's
 * accepted merge instant is used and named as the weaker basis it is, because a merge is not a
 * deployment. Neither is ever moved later to improve a figure.
 */
export function claimWindow(claim) {
  const deployment = claim && claim.stage === 'done' ? claim.delivery?.deployment : null;
  if (deployment?.observedAt) return { since: deployment.observedAt, basis: 'deployment-observation', reason: `${claim.key} was observed serving from ${String(deployment.sha ?? '').slice(0, 12)} at ${deployment.observedAt}; every delivery counted was merged after the release carrying the change was serving` };
  const merged = claim ? mergedAt(claim) : null;
  if (merged) return { since: merged, basis: 'merge-instant', reason: `${claim.key} carries no deployment observation, so the window starts at its merge (${merged}); a merge is not a deployment, so a delivery merged shortly after it may predate the change serving` };
  return { since: null, basis: 'unknown', reason: claim ? `${claim.key} is not delivered, so no window of deliveries after it can be bounded` : `${reworkClaim.item} is not a work item in this snapshot, so no window of deliveries after it can be bounded` };
}

/**
 * The commit the deployed control plane runs, from its own status document — the same reading as
 * src/throughput.ts `deployedRevision`: the release stamp first, then the platform-injected
 * build identity. What is serving is the thing the containment check names, never the checkout
 * the measurement runs in.
 */
export function deployedRevision(status) {
  const stamped = status?.release?.revision;
  if (stamped && stamped !== 'unknown') return { revision: stamped, source: 'release.revision' };
  const commit = status?.build?.commit;
  if (commit && commit !== 'unknown') return { revision: commit, source: 'build.commit' };
  return { revision: stamped ?? null, source: null };
}

const defaultRun = (command, args) => spawnSync(command, args, { encoding: 'utf8' });

/**
 * Whether the release now serving contains the claim's own merge commit — informational here,
 * and never population-changing: the window is bounded by the deployment observation or the
 * merge instant, whatever the ancestry says. An answer the repository the measurement runs in
 * cannot give is `null` with the reason, never an assumption either way.
 */
export function claimContainment({ revision, mergeSha, claim, repository }, run = defaultRun) {
  if (!revision || revision === 'unknown') return { contains: null, reason: 'the deployed release reports no build revision' };
  if (!mergeSha) return { contains: null, reason: `${claim} records no merge commit to compare the deployed revision against` };
  if (mergeSha.toLowerCase() === revision.toLowerCase()) return { contains: true, reason: null };
  const result = run('git', ['-C', repository, 'merge-base', '--is-ancestor', mergeSha, revision]);
  if (result.status === 0) return { contains: true, reason: null };
  if (result.status === 1) return { contains: false, reason: `${mergeSha.slice(0, 12)} is not an ancestor of the deployed ${revision.slice(0, 12)}` };
  return { contains: null, reason: `git could not compare ${mergeSha.slice(0, 12)} with the deployed ${revision.slice(0, 12)} from ${repository}: ${(result.stderr || result.error?.message || `exit ${result.status}`).toString().trim().slice(0, 200)}` };
}

// ---- AC-2: what the ledger attributes the window's rework rounds to -------------------------

/** The causes a rework round can have, with the mechanical/review split GY-136's share is over. */
export const reworkCauses = ['mechanical-proof', 'mechanical-ci', 'review-threads', 'review-verdict', 'integration', 'research', 'unclassified'];
const mechanicalCauses = ['mechanical-proof', 'mechanical-ci'], reviewCauses = ['review-threads', 'review-verdict'];
const isCause = (cause, group) => group.includes(cause);

/**
 * The cause taxonomy of src/daemon/decisions.ts, keyed by the binding prefix the loop writes
 * (`<sha>:proof:…` and so on). `mechanical` is exactly GY-115's own notion (src/model/mechanical-
 * proofs.ts): failed unit/integration proofs and failed required CI checks — no new category.
 */
export function causeOfBinding(binding) {
  if (!binding) return null;
  if (/^[0-9a-f]{7,40}:proof:/i.test(binding)) return 'mechanical-proof';
  if (/^[0-9a-f]{7,40}:ci:/i.test(binding)) return 'mechanical-ci';
  if (/^[0-9a-f]{7,40}:threads:/i.test(binding)) return 'review-threads';
  if (/^[0-9a-f]{7,40}:verdict:/i.test(binding)) return 'review-verdict';
  if (/^[0-9a-f]{7,40}:(conflict|sync|queue-conflict)/i.test(binding)) return 'integration';
  if (/^[0-9a-f]{7,40}:research:/i.test(binding)) return 'research';
  return null;
}

/**
 * The loop's verbatim reason templates, in `neededDecision`'s own precedence (src/daemon/
 * decisions.ts), for the reworks that carry no decision binding — direct master reworks. A proof
 * rework's reason also names threads (`address them in the same round`), so the order decides,
 * exactly as the loop's own if-chain does.
 */
const causeTemplates = [
  ['integration', /Only a fresh attempt can resolve it|Only a sync can resolve it|merge queue ejected candidate|conflicts with base branch tip|Speculative merge of [0-9a-f]+ into .+ conflicts/],
  ['review-verdict', /requested changes on/],
  ['mechanical-proof', /a trusted proof failed|does not exercise its criterion/],
  ['mechanical-ci', /required CI check/],
  ['research', /answered product questions after the head was built/],
  ['review-threads', /review threads? (?:is|are) (?:still )?open|are still open on/],
];
const causeOfReason = reason => { for (const [cause, pattern] of causeTemplates) if (pattern.test(reason)) return cause; return null; };

const stripObservationPrefix = text => text.replace(/^\[Decided from [^\]]*\]\s*/, '');
/** The candidate a round names: the binding's head first, else the head or PR the reason names. */
const namedCandidate = (binding, reason) => {
  const sha = (/^([0-9a-f]{7,40}):/i.exec(binding ?? '')?.[1]
    ?? /\bcandidate ([0-9a-f]{7,40})\b/i.exec(reason ?? '')?.[1]
    ?? /\b(?:on|of) ([0-9a-f]{12,40})\b/i.exec(reason ?? '')?.[1]
    ?? /[0-9a-f]{40}/i.exec(reason ?? '')?.[0]
    ?? null);
  if (sha) return sha.toLowerCase();
  const pr = /#(\d+)/.exec(reason ?? '')?.[1];
  return pr ? `pr-${pr}` : null;
};
const snippet = (text, limit = 200) => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/**
 * One window of the events ledger, classified: every `rework` row, joined to the `decision.
 * requested` row that caused it — by the `[decision <uuid>` marker the applied reason quotes,
 * else the nearest preceding rework request for the same work item, accepted only when the
 * rework's reason really quotes that request's grounds — and classified by the binding's cause
 * prefix, falling back to the loop's reason templates. Rounds whose record names no candidate or
 * pull request are reworks of unsubmitted items: not rounds, and counted as skipped instead, or
 * the shares would disagree with `speed.reworkRounds`. Rounds deduplicate by work item, candidate
 * and cause, because several ledger rows can record one round of one head family.
 */
export function classifyRounds(work, ledger, { since = null, until = null } = {}) {
  const keyOf = new Map(work.map(item => [item.id, item.key]));
  const decisions = new Map(), priorByWork = new Map();
  let decisionRows = 0;
  for (const event of ledger.decisions ?? []) {
    if (event.kind !== 'decision.requested') continue;
    decisionRows++;
    const payload = event.payload ?? {};
    if (payload.action !== 'rework') continue;
    const record = { id: payload.id ?? null, binding: payload.input?.binding ?? null, reason: String(payload.reason ?? ''), at: event.created_at, grounds: snippet(stripObservationPrefix(String(payload.reason ?? '')), 80) };
    if (payload.id) decisions.set(payload.id, record);
    const prior = priorByWork.get(event.work_id);
    if (!prior || Date.parse(record.at) > Date.parse(prior.at)) priorByWork.set(event.work_id, record);
  }
  const rounds = new Map(), unclassified = [];
  let rows = 0, duplicates = 0, skippedNoCandidate = 0;
  for (const event of ledger.rework ?? []) {
    if (event.kind !== 'rework') continue;
    const atMs = Date.parse(event.created_at);
    if (Number.isFinite(atMs) && since !== null && atMs < since) continue;
    if (Number.isFinite(atMs) && until !== null && atMs >= until) continue;
    rows++;
    const reason = String(event.details?.reason ?? event.payload?.details?.reason ?? event.payload?.reason ?? '');
    const marker = /\[decision ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(reason)?.[1] ?? null;
    let decision = marker ? decisions.get(marker) ?? null : null;
    if (!decision && !marker) {
      const prior = priorByWork.get(event.work_id) ?? null;
      if (prior && stripObservationPrefix(reason).startsWith(prior.grounds.slice(0, 40))) decision = prior;
    }
    const binding = decision?.binding ?? null;
    const candidate = namedCandidate(binding, reason);
    if (!candidate) { skippedNoCandidate++; continue; }
    const cause = causeOfBinding(binding) ?? causeOfReason(reason);
    const dedupeKey = `${event.work_id}|${candidate}|${binding ?? cause ?? 'unclassified'}`;
    const round = { key: keyOf.get(event.work_id) ?? `work ${String(event.work_id ?? '').slice(0, 8)}`, at: event.created_at, candidate, cause: cause ?? 'unclassified',
      grounds: binding ? 'decision binding' : cause ? 'reason template' : 'none', reason: snippet(reason) };
    if (round.cause === 'unclassified') unclassified.push(round);
    if (rounds.has(dedupeKey)) { duplicates++; continue; }
    rounds.set(dedupeKey, round);
  }
  const counted = [...rounds.values()];
  const causes = Object.fromEntries(reworkCauses.map(cause => [cause, counted.filter(round => round.cause === cause).length]));
  const mechanicalRounds = mechanicalCauses.reduce((total, cause) => total + causes[cause], 0);
  const findingRounds = mechanicalRounds + reviewCauses.reduce((total, cause) => total + causes[cause], 0);
  return {
    events: { reworkRows: rows, decisionRows },
    rounds: { total: counted.length, causes, mechanicalRounds, findingRounds,
      mechanicalShare: findingRounds ? Number((mechanicalRounds / findingRounds).toFixed(4)) : null },
    skipped: { noCandidate: skippedNoCandidate, duplicates },
    counted: counted.slice(0, 1000), truncatedRounds: Math.max(0, counted.length - 1000),
    unclassified: unclassified.slice(0, 10), unclassifiedTotal: unclassified.length,
  };
}

/**
 * One report: the overall summary for the window, for each split item the summaries before and
 * after it landed, and — the GY-136 claim measurement — the before/after summaries at the
 * claim's merge instant with the verdict, the ledger's cause classification of both sides, and
 * the provenance that makes every figure checkable. An item that is not delivered cannot split
 * anything or bound a window, and says so.
 */
export function measure(work, now, options, summarize, context = {}) {
  const overall = summarize(work, now, { since: options.since, until: options.until });
  const splits = options.split.map(key => {
    const item = work.find(entry => entry.key === key);
    const at = item ? mergedAt(item) : null;
    if (!at) return { key, mergedAt: null, reason: item ? `${key} is not delivered yet` : `${key} is not a work item`, before: null, after: null };
    return { key, mergedAt: at, reason: null,
      before: summarize(work, now, { since: options.since, until: at }),
      after: summarize(work, now, { since: at, until: options.until }) };
  });
  const claim = claimMeasurement(work, now, options, summarize, context);
  const sinceMs = claim.window.since ? Date.parse(claim.window.since) : null;
  const ledger = context.ledger ?? null;
  const untilMs = options.until ? Date.parse(options.until) : null;
  // Without ledger rows in hand there is nothing to classify: the claim's window and verdict are
  // still reported, and the classification is absent rather than empty.
  // The before side covers exactly the ledger range read for it (`ledger.readSince`), named, so
  // an unread stretch is never reported as a stretch without rework.
  const beforeSince = ledger?.readSince ?? options.since ?? null;
  const rounds = ledger && { ...ledger, rework: (ledger.rework ?? []).filter(event => event.work_id !== claim.itemId) };
  const findings = sinceMs === null || !ledger ? null : {
    basis: claim.window.basis, since: claim.window.since, until: options.until ?? null, beforeSince,
    before: classifyRounds(withoutClaim(work, claim.item), rounds, { since: beforeSince ? Date.parse(beforeSince) : null, until: sinceMs }),
    after: classifyRounds(withoutClaim(work, claim.item), rounds, { since: sinceMs, until: untilMs }),
    reconciliation: null,
  };
  if (findings) findings.reconciliation = reconcile(claim.after, findings.after);
  return { measuredAt: new Date(now).toISOString(), window: { since: options.since, until: options.until }, overall, splits, claim, findings,
    provenance: {
      origin: context.origin ?? null, argv: context.argv ?? null, ledger: context.eventsRead ?? null,
      statement: 'Every figure is measured from the events ledger — item timelines are replays of it (backfill source ledger), the classification reads its rework and decision rows — through the same arithmetic as master status (src/pipeline-speed.ts, loaded through tsx); nothing here is asserted by the change it measures.',
    } };
}

/** The classified rounds against what the speed summary counted, with any residual named, never dropped. */
function reconcile(summary, classification) {
  const summaryRounds = summary.items.reduce((total, item) => total + item.reworkRounds, 0);
  const ledgerRounds = classification.rounds.total;
  const residual = ledgerRounds - summaryRounds;
  const statement = residual === 0
    ? `The summary counts ${summaryRounds} rework rounds over ${summary.measured} measured deliveries and the ledger classification counts ${ledgerRounds}: the two agree.`
    : residual > 0
      ? `The ledger classification counts ${ledgerRounds} rounds where the summary counts ${summaryRounds} over its ${summary.measured} measured deliveries: ${residual} round(s) belong to items still in flight${summary.coverage.complete ? '' : ` or not measured (${summary.coverage.statement})`} — counted here, absent there, and named rather than dropped.`
      : `The summary counts ${summaryRounds} rework rounds over its ${summary.measured} measured deliveries where the ledger classification counts ${ledgerRounds}: ${-residual} round(s) the ledger no longer reaches (events pruned, or a round whose record names no candidate: ${classification.skipped.noCandidate} skipped).`;
  return { summaryRounds, ledgerRounds, residual, statement };
}

/**
 * The claim item itself is the change, not a delivery after it: its own merge instant bounds the
 * window, so it is left out of both sides and named as excluded, whatever it would do to a figure.
 */
const withoutClaim = (work, key) => work.filter(item => item.key !== key);

/** The claim measurement: window, before/after summaries, verdict, and the follow-up a miss names. */
export function claimMeasurement(work, now, options, summarize, context = {}) {
  const claim = work.find(item => item.key === options.claim) ?? null;
  const population = withoutClaim(work, options.claim);
  const window = claimWindow(claim);
  const baseline = { median: options.baselineMedian, source: options.baselineMedian === reworkClaim.baselineMedian
    ? `the pre-merge median of ${reworkClaim.baselineMedian} recorded in GY-136's description; fixed, never re-measured to pass`
    : `overridden on the command line (the claim's own recorded baseline is ${reworkClaim.baselineMedian}); named here rather than moved silently` };
  const minimumItems = reworkClaim.minimumItems;
  if (!window.since) return { item: options.claim, statement: claimStatement(options.claim), baseline, minimumItems, delivered: false,
    mergeSha: null, window, containment: null, deployed: null, before: null, after: null, judged: false, verdict: 'not judged', reason: window.reason, followUp: null };
  const before = summarize(population, now, { since: options.since, until: window.since });
  const after = summarize(population, now, { since: window.since, until: options.until });
  const judged = after.measured >= minimumItems;
  const met = judged && after.reworkRounds.median < baseline.median;
  const verdict = met ? 'verified' : judged ? 'unverified' : 'not judged';
  const measured = `median rework rounds ${after.reworkRounds.median} (p90 ${after.reworkRounds.p90}) over ${after.measured} measured deliveries merged since ${window.since}, against the recorded baseline of ${baseline.median} (nearest-rank median of integer rounds: below ${baseline.median} means at most ${baseline.median - 1}); the measured before-median over ${before.measured} deliveries is ${before.reworkRounds.median}`;
  const reason = met ? `GY-136's claim holds on this window: ${measured}.`
    : !judged ? `${after.measured} deliveries are measured in the window; the claim is judged over at least ${minimumItems}, so it is not judged yet. ${measured}.`
    : `${measured}. The claim is not verified: this is the finding, with the window, population and baseline unchanged.`;
  const followUp = met ? null : {
    title: `${options.claim}'s prereview-rework claim is ${met ? 'verified' : 'unverified'} over the deliveries since its merge`,
    description: [`Measured at ${new Date(now).toISOString()} over the window ${window.since} → ${options.until ?? new Date(now).toISOString()} (${window.basis}: ${window.reason}).`, measured,
      context.containment ? `Containment of merge ${String(context.containment.mergeSha ?? '').slice(0, 12)} in the deployed revision: ${context.containment.contains === null ? `unknown (${context.containment.reason})` : context.containment.contains} (informational).` : '',
      `Re-run: node scripts/measure-pipeline-speed.mjs --claim ${options.claim} --record .graphyard/measurements/rework-claim`].filter(Boolean).join('\n'),
  };
  return { item: options.claim, itemId: claim.id ?? null, statement: claimStatement(options.claim), baseline, minimumItems, delivered: true,
    excluded: [{ key: options.claim, reason: `${options.claim} is the change measured: its merge bounds the window, so it is not a delivery after its own merge` }],
    mergeSha: claim.delivery?.mergeSha ?? null, window, containment: context.containment ?? null, deployed: context.deployed ?? null,
    before, after, judged, verdict, reason, followUp };
}

const minutes = ms => `${Math.round(ms / 6000) / 10} min`;
const line = (label, summary) => `${label}: ${summary.measured} measured (${summary.routine.count} routine, ${summary.unmeasured} unmeasured); submit→merge p50 ${minutes(summary.submitToMerge.p50Ms)} p90 ${minutes(summary.submitToMerge.p90Ms)}; routine p50 ${minutes(summary.routine.submitToMerge.p50Ms)} p90 ${minutes(summary.routine.submitToMerge.p90Ms)}; rework median ${summary.reworkRounds.median} p90 ${summary.reworkRounds.p90}; hand-offs on ${summary.interventions.items} item(s); execution share ${summary.execution.share === null ? 'n/a' : `${Math.round(summary.execution.share * 100)}%`}; target ${summary.met === null ? `not judged (${summary.reason})` : summary.met ? 'met' : `missed (${summary.reason})`}`;
export function render(report) {
  const lines = [line('Overall', report.overall)];
  for (const split of report.splits) {
    if (!split.mergedAt) { lines.push(`${split.key}: ${split.reason}`); continue; }
    lines.push(`${split.key} landed ${split.mergedAt}`, `  ${line('before', split.before)}`, `  ${line('after', split.after)}`);
  }
  const claim = report.claim;
  if (claim) {
    lines.push(`${claim.item} claim, deliveries merged after ${claim.mergeSha ? claim.mergeSha.slice(0, 12) : 'its merge'}: ${claim.verdict.toUpperCase()}`);
    lines.push(`  Window ${claim.window.since ?? 'unknown'} → ${report.window.until ?? report.measuredAt} (${claim.window.basis}) — ${claim.window.reason}`);
    if (claim.delivered) {
      lines.push(`  Verdict: ${claim.reason}`);
      for (const excluded of claim.excluded ?? []) lines.push(`  Excluded: ${excluded.key} — ${excluded.reason}`);
      lines.push(`  Coverage: ${claim.after.coverage.statement}`);
      if (claim.deployed) lines.push(`  Deployed revision ${claim.deployed.revision ?? 'unknown'}${claim.deployed.revisionSource ? ` (from ${claim.deployed.revisionSource})` : ''}; contains ${claim.item}'s merge: ${claim.containment?.contains === null || claim.containment?.contains === undefined ? `unknown (${claim.containment?.reason ?? 'not checked'})` : claim.containment.contains} (informational)`);
      const findings = report.findings;
      if (findings) {
        for (const side of ['before', 'after']) {
          const rounds = findings[side].rounds;
          const named = reworkCauses.filter(cause => rounds.causes[cause]).map(cause => `${cause} ${rounds.causes[cause]}`).join(', ') || 'none';
          const range = side === 'before' ? `${findings.beforeSince ?? 'the ledger start'} → ${findings.since}` : `${findings.since} → ${findings.until ?? report.measuredAt}`;
          lines.push(`  Rework rounds ${side} the merge (${range}): ${rounds.total} counted (${named}); mechanical share ${rounds.mechanicalShare === null ? 'n/a (no classified finding rounds)' : `${Math.round(rounds.mechanicalShare * 100)}% of ${rounds.findingRounds} finding round(s)`}; ${findings[side].skipped.noCandidate} rework(s) of items with no candidate named are not rounds`);
        }
        if (findings.after.unclassifiedTotal) lines.push(`  Unclassified rounds since the merge: ${findings.after.unclassifiedTotal}, quoted in the recorded JSON for audit`);
        lines.push(`  Reconciliation: ${findings.reconciliation.statement}`);
      }
    }
  }
  return lines.join('\n');
}

async function readToken(env) {
  if (env.GRAPHYARD_TOKEN_FILE) return (await readFile(resolve(env.GRAPHYARD_TOKEN_FILE), 'utf8')).trim();
  if (env.GRAPHYARD_TOKEN) return env.GRAPHYARD_TOKEN;
  throw new Error('Set GRAPHYARD_TOKEN or GRAPHYARD_TOKEN_FILE to a credential that can read the work snapshot (coordinator, reader or operator)');
}

/** The ledger rows one claim window needs, cursor-walked in ledger order, bounded and never silent about a truncation. */
export async function readReworkLedger(read, since, until, pageLimit = 1000, pageBound = 200) {
  const walk = async (kinds, payload) => {
    const rows = []; let cursor = null, pages = 0;
    do {
      const params = new URLSearchParams({ kind: kinds.join(','), payload, order: 'asc', limit: String(pageLimit), view: 'page' });
      if (since) params.set('since', since);
      if (until) params.set('until', until);
      if (cursor) params.set('cursor', cursor);
      const page = await read(`/api/events?${params}`, 'events ledger');
      rows.push(...(page.events ?? []));
      cursor = page.page?.hasMore ? page.page.nextCursor : null;
    } while (cursor && ++pages < pageBound);
    return { rows, pages, truncated: !!cursor };
  };
  const rework = await walk(['rework'], 'details');
  const decisions = await walk(['decision.requested'], 'full');
  // Decision rows are read with `full` payloads, because `input.binding` sits at payload top
  // level; rework rows only need their details.
  return { rework: rework.rows, decisions: decisions.rows, eventsRead: { rework: { rows: rework.rows.length, pages: rework.pages, truncated: rework.truncated },
    decisionRequested: { rows: decisions.rows.length, pages: decisions.pages, truncated: decisions.truncated } } };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const options = parseArguments(argv);
  const base = env.GRAPHYARD_URL;
  if (!base) throw new Error('Set GRAPHYARD_URL to the control plane origin');
  const fetcher = deps.fetcher ?? fetch;
  const headers = { Authorization: `Bearer ${await readToken(env)}` };
  const read = async (path, what) => {
    const response = await fetcher(new URL(path, base), { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Graphyard refused the ${what} (${response.status})`);
    return response.json();
  };
  const snapshot = await read('/api/work-snapshot', 'work snapshot');
  const now = Date.parse(snapshot.now ?? new Date().toISOString());
  const claim = snapshot.work.find(item => item.key === options.claim) ?? null;
  const window = claimWindow(claim);
  const context = { origin: new URL(base).origin, argv: ['node', 'scripts/measure-pipeline-speed.mjs', ...argv] };
  if (window.since) {
    // The release identity and the ancestry check are informational: they name what is serving,
    // they never move the window or its population.
    const status = await read('/api/status', 'control-plane status');
    const { revision, source } = deployedRevision(status);
    const containment = claimContainment({ revision, mergeSha: claim?.delivery?.mergeSha ?? null, claim: options.claim, repository: deps.repository ?? process.cwd() }, deps.run);
    context.deployed = { revision, revisionSource: source, version: status.release?.version ?? null };
    context.containment = { ...containment, mergeSha: claim?.delivery?.mergeSha ?? null, revision };
    // The before side is read over a window of the same length as the after side (or from --since),
    // so the mechanical share on each side of the merge is measured, not left empty.
    const afterEnd = options.until ? Date.parse(options.until) : now;
    const readSince = options.since ?? new Date(Math.max(0, Date.parse(window.since) - Math.max(0, afterEnd - Date.parse(window.since)))).toISOString();
    context.ledger = deps.ledger ?? { ...(await readReworkLedger(read, readSince, options.until ?? null)), readSince };
    context.eventsRead = context.ledger.eventsRead;
  }
  const report = measure(snapshot.work, now, options, deps.summarize ?? await summarizer(), context);
  if (options.record) {
    await mkdir(options.record, { recursive: true });
    const file = join(options.record, `${report.measuredAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify(report, null, 2) + '\n');
    report.recorded = file;
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : render(report) + (report.recorded ? `\nRecorded ${report.recorded}` : ''));
  return report;
}

/** The summary module is TypeScript; tsx is a runtime dependency of the CLI already. */
export async function summarizer() {
  const { tsImport } = await import('tsx/esm/api');
  const module = await tsImport('../src/pipeline-speed.ts', import.meta.url);
  return module.pipelineSpeedSummary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(report => {
    // An unverified claim is not an error — it is the measurement's finding — but the exit status
    // says so, so a scheduled run cannot report a miss as a quiet success.
    if (report.claim && report.claim.verdict !== 'verified') process.exitCode = 2;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
