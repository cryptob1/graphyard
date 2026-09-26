import type { FaultInstance, FaultObservation } from './fault-classes.js';
import { wording } from './fault-wording.js';

// ---------------------------------------------------------------------------
// Tracking (GY-173): what the loop observes each cycle, as instances with a start and an end.
// Browser-safe like fault-classes.ts; split from it to keep each module within its budget.
// ---------------------------------------------------------------------------

/**
 * The loop's record: every instance it retains, the one each standing fault is, and each failing action's run, and
 * `since`, the first cycle that read every source (GY-374). Until then the record has no past to compare with, so what
 * it finds standing is marked `baseline`: already wrong before tracking began, not an occurrence inside the window.
 */
export interface FaultRecord { instances: FaultInstance[]; open: Record<string, string>; failing: Record<string, string>; since?: string | null }
export const retainedFaultInstances = 1000;
const instanceOf = (observation: FaultObservation, at: string, nth = 0): FaultInstance => ({ id: `${observation.kind}|${observation.subject.slice(0, 200)}|${at}${nth ? `#${nth}` : ''}`, kind: observation.kind, faultClass: observation.faultClass,
  subject: observation.subject.slice(0, 200), text: observation.text.slice(0, 500), at, lastSeenAt: at, linkedTo: null });
function retain(record: FaultRecord) { // drops the oldest past the bound: first those no standing fault or failing run names, then any, so the bound holds
  for (const spare of [new Set([...Object.values(record.open), ...Object.values(record.failing)]), new Set<string>()]) { let excess = record.instances.length - retainedFaultInstances;
    if (excess > 0) record.instances.splice(0, record.instances.length, ...record.instances.filter(entry => excess <= 0 || spare.has(entry.id) || excess-- <= 0)); }
  const kept = new Set(record.instances.map(entry => entry.id)); for (const refs of [record.open, record.failing]) for (const key of Object.keys(refs)) if (!kept.has(refs[key])) delete refs[key];
}
/**
 * One cycle's observations against the record. A fault that stood last cycle and still stands is
 * the same instance (its `lastSeenAt` moves); one not seen before, or seen again after it cleared,
 * is a new instance (n of one kind on one subject are n); one no longer observed has ended — unless the cycle's reads were `partial` (all of them, or a set of kinds), when an unread source ends nothing. Returns what opened. A fault is its kind, subject and wording less the figures that move while it stands (ages, counts, times, commits): one fixed while another of its kind appears on the subject ends, and the other opens.
 * What opens before the record's first complete cycle is `baseline` (see FaultRecord): a fresh record, a new coordinator
 * or the release that starts tracking finds every standing fault at once, and those are the installation's state, not recurrences.
 */
export function trackFaults(record: FaultRecord, observations: readonly FaultObservation[], at: string, partial: boolean | ReadonlySet<string> = false): FaultInstance[] {
  const opened: FaultInstance[] = [], seen = new Set<string>(), repeats = new Map<string, number>();
  // A record kept before GY-374 has no `since`, and one with a fault standing (none of them baseline) has tracked since its first instance.
  if (!record.since && Object.keys(record.open).length && !record.instances.some(entry => entry.baseline)) record.since = record.instances[0]?.at ?? at;
  const baseline = !record.since;
  for (const observation of observations) { // identical faults on one subject stand as that many instances, as the dashboard counts them
    const subject = observation.subject.slice(0, 200), base = `${observation.kind}|${subject}|${wording(observation.text)}`, nth = repeats.get(base) ?? 0, key = nth ? `${base}#${nth}` : base;
    repeats.set(base, nth + 1); seen.add(key);
    const standing = record.open[key] ? record.instances.find(entry => entry.id === record.open[key]) : undefined;
    if (standing) { standing.lastSeenAt = at; standing.text = observation.text.slice(0, 500); continue; }
    const instance = instanceOf(observation, at, opened.filter(entry => entry.kind === observation.kind && entry.subject === subject).length);
    if (baseline) instance.baseline = true;
    record.instances.push(instance); record.open[key] = instance.id; opened.push(instance);
  }
  if (partial !== true) for (const key of Object.keys(record.open)) if (!seen.has(key) && !(partial && partial.has(key.slice(0, key.indexOf('|'))))) delete record.open[key];
  if (baseline && partial !== true) record.since = at;
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
  const standing = record.failing[action] ? record.instances.find(entry => entry.id === record.failing[action]) : undefined;
  if (standing) { standing.lastSeenAt = at; return null; }
  const instance = noteFault(record, observation, at);
  if (record.instances.includes(instance)) record.failing[action] = instance.id;
  return instance;
}
