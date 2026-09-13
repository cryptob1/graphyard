// Run once, after linking Railway. Credentials are generated locally and sent over stdin.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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
execFileSync('npx', [...railway, 'variable', 'set', '--service', 'graphyard', '--skip-deploys', '--stdin', 'GRAPHYARD_PRINCIPALS'], { input: JSON.stringify(principals), stdio: ['pipe', 'ignore', 'inherit'] });
execFileSync('npx', [...railway, 'variable', 'set', '--service', 'graphyard', '--skip-deploys', 'DATABASE_URL=${{Postgres.DATABASE_URL}}', 'HOST=0.0.0.0', 'PORT=4310', 'GITHUB_REPOSITORY=cryptob1/graphyard'], { stdio: ['ignore', 'ignore', 'inherit'] });
console.log('Railway configured. Credentials saved to .graphyard/credentials.json (mode 0600); no credentials printed.');
