// Concern: the loop's fault record (GY-173) — which observations are one standing fault, when one ends,
// and each failing action's run, bounded. The catalogue and classification stay in fault-classes.ts.
import type { FaultInstance, FaultObservation } from './fault-classes.js';
import { wording } from './fault-wording.js';

/**
 * The loop's record: every instance it retains, the one each standing fault is, and each failing action's run.
 * The per-item `linked` map of GY-1632 is gone with instance linking (GY-2186): a cursor still carrying it drops it on read.
 */
export interface FaultRecord { instances: FaultInstance[]; open: Record<string, string>; failing: Record<string, string>; observedAt?: string }
export const retainedFaultInstances = 1000;
const instanceOf = (observation: FaultObservation, at: string, nth = 0): FaultInstance => ({ id: `${observation.kind}|${observation.subject.slice(0, 200)}|${at}${nth ? `#${nth}` : ''}`, kind: observation.kind, faultClass: observation.faultClass,
  subject: observation.subject.slice(0, 200), text: observation.text.slice(0, 500), at, lastSeenAt: at, linkedTo: null });
function retain(record: FaultRecord) { // drops the oldest past the bound: first those no standing fault or failing run names, then any, so the bound holds
  for (const spare of [new Set([...Object.values(record.open), ...Object.values(record.failing)]), new Set<string>()]) { let excess = record.instances.length - retainedFaultInstances;
    if (excess > 0) record.instances.splice(0, record.instances.length, ...record.instances.filter(entry => excess <= 0 || spare.has(entry.id) || excess-- <= 0)); }
  const kept = new Set(record.instances.map(entry => entry.id)); for (const refs of [record.open, record.failing]) for (const key of Object.keys(refs)) if (!kept.has(refs[key]) && !refs[key].startsWith('held:')) delete refs[key];
}
/** The decision a `decision-unanswered` line is about. */
const unansweredDecision = (observation: { kind: string; text: string }) => observation.kind === 'decision-unanswered' ? /^Decision (\S+) \(/.exec(observation.text)?.[1] : undefined;
/** The action key of the approver-exhaustion escalation that restates a decision's stall. */
export const exhaustionEscalationKey = (decision: string) => `escalation:decision-unjudged:${decision}`;
/**
 * GY-1751: an approver-exhaustion escalation restates the stall `decision-unanswered` counts for the same decision, so one stall is
 * one instance. Whichever is observed second is the restatement: the escalation is not counted while the unanswered line stands
 * (`unansweredStands`), and an unanswered line opening after the escalation's instance absorbs it. An escalation whose decision was
 * settled or never observed unanswered stays the instance it is.
 */
export function unansweredStands(record: Pick<FaultRecord, 'open' | 'instances'>, action: string) {
  const prefix = exhaustionEscalationKey('');
  if (!action.startsWith(prefix)) return false;
  const decision = action.slice(prefix.length);
  return Object.values(record.open).some(id => { const entry = record.instances.find(instance => instance.id === id); return entry && unansweredDecision(entry) === decision; });
}
/** An exhaustion escalation's failing run: held out of the instances (as `held:` JSON under `failing`) until a full observation has looked for its decision's unanswered line (settleHeld). */
const heldEscalation = (key: string, outcome: string) => key.startsWith(exhaustionEscalationKey('')) && (outcome === 'failed' || outcome === 'indeterminate');
const heldPrefix = 'held:';
function absorbEscalation(record: FaultRecord, observation: FaultObservation) {
  const decision = unansweredDecision(observation), id = decision && record.failing[exhaustionEscalationKey(decision)];
  if (!id) return;
  if (!id.startsWith(heldPrefix)) record.instances = record.instances.filter(entry => entry.id !== id);
  delete record.failing[exhaustionEscalationKey(decision)];
}
/** Held escalations no unanswered line absorbed in this observation are the exhausted runs they are: each becomes its instance once. */
function settleHeld(record: FaultRecord) {
  for (const [key, held] of Object.entries(record.failing)) {
    if (!held.startsWith(heldPrefix)) continue;
    const { observation, at } = JSON.parse(held.slice(heldPrefix.length)) as { observation: FaultObservation; at: string };
    delete record.failing[key];
    if (unansweredStands(record, key)) continue;
    const instance = noteFault(record, observation, at);
    if (record.instances.includes(instance)) record.failing[key] = instance.id;
  }
}
/** Whether this observation left the `decision-unanswered` source unread (a failed or cut read), so an escalation's absorbing line may be missing. */
const unansweredUnread = (partial: boolean | ReadonlySet<string>) => partial === true || (partial !== false && partial.has('decision-unanswered'));
/**
 * One cycle's observations against the record. A fault that stood last cycle and still stands is
 * the same instance (its `lastSeenAt` moves); one not seen before, or seen again after it cleared,
 * is a new instance (n of one kind on one subject are n); one no longer observed has ended — unless the cycle's reads were `partial` (all of them, or a set of kinds), when an unread source ends nothing. Returns what opened. A fault is its kind, subject and wording less the figures that move while it stands (ages, counts, times): one fixed while another of its kind appears on the subject ends, and the other opens.
 * The one exception is a kind that stands once on its subject and is observed once again, reworded: with nothing to tell
 * it from, it is the same fault whose line changed (a blocker restated, an attention line's reason updated), so it keeps its
 * instance rather than counting one cause twice toward its class.
 */
export function trackFaults(record: FaultRecord, observations: readonly FaultObservation[], at: string, partial: boolean | ReadonlySet<string> = false): FaultInstance[] {
  const opened: FaultInstance[] = [], seen = new Set<string>(), repeats = new Map<string, number>();
  const where = (kind: string, subject: string) => `${kind}|${subject.slice(0, 200)}`, observed = new Map<string, number>(), standingOn = new Map<string, string[]>();
  for (const observation of observations) observed.set(where(observation.kind, observation.subject), (observed.get(where(observation.kind, observation.subject)) ?? 0) + 1);
  for (const [key, id] of Object.entries(record.open)) { const entry = record.instances.find(instance => instance.id === id); if (entry) standingOn.set(where(entry.kind, entry.subject), [...(standingOn.get(where(entry.kind, entry.subject)) ?? []), key]); }
  for (const observation of observations) { // identical faults on one subject stand as that many instances, as the dashboard counts them
    const subject = observation.subject.slice(0, 200), base = `${observation.kind}|${subject}|${wording(observation.text)}`, nth = repeats.get(base) ?? 0, key = nth ? `${base}#${nth}` : base;
    repeats.set(base, nth + 1); seen.add(key);
    const alone = standingOn.get(where(observation.kind, subject)), reworded = !record.open[key] && observed.get(where(observation.kind, subject)) === 1 && alone?.length === 1 ? alone[0] : undefined;
    if (reworded) { record.open[key] = record.open[reworded]; delete record.open[reworded]; }
    const standing = record.open[key] ? record.instances.find(entry => entry.id === record.open[key]) : undefined;
    if (standing) { standing.lastSeenAt = at; standing.text = observation.text.slice(0, 500); absorbEscalation(record, observation); continue; } // a standing line that now names another decision restates that decision's escalation
    const instance = instanceOf(observation, at, opened.filter(entry => entry.kind === observation.kind && entry.subject === subject).length);
    record.instances.push(instance); record.open[key] = instance.id; opened.push(instance);
    absorbEscalation(record, observation);
  }
  if (!unansweredUnread(partial)) settleHeld(record); // a partial observation may not have read the unanswered line, so it settles nothing
  if (partial !== true) for (const key of Object.keys(record.open)) if (!seen.has(key) && !(partial && partial.has(key.slice(0, key.indexOf('|'))))) delete record.open[key];
  retain(record);
  return opened;
}
/** A fault that happens once rather than stands — a failed cycle — as its own instance. */
export function noteFault(record: FaultRecord, observation: FaultObservation, at: string): FaultInstance {
  const instance = instanceOf(observation, at); record.instances.push(instance); retain(record);
  return instance;
}

/**
 * A loop action's outcome. The action history keeps every failure it saw, so none is read back from it: an
 * action failing opens one instance, its further failures before a success are that instance, a success ends it.
 */
export function noteActionOutcome(record: FaultRecord, action: string, outcome: 'started' | 'done' | 'failed' | 'indeterminate' | 'waiting', observation: FaultObservation, at: string): FaultInstance | null {
  if (outcome === 'done') { delete record.failing[action]; return null; }
  if (outcome === 'started' || outcome === 'waiting') return null;
  if (heldEscalation(action, outcome) && !record.failing[action]) { record.failing[action] = `${heldPrefix}${JSON.stringify({ observation, at })}`; return null; }
  if (record.failing[action]?.startsWith(heldPrefix)) return null;
  const standing = record.failing[action] ? record.instances.find(entry => entry.id === record.failing[action]) : undefined;
  if (standing) { standing.lastSeenAt = at; return null; }
  const instance = noteFault(record, observation, at);
  if (record.instances.includes(instance)) record.failing[action] = instance.id;
  return instance;
}
