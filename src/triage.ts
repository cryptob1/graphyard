import type { Work } from './model.js';
import { isDelivered } from './model/closure.js';
import { followUpEntries, followUpParent, machineKind, overdueTriage, triageAttention, triageJudgementSchema, untriaged, type TriageJudgement } from './model/machine-backlog.js';
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
// A run that fails is retried on a later cycle; an item still untriaged a day after it was filed is
// raised as attention (model/machine-backlog.ts triageAttention).
// ---------------------------------------------------------------------------

/** The Graphyard Pi tool whose call is the triage session's judgement (integrations/pi). */
export const triageTool = 'graphyard_triage_decision';
/** The role the Pi extension registers the triage tool for. */
export const triageRole = 'triage';
/** How many triage runs one loop process keeps in flight at once. */
export const triageConcurrency = 2;
/** How long after a failed run the item is judged again. */
export const triageRetryMs = 60 * 60_000;
/** A triage session reads one item and a short list; it is bounded well within the research bound. */
const triageTimeoutMs = (settings: Pick<ResearchSettings, 'timeoutMinutes'>) => Math.min(settings.timeoutMinutes, 10) * 60_000;

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** The triage session's request: the item, the open and recently delivered items it may name, and the three outcomes. */
export function triagePrompt(config: { repository: string }, work: Work, all: readonly Work[]) {
  const kind = machineKind(work) === 'review-follow-up' ? `review follow-ups of ${followUpParent(work)}` : 'a recurring fault class';
  const delivered = all.filter(item => isDelivered(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 40);
  const open = all.filter(item => item.stage !== 'done' && item.id !== work.id).slice(0, 60);
  const findings = followUpParent(work) ? followUpEntries(work).slice(0, 60).map((entry, index) => `${index + 1}. ${entry.path ? `${entry.path}: ` : ''}${clip(entry.text, 400)}`).join(' ') : '';
  return `You are the Graphyard triage agent for ${config.repository}. The master loop filed ${work.key} (${work.type}, priority ${work.priority}) on its own, for ${kind}: ${work.title}. Nobody has judged it yet, and until someone does it sits unreleased in the backlog beside the operator's own items. `
    + `Its description: ${clip(work.description ?? '', 6000)} `
    + (findings ? `Its findings: ${findings} ` : '')
    + `Recently delivered items: ${delivered.map(item => `${item.key} ${clip(item.title, 120)}`).join('; ') || 'none'}. `
    + `Other open items: ${open.map(item => `${item.key} [${item.stage}] ${clip(item.title, 120)}`).join('; ') || 'none'}. `
    + 'Read this checkout (the base branch) where it helps, and judge the item. Choose exactly one: release it with a priority from 0 (most urgent) to 4, when it names real work still worth doing; close it with a reason, naming as ref the delivered item that already fixed it, or with no ref when it is not worth doing; or merge it into another open item that already covers it, naming that item as into. '
    + 'A closure or merge is applied only after an independent approver agrees, so state the evidence it can check. This session is read-only and nobody reads it: do not edit, commit, push, claim work or ask anyone anything. '
    + `Then call the ${triageTool} tool exactly once with outcome, priority, ref or into as the outcome needs, and reason, and stop.`;
}

export interface TriageStepAction { work: string; state: 'started' | 'done' | 'failed'; detail: string }
interface LiveTriage { run: Run<TriageJudgement>; settled: Promise<void> }
const live = new Map<string, LiveTriage>();
const failedAt = new Map<string, number>();
/** Test seam: stop and forget every triage run. */
export function clearTriageRuns() { for (const entry of live.values()) entry.run.cancel('the triage runs were cleared'); live.clear(); failedAt.clear(); }
/** Every run this process has in flight, settled. */
export async function triageSettled() { await Promise.all([...live.values()].map(entry => entry.settled)); }

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
}

/**
 * Start a triage run for each machine-filed item awaiting triage, oldest first, up to
 * `triageConcurrency` in flight. Each run settles on its own and records its judgement; a failed run
 * is noted and the item judged again after `triageRetryMs`.
 */
export function triageStep(input: TriageStepInput): TriageStepAction[] {
  const actions: TriageStepAction[] = [];
  if (!input.settings.enabled) return actions;
  const waiting = input.work.filter(item => untriaged(item) && !live.has(item.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const work of waiting) {
    if (live.size >= triageConcurrency) break;
    const failed = failedAt.get(work.id);
    if (failed !== undefined && input.clock - failed < triageRetryMs) continue;
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
  await input.record(work, { judgement: result.payload, runtime: input.runner.name });
  failedAt.delete(work.id);
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
