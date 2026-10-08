import { agentOwner, humanOwner, installationOwner, type AttentionItem } from '../master.js';
import { generatedFilesAssignment, generatedFilesDrift, generatedFilesVariable, generatedManifestScript } from '../install/generated-files.js';
import { docsHeadroomStatus } from '../daemon/faults.js';
import type { Work } from '../model.js';
import { mergeStalls } from '../merge-queue.js';
import { stallBoundMs, stalledItems, type ActionlessItem } from '../model/action-account.js';
import { elapsed } from '../model/sessions.js';
import { baseBreakHold, describeBaseBreak } from '../master/base-break-refresh.js';

// The orphaned-supervisor builders live in their own module (GY-138); they are read from here too.
export { nameOrphanSupervisors, orphanSupervisorAttention, supervisorReclaimCommand } from './orphan-supervisors.js';

/**
 * One attention item per requested decision whose approver could not be launched (GY-101, GY-849).
 * A decision changes nothing until a session judges it, and a launch the runtime refuses — for a
 * name it will not take, a credential it cannot read, a workspace that is gone — leaves the watch
 * standing with a session that never started. A launch that fails due to approver capacity
 * (all accounts spent, role concurrency limit reached) is not counted against the launch bound;
 * the loop relaunches it when capacity frees, oldest decision first. `master status` shows both
 * as needing attention: one awaiting relaunch, one waiting for a slot. The capacity wait is kept
 * on the watch only while it is the newest launch state (GY-920): a later launch — adopted,
 * failed for another reason, or successful — clears it, so the classification here follows the
 * launch rather than a wait that is over.
 */
export function approverLaunchAttention(daemon: {
  approvals?: { key: string; work: string; action: string; decision: string; agentName: string | null; launches: number; launchedAt: string | null; requestedAt: string; settledAt: string | null; capacity?: string | null }[];
  actions?: { key: string; kind: string; state: string; detail: string; at: string }[];
}): AttentionItem[] {
  const actions = daemon.actions ?? [];
  return (daemon.approvals ?? []).flatMap(watch => {
    if (watch.settledAt) return [];
    // GY-849: Decisions waiting for approver capacity (not counted against launch attempts) are
    // shown as waiting for a slot with the live sessions holding the role, not as stalled.
    // GY-920: the wait is classified only while it is still the newest launch state. A watch whose
    // launch went on anyway — an adopted session, or one the loop holds in flight — is classified
    // by that launch below, never by a wait the launch superseded.
    if (watch.capacity && !watch.agentName) {
      // GY-849: the wait is the loop's to clear — it relaunches the decision itself, oldest
      // waiting decision first, once an account or slot frees — so the remedy names no command:
      // a hand `master approver` here would race the relaunch the watch already covers.
      return [{ subject: watch.work, text: `${watch.work} is waiting for approver capacity to relaunch ${watch.action} decision ${watch.decision}: ${watch.capacity}`,
        ...agentOwner('master', `nothing to run: the loop relaunches ${watch.decision} itself, oldest waiting decision first, when capacity frees`, 'approver') }];
    }
    // The loop records a refused launch under the decision it was requested for (the request that
    // could not reach an approver) or under that launch's own key (a replacement that could not).
    const since = Date.parse(watch.launchedAt ?? watch.requestedAt);
    const refusal = actions.find(action => action.state === 'failed' && action.kind === 'decision'
      && (action.key === watch.key || action.key.startsWith(`approver:${watch.decision}:launch:`))
      && (!Number.isFinite(since) || Date.parse(action.at) >= since));
    return refusal ? [{ subject: watch.work, text: `${watch.work} is awaiting an approver for ${watch.action} decision ${watch.decision} that could not start${watch.agentName ? ` as ${watch.agentName}` : ''}: ${refusal.detail}`,
      ...agentOwner('master', `graphyard master approver ${watch.work} ${watch.decision} [AGENT_KIND]`, 'approver') }] : [];
  });
}

/**
 * Who is told what, and with which command.
 *
 * `master status` is an assembler over ledgers and snapshots; this is the part of it that turns
 * one observed situation into one line addressed to somebody. Each builder answers the same three
 * questions — what is true, how long it has been true, and whose command changes it — and keeping
 * them together is what stops two readers of the same situation saying different things about it.
 * Nothing here decides anything: every situation below was already decided by the control plane.
 */

/**
 * What an item with no action is missing, in one clause: the refusal its failing gate raised, or
 * the account itself when no gate said anything.
 */
const missingFrom = (entry: ActionlessItem) => entry.refusal ?? entry.detail;

/**
 * One attention item per open item the control plane names no action for and nothing is moving.
 *
 * This is the state with no other reporter. An item waiting on a dependency, on the entry ahead
 * of it in the merge queue, or on the session already building it has somewhere to be seen and
 * something that will move it; `actionlessItems` counts those separately and they raise nothing
 * here. What is left is an item holding a failing gate past the idle bound with no action, no
 * dependency and no recorded human need — which was, until this, exactly as visible as an item
 * that was fine. It is named with the gate, how long it has held it, what is missing, and who
 * answers: the operator for a decision the project reserves for a person, and the master for the
 * control-plane defect that a state produced no answer at all.
 */
export function stalledItemAttention(snapshot: { work: Work[]; now: string }, thresholdMs = stallBoundMs): AttentionItem[] {
  return stalledItems(snapshot.work, new Date(snapshot.now), thresholdMs).map(entry => {
    const held = `has held its ${entry.gate ?? 'unevaluated'} gate for ${elapsed(entry.heldMs)} with no action named and nothing moving it`;
    return entry.outcome === 'human'
      ? { subject: entry.key, text: `${entry.key} ${held}: ${missingFrom(entry)} — ${entry.detail}`, ...humanOwner('goals and priorities', entry.detail) }
      : { subject: entry.key, text: `${entry.key} ${held}: ${missingFrom(entry)} — the control plane computed neither an action, a dependency nor a human need for this state, which is a defect in the control plane rather than in the item (${entry.detail})`,
        ...agentOwner('master', `graphyard master create files the control-plane defect that left ${entry.key} without an action; until it is fixed, graphyard master status names no step for this item and nothing will claim it`) };
  });
}

/** Direct-merge mode (src/direct-merge.ts), first in master status and in one line while it is on: gated merging is bypassed. */
export const directMergeLine = (coordinator: any): { directMerge?: string } => coordinator?.directMerge?.line ? { directMerge: coordinator.directMerge.line } : {};

/** The merger setting (src/merger-mode.ts), in one line while the control plane is the merge writer; the key is `mergeWriter` because `merger` is the loop-merger presence report. */
export const mergeWriterLine = (coordinator: any): { mergeWriter?: string } => coordinator?.mergeWriter?.line ? { mergeWriter: coordinator.mergeWriter.line } : {};

/**
 * The worker scope requests the loop has routed to the independent approver (GY-176), as the
 * `(key, epoch, at)` that identifies each ask. A routed request is the approver's to judge and the
 * worker's to be told about; naming `master scope` for it would send a master to decide what is
 * already being decided, so the scope attention leaves these out.
 */
export function routedScopeRequests(approvals: readonly { work: string; action: string; scope?: { epoch: number; at: string } | null }[] = []) {
  const routed = new Set(approvals.filter(watch => watch.action === 'requirements' && watch.scope).map(watch => `${watch.work}:${watch.scope!.epoch}:${watch.scope!.at}`));
  return (work: { key: string; scopeRequest?: { epoch: number; at: string } | null }) => !!work.scopeRequest && routed.has(`${work.key}:${work.scopeRequest.epoch}:${work.scopeRequest.at}`);
}

/** The deployed generated-file manifest against the repository's, as installation attention; an unreadable manifest is the master's to fix. */
export function generatedFilesAttention(root: string, coordinator: any): AttentionItem[] {
  const generatedFiles: AttentionItem[] = [];
  try {
    const deployed = coordinator?.delegationLimits?.deployed?.[generatedFilesVariable];
    for (const text of generatedFilesDrift(deployed, generatedFilesAssignment(root))) generatedFiles.push({ subject: 'installation', text, ...installationOwner('delegation-limits', text) });
  } catch (error) {
    generatedFiles.push({ subject: 'installation', text: `The repository generated-file manifest is unreadable: ${error instanceof Error ? error.message : 'unknown reason'}`,
      ...agentOwner('master', `Fix ${generatedManifestScript} so --list prints the generated paths; master status reports the deployment drift again once it does`) });
  }
  return generatedFiles;
}

/** A merge pending past five minutes on a head GitHub reports mergeable, with no refusal (GY-344). */
export const mergeStallAttention = (snapshot: { work: Work[]; now: string }): AttentionItem[] =>
  mergeStalls(snapshot.work, Date.parse(snapshot.now)).map(stall => ({ subject: stall.key, text: stall.text, ...agentOwner('master', stall.next) }));

/** The unqualified line a failed required check gives a row, or the rework it was once named as. */
const failedCheckLine = (text: string | null | undefined) => !!text && (/^Required CI check .+ has not passed on the current candidate$/.test(text) || /needs a new head/.test(text));
/**
 * Name every open candidate held only by a base-branch breakage as such (GY-793): the failing
 * tests, the base commit that broke them and the tip that fixed them, in place of the unqualified
 * `Required CI check test has not passed` or a `needs a new head` nobody should be asked for. The
 * row's refusal and attention, and any attention item raised from them, carry the line, owned by
 * the control plane whose observation job is refreshing the candidate. It reports and never
 * decides: the gate stays refused until the refreshed head's checks pass.
 */
export function nameBaseBreaks<S extends { work: { key: string; refusal: { gate: string; reason: string } | null; attention: string | null }[]; attentionItems: AttentionItem[] }>(status: S, work: Work[]): S {
  const named = new Map<string, { text: string; tip: string }>();
  for (const item of work) {
    const found = item.stage === 'done' ? null : baseBreakHold(item);
    if (found) named.set(item.key, { text: describeBaseBreak(item.key, found), tip: found.fixedBy });
  }
  if (!named.size) return status;
  const owner = (key: string) => agentOwner('control plane', `nothing to run: the observation job brings ${key} onto ${named.get(key)!.tip.slice(0, 12)} and CI runs again; graphyard diagnose ${key} names anything holding the refresh`);
  const rows = status.work.map(row => {
    const entry = named.get(row.key);
    if (!entry) return row;
    const refusal = row.refusal && failedCheckLine(row.refusal.reason) ? { ...row.refusal, reason: entry.text } : row.refusal;
    return { ...row, refusal, ...(failedCheckLine(row.attention) ? { attention: entry.text, attentionOwner: owner(row.key) } : {}) };
  });
  const attentionItems = status.attentionItems.map(item => named.has(item.subject) && failedCheckLine(item.text) ? { ...item, ...owner(item.subject), text: named.get(item.subject)!.text } : item);
  return { ...status, work: rows, attentionItems };
}

/**
 * The documentation word budget on the base branch (GY-574), as `reportedAttention` carries it: the
 * reading, with its attention pushed onto the installation attention it lands beside.
 */
export async function docsBudgetAttention(root: string, baseBranch: string, onto: AttentionItem[]) {
  const docs = await docsHeadroomStatus(root, baseBranch);
  onto.push(...docs.attention);
  return docs.docs;
}
