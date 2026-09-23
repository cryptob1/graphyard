import { spawnSync, execFileSync } from 'node:child_process';
import { access, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mechanicalProof } from '../model/dispatch.js';
import type { CliCommand } from './registry.js';

/**
 * `graphyard verify GY-N`: the worker's own mechanical check before `complete` (GY-115).
 *
 * It runs exactly the unit and integration proofs the item's criteria name, against the working
 * tree as it stands, and names every other proof — manual, e2e, or deferred by a bootstrap
 * criterion — as outstanding rather than pretending to settle it. A proof is the set of test cases
 * whose title begins with its name, which is how producers find it too. With `--baseline` each
 * proof is run a second time on the base tree: a proof that passes there as well exercises
 * nothing, and the control plane records such evidence as unexercised rather than passing.
 *
 * The record is written to `.graphyard/verify/GY-N.json` in the worktree and bound to HEAD, so
 * `complete` can report what was run on the head it submits. It is the worker's own reading and
 * is never evidence: trusted evidence still comes only from an independent producer.
 */
export interface ProofRun {
  proof: string; criteria: string[]; result: 'pass' | 'fail'; executed: number; failed: number; skipped: number; files: string[];
  baseline?: { sha: string; result: 'pass' | 'fail'; executed: number; skipped: number };
  unexercised?: boolean;
}
export interface Outstanding { proof: string; criteria: string[]; reason: string }
export interface VerifyRecord { key: string; head: string; clean: boolean; at: string; ran: ProofRun[]; outstanding: Outstanding[] }
export interface VerifyOptions {
  /** The commit whose tree stands for "before the implementation"; null runs no baseline. */
  baseline?: string | null;
  now?: () => Date;
}
type Criterion = { id: string; proofs: string[]; bootstrap?: unknown };

const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A case belongs to a proof when its title starts with the proof name followed by a space or nothing. */
export const proofTitle = (proof: string) => new RegExp(`^${escape(proof)}(\\s|$)`);
export const recordPath = (root: string, key: string) => join(root, '.graphyard', 'verify', `${key}.json`);

/** Which of the item's proofs a worker can run here, and why each of the rest is outstanding. */
export function classifyProofs(criteria: Criterion[]): { runnable: { proof: string; criteria: string[] }[]; outstanding: Outstanding[] } {
  const runnable = new Map<string, string[]>(), outstanding = new Map<string, Outstanding>();
  for (const criterion of criteria) for (const proof of criterion.proofs) {
    if (criterion.bootstrap) {
      const entry = outstanding.get(proof) ?? { proof, criteria: [], reason: 'deferred by a bootstrap criterion onto the next change to its contract' };
      entry.criteria.push(criterion.id); outstanding.set(proof, entry);
    } else if (mechanicalProof(proof)) runnable.set(proof, [...(runnable.get(proof) ?? []), criterion.id]);
    else {
      const family = proof.slice(0, proof.indexOf(':'));
      const entry = outstanding.get(proof) ?? { proof, criteria: [], reason: family === 'manual' ? 'a manual proof is judged by an independent producer, not run here' : `${family}:* proofs are not run against a working tree` };
      entry.criteria.push(criterion.id); outstanding.set(proof, entry);
    }
  }
  for (const proof of runnable.keys()) outstanding.delete(proof);
  return { runnable: [...runnable].map(([proof, ids]) => ({ proof, criteria: ids })), outstanding: [...outstanding.values()] };
}

/** Every test file in the tree — tracked or new — whose source names the proof. */
async function proofFiles(root: string, proof: string) {
  const files = git(root, ['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(file => /\.test\.(ts|mts|js|mjs|cjs)$/.test(file));
  const named: string[] = [];
  for (const file of files) { try { if ((await readFile(join(root, file), 'utf8')).includes(proof)) named.push(file); } catch { /* deleted in the working tree */ } }
  return named;
}

/**
 * The project's own tests run with the credentials of this session withheld: every GRAPHYARD_* and
 * HERDR_* variable is dropped except the test-port choices a worker sets to avoid collisions. So is
 * NODE_TEST_CONTEXT, which a surrounding test runner sets and which turns the child's TAP stream off.
 */
const testEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT' && (!/^(GRAPHYARD|HERDR)_/.test(name) || /^GRAPHYARD_(\w+_)?TEST_PORT$/.test(name))));

/** Run one proof's cases in `root` and count what the TAP stream says about them. */
export async function runProof(root: string, proof: string, files?: string[]): Promise<Pick<ProofRun, 'result' | 'executed' | 'failed' | 'skipped' | 'files'>> {
  const selected = files ?? await proofFiles(root, proof);
  if (!selected.length) return { result: 'fail', executed: 0, failed: 0, skipped: 0, files: [] };
  const run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', '--test-name-pattern', proofTitle(proof).source, ...selected],
    { cwd: root, encoding: 'utf8', env: testEnvironment(), maxBuffer: 64 * 1024 * 1024 });
  const title = proofTitle(proof);
  let executed = 0, failed = 0, skipped = 0;
  for (const line of (run.stdout ?? '').split('\n')) {
    const match = line.match(/^(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/);
    if (!match || !title.test(match[2])) continue;
    if (match[3]) skipped++; else { executed++; if (match[1] === 'not ok') failed++; }
  }
  return { result: run.status === 0 && executed > 0 && failed === 0 && skipped === 0 ? 'pass' : 'fail', executed, failed, skipped, files: selected };
}

/** A detached checkout of `sha` beside the worktree, sharing its installed dependencies. */
async function withBaseTree<T>(root: string, sha: string, body: (tree: string) => Promise<T>): Promise<T> {
  const tree = join(root, '.graphyard', 'verify', `base-${sha.slice(0, 12)}`);
  git(root, ['worktree', 'add', '--force', '--detach', tree, sha]);
  try {
    try { await access(join(tree, 'node_modules')); } catch {
      try { await symlink(await realpath(join(root, 'node_modules')), join(tree, 'node_modules'), 'dir'); } catch { /* a tree without dependencies runs what it can */ }
    }
    return await body(tree);
  } finally { try { git(root, ['worktree', 'remove', '--force', tree]); } catch { /* already gone */ } }
}

export async function verifyWorkingTree(work: { key: string; criteria: Criterion[] }, root: string, options: VerifyOptions = {}): Promise<VerifyRecord> {
  const { runnable, outstanding } = classifyProofs(work.criteria);
  const head = git(root, ['rev-parse', 'HEAD']);
  const clean = git(root, ['status', '--porcelain']) === '';
  const ran: ProofRun[] = [];
  for (const entry of runnable) ran.push({ proof: entry.proof, criteria: entry.criteria, ...await runProof(root, entry.proof) });
  if (options.baseline) {
    const sha = git(root, ['rev-parse', `${options.baseline}^{commit}`]);
    await withBaseTree(root, sha, async tree => {
      for (const entry of ran) {
        const base = await runProof(tree, entry.proof);
        entry.baseline = { sha, result: base.result, executed: base.executed, skipped: base.skipped };
        // Passing on the tree before the implementation means the proof checks nothing the change did.
        entry.unexercised = entry.result === 'pass' && base.result === 'pass';
      }
    });
  }
  const record: VerifyRecord = { key: work.key, head, clean, at: (options.now ?? (() => new Date()))().toISOString(), ran, outstanding };
  await mkdir(join(root, '.graphyard', 'verify'), { recursive: true });
  await writeFile(recordPath(root, work.key), JSON.stringify(record, null, 2));
  return record;
}

/** What `complete` reports: the worker's own verification of the head it submits, or why there is none. */
export async function selfVerification(root: string, key: string) {
  let record: VerifyRecord;
  try { record = JSON.parse(await readFile(recordPath(root, key), 'utf8')); } catch {
    return { state: 'not-run' as const, reason: `graphyard verify ${key} was not run in this worktree; no proof was checked before submission`, ran: [], outstanding: [] };
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  const summary = { ran: record.ran.map(({ proof, criteria, result, executed, failed, skipped, unexercised }) => ({ proof, criteria, result, executed, failed, skipped, ...(unexercised ? { unexercised } : {}) })),
    outstanding: record.outstanding.map(({ proof, reason }) => ({ proof, reason })), verifiedAt: record.at };
  if (record.head !== head) return { state: 'stale' as const, reason: `verified ${record.head.slice(0, 12)}, not HEAD ${head.slice(0, 12)}; run graphyard verify ${key} again`, ...summary };
  const failing = record.ran.filter(entry => entry.result !== 'pass' || entry.unexercised);
  return { state: failing.length ? 'failing' as const : 'passing' as const,
    reason: failing.length ? `${failing.map(entry => entry.proof).join(', ')} did not pass on HEAD; the control plane will return this head before review` : `every mechanical proof passed on HEAD${record.clean ? '' : ' (with uncommitted changes present when it ran)'}`, ...summary };
}

export const verifyCommand: CliCommand = {
  name: 'verify',
  scope: 'work',
  help: [
    '  verify GY-N [--baseline [REF]] Run exactly the unit and integration proofs the item\'s',
    '                                criteria name against this working tree, name the rest as',
    '                                outstanding, and record the result for complete; --baseline',
    '                                also runs them on REF (default the merge base with origin/main)',
  ],
  run: async (context, work) => {
    const root = context.repositoryRoot();
    const flag = context.args.indexOf('--baseline');
    const explicit = flag >= 0 && context.args[flag + 1] && !context.args[flag + 1].startsWith('--') ? context.args[flag + 1] : null;
    const baseline = flag < 0 ? null : explicit ?? git(root, ['merge-base', 'HEAD', 'origin/main']);
    const record = await verifyWorkingTree(work, root, { baseline });
    context.print(record);
    if (record.ran.some(entry => entry.result !== 'pass' || entry.unexercised)) process.exitCode = 1;
  },
};
