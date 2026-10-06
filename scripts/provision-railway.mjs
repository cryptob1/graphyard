// Run once after linking Railway, and again whenever .graphyard/credentials.json changes.
// Credentials are generated locally and sent over stdin. Every re-run derives the delegation
// capacity variables from the principal set and reports drift against what the deployment
// currently runs with before setting the corrected values. It also carries the main guard's
// revert approver App (GY-1353) and refuses to provision an armed guard without one; after the
// redeploy, `--verify` confirms the live deployment reports that approver.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

/** The variables the control plane reads the revert approver App from (src/main-guard.ts revertApproverVariables). */
export const revertApproverVariables = ['GRAPHYARD_REVERT_APPROVER_APP_ID', 'GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY'];
const missingApprover = `set ${revertApproverVariables.join(', ')}`;

/**
 * The revert approver variables to set, from the operator's approver record: `.graphyard/revert-approver.json`
 * (mode 0600, beside credentials.json) or the same JSON on stdin with `--revert-approver-stdin`, as
 * `{ "appId", "installationId", "privateKey" | "privateKeyFile" }`. `live` is what the deployment's
 * `/api/status` reports (null when unreadable). The guard counts as armed unless the live server says
 * otherwise, since this script provisions GitHub delivery. Errors name all three variables and never a key.
 */
export async function revertApproverAssignment(record, live = null, readKey = path => readFile(path, 'utf8')) {
  const armed = live?.mainGuard ? live.mainGuard.armed !== false : true;
  if (!record) {
    if (!armed) return { variables: null, appId: null, note: 'the main guard is not armed; no revert approver is needed' };
    if (live?.mainGuard?.revertApprover) return { variables: null, appId: live.mainGuard.revertApprover, note: `the deployment already runs with revert approver App ${live.mainGuard.revertApprover}; kept` };
    return { error: `The main guard's revert approver is missing: ${missingApprover} on the control plane to an App installed on the repository other than the control-plane App (the reviewer App serves). Write {"appId", "installationId", "privateKey" or "privateKeyFile"} to .graphyard/revert-approver.json (mode 0600) or pipe it with --revert-approver-stdin, then rerun. Without it main's last-push-approval rule refuses every revert the guard opens.` };
  }
  const appId = Number(record.appId), installationId = Number(record.installationId);
  if (!Number.isSafeInteger(appId) || appId <= 0 || !Number.isSafeInteger(installationId) || installationId <= 0) return { error: `The revert approver record needs a GitHub App id and installation id to ${missingApprover}` };
  if (live?.githubAppId != null && Number(live.githubAppId) === appId) return { error: `The revert approver App ${appId} is the control-plane App; ${missingApprover} to another App installed on the repository (the reviewer App serves)` };
  const privateKey = record.privateKey ?? (record.privateKeyFile ? await readKey(record.privateKeyFile) : '');
  if (!/^-----BEGIN (RSA )?PRIVATE KEY-----/m.test(privateKey)) return { error: `The revert approver record's privateKey (or privateKeyFile) must be the PEM GitHub issued for App ${appId} to ${missingApprover}` };
  return { appId, variables: { GRAPHYARD_REVERT_APPROVER_APP_ID: String(appId), GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID: String(installationId), GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY: privateKey } };
}

/** Whether the live deployment runs with the approver App `appId` and no main-guard attention (`--verify`). */
export function verifyRevertApprover(live, appId) {
  const guard = live?.mainGuard;
  if (!guard) return { ok: false, line: 'The deployment does not report the main guard; deploy main first, then rerun --verify' };
  if (!guard.armed) return { ok: true, line: 'The main guard is not armed; no revert approver is needed' };
  if (guard.attention || !guard.revertApprover) return { ok: false, line: `The deployment still reports no revert approver: ${missingApprover}, redeploy the service, then rerun --verify` };
  if (appId != null && guard.revertApprover !== appId) return { ok: false, line: `The deployment runs with revert approver App ${guard.revertApprover}, not ${appId}; redeploy the service, then rerun --verify` };
  return { ok: true, line: `The deployment's main guard reports revert approver App ${guard.revertApprover}; graphyard doctor lists revert-approver ready` };
}

async function liveStatus(url, token) {
  try {
    const response = await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

// A malformed record is refused without echoing it: JSON.parse quotes the input in its message.
function parseApprover(text, source) {
  try { return JSON.parse(text); } catch { throw new Error(`The revert approver record from ${source} is not valid JSON; nothing was set`); }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(args) {
  register();
  const { delegationLimitAssignments, readDeployedDelegationLimits } = await import('../src/install/limits.ts');
  const { generatedFilesAssignment } = await import('../src/install/generated-files.ts');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = new URL('../.graphyard/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = new URL('credentials.json', directory);
  let principals;
  try { principals = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    principals = [
      { id: 'operator', role: 'admin', token: randomBytes(32).toString('hex') },
      { id: 'herdr-worker-1', role: 'worker', token: randomBytes(32).toString('hex') },
      { id: 'dashboard', role: 'reader', token: randomBytes(32).toString('hex') },
    ];
    await writeFile(file, JSON.stringify(principals, null, 2), { mode: 0o600, flag: 'wx' });
  }
  const railway = ['--yes', '--cache', '/tmp/graphyard-npm-cache', '@railway/cli'];
  // What the deployment runs with now, read from the live server when the operator credential
  // can reach it (GRAPHYARD_URL); the drift report is the difference from the principal set.
  let deployed = null;
  const url = process.env.GRAPHYARD_URL?.replace(/\/$/, '');
  const operator = principals.find(principal => principal.role === 'admin');
  const live = url && operator ? await liveStatus(url, operator.token) : null;
  // The revert approver record, from the operator's 0600 file or stdin; never printed.
  let record = null;
  if (args.includes('--revert-approver-stdin')) record = parseApprover(await readStdin(), 'stdin');
  else {
    try { record = parseApprover(await readFile(new URL('revert-approver.json', directory), 'utf8'), '.graphyard/revert-approver.json'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (args.includes('--verify')) {
    if (!url || !operator) throw new Error('--verify reads the live deployment: set GRAPHYARD_URL and keep the admin principal in .graphyard/credentials.json');
    const verdict = verifyRevertApprover(live, record ? Number(record.appId) : null);
    (verdict.ok ? console.log : console.error)(verdict.line);
    process.exitCode = verdict.ok ? 0 : 1;
    return;
  }
  const approver = await revertApproverAssignment(record, live);
  if (approver.error) { console.error(approver.error); process.exitCode = 1; return; }
  if (url && operator) {
    const read = await readDeployedDelegationLimits(url, operator.token);
    if (read.error) console.error(read.error);
    deployed = read.deployed;
  }
  const limits = delegationLimitAssignments(principals, deployed);
  // The generated-file manifest this repository declares, as the variable the regression guard
  // reads: derived here so the deployment exempts exactly the generated pages instead of treating
  // every one of them as owned work. A repository without a manifest declares none and sets nothing.
  const generated = generatedFilesAssignment(root);
  for (const entry of limits.drift) console.error(`Drift: ${entry.reason}`);
  execFileSync('npx', [...railway, 'variable', 'set', '--service', 'graphyard', '--skip-deploys', '--stdin', 'GRAPHYARD_PRINCIPALS'], { input: JSON.stringify(principals), stdio: ['pipe', 'ignore', 'inherit'] });
  if (approver.variables) execFileSync('npx', [...railway, 'variable', 'set', '--service', 'graphyard', '--skip-deploys', '--stdin', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY'], { input: approver.variables.GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY, stdio: ['pipe', 'ignore', 'inherit'] });
  const approverLines = approver.variables ? revertApproverVariables.slice(0, 2).map(name => `${name}=${approver.variables[name]}`) : [];
  execFileSync('npx', [...railway, 'variable', 'set', '--service', 'graphyard', '--skip-deploys', 'DATABASE_URL=${{Postgres.DATABASE_URL}}', 'HOST=0.0.0.0', 'PORT=4310', 'GITHUB_REPOSITORY=cryptob1/graphyard', ...limits.lines, ...(generated ? [generated.line] : []), ...approverLines], { stdio: ['ignore', 'ignore', 'inherit'] });
  const approverNote = approver.variables ? ` Revert approver App ${approver.appId} set; after the redeploy run with --verify.` : ` Revert approver: ${approver.note}.`;
  console.log(`Railway configured with ${[...limits.lines, ...(generated ? [generated.line] : [])].join(' ')}${limits.drift.length ? ` (corrected ${limits.drift.map(entry => entry.variable).join(', ')})` : ''}. Credentials saved to .graphyard/credentials.json (mode 0600); no credentials printed.${approverNote} Redeploy the service for the variables to take effect.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
