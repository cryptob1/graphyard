// Concern: cycle step 4c — request again the release of every backlog item whose release went stale (GY-1315).
import type { Work } from '../model.js';
import { staleRelease, unappliedReleases } from '../cli/owed-report.js';
import { diagnosisSettled } from '../runner/payloads.js';
import { maxDecisionRequests } from './decisions.js';
import { type DaemonEffects, record } from './effects.js';
import { message } from './state.js';
import type { Cycle } from './cycle.js';

/** The action key of the loop's re-request of one stale release; done once that release is asked again, so it is asked once. */
export const staleReleaseKey = (decision: string) => `release:stale:${decision}`;
type ReleaseDecide = (work: Work, action: 'release', reason: string, input?: Record<string, unknown>) => Promise<{ id: string }>;

/**
 * GY-1315. A release the server settled `stale` — the item revision moved between the request and
 * its approver's read — releases nothing, and its outcome says to reload and request again. Only the
 * diagnosis step did (GY-1296), for the fixes it filed: a release requested any other way sat in
 * backlog named as owed, and every such line counted as a decision fault (GY-1313 and GY-1314 counted
 * three minutes after going stale, before the diagnosis step's own re-request). Each cycle the loop
 * now requests every unreleased backlog item's stale release again, against the item's current
 * revision, with the master's operator-agent identity, and launches its independent approver: the
 * same bound as the diagnosis step's (maxDecisionRequests settled without applying, counted from the
 * item's own history so it survives a restart), then one escalation naming the manual route. A
 * release a diagnosis is carrying is left to it, so no release is asked twice. An approver that could
 * not be launched is relaunched by the unanswered-decision remedy, as for any decision the loop does
 * not watch.
 */
export async function staleReleaseStep(cycle: Cycle, effects: DaemonEffects) {
  const { state, snapshot, now, performed, isolate } = cycle;
  if (!effects.decide || !effects.approver || !effects.decisions) return;
  const decide = effects.decide as unknown as ReleaseDecide, approver = effects.approver, decisions = effects.decisions;
  const diagnosed = new Set(Object.values(state.diagnoses).filter(entry => !diagnosisSettled(entry) && entry.decision?.action === 'release').map(entry => entry.decision!.work));
  const note = async (key: string, item: Work, kind: 'decision' | 'escalation', outcome: 'done' | 'failed', detail: string) =>
    performed.push(await record(state, key, { kind, work: item.key, principal: null, state: outcome, detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
  for (const item of snapshot.work) {
    if (item.stage !== 'backlog' || item.ready || diagnosed.has(item.key)) continue;
    await isolate('decision', item, item.key, async () => {
      // An unreadable history is unknown: nothing is asked on it, and the next cycle reads it again.
      const history = await decisions(item).then(result => result.decisions, () => null);
      const release = history && staleRelease(item, history);
      if (!history || !release) return;
      const key = staleReleaseKey(release.id);
      if (state.actions[key]?.state === 'done') return;
      const spent = unappliedReleases(history), why = `release decision ${release.id} on ${item.key} was settled stale: ${release.outcome ?? 'no reason recorded'}`;
      if (spent >= maxDecisionRequests) {
        // The diagnosis step escalates its own spent release; one escalation is enough.
        if (state.actions[`escalation:diagnosis-stale:${release.id}`]) return;
        await note(key, item, 'escalation', 'done', `${item.key} still waits in backlog for its release, but ${spent} release requests settled stale or withdrawn (last ${release.id}), so the loop does not request it again. `
          + `Release it by hand: graphyard master release ${item.key}, or graphyard master decide ${item.key} release REASON, then graphyard master approver ${item.key} DECISION`);
        return;
      }
      const asked = (release.reason ?? `Release ${item.key}`).slice(0, 1500);
      let requested: { id: string };
      try { requested = await decide(item, 'release', `${asked} [Requested again by the master loop against revision ${item.revision}: ${why}]`.slice(0, 2000), {}); }
      catch (error) { await note(key, item, 'decision', 'failed', `Could not request again the release of ${item.key} after ${why}: ${message(error)}`); return; }
      const launched = await approver(item, requested.id).then(session => `launched approver ${session.agentName}`, error => `its approver could not be launched (${message(error)}), so the unanswered-decision remedy relaunches it`);
      await note(key, item, 'decision', 'done', `${why}; requested it again as release decision ${requested.id} against revision ${item.revision} (request ${spent + 1} of ${maxDecisionRequests}) and ${launched}`);
    });
  }
}
