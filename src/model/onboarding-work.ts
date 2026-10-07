/**
 * The onboarding pull request as a work item the loop owns (GY-1478). `graphyard up` publishes the
 * files `init --scan --apply` wrote on `graphyard/onboarding` and files that pull request as a work
 * item, so the loop's reviewer reviews it, the repository's checks run and the control plane merges
 * it under the normal gates; no person merges it by hand. While it is open, `up` and the dashboard's
 * Setup page show it as the current setup step from the same reading (onboardingWait). Browser-safe:
 * the Setup page imports it.
 */

/** The branch `graphyard up` publishes the onboarding files on, and the workspace its work item registers. */
export const onboardingBranch = 'graphyard/onboarding';
/** The work item's title: what the Setup page and `up` find it by, with its branch. */
export const onboardingWorkTitle = 'Add Graphyard onboarding';
/** What the item plans to change: the files `init --scan --apply` writes, the workflows as a directory. */
export const onboardingPlannedFiles = ['AGENTS.md', '.gitignore', 'graphyard.json', '.github/workflows/'] as const;
/** The proof the item's one criterion names, answered as a closed question about the changed files. */
export const onboardingProof = 'unit:onboarding-files';
const pullRequestUrl = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/;

/** The pull request number URL names, or null. */
export function pullRequestNumber(url: string) {
  const number = Number(pullRequestUrl.exec(url)?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * The work item that carries the onboarding pull request at URL through the normal gates: a chore
 * (no documentation obligation) that requires independent review and CHECKS (the repository's own,
 * else the control plane's default), so once the loop runs its reviewer reviews the pull request and
 * the control plane merges it.
 */
export function onboardingWorkRequest(url: string, checks: string[] | null) {
  return {
    title: onboardingWorkTitle, type: 'chore' as const, priority: 0,
    description: `${url}\n\nThe pull request graphyard up opened with the files it wrote while onboarding this repository: coordination instructions (AGENTS.md), configuration (graphyard.json) and Graphyard's delivery workflows. It changes nothing else. Filed by graphyard up so the loop reviews and merges it under the normal gates (GY-1478).`,
    criteria: [{ id: 'AC-1', text: 'The pull request adds only Graphyard\'s onboarding files (AGENTS.md, .gitignore, graphyard.json and .github/workflows), so the base branch carries the delivery workflows.', proofs: [onboardingProof] }],
    closedQuestions: [{ criterion: 'AC-1', proof: onboardingProof, question: 'Does this change touch only AGENTS.md, .gitignore, graphyard.json and files under .github/workflows?', criteria: ['yes', 'no'], pass: 'yes', state: [{ kind: 'changed-files' as const }] }],
    plannedFiles: [...onboardingPlannedFiles],
    policy: { checks: checks?.length ? checks : ['test', 'typecheck'], review: true },
  };
}

/** The onboarding item among WORK: the one with KEY, else the newest titled and branched as `up` files it. */
export function findOnboardingWork(work: readonly any[] | null | undefined, key?: string | null) {
  const items = (work ?? []).filter(item => key ? item?.key === key
    : item?.title === onboardingWorkTitle && (item.workspaces ?? []).some((space: any) => space?.branch === onboardingBranch));
  return [...items].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null;
}

/** "4 min", "1 h 5 min", "under a minute": how long something has waited, in words. */
export function waitedFor(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;
}

export type OnboardingWaitingFor = 'checks' | 'review' | 'merge';
export interface OnboardingWait {
  key: string; url: string | null;
  /** What the pull request still waits for; empty once it merged or was closed. */
  waitingFor: OnboardingWaitingFor[];
  merged: boolean;
  /** Closed without merging (duplicate, superseded, abandoned): the base branch still lacks the workflows. */
  closed: boolean;
  /** When the wait started (the item was filed) and how long it has lasted. */
  since: string; waitedMs: number;
  /** One plain sentence with no command, sha or file path: the Setup page's checklist line. */
  line: string;
}

/**
 * Where the onboarding item WORK stands at NOW (GY-1478 AC-2): what it waits for, read from its
 * gates (the repository's checks, the independent review, then the merge), and for how long.
 */
export function onboardingWait(work: any, now: number, repository?: string | null): OnboardingWait {
  const url = pullRequestUrl.exec(String(work?.description ?? ''))?.[0]
    ?? (repository && work?.submission?.pr ? `https://github.com/${repository}/pull/${work.submission.pr}` : null);
  // The `test` gate is every required check at once: the policy's and those branch protection adds (gates.ts).
  const passed = (name: string) => (work?.gates ?? []).find((gate: any) => gate?.name === name)?.passed === true;
  // Merged only on merge evidence: a closed item is done too, without its pull request merging.
  const closed = work?.stage === 'done' && !!work?.closure;
  const merged = !closed && (work?.observation?.merged === true || (work?.stage === 'done' && !!work?.delivery?.mergedAt));
  const waitingFor: OnboardingWaitingFor[] = merged || closed ? [] : [...(passed('test') ? [] : ['checks' as const]), ...(passed('review') ? [] : ['review' as const])];
  if (!merged && !closed && !waitingFor.length) waitingFor.push('merge');
  const since = typeof work?.createdAt === 'string' && Number.isFinite(Date.parse(work.createdAt)) ? work.createdAt : new Date(now).toISOString();
  const waitedMs = Math.max(0, now - Date.parse(since));
  const what = waitingFor.map(entry => entry === 'checks' ? 'its tests to pass' : entry === 'review' ? 'an independent review' : 'the merge').join(' and ');
  const line = merged ? 'The change that adds Graphyard\'s delivery workflows to your repository is merged.'
    : closed ? 'The change that adds Graphyard\'s delivery workflows to your repository was closed without merging, so your repository still lacks them.'
    : `The change that adds Graphyard's delivery workflows to your repository is waiting for ${what}. It has waited ${waitedFor(waitedMs)} and merges by itself; nothing is needed from you.`;
  return { key: String(work?.key ?? ''), url, waitingFor, merged, closed, since, waitedMs, line };
}
