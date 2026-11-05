// Writes or clears the serve record (.graphyard/served.json) the served control plane reads, for
// the E2E cases that judge its serving block (GY-3131):
//
//   node scripts/e2e-serve-record.mjs clear
//   node scripts/e2e-serve-record.mjs '{"commit":"main","url":...}'
//
// The record belongs in the control plane's serving root. Under scripts/e2e-serve.mjs that is the
// delivery fixture's repository it names in .graphyard/e2e-serve.json, not the trial checkout;
// with no e2e serve the root is this checkout. A commit of "main" is that root's main tip.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = await readFile('.graphyard/e2e-serve.json', 'utf8').then(text => JSON.parse(text).delivery?.root ?? '.', () => '.');
const file = join(root, '.graphyard', 'served.json'), [argument] = process.argv.slice(2);

const mainTip = () => {
  for (const ref of ['refs/remotes/origin/main', 'refs/heads/main', 'HEAD']) {
    try { return execFileSync('git', ['-C', root, 'rev-parse', '--verify', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* the ref is absent here */ }
  }
  throw new Error(`${root} has no main commit`);
};

if (argument === 'clear') await rm(file, { force: true });
else {
  const record = JSON.parse(argument);
  if (record.commit === 'main') record.commit = mainTip();
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(file, JSON.stringify(record) + '\n');
}
