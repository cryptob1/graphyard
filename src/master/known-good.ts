// Concern: GY-1529 — the known-good coordinator: a pinned checkout at the last promoted SHA that runs the master loop, outside the candidate under test.
//
// The loop used to run from the checkout that is also the repository under change, so when Graphyard
// merged its own broken change the loop that had to act was the broken one. The pin is a detached
// linked worktree under `<installDir>/coordinator/<sha12>`, built there, and `coordinator/current` is a
// symlink moved by rename. Only the last good pin is kept, the one this process loaded its modules
// from (GY-2760), and the one the running loop recorded it loaded from, since the deploy unit pins from
// its own process; `graphyard master recover` rebuilds an older one.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ChildRun } from '../child-runner.js';

export const knownGoodDirectory = (installDir: string) => join(installDir, 'coordinator');
/** The CLI the master unit runs while a pin exists. */
export const knownGoodCli = (installDir: string) => join(knownGoodDirectory(installDir), 'current', 'dist', 'cli.js');
const stateFile = (installDir: string) => join(knownGoodDirectory(installDir), 'state.json');
const fullSha = /^[0-9a-f]{40}$/;
const short = (sha: string) => sha.slice(0, 12);

export interface KnownGoodState { sha: string; pinnedAt: string; previous: string | null }
/** Where the pin lives and which repository it is a worktree of. */
export interface KnownGoodGit { installDir: string; repository: string; now?: () => Date; loadedFrom?: string }
/** This module's file: a loop running from a pin loaded it from inside that pin's directory. */
const loadedModule = fileURLToPath(import.meta.url);
const runningFile = (installDir: string) => join(knownGoodDirectory(installDir), 'running');

/** The loop records the pin it loaded from, so a deploy pinning from another process never removes it. */
export function recordRunningPin(installDir: string, loadedFrom = loadedModule) {
  const directory = knownGoodDirectory(installDir);
  const entry = existsSync(directory) ? readdirSync(directory).find(name => /^[0-9a-f]{12}$/.test(name) && loadedFrom.startsWith(realpathSync(join(directory, name)) + sep)) : undefined;
  if (entry) writeFileSync(runningFile(installDir), `${entry}\n`);
}

/** The pin, or null when none was ever made (the unit then runs the checkout path). */
export function knownGoodState(installDir: string): KnownGoodState | null {
  try {
    const state = JSON.parse(readFileSync(stateFile(installDir), 'utf8'));
    if (!fullSha.test(state?.sha) || typeof state.pinnedAt !== 'string') return null;
    return { sha: state.sha, pinnedAt: state.pinnedAt, previous: fullSha.test(state.previous) ? state.previous : null };
  } catch { return null; }
}

/** The launcher `dist/cli.js` when the build emitted none: the TypeScript sources run through tsx, as bin/graphyard.mjs does. */
export const launcher = ["import { tsImport } from 'tsx/esm/api';", "await tsImport('../src/cli.ts', import.meta.url);", ''].join('\n');

/**
 * Pin `sha`: a detached worktree at `coordinator/<sha12>` with `npm ci` and `npm run build` run in it,
 * then `current` repointed by renaming a fresh symlink over it, so a reader sees the old pin or the new
 * one, never neither. Any failure removes the new worktree and leaves the pin as it was. Every other
 * pin is removed last.
 */
export async function pinKnownGood(git: KnownGoodGit, sha: string, run: ChildRun): Promise<KnownGoodState> {
  sha = sha.toLowerCase();
  if (!fullSha.test(sha)) throw new Error(`Cannot pin ${sha}: a pin names a full 40-character commit`);
  const before = knownGoodState(git.installDir);
  if (before?.sha === sha) return before;
  const directory = knownGoodDirectory(git.installDir), target = join(directory, short(sha));
  mkdirSync(directory, { recursive: true });
  const worktree = async (...args: string[]) => { await run('git', ['-C', git.repository, 'worktree', ...args]); };
  if (existsSync(target)) await worktree('remove', '--force', target);
  await worktree('add', '--detach', target, sha);
  try {
    await run('npm', ['ci'], { cwd: target, timeoutMs: 20 * 60_000 });
    await run('npm', ['run', 'build'], { cwd: target, timeoutMs: 20 * 60_000 });
    if (!existsSync(join(target, 'dist', 'cli.js'))) { mkdirSync(join(target, 'dist'), { recursive: true }); writeFileSync(join(target, 'dist', 'cli.js'), launcher); }
  } catch (error) {
    await worktree('remove', '--force', target).catch(() => rmSync(target, { recursive: true, force: true }));
    throw error;
  }
  const next: KnownGoodState = { sha, pinnedAt: (git.now?.() ?? new Date()).toISOString(), previous: before?.sha ?? null };
  const staging = join(directory, `current.${process.pid}.tmp`);
  rmSync(staging, { force: true });
  symlinkSync(short(sha), staging);
  renameSync(staging, join(directory, 'current'));
  writeFileSync(`${stateFile(git.installDir)}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${stateFile(git.installDir)}.tmp`, stateFile(git.installDir));
  // Everything but the new pin, the one the running loop recorded and the one this process runs from goes.
  const running = (() => { try { return readFileSync(runningFile(git.installDir), 'utf8').trim(); } catch { return ''; } })();
  const keep = new Set([short(sha), running]);
  const loaded = git.loadedFrom ?? loadedModule;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (keep.has(entry) || !/^[0-9a-f]{12}$/.test(entry) || !lstatSync(path).isDirectory() || loaded.startsWith(realpathSync(path) + sep)) continue;
    await worktree('remove', '--force', path).catch(() => rmSync(path, { recursive: true, force: true }));
  }
  return next;
}
