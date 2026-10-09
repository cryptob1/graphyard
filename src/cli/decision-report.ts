import { agentOwner, approverSessionName, type AttentionItem, type HerdrAgent } from '../master.js';
import { approverStallVerdict, boundLaunch, idleScreenPauseMs, screenMotion, type ScreenMotion } from '../master/approver-stall.js';
import { launchStartMs } from '../master/launch.js';
import { standingCapacity, type CapacityState } from '../model/capacity.js';
import { elapsed } from '../model/sessions.js';
import { mapBounded, readConcurrency } from '../master/timings.js';
import { staleReleaseAttention } from './owed-report.js';
import { approverJudgeBoundMs, masterTurnWaitBoundMs, maxApproverLaunches } from '../daemon/decisions.js';
import { convergibleClose, staleAttentionAttempts, staleRun } from '../model/stale-close.js';
import type { Closure } from '../model/closure.js';

type DecisionRow = { id: string; action: string; state: string; input?: any; requestedAt: string; staleAt?: string; requestedBy?: string; outcome?: string | null; race?: unknown; refusal?: { approver: string; reason: string; at: string } | null };
type ApprovalWatch = { work: string; decision: string; agentName: string | null; settledAt?: string | null; ended?: string[]; launches?: number; launchedAt?: string | null; exhaustedAt?: string | null };
export interface UnansweredDecision { work: string; id: string; action: string; requestedAt: string; session: string; ageMs: number; age: string; ended?: string[]; inMotionUntil?: string; /** GY-1598: its tab is still in Herdr, `done` or `idle` at a still screen: `closes` when `master approver` closes it, else the pane to close first. */ visible?: { status: string } & ({ closes: true } | { closes: false; pane: string; why: string }) }
/**
 * The approver launch records `master approver` judges a listed session's age by (GY-1598), each only for the pane it names, and its
 * start bound. `screens` holds how each idle session's screen behaved across a pause, still only when it showed no trace of its decision, read by `terminalDecisions` through `read`; an idle one with none is unread.
 */
export interface ApproverStarts { records: { agentName: string; launchedAt: string; pane?: string | null }[]; boundMs: number; screens?: Record<string, ScreenMotion>; read?: (agent: HerdrAgent) => Promise<string | null>; pauseMs?: number }
const approverOf = (item: { key: string }, decision: { id: string }, approvals: ApprovalWatch[]) => {
  const watch = approvals.find(entry => entry.decision === decision.id);
  return { watch, session: watch?.agentName ?? approverSessionName(item, decision.id) };
};

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
export const refusalAnswerWaitBoundMs = masterTurnWaitBoundMs;
/**
 * GY-1349. How long a stale decision of any action but release (GY-1315 re-requests those itself)
 * may stand before its line counts as a `decision-stale` fault: nothing but the master requests it
 * again, on its next turn. On 6 October 2026 GY-1338's resolve decision went stale at 04:13:09
 * when the item's revision moved under its approver, and counted 26 seconds later. The bound runs
 * from when the server settled it stale, or from its request for a record that does not say.
 */
export const staleDecisionWaitBoundMs = masterTurnWaitBoundMs;
/**
 * Until when an unanswered decision is a relaunch the loop is already making: its watch is
 * unsettled and unescalated, it counts launches and some remain, and the latest launch (or the request, before any)
 * is within `approverRelaunchWaitBoundMs`. A decision the loop does not watch is the master's to
 * put to an approver (`master decide`, then `master approver`), so it is in motion for
 * `masterTurnWaitBoundMs` after its request (GY-1346): on 6 October 2026 GY-1338's requirements
 * decision counted 17 minutes after the master asked for it and GY-1335's resolve one minute
 * after, each before the master's approver launch. A watched decision whose launches are spent,
 * or one escalated as unjudged, has no bound and counts at once.
 */
export function unansweredInMotionUntil(watch: ApprovalWatch | undefined, requestedAt: string): string | undefined {
  if (!watch) {
    const requested = Date.parse(requestedAt);
    return Number.isFinite(requested) ? new Date(requested + masterTurnWaitBoundMs).toISOString() : undefined;
  }
  if (watch.settledAt || watch.exhaustedAt || (watch.launches ?? maxApproverLaunches) >= maxApproverLaunches) return undefined;
  const since = Date.parse(watch.launchedAt ?? requestedAt);
  return Number.isFinite(since) ? new Date(since + approverRelaunchWaitBoundMs).toISOString() : undefined;
}

/**
 * Decisions left at `requested` with no live approver session (GY-141): the session the loop
 * launched for it — or, for one a master launched by hand, the name `master approver` gives it —
 * is gone from Herdr or reports `done`, and no outcome was ever recorded. That is a stall, not a
 * judgement: an approver that declines records `master refuse`, and its decision ends `refused`.
 * A session still listed `done`, or `idle` at a still screen, keeps its tab (GY-1598): within its start bound it is no stall yet; past
 * it `master approver` and the loop close it before launching the next, judged by `approverStallVerdict` on the same launch record and
 * screen reading; with no launch record bound to its pane, its pane is named. An idle one whose screen moves, or shows its request
 * ran (a silent command), is at work, and one whose screen was not read is concluded nothing about.
 * Nothing is concluded while Herdr cannot be read. An item waiting for an approver account to
 * reset is not one: the loop launches no approver before then, and master status names that wait
 * once, as the approver capacity line, not as a stall per decision (GY-182).
 */
export function unansweredDecisions(items: { key: string; decisions: DecisionRow[]; capacity?: CapacityState | null }[], approvals: ApprovalWatch[], runtime: { available: boolean; agents: HerdrAgent[] }, now: number,
  starts: ApproverStarts = { records: [], boundMs: launchStartMs({ run: {} }) }): UnansweredDecision[] {
  if (!runtime.available) return [];
  return items.flatMap(item => standingCapacity(item, 'approver').length ? [] : item.decisions.flatMap(decision => {
    if (decision.state !== 'requested') return [];
    const { watch, session } = approverOf(item, decision, approvals);
    const live = runtime.agents.find(agent => agent.name === session), status = live?.agent_status ?? '';
    if (live && status !== 'done' && status !== 'idle') return [];
    const screen = status === 'idle' ? starts.screens?.[session] ?? 'unreadable' : undefined;
    if (screen && screen !== 'still') return [];
    const verdict = live ? approverStallVerdict(live, boundLaunch(starts.records, live)?.launchedAt, starts.boundMs, now, screen) : null;
    if (verdict && !verdict.close && verdict.why.startsWith('it is within')) return [];
    const ageMs = Math.max(0, now - Date.parse(decision.requestedAt));
    // How the loop's earlier sessions for this decision ended (GY-551): the reasons sit beside the
    // decision here, not only in the escalation detail. A decision the loop never watched has none.
    const inMotionUntil = unansweredInMotionUntil(watch, decision.requestedAt);
    return [{ work: item.key, id: decision.id, action: decision.action, requestedAt: decision.requestedAt, session, ageMs, age: elapsed(ageMs),
      ...(watch?.ended?.length ? { ended: watch.ended } : {}), ...(inMotionUntil ? { inMotionUntil } : {}), ...(verdict ? { visible: { status, ...(verdict.close ? { closes: true as const } : { closes: false as const, pane: live!.pane_id ?? session, why: verdict.why }) } } : {}) }];
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
export async function terminalDecisions(masterApi: (path: string) => Promise<any>, work: { id: string; key: string; stage: string; ready?: boolean; capacity?: CapacityState | null; closure?: Closure | null }[],
  sessions: { approvals: ApprovalWatch[]; runtime: { available: boolean; agents: HerdrAgent[] }; now: number; starts?: ApproverStarts }) {
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
      if (owed) { attentionItems.push(owed); continue; }
      // GY-1439: a series of stale settles of one action is one line, not one per attempt. A revision-raced close whose
      // grounds still hold is the loop's to request again (staleCloseStep), named by its wait, until the series reaches
      // staleAttentionAttempts; from there one line stands for the series, its wording free of the attempt's id and count.
      const run = staleRun(decisions, decision.action);
      if (decision.action === 'close') { const converge = convergibleClose(item, decisions, work); if (converge && 'input' in converge) continue; }
      if (run.length >= staleAttentionAttempts) attentionItems.push({ subject: item.key, text: `Decision ${item.key}/${decision.action} (${decision.action}) is stale on ${staleAttentionAttempts} or more requests in a row: the item moved between each request and its approval, so the loop no longer requests it again`,
          ...agentOwner('master', `The latest is ${decision.id} (${decision.outcome ?? 'the item moved past it'}); graphyard master decide ${item.key} ${decision.action} [JSON|@FILE] REASON, then graphyard master approver ${item.key} DECISION — or act on the item yourself`, 'approver') });
      else attentionItems.push({ ...staleInMotion(decision), subject: item.key, text: `Decision ${decision.id} (${decision.action}) is stale: ${decision.outcome ?? 'the item moved past it'}; request it again, the stale decision no longer blocks`,
          ...agentOwner('master', `graphyard master decide ${item.key} ${decision.action} [JSON|@FILE] REASON, then graphyard master approver ${item.key} DECISION`, 'approver') });
    }
  }
  // GY-1598: an idle session named for a requested decision is judged on its screen across a pause, as `master approver` judges it.
  const starts = sessions.starts, idle = !starts?.read || !sessions.runtime.available ? [] : histories.flatMap(item => item.decisions.filter(decision => decision.state === 'requested')
    .flatMap(decision => sessions.runtime.agents.filter(agent => agent.name === approverOf(item, decision, sessions.approvals).session && agent.agent_status === 'idle'
      && !approverStallVerdict(agent, boundLaunch(starts.records, agent)?.launchedAt, starts.boundMs, sessions.now).why.startsWith('it is within')).map(agent => ({ agent, decision: decision.id }))));
  const screens = Object.fromEntries(await Promise.all(idle.map(async ({ agent, decision }) => [agent.name!, await screenMotion(() => starts!.read!(agent), decision, starts!.pauseMs ?? idleScreenPauseMs)] as const)));
  const unanswered = unansweredDecisions(histories, sessions.approvals, sessions.runtime, sessions.now, starts && { ...starts, screens: { ...starts.screens, ...screens } });
  for (const entry of unanswered) {
    const shown = entry.visible, sits = shown && `sits ${shown.status}${shown.status === 'idle' ? ' at a still screen' : ''} in Herdr`;
    const state = !shown ? 'is not running' : shown.closes ? `${sits} past its start bound` : `${sits}, but ${shown.why}`;
    const next = `graphyard master approver ${entry.work} ${entry.id} [AGENT_KIND] ${shown?.closes ? `closes ${entry.session} and ` : ''}puts it to a fresh approver`;
    attentionItems.push({ subject: entry.work, text: `Decision ${entry.id} (${entry.action}) is unanswered after ${entry.age}: approver session ${entry.session} ${state} and recorded no outcome${entry.ended?.length ? ` (${entry.ended.join('; ')})` : ''} — a stall, not a refusal`,
      ...agentOwner('master', shown && !shown.closes ? `herdr pane close ${shown.pane} (master approver refuses it while ${shown.why}), then ${next}` : next, 'approver'), ...(entry.inMotionUntil ? { inMotionUntil: entry.inMotionUntil } : {}) });
  }
  return { listed, attentionItems, unanswered, refused };
}

/** Until when a stale decision is the master's turn to request again (GY-1349): `staleDecisionWaitBoundMs` after it went stale. */
function staleInMotion(decision: DecisionRow): { inMotionUntil?: string } {
  const at = Date.parse(decision.staleAt ?? decision.requestedAt);
  return Number.isFinite(at) ? { inMotionUntil: new Date(at + staleDecisionWaitBoundMs).toISOString() } : {};
}

/** Whether the refused decision's requester asked the item for a later decision, of any action and not taken back: the refusal's answer (GY-1337). */
function answeredRefusal(refused: DecisionRow, decisions: readonly DecisionRow[]): boolean {
  const at = Date.parse(refused.refusal?.at ?? refused.requestedAt);
  return !!refused.requestedBy && Number.isFinite(at) && decisions.some(other => other.id !== refused.id && other.requestedBy === refused.requestedBy
    && other.state !== 'withdrawn' && Date.parse(other.requestedAt) > at);
}
