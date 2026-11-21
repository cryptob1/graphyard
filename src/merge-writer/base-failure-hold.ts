// Concern: GY-3140, GY-3451 — while a base failure stands on main, the merge writer trials only hotfixes and base repairs (GY-3563).
import type { MergeLedgerState } from '../model/merge-ledger.js';
import { parseBaseFailureReason } from './executor.js';

type Git = (args: string[]) => Promise<string>;
const codeExtension = /\.(?:[cm]?[jt]sx?)$/;

/**
 * GY-3451: the base failure that still stands on main's `tip`, with its failing test files and their scope: one the
 * ledger records on `tip` itself, or on an earlier tip when nothing main changed since touches the failing tests or
 * the files they select — a change that misses them cannot have turned main green. Null once one does.
 */
export async function standingBaseFailure(git: Git, ledger: Readonly<Record<string, MergeLedgerState>>, tip: string): Promise<{ reason: string; files: string[]; scope: Set<string> } | null> {
  const seen = new Set<string>();
  for (const state of Object.values(ledger)) {
    const reason = state.state === 'refused' ? state.refusal?.reason ?? '' : '';
    const parsed = parseBaseFailureReason(reason);
    if (!parsed || seen.has(`${parsed.tip}:${parsed.files.join(',')}`)) continue;
    seen.add(`${parsed.tip}:${parsed.files.join(',')}`);
    try {
      const scope = await scopeOf(git, parsed.tip, parsed.files);
      if (parsed.tip === tip.toLowerCase()) return { reason, files: parsed.files, scope };
      const since = (await git(['diff', '--name-only', parsed.tip, tip])).split('\n').map(line => line.trim()).filter(Boolean);
      if (!since.some(file => scope.has(file))) return { reason, files: parsed.files, scope };
    } catch { continue; } // a tip the checkout no longer holds stands for nothing
  }
  return null;
}

/**
 * The failing tests at `tip` and every file they select, as the trial's selection maps it
 * (scripts/ci-tests.mjs `fileEdges`, imports and data reads followed transitively): a change to none of them cannot
 * repair the failure. Without that script only the test files themselves count.
 */
export async function baseFailureScope(git: Git, tip: string, tests: readonly string[]): Promise<Set<string>> {
  const tracked = (await git(['ls-tree', '-r', '--name-only', tip])).split('\n').map(line => line.trim()).filter(Boolean);
  const files = new Set(tracked), directories = new Map<string, string[]>();
  for (const file of tracked) {
    const parts = file.split('/');
    for (let at = 1; at < parts.length; at++) { const directory = parts.slice(0, at).join('/'); directories.set(directory, [...(directories.get(directory) ?? []), file]); }
  }
  const seen = new Set(tests.filter(test => files.has(test))), queue = [...seen];
  // The selection script lives outside src (as units.ts names scripts/graphyard-executor.mjs), so it is loaded by its URL.
  const edges = await import(new URL('../../scripts/ci-tests.mjs', import.meta.url).href).then((module: typeof import('../../scripts/ci-tests.mjs')) => module.fileEdges, () => null);
  if (!edges) return seen;
  while (queue.length) {
    const file = queue.pop()!;
    if (!codeExtension.test(file)) continue;
    const { imports, data } = edges(file, await git(['show', `${tip}:${file}`]), files, directories);
    for (const next of [...imports, ...data]) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return seen;
}

const scopes = new Map<string, Set<string>>();
async function scopeOf(git: Git, tip: string, files: string[]) {
  const key = `${tip}:${files.join(',')}`;
  if (!scopes.has(key)) { if (scopes.size >= 8) scopes.clear(); scopes.set(key, await baseFailureScope(git, tip, files)); }
  return scopes.get(key)!;
}
