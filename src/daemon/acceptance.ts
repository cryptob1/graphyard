// Concern: the acceptance role (GY-1417) — each open goal is drafted headless into customer outcomes and
// required cases on one pull request, judged headless by the approver identity, landed by the control
// plane at its approved head and recorded merged (or closed unmerged, or conflicting, and drafted again).
// Under the control-plane merger (GY-1535) the draft is one commit the merge writer lands instead: no pull request.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { caseDirectory, contractFile, parseContract } from '../e2e/case.js';
import { acceptanceChangeRisk, acceptanceDraftSchema, acceptanceName, acceptanceStuckMs, draftFiles, maxDraftRounds, type AcceptanceDraft, type Goal, type Landing } from '../model/goal.js';
import type { MergerMode } from '../merger-mode.js';
import { baseMovedReason } from '../merge-writer/executor.js';
import type { MergeWriterReads } from './cycle-merge-writer.js';
import { agentToken } from '../master/autonomy.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { capacityRefusal, selectFleetSession } from '../fleet.js';
import { heldAwareProbe } from '../master/environments.js';
import { Refusal, RefusedResponse } from '../model/refusal.js';
import type { MasterConfig } from '../master.js';
import { diagnosticianSettings, type DiagnosticianSettings } from '../runner/payloads.js';
import { piRunner } from '../runner/pi.js';
import { registryHeadlessLaunch, registryRunner } from '../runner/roles.js';
import type { Runner } from '../runner/types.js';
import type { ChildRun } from '../child-runner.js';
import { type DaemonAction, message } from './state.js';
import { record } from './effects.js';
import { detailChanged } from './decisions.js';
import type { Cycle } from './cycle.js';

export const acceptanceRole = 'acceptance';
export const acceptanceTool = 'graphyard_acceptance';
/** The judgement run's Pi role and tool: the approver identity's verdict on one draft. */
export const acceptanceJudgeRole = 'acceptance-judge';
export const acceptanceJudgementTool = 'graphyard_acceptance_judgement';
/** A run that returned nothing is tried again after this long: each try is a paid model run. */
export const acceptanceRetryMs = 60 * 60_000;
/** A step that only talks to GitHub or the control plane (open, post, close) is retried after this long, reusing the draft. */
export const acceptanceStepRetryMs = 10 * 60_000;
/** An acceptance pull request's state is read, or its landing asked, at most this often per goal. */
export const acceptancePollMs = 5 * 60_000;
export const acceptancePayloadSchema = z.object({ goal: z.string().min(1).max(40), outcomes: z.unknown() }).strict()
  .transform(({ goal, outcomes }) => ({ goal, ...acceptanceDraftSchema.parse({ outcomes }) }));
export const judgementPayloadSchema = z.object({ goal: z.string().min(1).max(40), verdict: z.enum(['approve', 'refuse']), reason: z.string().trim().min(1).max(2000) }).strict();
export type Judgement = z.infer<typeof judgementPayloadSchema>;

export interface AcceptanceRun { runner: Runner; runtime: string; model: string; release?: (reason: string) => Promise<unknown> }
export interface PullRequestState { state: 'open' | 'closed' | 'merged'; mergeSha: string | null; head: string | null }
/**
 * The merge writer's steps an approved acceptance change lands through under the control-plane
 * merger (GY-1535; cycle-merge-writer.ts builds them): the fetched base tip, the exact merge commit
 * of the head onto it, the leased deploy-key push, and the merge commit the base's first-parent
 * history already holds for a head (so a retry after a lost record never pushes twice).
 */
export interface AcceptanceWriterPorts extends Pick<MergeWriterReads, 'baseBranch' | 'retrials' | 'fetch' | 'merge' | 'push'> {
  merged(head: string): Promise<string | null>;
}
export interface AcceptanceEffects {
  settings: Pick<DiagnosticianSettings, 'enabled' | 'model' | 'fallbackModel' | 'timeoutMinutes'>;
  cwd: string;
  goals: () => Promise<Goal[]>;
  /** The draft runs on the acceptance role's accounts; the judgement on the approver role's. */
  runner: (role: 'draft' | 'judge', attempt: 'primary' | 'fallback', goal: Goal) => Promise<AcceptanceRun>;
  /** Push the draft to the goal's branch for this revision and open its pull request, or reuse the one already open there. */
  open: (goal: Goal, draft: AcceptanceDraft) => Promise<{ pr: number; branch: string; head: string }>;
  /** Post the draft as the master's operator-agent identity: its author. */
  draft: (goal: Goal, input: AcceptanceDraft & { pr: number | null; branch: string; head: string }) => Promise<Goal>;
  /** Post the verdict as the approver identity, which never authored a draft. */
  judge: (goal: Goal, judgement: Judgement) => Promise<Goal>;
  pullRequest: (pr: number) => Promise<PullRequestState>;
  /**
   * Ask the control plane to land the approved pull request (POST /api/goals/:key/land): it publishes
   * the App-bound gate verdicts on the approved head and merges it there once GitHub's own checks pass,
   * recording it merged; a pull request closed, moved off that head or conflicting is closed and recorded closed.
   */
  land: (goal: Goal) => Promise<{ goal: Goal; landing: Landing }>;
  /** Close a refused or abandoned acceptance pull request with a comment and delete its branch; nothing when it is no longer open. */
  close: (pr: number, comment: string) => Promise<void>;
  /** Record the draft closed unmerged; `pr` is null for a merge-writer change. */
  closed: (goal: Goal, pr: number | null, reason: string) => Promise<Goal>;
  /** The recorded merger (GY-1535), read afresh before a draft is opened; absent, `github`. */
  merger?: () => Promise<MergerMode>;
  /** Under the control-plane merger: commit the draft on its own branch in the coordinator checkout from the base tip, with no push and no pull request. */
  commit?: (goal: Goal, draft: AcceptanceDraft) => Promise<{ branch: string; head: string }>;
  /** Under the control-plane merger: the merge writer's steps the approved change lands through. */
  writer?: AcceptanceWriterPorts;
  /** Record a merge-writer change merged at the merge commit the writer pushed (POST /api/goals/:key/land with `mergeSha`); the control plane checks the base holds it. */
  landed?: (goal: Goal, mergeSha: string) => Promise<{ goal: Goal; landing: Landing }>;
}

/** A finished run, kept until it is posted: the draft (and the pull request it was opened as) or the verdict; `deferred` names the full role no run started on. */
interface Pending { revision: number; draft?: AcceptanceDraft | null; opened?: { pr: number | null; branch: string; head: string }; judgement?: Judgement | null; runs: string[]; deferred?: string }
/** A draft the current base can never take (an outcome, case or file it names already exists): it is dropped and drafted again, never reopened. */
export class UnopenableDraft extends Error {}
const unopenable = (error: unknown) => error instanceof UnopenableDraft || ((error instanceof Refusal || error instanceof RefusedResponse) && error.status === 422);
const live = new Map<string, Promise<void>>();
const pending = new Map<string, Pending>();
/** When each goal's next try of a step may run: `${goal.id}:${step}`. */
const retryAt = new Map<string, number>();
const polledAt = new Map<string, number>();
/** Pull requests closed by this loop or the control plane. */
const closedPulls = new Set<number>();
export async function draftsSettled() { await Promise.all([...live.values()]); }
export function clearDrafts() { for (const store of [live, pending, retryAt, polledAt]) store.clear(); closedPulls.clear(); }

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
type Note = (goal: Goal, outcome: DaemonAction['state'], detail: string) => Promise<void>;

async function declared(cwd: string) {
  const contract = await readFile(join(cwd, contractFile), 'utf8').then(source => parseContract(source).outcomes.map(outcome => ({ id: outcome.id, cases: outcome.cases })), () => []);
  return { outcomes: contract };
}

export function acceptancePrompt(config: { repository: string }, goal: Goal, existing: { outcomes: { id: string; cases: string[] }[] }) {
  const input = { goal: goal.key, statement: goal.statement, users: goal.users, constraints: goal.constraints, deployTarget: goal.deployTarget,
    lastRefusal: goal.refusal ? { by: goal.refusal.by, reason: goal.refusal.reason } : null, existingOutcomes: existing.outcomes };
  return `You are the Graphyard acceptance role for ${config.repository}: the customer's advocate. Turn the goal below into what its users must be able to do, before any code is written. `
    + 'This session is read-only: never edit, commit, push, claim or decide anything, and never ask anyone anything. '
    + `Read ${caseDirectory}/ and ${contractFile} in this checkout for the case format and the outcomes already declared. `
    + `Then call the ${acceptanceTool} tool exactly once with goal "${goal.key}" and outcomes: each outcome a new id (lower-case letters, digits, ., _ and -), a plain-language title a customer would say, `
    + 'the criteria they would check it by, and exactly one case proving it — a case in the e2e/cases format whose id is new, with required true, target "uat", and http or browser steps that check what the customer sees, not how it is built. '
    + 'Answer any refusal of the last draft. Stop after the call.\n\n'
    + `The goal, as JSON:\n${clip(JSON.stringify(input), 50_000)}`;
}

export function judgementPrompt(config: { repository: string }, goal: Goal) {
  const input = { goal: goal.key, statement: goal.statement, users: goal.users, constraints: goal.constraints, deployTarget: goal.deployTarget,
    pullRequest: goal.acceptance!.pr, author: goal.acceptance!.author, outcomes: goal.acceptance!.outcomes };
  return `You are the independent approver of an acceptance draft for ${config.repository}. You did not write it. Judge whether it states what the goal's users asked for, before any code is written. `
    + 'This session is read-only: never edit, commit, push, claim or decide anything, and never ask anyone anything. '
    + 'Approve only when every outcome is in plain language a customer would recognise, together they cover the goal within its constraints, and each one\'s single required uat case checks what the customer sees rather than how it is built. Otherwise refuse, naming what the next draft must change. '
    + `Call the ${acceptanceJudgementTool} tool exactly once with goal "${goal.key}", verdict "approve" or "refuse", and your reason. Stop after the call.\n\n`
    + `The goal and its draft, as JSON:\n${clip(JSON.stringify(input), 80_000)}`;
}

/**
 * One headless run, primary then fallback, as the diagnostician runs (GY-439). A registry role at
 * its concurrency (or paused) defers the goal instead: no fallback starts, so the operator's limit
 * holds however many goals are open.
 */
async function runHeadless<T>(acceptance: AcceptanceEffects, role: 'draft' | 'judge', goal: Goal, prompt: string, validate: (payload: unknown) => T): Promise<{ payload: T | null; runs: string[]; deferred?: string }> {
  const runs: string[] = [];
  const [env, tool] = role === 'draft' ? [acceptanceRole, acceptanceTool] : [acceptanceJudgeRole, acceptanceJudgementTool];
  for (const attempt of ['primary', 'fallback'] as const) {
    let chosen: AcceptanceRun;
    try { chosen = await acceptance.runner(role, attempt, goal); } catch (error) {
      const full = capacityRefusal(error);
      if (full) return { payload: null, runs, deferred: `${full}: ${clip(message(error), 300)}` };
      runs.push(`no ${attempt} runner: ${message(error)}`); continue;
    }
    const run = chosen.runner.start(prompt, { cwd: acceptance.cwd, env: { GRAPHYARD_PI_ROLE: env }, tool, timeoutMs: acceptance.settings.timeoutMinutes * 60_000, validate });
    const result = await run.result();
    await Promise.resolve(chosen.release?.(`the ${attempt} acceptance ${role} of ${goal.key} ended`)).catch(() => {});
    if (result.ok) return { payload: result.payload, runs };
    runs.push(`${chosen.model} ${result.failure.reason}: ${clip(result.failure.detail, 300)}`);
    if (result.failure.reason === 'cancelled') break;
  }
  return { payload: null, runs };
}
const ofGoal = (goal: Goal) => (parsed: { goal: string }) => { if (parsed.goal !== goal.key) throw new Error(`the answer names ${parsed.goal}, not ${goal.key}`); };
function launch(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, role: 'draft' | 'judge') {
  const run = role === 'draft'
    ? declared(acceptance.cwd).then(existing => runHeadless(acceptance, role, goal, acceptancePrompt(cycle.config, goal, existing), payload => {
      const parsed = acceptancePayloadSchema.parse(payload); ofGoal(goal)(parsed); return { outcomes: parsed.outcomes };
    })).then(result => ({ revision: goal.revision, draft: result.payload, runs: result.runs, deferred: result.deferred }))
    : runHeadless(acceptance, role, goal, judgementPrompt(cycle.config, goal), payload => { const parsed = judgementPayloadSchema.parse(payload); ofGoal(goal)(parsed); return parsed; })
      .then(result => ({ revision: goal.revision, judgement: result.payload, runs: result.runs, deferred: result.deferred }));
  live.set(goal.id, run.catch(error => ({ revision: goal.revision, [role === 'draft' ? 'draft' : 'judgement']: null, runs: [message(error)] }))
    .then(result => { pending.set(goal.id, result); }).finally(() => live.delete(goal.id)));
}
const due = (cycle: Cycle, goal: Goal, step: string) => cycle.clock >= (retryAt.get(`${goal.id}:${step}`) ?? -Infinity);
const later = (cycle: Cycle, goal: Goal, step: string, ms: number) => { retryAt.set(`${goal.id}:${step}`, cycle.clock + ms); };
/** A run the full role deferred: dropped, and launched again after one poll interval. */
function deferred(cycle: Cycle, goal: Goal, result: Pending, step: 'draft' | 'judge', note: Note) {
  pending.delete(goal.id); later(cycle, goal, step, acceptancePollMs);
  return note(goal, 'waiting', `The ${step === 'draft' ? 'acceptance role' : 'approver'} is at its registry capacity (${result.deferred}); ${goal.key}'s ${step === 'draft' ? 'draft' : 'judgement'} starts no fallback and is launched again in five minutes`);
}

/**
 * One loop step over every open goal (GY-1417). Each goal moves at most one transition a cycle;
 * a run's result is kept until it is posted, so a failed open or post retries without another
 * model run, and each GitHub read or write is bounded per goal by its interval.
 */
export async function acceptanceStep(cycle: Cycle) {
  const { state, effects, now, performed } = cycle;
  const acceptance = effects.acceptance;
  if (!acceptance?.settings.enabled) return;
  const note: Note = async (goal, outcome, detail) => {
    const key = `acceptance:${goal.id}`;
    if (!detailChanged(state.actions[key], clip(detail, 1000))) return;
    performed.push(await record(state, key, { kind: 'decision', work: goal.key, principal: null, state: outcome, detail: clip(detail, 1000), attempts: (state.actions[key]?.attempts ?? 0) + (outcome === 'failed' ? 1 : 0), cycle: state.cycle }, now(), effects.persist));
  };
  const goals = await cycle.isolate('decision', null, 'the open goals', () => acceptance.goals());
  for (const goal of goals ?? []) {
    await cycle.isolate('decision', null, `the acceptance of ${goal.key}`, async () => {
      const result = pending.get(goal.id);
      if (result && result.revision !== goal.revision) pending.delete(goal.id);
      if (goal.stage === 'acceptance-drafting') return drafting(cycle, acceptance, goal, note);
      if (goal.stage === 'awaiting-approval') return awaiting(cycle, acceptance, goal, note);
      if (goal.stage === 'accepted') return accepted(cycle, acceptance, goal, note);
    });
  }
}

async function drafting(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, note: Note) {
  // A refused or closed draft's pull request is closed (and its branch deleted) before the next draft, so none accumulates.
  // A merge-writer change has no pull request to close: its branch is the coordinator checkout's alone.
  const refused = goal.refusal?.pr != null ? goal.refusal as NonNullable<Goal['refusal']> & { pr: number } : null;
  if (refused && !closedPulls.has(refused.pr) && due(cycle, goal, 'close')) {
    try {
      await acceptance.close(refused.pr, `Closed by the Graphyard loop: ${goal.key}'s acceptance draft was not taken (${clip(refused.reason, 500)}, by ${refused.by}). The next draft opens on a new pull request.`);
      closedPulls.add(refused.pr);
      await note(goal, 'done', `Closed ${goal.key}'s refused acceptance pull request #${refused.pr} and deleted its branch`);
    } catch (error) { later(cycle, goal, 'close', acceptanceStepRetryMs); return note(goal, 'failed', `Could not close ${goal.key}'s refused acceptance pull request #${refused.pr}: ${message(error)}; it is tried again in ten minutes, and the next draft waits for it`); }
  }
  // Closed before the next draft: until then nothing else moves.
  if (refused && !closedPulls.has(refused.pr)) return;
  if ((goal.drafts ?? 0) >= maxDraftRounds)
    return note(goal, 'done', `${goal.key} has had ${goal.drafts} acceptance drafts refused or closed (last: ${clip(goal.refusal?.reason ?? 'none recorded', 300)}); the loop drafts no more and leaves it to the master`);
  const result = pending.get(goal.id);
  if (result && 'draft' in result) {
    if (!result.draft && result.deferred) return deferred(cycle, goal, result, 'draft', note);
    if (!result.draft) {
      pending.delete(goal.id); later(cycle, goal, 'draft', acceptanceRetryMs);
      return note(goal, 'failed', `The acceptance role returned no draft for ${goal.key}: ${result.runs.join('; ')}; it is drafted again in an hour`);
    }
    if (!due(cycle, goal, 'post')) return;
    // A draft the base or the control plane can never take is dropped, so the role drafts new ids within the hourly retry rather than reopening it forever.
    const drop = (error: unknown) => { pending.delete(goal.id); later(cycle, goal, 'draft', acceptanceRetryMs); return note(goal, 'failed', `The acceptance draft for ${goal.key} can never be opened: ${message(error)}; it is dropped and drafted again in an hour`); };
    try { result.opened ??= await openDraft(acceptance, goal, result.draft); }
    catch (error) { if (unopenable(error)) return drop(error); later(cycle, goal, 'post', acceptanceStepRetryMs); return note(goal, 'failed', `The acceptance draft for ${goal.key} could not be opened: ${message(error)}; the same draft is opened again in ten minutes, reusing its branch`); }
    const opened = result.opened, named = opened.pr === null ? `acceptance change ${opened.head.slice(0, 12)} on ${opened.branch}` : `acceptance pull request #${opened.pr}`;
    try { await acceptance.draft(goal, { ...result.draft, ...opened }); }
    catch (error) {
      if (unopenable(error)) { if (opened.pr !== null) await acceptance.close(opened.pr, `Closed by the Graphyard loop: ${clip(message(error), 500)}`).catch(() => {}); return drop(error); }
      later(cycle, goal, 'post', acceptanceStepRetryMs); return note(goal, 'failed', `Opened ${named} for ${goal.key}, but its draft could not be recorded: ${message(error)}; it is posted again in ten minutes`);
    }
    pending.delete(goal.id);
    return note(goal, 'done', `Opened ${named} for ${goal.key}${opened.pr === null ? ' for the merge writer, with no pull request' : ''}: ${result.draft.outcomes.map(entry => `${entry.id} (case ${entry.case.id})`).join(', ')}; it awaits an approver other than its author`);
  }
  if (live.has(goal.id) || !due(cycle, goal, 'draft')) return;
  launch(cycle, acceptance, goal, 'draft');
  await note(goal, 'done', `Launched the acceptance role for ${goal.key} (draft ${(goal.drafts ?? 0) + 1} of at most ${maxDraftRounds}) on ${acceptance.settings.model}, falling back to ${acceptance.settings.fallbackModel}`);
}

/**
 * Under the control-plane merger the draft is committed for the merge writer (GY-1535): one change
 * on its own branch of the coordinator checkout, never pushed and never a pull request. Otherwise,
 * or when the loop has no commit step, it is opened as the acceptance pull request.
 */
async function openDraft(acceptance: AcceptanceEffects, goal: Goal, draft: AcceptanceDraft): Promise<{ pr: number | null; branch: string; head: string }> {
  if (acceptance.commit && acceptance.writer && (await acceptance.merger?.()) === 'control-plane') return { pr: null, ...await acceptance.commit(goal, draft) };
  return acceptance.open(goal, draft);
}

/** The draft's pull request read at most once per poll interval; a pull request closed unmerged sends the goal back to drafting. A merge-writer change has none: it stays open until it is judged. */
async function polled(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, note: Note) {
  if (goal.acceptance!.pr === null) return true;
  if (cycle.clock - (polledAt.get(goal.id) ?? -Infinity) < acceptancePollMs) return null;
  polledAt.set(goal.id, cycle.clock);
  const pr = await acceptance.pullRequest(goal.acceptance!.pr!);
  if (pr.state !== 'closed') return pr;
  const reason = `acceptance pull request #${goal.acceptance!.pr} was closed without merging`;
  await acceptance.closed(goal, goal.acceptance!.pr!, reason);
  await note(goal, 'done', `${goal.key}'s ${reason}, so it goes back to drafting with that reason recorded`);
  return null;
}

async function awaiting(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, note: Note) {
  const result = pending.get(goal.id);
  if (result && 'judgement' in result) {
    if (!result.judgement && result.deferred) return deferred(cycle, goal, result, 'judge', note);
    if (!result.judgement) {
      pending.delete(goal.id); later(cycle, goal, 'judge', acceptanceRetryMs);
      return note(goal, 'failed', `The approver returned no judgement on ${goal.key}'s ${acceptanceName(goal)}: ${result.runs.join('; ')}; it is judged again in an hour`);
    }
    if (!due(cycle, goal, 'verdict')) return;
    try { await acceptance.judge(goal, result.judgement); }
    catch (error) { later(cycle, goal, 'verdict', acceptanceStepRetryMs); return note(goal, 'failed', `The approver's ${result.judgement.verdict} of ${goal.key} could not be recorded: ${message(error)}; it is posted again in ten minutes`); }
    pending.delete(goal.id);
    return note(goal, 'done', `The approver ${result.judgement.verdict === 'approve' ? 'approved' : 'refused'} ${goal.key}'s ${acceptanceName(goal)}: ${clip(result.judgement.reason, 600)}`);
  }
  if (live.has(goal.id)) return;
  if (!await polled(cycle, acceptance, goal, note) || !due(cycle, goal, 'judge')) return;
  launch(cycle, acceptance, goal, 'judge');
  await note(goal, 'done', `Launched the approver's judgement of ${goal.key}'s ${acceptanceName(goal)}, drafted by ${goal.acceptance!.author}`);
}

/**
 * An approved draft is landed by the control plane, asked at most once per poll interval. Merged, its
 * cases are protected. Conflicting with its base (another goal's contract binding merged first) or
 * moved off its approved head, it was closed: the same outcomes are opened again from the current
 * base without another run, and judged again. Not merged a day after its approval, it is the master's.
 */
async function accepted(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, note: Note) {
  const { pr, outcomes } = goal.acceptance!;
  if (pr === null) return landChange(cycle, acceptance, goal, note);
  if (!due(cycle, goal, 'land')) return;
  later(cycle, goal, 'land', acceptancePollMs);
  let answer: { goal: Goal; landing: Landing };
  try { answer = await acceptance.land(goal); }
  catch (error) { return note(goal, 'failed', `Could not land ${goal.key}'s approved acceptance pull request #${pr}: ${message(error)}; it is asked again in five minutes`); }
  const { landing } = answer;
  if (landing.state === 'merged') return note(goal, 'done', `${goal.key}'s acceptance pull request #${pr} merged; its cases ${outcomes.map(outcome => outcome.case.id).join(', ')} are protected`);
  if (landing.state === 'waiting') {
    const approved = goal.approval ? Date.parse(goal.approval.at) : cycle.clock;
    if (cycle.clock - approved > acceptanceStuckMs)
      return note(goal, 'failed', `${goal.key}'s acceptance pull request #${pr} was approved ${goal.approval!.at} and has not merged: ${landing.detail}. The master decides: graphyard goal closed ${goal.key} ${pr} -- REASON drafts it again`);
    return note(goal, 'done', `Published the gate verdicts on ${goal.key}'s approved acceptance pull request #${pr} and asked GitHub to merge it: ${landing.detail}; asked again in five minutes`);
  }
  closedPulls.add(pr);
  if (landing.state === 'unapproved') return note(goal, 'failed', `${goal.key}'s ${landing.detail}. It went back to drafting with that reason recorded; the master decides what the merged files stand for`);
  if (landing.state !== 'closed') pending.set(goal.id, { revision: answer.goal.revision, draft: { outcomes }, runs: [] });
  return note(goal, 'done', `${goal.key}'s ${landing.detail}, so it went back to drafting${landing.state === 'closed' ? ' with that reason recorded' : '; the same outcomes are opened again from the current base and judged again'}`);
}

/**
 * GY-1535: an approved merge-writer change is landed by the merge writer's own steps, tried at most
 * once per poll interval. Merged, the control plane records it (checking the base holds the merge
 * commit) and protects its cases exactly as a merged acceptance pull request; a lost record is posted
 * again without a second push. Conflicting with its base or moved off its approved head, it is
 * recorded closed and the same outcomes are committed again from the current base and judged again.
 */
async function landChange(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, note: Note) {
  const { outcomes } = goal.acceptance!, named = acceptanceName(goal);
  if (!due(cycle, goal, 'land')) return;
  later(cycle, goal, 'land', acceptancePollMs);
  if (!acceptance.writer || !acceptance.landed)
    return note(goal, 'failed', `${goal.key}'s ${named} is approved for the merge writer, but this loop runs without the merge writer's steps; it is tried again in five minutes`);
  let landing: Landing;
  try { landing = await mergeAcceptanceChange(acceptance.writer, goal); }
  catch (error) { return note(goal, 'failed', `The merge writer could not land ${goal.key}'s ${named}: ${message(error)}; it is tried again in five minutes`); }
  if (landing.state === 'merged') {
    try { await acceptance.landed(goal, landing.mergeSha!); }
    catch (error) { return note(goal, 'failed', `The merge writer landed ${goal.key}'s ${named} as ${landing.mergeSha}, but it could not be recorded merged: ${message(error)}; it is recorded again in five minutes, without a second push`); }
    return note(goal, 'done', `${landing.detail}; ${goal.key}'s cases ${outcomes.map(outcome => outcome.case.id).join(', ')} are protected and it moves to planning`);
  }
  if (landing.state === 'waiting') {
    const approved = goal.approval ? Date.parse(goal.approval.at) : cycle.clock;
    if (cycle.clock - approved > acceptanceStuckMs)
      return note(goal, 'failed', `${goal.key}'s ${named} was approved ${goal.approval!.at} and the merge writer has not landed it: ${landing.detail}. The master decides: graphyard goal closed ${goal.key} change -- REASON drafts it again`);
    return note(goal, 'done', `The merge writer has not landed ${goal.key}'s ${named} yet: ${landing.detail}; it is tried again in five minutes`);
  }
  let reopened: Goal;
  try { reopened = await acceptance.closed(goal, null, landing.detail); }
  catch (error) { return note(goal, 'failed', `${goal.key}'s ${landing.detail}, but it could not be recorded closed: ${message(error)}; it is tried again in five minutes`); }
  if (landing.state === 'unapproved') return note(goal, 'failed', `${goal.key}'s ${landing.detail}. It went back to drafting with that reason recorded`);
  pending.set(goal.id, { revision: reopened.revision, draft: { outcomes }, runs: [] });
  return note(goal, 'done', `${goal.key}'s ${landing.detail}, so it went back to drafting; the same outcomes are committed again from the current base and judged again`);
}

/**
 * GY-1535: one approved acceptance change through the merge writer's steps. The change is classified
 * sensitive (model/goal.ts acceptanceChangeRisk), so it lands only on the approver identity's verdict
 * on its exact head, by an identity other than its author, and only when the merge adds nothing but
 * its cases and the contract. The merge commit of the head onto the fetched tip is pushed leased on
 * that tip, made again on a moved tip up to the writer's retrials; a head the base already holds a
 * merge of is answered merged without a push.
 */
export async function mergeAcceptanceChange(writer: AcceptanceWriterPorts, goal: Goal): Promise<Landing> {
  const { acceptance, approval } = goal;
  if (!acceptance || acceptance.pr !== null || !approval || goal.stage !== 'accepted') throw new Error(`${goal.key} is ${goal.stage}; only an approved merge-writer acceptance change is landed by the merge writer`);
  const named = acceptanceName(goal);
  if (approval.head !== acceptance.head) return { state: 'moved', mergeSha: null, detail: `${named} is not the approved head ${approval.head.slice(0, 12)}` };
  if (approval.by === acceptance.author) return { state: 'unapproved', mergeSha: null, detail: `${named} was approved by its own author ${approval.by}; a sensitive change lands only on another identity's verdict` };
  const already = await writer.merged(acceptance.head);
  if (already) return { state: 'merged', mergeSha: already, detail: `${writer.baseBranch} already holds ${goal.key}'s ${named} as ${already}` };
  const allowed = new Set(draftFiles({ outcomes: acceptance.outcomes }, null).map(file => file.path));
  for (let tries = 0; tries <= writer.retrials; tries++) {
    const tip = await writer.fetch();
    const merged = await writer.merge(acceptance.head, tip);
    if ('conflict' in merged) return { state: 'conflicting', mergeSha: null, detail: `${named} conflicts with ${writer.baseBranch} at ${tip.slice(0, 12)} in ${merged.conflict.slice(0, 20).join(', ')}` };
    const stray = merged.files.filter(path => !allowed.has(path));
    if (stray.length) return { state: 'unapproved', mergeSha: null, detail: `${named} changes ${stray.slice(0, 20).join(', ')}, which are not its cases or contract; no approver judged them` };
    const risk = acceptanceChangeRisk(merged.files);
    if ((await writer.push(merged.mergeSha, tip)) === 'pushed') {
      await writer.fetch();
      return { state: 'merged', mergeSha: merged.mergeSha, detail: `The merge writer merged ${goal.key}'s ${named} as ${merged.mergeSha} onto ${writer.baseBranch} at ${tip.slice(0, 12)}: a ${risk.risk} change (${clip(risk.reasons.join('; '), 300)}) approved by ${approval.by}, not its author ${acceptance.author}` };
    }
  }
  return { state: 'waiting', mergeSha: null, detail: `${named}'s push was refused: ${baseMovedReason(writer.retrials + 1)}` };
}

/** The draft's cases and contract bindings committed on the goal's branch for this revision, in a throwaway checkout of the base tip that shares `root`'s object store; `after` runs before it is removed. */
async function commitDraft<T>(run: ChildRun, root: string, scratch: string, config: { baseBranch: string }, goal: Goal, draft: AcceptanceDraft,
  after: (commit: { directory: string; branch: string; head: string }) => Promise<T>): Promise<T> {
  await run('git', ['-C', root, 'fetch', '--no-tags', 'origin', config.baseBranch]);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'graphyard-acceptance-'));
  try {
    await run('git', ['-C', root, 'worktree', 'add', '--detach', directory, `origin/${config.baseBranch}`]);
    const contract = await readFile(join(directory, contractFile), 'utf8').then(source => parseContract(source), () => null);
    let files: ReturnType<typeof draftFiles>;
    try { files = draftFiles(draft, contract); } catch (error) { throw new UnopenableDraft(message(error)); }
    for (const file of files) {
      if (file.path !== contractFile && await stat(join(directory, file.path)).then(() => true, () => false)) throw new UnopenableDraft(`${file.path} already exists on ${config.baseBranch}; the draft must name a new case`);
      // A brand-new repository has no e2e/ yet: its first goal's change creates it.
      await mkdir(dirname(join(directory, file.path)), { recursive: true });
      await writeFile(join(directory, file.path), file.content);
    }
    // One branch per draft revision, owned by the loop: a retry moves it and reuses what was opened there.
    const branch = `graphyard/${goal.key.toLowerCase()}-acceptance-${goal.revision}`;
    await run('git', ['-C', directory, 'checkout', '-B', branch]);
    await run('git', ['-C', directory, 'add', '--', ...files.map(file => file.path)]);
    await run('git', ['-C', directory, 'commit', '-m', `${goal.key}: customer outcomes and required E2E cases\n\n${goal.statement}`]);
    const head = String(await run('git', ['-C', directory, 'rev-parse', 'HEAD'])).trim();
    return await after({ directory, branch, head });
  } finally {
    await Promise.resolve(run('git', ['-C', root, 'worktree', 'remove', '--force', directory])).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

/** GY-1535: the draft committed for the merge writer on its branch of the coordinator checkout `root`: nothing is pushed and no pull request is opened. */
export const commitAcceptanceChange = (run: ChildRun, root: string, scratch: string, config: { baseBranch: string }, goal: Goal, draft: AcceptanceDraft) =>
  commitDraft(run, root, scratch, config, goal, draft, async ({ branch, head }) => ({ branch, head }));

/** The merge commit on `ref`'s first-parent history whose second parent is `head`, or null when the base holds none. */
export async function mergedOnBase(git: (...args: string[]) => Promise<string>, ref: string, head: string): Promise<string | null> {
  try { await git('merge-base', '--is-ancestor', head, ref); } catch { return null; }
  const lines = (await git('rev-list', '--first-parent', '--parents', ref)).split('\n');
  for (const line of lines) { const [sha, , second] = line.trim().toLowerCase().split(' '); if (second === head.toLowerCase()) return sha!; }
  return null;
}

export const openAcceptancePullRequest = (run: ChildRun, root: string, scratch: string, config: { repository: string; baseBranch: string }, goal: Goal, draft: AcceptanceDraft) =>
  commitDraft(run, root, scratch, config, goal, draft, async ({ directory, branch, head }) => {
    // A retry force-pushes the draft's branch and reuses its open pull request.
    await run('git', ['-C', directory, 'push', '--force', 'origin', `HEAD:refs/heads/${branch}`]);
    const open = JSON.parse(String(await run('gh', ['pr', 'list', '--repo', config.repository, '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1']))) as { number: number }[];
    if (open[0]) return { pr: open[0].number, branch, head };
    const body = [`Acceptance for ${goal.key}: ${goal.statement}`, '', ...draft.outcomes.map(outcome => `- **${outcome.title}** (${outcome.id}), proved by required uat case \`${outcome.case.id}\`: ${outcome.criteria.join('; ')}`), '',
      'Drafted by the acceptance role and judged by the approver identity, never its author; once approved Graphyard lands it at the approved head, and its cases and bindings are protected from then on.'].join('\n');
    const url = String(await run('gh', ['pr', 'create', '--repo', config.repository, '--base', config.baseBranch, '--head', branch, '--title', `${goal.key}: acceptance — ${clip(goal.statement, 80)}`, '--body', body])).trim();
    const pr = Number(url.match(/\/pull\/(\d+)/)?.[1]);
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error(`gh pr create answered ${clip(url, 200)}, which names no pull request`);
    return { pr, branch, head };
  });

interface Calls {
  run: ChildRun; fetcher: typeof fetch;
  asCoordinator: (path: string) => Promise<any>;
  asOperatorAgent: (method: 'GET' | 'POST', path: string, body?: unknown, key?: string) => Promise<any>;
  /** GY-1535: the recorded merger and the merge writer's reads over the coordinator checkout; absent, every draft is a pull request. */
  merger?: () => Promise<MergerMode>;
  writer?: Pick<MergeWriterReads, 'baseBranch' | 'retrials' | 'fetch' | 'merge' | 'push'>;
}
/**
 * The acceptance role's effects under the live configuration: runners as the diagnostician's (the
 * registry's acceptance or approver role when an operator defines one, else Pi on
 * `run.diagnostician`'s models, whatever its `enabled`), drafts posted as the master's operator-agent identity and verdicts as the
 * approver identity, so the author of a draft never judges it, and GitHub through `gh`. Under the
 * control-plane merger (GY-1535) a draft is committed in the coordinator checkout instead and landed
 * by the merge writer's reads, recorded merged as the operator agent.
 */
export function acceptanceEffects(config: MasterConfig, root: string, calls: Calls): AcceptanceEffects {
  // The diagnostician's model settings, but enabled on its own: `run.diagnostician.enabled: false` never holds a goal.
  const { run } = calls, settings = { ...diagnosticianSettings(config.run), enabled: true };
  const gh = async (args: string[]) => String(await run('gh', [...args, '--repo', config.repository]));
  const asApprover = async (path: string, body: unknown, key: string) => {
    const response = await calls.fetcher(`${config.url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${await agentToken(root, config, 'approver')}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`);
    return result;
  };
  const read = async (pr: number): Promise<PullRequestState> => {
    const view = JSON.parse(await gh(['pr', 'view', String(pr), '--json', 'state,mergeCommit,headRefOid']));
    return { state: view.state === 'MERGED' ? 'merged' : view.state === 'CLOSED' ? 'closed' : 'open', mergeSha: view.mergeCommit?.oid ?? null, head: view.headRefOid ?? null };
  };
  return {
    settings, cwd: root,
    goals: async () => (await calls.asCoordinator('goals?open=1')).goals,
    runner: async (role, attempt, goal) => {
      if (attempt === 'primary') {
        const [name, principal] = role === 'draft' ? [acceptanceRole, config.operatorAgent!.id] as const : ['approver', config.approver!.id] as const;
        const fleet = await selectFleetSession(config, name, { name, principal }, await heldAwareProbe(config, { work: goal.key })); // an account held here, or its twin, is spent (GY-1574)
        if (fleet) { const launched = registryHeadlessLaunch(fleet.account); return { runner: registryRunner(fleet.account), runtime: launched.command, model: launched.model, release: fleet.release }; }
      }
      const model = attempt === 'primary' ? settings.model : settings.fallbackModel;
      return { runner: piRunner({ command: settings.command, model }), runtime: 'pi', model };
    },
    open: (goal, draft) => openAcceptancePullRequest(run, root, worktreeRoot(root, config), config, goal, draft),
    draft: (goal, input) => calls.asOperatorAgent('POST', `goals/${goal.key}/draft`, input, `acceptance:${goal.id}:${goal.revision}`),
    judge: (goal, judgement) => asApprover(`goals/${goal.key}/${judgement.verdict}`, { reason: judgement.reason }, `acceptance:${goal.id}:${goal.revision}:judged`),
    pullRequest: read,
    land: goal => calls.asOperatorAgent('POST', `goals/${goal.key}/land`, {}, `acceptance:${goal.id}:${goal.revision}:land:${Date.now()}`),
    close: async (pr, comment) => { if ((await read(pr)).state === 'open') await gh(['pr', 'close', String(pr), '--comment', comment, '--delete-branch']); },
    closed: (goal, pr, reason) => calls.asOperatorAgent('POST', `goals/${goal.key}/closed`, { pr, reason }, `acceptance:${goal.id}:${goal.revision}:closed`),
    ...(calls.merger && calls.writer ? {
      merger: calls.merger,
      commit: (goal: Goal, draft: AcceptanceDraft) => commitAcceptanceChange(run, root, worktreeRoot(root, config), config, goal, draft),
      writer: { ...calls.writer, merged: (head: string) => mergedOnBase(async (...args) => String(await run('git', ['-C', root, ...args])), `refs/remotes/origin/${calls.writer!.baseBranch}`, head) },
      landed: (goal: Goal, mergeSha: string) => calls.asOperatorAgent('POST', `goals/${goal.key}/land`, { mergeSha }, `acceptance:${goal.id}:${goal.revision}:landed:${mergeSha}`),
    } : {}),
  };
}
