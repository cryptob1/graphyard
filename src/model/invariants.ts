import { z } from 'zod';
import { isClosed } from './closure.js';
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
// each cycle, and `master status` prints one line per invariant with its threshold and its reading. The soak suites (`tests/soak-*.test.ts`)
// hold every one of them over simulated days of the real loop, so a change that breaks one fails CI.
// ---------------------------------------------------------------------------

export const systemInvariants = ['lingering-sessions', 'refresh-churn', 'merge-stall'] as const;
export type SystemInvariant = typeof systemInvariants[number];


/**
 * Each invariant's threshold, in master config under `invariants` (every field optional; these are
 * the defaults). A violation is a reading past its threshold.
 */
export const invariantThresholdsSchema = z.object({
  /** Retired (GY-2875): the follow-up and triage invariants; a config written before keeps parsing. */
  followUpsPerParent: z.unknown().optional(), untriagedBacklogHours: z.unknown().optional(), untriagedBacklogMax: z.unknown().optional(),
  /** No agent session open more than this long after its item is delivered or its decision settled. */
  sessionAfterSettleMinutes: z.number().int().min(1).max(1440).default(30),
  /** No candidate base-refreshed more than this many times without a head change of its own. */
  refreshesWithoutHeadChange: z.number().int().min(1).max(100).default(3),
  /** No item in the merge stage with a mergeable pull request for longer than this without a recorded refusal. */
  mergeableWithoutRefusalMinutes: z.number().int().min(1).max(1440).default(10),
  /** Retired (GY-2876): the cycle-p90 invariant; a config written before keeps parsing. */
  cycleP90Seconds: z.unknown().optional(), cycleWindowMinutes: z.unknown().optional(),
}).strict();
export type InvariantThresholds = z.infer<typeof invariantThresholdsSchema>;
export const invariantDefaults: InvariantThresholds = invariantThresholdsSchema.parse({});

/**
 * What the loop carries between cycles to judge the invariants that are about history rather than
 * one snapshot: each candidate's base refreshes since its own last head change, when each merge-stage
 * candidate was first seen mergeable, and the last cycle's report for `master status`.
 */
export const invariantRecordSchema = z.object({
  refreshes: z.record(z.string(), z.object({ head: z.string().max(64), count: z.number().int().min(0).max(10_000), seen: z.array(z.string().max(200)).max(20) }).strict()).default({}),
  mergeable: z.record(z.string(), z.object({ sha: z.string().max(64), since: z.string() }).strict()).default({}),
  /** Retired with the lease-loss escalation (GY-2874): a cursor written before keeps parsing. */
  builds: z.unknown().optional(), losses: z.unknown().optional(),
  report: z.preprocess(entries => Array.isArray(entries) ? entries.filter(entry => (systemInvariants as readonly unknown[]).includes(entry?.invariant)) : entries, z.array(z.object({ invariant: z.enum(systemInvariants), /** Retired (GY-2873): a cursor written before keeps parsing. */ faultClass: z.unknown().optional(), threshold: z.string().max(200), reading: z.string().max(500), holds: z.boolean(),
    observed: z.boolean(), subjects: z.array(z.string().max(40)).max(20), line: z.string().max(700) }).strict())).default([]),
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
  /** The session runtime's listing this cycle; null when it could not be read. */
  agents?: readonly { name?: string; pane_id?: string }[] | null;
  /** The build the control plane reports it runs; null when it could not be read. */
  build?: string | null;
}

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
    checks.push({ invariant, threshold, reading: reading.slice(0, 500), holds: holds || !observed, observed, subjects: subjects.slice(0, 20), line: line.slice(0, 700) });
  };

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
    judge('lingering-sessions', `no session open ${limits.sessionAfterSettleMinutes} min after its item is delivered or its decision settled`,
      lingering.length ? `${lingering.length} session(s) still open, e.g. ${lingering[0].detail}` : 'no session outlived its item or decision', !lingering.length, lingering.map(entry => entry.subject));
  } else judge('lingering-sessions', `no session open ${limits.sessionAfterSettleMinutes} min after its item is delivered or its decision settled`, 'the session runtime could not be read this cycle', true, [], false);

  // 3. No candidate base-refreshed past its bound without a head change of its own (GY-375). A base
  //    refresh the control plane recorded is one refresh; a head that is not the refresh's output is
  //    the worker's own and starts over.
  const live = new Set<string>();
  for (const item of work.filter(entry => open(entry) && !!entry.candidate)) {
    live.add(item.id);
    const head = item.candidate!.sha, refresh = item.baseRefresh ?? null;
    const entry = record.refreshes[item.id] ?? { head, count: 0, seen: [] };
    if (entry.head !== head && refresh?.head !== head) entry.count = 0; // the refreshes already seen stay seen: only a new one counts
    entry.head = head;
    const events = refresh ? [`refresh:${refresh.base}:${refresh.at}`] : [];
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
    const mergeable = item.stage === 'merge' && !!candidate && !!observation && observation.mergeable === true && !observation.merged && observation.candidate.sha === candidate.sha;
    // A gate still failing is a recorded refusal (its reasons are on the item).
    const refused = !item.gates.every(gate => gate.passed) || item.violations.length > 0;
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

  record.report = checks; record.at = at;
  return checks;
}

