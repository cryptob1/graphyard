// Concern: cycle step 6b — apply the remedy a stalled row's unchanged reason binds to (GY-949).
import { fileURLToPath } from 'node:url';
import type { ChildRun } from '../child-runner.js';
import { actionStall, type ActionRow } from '../model/actions.js';
import type { Work } from '../model.js';
import { applyInstallationAccept, stallRemedy, standingRemedy, type BoundRemedy, type FlowResult, type RemedyFlow } from '../stall-remedies.js';
import { record } from './effects.js';
import { message } from './state.js';
import type { Cycle } from './cycle.js';

/** A stalled row whose reason binds to a remedy the loop applies, with no attempt recorded for its run. */
export interface OwedRemedy { work: Work; row: ActionRow; reason: string; bound: BoundRemedy }

/**
 * The rows a loop-applied remedy is owed for: open, stalled (`actionStall`) on a reason the
 * registry binds to a remedy the loop applies, and with no attempt of it recorded for the run.
 */
export function owedRemedies(work: Work[]): OwedRemedy[] {
  return work.filter(item => item.stage !== 'done').flatMap(item => (item.actionQueue?.actions ?? []).flatMap(row => {
    const stall = actionStall(row);
    const bound = stall && stallRemedy(stall.reason);
    return bound?.applies === 'loop' && !standingRemedy(item, row.id, stall!.reason) ? [{ work: item, row, reason: stall!.reason, bound }] : [];
  }));
}

/**
 * The runs a loop has applied a remedy for, by row: the reason applied for. It covers the instant
 * between a remedy settling and the next snapshot showing its record, so a cycle that read the world
 * before the record landed does not apply it again; an entry goes once the snapshot shows the
 * record, or the row no longer stalls on that reason. It is kept per loop — keyed on the loop's
 * launcher, which lives as long as the loop does — so two loops in one process never share or clear
 * each other's entries. A restart forgets it, and by then the record is on the row: it is written
 * before the launch settles.
 */
const appliedByLoop = new WeakMap<object, Map<string, string>>();
function appliedOf(loop: object) {
  let applied = appliedByLoop.get(loop);
  if (!applied) appliedByLoop.set(loop, applied = new Map());
  return applied;
}

/**
 * Step 6b. For every stalled row the registry binds to a remedy the loop applies, apply it once for
 * the row's unchanged run and record the attempt on the row. Rows held by the same condition share
 * one application: the permission hold that stalls two items' resyncs is one installation to
 * accept, so the flow runs once and its outcome is recorded on each row. The flow runs beside the
 * cycle (the launcher), since a sudo confirmation inside it may wait minutes; nothing forces a retry
 * of the row afterwards — its own stall recheck picks the cleared condition up. A refusal is
 * recorded like any outcome and is not applied again for the run: the liveness rule escalates it
 * once with the refusal and the remedy named (src/model/liveness.ts).
 */
export async function remedyStep(cycle: Cycle) {
  const { effects, snapshot, state, now, launch } = cycle;
  if (!effects.browserFlow || !effects.recordRemedy) return;
  const applied = appliedOf(cycle.launcher);
  for (const [id, reason] of [...applied]) {
    const item = snapshot.work.find(entry => (entry.actionQueue?.actions ?? []).some(row => row.id === id));
    const row = item?.actionQueue!.actions.find(entry => entry.id === id);
    if (!row || actionStall(row)?.reason !== reason || standingRemedy(item!, id, reason)) applied.delete(id);
  }
  const owed = owedRemedies(snapshot.work).filter(entry => applied.get(entry.row.id) !== entry.reason);
  const groups = new Map<string, OwedRemedy[]>();
  for (const entry of owed) groups.set(entry.bound.kind, [...(groups.get(entry.bound.kind) ?? []), entry]);
  for (const [kind, rows] of groups) {
    if (kind !== 'installation-accept') continue;
    const key = `remedy:${kind}`;
    if (cycle.launcher.busy(key)) continue;
    for (const entry of rows) applied.set(entry.row.id, entry.reason);
    const distinct = [...new Map(rows.map(entry => [entry.work.key, entry.work])).values()];
    const sole = distinct.length === 1 ? distinct[0] : null;
    await record(state, key, { kind: 'config', work: sole?.key ?? null, principal: null, epoch: sole?.epoch ?? null,
      state: 'started',
      detail: `Applying the ${kind} remedy for the stalled ${rows.map(r => `${r.work.key}'s ${r.row.kind}`).join(', ')}`,
      attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    launch('config', sole, key, [], async sink => {
      const outcome = await applyInstallationAccept(effects.browserFlow!);
      const recorded: string[] = [], refused: string[] = [];
      for (const entry of rows) {
        try { await effects.recordRemedy!(entry.row.id, { remedy: 'installation-accept', reason: entry.reason, ...outcome }); recorded.push(`${entry.work.key}'s ${entry.row.kind}`); }
        catch (error) { refused.push(`${entry.work.key}'s ${entry.row.kind} (${message(error)})`); }
      }
      sink.push(await record(state, key, { kind: 'config', work: sole?.key ?? null, principal: null, epoch: sole?.epoch ?? null,
        state: outcome.outcome === 'refused' ? 'failed' : 'done',
        detail: `Applied the ${kind} remedy (${outcome.flows.join(', then ')}) for the stalled ${recorded.concat(refused).join(', ')}: ${outcome.outcome} — ${outcome.detail}${recorded.length ? `. Recorded on ${recorded.join(', ')}` : ''}${refused.length ? `. Not recorded on ${refused.join(', ')}` : ''}`.slice(0, 2000),
        attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    });
  }
}

/** How long a remedy's browser flow may run: a sudo confirmation it waits on is bounded inside it (passSudo). */
export const remedyFlowTimeoutMs = 15 * 60_000;
const graphyardCli = fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url));
/**
 * `graphyard master browser FLOW` as a child of the loop (GY-949), the same command the master
 * runs by hand, so the flow is recorded, verified through the API and audited exactly as it is
 * then. It prints its ledger entry whether it applied or refused, and exits non-zero on a refusal.
 */
export async function browserFlowChild(run: ChildRun, root: string, flow: RemedyFlow): Promise<FlowResult> {
  let printed: string;
  try { printed = String(await run(process.execPath, [graphyardCli, 'master', 'browser', flow], { cwd: root, timeoutMs: remedyFlowTimeoutMs })); }
  catch (error) { printed = String((error as { stdout?: unknown } | null)?.stdout ?? ''); if (!printed.includes('{')) throw error; }
  const entry = JSON.parse(printed.slice(printed.indexOf('{'))) as { outcome?: unknown; verified?: unknown; reason?: unknown };
  const outcome = entry.outcome === 'applied' || entry.outcome === 'unchanged' ? entry.outcome : 'refused';
  return { outcome, verified: entry.verified === true, reason: String(entry.reason ?? `master browser ${flow} printed no reason`) };
}
