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
// `--record DIR` appends the report as one timestamped JSON file, which is what `master status`
// reads to say whether the claim is verified against the release now serving. The arithmetic and
// the population rule are the module master status uses (src/throughput.ts), loaded through tsx,
// so the measurement and the report can never disagree.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  const verify = deps.verify ?? await verifier();
  const report = verify(snapshot.work, now, { deployed, since: options.since, until: options.until, claimKey: options.claim });
  if (options.record) {
    await mkdir(options.record, { recursive: true });
    const file = join(options.record, `${report.measuredAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify(report, null, 2) + '\n');
    report.recorded = file;
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
export async function verifier() { return (await module_()).verifyThroughput; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
