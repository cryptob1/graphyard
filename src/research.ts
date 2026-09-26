import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, isClosed, operatorScopeIncludes, type Principal, type Work } from './model.js';
import { humanOnlyRefusal, parkRule } from './model/human-request.js';
import { defaultPiModel, piRunner } from './runner/pi.js';
import type { Run, RunResult, Runner } from './runner/types.js';
import { save } from './store.js';
import type { Services } from './server/routes.js';

// ---------------------------------------------------------------------------
// Research before build (GY-259).
//
// A worker used to start from the ticket alone and rediscover the codebase, its conventions and
// the prior art during the expensive build, and a product ambiguity surfaced late, as a review
// finding or a rework round. Before a feature item (or any item whose intent sets
// `"research": true`) is dispatched, the loop now runs one cheap Pi session through the GY-169
// headless runner on the research model (`run.research` in .graphyard/master.json, the Z.AI GLM
// flash model by default). It submits a brief through a typed Graphyard tool: the existing code
// and conventions to reuse, external patterns and prior art with their sources, risks and edge
// cases, a recommended approach, and the product questions only the operator may answer.
//
// Nothing here ever holds the item. A question becomes a goals-and-priorities request under Needs
// you with a recommended answer and a deadline, and the build proceeds at once on the
// recommendation, marked provisional. A later answer is added to the brief; one that differs from
// the recommendation an attempt already built on returns that head for rework. A run that fails,
// times out or overruns its token budget is recorded as a failure, and the item is dispatched
// without a brief. One run per item per requirements revision.
// ---------------------------------------------------------------------------

/**
 * A product question the research step raised (GY-259). It is asked of the operator in Graphyard
 * as a goals-and-priorities request with a recommended answer and a deadline, and never holds the
 * build: the item proceeds on the recommendation, marked provisional, until an answer arrives.
 * `answer.epoch` is the attempt current when it arrived and `inFlight` whether an attempt was
 * building or submitted then; a differing answer to an attempt in flight returns its head.
 */
export interface ResearchQuestion {
  id: string; kind: 'goals-and-priorities';
  question: string; why: string; recommendation: string;
  at: string; deadline: string;
  answer: { by: string; at: string; text: string; differs: boolean; epoch: number; inFlight: boolean; waitedMs: number } | null;
}
/** The research brief the loop recorded on the item, or the failure that left it without one (GY-259, src/research.ts). */
export interface ResearchRecord {
  /** The requirements revision researched: a digest of title, description and criteria. One run per revision. */
  revision: string;
  state: 'running' | 'recorded' | 'failed';
  startedAt: string; endedAt: string | null;
  runtime: string; model: string; timeoutMs: number; tokenBudget: number;
  /** The tokens the run streamed, as the runner estimated them; null when the record predates the count (GY-434). */
  tokens: number | null;
  brief: {
    existingCode: { path: string; note: string }[];
    patterns: { pattern: string; source: string }[];
    risks: string[];
    approach: string;
  } | null;
  questions: ResearchQuestion[];
  failure: { reason: string; detail: string } | null;
  recordedBy: string;
}

/** The Graphyard Pi tool whose call is the research session's submission (integrations/pi). */
export const researchTool = 'graphyard_research_brief';
/** The role the Pi extension registers the research tool for. */
export const researchRole = 'research';

const line = (max: number) => z.string().trim().min(1).max(max);
/** What `graphyard_research_brief` submits, as the control plane re-validates it. */
export const researchBriefSchema = z.object({
  existingCode: z.array(z.object({ path: line(500), note: line(1000) }).strict()).max(40),
  patterns: z.array(z.object({ pattern: line(1000), source: line(500) }).strict()).max(20),
  risks: z.array(line(1000)).max(20),
  approach: line(6000),
  questions: z.array(z.object({ question: line(1000), why: line(1000), recommendation: line(1000) }).strict()).max(10),
}).strict();
export type ResearchBrief = z.infer<typeof researchBriefSchema>;

/**
 * `run.research` in .graphyard/master.json. `command` is the environment wrapper or Pi binary the
 * research account runs through (it defaults to `run.pi.command`), `model` the cheapest model
 * configured for research, `timeoutMinutes` the bound on one run, `tokenBudget` the estimated
 * tokens one run may stream before it is stopped, and `questionDeadlineHours` how long a product
 * question waits for the operator before its recommendation stands unchallenged.
 */
export const researchSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().trim().min(1).max(500).optional(),
  model: z.string().trim().min(1).max(200).default(defaultPiModel),
  timeoutMinutes: z.number().int().min(1).max(60).default(15),
  tokenBudget: z.number().int().min(1_000).max(5_000_000).default(200_000),
  questionDeadlineHours: z.number().min(0.25).max(168).default(4),
}).strict();
export type ResearchSettings = z.infer<typeof researchSettingsSchema> & { command: string };
/** The research settings in force: `run.research` over its defaults, Pi's command from `run.pi` when research names none. */
export function researchSettings(run: { research?: unknown; pi?: { command?: string } } | undefined): ResearchSettings {
  const parsed = researchSettingsSchema.parse(run?.research ?? {});
  return { ...parsed, command: parsed.command ?? run?.pi?.command ?? 'pi' };
}

/** A feature is researched unless its intent says `"research": false`; a bug or chore only when it says `true`. */
export const researchWanted = (work: Pick<Work, 'type' | 'research'>) => work.research === true || work.type === 'feature' && work.research !== false;
/** The requirements revision: what the item asks for, digested. A new revision is researched afresh; nothing else starts a second run. */
export function requirementsRevision(work: Pick<Work, 'title' | 'description' | 'criteria'>) {
  return createHash('sha256').update(JSON.stringify([work.title, work.description ?? '', work.criteria.map(criterion => [criterion.id, criterion.text])])).digest('hex').slice(0, 16);
}
/** The record for the item's current requirements, or null when this revision was never researched. */
export const currentResearch = (work: Pick<Work, 'title' | 'description' | 'criteria' | 'researchBrief'>) =>
  work.researchBrief && work.researchBrief.revision === requirementsRevision(work) ? work.researchBrief : null;
/** How long past its timeout a run recorded as running still holds dispatch: the runner stops it at the timeout, and its failure is posted within this. */
export const researchHoldGraceMs = 60_000;
/**
 * Whether dispatch waits for this item's research: only while a run for its current requirements
 * is recorded as running and its time limit (plus the grace to record its end) has not passed. A
 * run nobody finished — the loop restarted under it — stops holding at that same bound.
 */
export function researchHold(work: Work, clock: number) {
  const record = researchWanted(work) ? currentResearch(work) : null;
  return !!record && record.state === 'running' && clock < Date.parse(record.startedAt) + record.timeoutMs + researchHoldGraceMs;
}

// ---- What the loop records on the item, and the operator's answers -------------------------------

export const researchEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('started'), revision: z.string().regex(/^[0-9a-f]{16}$/), runtime: line(40), model: line(200),
    timeoutMs: z.number().int().positive().max(3_600_000), tokenBudget: z.number().int().positive() }).strict(),
  z.object({ event: z.literal('recorded'), revision: z.string().regex(/^[0-9a-f]{16}$/), brief: researchBriefSchema,
    questionDeadlineMs: z.number().int().positive().max(7 * 24 * 3_600_000).default(4 * 3_600_000),
    tokens: z.number().int().nonnegative().max(1_000_000_000).optional() }).strict(),
  z.object({ event: z.literal('failed'), revision: z.string().regex(/^[0-9a-f]{16}$/), reason: line(40), detail: line(1000) }).strict(),
]);
export type ResearchEvent = z.input<typeof researchEventSchema>;
export const researchAnswerSchema = z.object({ question: z.string().uuid(), answer: line(4000) }).strict();

/**
 * Apply one research event to the item: the one transition the server makes and the loop's tests
 * replay. A run is started once per requirements revision, and only a running run records its end.
 */
export function applyResearchEvent(work: Work, input: ResearchEvent, actor: string, now: Date): ResearchRecord {
  const event = researchEventSchema.parse(input), at = now.toISOString();
  const existing = work.researchBrief?.revision === event.revision ? work.researchBrief : null;
  demand(event.revision === requirementsRevision(work), `${work.key}'s requirements are at revision ${requirementsRevision(work)}, not ${event.revision}; reload before recording research`);
  if (event.event === 'started') {
    demand(!existing, `${work.key} was already researched at requirements revision ${event.revision} (${existing?.state}); one run per revision`);
    work.researchBrief = { revision: event.revision, state: 'running', startedAt: at, endedAt: null, runtime: event.runtime, model: event.model,
      timeoutMs: event.timeoutMs, tokenBudget: event.tokenBudget, tokens: null, brief: null, questions: [], failure: null, recordedBy: actor };
    return work.researchBrief;
  }
  demand(existing?.state === 'running', `${work.key} has no research run at revision ${event.revision} to record the end of`);
  if (event.event === 'failed') {
    work.researchBrief = { ...existing!, state: 'failed', endedAt: at, tokens: existing!.tokens ?? null, failure: { reason: event.reason, detail: event.detail } };
    return work.researchBrief;
  }
  const { questions, ...brief } = event.brief;
  const deadline = new Date(now.getTime() + event.questionDeadlineMs).toISOString();
  work.researchBrief = { ...existing!, state: 'recorded', endedAt: at, tokens: event.tokens ?? null, brief,
    questions: questions.map(question => ({ id: randomUUID(), kind: 'goals-and-priorities', ...question, at, deadline, answer: null })) };
  return work.researchBrief;
}

const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const agreement = /^(yes|ok|okay|agreed|agree|approved|approve|fine|sounds good|go with (the )?recommendation|as recommended|recommended|use (the )?recommendation|accept(ed)?( (the )?recommendation)?)$/;
/** Whether an answer departs from the recommendation the build proceeded on: an agreement, or the recommendation itself, does not. */
export function answerDiffers(answer: string, recommendation: string) {
  const said = normalized(answer);
  return !(said === normalized(recommendation) || agreement.test(said));
}

/**
 * Apply the operator's answer to one product question. It is kept on the brief with the attempt
 * current when it arrived and whether that attempt was already building or submitted, which is
 * what decides a rework (`researchRework`).
 */
export function applyResearchAnswer(work: Work, input: z.input<typeof researchAnswerSchema>, actor: string, now: Date): ResearchQuestion {
  const data = researchAnswerSchema.parse(input);
  const record = work.researchBrief;
  const index = record?.questions.findIndex(question => question.id === data.question) ?? -1;
  demand(record && index >= 0, `${work.key} has no research question ${data.question}; reload before answering`, 404);
  const question = record!.questions[index];
  demand(!question.answer, `Research question ${question.id} on ${work.key} was already answered by ${question.answer?.by}`);
  const answered: ResearchQuestion = { ...question, answer: { by: actor, at: now.toISOString(), text: data.answer, differs: answerDiffers(data.answer, question.recommendation),
    epoch: work.epoch, inFlight: !!work.lease || !!work.submission, waitedMs: Math.max(0, now.getTime() - Date.parse(question.at)) } };
  work.researchBrief = { ...record!, questions: record!.questions.map((entry, position) => position === index ? answered : entry) };
  return answered;
}

/**
 * The rework a late answer calls for: an answer that differs from the recommendation an attempt
 * was already building on, while that attempt's head is the candidate. A head submitted by a later
 * attempt was launched with the answer in its brief, so it is not sent back for it.
 */
export function researchRework(work: Pick<Work, 'key' | 'submission' | 'candidate' | 'reworkRequested' | 'researchBrief'>): { reason: string; binding: string } | null {
  if (!work.submission || !work.candidate || work.reworkRequested) return null;
  const late = (work.researchBrief?.questions ?? []).filter(question => question.answer?.differs && question.answer.inFlight && work.submission!.epoch <= question.answer.epoch);
  if (!late.length) return null;
  const named = late.map(question => `"${question.question.slice(0, 200)}" was answered "${question.answer!.text.slice(0, 300)}", not the provisional "${question.recommendation.slice(0, 200)}"`).join('; ');
  return { reason: `${work.key}: the operator answered product questions after the head was built on the research brief's provisional recommendations: ${named}. The candidate returns to a worker to build on the answer.`,
    binding: `${work.candidate.sha}:research:${late.map(question => question.id.slice(0, 8)).join(',')}` };
}

// ---- The prompts: the research session's, and the brief the worker and reviewer start from -------

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

export function researchPrompt(config: { repository: string }, work: Pick<Work, 'key' | 'title' | 'type' | 'description' | 'criteria' | 'plannedFiles'>, settings: Pick<ResearchSettings, 'timeoutMinutes' | 'tokenBudget'>) {
  return `You are the Graphyard research agent for ${config.repository}. An implementation worker on a more expensive model will build ${work.key} (${work.type}): ${work.title}. Before it starts, research the item so it begins from what already exists instead of rediscovering it. `
    + (work.description ? `The item's description: ${clip(work.description, 6000)} ` : '')
    + `Its acceptance criteria: ${work.criteria.map(criterion => `${criterion.id}: ${clip(criterion.text, 1500)}`).join(' ')} `
    + (work.plannedFiles?.length ? `Its planned files: ${work.plannedFiles.join(', ')}. ` : '')
    + 'Read this checkout (it is the base branch) and, where it helps, the outside world, and find: the existing code and conventions to reuse, as paths with what each offers; relevant external patterns and prior art, each with its source (a URL, a library, a standard, or a path); the risks and edge cases; and the approach you recommend. '
    + 'List as product questions only questions about the product experience whose answer is the operator\'s to choose (goals and priorities), each with why it matters and a concrete recommended answer: the build proceeds on your recommendation until the operator answers, so recommend what you would ship. Settle every engineering question yourself in the approach. '
    + `This session is read-only and nobody reads it: do not edit, commit, push, claim work, run the build or tests, or ask anyone anything. Keep within about ${settings.tokenBudget} tokens and ${settings.timeoutMinutes} minutes. `
    + `Then call the ${researchTool} tool exactly once with existingCode, patterns, risks, approach and questions, and stop.`;
}

/** The product decisions as a worker or reviewer reads them: each answered one, and each still provisional on its recommendation. */
export function researchDecisions(record: Pick<ResearchRecord, 'questions'>) {
  return record.questions.map(question => question.answer
    ? `${question.question} — answered by the operator: ${question.answer.text}`
    : `${question.question} — provisional (the operator has not answered; deadline ${question.deadline}): ${question.recommendation}`);
}
const briefText = (record: ResearchRecord, limit: number) => {
  const brief = record.brief!;
  return clip([
    brief.existingCode.length ? `Existing code to reuse: ${brief.existingCode.map(entry => `${entry.path} (${entry.note})`).join('; ')}.` : '',
    brief.patterns.length ? `Patterns and prior art: ${brief.patterns.map(entry => `${entry.pattern} [${entry.source}]`).join('; ')}.` : '',
    brief.risks.length ? `Risks and edge cases: ${brief.risks.join('; ')}.` : '',
    `Recommended approach: ${brief.approach}`,
    record.questions.length ? `Product decisions: ${researchDecisions(record).join('; ')}.` : '',
  ].filter(Boolean).join(' '), limit);
};

/** The worker's launch request carries the brief and the product decisions; a failed run is said so, and build proceeds from the criteria. */
export function researchWorkerSection(work: Pick<Work, 'key' | 'title' | 'description' | 'criteria' | 'researchBrief'>, cliPath: string) {
  const record = currentResearch(work);
  if (!record) return '';
  if (record.state !== 'recorded' || !record.brief) return record.state === 'failed' ? `The research step for ${work.key} did not produce a brief (${record.failure?.reason}: ${clip(record.failure?.detail ?? '', 200)}); start from the criteria. ` : '';
  return `Start from the research brief a research session recorded for ${work.key} (the whole brief is researchBrief in node ${cliPath} status ${work.key}): ${briefText(record, 6000)} `
    + 'Build on the answered product decisions as given and on the provisional ones as their recommendation; an answer that arrives later is added to the brief, and one that differs returns the head for rework. ';
}

/** The reviewer checks the change against the brief's recommended approach and the operator's answered questions. */
export function researchReviewSection(work: Pick<Work, 'key' | 'title' | 'description' | 'criteria' | 'researchBrief'>) {
  const record = currentResearch(work);
  if (!record || record.state !== 'recorded' || !record.brief) return '';
  const answered = record.questions.filter(question => question.answer);
  return `A research brief was recorded for ${work.key} before it was built. Check the change against its recommended approach: ${clip(record.brief.approach, 2000)} `
    + (answered.length ? `and against the operator's answered product questions: ${researchDecisions({ questions: answered }).join('; ')}. A change that contradicts an answered question does not meet what the operator asked for and is BLOCKING. ` : '')
    + (record.questions.length > answered.length ? `Questions still provisional were built on their recommendations: ${researchDecisions({ questions: record.questions.filter(question => !question.answer) }).join('; ')}. ` : '')
    + 'A departure from the recommended approach that the pull request does not justify is a FOLLOW-UP unless it leaves a criterion unmet. ';
}

// ---- The loop's step -----------------------------------------------------------------------------

export interface ResearchStepAction { work: string; state: 'started' | 'done' | 'failed'; detail: string }
interface LiveResearch { revision: string; run: Run<ResearchBrief>; settled: Promise<void> }
const live = new Map<string, LiveResearch>();
/** The research run this process has live for an item, if any. */
export const researchRunning = (workId: string) => live.get(workId) ?? null;
/** Test seam: stop and forget every research run. */
export function clearResearchRuns() { for (const entry of live.values()) entry.run.cancel('the research runs were cleared'); live.clear(); }

/** The research runner: Pi on the research account and model. */
export const researchRunner = (settings: ResearchSettings): Runner => piRunner({ command: settings.command, model: settings.model });
/** Roughly four characters a token: what a run has streamed, for its budget. */
const estimatedTokens = (text: string) => Math.ceil(text.length / 4);

export interface ResearchStepInput {
  /** The items dispatch would offer this cycle, in order. */
  items: readonly Work[];
  clock: number;
  settings: ResearchSettings;
  config: { repository: string };
  /** The checkout the research session reads: the loop's own. */
  cwd: string;
  runner: Runner;
  /** Records an event on the item through the control plane (POST work/ID/research as the coordinator). */
  record: (work: Work, event: ResearchEvent) => Promise<unknown>;
}

/**
 * Research the items about to be dispatched. An item whose current requirements were never
 * researched gets one run, recorded as started before it launches; the run settles on its own
 * and records the brief or the failure. The result names every item dispatch must hold this
 * cycle — only those with a run in progress within its bound — and what the step did.
 */
export async function researchStep(input: ResearchStepInput): Promise<{ held: Set<string>; actions: ResearchStepAction[] }> {
  const held = new Set<string>(), actions: ResearchStepAction[] = [];
  for (const work of input.items) {
    if (!researchWanted(work) || !input.settings.enabled) continue;
    const revision = requirementsRevision(work), running = live.get(work.id);
    if (running?.revision === revision) { held.add(work.id); continue; }
    const record = currentResearch(work);
    if (record) {
      if (record.state !== 'running') continue;
      if (researchHold(work, input.clock)) { held.add(work.id); continue; }
      // A run recorded as running that this process is not running and whose bound has passed:
      // the loop restarted under it. Its failure is recorded and the item is built without a brief.
      try {
        await input.record(work, { event: 'failed', revision, reason: 'timeout', detail: `No research run finished within ${Math.round(record.timeoutMs / 60_000)} minutes of ${record.startedAt}; build proceeds without a brief` });
        actions.push({ work: work.key, state: 'failed', detail: `${work.key}'s research run never finished within its bound; build proceeds without a brief` });
      } catch (error) { actions.push({ work: work.key, state: 'failed', detail: `Could not record ${work.key}'s unfinished research run: ${message(error)}` }); }
      continue;
    }
    const timeoutMs = input.settings.timeoutMinutes * 60_000;
    try { await input.record(work, { event: 'started', revision, runtime: input.runner.name, model: input.settings.model, timeoutMs, tokenBudget: input.settings.tokenBudget }); }
    catch (error) {
      // Research never blocks: a plane that cannot record the run gets no run, and dispatch goes on.
      actions.push({ work: work.key, state: 'failed', detail: `Research for ${work.key} was not started, so it is built without a brief: ${message(error)}` });
      continue;
    }
    held.add(work.id);
    const run = input.runner.start(researchPrompt(input.config, work, input.settings), {
      cwd: input.cwd, env: { GRAPHYARD_PI_ROLE: researchRole }, tool: researchTool, timeoutMs, validate: payload => researchBriefSchema.parse(payload) });
    let streamed = 0, overBudget = false;
    run.onEvent(event => {
      if (event.kind !== 'message' && event.kind !== 'tool-end') return;
      streamed += estimatedTokens(event.text);
      if (streamed > input.settings.tokenBudget && !overBudget) { overBudget = true; run.cancel(`the run streamed about ${streamed} tokens, over its ${input.settings.tokenBudget}-token budget`); }
    });
    const settled = run.result().then(result => settleResearch(input, work, revision, result, overBudget, streamed)).catch(() => {}).finally(() => { if (live.get(work.id)?.run === run) live.delete(work.id); });
    live.set(work.id, { revision, run, settled });
    actions.push({ work: work.key, state: 'started', detail: `Researching ${work.key} on ${input.settings.model} before build (at most ${input.settings.timeoutMinutes} minutes and ${input.settings.tokenBudget} tokens); dispatch waits for its brief` });
  }
  return { held, actions };
}

/** Record how a run ended: its brief, or its failure — with what the run streamed, as the token spend (GY-434). Either way the item is dispatched on the next cycle. */
async function settleResearch(input: ResearchStepInput, work: Work, revision: string, result: RunResult<ResearchBrief>, overBudget: boolean, tokens: number) {
  if (result.ok) {
    await input.record(work, { event: 'recorded', revision, brief: result.payload, tokens, questionDeadlineMs: Math.round(input.settings.questionDeadlineHours * 3_600_000) });
    return;
  }
  const reason = overBudget ? 'token-budget' : result.failure.reason;
  await input.record(work, { event: 'failed', revision, reason, detail: clip(`${result.failure.detail}; build proceeds without a brief`, 1000) });
}
/** Every run this process has in flight, settled: a test's way to wait for the step's effects. */
export async function researchSettled() { await Promise.all([...live.values()].map(entry => entry.settled)); }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// ---- What master status counts (GY-434) ----------------------------------------------------------

/** One research run as `master status` counts it: the item, and the model, start or failure it ran under. */
export interface ResearchRunLine { key: string; model?: string; since?: string; reason?: string }
/**
 * The research step across the fleet, as `master status` reports it: `live` are the runs recorded
 * as running within their time limit (plus the grace to record their end), `waiting` the released
 * items whose run has still to start — and, past its bound, the recorded-but-unfinished run the
 * loop is about to fail — and `failed` the runs that ended without a brief, so their items built
 * from the criteria alone.
 */
export function researchStatus(work: readonly Work[], now: number): { live: ResearchRunLine[]; waiting: ResearchRunLine[]; failed: ResearchRunLine[] } {
  const live: ResearchRunLine[] = [], waiting: ResearchRunLine[] = [], failed: ResearchRunLine[] = [];
  for (const item of work) {
    if (item.stage === 'done' || isClosed(item) || !researchWanted(item)) continue;
    const record = currentResearch(item);
    if (record?.state === 'running') {
      if (researchHold(item, now)) live.push({ key: item.key, model: record.model, since: record.startedAt });
      else waiting.push({ key: item.key });
      continue;
    }
    if (record?.state === 'failed') { failed.push({ key: item.key, reason: record.failure?.reason ?? 'failed' }); continue; }
    if (record?.state === 'recorded') continue;
    if (item.ready && !item.blocker && !item.submission && !item.candidate) waiting.push({ key: item.key });
  }
  return { live, waiting, failed };
}

// ---- The control plane's routes ------------------------------------------------------------------

type Db = pg.PoolClient;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function receipt(db: Db, actor: Principal, key: string, fingerprint: string) {
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const row = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
  if (row) demand(row.fingerprint === fingerprint, 'Idempotency key reused with different input');
  return row?.result as Work | undefined;
}
async function transact(services: Services, actor: Principal, id: string, key: string, fingerprint: string, change: (work: Work, now: Date) => { kind: string; details: unknown }) {
  return services.engine.store.transaction(async (db, now) => {
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay;
    const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
    const work = all.find(item => item.id === id || item.key === id);
    demand(work, 'Work item not found', 404);
    demand(operatorScopeIncludes(actor, work!), 'Work item is outside this operator-agent scope', 403);
    demand(work!.stage !== 'done', 'Delivered work is immutable');
    const { kind, details } = change(work!, now);
    services.engine.evaluate(work!, all, now);
    await (services.engine as unknown as { recordDispatch(db: Db, work: Work, now: Date): Promise<void> }).recordDispatch(db, work!, now);
    await save(db, work!, actor.id, kind, now, details);
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
    return work!;
  });
}

/** `POST /api/work/ID/research`: the loop records a run starting, its brief, or its failure, as the coordinator. */
export async function recordResearch(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  const event = researchEventSchema.parse(body);
  demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
  return transact(services, actor, id, key, digest({ id, research: event }), (work, now) => {
    const record = applyResearchEvent(work, event, actor.id, now);
    return { kind: `research.${event.event}`, details: event.event === 'recorded' ? { revision: record.revision, questions: record.questions.map(question => ({ id: question.id, question: question.question, recommendation: question.recommendation, deadline: question.deadline })) } : { revision: record.revision, state: record.state, failure: record.failure } };
  });
}

/**
 * `POST /api/work/ID/research-answer`: the operator answers a product question. Only a declared
 * human session answers, as for every goals-and-priorities request (the park rule's own refusal).
 * The answer never parks or releases anything: the brief carries it, and the loop requests rework
 * when it differs from what an attempt already built on.
 */
export async function answerResearch(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  const data = researchAnswerSchema.parse(body);
  const refusal = humanOnlyRefusal(parkRule.kind, actor);
  demand(!refusal, refusal!, 403);
  return transact(services, actor, id, key, digest({ id, researchAnswer: data }), (work, now) => {
    const answered = applyResearchAnswer(work, data, actor.id, now);
    return { kind: 'research.answered', details: { question: answered, rework: !!researchRework(work) } };
  });
}
