import { z } from 'zod';
import { mergeableNow } from '../merge-queue.js';
import { isClosed } from './closure.js';
import { standingEscalations } from './escalation.js';
import type { FaultClass, FaultKind, FaultObservation } from './fault-classes.js';
import type { Work } from './work.js';

// ---------------------------------------------------------------------------
// System invariants (GY-404).
//
// Every gate judges one change against that change's criteria, so every fault found on 2026-09-25
// passed its own item's tests, review and proofs: the faults only appeared from interaction over
// time — follow-ups filed per approved head (GY-402), approvers never closed (GY-403), clean
// candidates refreshed on every merge (GY-375), cycles growing to minutes (GY-377), merges stalled
// on CLEAN and UNSTABLE pull requests (GY-344). Each was found by somebody reading the board hours
// late. These are the properties the running system must keep. The loop checks every one of them
// each cycle (src/daemon/faults.ts), reports each violation as a fault with its class — so a class
// that recurs files one structural item, like any other fault — and `master status` prints one
// line per invariant with its threshold and its reading. `tests/soak.test.ts` holds every one of
// them over a simulated day of the real loop, so a change that breaks one fails CI.
// ---------------------------------------------------------------------------

export const systemInvariants = ['follow-ups-per-parent', 'lingering-sessions', 'refresh-churn', 'merge-stall', 'cycle-p90', 'untriaged-backlog', 'deploy-lease-loss'] as const;
export type SystemInvariant = typeof systemInvariants[number];

/** The fault class each invariant's violation is an instance of: its recurrence files one item for that class. */
export const invariantFaultClass: Record<SystemInvariant, FaultClass> = {
  'follow-ups-per-parent': 'review-convergence', 'lingering-sessions': 'session-liveness', 'refresh-churn': 'merge', 'merge-stall': 'merge',
  'cycle-p90': 'loop', 'untriaged-backlog': 'stalled-gate', 'deploy-lease-loss': 'session-liveness',
};
/** The fault kind a violation is recorded under: `invariant:NAME`, one per invariant. */
export const invariantFaultKind = (invariant: SystemInvariant) => `invariant:${invariant}` as FaultKind;

/**
 * Each invariant's threshold, in master config under `invariants` (every field optional; these are
 * the defaults). A violation is a reading past its threshold.
 */
export const invariantThresholdsSchema = z.object({
  /** At most this many open follow-up items per parent item. */
  followUpsPerParent: z.number().int().min(1).max(100).default(1),
  /** No agent session open more than this long after its item is delivered or its decision settled. */
  sessionAfterSettleMinutes: z.number().int().min(1).max(1440).default(30),
  /** No candidate base-refreshed more than this many times without a head change of its own. */
  refreshesWithoutHeadChange: z.number().int().min(1).max(100).default(3),
  /** No item in the merge stage with a mergeable pull request for longer than this without a recorded refusal. */
  mergeableWithoutRefusalMinutes: z.number().int().min(1).max(1440).default(10),
  /** The loop's cycle p90 stays under this, over the last `cycleWindowMinutes`. */
  cycleP90Seconds: z.number().int().min(1).max(3600).default(30),
  cycleWindowMinutes: z.number().int().min(5).max(1440).default(60),
  /** Machine-filed backlog items left untriaged longer than this number at most `untriagedBacklogMax`. */
  untriagedBacklogHours: z.number().int().min(1).max(720).default(24),
  untriagedBacklogMax: z.number().int().min(0).max(1000).default(0),
  /** Worker leases lost within `deployWindowMinutes` of a control-plane deploy number at most `deployLeaseLosses`. */
  deployLeaseLosses: z.number().int().min(0).max(100).default(0),
  deployWindowMinutes: z.number().int().min(1).max(120).default(10),
}).strict();
export type InvariantThresholds = z.infer<typeof invariantThresholdsSchema>;
export const invariantDefaults: InvariantThresholds = invariantThresholdsSchema.parse({});

/**
 * What the loop carries between cycles to judge the invariants that are about history rather than
 * one snapshot: each candidate's base refreshes since its own last head change, when each merge-stage
 * candidate was first seen mergeable, the control-plane builds seen (a change is a deploy), the
 * lease losses seen, and the last cycle's report for `master status`.
 */
export const invariantRecordSchema = z.object({
  refreshes: z.record(z.string(), z.object({ head: z.string().max(64), count: z.number().int().min(0).max(10_000), seen: z.array(z.string().max(200)).max(20) }).strict()).default({}),
  mergeable: z.record(z.string(), z.object({ sha: z.string().max(64), since: z.string() }).strict()).default({}),
  builds: z.array(z.object({ commit: z.string().max(64), firstSeenAt: z.string(), lastSeenAt: z.string() }).strict()).max(20).default([]),
  losses: z.array(z.object({ work: z.string().max(40), at: z.string(), epoch: z.number().int().min(0).nullable() }).strict()).max(200).default([]),
  report: z.array(z.object({ invariant: z.enum(systemInvariants), faultClass: z.string().max(40), threshold: z.string().max(200), reading: z.string().max(500), holds: z.boolean(),
    observed: z.boolean(), subjects: z.array(z.string().max(40)).max(20), line: z.string().max(700) }).strict()).default([]),
  at: z.string().nullable().default(null),
}).strict();
export type InvariantRecord = z.infer<typeof invariantRecordSchema>;
export const emptyInvariantRecord = (): InvariantRecord => invariantRecordSchema.parse({});

/** One invariant as this cycle judged it: its threshold and reading, whether it holds, the items at fault, and its status line. */
export type InvariantCheck = InvariantRecord['report'][number];

/** What one cycle judges the invariants from. Everything but `work` and `now` may be missing; an invariant whose source is missing is not observed. */
export interface InvariantInput {
  work: readonly Work[];
  now: number;
  thresholds?: Partial<InvariantThresholds>;
  /** The loop's retained cycle measures: when each ran and how long it took. */
  metrics?: readonly { at: string; durationMs: number }[];
  /** The decisions the loop put to approvers: which session judged each and when it settled. */
  approvals?: Readonly<Record<string, { work: string; agentName: string | null; pane: string | null; settledAt: string | null }>>;
  /** Herdr's listing this cycle; null when Herdr could not be read. */
  agents?: readonly { name?: string; pane_id?: string }[] | null;
  /** The build the control plane reports it runs; null when it could not be read. */
  build?: string | null;
  /** Items whose current candidate's guarded merge was refused, with the refusal recorded (the loop's merge action failed). */
  refusedMerges?: ReadonlySet<string>;
}

/** The follow-up item's one proof (review-threads.ts `followUpTriageProof`): what marks a machine-filed follow-up. */
export const followUpProof = 'manual:review-followups-triaged';
/** The parent a follow-up item was filed for: the approved item it depends on, or null for any other item. */
export function followUpParent(work: Pick<Work, 'criteria' | 'dependencies' | 'title'>): string | null {
  const followUp = work.criteria.some(criterion => criterion.proofs.includes(followUpProof)) || /^Follow-ups from the approved review of /.test(work.title);
  return followUp ? work.dependencies[0] ?? null : null;
}
/** Filed by the product rather than a person: a follow-up of an approval, a recurring fault class, or an intervention pattern. */
export const machineFiled = (work: Pick<Work, 'criteria' | 'dependencies' | 'title' | 'origin'>) => followUpParent(work) !== null || !!work.origin?.faultClass || !!work.origin?.pattern;

/** An approver session's name: the role word, the item's key, and the decision's id (master/autonomy.ts `approverSessionName`). */
const approverNamePattern = /^(?:graphyard|gy)-approver-(gy-\d+)-[0-9a-f]+$/;
const open = (work: Work) => work.stage !== 'done' && !isClosed(work);
const time = (value: string | null | undefined) => { const parsed = value ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : null; };
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
const keysOf = (work: readonly Work[], ids: Iterable<string>) => [...new Set(ids)].map(id => work.find(item => item.id === id)?.key ?? id).slice(0, 20);
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null; };

/**
 * Every invariant, judged over this cycle's snapshot and the record carried from earlier cycles,
 * which it updates. One check per invariant, in `systemInvariants` order.
 */
export function checkInvariants(record: InvariantRecord, input: InvariantInput): InvariantCheck[] {
  const limits = invariantThresholdsSchema.parse(input.thresholds ?? {});
  const { work, now } = input, at = new Date(now).toISOString();
  const checks: InvariantCheck[] = [];
  const judge = (invariant: SystemInvariant, threshold: string, reading: string, holds: boolean, subjects: string[] = [], observed = true) => {
    const line = `${invariant}: ${observed ? holds ? 'holds' : 'VIOLATED' : 'not observed'} — ${reading} (threshold: ${threshold})`;
    checks.push({ invariant, faultClass: invariantFaultClass[invariant], threshold, reading: reading.slice(0, 500), holds: holds || !observed, observed, subjects: subjects.slice(0, 20), line: line.slice(0, 700) });
  };

  // 1. At most one open follow-up item per parent (GY-402: 170 follow-ups for 40 parents).
  const followUps = new Map<string, string[]>();
  for (const item of work.filter(open)) { const parent = followUpParent(item); if (parent) followUps.set(parent, [...(followUps.get(parent) ?? []), item.key]); }
  const crowded = [...followUps].filter(([, items]) => items.length > limits.followUpsPerParent);
  const most = Math.max(0, ...[...followUps.values()].map(items => items.length));
  judge('follow-ups-per-parent', `at most ${limits.followUpsPerParent} open follow-up item(s) per parent`,
    crowded.length ? `${crowded.length} parent(s) hold more, the most ${most}: ${keysOf(work, [crowded[0][0]])[0]} has ${crowded[0][1].join(', ')}` : `the most open follow-ups on one parent is ${most}`,
    !crowded.length, keysOf(work, crowded.map(([parent]) => parent)));

  // 2. No agent session open past its bound after its item is delivered or its decision settled (GY-403).
  const bound = limits.sessionAfterSettleMinutes * 60_000;
  if (input.agents) {
    const listed = (name: string | null | undefined, pane: string | null | undefined) => input.agents!.some(agent => (!!name && agent.name === name) || (!!pane && agent.pane_id === pane));
    const lingering: { subject: string; detail: string }[] = [];
    for (const item of work.filter(entry => entry.stage === 'done')) {
      const settled = time(item.delivery?.mergedAt) ?? time(item.closure?.at);
      if (settled === null || now - settled <= bound) continue;
      for (const session of item.sessions ?? []) if (session.state === 'running' && !session.endedAt && listed(session.agentName, session.pane))
        lingering.push({ subject: item.key, detail: `${session.kind} session ${session.agentName ?? session.pane ?? session.id} on ${item.key}, ${minutes(now - settled)} after it was delivered` });
    }
    const named = new Set<string>();
    for (const watch of Object.values(input.approvals ?? {})) {
      const settled = time(watch.settledAt);
      if (settled !== null && now - settled > bound && listed(watch.agentName, watch.pane)) { lingering.push({ subject: watch.work, detail: `approver session ${watch.agentName ?? watch.pane} on ${watch.work}, ${minutes(now - settled)} after its decision settled` }); if (watch.agentName) named.add(watch.agentName); }
    }
    // An approver the loop no longer watches — launched by hand (`master approver`, GY-403), or its watch retired — is
    // known by its name (master/autonomy.ts `approverSessionName`), which carries the item's key.
    for (const agent of input.agents) {
      const key = approverNamePattern.exec(agent.name ?? '')?.[1], item = key ? work.find(entry => entry.key.toLowerCase() === key) : undefined;
      const settled = item?.stage === 'done' ? time(item.delivery?.mergedAt) ?? time(item.closure?.at) : null;
      if (item && settled !== null && now - settled > bound && !named.has(agent.name!)) lingering.push({ subject: item.key, detail: `approver session ${agent.name} on ${item.key}, ${minutes(now - settled)} after it was delivered` });
    }
    judge('lingering-sessions', `no session open ${limits.sessionAfterSettleMinutes} min after its item is delivered or its decision settled`,
      lingering.length ? `${lingering.length} session(s) still open, e.g. ${lingering[0].detail}` : 'no session outlived its item or decision', !lingering.length, lingering.map(entry => entry.subject));
  } else judge('lingering-sessions', `no session open ${limits.sessionAfterSettleMinutes} min after its item is delivered or its decision settled`, 'Herdr could not be read this cycle', true, [], false);

  // 3. No candidate base-refreshed past its bound without a head change of its own (GY-375). A base
  //    refresh the control plane recorded, or a queue tip it merged the base into, is one refresh;
  //    a head that is neither the refresh's nor the tip's output is the worker's own and starts over.
  const live = new Set<string>();
  for (const item of work.filter(entry => open(entry) && !!entry.candidate)) {
    live.add(item.id);
    const head = item.candidate!.sha, refresh = item.baseRefresh ?? null, tip = item.queue?.speculation ?? null;
    const entry = record.refreshes[item.id] ?? { head, count: 0, seen: [] };
    const produced = new Set([refresh?.head, tip?.tip].filter((sha): sha is string => !!sha));
    if (entry.head !== head && !produced.has(head)) entry.count = 0; // the refreshes already seen stay seen: only a new one counts
    entry.head = head;
    const events = [refresh ? `refresh:${refresh.base}:${refresh.at}` : null, tip?.merge ? `tip:${tip.tip}:${tip.base}` : null].filter((event): event is string => !!event);
    for (const event of events) if (!entry.seen.includes(event)) { entry.count += 1; entry.seen = [...entry.seen, event].slice(-20); }
    record.refreshes[item.id] = entry;
  }
  for (const id of Object.keys(record.refreshes)) if (!live.has(id)) delete record.refreshes[id];
  const churned = Object.entries(record.refreshes).filter(([, entry]) => entry.count > limits.refreshesWithoutHeadChange);
  const churn = Math.max(0, ...Object.values(record.refreshes).map(entry => entry.count));
  judge('refresh-churn', `at most ${limits.refreshesWithoutHeadChange} base refreshes per candidate without a head change of its own`,
    churned.length ? `${churned.length} candidate(s) past it, the most ${churn} refreshes on ${keysOf(work, [churned[0][0]])[0]}` : `the most refreshes without a head change is ${churn}`, !churned.length, keysOf(work, churned.map(([id]) => id)));

  // 4. No merge-stage item with a mergeable pull request past its bound without a recorded refusal (GY-344, #206).
  const mergeBound = limits.mergeableWithoutRefusalMinutes * 60_000, waiting = new Set<string>(), stalled: { key: string; ms: number }[] = [];
  for (const item of work.filter(open)) {
    const observation = item.observation, candidate = item.candidate;
    // Once GitHub was asked, its own MergeStateStatus says whether it can merge the head (CLEAN, UNSTABLE, HAS_HOOKS),
    // as `master status` judges a stalled merge (merge-queue.ts `mergeStalls`); a queued entry waits on its merge group.
    const github = observation?.githubQueue && observation.githubQueue.head === candidate?.sha ? observation.githubQueue : null;
    const mergeable = item.stage === 'merge' && !!candidate && !!observation && observation.mergeable === true && !observation.merged && observation.candidate.sha === candidate.sha
      && (!github || !github.queue && mergeableNow(github));
    // A gate still failing is a recorded refusal (its reasons are on the item), and so are a refused guarded merge and GitHub's refusal of the request.
    const refused = !item.gates.every(gate => gate.passed) || item.violations.length > 0 || !!input.refusedMerges?.has(item.id) || !!github?.refused;
    if (!mergeable || refused) continue;
    waiting.add(item.id);
    const entry = record.mergeable[item.id]?.sha === candidate!.sha ? record.mergeable[item.id] : { sha: candidate!.sha, since: at };
    record.mergeable[item.id] = entry;
    const ms = now - Date.parse(entry.since);
    if (ms > mergeBound) stalled.push({ key: item.key, ms });
  }
  for (const id of Object.keys(record.mergeable)) if (!waiting.has(id)) delete record.mergeable[id];
  judge('merge-stall', `no merge-stage item mergeable ${limits.mergeableWithoutRefusalMinutes} min without a recorded refusal`,
    stalled.length ? `${stalled.length} item(s) mergeable and unmerged with nothing refusing them, the longest ${stalled[0].key} for ${minutes(Math.max(...stalled.map(entry => entry.ms)))}` : `${waiting.size} mergeable item(s), none past the bound`, !stalled.length, stalled.map(entry => entry.key));

  // 5. The loop's cycle p90 over the window stays under its bound (GY-377).
  const from = now - limits.cycleWindowMinutes * 60_000;
  const durations = (input.metrics ?? []).filter(metric => (time(metric.at) ?? -Infinity) >= from).map(metric => metric.durationMs);
  const p90 = percentile(durations, 0.9);
  if (p90 === null) judge('cycle-p90', `p90 under ${limits.cycleP90Seconds} s over ${limits.cycleWindowMinutes} min`, 'no cycle measured in the window', true, [], false);
  else judge('cycle-p90', `p90 under ${limits.cycleP90Seconds} s over ${limits.cycleWindowMinutes} min`, `p90 ${(p90 / 1000).toFixed(1)} s over ${durations.length} cycle(s)`, p90 < limits.cycleP90Seconds * 1000);

  // 6. Machine-filed backlog items untriaged past the bound number at most the threshold (zero).
  const triageBound = limits.untriagedBacklogHours * 3_600_000;
  const untriaged = work.filter(item => open(item) && item.stage === 'backlog' && !item.ready && machineFiled(item) && now - (time(item.createdAt) ?? now) > triageBound);
  judge('untriaged-backlog', `at most ${limits.untriagedBacklogMax} machine-filed backlog item(s) untriaged past ${limits.untriagedBacklogHours} h`,
    untriaged.length ? `${untriaged.length} untriaged, the oldest ${untriaged[0].key}` : 'every machine-filed backlog item is triaged or younger than the bound', untriaged.length <= limits.untriagedBacklogMax, untriaged.map(item => item.key));

  // 7. No worker lease lost to a deploy: a lease-loss raised within the window after the control plane's build changed.
  const retain = now - 24 * 3_600_000;
  for (const item of work) for (const escalation of standingEscalations(item)) {
    if (escalation.trigger !== 'lease-loss' || escalation.actor !== 'graphyard' || record.losses.some(loss => loss.work === item.key && loss.at === escalation.at)) continue;
    const epoch = /lost lease epoch (\d+)/.exec(escalation.reason)?.[1];
    record.losses.push({ work: item.key, at: escalation.at, epoch: epoch ? Number(epoch) : null });
  }
  record.losses = record.losses.filter(loss => (time(loss.at) ?? 0) >= retain).slice(-200);
  if (input.build) {
    const last = record.builds.at(-1);
    if (last?.commit === input.build) last.lastSeenAt = at;
    else record.builds = [...record.builds, { commit: input.build, firstSeenAt: at, lastSeenAt: at }].slice(-20);
  }
  // A deploy happened between the last cycle that saw the old build and the first that saw the new one.
  const deploys = record.builds.slice(1).map((build, index) => ({ commit: build.commit, from: Date.parse(record.builds[index].lastSeenAt), to: Date.parse(build.firstSeenAt) }));
  const windowMs = limits.deployWindowMinutes * 60_000;
  const lost = record.losses.filter(loss => { const when = time(loss.at); return when !== null && deploys.some(deploy => when >= deploy.from && when <= deploy.to + windowMs); });
  if (!record.builds.length) judge('deploy-lease-loss', `at most ${limits.deployLeaseLosses} lease(s) lost within ${limits.deployWindowMinutes} min of a deploy`, 'the control plane reported no build this cycle', true, [], false);
  else judge('deploy-lease-loss', `at most ${limits.deployLeaseLosses} lease(s) lost within ${limits.deployWindowMinutes} min of a deploy`,
    lost.length ? `${lost.length} lease(s) lost to a deploy, e.g. ${lost[0].work} at ${lost[0].at}` : `${deploys.length} deploy(s) seen, no lease lost to one`, lost.length <= limits.deployLeaseLosses, lost.map(loss => loss.work));

  record.report = checks; record.at = at;
  return checks;
}

/**
 * The faults this cycle's checks report: exactly one per violated invariant, whatever number of
 * items it holds, so a violation that keeps standing is one fault instance and a class that
 * recurs files one item. The wording names the threshold, a count and the first subject only, so a
 * reading that moves while the violation stands does not read as a new fault; the reading itself is
 * on the invariant's `master status` line.
 */
export function invariantFaults(checks: readonly InvariantCheck[]): FaultObservation[] {
  return checks.filter(check => check.observed && !check.holds).map(check => ({
    kind: invariantFaultKind(check.invariant), faultClass: check.faultClass as FaultClass, subject: `invariant:${check.invariant}`,
    text: `System invariant ${check.invariant} is violated (threshold: ${check.threshold}) by ${check.subjects.length} subject(s)${check.subjects.length ? `, first ${check.subjects[0]}` : ''}`.slice(0, 500),
  }));
}
/** The invariant kinds a cycle that could not read Herdr leaves unobserved. */
export const herdrInvariantKinds: readonly string[] = [invariantFaultKind('lingering-sessions')];
