// GY-3214: `npx @cryptob1/graphyard …` on a host with no Graphyard checkout. The published package is this
// launcher alone; the code it runs is a Git checkout of Graphyard's upstream at the commit the
// package was published from, under the install's own directory, so the loop, `graphyard upgrade`
// and the deploy watch move it with Git like any other install.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentCliPath, prepareCliRelease } from './cli-release.mjs';

/** The release tree this host runs for the repository `args` or the working directory names, cloned and installed on first use. */
export async function releaseRoot(packageRoot, args) {
  const flag = args.findIndex(arg => arg === '--repo' || arg.startsWith('--repo='));
  let repository = flag < 0 ? '' : args[flag].startsWith('--repo=') ? args[flag].slice(7) : args[flag + 1] ?? '';
  if (!repository) {
    try { repository = /[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())?.[1] ?? ''; } catch { /* not a checkout */ }
  }
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repository);
  if (!match) { console.error('Run this in your repository\'s checkout: npx @cryptob1/graphyard up --repo OWNER/NAME'); process.exit(1); }
  const directory = join(process.env.GRAPHYARD_CONFIG_HOME ?? join(homedir(), '.config', 'graphyard'), `${match[1]}-${match[2]}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'));
  // An installed host runs the release it serves, which the deploy watch moves.
  const current = currentCliPath(directory);
  if (existsSync(join(current, 'bin', 'graphyard.mjs'))) return realpathSync(current);
  const { graphyardCommit: commit, graphyardUpstream: upstream } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  console.error(`[graphyard] Fetching Graphyard ${commit.slice(0, 12)} into ${directory} (a few minutes, once)`);
  const run = (command, words, options = {}) => {
    // The children's output goes to stderr: stdout is the command's own (up --json).
    if (spawnSync(command, words, { cwd: options.cwd, stdio: ['ignore', 2, 2] }).status !== 0) throw new Error(`${command} ${words.join(' ')} failed`);
  };
  const release = await prepareCliRelease(directory, upstream, commit, run);
  symlinkSync(release, current);
  return release;
}
