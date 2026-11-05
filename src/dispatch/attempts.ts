import { neverStarted, neverStartedReason } from '../master/launch.js';
import { sessionRetry } from '../producer.js';
import { bounded, dispatchFailureLimit } from './cursor.js';
/** A session record as the dispatcher reads it from either ledger. */
export type DispatchedSession = { requestId?: string; state: string; requestedAt: string; closedAt?: string; resolution?: string; profile?: string; attempt?: number; acknowledgedAt?: string; verdict?: { state: string } };
export const requestSessions = (records: DispatchedSession[], requestId: string) => records.filter(record => record.requestId === requestId);
/**
 * GY-1227. The resolution `describeAttempts` gives a failed or expired session that recorded none and
 * was never acknowledged: it never took up its request, so it acted on nothing.
 */
export const unacknowledgedReason = 'never acknowledged';
const retriedSession = (record: Pick<DispatchedSession, 'state'>) => record.state === 'failed' || record.state === 'expired';
const sessionResolution = (record: DispatchedSession) => record.resolution
  ?? (retriedSession(record) && !record.acknowledgedAt ? `${unacknowledgedReason}: the session ended without a recorded resolution before it took up its request` : undefined);
/** Every attempt a request had, as the attention item names them. */
export const describeAttempts = (records: DispatchedSession[], requestId: string) => requestSessions(records, requestId).slice(-30)
  .map((record, index) => { const resolution = sessionResolution(record); return bounded(`attempt ${record.attempt ?? index + 1}${record.profile ? ` on ${record.profile}` : ''}: ${record.state}${resolution ? ` — ${resolution}` : ''}`, 300); });
/** GY-120. The start of the refusal a session that exited at launch on its provider's limit notice carries (`InstantExitError`). */
export const instantExitReason = 'the session exited within seconds of its launch';
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * GY-1153. The resolutions of producer attempts that ended before the session acted on its request:
 * it never started (no prompt taken up, a trust prompt it sat on, a pane gone before acting), it was
 * never acknowledged, the headless run could not start, the launch was refused, or the session
 * exited at launch on its account's limit notice. Such attempts judged nothing about the candidate.
 * Matched on the start of the resolution only: a session that acted and later quoted a quota or rate
 * limit in its last words acted, and still earns the GY-496 rework. GY-1227: the wordings the
 * launcher and this dispatcher write are their exported constants, so a reword moves both at once;
 * the rest are producer.ts's headless-run and registry refusals and this file's own wait reasons.
 */
const unactedResolution = new RegExp(`^(?:${[neverStartedReason, unacknowledgedReason, instantExitReason, 'exited at launch', 'the headless run could not start',
  'launch refused', 'refused before it started', 'failed before it started', 'reserved by another dispatch'].map(literal).join('|')}|(?:every (?:independent )?producer )?profile(?: is)? busy)\\b`, 'i');
/** The `attempt N on PROFILE: STATE — ` prefix `describeAttempts` puts before each resolution. */
const attemptLine = /^attempt \d+(?: on ([^:]+))?: [\w-]+(?: — |$)/;
/** GY-1153. Whether a producer attempt (a resolution, or a line `describeAttempts` wrote) ended without the session acting. */
export function isUnactedProducerAttempt(text: string): boolean {
  return !!text && unactedResolution.test(text.replace(attemptLine, ''));
}
/**
 * GY-1227. Whether a session record ended without acting, read from the record itself: a session
 * `neverStarted` judged so, or a failed or expired one that recorded no resolution and was never
 * acknowledged, as well as any resolution `isUnactedProducerAttempt` reads as unacted.
 */
export const unactedProducerSession = (record: DispatchedSession) => neverStarted(record) || isUnactedProducerAttempt(sessionResolution(record) ?? '');
/**
 * GY-1227. Whether a spent request's attempts all ended without the session acting. No recorded
 * attempt is not evidence of a runtime fault, so an empty list counts as acted, the same in the
 * escalation, the rework and the attention.
 */
export const unactedProducerAttempts = (attempts: readonly string[]) => attempts.length > 0 && attempts.every(isUnactedProducerAttempt);
/** GY-1227. Whether a session ended at launch on its account's limit notice, the account held until its reset. */
const limitNoticeResolution = new RegExp(`^(?:${[instantExitReason, 'exited at launch'].map(literal).join('|')})\\b`, 'i');
export const limitNoticeExit = (record: DispatchedSession | undefined) => !!record && limitNoticeResolution.test(sessionResolution(record) ?? '');
/**
 * GY-1227. How many of a request's sessions came before it was first spent: those after are runtime
 * relaunches (GY-1153), each on a profile `runtimeProfiles` named. The whole list when it never was.
 */
export function requestSpentAt(sessions: DispatchedSession[], now: number) {
  for (let count = 1; count <= sessions.length; count++) {
    const retry = sessionRetry(sessions.slice(0, count), sessions[0].requestId ?? '', now);
    if (retry.exhausted || retry.attempts >= dispatchFailureLimit) return count;
  }
  return sessions.length;
}
/**
 * The profiles a relaunch tries, freshest first: a profile no attempt of this request ran on, then
 * the ones earlier attempts ran on, and the profile of the session that just settled last. A
 * relaunch on the account that just ended without an answer is the one least likely to answer.
 */
export function preferFreshProfiles<P extends { name: string }>(profiles: P[], records: DispatchedSession[], requestId: string): P[] {
  const used = requestSessions(records, requestId).map(record => record.profile);
  if (!used.length) return profiles;
  const rank = (profile: P) => used.lastIndexOf(profile.name);
  return profiles.map((profile, index) => ({ profile, index })).sort((a, b) => rank(a.profile) - rank(b.profile) || a.index - b.index).map(entry => entry.profile);
}
