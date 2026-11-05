// Concern: a runtime that started but failed before doing useful work is a failed launch.
import type { Work } from '../model.js';
import type { SessionHandle } from '../model/sessions.js';
import type { CoordinationRounds } from '../server/work-view.js';
import { resumeExitWindowMs } from '../master/session-resume.js';
import { redactString } from '../redaction.js';
import type { Cycle } from './cycle.js';
import { record } from './effects.js';
import { clearLaunchFailures, recordLaunchFailure } from './sessions.js';

export const earlyExitKey = (item: Pick<Work, 'id'>) => `early-exit:${item.id}`;

/** Read before the pane closes. Only an unsuccessful supervisor exit is a launch incident. */
export async function workerLaunchHealth(cycle: Cycle, item: Work, session: SessionHandle): Promise<string | null> {
  if (session.kind !== 'implementation') return null;
  const { config, effects, state, clock } = cycle;
  const epoch = session.epoch ?? Number(/:(\d+)$/.exec(session.id)?.[1]);
  if (epoch !== item.epoch) return null;
  const profile = config.workers.find(profile => profile.principal === session.principal);
  const end = (item as Work & CoordinationRounds).attemptEnd
    ?? item.pipeline?.attempts.find(attempt => attempt.epoch === epoch);
  const ended = end?.epoch === epoch && !!end.endedAt;
  const startedAt = session.runtimeStartedAt ?? session.startedAt;
  const age = Date.parse(ended ? end.endedAt! : new Date(clock).toISOString()) - Date.parse(startedAt);
  const key = earlyExitKey(item);
  const runtime = session.runtime ?? null;
  const recovered = () => { delete state.actions[key]; if (runtime) clearLaunchFailures(state, runtime); return null; };
  if (item.submission?.epoch === epoch || age >= resumeExitWindowMs) return recovered();
  const space = item.workspaces.find(space => space.epoch === epoch && space.host === config.hostId);
  const reading = space && session.initialHead ? await Promise.resolve().then(() => effects.worktreeState?.(space)).catch(() => null) : null;
  if (reading?.head && reading.head !== session.initialHead) return recovered();
  // A release, blocker, lease expiry, successful exit or unreadable inventory is not proof of a crash.
  const exit = end?.cause?.match(/the agent process exited \((code (-?\d+)|SIG[A-Z0-9]+)\) while its lease was live/);
  if (!ended || age < 0 || !exit || exit[2] === '0') return null;
  const previous = state.actions[key];
  if (previous?.epoch === epoch) return previous.detail;
  const screen = await Promise.resolve().then(() => effects.sessionScreen?.(session)).catch(() => null) ?? '';
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
