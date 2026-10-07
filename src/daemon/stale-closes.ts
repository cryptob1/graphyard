// Concern: cycle step 4c — a close that went stale on a revision race is requested again, and the item it closes holds still meanwhile (GY-1439).
import type { Work } from '../model.js';
import { convergibleClose, pendingClose, revisionRace, staleAttentionAttempts, staleWaitKey } from '../model/stale-close.js';
import { diagnosisSettled } from '../runner/payloads.js';
import { mapBounded } from '../master/timings.js';
import { detailChanged } from './decisions.js';
import { decisionReadConcurrency } from './decision-reads.js';
import { type DaemonEffects, record } from './effects.js';
import { readyToRetry } from './sessions.js';
import { message } from './state.js';
import type { Cycle } from './cycle.js';

/** The action key of the loop's re-request of one stale close; done once that close is asked again, so it is asked once. */
export const staleCloseKey = (decision: string) => `close:stale:${decision}`;
const staleWaitPrefix = 'wait:decision-stale:';
/** The detail a named wait carries while the loop is still requesting the close again: the item is being closed. */
const converging = /; the loop requested it again /;

/** The items a diagnosis carries the close of: its own re-request (GY-1296) asks them again, so this step does not. */
const diagnosedCloses = (state: Cycle['state']) =>
  new Set(Object.values(state.diagnoses).filter(entry => !diagnosisSettled(entry) && entry.state === 'closing' && entry.decision?.action === 'close').map(entry => entry.decision!.work));

/**
 * GY-1439. The open items a close decision stands on, requested and not yet applied, by key, with the
 * decision that closes each — as far as the loop knows without a read: a watch of its own or of a
 * hand-launched approver, a diagnosis closing the item, a kept history whose latest close is
 * requested, approved or stale and still being asked again, or a named stale wait still converging.
 * While one stands, the loop's advancing steps take nothing on the item (the routine decisions —
 * a mechanical bot round, a rework, an attestation — the observation wake behind a rework, the
 * review-cap withdrawal that spends a fresh review, a worker dispatch): each moved the item's
 * revision under the close, which settled stale, and spent a round on a candidate being closed.
 * GY-1437's close as a duplicate of GY-1438 went stale twice in 13 minutes on 7 October 2026 while
 * the loop authorized a mechanical rework of the same candidate.
 */
export function closingItems(cycle: Pick<Cycle, 'state' | 'open' | 'heldDecisions' | 'snapshot'>): Map<string, string> {
  const { state, open, heldDecisions, snapshot } = cycle, closing = new Map<string, string>(), keys = new Set(open.map(item => item.key));
  for (const watch of Object.values(state.approvals)) if (watch.action === 'close' && !watch.settledAt && keys.has(watch.work)) closing.set(watch.work, watch.decision);
  for (const entry of Object.values(state.diagnoses)) if (!diagnosisSettled(entry) && entry.state === 'closing' && entry.decision && keys.has(entry.decision.work)) closing.set(entry.decision.work, entry.decision.id);
  for (const item of open) {
    const history = heldDecisions.histories.get(item.id);
    const pending = history && (pendingClose(history)?.id ?? convergingClose(item, history, snapshot.work));
    if (pending) closing.set(item.key, pending);
    const wait = state.actions[staleWaitKey(item, 'close')];
    if (!history && !closing.has(item.key) && wait && converging.test(wait.detail)) closing.set(item.key, / as close decision (\S+) /.exec(wait.detail)?.[1] ?? 'its close');
  }
  return closing;
}
const convergingClose = (item: Work, history: Parameters<typeof convergibleClose>[1], work: readonly Work[]) => {
  const converge = convergibleClose(item, history, work);
  return converge && 'input' in converge ? converge.decision.id : null;
};
/**
 * The close standing on one item about to be advanced, read from its history: a close requested by
 * hand since the loop last read the item holds it too, and one refused or applied since holds it no
 * longer. The decisions step reads the same history for the request it would make. An unreadable
 * history falls back to what `closingItems` knew (`known`).
 */
export async function closeStanding(effects: Pick<DaemonEffects, 'decisions'>, item: Work, work: readonly Work[], known: ReadonlyMap<string, string>): Promise<string | null> {
  const history = effects.decisions ? await effects.decisions(item).then(result => result.decisions, () => null) : null;
  return history ? pendingClose(history)?.id ?? convergingClose(item, history, work) : known.get(item.key) ?? null;
}

/**
 * GY-1439. A close bound to the item revision the server settled `stale` — a review settled, a bot
 * round was authorized or an observation refreshed between the request and its approval — closes
 * nothing, and before this only the master asked again, on its next turn: GY-1437's close stood
 * unapplied for 13 minutes across two such races. Each cycle the loop now reads the item afresh,
 * re-validates the close's grounds at its current revision (`convergibleClose`: still open, the
 * item it names still held and not itself closed), and requests the same closure again against
 * that revision with the master's operator-agent identity, then launches its independent approver;
 * `closingItems` holds the item's advancing steps meanwhile, so the second request is not raced by
 * the loop's own writes. A close a diagnosis carries is left to it. The series is one named wait
 * per item and action (`staleWaitKey`): the attempt count and the revision the latest request
 * expected against the one the server found, re-recorded only when that changes, retired when the
 * close applies; after `staleAttentionAttempts` stale settles in a row it is asked no more, and
 * master status raises one attention line for the series (cli/decision-report.ts).
 */
export async function staleCloseStep(cycle: Cycle, effects: DaemonEffects) {
  const { state, snapshot, now, performed, isolate, open } = cycle;
  const { decide, approver, decisions } = effects;
  if (!decide || !approver || !decisions) return;
  const note = async (key: string, item: Work, outcome: 'done' | 'failed', detail: string) =>
    performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: outcome, detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
  // The named waits of items no longer open are retired: their close applied, or they were delivered.
  const ids = new Set(open.map(item => item.id));
  for (const key of Object.keys(state.actions)) if (key.startsWith(staleWaitPrefix) && !ids.has(key.slice(staleWaitPrefix.length).split(':')[0]!)) delete state.actions[key];
  const diagnosed = diagnosedCloses(state), known = closingItems(cycle);
  const candidates = open.filter(item => !diagnosed.has(item.key) && (known.has(item.key) || !!state.actions[staleWaitKey(item, 'close')]
    || cycle.heldDecisions.histories.get(item.id)?.some(decision => decision.action === 'close')));
  // An unreadable history is unknown: nothing is asked on it, and the next cycle reads it again.
  const histories = await mapBounded(candidates, decisionReadConcurrency, item => decisions(item).then(result => result.decisions, () => null));
  for (const [index, item] of candidates.entries()) {
    const history = histories[index];
    if (!history) continue;
    await isolate('decision', item, item.key, async () => {
      const waitKey = staleWaitKey(item, 'close'), wait = state.actions[waitKey];
      const latest = history.filter(decision => decision.action === 'close').at(-1);
      // Applied, refused or asked again and still standing: the series is over, or the new request carries it.
      if (!latest || latest.state !== 'stale') {
        if (wait && latest?.state !== 'requested' && latest?.state !== 'approved') { delete state.actions[waitKey]; await effects.persist(state); }
        return;
      }
      const converge = convergibleClose(item, history, snapshot.work);
      if (!converge) return;
      const run = converge.run, race = revisionRace(converge.decision);
      const series = `${item.key}'s close decision settled stale ${run.length} time(s) in a row (latest ${converge.decision.id}: expected revision ${String(converge.decision.input?.expectedRevision ?? 'unknown')}, item at ${race?.current ?? 'unknown'})`;
      if ('refused' in converge) {
        const detail = `${series}; the loop does not request it again: ${converge.refused}`;
        if (detailChanged(wait, detail)) await note(waitKey, item, 'done', detail);
        return;
      }
      const key = staleCloseKey(converge.decision.id);
      if (state.actions[key]?.state === 'done') return;
      if (state.actions[key]?.state === 'failed' && !readyToRetry(state.actions[key], state.cycle)) return;
      const asked = (converge.decision.reason ?? `Close ${item.key} (${converge.input.kind}${converge.input.ref ? ` of ${converge.input.ref}` : ''})`).replace(/ \[Requested again by the master loop[^\]]*\]$/, '').slice(0, 1500);
      const why = `close decision ${converge.decision.id} settled stale (expected revision ${race!.expected}, item at ${race!.current}) and its grounds still hold`;
      const ask = (target: Work) => decide(target, 'close', `${asked} [Requested again by the master loop against revision ${target.revision}: ${why}]`.slice(0, 2000), converge.input);
      let requested: { id: string }, target = item;
      try { requested = await ask(item); }
      catch (error) {
        // The request names the snapshot's revision, and a write since moved it: read the item once more and ask against that.
        const fresh = /Task revision changed/.test(message(error)) && effects.snapshot ? (await effects.snapshot().catch(() => null))?.work.find(entry => entry.id === item.id) : undefined;
        const again = fresh && fresh.stage !== 'done' ? await ask(fresh).then(made => ({ made }), (retry: unknown) => ({ error: retry })) : { error };
        if (!('made' in again)) { await note(key, item, 'failed', `Could not request again the close of ${item.key} after ${why}: ${message(again.error)}`); return; }
        requested = again.made; target = fresh!;
      }
      await note(waitKey, item, 'done', `${series}; the loop requested it again as close decision ${requested.id} against revision ${target.revision} (request ${run.length + 1} of ${staleAttentionAttempts})`);
      const launched = await approver(target, requested.id).then(session => `launched approver ${session.agentName}`, error => `its approver could not be launched (${message(error)}), so the unanswered-decision remedy relaunches it`);
      await note(key, item, 'done', `${why}; requested it again as close decision ${requested.id} against revision ${target.revision} and ${launched}`);
    });
  }
}
