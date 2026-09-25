import { agentOwner, approverSessionName, type AttentionItem, type HerdrAgent } from '../master.js';
import { standingCapacity, type CapacityState } from '../model/capacity.js';
import { elapsed } from '../model/sessions.js';

type DecisionRow = { id: string; action: string; state: string; requestedAt: string; outcome?: string | null; race?: unknown; refusal?: { approver: string; reason: string; at: string } | null };
type ApprovalWatch = { work: string; decision: string; agentName: string | null; settledAt?: string | null };
export interface UnansweredDecision { work: string; id: string; action: string; requestedAt: string; session: string; ageMs: number; age: string }

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
    const session = approvals.find(watch => watch.decision === decision.id)?.agentName ?? approverSessionName(item, decision.id);
    const live = runtime.agents.find(agent => agent.name === session);
    if (live && live.agent_status !== 'done') return [];
    const ageMs = Math.max(0, now - Date.parse(decision.requestedAt));
    return [{ work: item.key, id: decision.id, action: decision.action, requestedAt: decision.requestedAt, session, ageMs, age: elapsed(ageMs) }];
  }));
}

/**
 * Decisions nothing will move without the master: a stale one — approval refused on a revision or
 * candidate race, so its pin can never hold again — a withdrawn one the requester took back, a
 * refused one an approver judged and declined with its reason, and an unanswered one whose
 * approver session ended without recording anything. A stale or refused decision raises master
 * attention only while it is still the latest decision for its action — a later decision of the
 * same action supersedes it, whatever its state; a withdrawn one is listed for the record and
 * never raises attention. A refusal is answered, never retried: the server refuses an identical
 * request, so the next step is a request that cites the refused decision with what it lacked.
 */
export async function terminalDecisions(masterApi: (path: string) => Promise<any>, work: { id: string; key: string; stage: string; capacity?: CapacityState | null }[],
  sessions: { approvals: ApprovalWatch[]; runtime: { available: boolean; agents: HerdrAgent[] }; now: number }) {
  const listed: { work: string; id: string; action: string; state: string; reason: string | null; race?: unknown; refusedBy?: string; refusedAt?: string }[] = [];
  const attentionItems: AttentionItem[] = [];
  const histories: { key: string; decisions: DecisionRow[]; capacity?: CapacityState | null }[] = [];
  let refused = 0;
  for (const item of work) {
    if (item.stage === 'done') continue;
    const history = await masterApi(`work/${item.id}/decisions`).catch(() => null);
    const decisions: DecisionRow[] = history?.decisions ?? [];
    histories.push({ key: item.key, decisions, capacity: item.capacity });
    const latest = new Map<string, string>();
    for (const decision of decisions) latest.set(decision.action, decision.id);
    for (const decision of decisions) {
      if (decision.state === 'refused') {
        const by = decision.refusal?.approver ?? 'the approver', reason = decision.refusal?.reason ?? decision.outcome ?? null;
        listed.push({ work: item.key, id: decision.id, action: decision.action, state: 'refused', reason, refusedBy: by, ...(decision.refusal ? { refusedAt: decision.refusal.at } : {}) });
        if (latest.get(decision.action) !== decision.id) continue;
        refused += 1;
        attentionItems.push({ subject: item.key, text: `Decision ${decision.id} (${decision.action}) was refused by ${by}: ${reason ?? 'no reason recorded'}. Answer the refusal: an identical request is refused, so a new one must cite ${decision.id} with what the refused request lacked, or the item needs something else`,
          ...agentOwner('master', `Answer the refusal: graphyard master decide ${item.key} ${decision.action} [JSON|@FILE] REASON citing ${decision.id} and what it lacked, then graphyard master approver ${item.key} DECISION — or act on the refusal instead`, 'approver') });
        continue;
      }
      if (decision.state !== 'stale' && decision.state !== 'withdrawn') continue;
      listed.push({ work: item.key, id: decision.id, action: decision.action, state: decision.state, reason: decision.outcome ?? null, ...(decision.race ? { race: decision.race } : {}) });
      if (decision.state === 'stale' && latest.get(decision.action) === decision.id)
        attentionItems.push({ subject: item.key, text: `Decision ${decision.id} (${decision.action}) is stale: ${decision.outcome ?? 'the item moved past it'}; request it again, the stale decision no longer blocks`,
          ...agentOwner('master', `graphyard master decide ${item.key} ${decision.action} [JSON|@FILE] REASON, then graphyard master approver ${item.key} DECISION`, 'approver') });
    }
  }
  const unanswered = unansweredDecisions(histories, sessions.approvals, sessions.runtime, sessions.now);
  for (const entry of unanswered)
    attentionItems.push({ subject: entry.work, text: `Decision ${entry.id} (${entry.action}) is unanswered after ${entry.age}: approver session ${entry.session} is not running and recorded no outcome — a stall, not a refusal`,
      ...agentOwner('master', `graphyard master approver ${entry.work} ${entry.id} [AGENT_KIND] puts it to a fresh approver`, 'approver') });
  return { listed, attentionItems, unanswered, refused };
}
