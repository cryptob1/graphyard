// Concern: GY-1529 — the known-good coordinator: a pinned checkout at the last promoted SHA that runs the master loop, outside the candidate under test.
//
// The loop used to run from the checkout that is also the repository under change, so when Graphyard
// merged its own broken change the loop that had to act was the broken one. The pin is a detached
// linked worktree under `<installDir>/coordinator/<sha12>`, built there, and `coordinator/current` is a
// symlink moved by rename only after production verified the SHA. The previous pin is kept so
// `graphyard master recover` can repoint at it; the one before that is removed.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildRun } from '../child-runner.js';

export const knownGoodDirectory = (installDir: string) => join(installDir, 'coordinator');
/** The CLI the master unit runs while a pin exists. */
export const knownGoodCli = (installDir: string) => join(knownGoodDirectory(installDir), 'current', 'dist', 'cli.js');
const stateFile = (installDir: string) => join(knownGoodDirectory(installDir), 'state.json');
const fullSha = /^[0-9a-f]{40}$/;
const short = (sha: string) => sha.slice(0, 12);

export interface KnownGoodState { sha: string; pinnedAt: string; previous: string | null }
/** Where the pin lives and which repository it is a worktree of. */
export interface KnownGoodGit { installDir: string; repository: string; now?: () => Date }

/** The pin, or null when none was ever made (the unit then runs the checkout path). */
export function knownGoodState(installDir: string): KnownGoodState | null {
  try {
    const state = JSON.parse(readFileSync(stateFile(installDir), 'utf8'));
    if (!fullSha.test(state?.sha) || typeof state.pinnedAt !== 'string') return null;
    return { sha: state.sha, pinnedAt: state.pinnedAt, previous: fullSha.test(state.previous) ? state.previous : null };
  } catch { return null; }
}

/** The launcher `dist/cli.js` when the build emitted none: the TypeScript sources run through tsx, as bin/graphyard.mjs does. */
const launcher = `import { tsImport } from 'tsx/esm/api';\nawait tsImport('../src/cli.ts', import.meta.url);\n`;

/**
 * Pin `sha`: a detached worktree at `coordinator/<sha12>` with `npm ci` and `npm run build` run in it,
 * then `current` repointed by renaming a fresh symlink over it, so a reader sees the old pin or the new
 * one, never neither. Any failure removes the new worktree and leaves the pin as it was. The pin before
 * the previous one is removed last.
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
  // Everything but the new pin and the one it replaced goes, the older pin first.
  const keep = new Set([short(sha), next.previous ? short(next.previous) : '']);
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (keep.has(entry) || !/^[0-9a-f]{12}$/.test(entry) || !lstatSync(path).isDirectory()) continue;
    await worktree('remove', '--force', path).catch(() => rmSync(path, { recursive: true, force: true }));
  }
  return next;
}

/** Pin `sha` only when production serves it; a failed verification leaves the pin unchanged. */
export async function pinAfterVerify(git: KnownGoodGit, sha: string, run: ChildRun, verify: () => Promise<{ verified: boolean }>): Promise<KnownGoodState | null> {
  if (!(await verify()).verified) return null;
  return pinKnownGood(git, sha, run);
}

/** A release's `verify` that pins the SHA it confirmed; a pin that fails is the loop's to retry, never a verification failure. */
export function pinningVerify<V extends { verified: boolean }>(git: KnownGoodGit, run: ChildRun, verify: (sha: string) => Promise<V>, onFailure: (error: unknown) => void = () => {}) {
  return async (sha: string): Promise<V> => {
    const verified = await verify(sha);
    if (verified.verified) await pinKnownGood(git, sha, run).catch(onFailure);
    return verified;
  };
}

/** How many promotions production is ahead of the pin, from the promoted SHAs newest first; null when the pin is not among them. */
export function promotionsBehind(pinned: string, promoted: string[]): number | null {
  const index = promoted.findIndex(sha => sha === pinned);
  return index < 0 ? null : index;
}

/** The `graphyard doctor` line; FAIL when the pin is more than one promotion behind production (or no longer a promoted SHA). */
export function coordinatorDoctorLine(pinned: string | null, production: string | null, behind: number | null) {
  const label = (sha: string | null) => sha ? short(sha) : 'none';
  const line = `coordinator: pinned ${label(pinned)} (production ${label(production)})`;
  const same = !!pinned && !!production && (pinned.startsWith(production) || production.startsWith(pinned));
  const stale = !!pinned && !!production && !same && (behind === null || behind > 1);
  return { line: stale ? `FAIL ${line}` : line, ok: !stale };
}
