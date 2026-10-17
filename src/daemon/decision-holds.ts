// Concern: decisions the record or the runtime already answers — the applied rework a put would be refused for, and the approver name a launch is refused for (GY-1888).
import { decisionSituation } from '../model/approval.js';
import type { Work } from '../model.js';
import { type HerdrAgent, approverSessionName } from '../master.js';
import { boundLaunch } from '../master/approver-stall.js';
import { heldRework, heldSameGrounds } from '../server/held-rework.js';
import { heldApproverPaneIn, heldReworkNamedIn } from './decision-text.js';
import type { RoutineDecision } from './decisions.js';
import type { DaemonEffects } from './effects.js';
import { type ApprovalWatch, type DaemonState, approvalWatchSchema } from './state.js';
import { stepCallCarried } from './step-budget.js';
import { unknownRegistrySession } from '../fleet.js';

/** The applied rework that already holds an item, as the loop records it answered: no request is put, and no refusal recurs. */
export type HeldReworkAnswer = { id: string; detail: string };

/**
 * GY-1888: an applied rework the item still holds answers a rework request on the record, by the same judgement the control
 * plane refuses a second one with (heldRework, heldSameGrounds): no worker has submitted since, so the item waits for a worker
 * on the hold and a second rework authorizes nothing. The hold is adopted instead of putting the request and being refused on
 * every retry — GY-1846's put was, each refusal a counted decision fault, unbounded on an install where no worker can take the
 * hold. A request that already stands is this action's live decision and is left to its supervision (null here).
 */
export function heldReworkAnswer(item: Work, history: readonly unknown[], decision: RoutineDecision, standing: unknown): HeldReworkAnswer | null {
  if (standing || decision.action !== 'rework') return null;
  const holding = heldRework(item, history as Parameters<typeof heldRework>[1]);
  if (!holding || !heldSameGrounds(holding, decisionSituation('rework', item), decision.input ?? {}, item)) return null;
  const why = `applied${holding.situation?.sha ? ` for head ${holding.situation.sha.slice(0, 12)}` : ''} and no worker has submitted since`;
  return { id: holding.id, detail: `${item.key} already holds rework decision ${holding.id} (${why}), so a second rework authorizes nothing: the hold is adopted, nothing is requested, and the item waits for a worker on it` };
}

/**
 * The hold that appeared after the cycle's history read: the server refused the put naming the applied rework that holds the
 * item (heldReworkNamedIn). It is adopted for the same reason heldReworkAnswer adopts it, so a hold that answers the request is
 * never answered with a refused put again next cycle.
 */
export function refusedHeldReworkAnswer(item: Work, decision: RoutineDecision, error: unknown): HeldReworkAnswer | null {
  const applied = decision.action === 'rework' ? heldReworkNamedIn(error) : null;
  return applied ? { id: applied, detail: `${item.key} already holds rework decision ${applied}, which the control plane refused this request naming: a second rework authorizes nothing, so the hold is adopted, nothing is requested, and the item waits for a worker on it` } : null;
}

/** The settled watch an adopted hold leaves on the decision's key. */
export const heldReworkWatch = (item: Work, held: HeldReworkAnswer, stamp: string): ApprovalWatch =>
  approvalWatchSchema.parse({ work: item.key, action: 'rework', decision: held.id, requestedAt: stamp, settledAt: stamp });

type Launched = Awaited<ReturnType<NonNullable<DaemonEffects['approver']>>>;
/**
 * What the approver supervisor lends the held-name recovery: the effects the launch itself ran through — on the launcher beside
 * the cycle, the cycle's own unbounded ones, so a recovery that starts after the decisions step's budget is spent still reads
 * the inventory and is never refused unsent by it — its state, and the invalidation of its one Herdr inventory.
 */
export type HeldNameIo = { effects: DaemonEffects; state: DaemonState; stamp: string; invalidate: () => void; listingLost: (error: unknown) => never[] };

/**
 * GY-1888. The recovery a launch refused for its own session name takes before it fails: the runtime held the name for a pane
 * it names (heldApproverPaneIn), and a name derived from the item and the decision alone belongs to this decision's approver
 * alone, so the holder is this decision's own approver pane. The inventory that launch read is stale by then, so it is read
 * again: a session listed under the name is the approver, adopted exactly as a launch that had seen it would adopt it, its
 * pane-bound launch record dating it (`adopted`, no launch made); a pane listed under another name is a live session this
 * decision's name cannot be judged against, and is left alone; an unlisted pane is the leftover the failure's own remedy names
 * for a hand (`herdr pane close … on the host`): the registry session its pane-bound launch record names is ended first, so
 * the role's slot it held is free, then the pane is closed and the launch is made once more (`launched`). Anything else returns the launch's failure (`failed`) — the refusal itself, or the repeated launch's — so a name some live session holds is
 * never closed and a recovery that cannot be made never loops.
 */
export async function recoverHeldName(io: HeldNameIo, item: Work, watch: ApprovalWatch, error: unknown, relaunch: () => Promise<Launched>): Promise<{ adopted: string } | { launched: Launched; detail: string } | { failed: unknown; session?: string }> {
  const { effects, state } = io, name = approverSessionName(item, watch.decision), leftover = heldApproverPaneIn(error, name);
  if (!leftover || leftover === watch.pane) return { failed: error };
  io.invalidate();
  const read = async (): Promise<{ agents: HerdrAgent[]; available: boolean }> => await effects.herdr?.() ?? { agents: await effects.agents(), available: true };
  const fresh = await read().catch(() => ({ agents: [] as HerdrAgent[], available: false }));
  const relisted = fresh.available ? fresh.agents.find(candidate => candidate.name === name && candidate.pane_id) : undefined;
  const recorded = await effects.approverLaunch?.(name).catch(refusal => { if (stepCallCarried(refusal)) throw refusal; return null; }) ?? null;
  if (relisted) {
    const adopted = recorded?.pane && recorded.pane === relisted.pane_id ? recorded : null;
    Object.assign(watch, { agentName: name, pane: relisted.pane_id, launchedAt: boundLaunch(await effects.approverLaunches?.().catch(io.listingLost) ?? [], relisted)?.launchedAt ?? io.stamp, account: adopted?.account ?? null, runtime: adopted?.runtime ?? null, session: adopted?.session ?? null, capacity: null });
    await effects.persist(state);
    return { adopted: `the runtime held session name ${name} for pane ${leftover}, which the inventory lists again as ${relisted.pane_id}: it is adopted as the decision's approver; the decision is judged without a launch` };
  }
  if (!fresh.available || fresh.agents.some(candidate => candidate.pane_id === leftover)) return { failed: error };
  // The leftover's registry session still counts against the role's concurrency until it is ended; one the registry no longer
  // knows is ended already. One that could not be ended stays on the watch (session), so the next launch ends it first.
  const session = recorded?.pane === leftover ? recorded.session ?? null : null;
  if (session && effects.endRegistrySession) {
    try { await effects.endRegistrySession(session, `approver pane ${leftover} held session name ${name} while listed nowhere, and is closed so ${item.key}'s approver can launch`); }
    catch (refusal) { if (stepCallCarried(refusal)) throw refusal; if (!unknownRegistrySession(refusal)) return { failed: error, session }; }
  }
  try { await effects.closeSession(leftover); } catch { return { failed: error }; }
  io.invalidate();
  const detail = `closed leftover approver pane ${leftover}${session ? ` and ended its registry session ${session}` : ''}, which held session name ${name} while listed nowhere`;
  try { return { launched: await relaunch(), detail }; } catch (retry) { return { failed: retry }; }
}
