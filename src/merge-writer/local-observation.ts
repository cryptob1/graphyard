// Concern: the merge writer's local observation (GY-1523) — a submitted head read from the coordinator's own object store, never from GitHub.
import { execFile } from 'node:child_process';
import { demand, type Observation } from '../model.js';
import type {} from '../model/gates.js'; // Observation.source
import { parseLocalScopeDiff } from '../sync.js';
import { observationClaim } from '../observation-priority.js';
import type { Engine } from '../engine.js';

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
 * object store where GitHub's reading of a pull request would be. The diff is taken directly against
 * the base tip, as `graphyard sync` takes it, with the parser the sync shares; the head's ancestry
 * of that tip stands where GitHub's `behind`/`dirty` reading stood. The constants say what the
 * writer has not done: nothing is protected, checked, reviewed or merged, and the head is held
 * mergeable until the merge writer's trial says otherwise (gates read the merge ledger for that).
 * `candidate.pr` is 0 until the submit transaction allocates the change number.
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
  if (tip.status !== 0 || !/^[0-9a-f]{40}$/.test(tip.stdout.trim())) {
    tip = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
  }
  demand(tip.status === 0 && /^[0-9a-f]{40}$/.test(tip.stdout.trim()), `The control plane's checkout holds no ${baseRef} to observe ${head.slice(0, 12)} against`, 503);
  const baseTip = tip.stdout.trim();
  const baseTipContained = (await git(['merge-base', '--is-ancestor', baseTip, head])).status === 0;
  const raw = await git(['diff', '--raw', '-M', '-z', '--no-abbrev', baseTip, head]);
  const numstat = await git(['diff', '--numstat', '-M', '-z', baseTip, head]);
  demand(raw.status === 0 && numstat.status === 0, `The control plane could not diff ${head.slice(0, 12)} against ${baseRef}: ${(raw.stderr || numstat.stderr).trim()}`, 503);
  const scopeFiles = parseLocalScopeDiff(raw.stdout, numstat.stdout);
  return {
    source: 'control-plane',
    candidate: { sha: head, baseSha: baseTip, pr: 0, branch, author },
    files: scopeFiles.map(file => file.path), scopeFiles, baseTip, baseTipContained,
    protected: false, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true,
    at: (input.at ?? new Date()).toISOString(),
  };
}

/**
 * The observation job of a control-plane install with no GitHub App (GY-1675): take one due job and
 * observe its candidate from the local checkout, as `processJob` does from GitHub; false when no job
 * was due or the observation failed. A job for an item with nothing submitted yet is deferred a
 * minute; one for a finished item, or with no candidate, is dropped.
 */
export async function processControlPlaneJob(engine: Engine): Promise<boolean> {
  const all = await engine.store.fleet();
  const plan = observationClaim(all, Date.now(), false);
  const job = await engine.store.takeJob(plan.order, plan.headCount);
  if (!job) return false;
  let work = all.find(w => w.id === job.work_id);
  if (!work?.submission || work.stage === 'done' || !work.candidate) {
    if (work && !work.submission && work.stage !== 'done') {
      await engine.store.deferJob(job.work_id, job.token, new Date(Date.now() + 60_000).toISOString(), 'no submission to observe', null);
    } else {
      await engine.store.pool.query('DELETE FROM jobs WHERE work_id=$1 AND token=$2', [job.work_id, job.token]);
    }
    return true;
  }
  let observed = false;
  try {
    const observation = await engine.observeControlPlaneCandidate(work);
    if (observation) {
      work = await engine.observe(work.id, work.revision, observation, job.token);
      observed = true;
    }
    await engine.store.finishJob(job.work_id, job.token, undefined, false, 20_000, observed);
    return true;
  } catch (error: any) {
    await engine.store.finishJob(job.work_id, job.token, error instanceof Error ? error.message : String(error), false, 10_000, observed);
    return false;
  }
}
