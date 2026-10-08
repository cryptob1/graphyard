import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ScopeFile } from './model.js';
import { addsTestFile, timingBaselinePath } from './model/timing-companion.js';
import { classifyScope, inPlannedScope } from './regression-guard.js';

/**
 * GY-1494. A worker learns it changed a file outside plannedFiles only when complete or sync
 * refuses, after the work is done. The worker's Claude harness runs `graphyard scope-guard GY-N
 * EPOCH` before every Edit, Write, MultiEdit and NotebookEdit; this is its judgement. The target
 * is classified exactly as complete classifies the file the edit would leave behind
 * (regression-guard.ts classifyScope) against the item's plannedFiles read live from the control
 * plane, so an applied scope request lets the next edit through with no relaunch. Wherever the
 * outcome is uncertain — an unreadable item, base or payload, a write that may restore the base
 * version, the timing baseline a test change may imply — the edit is allowed: the hook never
 * denies what complete would accept, and complete stays the authority.
 */
export const scopeGuardTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;
export const scopeGuardMatcher = scopeGuardTools.join('|');
/** How long the guard waits for the item, and for the hook payload, before it allows the edit. */
export const scopeGuardReadMs = 5_000;
/** The hook command a worker's harness runs for its own item and epoch. */
export const scopeGuardCommand = (cliPath: string, key: string, epoch: number) => `node ${cliPath} scope-guard ${key} ${epoch}`;

export interface ScopeGuardTarget { tool: string; path: string; cwd: string | null; content: string | null }
/** The edit a PreToolUse payload names, or null when stdin is not one the guard recognises. */
export function scopeGuardTarget(payload: string): ScopeGuardTarget | null {
  let parsed: any;
  try { parsed = JSON.parse(payload); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !scopeGuardTools.includes(parsed.tool_name)) return null;
  const input = parsed.tool_input;
  const path = input?.file_path ?? input?.notebook_path;
  if (typeof path !== 'string' || !path) return null;
  return { tool: parsed.tool_name, path, cwd: typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : null,
    content: parsed.tool_name === 'Write' && typeof input.content === 'string' ? input.content : null };
}

export interface ScopeGuardItem { key: string; plannedFiles?: string[]; workspaces?: { path: string; epoch: number }[]; observation?: { files?: string[] } | null }
export interface ScopeGuardReads {
  /** The item as the control plane holds it now. */
  item(): Promise<ScopeGuardItem>;
  /** The worktree when the item records none for this epoch (the Git toplevel of the session's directory). */
  toplevel(cwd: string): Promise<string | null>;
  /** The base branch tip's content at a repository-relative path: null when it holds no file there, undefined when it cannot be read. */
  base(root: string, path: string): Promise<string | null | undefined>;
  /** The repository's generated files. */
  generated(root: string): Promise<readonly string[]>;
}
export interface ScopeGuardInput { key: string; epoch: number; cliPath: string; payload: string; cwd: string; timeoutMs?: number }
export interface ScopeGuardResult { decision: 'allow' | 'deny'; exitCode: 0 | 2; message: string | null }

const allow = (message: string | null): ScopeGuardResult => ({ decision: 'allow', exitCode: 0, message });
const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
/** A path relative to root, or null when it lies outside it; symlinked spellings of the root count as inside. */
function insideRoot(root: string, path: string) {
  for (const base of new Set([resolve(root), real(root)])) {
    for (const target of new Set([resolve(path), real(path)])) {
      const rel = relative(base, target);
      if (rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) return rel.split(sep).join('/');
    }
  }
  return null;
}
function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} seconds`)), ms); timer.unref?.(); })])
    .finally(() => clearTimeout(timer));
}

/** The file complete would see after this edit, as the regression guard records it. */
export function prospectiveScopeFile(path: string, base: string | null, content: string | null, companion: boolean): ScopeFile {
  if (base === null) return { path, status: 'added', sha: 'edit', baseSha: null, additions: 1, deletions: 0, binary: false };
  // A Write of exactly the base content leaves the file identical to the base tip.
  const restores = content !== null && content === base;
  return { path, status: 'modified', sha: restores ? 'base' : 'edit', baseSha: 'base', additions: 1, deletions: 0, binary: false,
    ...(companion ? { companion: { allowed: true, detail: 'may be the implied companion of this change\'s test files; complete judges its lines' } } : {}) };
}

export async function scopeGuard(input: ScopeGuardInput, reads: ScopeGuardReads): Promise<ScopeGuardResult> {
  const target = scopeGuardTarget(input.payload);
  if (!target) return allow(`Graphyard scope-guard allowed the edit: stdin is not a ${scopeGuardTools.join('/')} PreToolUse hook payload.`);
  const timeoutMs = input.timeoutMs ?? scopeGuardReadMs;
  let item: ScopeGuardItem;
  try { item = await bounded(reads.item(), timeoutMs, `The control plane's record of ${input.key}`); }
  catch (error) { return allow(`Graphyard scope-guard allowed the edit: ${input.key} could not be read (${error instanceof Error ? error.message : String(error)}); complete still checks the planned files.`); }
  const cwd = target.cwd ?? input.cwd;
  try {
    const root = item.workspaces?.filter(workspace => workspace.epoch === input.epoch).at(-1)?.path ?? await bounded(reads.toplevel(cwd), timeoutMs, 'git rev-parse');
    if (!root) return allow(`Graphyard scope-guard allowed the edit: no worktree is recorded for ${input.key} epoch ${input.epoch}.`);
    const path = insideRoot(root, resolve(cwd, target.path));
    if (path === null) return allow(null);
    const planned = item.plannedFiles ?? [];
    if (inPlannedScope(planned, path)) return allow(null);
    const base = await bounded(reads.base(root, path), timeoutMs, 'The base branch tip');
    if (base === undefined) return allow(`Graphyard scope-guard allowed the edit of ${path}: the base branch tip could not be read; complete still checks the planned files.`);
    const generated = base === null ? [] : await bounded(reads.generated(root), timeoutMs, 'The generated-files manifest').catch(() => null);
    if (generated === null) return allow(`Graphyard scope-guard allowed the edit of ${path}: the repository's generated files could not be read; complete still checks the planned files.`);
    const companion = path === timingBaselinePath && addsTestFile(item);
    const [finding] = classifyScope(planned, [prospectiveScopeFile(path, base, target.content, companion)], generated);
    if (!finding.refused) return allow(null);
    return { decision: 'deny', exitCode: 2, message: scopeGuardDenial({ key: input.key, epoch: input.epoch, cliPath: input.cliPath, path }) };
  } catch (error) {
    return allow(`Graphyard scope-guard allowed the edit: ${error instanceof Error ? error.message : String(error)}; complete still checks the planned files.`);
  }
}

/** The one message a denial prints: the path, the item, the exact scope request, and why. */
export function scopeGuardDenial(input: { key: string; epoch: number; cliPath: string; path: string }) {
  return `Graphyard denied this edit: ${input.path} is outside ${input.key}'s plannedFiles, and complete refuses unplanned changes to a file the base branch holds. `
    + `If the change needs it, ask for it and wait for the outcome: node ${input.cliPath} scope-request ${input.key} ${input.epoch} ${input.path} --wait -- REASON. `
    + 'Once the request is applied, edit the file again; nothing needs relaunching.';
}
