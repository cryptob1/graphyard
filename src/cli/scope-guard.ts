import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { configuredGeneratedFiles } from '../generated-files.js';
import { scopeGuard, scopeGuardReadMs, type ScopeGuardReads } from '../scope-guard.js';
import { parseGeneratedManifest } from '../sync.js';
import { cliPath, type CliContext } from './context.js';
import { defineCommands } from './registry.js';

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd, encoding: 'utf8', timeout: scopeGuardReadMs, maxBuffer: 64 * 1024 * 1024 })).stdout;

/** The hook payload on stdin, or '' when stdin is a terminal or says nothing within the bound. */
async function hookPayload() {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  const read = (async () => { for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); })();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([read, new Promise(done => { timer = setTimeout(done, scopeGuardReadMs); })]).finally(() => clearTimeout(timer));
  return Buffer.concat(chunks).toString('utf8');
}

/** The base branch tip the regression guard compares against: origin's default branch, as the worktree knows it. */
async function baseRef(root: string) {
  const symbolic = await git(root, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').then(text => text.trim()).catch(() => '');
  return symbolic || 'refs/remotes/origin/main';
}

export const hostScopeGuardReads = (context: CliContext, key: string): ScopeGuardReads => ({
  item: () => context.api(`work/${encodeURIComponent(key)}`),
  toplevel: async cwd => (await git(cwd, 'rev-parse', '--show-toplevel')).trim() || null,
  base: async (root, path) => {
    const ref = await baseRef(root);
    try { await git(root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`); } catch { return undefined; }
    const entry = (await git(root, 'ls-tree', ref, '--', path)).trim();
    if (!entry) return null;
    return git(root, 'cat-file', 'blob', `${ref}:${path}`);
  },
  generated: async root => {
    const declared = configuredGeneratedFiles();
    if (!existsSync(resolve(root, 'scripts/check-docs.mjs'))) return declared;
    const manifest = parseGeneratedManifest((await run(process.execPath, ['scripts/check-docs.mjs', '--manifest'], { cwd: root, encoding: 'utf8', timeout: scopeGuardReadMs })).stdout);
    return [...new Set([...declared, ...(manifest?.files ?? [])])];
  },
});

/**
 * `scope-guard GY-N EPOCH` (GY-1494): the worker's Claude PreToolUse hook. It reads the hook
 * payload on stdin and exits 2 with one message when the edit would change a file complete
 * refuses; anything it cannot judge is allowed with the reason on stderr. It is not a work-scoped
 * command, so an unreadable item is bounded by its own five seconds and allowed, never a failure.
 */
export const scopeGuardCommands = defineCommands([{
  name: 'scope-guard',
  help: [
    '  scope-guard GY-N EPOCH        Worker Claude PreToolUse hook (installed by dispatch): reads',
    '                                the hook payload on stdin and denies, exit 2, an edit that',
    '                                complete would refuse as outside plannedFiles, naming the',
    '                                scope-request command; allows whatever it cannot judge',
  ],
  async run(context) {
    const key = context.id ?? '', epoch = Number(context.args[0]);
    const payload = await hookPayload();
    if (!key || !Number.isInteger(epoch) || epoch < 1) { console.error('Graphyard scope-guard allowed the edit: use scope-guard GY-N EPOCH.'); process.exit(0); }
    const result = await scopeGuard({ key, epoch, cliPath, payload, cwd: process.cwd() }, hostScopeGuardReads(context, key));
    if (result.message) console.error(result.message);
    // A read abandoned at the bound would hold the process open; the hook answers now.
    process.exit(result.exitCode);
  },
}]);
