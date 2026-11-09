// GY-3200: which package manager a checkout uses, read from its lockfile, and the command lines
// the merge trial, worktree setup, worker verification and the serve pass run through it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * The build: npm's root build script as today; in a pnpm workspace with turbo, turbo builds the
 * packages the change affects (its dependsOn ^build builds their dependencies first); without
 * turbo, pnpm builds the changed packages, their dependents and those packages' dependencies in
 * topological order. A root-trigger change builds everything.
 */
export function buildArgv(manager: PackageManager, changedFiles: readonly string[], base: string): string[] {
  if (manager.name === 'npm') return ['npm', 'run', 'build'];
  if (!manager.workspace) return pnpm(manager.version, 'run', 'build');
  const all = changedFiles.some(rootTrigger);
  if (manager.turbo) return pnpm(manager.version, 'exec', 'turbo', 'run', 'build', ...(all ? [] : [`--filter=...[${base}]`]));
  return pnpm(manager.version, '--recursive', '--if-present', ...(all ? [] : [`--filter=...[${base}]...`]), 'run', 'build');
}

/** The test check: `npm test` as today, `pnpm test`, or turbo's affected tests under the same root-trigger rule. */
export function testArgv(manager: PackageManager, changedFiles: readonly string[], base: string): string[] {
  if (manager.name === 'npm') return ['npm', 'test'];
  if (!manager.turbo || !manager.workspace) return pnpm(manager.version, 'test');
  return pnpm(manager.version, 'exec', 'turbo', 'run', 'test', ...(changedFiles.some(rootTrigger) ? [] : [`--filter=...[${base}]`]));
}
