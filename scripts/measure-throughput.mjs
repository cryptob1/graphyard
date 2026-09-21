// The witness measurement behind `manual:throughput-without-master` (GY-87, AC-6).
//
// AC-6 is stated over real deliveries made *with no master session running*: at least ten of
// them, with a submit→merge p50 inside thirty minutes and nothing idle-but-actionable past five
// minutes. `src/throughput.ts` decides that population per delivery, from the record — the
// queue's own history has to show a stateless executor settling the rows that moved the item
// after it submitted, and nothing may have been handed to a master or an operator in between —
// so neither reading below can certify a window by averaging in deliveries a master drove.
//
// There are two readings, and a full witness takes both.
//
//   --live (the default) reads the running control plane and judges what it recorded:
//
//     GRAPHYARD_URL=… GRAPHYARD_TOKEN=… node scripts/measure-throughput.mjs \
//       [--since ISO] [--until ISO] [--minutes N] [--interval SECONDS] [--record DIR] [--json]
//
//   `--minutes` is how long the queue is sampled before the verdict (default 30, one sample every
//   `--interval` seconds, default 60). A run with `--minutes 0` takes a single sample and says so.
//
//   --fleet conducts the window instead of waiting for one. A control plane that runs the
//   coordination loop this change replaces cannot produce a masterless delivery — every delivery
//   in its ledger is excluded, and the live reading says so by name — so the run stands a control
//   plane up on a scratch Postgres, drives ten or more items through it with stateless executors
//   and no master session anywhere, and judges what they delivered:
//
//     node scripts/measure-throughput.mjs --fleet [--deliveries N] [--executors N] \
//       [--scale] [--database URL] [--port N] [--record DIR] [--json]
//
//   `--scale` runs the same workload twice, with one executor and then with `--executors`, and
//   reports both, because "throughput scales with executors" is a comparison and not a threshold.
//   What that comparison shows with stand-in agents is how the load divides — each executor
//   carries its share of the rows and none of them waits on a coordinator — rather than a
//   wall-clock speed-up, because handlers that answer immediately leave the merge queue's own
//   sequencing as the bound. Everything the run stands in for is named in its report
//   (`fleetStandIns`), and so is the honest limit a conducted run leaves (`fleetCaveat`).
//
// The exit status is 0 when the criterion is met and 1 when it is not, so the witness submits a
// `fail` record rather than omitting one. The arithmetic is src/throughput.ts, the same module
// master status reports from, loaded through tsx so the two can never disagree.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function parseArguments(argv) {
  const options = { mode: 'live', since: null, until: null, minutes: 30, intervalSeconds: 60, record: null, json: false,
    deliveries: 12, executors: 2, scale: false, database: null, port: null };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--fleet') options.mode = 'fleet';
    else if (argument === '--live') options.mode = 'live';
    else if (argument === '--since') options.since = value();
    else if (argument === '--until') options.until = value();
    else if (argument === '--minutes') options.minutes = Number(value());
    else if (argument === '--interval') options.intervalSeconds = Number(value());
    else if (argument === '--deliveries') options.deliveries = Number(value());
    else if (argument === '--executors') options.executors = Number(value());
    else if (argument === '--scale') options.scale = true;
    else if (argument === '--database') options.database = value();
    else if (argument === '--port') options.port = Number(value());
    else if (argument === '--record') options.record = value();
    else if (argument === '--json') options.json = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  for (const stamp of [options.since, options.until]) if (stamp !== null && !Number.isFinite(Date.parse(stamp))) throw new Error(`Not an ISO 8601 timestamp: ${stamp}`);
  if (!Number.isFinite(options.minutes) || options.minutes < 0 || options.minutes > 720) throw new Error('--minutes takes 0 to 720');
  if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 5 || options.intervalSeconds > 900) throw new Error('--interval takes whole seconds between 5 and 900');
  // The criterion asks for at least ten deliveries, so a conducted run may not be configured to
  // make fewer: a witness that drove five items would report "not met" for a reason it chose.
  if (!Number.isInteger(options.deliveries) || options.deliveries < 10 || options.deliveries > 200) throw new Error('--deliveries takes a whole number between 10 and 200; AC-6 is stated over at least ten');
  if (!Number.isInteger(options.executors) || options.executors < 1 || options.executors > 16) throw new Error('--executors takes a whole number between 1 and 16');
  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)) throw new Error('--port takes a whole port number');
  return options;
}

const minutes = ms => `${Math.round(ms / 6000) / 10} min`;
const seconds = ms => `${Math.round(ms / 100) / 10} s`;

export function render(witness) {
  const lines = [
    `Deliveries with no master session running: ${witness.deliveries} of ${witness.delivered} in ${witness.window.since ?? 'the whole ledger'} → ${witness.window.until ?? 'now'} (the criterion asks for at least ${witness.thresholds.minimumDeliveries})`,
    `Submit→merge over them: p50 ${minutes(witness.submitToMergeP50Ms)}, p90 ${minutes(witness.submitToMergeP90Ms)} (target p50 ${minutes(witness.thresholds.submitToMergeP50Ms)})`,
    `Every delivery in the window, for comparison: p50 ${minutes(witness.windowSubmitToMerge.p50Ms)}, p90 ${minutes(witness.windowSubmitToMerge.p90Ms)} over ${witness.windowSubmitToMerge.count}`,
    `Queue: ${witness.samples} sample(s); worst idle-but-actionable ${witness.worstIdle ? `${minutes(witness.worstIdle.waitedMs)} on ${witness.worstIdle.key} at ${witness.worstIdle.at}` : `none past ${minutes(witness.thresholds.idleMs)}`}`,
    `Executors that settled rows: ${witness.executors.join(', ') || 'none'}`,
    `Hand-offs to a master or operator between submit and merge: ${witness.handoffs.items} item(s) (${witness.handoffs.blocked} blocked report(s), ${witness.handoffs.requirements} requirements revision(s))`,
  ];
  if (witness.excluded.length) lines.push(`Excluded from the population: ${witness.excluded.length}` + (witness.excluded.length ? ` — most recently ${witness.excluded.slice(-3).map(entry => `${entry.key} (${entry.reason})`).join('; ')}` : ''));
  lines.push(witness.met ? 'Verdict: met' : `Verdict: not met — ${witness.reasons.join('; ')}`);
  return lines.join('\n');
}

/** One conducted run, rendered: what it drove, who ran it, and how long a row waited to be taken. */
export function renderFleet(run) {
  return [
    `Fleet run: ${run.delivered} of ${run.requested} items delivered in ${seconds(run.elapsedMs)} by ${run.executors.length} executor(s), no master session in the run`,
    ...run.executors.map(entry => `  ${entry.id} on ${entry.host}: ${entry.ran} action(s), ${entry.failed} failed (${entry.kinds.join(', ') || 'none'})`),
    `Queue wait (requested → claimed): p50 ${seconds(run.queueWait.p50Ms)}, p90 ${seconds(run.queueWait.p90Ms)} over ${run.queueWait.count} row(s)`,
    render(run.witness),
  ].join('\n');
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
/** The conducted run is TypeScript too, and loaded the same way. */
export async function fleet() {
  const { tsImport } = await import('tsx/esm/api');
  return tsImport('../src/throughput-run.ts', import.meta.url);
}

async function record(directory, report) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${report.measuredAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(report, null, 2) + '\n');
  return file;
}

/**
 * The live reading: sample the running control plane's queue across the window and judge what it
 * recorded. A single reading catches a row that has already been waiting; only repeated readings
 * catch one that goes idle while the window is open.
 */
export async function measureLive(options, env, sleep) {
  const base = env.GRAPHYARD_URL;
  if (!base) throw new Error('Set GRAPHYARD_URL to the control plane origin');
  const token = await readToken(env);
  const read = async () => {
    const response = await fetch(new URL('/api/work-snapshot', base), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Graphyard refused the work snapshot (${response.status})`);
    return response.json();
  };
  const { judgeThroughput, sampleQueue } = await measurements();
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
  return { measuredAt: new Date().toISOString(), mode: 'live', origin: base, sampledMinutes: options.minutes, intervalSeconds: options.intervalSeconds, witness };
}

/**
 * The conducted run, on a Postgres of its own.
 *
 * `--database` points the run at one; without it the run starts an embedded server and throws it
 * away again, which is why the measurement never touches a production database and never has to
 * be trusted not to.
 */
export async function measureFleet(options, env) {
  const { runFleetWitness } = await fleet();
  const log = options.json ? () => {} : line => console.error(line);
  const started = [];
  const withDatabase = async run => {
    if (options.database) return run(options.database);
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const port = options.port ?? Number(env.GRAPHYARD_WITNESS_PORT ?? 15_543);
    const database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-witness-')), user: 'graphyard', password: 'witness-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
    await database.initialise(); await database.start();
    started.push(database);
    const name = `graphyard_witness_${Date.now().toString(36)}`;
    await database.createDatabase(name);
    return run(`postgres://graphyard:witness-only@127.0.0.1:${port}/${name}`);
  };
  try {
    return await withDatabase(async url => {
      // "Throughput scales with executors" is a comparison, so `--scale` makes it one: the same
      // workload, once with a single executor and once with the configured fleet.
      const runs = [];
      if (options.scale && options.executors > 1) runs.push(await runFleetWitness({ databaseUrl: url, deliveries: options.deliveries, executors: 1, log }));
      runs.push(await runFleetWitness({ databaseUrl: url, deliveries: options.deliveries, executors: options.executors, log }));
      const witnessed = runs.at(-1);
      return { measuredAt: new Date().toISOString(), mode: 'fleet', deliveries: options.deliveries, executors: options.executors,
        runs, standIns: witnessed.standIns, caveat: witnessed.caveat, witness: witnessed.witness };
    });
  } finally { for (const database of started) await database.stop().catch(() => {}); }
}

export async function main(argv = process.argv.slice(2), env = process.env, sleep = delay) {
  const options = parseArguments(argv);
  const report = options.mode === 'fleet' ? await measureFleet(options, env) : await measureLive(options, env, sleep);
  if (options.record) report.recorded = await record(options.record, report);
  const rendered = options.mode === 'fleet'
    ? [...report.runs.map(renderFleet), '', 'Stood in for:', ...report.standIns.map(entry => `  - ${entry}`), '', report.caveat].join('\n')
    : render(report.witness);
  console.log(options.json ? JSON.stringify(report, null, 2) : rendered + (report.recorded ? `\nRecorded ${report.recorded}` : ''));
  // Every run has to meet it, not only the one the report carries as its verdict: a `--scale`
  // comparison whose first run left a row idle is a run that failed, and hiding that behind the
  // second would make the comparison worth less than not taking it.
  if (!(options.mode === 'fleet' ? report.runs.every(run => run.witness.met) : report.witness.met)) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
