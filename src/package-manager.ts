// GY-3200: which package manager a checkout uses, read from its lockfile, and the command lines
// the merge trial, worktree setup, worker verification and the serve pass run through it.
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { npmCiArgs } from './cli/test-isolation.js';

export type PackageManager = { name: 'npm' } | { name: 'pnpm'; version: string; workspace: boolean; turbo: boolean };

const readManifest = (root: string): { packageManager?: unknown; devDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown> } => {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) ?? {}; } catch { return {}; }
};

/** pnpm-lock.yaml means pnpm, at package.json packageManager's version (else 10); anything else is npm, as before. */
export function packageManager(root: string): PackageManager {
  if (!existsSync(join(root, 'pnpm-lock.yaml'))) return { name: 'npm' };
  const manifest = readManifest(root);
  const declared = typeof manifest.packageManager === 'string' ? /^pnpm@([^+\s]+)/.exec(manifest.packageManager)?.[1] : undefined;
  const turbo = existsSync(join(root, 'turbo.json')) && !!(manifest.devDependencies?.turbo ?? manifest.dependencies?.turbo);
  return { name: 'pnpm', version: declared ?? '10', workspace: existsSync(join(root, 'pnpm-workspace.yaml')), turbo };
}

/** pnpm through npm's own registry access and cache: no corepack or host install. */
export const pnpm = (version: string, ...args: string[]) => ['npm', 'exec', '--yes', '--', `pnpm@${version}`, ...args];

/** The full, frozen install: npm ci (npmCiArgs) as today, or pnpm's frozen-lockfile install. */
export const installArgv = (manager: PackageManager): string[] =>
  manager.name === 'npm' ? ['npm', ...npmCiArgs] : pnpm(manager.version, 'install', '--frozen-lockfile');

/** A change to one of these root files builds and tests the whole workspace. */
export const rootTrigger = (file: string) => /^(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|turbo\.json|\.npmrc|tsconfig[^/]*\.json)$/.test(file);

/** GY-3250: the workspace packages a change selects: null when a root trigger selects all. */
export interface AffectedPackages { packages: string[] | null; summary: string }

/**
 * The packages a pnpm workspace change affects, from the candidate's own changed files (the trial
 * base to its merge commit, so commits a back-merge brought that the base already holds are not
 * among them): each package holding a changed file, then every package depending on one of those,
 * transitively. `summary` names each and why, for the trial log.
 */
export function affectedPackages(root: string, changedFiles: readonly string[]): AffectedPackages {
  const trigger = changedFiles.find(rootTrigger);
  if (trigger) return { packages: null, summary: `all (root trigger ${trigger})` };
  const listed = /^packages:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))?.[1] ?? '';
  const patterns = [...listed.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)].map(match => match[1]!);
  const dirs = globSync(patterns.filter(pattern => !pattern.startsWith('!')).map(pattern => `${pattern}/package.json`), { cwd: root, exclude: ['**/node_modules/**', ...patterns.filter(pattern => pattern.startsWith('!')).map(pattern => `${pattern.slice(1)}/package.json`)] }).map(file => dirname(file));
  const packages = dirs.map(dir => {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    return { dir, name: String(manifest.name ?? dir), uses: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }) };
  }).sort((a, b) => b.dir.length - a.dir.length || a.dir.localeCompare(b.dir));
  const reasons = new Map<string, string>();
  for (const file of changedFiles) {
    const owner = packages.find(entry => file.startsWith(`${entry.dir}/`));
    if (owner) reasons.set(owner.name, 'changed');
  }
  for (let grown = true; grown;) {
    grown = false;
    for (const entry of packages) {
      const used = entry.uses.find(name => reasons.has(name) && name !== entry.name);
      if (used && !reasons.has(entry.name)) { reasons.set(entry.name, `depends on ${used}`); grown = true; }
    }
  }
  return { packages: [...reasons.keys()], summary: reasons.size ? [...reasons].map(([name, why]) => `${name} (${why})`).join(', ') : 'none (no workspace package changed)' };
}

const turboFilters = (packages: readonly string[] | null) => packages === null ? [] : packages.length ? packages.map(name => `--filter=${name}`) : ['--filter=//'];

/**
 * The build: npm's root build script as today; in a pnpm workspace, the affected packages
 * (`affectedPackages`, null for all): turbo builds them (its dependsOn ^build builds their
 * dependencies first); without turbo, pnpm builds them and their dependencies in topological
 * order. Null when a pnpm workspace change affects no package: nothing to build.
 */
export function buildArgv(manager: PackageManager, packages: readonly string[] | null): string[] | null {
  if (manager.name === 'npm') return ['npm', 'run', 'build'];
  if (!manager.workspace) return pnpm(manager.version, 'run', 'build');
  if (manager.turbo) return pnpm(manager.version, 'exec', 'turbo', 'run', 'build', ...turboFilters(packages));
  if (packages?.length === 0) return null;
  return pnpm(manager.version, '--recursive', '--if-present', ...(packages ?? []).map(name => `--filter=${name}...`), 'run', 'build');
}

/** The test check: `npm test` as today, `pnpm test`, or turbo's tests of the affected packages. */
export function testArgv(manager: PackageManager, packages: readonly string[] | null): string[] {
  if (manager.name === 'npm') return ['npm', 'test'];
  if (!manager.turbo || !manager.workspace) return pnpm(manager.version, 'test');
  return pnpm(manager.version, 'exec', 'turbo', 'run', 'test', ...turboFilters(packages));
}
