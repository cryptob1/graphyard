import { demand } from './model/refusal.js';
import { actionStall } from './model/action-progress.js';
import type { ActionRow } from './model/actions.js';
import type { Work } from './model/work.js';

/**
 * The reason→remedy registry (GY-949): what clears each unchanged reason a stalled action row
 * keeps failing for, or which bounded decision owns it.
 *
 * A row that fails three times for one reason is stalled (`actionStall`), and until this registry
 * a stall was only reported: `master status` raised one attention whose whole instruction was
 * "Clear what that reason names", the row re-ran the impossibility on a widening backoff, and after
 * `livenessRetryLimit` failures it became an escalation addressed to whoever read it. On 29
 * September 2026 GY-864 and GY-515 sat that way on the App permission hold — a condition `master
 * browser installation-accept` exists to clear — and GY-947, GY-73 and GY-806 on a full worker role,
 * a condition only a capacity decision moves (GY-948).
 *
 * Each entry recognises one family of reasons and binds it to its remedy:
 *
 * - `installation-accept` — the control-plane App lacks a permission its installation has a
 *   pending request for. The loop applies it itself (`applies: 'loop'`): it runs the master browser
 *   installation-accept flow, app-permissions first when the flow reports the App does not yet
 *   request the permission, verifies through the API, and records the attempt and its outcome on
 *   the row exactly once per unchanged run (`recordStallRemedy`). A refused remedy escalates once
 *   with the refusal named (liveness.ts) and is never retried for that run.
 * - `capacity` — a role at its concurrency limit. Nothing the loop can run clears it: it is a
 *   capacity decision, owned by the master, and the lever is named — the role's concurrency in the
 *   agent registry, or a live session of the role ending.
 * - `installation-suspended` — the App's installation is suspended, which only the account that
 *   owns it can reinstate: a human decision.
 *
 * A reason no entry recognises keeps the generic instruction. Pure: nothing here runs a remedy.
 */

export const stallRemedyKinds = ['installation-accept', 'capacity', 'installation-suspended'] as const;
export type StallRemedyKind = typeof stallRemedyKinds[number];
/** The master browser flows a loop-applied remedy may run, in the order it may run them. */
export const remedyFlows = ['installation-accept', 'app-permissions'] as const;
export type RemedyFlow = typeof remedyFlows[number];

export interface BoundRemedy {
  kind: StallRemedyKind;
  /** `loop`: the loop applies the remedy itself; `decision`: a bounded decision `owner` makes. */
  applies: 'loop' | 'decision';
  owner: 'master' | 'human';
  /** The remedy named in one line, for an escalation's detail and the loop's own record. */
  remedy: string;
  /** What the attention names as the next step while no attempt of the remedy is recorded. */
  next: string;
}

const installationAccept = (app: string, permission: string, url: string): BoundRemedy => ({
  kind: 'installation-accept', applies: 'loop', owner: 'master',
  remedy: `graphyard master browser installation-accept (app-permissions first when the App does not yet request it), accepting App ${app}'s pending request for ${permission} at ${url}`,
  next: `Nothing to run by hand: the loop applies the sanctioned remedy itself — graphyard master browser installation-accept, app-permissions first when the App does not yet request ${permission} — once for this unchanged run, verifies the grant through the API and records the outcome on the row; the row's own recheck picks the granted permission up`,
});

/** Each family of stall reasons and the remedy it binds to; the first entry that recognises a reason binds it. */
export const stallRemedyRegistry: readonly { kind: StallRemedyKind; bind: (reason: string) => BoundRemedy | null }[] = [
  {
    kind: 'installation-suspended',
    bind: reason => /\binstallation \S+ is suspended\b/i.test(reason) ? { kind: 'installation-suspended', applies: 'decision', owner: 'human',
      remedy: 'reinstate the suspended GitHub App installation from the account that owns it',
      next: 'Reinstate the suspended GitHub App installation from the account that owns it; nothing the loop runs can, and the row\'s recheck picks the reinstated installation up' } : null,
  },
  {
    kind: 'installation-accept',
    // describeShortfall (src/github-permissions.ts) words every permission hold this way.
    bind: reason => {
      const hold = /\bApp (\S+) lacks ([A-Za-z ]+: (?:read|write|admin))\b.*?\baccept the pending permission request at (\S+?)[;,]?(?:\s|$)/.exec(reason);
      return hold ? installationAccept(hold[1], hold[2], hold[3]) : null;
    },
  },
  {
    kind: 'capacity',
    // The registry (src/fleet.ts, src/model/registry-sessions.ts) words a full role this way.
    bind: reason => {
      const full = /\brole (\S+) is at its concurrency limit \((\d+) of (\d+) live/.exec(reason);
      if (!full) return null;
      const [, role, live, limit] = full;
      const lever = `raise role ${role}'s concurrency in the agent registry (graphyard master registry role set ${role} ACCOUNT[,ACCOUNT…] --concurrency N --reason REASON, N above ${limit}) or let a live ${role} session end`;
      return { kind: 'capacity', applies: 'decision', owner: 'master', remedy: `a capacity decision: ${lever}`,
        next: `Role ${role} is full (${live} of ${limit} live), and retrying moves nothing: it is a capacity decision the master owns — ${lever}. The row is escalated to that decision with this lever named if it keeps failing, and is claimed within one recheck of a slot freeing` };
    },
  },
];

/** The remedy a stall reason binds to, or null when no entry recognises it. */
export function stallRemedy(reason: string): BoundRemedy | null {
  for (const entry of stallRemedyRegistry) { const bound = entry.bind(reason); if (bound) return bound; }
  return null;
}

// ---- The remedy record on the row ---------------------------------------------------------------

export const remedyOutcomes = ['applied', 'unchanged', 'refused'] as const;
export type RemedyOutcome = typeof remedyOutcomes[number];
/** One attempt of a loop-applied remedy, recorded on the row it was applied for. */
export interface RemedyRecord {
  remedy: StallRemedyKind;
  /** The unchanged reason the run failed for when the remedy was applied. */
  reason: string;
  at: string; by: string;
  outcome: RemedyOutcome;
  /** What the remedy did or why it was refused, as the flow reported it. */
  detail: string;
  /** The flows it ran, in order. */
  flows: RemedyFlow[];
}

/**
 * The remedy recorded for the row's current unchanged run of `reason`, or null when none is. A run
 * spans every copy of the row — an escalation retires the row and a lifted one opens it afresh — so
 * every copy is read. A record stands while nothing after it moved the row: no completion, no
 * reopening and no failure for another reason. The run's first failure is not the test, because a
 * long run outgrows the row's retained history and its first failure is trimmed away.
 */
export function standingRemedy(work: Pick<Work, 'actionQueue'>, id: string, reason: string): RemedyRecord | null {
  const copies = [...(work.actionQueue?.history ?? []), ...(work.actionQueue?.actions ?? [])].filter(row => row.id === id);
  const record = copies.map(row => row.remedy).filter((entry): entry is RemedyRecord => !!entry && entry.reason === reason)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
  if (!record) return null;
  const after = copies.flatMap(row => row.history).filter(entry => Date.parse(entry.at) > Date.parse(record.at));
  return after.some(entry => entry.event === 'completed' || entry.event === 'reopened' || entry.event === 'failed' && entry.reason !== reason) ? null : record;
}

/**
 * Record one attempt of a loop-applied remedy on the open row it was applied for. Refused unless
 * the row is still stalled on the reason the remedy was applied for and no attempt is recorded for
 * that run yet: one record per unchanged run, whoever asks.
 */
export function recordStallRemedy(work: Work, id: string, input: Omit<RemedyRecord, 'at' | 'by'>, by: string, now: Date): ActionRow {
  const row = work.actionQueue?.actions.find(entry => entry.id === id);
  demand(row, 'Action is not open on this work item', 404);
  const stall = actionStall(row!);
  demand(stall && stall.reason === input.reason, 'The row is no longer stalled on the reason the remedy was applied for', 409);
  const bound = stallRemedy(input.reason);
  demand(bound?.applies === 'loop' && bound.kind === input.remedy, `The reason does not bind to the ${input.remedy} remedy`, 409);
  demand(!standingRemedy(work, id, input.reason), 'A remedy is already recorded for this unchanged run', 409);
  row!.remedy = { ...input, at: now.toISOString(), by };
  return row!;
}

// ---- Applying a loop remedy ---------------------------------------------------------------------

/** What one master browser flow reported: its ledger outcome, whether the API verified it, and why. */
export interface FlowResult { outcome: 'applied' | 'unchanged' | 'refused'; verified: boolean; reason: string }
/** The refusal installation-accept gives while the App itself does not yet request the permission. */
export const appPermissionsFirst = 'run master browser app-permissions first';

/**
 * Apply the installation-accept remedy through `flow`: installation-accept, and when it is refused
 * because the App does not yet request the permission, app-permissions and installation-accept
 * again. A flow that throws is a refusal carrying its message. Never more than those three runs.
 */
export async function applyInstallationAccept(flow: (name: RemedyFlow) => Promise<FlowResult>): Promise<Pick<RemedyRecord, 'outcome' | 'detail' | 'flows'>> {
  const flows: RemedyFlow[] = [];
  const attempt = async (name: RemedyFlow): Promise<FlowResult> => {
    flows.push(name);
    try { return await flow(name); } catch (error) { return { outcome: 'refused', verified: false, reason: error instanceof Error ? error.message : String(error) }; }
  };
  let accepted = await attempt('installation-accept');
  if (accepted.outcome === 'refused' && accepted.reason.includes(appPermissionsFirst)) {
    const raised = await attempt('app-permissions');
    if (raised.outcome === 'refused') return { outcome: 'refused', detail: `app-permissions was refused: ${raised.reason}`.slice(0, 2000), flows };
    accepted = await attempt('installation-accept');
  }
  const outcome = accepted.outcome === 'refused' || !accepted.verified ? 'refused' : accepted.outcome;
  return { outcome, detail: `installation-accept ${accepted.outcome}${accepted.verified ? ', verified through the API' : ''}: ${accepted.reason}`.slice(0, 2000), flows };
}

/** The remedy as the attention and escalation name it once an attempt is recorded. */
export function describeRemedyRecord(record: RemedyRecord) {
  const ran = record.flows.join(', then ');
  return record.outcome === 'refused'
    ? `the loop's ${record.remedy} remedy (${ran}) was refused at ${record.at}: ${record.detail}`
    : `the loop applied the ${record.remedy} remedy (${ran}) at ${record.at}, ${record.outcome}: ${record.detail}`;
}
