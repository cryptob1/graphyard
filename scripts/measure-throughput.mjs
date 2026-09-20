// The witness measurement behind `manual:throughput-without-master` (GY-87, AC-6).
//
// AC-6 is a claim about real deliveries: with the control plane naming each item's next action
// and stateless executors running the rows, throughput follows the number of executors and agents
// rather than an operator's attention. A fixture cannot establish that — a fleet of stubs that
// finishes in milliseconds passes a thirty-minute target whatever the loop does — so this reads
// the live control plane instead, and judges what it actually recorded:
//
//   * at least ten deliveries in the window, with the submit→merge p50 the ledger really holds;
//   * no action row idle but actionable past the five-minute bound, in any sample taken across
//     the window (the queue is polled, not read once);
//   * no hand-off to a master or operator between submit and merge on any measured delivery, and
//     every settled action row settled by a named stateless executor. A master daemon claims
//     nothing from the queue, so it can settle nothing in it.
//
//   GRAPHYARD_URL=… GRAPHYARD_TOKEN=… node scripts/measure-throughput.mjs \
//     [--since ISO] [--until ISO] [--minutes N] [--interval SECONDS] [--record DIR] [--json]
//
// `--minutes` is how long the queue is sampled before the verdict (default 30, one sample every
// `--interval` seconds, default 60). A run with `--minutes 0` takes a single sample and says so.
// The exit status is 0 when the criterion is met and 1 when it is not, so the witness submits a
// `fail` record rather than omitting one. The arithmetic is src/throughput.ts, the same module
// master status reports from, loaded through tsx so the two can never disagree.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function parseArguments(argv) {
  const options = { since: null, until: null, minutes: 30, intervalSeconds: 60, record: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--since') options.since = value();
    else if (argument === '--until') options.until = value();
    else if (argument === '--minutes') options.minutes = Number(value());
    else if (argument === '--interval') options.intervalSeconds = Number(value());
    else if (argument === '--record') options.record = value();
    else if (argument === '--json') options.json = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  for (const stamp of [options.since, options.until]) if (stamp !== null && !Number.isFinite(Date.parse(stamp))) throw new Error(`Not an ISO 8601 timestamp: ${stamp}`);
  if (!Number.isFinite(options.minutes) || options.minutes < 0 || options.minutes > 720) throw new Error('--minutes takes 0 to 720');
  if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 5 || options.intervalSeconds > 900) throw new Error('--interval takes whole seconds between 5 and 900');
  return options;
}

const minutes = ms => `${Math.round(ms / 6000) / 10} min`;
export function render(witness) {
  const lines = [
    `Deliveries: ${witness.deliveries} measured (${witness.routine} routine) in ${witness.window.since ?? 'the whole ledger'} → ${witness.window.until ?? 'now'}`,
    `Submit→merge: p50 ${minutes(witness.submitToMergeP50Ms)}, p90 ${minutes(witness.submitToMergeP90Ms)} (target p50 ${minutes(witness.thresholds.submitToMergeP50Ms)})`,
    `Queue: ${witness.samples} sample(s); worst idle-but-actionable ${witness.worstIdle ? `${minutes(witness.worstIdle.waitedMs)} on ${witness.worstIdle.key} at ${witness.worstIdle.at}` : `none past ${minutes(witness.thresholds.idleMs)}`}`,
    `Executors that settled rows: ${witness.executors.join(', ') || 'none'}`,
    `Hand-offs to a master or operator between submit and merge: ${witness.handoffs.items} item(s) (${witness.handoffs.blocked} blocked report(s), ${witness.handoffs.requirements} requirements revision(s))`,
    witness.met ? 'Verdict: met' : `Verdict: not met — ${witness.reasons.join('; ')}`,
  ];
  return lines.join('\n');
}

async function readToken(env) {
  if (env.GRAPHYARD_TOKEN_FILE) return (await readFile(resolve(env.GRAPHYARD_TOKEN_FILE), 'utf8')).trim();
  if (env.GRAPHYARD_TOKEN) return env.GRAPHYARD_TOKEN;
  throw new Error('Set GRAPHYARD_TOKEN or GRAPHYARD_TOKEN_FILE to a credential that can read the work snapshot');
}

/** The measurement module is TypeScript; tsx is a runtime dependency of the CLI already. */
export async function measurements() {
  const { tsImport } = await import('tsx/esm/api');
  return tsImport('../src/throughput.ts', import.meta.url);
}

export async function main(argv = process.argv.slice(2), env = process.env, sleep = delay) {
  const options = parseArguments(argv);
  const base = env.GRAPHYARD_URL;
  if (!base) throw new Error('Set GRAPHYARD_URL to the control plane origin');
  const token = await readToken(env);
  const read = async () => {
    const response = await fetch(new URL('/api/work-snapshot', base), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Graphyard refused the work snapshot (${response.status})`);
    return response.json();
  };
  const { judgeThroughput, sampleQueue } = await measurements();

  // Sample the live queue across the window: a single reading catches a row that has already been
  // waiting, but only repeated readings catch one that goes idle while the window is open.
  const samples = [];
  const deadline = Date.now() + options.minutes * 60_000;
  let snapshot = await read();
  for (;;) {
    samples.push(sampleQueue(snapshot.work, new Date(snapshot.now)));
    if (Date.now() >= deadline) break;
    await sleep(Math.min(options.intervalSeconds * 1000, Math.max(0, deadline - Date.now())));
    snapshot = await read();
  }
  const witness = judgeThroughput(snapshot.work, Date.parse(snapshot.now), samples, { since: options.since, until: options.until });
  const report = { measuredAt: new Date().toISOString(), origin: base, sampledMinutes: options.minutes, intervalSeconds: options.intervalSeconds, witness };
  if (options.record) {
    await mkdir(options.record, { recursive: true });
    const file = join(options.record, `${report.measuredAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify(report, null, 2) + '\n');
    report.recorded = file;
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : render(witness) + (report.recorded ? `\nRecorded ${report.recorded}` : ''));
  if (!witness.met) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
