/**
 * The onboarding change as a work item the loop owns (GY-1478). `graphyard up` publishes the files
 * `init --scan --apply` wrote as one commit on `graphyard/onboarding` and submits that commit as a
 * work item exactly as a worker's `complete --head` does, so the loop's reviewer reviews it and the
 * control plane merges it under the normal gates; no pull request is opened and no person merges it
 * by hand. While the item is open, `up` and the dashboard's Setup page show it as the current setup
 * step from the same reading (onboardingWait). Browser-safe: the Setup page imports it.
 */

/** The branch `graphyard up` publishes the onboarding files on, and the workspace its work item registers. */
export const onboardingBranch = 'graphyard/onboarding';
/** The work item's title: what the Setup page and `up` find it by, with its branch. */
export const onboardingWorkTitle = 'Add Graphyard onboarding';
/** The proof the item's one criterion names, answered as a closed question about the changed files. */
export const onboardingProof = 'unit:onboarding-files';
/**
 * GY-3037: every item owes an e2e proof, so onboarding leaves every repository able to carry one:
 * the first case `init --scan --apply` writes when the repository has none (e2e.serve it writes
 * beside it, when no application serves a head, lives in the applied graphyard.json). The item
 * names the repository's first case, this one when it was just written.
 */
export const onboardingCaseId = 'served-head';
export const onboardingCasePath = `e2e/cases/${onboardingCaseId}.json`;

/**
 * The serve declaration onboarding writes when nothing previewable serves a head: a server that
 * needs nothing but Node answering on a loopback port with graphyard.json. It is a placeholder
 * (GY-3208): no case run against it exercises the application, so the merge trial fails every case
 * but onboarding's own first one against it, and master status names it, until the repository
 * declares the serve that runs its application.
 */
export const onboardingServe = {
  command: `node -e "require('http').createServer((request,response)=>{response.setHeader('content-type','application/json');response.end(require('fs').readFileSync('graphyard.json'))}).listen(43911,'127.0.0.1')"`,
  url: 'http://127.0.0.1:43911/',
  readySeconds: 60,
};
/** Whether `serve` is the placeholder onboarding wrote, unchanged. */
export const isPlaceholderServe = (serve: { command?: string } | null | undefined) => serve?.command === onboardingServe.command;
/** Why a case cannot run against the placeholder, and what to declare instead. */
export const placeholderServeRefusal = 'e2e.serve is onboarding\'s placeholder serve, which answers with graphyard.json and runs none of the application: declare the command that serves the application in graphyard.json "e2e": { "serve": { "command", "url", "readySeconds" } }, or a previewable application in delivery.applications';

/**
 * The work item that carries the onboarding commit on `graphyard/onboarding` through the normal
 * gates: a chore that requires independent review and CHECKS (the repository's own, else the
 * control plane's default), so once the loop runs its reviewer reviews the head and the control
 * plane merges it. Its e2e proof names `caseId` — the repository's first case, the one this commit
 * wrote or an existing one — which the merge trial runs against the served head (GY-3037).
 */
export function onboardingWorkRequest(commit: string, checks: string[] | null, caseId: string | null) {
  return {
    title: onboardingWorkTitle, type: 'chore' as const, priority: 0,
    description: `${commit.slice(0, 12)} on ${onboardingBranch}\n\nThe commit graphyard up published with the files it wrote while onboarding this repository: coordination instructions (AGENTS.md), configuration (graphyard.json) and, when the repository had no E2E case, the first one (${onboardingCasePath}). It changes nothing else. Filed by graphyard up so the loop reviews and merges it under the normal gates (GY-1478).`,
    criteria: [{ id: 'AC-1', text: `The change adds only Graphyard's onboarding files (AGENTS.md, .gitignore, graphyard.json and, when written, ${onboardingCasePath}); no .github/workflows file is written.`, proofs: [onboardingProof, ...(caseId ? [`e2e:${caseId}`] : [])] }],
    closedQuestions: [{ criterion: 'AC-1', proof: onboardingProof, question: `Does this change touch only AGENTS.md, .gitignore, graphyard.json and, when it adds one, ${onboardingCasePath}?`, criteria: ['yes', 'no'], pass: 'yes', state: [{ kind: 'changed-files' as const }] }],
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
  key: string;
  /** What the item still waits for; empty once the change merged or was closed. */
  waitingFor: OnboardingWaitingFor[];
  /** The control plane merged the change: the item is done with a delivery, not closed. */
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
export function onboardingWait(work: any, now: number): OnboardingWait {
  // The `test` gate is every required check at once: the policy's and those branch protection adds (gates.ts).
  const passed = (name: string) => (work?.gates ?? []).find((gate: any) => gate?.name === name)?.passed === true;
  // Done only tells merged from closed: a closed item is done too, without its change merging.
  const closed = work?.stage === 'done' && !!work?.closure;
  const merged = work?.stage === 'done' && !closed;
  const waitingFor: OnboardingWaitingFor[] = merged || closed ? [] : [...(passed('test') ? [] : ['checks' as const]), ...(passed('review') ? [] : ['review' as const])];
  if (!merged && !closed && !waitingFor.length) waitingFor.push('merge');
  const since = typeof work?.createdAt === 'string' && Number.isFinite(Date.parse(work.createdAt)) ? work.createdAt : new Date(now).toISOString();
  const waitedMs = Math.max(0, now - Date.parse(since));
  const what = waitingFor.map(entry => entry === 'checks' ? 'its tests to pass' : entry === 'review' ? 'an independent review' : 'the merge').join(' and ');
  const line = merged ? 'The change that adds Graphyard\'s delivery workflows to your repository is merged.'
    : closed ? 'The change that adds Graphyard\'s delivery workflows to your repository was closed without merging, so your repository still lacks them.'
    : `The change that adds Graphyard's delivery workflows to your repository is waiting for ${what}. It has waited ${waitedFor(waitedMs)} and merges by itself; nothing is needed from you.`;
  return { key: String(work?.key ?? ''), waitingFor, merged, closed, since, waitedMs, line };
}
