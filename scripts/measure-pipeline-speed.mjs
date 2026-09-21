// The periodic pipeline-speed measurement (GY-54). Reads the work snapshot with a read-capable
// credential, summarizes submit→merge p50/p90, rework rounds, hand-offs and execution versus wait
// over every delivery whose timeline recorded a submission, judges the target, and — with
// `--split` — reports the same figures for the deliveries merged before and after each named item
// landed, so the effect of a change is measured rather than asserted. `--record DIR` appends the
// report as one timestamped JSON file per run; the master's 3-hourly measurement points it at
// `.graphyard/measurements/pipeline-speed`.
//
//   GRAPHYARD_URL=… GRAPHYARD_TOKEN=… node scripts/measure-pipeline-speed.mjs [--since ISO] [--until ISO]
//     [--split GY-55,GY-64] [--record DIR] [--json]
//
// The arithmetic is the same module master status uses (src/pipeline-speed.ts), loaded through
// tsx so the two can never disagree.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArguments(argv) {
  const options = { since: null, until: null, split: [], record: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--since') options.since = value();
    else if (argument === '--until') options.until = value();
    else if (argument === '--split') options.split.push(...value().split(',').map(key => key.trim()).filter(Boolean));
    else if (argument === '--record') options.record = value();
    else if (argument === '--json') options.json = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  for (const stamp of [options.since, options.until]) if (stamp !== null && !Number.isFinite(Date.parse(stamp))) throw new Error(`Not an ISO 8601 timestamp: ${stamp}`);
  return options;
}

/** The accepted merge instant of a delivered item, on the repository clock when the delivery carried it there. */
const mergedAt = item => item.stage === 'done' && item.delivery ? item.delivery.mergedAtRepository ?? item.delivery.mergedAt : null;

/**
 * One report: the overall summary for the window, and for each split item the summary of the
 * deliveries merged before it landed and of those merged after. An item that is not delivered
 * cannot split anything and says so.
 */
export function measure(work, now, options, summarize) {
  const overall = summarize(work, now, { since: options.since, until: options.until });
  const splits = options.split.map(key => {
    const item = work.find(entry => entry.key === key);
    const at = item ? mergedAt(item) : null;
    if (!at) return { key, mergedAt: null, reason: item ? `${key} is not delivered yet` : `${key} is not a work item`, before: null, after: null };
    return { key, mergedAt: at, reason: null,
      before: summarize(work, now, { since: options.since, until: at }),
      after: summarize(work, now, { since: at, until: options.until }) };
  });
  return { measuredAt: new Date(now).toISOString(), window: { since: options.since, until: options.until }, overall, splits };
}

const minutes = ms => `${Math.round(ms / 6000) / 10} min`;
const line = (label, summary) => `${label}: ${summary.measured} measured (${summary.routine.count} routine, ${summary.unmeasured} unmeasured); submit→merge p50 ${minutes(summary.submitToMerge.p50Ms)} p90 ${minutes(summary.submitToMerge.p90Ms)}; routine p50 ${minutes(summary.routine.submitToMerge.p50Ms)} p90 ${minutes(summary.routine.submitToMerge.p90Ms)}; rework median ${summary.reworkRounds.median} p90 ${summary.reworkRounds.p90}; hand-offs on ${summary.interventions.items} item(s); execution share ${summary.execution.share === null ? 'n/a' : `${Math.round(summary.execution.share * 100)}%`}; target ${summary.met === null ? `not judged (${summary.reason})` : summary.met ? 'met' : `missed (${summary.reason})`}`;
export function render(report) {
  const lines = [line('Overall', report.overall)];
  for (const split of report.splits) {
    if (!split.mergedAt) { lines.push(`${split.key}: ${split.reason}`); continue; }
    lines.push(`${split.key} landed ${split.mergedAt}`, `  ${line('before', split.before)}`, `  ${line('after', split.after)}`);
  }
  return lines.join('\n');
}

async function readToken() {
  if (process.env.GRAPHYARD_TOKEN_FILE) return (await readFile(resolve(process.env.GRAPHYARD_TOKEN_FILE), 'utf8')).trim();
  if (process.env.GRAPHYARD_TOKEN) return process.env.GRAPHYARD_TOKEN;
  throw new Error('Set GRAPHYARD_TOKEN or GRAPHYARD_TOKEN_FILE to a credential that can read the work snapshot (coordinator, reader or operator)');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const base = env.GRAPHYARD_URL;
  if (!base) throw new Error('Set GRAPHYARD_URL to the control plane origin');
  const response = await fetch(new URL('/api/work-snapshot', base), { headers: { Authorization: `Bearer ${await readToken()}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Graphyard refused the work snapshot (${response.status})`);
  const snapshot = await response.json();
  const report = measure(snapshot.work, Date.parse(snapshot.now), options, await summarizer());
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
