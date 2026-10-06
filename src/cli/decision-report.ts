import { agentOwner, approverSessionName, type AttentionItem, type HerdrAgent } from '../master.js';
import { standingCapacity, type CapacityState } from '../model/capacity.js';
import { elapsed } from '../model/sessions.js';
import { mapBounded, readConcurrency } from '../master/timings.js';
import { staleReleaseAttention } from './owed-report.js';
import { approverJudgeBoundMs, maxApproverLaunches } from '../daemon/decisions.js';

type DecisionRow = { id: string; action: string; state: string; requestedAt: string; requestedBy?: string; outcome?: string | null; race?: unknown; refusal?: { approver: string; reason: string; at: string } | null };
type ApprovalWatch = { work: string; decision: string; agentName: string | null; settledAt?: string | null; ended?: string[]; launches?: number; launchedAt?: string | null; exhaustedAt?: string | null };
export interface UnansweredDecision { work: string; id: string; action: string; requestedAt: string; session: string; ageMs: number; age: string; ended?: string[]; inMotionUntil?: string }

/**
 * GY-1337. How long after its approver's latest launch an unanswered decision the loop still
 * supervises is a relaunch in motion: the judge bound a session gets (`approverJudgeBoundMs`) and
 * five minutes for the loop to notice the session ended and launch the next. On 6 October 2026
 * GY-1335's requirements decision counted as `decision-unanswered` two minutes after its approver
 * pane vanished; the loop relaunched it (GY-551) eight minutes later and the approver judged it.
 */
export const approverRelaunchWaitBoundMs = approverJudgeBoundMs + 5 * 60_000;
/**
 * GY-1337. How long a refusal may stand before its line counts as a `decision-refused` fault: the
 * loop's master session reads it in `master status` on its next wake (the heartbeat is 30 minutes
 * at most by default) and answers it — a request citing it, or a different decision the item
 * needs. GY-1335's release was refused at 00:52 on 6 October 2026 because GY-1332's PR #813 was in
 * review, counted at once, and was answered by a requirements decision ten minutes later.
 */
export const refusalAnswerWaitBoundMs = 30 * 60_000;
/**
 * Until when an unanswered decision is a relaunch the loop is already making: its watch is
 * unsettled and unescalated, it counts launches and some remain, and the latest launch (or the request, before any)
 * is within `approverRelaunchWaitBoundMs`. A decision the loop does not watch, or one whose
 * launches are spent, has no bound and counts at once.
 */
export function unansweredInMotionUntil(watch: ApprovalWatch | undefined, requestedAt: string): string | undefined {
  if (!watch || watch.settledAt || watch.exhaustedAt || (watch.launches ?? maxApproverLaunches) >= maxApproverLaunches) return undefined;
  const since = Date.parse(watch.launchedAt ?? requestedAt);
  return Number.isFinite(since) ? new Date(since + approverRelaunchWaitBoundMs).toISOString() : undefined;
}

/**
 * Decisions left at `requested` with no live approver session (GY-141): the session the loop
 * launched for it — or, for one a master launched by hand, the name `master approver` gives it —
 * is gone from Herdr or reports `done`, and no outcome was ever recorded. That is a stall, not a
 * judgement: an approver that declines records `master refuse`, and its decision ends `refused`.
 * Nothing is concluded while Herdr cannot be read. An item waiting for an approver account to
 * reset is not one: the loop launches no approver before then, and master status names that wait
 * once, as the approver capacity line, not as a stall per decision (GY-182).
 */
export function unansweredDecisions(items: { key: string; decisions: DecisionRow[]; capacity?: CapacityState | null }[], approvals: ApprovalWatch[], runtime: { available: boolean; agents: HerdrAgent[] }, now: number): UnansweredDecision[] {
  if (!runtime.available) return [];
  return items.flatMap(item => standingCapacity(item, 'approver').length ? [] : item.decisions.flatMap(decision => {
    if (decision.state !== 'requested') return [];
    const watch = approvals.find(entry => entry.decision === decision.id);
    const session = watch?.agentName ?? approverSessionName(item, decision.id);
    const live = runtime.agents.find(agent => agent.name === session);
    if (live && live.agent_status !== 'done') return [];
    const ageMs = Math.max(0, now - Date.parse(decision.requestedAt));
    // How the loop's earlier sessions for this decision ended (GY-551): the reasons sit beside the
    // decision here, not only in the escalation detail. A decision the loop never watched has none.
    const inMotionUntil = unansweredInMotionUntil(watch, decision.requestedAt);
    return [{ work: item.key, id: decision.id, action: decision.action, requestedAt: decision.requestedAt, session, ageMs, age: elapsed(ageMs),
      ...(watch?.ended?.length ? { ended: watch.ended } : {}), ...(inMotionUntil ? { inMotionUntil } : {}) }];
  }));
}

/**
 * Decisions nothing will move without the master: a stale one — approval refused on a revision or
 * candidate race, so its pin can never hold again — a withdrawn one the requester took back, a
 * refused one an approver judged and declined with its reason, and an unanswered one whose
 * approver session ended without recording anything. A stale or refused decision raises master
 * attention only while it is still the latest decision for its action — a later decision of the
 * same action supersedes it, whatever its state; a withdrawn one is listed for the record and
 * never raises attention. A refusal is answered once its requester asks the item for any later
 * decision, of any action, not taken back (GY-1337): it acted on the refusal, so it raises nothing more; one still
 * unanswered carries `inMotionUntil` for `refusalAnswerWaitBoundMs` after it, the master's turn. A refusal is answered, never retried: the server refuses an identical
 * request, so the next step is a request that cites the refused decision with what it lacked.
 */
export async function terminalDecisions(masterApi: (path: string) => Promise<any>, work: { id: string; key: string; stage: string; ready?: boolean; capacity?: CapacityState | null }[],
  sessions: { approvals: ApprovalWatch[]; runtime: { available: boolean; agents: HerdrAgent[] }; now: number }) {
  const listed: { work: string; id: string; action: string; state: string; reason: string | null; race?: unknown; refusedBy?: string; refusedAt?: string }[] = [];
  const attentionItems: AttentionItem[] = [];
  const histories: { key: string; decisions: DecisionRow[]; capacity?: CapacityState | null }[] = [];
  let refused = 0;
  // One read per open item, at most `readConcurrency` in flight (GY-377): read one after another,
  // 170 open items at ~0.4 s each held every loop cycle and every status build for over a minute.
  const open = work.filter(item => item.stage !== 'done');
  const read = await mapBounded(open, readConcurrency, item => masterApi(`work/${item.id}/decisions`).catch(() => null));
  for (const [index, item] of open.entries()) {
    const history = read[index];
    const decisions: DecisionRow[] = history?.decisions ?? [];
    histories.push({ key: item.key, decisions, capacity: item.capacity });
    const latest = new Map<string, string>();
    for (const decision of decisions) latest.set(decision.action, decision.id);
    for (const decision of decisions) {
      if (decision.state === 'refused') {
        const by = decision.refusal?.approver ?? 'the approver', reason = decision.refusal?.reason ?? decision.outcome ?? null;
        listed.push({ work: item.key, id: decision.id, action: decision.action, state: 'refused', reason, refusedBy: by, ...(decision.refusal ? { refusedAt: decision.refusal.at } : {}) });
        if (latest.get(decision.action) !== decision.id || answeredRefusal(decision, decisions)) continue;
        refused += 1;
        const at = decision.refusal ? Date.parse(decision.refusal.at) : Number.NaN;
        attentionItems.push({ ...(Number.isFinite(at) ? { inMotionUntil: new Date(at + refusalAnswerWaitBoundMs).toISOString() } : {}), subject: item.key, text: `Decision ${decision.id} (${decision.action}) was refused by ${by}: ${reason ?? 'no reason recorded'}. Answer the refusal: an identical request is refused, so a new one must cite ${decision.id} with what the refused request lacked, or the item needs something else`,
          ...agentOwner('master', `Answer the refusal: graphyard master decide ${item.key} ${decision.action} [JSON|@FILE] REASON citing ${decision.id} and what it lacked, then graphyard master approver ${item.key} DECISION — or act on the refusal instead`, 'approver') });
        continue;
      }
      if (decision.state !== 'stale' && decision.state !== 'withdrawn') continue;
      listed.push({ work: item.key, id: decision.id, action: decision.action, state: decision.state, reason: decision.outcome ?? null, ...(decision.race ? { race: decision.race } : {}) });
      if (decision.state !== 'stale' || latest.get(decision.action) !== decision.id) continue;
      // A stale release of an item in backlog is owed: nothing else shows that it waits (GY-1294).
      const owed = decision.action === 'release' ? staleReleaseAttention(item, decisions, sessions.now) : null;
      if (owed) attentionItems.push(owed);
      else attentionItems.push({ subject: item.key, text: `Decision ${decision.id} (${decision.action}) is stale: ${decision.outcome ?? 'the item moved past it'}; request it again, the stale decision no longer blocks`,
          ...agentOwner('master', `graphyard master decide ${item.key} ${decision.action} [JSON|@FILE] REASON, then graphyard master approver ${item.key} DECISION`, 'approver') });
    }
  }
  const unanswered = unansweredDecisions(histories, sessions.approvals, sessions.runtime, sessions.now);
  for (const entry of unanswered)
    attentionItems.push({ subject: entry.work, text: `Decision ${entry.id} (${entry.action}) is unanswered after ${entry.age}: approver session ${entry.session} is not running and recorded no outcome${entry.ended?.length ? ` (${entry.ended.join('; ')})` : ''} — a stall, not a refusal`,
      ...agentOwner('master', `graphyard master approver ${entry.work} ${entry.id} [AGENT_KIND] puts it to a fresh approver`, 'approver'), ...(entry.inMotionUntil ? { inMotionUntil: entry.inMotionUntil } : {}) });
  return { listed, attentionItems, unanswered, refused };
}

/** Whether the refused decision's requester asked the item for a later decision, of any action and not taken back: the refusal's answer (GY-1337). */
function answeredRefusal(refused: DecisionRow, decisions: readonly DecisionRow[]): boolean {
  const at = Date.parse(refused.refusal?.at ?? refused.requestedAt);
  return !!refused.requestedBy && Number.isFinite(at) && decisions.some(other => other.id !== refused.id && other.requestedBy === refused.requestedBy
    && other.state !== 'withdrawn' && Date.parse(other.requestedAt) > at);
}
