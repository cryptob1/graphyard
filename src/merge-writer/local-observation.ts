// Concern: the merge writer's local observation (GY-1523) — a submitted head read from the coordinator's own object store, never from GitHub.
import { execFile } from 'node:child_process';
import { demand, type Observation } from '../model.js';
import type {} from '../model/gates.js'; // Observation.source
import { parseLocalScopeDiff } from '../sync.js';
import { contractFile, movedBindings } from '../e2e/case.js';

/** What one git invocation returned; a non-zero exit is an answer here, never a throw. */
export interface GitResult { status: number | null; stdout: string; stderr: string }
/** Runs `git` with `args` in the checkout whose object store holds the submitted heads; `timeoutMs` kills a run that outlasts it. */
export type GitRunner = (args: readonly string[], options?: { timeoutMs?: number }) => Promise<GitResult>;

/** The default runner: `git -C root`, the coordinator checkout the control plane serves from. */
export function gitRunnerFor(root: string): GitRunner {
  return (args, options = {}) => new Promise(resolve => {
    execFile('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: options.timeoutMs ?? 0, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const status = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0;
      const killed = error && (error as { killed?: boolean }).killed && options.timeoutMs ? `git ${args[0]} was stopped after ${options.timeoutMs}ms` : '';
      resolve({ status, stdout: String(stdout ?? ''), stderr: [String(stderr ?? '').trim(), killed].filter(Boolean).join('\n') });
    });
  });
}

export interface HeadObservationInput {
  /** The 40-hex commit the worker submitted. */
  head: string;
  /** The base branch's name; its tip is read from `refs/remotes/origin/BASE` in the shared checkout. */
  base: string;
  /** The assigned workspace branch, named when the head is absent, and recorded on the candidate. */
  branch: string;
  /** The submitting worker, recorded as the candidate's author. */
  author: string;
  at?: Date;
}

/** The refusal for a head the shared object store does not hold, naming the ref the worker's branch should hold. */
export const absentHeadRefusal = (head: string, branch: string) =>
  `Commit ${head.slice(0, 12)} is not in the control plane's object store: refs/heads/${branch} should hold it. Commit on the assigned branch and complete again with the head that branch holds; nothing is pushed in control-plane mode`;

/**
 * The control plane's own observation of a submitted head (GY-1523), built from the shared Git
 * object store where GitHub's reading of a pull request would be. The diff is the head's own
 * merge delta — from its merge base with the base tip, each file's base blob read at the tip —
 * so a tip that moved past the head's base names none of the files the base gained (GY-2082):
 * classifying those made a normal head read sensitive and owe a reviewer and a rework round it
 * did not owe. The parser is the sync's; the head's ancestry of that tip stands where GitHub's
 * `behind`/`dirty` reading stood. The constants say what the writer has not done: nothing is
 * protected, checked, reviewed or merged, and the head is held mergeable until the merge
 * writer's trial says otherwise (gates read the merge ledger for that). `candidate.pr` is 0
 * until the submit transaction allocates the change number.
 */
export async function observeHead(git: GitRunner, input: HeadObservationInput): Promise<Observation> {
  const { head, base, branch, author } = input;
  const commit = await git(['rev-parse', '--verify', '--quiet', `${head}^{commit}`]);
  demand(commit.status === 0 && commit.stdout.trim() === head, absentHeadRefusal(head, branch), 422);
  const baseRef = `refs/remotes/origin/${base}`;
  let tip = await git(['rev-parse', '--verify', '--quiet', baseRef]);
  if (tip.status !== 0 || !/^[0-9a-f]{40}$/.test(tip.stdout.trim())) {
    tip = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]);
  }
  // The checkout's own HEAD is never a stand-in: it may be any branch, so the scope and ancestry read against it would be false.
  demand(tip.status === 0 && /^[0-9a-f]{40}$/.test(tip.stdout.trim()), `The control plane's checkout holds no ${baseRef} or refs/heads/${base} to observe ${head.slice(0, 12)} against`, 503);
  const baseTip = tip.stdout.trim();
  const baseTipContained = (await git(['merge-base', '--is-ancestor', baseTip, head])).status === 0;
  // The candidate's delta is what merging it adds onto the base tip: the diff from its merge base
  // with the tip, never the two-dot diff from the tip itself. A tip that moved past the head's
  // base carries files the base gained, and a two-dot diff names them as the head's own — the
  // risk class then read another change's installation paths and owed queued heads a reviewer and
  // a rework round they did not owe (GY-2082). Unrelated histories have no merge base; the tip
  // stands in for it, as the two-dot diff stood before.
  const ancestor = await git(['merge-base', baseTip, head]);
  const mergeBase = /^[0-9a-f]{40}$/.test(ancestor.stdout.trim()) ? ancestor.stdout.trim() : baseTip;
  const raw = await git(['diff', '--raw', '-M', '-z', '--no-abbrev', mergeBase, head]);
  const numstat = await git(['diff', '--numstat', '-M', '-z', mergeBase, head]);
  demand(raw.status === 0 && numstat.status === 0, `The control plane could not diff ${head.slice(0, 12)} against ${baseRef}: ${(raw.stderr || numstat.stderr).trim()}`, 503);
  const scopeFiles = parseLocalScopeDiff(raw.stdout, numstat.stdout);
  // The diff's old side is the merge base; the base blobs the scope judgement reads are the base
  // tip's, as a provider observation compares with the bound base: a file the head deleted that
  // the base deleted too stays already-absent rather than deleted.
  if (mergeBase !== baseTip && scopeFiles.length) {
    const ends = [...new Set(scopeFiles.flatMap(file => file.previousPath && file.previousPath !== file.path ? [file.previousPath, file.path] : [file.path]))];
    const tree = await git(['ls-tree', '-z', '-r', baseTip, '--', ...ends]);
    demand(tree.status === 0, `The control plane could not read ${baseRef}'s blobs for ${head.slice(0, 12)}'s delta: ${tree.stderr.trim()}`, 503);
    const blobs = new Map(tree.stdout.split('\0').filter(Boolean).flatMap(entry => {
      const match = entry.match(/^[0-7]{6} \w+ ([0-9a-f]{40})\t(.*)$/s);
      return match ? [[match[2], match[1]] as const] : [];
    }));
    for (const file of scopeFiles) {
      file.baseSha = blobs.get(file.path) ?? null;
      if (file.previousPath) file.previousBaseSha = blobs.get(file.previousPath) ?? null;
    }
  }
  // The contract's contents, so a protected binding is judged by whether it moved, not by the file changing (GY-2602).
  const contract = async (sha: string) => { const shown = await git(['show', `${sha}:${contractFile}`]); return shown.status === 0 ? shown.stdout : null; };
  const contractMoved = scopeFiles.some(file => file.path === contractFile || file.previousPath === contractFile) ? movedBindings(await contract(baseTip), await contract(head)) : undefined;
  return {
    source: 'control-plane', ...(contractMoved !== undefined ? { contractMoved } : {}),
    candidate: { sha: head, baseSha: baseTip, pr: 0, branch, author },
    files: scopeFiles.map(file => file.path), scopeFiles, baseTip, baseTipContained,
    protected: false, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true,
    at: (input.at ?? new Date()).toISOString(),
  };
}
