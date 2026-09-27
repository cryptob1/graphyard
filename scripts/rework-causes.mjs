// Rework-round causes (GY-643). Reads the work snapshot with a read-capable credential, takes the
// last N delivered items (100 by default), reads every `rework` ledger row their submissions can
// hold, classifies each round from the recorded reason alone (src/flow-analytics.ts, loaded
// through tsx so the script and `master status` can never disagree), and reports the share of
// each cause. The three largest causes are each linked to an open fix item — one is filed through
// POST /api/work when none exists and the credential may create work; a refusal is reported with
// the exact payload instead of swallowed.
//
//   GRAPHYARD_URL=… GRAPHYARD_TOKEN=… node scripts/rework-causes.mjs [--items 100] [--record DIR] [--json] [--no-file]
//
// `master status` reports the same classification under `speed.reworkRounds.ownChange`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Open-item title keywords each cause's fix item is found by (case-insensitive `includes`). */
export const fixItemKeywords = {
  'own-change': ['review finding'],
  'base-breakage': ['base breakage'],
  'conflict': ['conflict'],
  'docs-budget': ['docs budget'],
  'lost-approval-or-proof': ['lost approval', 'proof'],
  'ci-flake': ['flake'],
  'other': [],
};

export function parseArguments(argv) {
  const options = { items: 100, record: null, json: false, file: true };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--items') { options.items = Number(value()); if (!Number.isInteger(options.items) || options.items < 1) throw new Error('--items needs a positive integer'); }
    else if (argument === '--record') options.record = value();
    else if (argument === '--json') options.json = true;
    else if (argument === '--no-file') options.file = false;
    else throw new Error(`Unknown argument ${argument}`);
  }
  return options;
}

/** The accepted merge instant of a delivered item, on the repository clock when the delivery carried it there. */
const mergedAt = item => item.stage === 'done' && item.delivery ? item.delivery.mergedAtRepository ?? item.delivery.mergedAt ?? null : null;

/**
 * Rounds per delivered item: every `rework` row for the item at or after its first submission —
 * the same rule the pipeline timeline counts by (`recordRework`). Items with no recorded
 * submission are reported as unmeasured rather than silently dropped.
 */
export function attributeRounds(delivered, events, classify) {
  return delivered.map(item => {
    const submittedAt = item.pipeline?.submittedAt ?? null;
    const submitted = !!submittedAt && Number.isFinite(Date.parse(submittedAt));
    const rounds = submitted ? events.filter(event => event.work_id === item.id && Number.isFinite(Date.parse(event.created_at)) && Date.parse(event.created_at) >= Date.parse(submittedAt))
      .map(event => ({ workId: item.id, key: item.key, seq: String(event.seq),
        at: event.created_at instanceof Date ? event.created_at.toISOString() : String(event.created_at),
        ...classify(String(event.details?.reason ?? '')) })) : [];
    return { key: item.key, mergedAt: mergedAt(item), measured: submitted, rounds };
  });
}

/** The open fix item a cause links to: the oldest open item whose title names the cause. */
export function findFixItem(openItems, cause) {
  const keywords = fixItemKeywords[cause] ?? [];
  const matches = openItems.filter(item => keywords.some(keyword => item.title.toLowerCase().includes(keyword)))
    .sort((a, b) => String(a.key).localeCompare(String(b.key), 'en', { numeric: true }));
  return matches[0] ? { key: matches[0].key, title: matches[0].title } : null;
}

/** The work item the script files for a top cause with no open fix item. */
export function filingPayload(cause, label, count, share) {
  return {
    title: `Fix the ${label.toLowerCase()} rework rounds (${count} round${count === 1 ? '' : 's'}, ${share === null ? 'share n/a' : `${Math.round(share * 100)}% of rounds`})`,
    description: `Filed by scripts/rework-causes.mjs (GY-643): ${label.toLowerCase()} is one of the largest causes of rework rounds over the last 100 delivered items, and no open item already names it. Reduce the rounds this cause produces without weakening any requirement.`,
    type: 'bug', priority: 1, plannedFiles: [],
    criteria: [{ id: 'AC-1', text: `Rework rounds classified as ${cause} over the last 100 delivered items fall below the share this item was filed for, measured by scripts/rework-causes.mjs`, proofs: ['manual:rework-cause-fix'] }],
  };
}

/**
 * The report shape `main` assembles: the classified rounds over the delivered population, the
 * share of each cause, the raw and own-change medians, and, for each of the three largest causes,
 * its open fix item — with the filing payload a cause still owes when `options.file` is on.
 */

const medianLine = report => `raw median ${report.reworkRounds.rawMedian} p90 ${report.reworkRounds.rawP90}; own-change median ${report.reworkRounds.median} p90 ${report.reworkRounds.p90}`;
export function render(report) {
  const lines = [`Rework causes over the last ${report.population.items} delivered items (${report.population.delivered} delivered, ${report.population.measured} measured, ${report.rounds} rounds, window ${report.window.since ?? '?'} … ${report.window.until}).`];
  if (report.statement) lines.push(report.statement);
  lines.push(`Rounds: ${report.rounds} classified; ${report.ownChange} about the item's own change, ${report.outsideItem} outside it. ${medianLine(report)}`);
  for (const entry of report.largest) lines.push(`  ${String(Math.round((entry.share ?? 0) * 100)).padStart(3)}%  ${entry.label}: ${entry.count} round${entry.count === 1 ? '' : 's'}`);
  for (const fix of report.fix) {
    if (fix.item) lines.push(`  fix item for ${fix.cause}: ${fix.item.key} — ${fix.item.title}`);
    else if (fix.filing) lines.push(`  no open fix item for ${fix.cause}; file with POST /api/work: ${JSON.stringify(fix.filing)}`);
    else if (fix.filed) lines.push(`  filed fix item for ${fix.cause}: ${fix.filed.key ?? `refused (${fix.filed.reason})`}`);
  }
  return lines.join('\n');
}

async function readToken() {
  if (process.env.GRAPHYARD_TOKEN_FILE) return (await readFile(resolve(process.env.GRAPHYARD_TOKEN_FILE), 'utf8')).trim();
  if (process.env.GRAPHYARD_TOKEN) return process.env.GRAPHYARD_TOKEN;
  throw new Error('Set GRAPHYARD_TOKEN or GRAPHYARD_TOKEN_FILE to a credential that can read the work snapshot (coordinator, reader or operator)');
}

/**
 * Files one fix item for a cause with no open item; a refusal is returned as a recorded outcome,
 * never thrown, so a read-only credential still produces the report.
 */
export async function fileFixItem(base, token, payload, post = fetch) {
  try {
    const response = await post(new URL('/api/work', base), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomId() }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { filed: false, status: response.status, reason: body.error ?? `HTTP ${response.status}` };
    return { filed: true, key: body.key ?? null };
  } catch (error) { return { filed: false, status: null, reason: error instanceof Error ? error.message : String(error) }; }
}
const randomId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Bounded paged read of the window's `rework` rows (small `details` payloads, no work documents). */
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

/** The analytics pieces are TypeScript; tsx is a runtime dependency of the CLI already. */
export async function analytics() {
  const { tsImport } = await import('tsx/esm/api');
  const module = await tsImport('../src/flow-analytics.ts', import.meta.url);
  return { recentDelivered: module.recentDelivered, classify: module.classifyReworkReason, summarize: module.summarizeReworkSplit };
}

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
  const { recentDelivered, classify, summarize } = await analytics();
  const snapshot = await api('work-snapshot');
  const population = recentDelivered(snapshot.work, options.items);
  const events = await readReworkEvents(api, population.since);
  const openItems = snapshot.work.filter(item => item.stage !== 'done' && !item.closure);
  const entries = attributeRounds(population.items, events.rounds, classify);
  const summary = summarize(entries);
  const largest = summary.largest.filter(entry => entry.count > 0).slice(0, 3);
  const report = { measuredAt: new Date(Date.parse(snapshot.now)).toISOString(),
    population: { items: options.items, delivered: entries.length, measured: summary.measured, unmeasured: summary.unmeasured },
    window: { since: population.since, until: snapshot.now }, eventsComplete: events.complete, pages: events.pages,
    statement: events.complete ? null
      : `The rework read reached its ${events.pages}-page bound: rounds recorded before the last row read were not examined, so every figure below is a floor.`,
    rounds: summary.rounds, ownChange: summary.ownChange, outsideItem: summary.outsideItem,
    causes: summary.byCause, shares: summary.shares, largest,
    reworkRounds: { rawMedian: summary.rawMedian, rawP90: summary.rawP90, rawDistribution: summary.rawDistribution,
      median: summary.median, p90: summary.p90, distribution: summary.distribution },
    fix: [] };
  for (const entry of largest) {
    const item = findFixItem(openItems, entry.cause);
    report.fix.push({ cause: entry.cause, count: entry.count, share: entry.share, item,
      ...(item || !options.file ? {} : { filed: await fileFixItem(base, token, filingPayload(entry.cause, entry.label, entry.count, entry.share)) }) });
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
