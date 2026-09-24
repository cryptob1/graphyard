import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mechanicalProof } from '../model/dispatch.js';
import type { CliCommand } from './registry.js';
import { isolatedTestEnvironment, reserveTestPorts, testPortEnvironment, type ReserveOptions } from './test-isolation.js';

/**
 * `graphyard verify GY-N`: the worker's own mechanical check before `complete` (GY-115).
 *
 * It runs exactly the unit and integration proofs the item's criteria name, against the working
 * tree as it stands, and names every other proof — manual, e2e, or deferred by a bootstrap
 * criterion — as outstanding rather than pretending to settle it. A proof is the set of test cases
 * whose title begins with its name, which is how producers find it too.
 *
 * The record is written to `.graphyard/verify/GY-N.json` in the worktree and bound to HEAD, so
 * `complete` can report what was run on the head it submits. It is the worker's own reading and is
 * never evidence: trusted evidence still comes only from an independent producer, and the control
 * plane requests no review until that evidence has passed on the head.
 */
export interface ProofRun { proof: string; criteria: string[]; result: 'pass' | 'fail'; executed: number; failed: number; skipped: number; files: string[] }
export interface Outstanding { proof: string; criteria: string[]; reason: string }
export interface VerifyRecord { key: string; head: string; clean: boolean; at: string; ran: ProofRun[]; outstanding: Outstanding[] }
type Criterion = { id: string; proofs: string[]; bootstrap?: unknown };

const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A case belongs to a proof when its title is the proof name, or starts with it followed by a space. */
export const proofTitle = (proof: string) => new RegExp(`^${escape(proof)}(\\s|$)`);
export const recordPath = (root: string, key: string) => join(root, '.graphyard', 'verify', `${key}.json`);

/** Which of the item's proofs a worker can run here, and why each of the rest is outstanding. */
export function classifyProofs(criteria: Criterion[]): { runnable: { proof: string; criteria: string[] }[]; outstanding: Outstanding[] } {
  const runnable = new Map<string, string[]>(), outstanding = new Map<string, Outstanding>();
  const owe = (proof: string, criterion: string, reason: string) => {
    const entry = outstanding.get(proof) ?? { proof, criteria: [], reason };
    entry.criteria.push(criterion); outstanding.set(proof, entry);
  };
  for (const criterion of criteria) for (const proof of criterion.proofs) {
    if (criterion.bootstrap) owe(proof, criterion.id, 'deferred by a bootstrap criterion onto the next change to its contract');
    else if (mechanicalProof(proof)) runnable.set(proof, [...(runnable.get(proof) ?? []), criterion.id]);
    else {
      const family = proof.slice(0, proof.indexOf(':'));
      owe(proof, criterion.id, family === 'manual' ? 'a manual proof is judged by an independent producer, not run here' : `${family}:* proofs are not run against a working tree`);
    }
  }
  // A proof one criterion defers and another requires outright is still run.
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
 * Run one proof's cases in `root` and count what the TAP stream says about them. The proof's test
 * files run whole, and its cases are the ones whose title begins with the proof name: narrowing the
 * run with --test-name-pattern would report every other case of the file as skipped, which a
 * producer then has to explain away. The run gets the suite's isolation (test-isolation.ts): this
 * session's credentials withheld and a window of free ports held for it alone.
 */
export async function runProof(root: string, proof: string, files: string[], ports: ReserveOptions = {}): Promise<Pick<ProofRun, 'result' | 'executed' | 'failed' | 'skipped' | 'files'>> {
  if (!files.length) return { result: 'fail', executed: 0, failed: 0, skipped: 0, files };
  const reservation = await reserveTestPorts(ports);
  let run: ReturnType<typeof spawnSync>;
  try {
    run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', ...files],
      { cwd: root, encoding: 'utf8', env: isolatedTestEnvironment(process.env, testPortEnvironment(reservation.base)), maxBuffer: 64 * 1024 * 1024 });
  } finally { reservation.release(); }
  const { executed, failed, skipped } = countProofCases(String(run.stdout ?? ''), proof);
  // The file's other cases are the ordinary suite's business: only the proof's own decide its result.
  return { result: executed > 0 && failed === 0 && skipped === 0 ? 'pass' : 'fail', executed, failed, skipped, files };
}

/** The proof's cases in a TAP stream, attributed by title prefix. */
export function countProofCases(tap: string, proof: string) {
  const title = proofTitle(proof);
  let executed = 0, failed = 0, skipped = 0;
  for (const line of tap.split('\n')) {
    const match = line.match(/^\s*(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/);
    if (!match || !title.test(match[2])) continue;
    if (match[3]) skipped++; else { executed++; if (match[1] === 'not ok') failed++; }
  }
  return { executed, failed, skipped };
}

export async function verifyWorkingTree(work: { key: string; criteria: Criterion[] }, root: string, now = () => new Date()): Promise<VerifyRecord> {
  const { runnable, outstanding } = classifyProofs(work.criteria);
  const head = git(root, ['rev-parse', 'HEAD']);
  const clean = git(root, ['status', '--porcelain']) === '';
  const ran: ProofRun[] = [];
  for (const entry of runnable) ran.push({ proof: entry.proof, criteria: entry.criteria, ...await runProof(root, entry.proof, await proofFiles(root, entry.proof)) });
  const record: VerifyRecord = { key: work.key, head, clean, at: now().toISOString(), ran, outstanding };
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
  const summary = { ran: record.ran.map(({ proof, criteria, result, executed, failed, skipped }) => ({ proof, criteria, result, executed, failed, skipped })),
    outstanding: record.outstanding.map(({ proof, criteria, reason }) => ({ proof, criteria, reason })), verifiedAt: record.at };
  if (record.head !== head) return { state: 'stale' as const, reason: `verified ${record.head.slice(0, 12)}, not HEAD ${head.slice(0, 12)}; run graphyard verify ${key} again`, ...summary };
  const failing = record.ran.filter(entry => entry.result !== 'pass');
  return { state: failing.length ? 'failing' as const : 'passing' as const,
    reason: failing.length ? `${failing.map(entry => entry.proof).join(', ')} did not pass on HEAD; the control plane returns this head to its worker before review`
      : `every mechanical proof passed on HEAD${record.clean ? '' : ' (with uncommitted changes present when it ran)'}`, ...summary };
}

export const verifyCommand: CliCommand = {
  name: 'verify',
  scope: 'work',
  help: [
    '  verify GY-N                  Run exactly the unit and integration proofs the item\'s',
    '                                criteria name against this working tree, name the rest as',
    '                                outstanding, and record the result complete reports',
  ],
  run: async (context, work) => {
    const record = await verifyWorkingTree(work, context.repositoryRoot());
    context.print(record);
    if (record.ran.some(entry => entry.result !== 'pass')) process.exitCode = 1;
  },
};
