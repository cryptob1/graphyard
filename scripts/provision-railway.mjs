// Run once after linking Railway, and again whenever .graphyard/credentials.json changes.
// Credentials are generated locally and sent over stdin. Every re-run derives the delegation
// capacity variables from the principal set and reports drift against what the deployment
// currently runs with before setting the corrected values.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
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
if (url && operator) {
  const live = await readDeployedDelegationLimits(url, operator.token);
  if (live.error) console.error(live.error);
  deployed = live.deployed;
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
