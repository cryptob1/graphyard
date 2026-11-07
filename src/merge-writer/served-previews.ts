// Concern: the three preview cases the daily diagnostics prove (GY-3193). They need the loop's item
// previews, and two need Compose, which the trial withholds from the head's code (GY-2997), so they
// run on the host: the verified commit, the one the install serves, in its own e2e.serve scratch
// install with Docker and the item-preview step. Never the live install: a case creates feature
// items, which the live loop would dispatch to workers. A case that did not run is not covered.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateLimitMs } from '../batch-gate.js';
import { defaultChildRun } from '../child-runner.js';
import { declaredServe, runTrialE2eGroup, type TrialE2eCase } from './e2e-trial.js';
import { previewEnvironment } from './preview.js';

export const servedPreviewCases = ['preview-isolation-cleanup', 'preview-serves-change', 'previews-for-declared-apps'] as const;

/** One preview case's last daily run: `not covered` when it was left out, pending or could not run, naming why. */
export interface PreviewCaseRun { case: string; at: string; commit: string; verdict: 'passed' | 'failed' | 'not covered'; detail: string | null }

export const notCovered = (commit: string, at: string, detail: string): PreviewCaseRun[] =>
  servedPreviewCases.map(id => ({ case: id, at, commit, verdict: 'not covered', detail }));

/** Each preview case's run from what the group reported: only a case that executed has a verdict of its own. */
export function previewCaseRuns(cases: readonly TrialE2eCase[], commit: string, at: string): PreviewCaseRun[] {
  return servedPreviewCases.map(id => {
    const entry = cases.find(item => item.case === id), detail = entry?.failingStep ?? null;
    if (!entry || !entry.executed) return { case: id, at, commit, verdict: 'not covered', detail: detail ?? 'the run left it out' };
    return { case: id, at, commit, verdict: entry.failed ? 'failed' : 'passed', detail };
  });
}

/** The preview cases on `commit`, checked out from `root` and served by its own e2e.serve; never throws. */
export async function runServedPreviewCases(input: { root: string; commit: string; budgetMs?: number; hostEnvironment?: NodeJS.ProcessEnv; runGroup?: typeof runTrialE2eGroup }): Promise<PreviewCaseRun[]> {
  const at = () => new Date().toISOString(), proofs = servedPreviewCases.map(id => `e2e:${id}`);
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-preview-cases-')), worktree = join(directory, 'checkout');
  const git = (...args: string[]) => defaultChildRun('git', ['-C', input.root, ...args]);
  try {
    await git('worktree', 'add', '--detach', worktree, input.commit);
    if (existsSync(join(input.root, 'node_modules'))) await symlink(join(input.root, 'node_modules'), join(worktree, 'node_modules'));
    const { serve } = declaredServe(worktree);
    if (!serve) return notCovered(input.commit, at(), 'the commit declares no e2e.serve');
    const env = previewEnvironment(join(directory, 'home'), input.hostEnvironment);
    await mkdir(env.TMPDIR!, { recursive: true });
    // One serve per case: a failed required case stops its run, and each case's verdict is its own.
    const cases: TrialE2eCase[] = [];
    for (const proof of proofs) cases.push(...await (input.runGroup ?? runTrialE2eGroup)(serve, [proof], { worktree, mergeSha: input.commit, proofs: [proof], env, scratch: directory, budgetMs: input.budgetMs ?? gateLimitMs / proofs.length,
      holds: async path => existsSync(join(worktree, path)), log: line => console.log(`Preview cases: ${line}`) }));
    return previewCaseRuns(cases, input.commit, at());
  } catch (error) {
    return notCovered(input.commit, at(), error instanceof Error ? error.message : String(error));
  } finally {
    await git('worktree', 'remove', '--force', worktree).catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
