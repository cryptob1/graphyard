import type { Work } from './model.js';
import { isDelivered } from './model/closure.js';
import { closesFaultClass, deliveredFaultClassCover, predateLanding, type FaultInstance } from './model/fault-classes.js';
import { awaitsParent, followUpEntries, followUpParent, machineKind, overdueTriage, triageAttention, triageClosure, triageJudgementSchema, untriaged, type TriageJudgement } from './model/machine-backlog.js';
import { agentOwner, type AttentionItem } from './master/attention.js';
import type { ResearchSettings } from './research.js';
import type { Run, RunResult, Runner } from './runner/types.js';

// ---------------------------------------------------------------------------
// Triage of the machine-filed backlog (GY-402).
//
// The loop files review follow-ups and recurring-fault items on its own, and until now nothing
// judged them: they sat unreleased in the backlog, burying the operator's own items. Each such item
// awaiting triage now gets one cheap headless session — Pi on the research account and model, the
// same runner the research step uses (src/research.ts) — that reads the item, this checkout and the
// delivered items, and submits one judgement through the `graphyard_triage_decision` tool: release
// it with a priority, close it (already fixed by a named delivered item, or not worth doing), or
// merge it into another open item. The loop records the judgement on the item (POST
// work/ID/triage). A release applies at once; a closure or merge is proposed, and the loop requests
// the `close` decision for it, which an independent approver session judges before it is applied.
// A refused closure is put to the next triage session with the refusal's reason, and the same
// closure proposed again while the item is unchanged is dropped unrecorded, so it never launches
// another approver session (GY-1448). A run that fails is retried on a later cycle; an item still
// untriaged a day after it was filed is raised as attention (model/machine-backlog.ts triageAttention).
// A recurring-fault item whose origin instances were all first seen before a delivered item naming
// the same class landed needs no session (GY-1632): the loop proposes closing it as covered by that
// item, which the approver judges like any closure, and no worker is dispatched to re-implement it.
// ---------------------------------------------------------------------------

/** The Graphyard Pi tool whose call is the triage session's judgement (integrations/pi). */
export const triageTool = 'graphyard_triage_decision';
/** The role the Pi extension registers the triage tool for. */
export const triageRole = 'triage';
/** How many triage runs one loop process keeps in flight at once, unless `run.research.triageConcurrency` says otherwise. */
export const triageConcurrency = 2;
/** How long after a failed run the item is judged again. */
export const triageRetryMs = 60 * 60_000;
/** A triage session reads one item and a short list; it is bounded well within the research bound. */
const triageTimeoutMs = (settings: Pick<ResearchSettings, 'timeoutMinutes'>) => Math.min(settings.timeoutMinutes, 10) * 60_000;

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/**
 * The closure an approver refused on this item while its evidence is unchanged since (GY-1448): the
 * item's triage record is `refused` and nothing saved the item after the refusal (a description
 * amended, findings merged in). Null once the item changes, or when it carries no refused closure.
 */
export function refusedClosure(work: Pick<Work, 'triage' | 'updatedAt'>): { kind: string; ref: string | null; refusal: string | null; at: string } | null {
  const triage = work.triage;
  const closure = triage?.state === 'refused' ? triageClosure(triage.judgement) : null;
  if (!closure || Date.parse(work.updatedAt) > Date.parse(triage!.at)) return null;
  return { kind: closure.kind, ref: closure.ref, refusal: triage!.refusal ?? null, at: triage!.at };
}
/** Whether `judgement` proposes again the closure the approver refused on `work` — same kind and ref — with the item's evidence unchanged. */
export function repeatsRefusedClosure(work: Pick<Work, 'triage' | 'updatedAt'>, judgement: TriageJudgement) {
  const refused = refusedClosure(work), closure = triageClosure(judgement);
  return !!refused && !!closure && closure.kind === refused.kind && closure.ref === refused.ref;
}
const closureName = (closure: { kind: string; ref: string | null }) => `${closure.kind}${closure.ref ? ` of ${closure.ref}` : ''}`;

/**
 * The judgement a recurring-fault item needs no session for (GY-1632): close it as covered by the
 * newest delivered item naming its class, when every instance its origin lists, and every instance the
 * loop has since linked to it (`linked`), predates that item's landing: a recurrence after the landing
 * linked to the open item keeps it open, never suppressed by its closure. Null when it lists none, one
 * postdates the landing, or no delivered item names the class.
 */
export function coveredByDelivery(work: Work, all: readonly Work[], linked: readonly Pick<FaultInstance, 'at' | 'linkedTo'>[] = []): Extract<TriageJudgement, { outcome: 'close' }> | null {
  const faultClass = closesFaultClass(work), instances = work.origin?.faultClass?.instances ?? [];
  if (!faultClass || !instances.length) return null;
  const cover = deliveredFaultClassCover(all.filter(item => item.id !== work.id), faultClass);
  if (!cover || !predateLanding([...instances, ...linked.filter(entry => entry.linkedTo === work.key)], cover.landedAt)) return null;
  const landed = new Date(cover.landedAt).toISOString();
  return { outcome: 'close', ref: cover.item.key, reason: `Covered by ${cover.item.key}, delivered for the ${faultClass} fault class at ${landed}: every instance this item lists (${instances.length}, the latest first seen ${instances.map(entry => entry.at).sort().at(-1)}) predates that landing, so the delivered fix already answers them` };
}

/** The triage session's request: the item, the open and recently delivered items it may name, and the three outcomes. */
export function triagePrompt(config: { repository: string }, work: Work, all: readonly Work[]) {
  const kind = machineKind(work) === 'review-follow-up' ? `review follow-ups of ${followUpParent(work)}` : 'a recurring fault class';
  const delivered = all.filter(item => isDelivered(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 40);
  const open = all.filter(item => item.stage !== 'done' && item.id !== work.id).slice(0, 60);
  const findings = followUpParent(work) ? followUpEntries(work).slice(0, 60).map((entry, index) => `${index + 1}. ${entry.path ? `${entry.path}: ` : ''}${clip(entry.text, 400)}`).join(' ') : '';
  return `You are the Graphyard triage agent for ${config.repository}. The master loop filed ${work.key} (${work.type}, priority ${work.priority}) on its own, for ${kind}: ${work.title}. ${work.triage?.state === 'refused' ? 'No judgement of it stands' : 'Nobody has judged it yet'}, and until one does it sits unreleased in the backlog beside the operator's own items. `
    + `Its description: ${clip(work.description ?? '', 6000)} `
    + (findings ? `Its findings: ${findings} ` : '')
    + refusalNote(work)
    + `Recently delivered items: ${delivered.map(item => `${item.key} ${clip(item.title, 120)}`).join('; ') || 'none'}. `
    + `Other open items: ${open.map(item => `${item.key} [${item.stage}] ${clip(item.title, 120)}`).join('; ') || 'none'}. `
    + 'Read this checkout (the base branch) where it helps, and judge the item. Choose exactly one: release it with a priority from 0 (most urgent) to 4, when it names real work still worth doing; close it with a reason, naming as ref the delivered item that already fixed it, or with no ref when it is not worth doing; or merge it into another open item that already covers it, naming that item as into. '
    + 'A closure or merge is applied only after an independent approver agrees, so state the evidence it can check. This session is read-only and nobody reads it: do not edit, commit, push, claim work or ask anyone anything. '
    + `Then call the ${triageTool} tool exactly once with outcome, priority, ref or into as the outcome needs, and reason, and stop.`;
}

/**
 * What triage is told of a closure the approver refused (GY-1448): the closure and the refusal's
 * reason, and that the same closure is not proposed again unless it names evidence the refusal did not weigh.
 */
function refusalNote(work: Work) {
  const triage = work.triage;
  const closure = triage?.state === 'refused' ? triageClosure(triage.judgement) : null;
  if (!closure) return '';
  return `An earlier triage proposed closing it (${closureName(closure)}) and the independent approver refused that closure at ${triage!.at}: "${clip(triage!.refusal ?? 'no reason recorded', 2000)}". `
    + `Do not propose that closure (${closureName(closure)}) again: ${refusedClosure(work) ? 'the item has not changed since the refusal, so the loop drops the same closure unrecorded and requests no decision for it' : 'propose it only naming the new evidence that answers the refusal'}. `
    + 'Follow the refusal instead: release it with a priority, rescoped to the work it still names, or close or merge it on a different ref the refusal did not weigh, stating that new evidence. ';
}

export interface TriageStepAction { work: string; state: 'started' | 'done' | 'failed' | 'held'; detail: string }
interface LiveTriage { run: Run<TriageJudgement>; settled: Promise<void> }
const live = new Map<string, LiveTriage>();
const failedAt = new Map<string, number>();
/** Items whose triage run proposed again the closure refused at the recorded time (GY-1448), by item id: not judged again while that refusal stands unchanged. */
const repeatedAt = new Map<string, string>();
/** Covered-by-delivery closures being recorded, by item id (GY-1632): no session runs for them. */
const recording = new Map<string, Promise<void>>();
/** Test seam: stop and forget every triage run. */
export function clearTriageRuns() { for (const entry of live.values()) entry.run.cancel('the triage runs were cleared'); live.clear(); failedAt.clear(); repeatedAt.clear(); recording.clear(); }
/** Every run this process has in flight, settled. */
export async function triageSettled() { await Promise.all([...[...live.values()].map(entry => entry.settled), ...recording.values()]); }

export interface TriageStepInput {
  work: readonly Work[];
  clock: number;
  settings: ResearchSettings;
  config: { repository: string };
  /** The checkout the triage session reads: the loop's own. */
  cwd: string;
  runner: Runner;
  /** Records the judgement on the item (POST work/ID/triage as the coordinator). */
  record: (work: Work, body: { judgement: TriageJudgement; runtime?: string }) => Promise<unknown>;
  /** The loop's retained fault instances: those linked to an item keep it from closing as covered (GY-1632). */
  faultInstances?: readonly FaultInstance[];
}

/**
 * Start a triage run for each machine-filed item awaiting triage, oldest first, but a follow-up whose parent has not shipped, up to
 * `triageConcurrency` in flight. Each run settles on its own and records its judgement; a failed run
 * is noted and the item judged again after `triageRetryMs`.
 */
export function triageStep(input: TriageStepInput): TriageStepAction[] {
  const actions: TriageStepAction[] = [];
  if (!input.settings.enabled) return actions;
  // A follow-up whose parent has not shipped is never judged (GY-845): its findings may still change,
  // and the migration folds it back onto the parent.
  const waiting = input.work.filter(item => untriaged(item) && !awaitsParent(item, input.work) && !live.has(item.id) && !recording.has(item.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const work of waiting) {
    const failed = failedAt.get(work.id);
    if (failed !== undefined && input.clock - failed < triageRetryMs) continue;
    // GY-1632: every instance predates a delivered same-class item's landing — closing it as covered needs no session, and never releases it to a worker.
    const covered = coveredByDelivery(work, input.work, input.faultInstances);
    if (covered && !repeatsRefusedClosure(work, covered)) {
      const settled = input.record(work, { judgement: covered }).then(() => {}, () => { failedAt.set(work.id, Date.now()); }).finally(() => recording.delete(work.id));
      recording.set(work.id, settled);
      actions.push({ work: work.key, state: 'done', detail: `Proposing to close machine-filed ${work.key} as covered by delivered ${covered.ref}: every instance it lists predates that item's landing, so no worker is dispatched` });
      continue;
    }
    if (live.size >= (input.settings.triageConcurrency ?? triageConcurrency)) break;
    // A run already proposed again the closure the approver refused, and the item has not changed
    // since (GY-1448): another session would only propose it once more, so the item waits for its
    // evidence to change, or for the master once it is overdue (untriagedAttention).
    const refused = refusedClosure(work);
    if (refused && repeatedAt.get(work.id) === refused.at) {
      actions.push({ work: work.key, state: 'held', detail: `Holding machine-filed ${work.key} out of triage: its triage proposed again the closure (${closureName(refused)}) the approver refused at ${refused.at}, and the item has not changed since, so the loop requests no close decision for it` });
      continue;
    }
    // Started outside the run registry, as a scratch run (runner/pi.ts): nothing adopts it after a
    // restart, so it bounds itself, ends with this process, and a run left by a loop killed outright
    // is ended and removed by the next scratch run before it starts, never judged twice at once.
    const run = input.runner.start(triagePrompt(input.config, work, input.work), {
      cwd: input.cwd, env: { GRAPHYARD_PI_ROLE: triageRole }, tool: triageTool, timeoutMs: triageTimeoutMs(input.settings), validate: payload => triageJudgementSchema.parse(payload) });
    const settled = run.result().then(result => settleTriage(input, work, result)).catch(() => { failedAt.set(work.id, Date.now()); }).finally(() => { if (live.get(work.id)?.run === run) live.delete(work.id); });
    live.set(work.id, { run, settled });
    actions.push({ work: work.key, state: 'started', detail: `Triaging machine-filed ${work.key} on ${input.settings.model}: release with a priority, close with a reason, or merge into another item` });
  }
  return actions;
}

async function settleTriage(input: TriageStepInput, work: Work, result: RunResult<TriageJudgement>) {
  if (!result.ok) { failedAt.set(work.id, Date.now()); return; }
  failedAt.delete(work.id);
  // The closure the approver refused, proposed again on unchanged evidence, is never recorded: its
  // fresh judgement time would bind a new close decision the refusal does not match, and launch
  // another approver session for a closure already refused (GY-1448).
  if (repeatsRefusedClosure(work, result.payload)) { repeatedAt.set(work.id, work.triage!.at); return; }
  await input.record(work, { judgement: result.payload, runtime: input.runner.name });
}

/**
 * Each machine-filed item still untriaged past `triageDeadlineMs` as attention (GY-402): it names the
 * triage step that has not judged it. The master's to answer — the loop runs the triage session once
 * `run.research` names the research account, and a closure it proposes goes to the approver.
 */
export function untriagedAttention(snapshot: { work: readonly Work[]; now: string }): AttentionItem[] {
  const now = Date.parse(snapshot.now);
  return overdueTriage(snapshot.work, now).map(work => ({ subject: work.key, text: triageAttention(work, now),
    ...agentOwner('master', `Nothing to run by hand while the loop cycles with run.research configured: its triage step judges ${work.key}; to judge it yourself, graphyard master release ${work.key} REASON, or graphyard master close ${work.key} REASON --superseded-by GY-M | --duplicate-of GY-M | --obsolete`) }));
}
