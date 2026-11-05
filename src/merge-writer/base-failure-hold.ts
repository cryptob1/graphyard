// Concern: GY-3140 — while a base failure stands on main's tip, the merge writer trials only a head that can repair it.
import type { MergeLedgerState } from '../model/merge-ledger.js';
import { parseBaseFailureReason } from './executor.js';

type Git = (args: string[]) => Promise<string>;
const codeExtension = /\.(?:[cm]?[jt]sx?)$/;

/** The base failure the ledger records on `tip`: its refusal reason and the failing test files it names, or null. */
export function standingBaseFailure(ledger: Readonly<Record<string, MergeLedgerState>>, tip: string): { reason: string; files: string[] } | null {
  for (const state of Object.values(ledger)) {
    const reason = state.state === 'refused' ? state.refusal?.reason ?? '' : '';
    const parsed = parseBaseFailureReason(reason);
    if (parsed && parsed.tip === tip.toLowerCase()) return { reason, files: parsed.files };
  }
  return null;
}

/**
 * The failing tests at `tip` and every file they select, as the trial's selection maps it
 * (scripts/ci-tests.mjs `fileEdges`, followed transitively): a change to none of them cannot
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
    for (const next of edges(file, await git(['show', `${tip}:${file}`]), files, directories)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return seen;
}

let cached: { key: string; scope: Set<string> } | null = null;
/**
 * The heads of `heads` a trial would be wasted on: while `failure` stands on `tip`, a head whose
 * own change (against its merge base with the tip) touches neither the failing tests nor any file
 * they select. A head that touches them is the possible repair and is trialled.
 */
export async function heldByBaseFailure(git: Git, tip: string, failure: { files: string[] }, heads: readonly { id: string; head: string }[]): Promise<Set<string>> {
  const key = `${tip}:${failure.files.join(',')}`;
  if (cached?.key !== key) cached = { key, scope: await baseFailureScope(git, tip, failure.files) };
  const scope = cached.scope, held = new Set<string>();
  for (const { id, head } of heads) {
    const changed = (await git(['diff', '--name-only', `${tip}...${head}`])).split('\n').map(line => line.trim()).filter(Boolean);
    if (!changed.some(file => scope.has(file))) held.add(id);
  }
  return held;
}
