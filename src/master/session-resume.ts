// Concern: carrying a worker's runtime conversation into the item's next attempt (GY-2971).
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dispatchedFile } from './dispatch-reservation.js';
import { runtimeAdapter } from './runtimes.js';

/**
 * What the last worker launch of an item recorded, beside the epoch the dispatch reservation reads:
 * the runtime and account it ran on, the runtime's own session id, its worktree, and the attempt it
 * resumed, if any. Written once the launch started; a record from before GY-2971 has only the epoch.
 */
export interface AttemptLaunch { epoch: number; runtime?: string | null; account?: string | null; session?: string | null; path?: string | null; resumedFrom?: number | null }
export async function readAttemptLaunch(root: string, key: string): Promise<AttemptLaunch | null> {
  const record = await readFile(dispatchedFile(root, key), 'utf8').then(text => JSON.parse(text) as AttemptLaunch, () => null);
  return typeof record?.epoch === 'number' ? record : null;
}

/** Set on a resume launch's tab: its `watch` supervisor leaves the lease to the launcher when the runtime exits within `resumeExitWindowMs`. */
export const resumeLaunchVariable = 'GRAPHYARD_RESUME_LAUNCH', resumeExitWindowMs = 60_000;

export type ResumePlan = { resume: true; from: number; session: string; args: string[] } | { resume: false; session: string | null; args: string[]; why: string | null };
/** A fresh launch's arguments: the runtime's own, plus the session id it records when it has a form for one. */
export function freshLaunch(kind: string | undefined, why: string | null): Extract<ResumePlan, { resume: false }> {
  const form = runtimeAdapter(kind)?.resume, session = form ? randomUUID() : null;
  return { resume: false, session, args: form && session ? form.fresh(session) : [], why };
}
/**
 * Whether this launch resumes the previous attempt's session: only on the same runtime and the same
 * account — an account the selection passed over (limited, logged out) is not free — and only when
 * that attempt recorded its session id. Otherwise the launch is fresh, as before, with the reason.
 */
export function resumePlan(previous: AttemptLaunch | null, launch: { kind?: string; account: string | null }): ResumePlan {
  if (!previous) return freshLaunch(launch.kind, null);
  const attempt = `attempt ${previous.epoch}`;
  const form = runtimeAdapter(launch.kind)?.resume;
  const why = !form ? `the ${launch.kind ?? 'unnamed'} runtime has no resume form`
    : previous.runtime !== launch.kind ? `${attempt} ran on ${previous.runtime ?? 'an unrecorded runtime'}, this launch on ${launch.kind}`
    : previous.account !== launch.account ? `${attempt}'s account ${previous.account ?? 'unnamed'} is not free; this launch is on ${launch.account ?? 'no named account'}`
    : !previous.session ? `${attempt} recorded no runtime session id`
    : null;
  if (why || !form || !previous.session) return freshLaunch(launch.kind, why);
  return { resume: true, from: previous.epoch, session: previous.session, args: form.resume(previous.session) };
}

/** Carries the session's transcript into the next attempt's worktree, for a runtime that keeps it under the directory it ran in (Claude Code). */
export async function carryTranscript(kind: string | undefined, environment: Record<string, string>, session: string, from: string | null | undefined, to: string) {
  if (from && from !== to) await runtimeAdapter(kind)?.resume?.carry?.(environment, session, from, to);
}

/** The attempt line `master status` shows for an item: `attempt N`, with the attempt it resumed when it did. */
export function attemptLabel(epoch: number, launched: AttemptLaunch | null) {
  if (!epoch) return null;
  return launched?.epoch === epoch && launched.resumedFrom ? `attempt ${epoch} (resumed from ${launched.resumedFrom})` : `attempt ${epoch}`;
}
