// Run once after linking Railway, and again whenever .graphyard/credentials.json changes.
// Credentials are generated locally and sent over stdin. Every re-run derives the delegation
// capacity variables from the principal set and reports drift against what the deployment
// currently runs with before setting the corrected values.
//
// A full run writes GRAPHYARD_PRINCIPALS from credentials.json, so on a deployment whose principal
// set has since grown (installers and `graphyard principals` add to the deployment, not to this
// file) it refuses rather than drop them (GY-1365).
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

/**
 * The principals the deployment runs with that `principals` (credentials.json) lacks: a full run
 * would replace GRAPHYARD_PRINCIPALS with the file and drop them, so it refuses naming their ids
 * (never a token). Null when nothing would be dropped: an empty service or an unparsable value
 * holds no principal that runs. When Railway's variable list itself could not be read (null) the
 * comparison cannot be made, so the full run refuses rather than overwrite the set blind.
 */
export function principalNarrowing(principals, deployed) {
  if (deployed === null || deployed === undefined) return `Railway did not answer \`variable list\` for the service, so the deployment's GRAPHYARD_PRINCIPALS cannot be compared with .graphyard/credentials.json; a full run would overwrite it blind and nothing was set. Check \`railway status\` and the login, then rerun.`;
  let running;
  try { running = JSON.parse(deployed?.GRAPHYARD_PRINCIPALS ?? '[]'); } catch { return null; }
  if (!Array.isArray(running)) return null;
  const kept = new Set(principals.map(principal => principal.id));
  const dropped = running.map(principal => principal?.id).filter(id => typeof id === 'string' && !kept.has(id));
  if (!dropped.length) return null;
  return `The deployment's GRAPHYARD_PRINCIPALS holds ${dropped.length} principal${dropped.length === 1 ? '' : 's'} that .graphyard/credentials.json does not (${dropped.join(', ')}); a full run would drop them and nothing was set. Add them to credentials.json first.`;
}

// The service's variables, read without printing them; null when Railway cannot answer. An empty
// answer is a service with no variables set yet.
function railwayVariables(railway) {
  try {
    const out = execFileSync('npx', [...railway, 'variable', 'list', '--service', 'graphyard', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() ? JSON.parse(out) : {};
  } catch { return null; }
}

async function main(args) {
  register();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = new URL('../.graphyard/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = new URL('credentials.json', directory);
  let principals = null;
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
  const url = process.env.GRAPHYARD_URL?.replace(/\/$/, '');
  const operator = principals?.find(principal => principal.role === 'admin');
  const variables = railwayVariables(railway);
  const narrowing = principalNarrowing(principals, variables);
  if (narrowing) { console.error(narrowing); process.exitCode = 1; return; }
  const { delegationLimitAssignments, readDeployedDelegationLimits } = await import('../src/install/limits.ts');
  const { generatedFilesAssignment } = await import('../src/install/generated-files.ts');
  let deployed = null;
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
  execFileSync('npx', [...railway, 'variable', 'set', '--service', 'graphyard', '--skip-deploys', 'DATABASE_URL=${{Postgres.DATABASE_URL}}', 'HOST=0.0.0.0', 'PORT=4310', 'GITHUB_REPOSITORY=cryptob1/graphyard', ...limits.lines, ...(generated ? [generated.line] : [])], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`Railway configured with ${[...limits.lines, ...(generated ? [generated.line] : [])].join(' ')}${limits.drift.length ? ` (corrected ${limits.drift.map(entry => entry.variable).join(', ')})` : ''}. Credentials saved to .graphyard/credentials.json (mode 0600); no credentials printed. Redeploy the service for the variables to take effect.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
