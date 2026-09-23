// The preventable-rework measurement (GY-115 AC-4). Reads the work snapshot with a read-capable
// credential and reports, for the deliveries merged before and after the split item landed (GY-115
// by default), how many rework rounds were triggered by a criterion an automatable proof had
// caught: returned heads on which trusted evidence recorded one of the item's own unit or
// integration proofs failing, or passing only as unexercised. Each such head is also split by
// whether a reviewer was asked about it first — the judgment mechanical verification now spares —
// so the claim that review-after-proof removes rework is settled by this repository's timelines.
//
//   GRAPHYARD_URL=… GRAPHYARD_TOKEN=… node scripts/measure-preventable-rework.mjs [--split GY-115]
//     [--since ISO] [--until ISO] [--json]
//
// The arithmetic lives in src/preventable-rework.ts, loaded through tsx.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArguments(argv) {
  const options = { since: null, until: null, split: 'GY-115', json: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--since') options.since = value();
    else if (argument === '--until') options.until = value();
    else if (argument === '--split') options.split = value();
    else if (argument === '--json') options.json = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  for (const stamp of [options.since, options.until]) if (stamp !== null && !Number.isFinite(Date.parse(stamp))) throw new Error(`Not an ISO 8601 timestamp: ${stamp}`);
  return options;
}

const mergedAt = item => item.stage === 'done' && item.delivery ? item.delivery.mergedAtRepository ?? item.delivery.mergedAt : null;

/** The before/after report around the split item's landing; before it lands, everything counts as before. */
export function measure(work, now, options, preventableRework) {
  const item = work.find(entry => entry.key === options.split);
  const at = item ? mergedAt(item) : null;
  return {
    measuredAt: new Date(now).toISOString(), split: options.split, landedAt: at,
    reason: at ? null : item ? `${options.split} is not delivered yet; every delivery counts as before it` : `${options.split} is not a work item`,
    before: preventableRework(work, { since: options.since, until: at ?? options.until }),
    after: at ? preventableRework(work, { since: at, until: options.until }) : null,
  };
}

const line = (label, summary) => `${label}: ${summary.items} deliver${summary.items === 1 ? 'y' : 'ies'}, ${summary.reworkRounds} rework round(s), ${summary.returnedHeads} returned head(s); ${summary.catchable} caught by an automatable proof of the item's own criteria — ${summary.catchableAfterReview} after a reviewer was asked, ${summary.catchableBeforeReview} before any review`;
export function render(report) {
  return [report.landedAt ? `${report.split} landed ${report.landedAt}` : report.reason, line('before', report.before), ...(report.after ? [line('after', report.after)] : [])].join('\n');
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
  const report = measure(snapshot.work, Date.parse(snapshot.now), options, await reworkMeasure());
  console.log(options.json ? JSON.stringify(report, null, 2) : render(report));
  return report;
}

/** The measure module is TypeScript; tsx is a runtime dependency of the CLI already. */
export async function reworkMeasure() {
  const { tsImport } = await import('tsx/esm/api');
  return (await tsImport('../src/preventable-rework.ts', import.meta.url)).preventableRework;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
