// Concern: a runtime that started but failed before doing useful work is a failed launch.
import type { Work } from '../model.js';
import type { SessionHandle } from '../model/sessions.js';
import type { CoordinationRounds } from '../server/work-view.js';
import { resumeExitWindowMs } from '../master/session-resume.js';
import { redactString } from '../redaction.js';
import type { Cycle } from './cycle.js';
import { record } from './effects.js';
import { clearLaunchFailures, recordLaunchFailure } from './sessions.js';

import { earlyExitKey, leaseLossReason } from './repeated-failure.js';
export { earlyExitKey };

/** Read before the session closes: diagnose crashes and workers that stopped on a lease refusal. */
export async function workerLaunchHealth(cycle: Cycle, item: Work, session: SessionHandle): Promise<string | null> {
  if (session.kind !== 'implementation') return null;
  const { config, effects, state, clock } = cycle;
  const epoch = session.epoch ?? Number(/:(\d+)$/.exec(session.id)?.[1]);
  const profile = config.workers.find(profile => profile.principal === session.principal);
  const latest = (item as Work & CoordinationRounds).attemptEnd;
  const end = latest?.epoch === epoch ? latest : item.pipeline?.attempts.find(attempt => attempt.epoch === epoch);
  const ended = end?.epoch === epoch && !!end.endedAt;
  const startedAt = session.runtimeStartedAt ?? session.startedAt;
  const age = Date.parse(ended ? end.endedAt! : new Date(clock).toISOString()) - Date.parse(startedAt);
  const key = earlyExitKey(item);
  const runtime = session.runtime ?? null;
  const recovered = () => { if (state.failureRuns[item.id]?.kind === 'lease') delete state.failureRuns[item.id]; delete state.actions[key]; if (runtime) clearLaunchFailures(state, runtime, item); return null; };
  if (item.submission?.epoch === epoch) return epoch === item.epoch ? recovered() : null;
  const previous = state.actions[key];
  if (previous?.epoch != null && previous.epoch >= epoch) return previous.epoch === epoch ? previous.detail : null;
  const leaseMissing = !item.lease || item.lease.epoch !== epoch || Date.parse(item.lease.expiresAt) <= clock;
  const exited = ended || session.state === 'finished' || session.observed === 'ended';
  if (!exited) return epoch === item.epoch && state.failureRuns[item.id]?.kind !== 'lease' && age >= resumeExitWindowMs ? recovered() : null;
  const screen = await Promise.resolve().then(() => effects.sessionScreen?.(session)).catch(() => null) ?? '';
  // A successful process exit can still be an abandoned assignment: the agent stopped on a
  // lease refusal. Do not forgive it for running longer or preserving a commit first.
  if ((leaseMissing && end?.end !== 'released' && end?.end !== 'submitted') || /Lease missing, expired, or superseded/.test(screen)) {
    const reason = `${item.key} epoch ${epoch}: ${leaseLossReason}`;
    await record(state, key, { kind: 'dispatch', work: item.key, principal: session.principal, epoch, state: 'failed', detail: reason,
      attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, clock, effects.persist);
    return reason;
  }
  if (epoch !== item.epoch) return null;
  if (age >= resumeExitWindowMs) return recovered();
  const space = item.workspaces.find(space => space.epoch === epoch && space.host === config.hostId);
  const reading = space && session.initialHead ? await Promise.resolve().then(() => effects.worktreeState?.(space)).catch(() => null) : null;
  if (reading?.head && reading.head !== session.initialHead) return recovered();
  // A release, blocker, lease expiry, successful exit or unreadable inventory is not proof of a crash.
  const exit = end?.cause?.match(/the agent process exited \((code (-?\d+)|SIG[A-Z0-9]+)\) while its lease was live/);
  if (!ended || age < 0 || !exit || exit[2] === '0') return recovered();
  // Mask full values before taking a tail or bounding it: cutting a secret first can leak a prefix.
  let safe = screen;
  for (const [name, value] of Object.entries({ ...process.env, ...profile?.environment })) {
    if (value && /token|password|passwd|secret|api[_-]?key|authorization/i.test(name)) safe = safe.split(value).join('[redacted]');
  }
  const tail = redactString(safe.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n').slice(-20).join('\n')).trim();
  const reason = `${item.key} epoch ${epoch}: worker exited unsuccessfully (${exit[1]}) within ${resumeExitWindowMs / 1000}s without submitting or committing${tail ? `: ${tail}` : ''}`.slice(0, 500);
  recordLaunchFailure(state, runtime, item, reason, clock);
  await record(state, key, { kind: 'dispatch', work: item.key, principal: session.principal, epoch, state: 'failed', detail: reason,
    attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, clock, effects.persist);
  return reason;
}
