// Post-deploy verification of GY-87's throughput claim (GY-99).
//
// Reads the deployed control plane's own release identity and its real ledger, measures
// first-submit-to-merge and idle-but-actionable over the deliveries made with no master session
// running since a release carrying GY-87 began serving, and judges the claim against its own
// budgets. It relaxes nothing: a miss is printed as a finding with the measured values and a
// named follow-up, and every delivery the window holds — counted or excluded — is listed with its
// figures, the executor that claimed each of its actions, and the reason it is in or out.
//
//   GRAPHYARD_URL=… GRAPHYARD_TOKEN_FILE=… node scripts/measure-throughput.mjs \
//     [--since ISO] [--until ISO] [--claim GY-87] [--repository PATH] [--record DIR] [--json]
//
// `--record DIR` appends the report as one timestamped JSON file (never overwriting one recorded in
// the same millisecond, and keeping the newest 30 of its own records; other files in DIR are left alone), which is what `master status` reads to say
// whether the claim is verified against the release now serving. The loop records one itself after
// each verified deployment (GY-1385); this script is the by-hand run. The arithmetic, the population
// rule and the recorder are the module master status uses (src/throughput.ts), loaded through tsx,
// so the measurement and the report can never disagree.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArguments(argv) {
  const options = { since: null, until: null, claim: 'GY-87', repository: process.cwd(), record: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--since') options.since = value();
    else if (argument === '--until') options.until = value();
    else if (argument === '--claim') options.claim = value();
    else if (argument === '--repository') options.repository = value();
    else if (argument === '--record') options.record = value();
    else if (argument === '--json') options.json = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  for (const stamp of [options.since, options.until]) if (stamp !== null && !Number.isFinite(Date.parse(stamp))) throw new Error(`Not an ISO 8601 timestamp: ${stamp}`);
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(options.claim)) throw new Error(`--claim takes a work-item key such as GY-87, not ${options.claim}`);
  return options;
}

const defaultRun = (command, args) => spawnSync(command, args, { encoding: 'utf8' });

/**
 * Whether the release now serving contains the claim's own merge commit — the fact that makes
 * this a measurement of GY-87's executors rather than of whatever ran before them. Ancestry is
 * asked of the repository the measurement runs in; an answer it cannot give is `null` with the
 * reason, never an assumption either way.
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

async function readToken(env) {
  if (env.GRAPHYARD_TOKEN_FILE) return (await readFile(resolve(env.GRAPHYARD_TOKEN_FILE), 'utf8')).trim();
  if (env.GRAPHYARD_TOKEN) return env.GRAPHYARD_TOKEN;
  throw new Error('Set GRAPHYARD_TOKEN or GRAPHYARD_TOKEN_FILE to a credential that can read the work snapshot (coordinator, reader or operator)');
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
  // The release identity comes from the deployment itself, never from the checkout this runs in:
  // what is serving is the thing under measurement.
  const status = await read('/api/status', 'control-plane status');
  // The bounded read (GY-1385): the default snapshot carries each settled delivery's summary, which
  // is enough to choose the window; only the deliveries inside it are then read whole, for the
  // action rows and sessions admission judges. The full snapshot of every item is never asked for.
  const snapshot = await read('/api/work-snapshot', 'work snapshot');
  const now = Date.parse(snapshot.now ?? status.now ?? new Date().toISOString());
  const claim = snapshot.work.find(item => item.key === options.claim);
  // A build that never stamped a release revision still names its commit in the build identity
  // the platform injects; the report says which field named it.
  const { deployedRevision } = deps.deployedRevision ? deps : await module_();
  const { revision, source } = deployedRevision(status);
  const containment = claimContainment({ revision, mergeSha: claim?.delivery?.mergeSha ?? null, claim: options.claim, repository: options.repository }, deps.run);
  const deployed = { revision, revisionSource: source, version: status.release?.version ?? null, origin: new URL(base).origin,
    observedAt: status.now ?? new Date(now).toISOString(), containsClaim: containment.contains, reason: containment.reason };
  const measure = deps.measure ?? (await module_()).measureThroughput;
  const readItem = id => read(`/api/work/${encodeURIComponent(id)}`, `work item ${id}`);
  const { report } = await measure(snapshot.work, readItem, now, { deployed, since: options.since, until: options.until, claimKey: options.claim });
  if (options.record) {
    // The loop's own recorder (GY-1414): a file is never overwritten — a second record in the same
    // millisecond takes the next `_N` suffix — and the directory keeps the newest 30.
    const { recordThroughputMeasurement } = deps.recordThroughputMeasurement ? deps : await module_();
    report.recorded = join(options.record, await recordThroughputMeasurement(resolve(options.record), report, '.'));
  }
  const { renderThroughput } = deps.render ? { renderThroughput: deps.render } : await module_();
  console.log(options.json ? JSON.stringify(report, null, 2) : renderThroughput(report) + (report.recorded ? `\nRecorded ${report.recorded}` : ''));
  // An unverified claim is not an error — it is the measurement's finding — but the exit status
  // says so, so a scheduled run cannot report a miss as a quiet success.
  if (report.verdict !== 'verified') process.exitCode = 2;
  return report;
}

/** The verification module is TypeScript; tsx is a runtime dependency of the CLI already. */
const module_ = async () => { const { tsImport } = await import('tsx/esm/api'); return tsImport('../src/throughput.ts', import.meta.url); };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
