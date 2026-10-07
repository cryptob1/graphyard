// Concern: the acceptance role (GY-1417) — each open goal is drafted headless into customer outcomes and
// required cases on one pull request, judged headless by the approver identity, auto-merged at its
// approved head, and recorded merged (or closed unmerged and drafted again).
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { caseDirectory, contractFile, parseContract } from '../e2e/case.js';
import { acceptanceDraftSchema, draftFiles, maxDraftRounds, type AcceptanceDraft, type Goal } from '../model/goal.js';
import { agentToken } from '../master/autonomy.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { selectFleetSession } from '../fleet.js';
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
/** A step that only talks to GitHub or the control plane (open, post, close, enqueue) is retried after this long, reusing the draft. */
export const acceptanceStepRetryMs = 10 * 60_000;
/** An acceptance pull request's state is read at most this often per goal. */
export const acceptancePollMs = 5 * 60_000;
export const acceptancePayloadSchema = z.object({ goal: z.string().min(1).max(40), outcomes: z.unknown() }).strict()
  .transform(({ goal, outcomes }) => ({ goal, ...acceptanceDraftSchema.parse({ outcomes }) }));
export const judgementPayloadSchema = z.object({ goal: z.string().min(1).max(40), verdict: z.enum(['approve', 'refuse']), reason: z.string().trim().min(1).max(2000) }).strict();
export type Judgement = z.infer<typeof judgementPayloadSchema>;

export interface AcceptanceRun { runner: Runner; runtime: string; model: string; release?: (reason: string) => Promise<unknown> }
export interface PullRequestState { state: 'open' | 'closed' | 'merged'; mergeSha: string | null; head: string | null }
export interface AcceptanceEffects {
  settings: Pick<DiagnosticianSettings, 'enabled' | 'model' | 'fallbackModel' | 'timeoutMinutes'>;
  cwd: string;
  goals: () => Promise<Goal[]>;
  /** The draft runs on the acceptance role's accounts; the judgement on the approver role's. */
  runner: (role: 'draft' | 'judge', attempt: 'primary' | 'fallback', goal: Goal) => Promise<AcceptanceRun>;
  /** Push the draft to the goal's branch for this revision and open its pull request, or reuse the one already open there. */
  open: (goal: Goal, draft: AcceptanceDraft) => Promise<{ pr: number; branch: string; head: string }>;
  /** Post the draft as the master's operator-agent identity: its author. */
  draft: (goal: Goal, input: AcceptanceDraft & { pr: number; branch: string; head: string }) => Promise<Goal>;
  /** Post the verdict as the approver identity, which never authored a draft. */
  judge: (goal: Goal, judgement: Judgement) => Promise<Goal>;
  pullRequest: (pr: number) => Promise<PullRequestState>;
  /** Auto-merge the approved pull request at exactly its approved head, once its required checks pass. */
  enqueue: (pr: number, head: string) => Promise<void>;
  /** Close a refused or abandoned acceptance pull request with a comment and delete its branch; nothing when it is no longer open. */
  close: (pr: number, comment: string) => Promise<void>;
  merged: (goal: Goal, pr: number, mergeSha: string | null) => Promise<Goal>;
  closed: (goal: Goal, pr: number, reason: string) => Promise<Goal>;
}

/** A finished run, kept until it is posted: the draft (and the pull request it was opened as) or the verdict. */
interface Pending { revision: number; draft?: AcceptanceDraft | null; opened?: { pr: number; branch: string; head: string }; judgement?: Judgement | null; runs: string[] }
const live = new Map<string, Promise<void>>();
const pending = new Map<string, Pending>();
/** When each goal's next try of a step may run: `${goal.id}:${step}`. */
const retryAt = new Map<string, number>();
const polledAt = new Map<string, number>();
/** Pull requests closed, and heads auto-merge was enabled at, by this loop. */
const closedPulls = new Set<number>();
const enqueued = new Set<string>();
export async function draftsSettled() { await Promise.all([...live.values()]); }
export function clearDrafts() { for (const store of [live, pending, retryAt, polledAt]) store.clear(); closedPulls.clear(); enqueued.clear(); }

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

/** One headless run, primary then fallback, as the diagnostician runs (GY-439). */
async function runHeadless<T>(acceptance: AcceptanceEffects, role: 'draft' | 'judge', goal: Goal, prompt: string, validate: (payload: unknown) => T): Promise<{ payload: T | null; runs: string[] }> {
  const runs: string[] = [];
  const [env, tool] = role === 'draft' ? [acceptanceRole, acceptanceTool] : [acceptanceJudgeRole, acceptanceJudgementTool];
  for (const attempt of ['primary', 'fallback'] as const) {
    let chosen: AcceptanceRun;
    try { chosen = await acceptance.runner(role, attempt, goal); } catch (error) { runs.push(`no ${attempt} runner: ${message(error)}`); continue; }
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
    })).then(result => ({ revision: goal.revision, draft: result.payload, runs: result.runs }))
    : runHeadless(acceptance, role, goal, judgementPrompt(cycle.config, goal), payload => { const parsed = judgementPayloadSchema.parse(payload); ofGoal(goal)(parsed); return parsed; })
      .then(result => ({ revision: goal.revision, judgement: result.payload, runs: result.runs }));
  live.set(goal.id, run.catch(error => ({ revision: goal.revision, [role === 'draft' ? 'draft' : 'judgement']: null, runs: [message(error)] }))
    .then(result => { pending.set(goal.id, result); }).finally(() => live.delete(goal.id)));
}
const due = (cycle: Cycle, goal: Goal, step: string) => cycle.clock >= (retryAt.get(`${goal.id}:${step}`) ?? -Infinity);
const later = (cycle: Cycle, goal: Goal, step: string, ms: number) => { retryAt.set(`${goal.id}:${step}`, cycle.clock + ms); };

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
      if (goal.stage === 'planned') return planned(cycle, acceptance, goal, note);
    });
  }
}

async function drafting(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, note: Note) {
  // A refused or closed draft's pull request is closed (and its branch deleted) before the next draft, so none accumulates.
  const refused = goal.refusal;
  if (refused && !closedPulls.has(refused.pr) && due(cycle, goal, 'close')) {
    try {
      await acceptance.close(refused.pr, `Closed by the Graphyard loop: ${goal.key}'s acceptance draft was not taken (${clip(refused.reason, 500)}, by ${refused.by}). The next draft opens on a new pull request.`);
      closedPulls.add(refused.pr);
      await note(goal, 'done', `Closed ${goal.key}'s refused acceptance pull request #${refused.pr} and deleted its branch`);
    } catch (error) { later(cycle, goal, 'close', acceptanceStepRetryMs); await note(goal, 'failed', `Could not close ${goal.key}'s refused acceptance pull request #${refused.pr}: ${message(error)}; it is tried again in ten minutes`); }
  }
  if ((goal.drafts ?? 0) >= maxDraftRounds)
    return note(goal, 'done', `${goal.key} has had ${goal.drafts} acceptance drafts refused or closed (last: ${clip(refused?.reason ?? 'none recorded', 300)}); the loop drafts no more and leaves it to the master`);
  const result = pending.get(goal.id);
  if (result && 'draft' in result) {
    if (!result.draft) {
      pending.delete(goal.id); later(cycle, goal, 'draft', acceptanceRetryMs);
      return note(goal, 'failed', `The acceptance role returned no draft for ${goal.key}: ${result.runs.join('; ')}; it is drafted again in an hour`);
    }
    if (!due(cycle, goal, 'post')) return;
    try { result.opened ??= await acceptance.open(goal, result.draft); }
    catch (error) { later(cycle, goal, 'post', acceptanceStepRetryMs); return note(goal, 'failed', `The acceptance draft for ${goal.key} could not be opened as a pull request: ${message(error)}; the same draft is opened again in ten minutes, reusing its branch and pull request`); }
    try { await acceptance.draft(goal, { ...result.draft, ...result.opened }); }
    catch (error) { later(cycle, goal, 'post', acceptanceStepRetryMs); return note(goal, 'failed', `Opened #${result.opened.pr} for ${goal.key}, but its draft could not be recorded: ${message(error)}; it is posted again in ten minutes`); }
    pending.delete(goal.id);
    return note(goal, 'done', `Opened acceptance pull request #${result.opened.pr} for ${goal.key}: ${result.draft.outcomes.map(entry => `${entry.id} (case ${entry.case.id})`).join(', ')}; it awaits an approver other than its author`);
  }
  if (live.has(goal.id) || !due(cycle, goal, 'draft')) return;
  launch(cycle, acceptance, goal, 'draft');
  await note(goal, 'done', `Launched the acceptance role for ${goal.key} (draft ${(goal.drafts ?? 0) + 1} of at most ${maxDraftRounds}) on ${acceptance.settings.model}, falling back to ${acceptance.settings.fallbackModel}`);
}

/** The draft's pull request read at most once per poll interval; a pull request closed unmerged sends the goal back to drafting. */
async function polled(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, note: Note) {
  if (cycle.clock - (polledAt.get(goal.id) ?? -Infinity) < acceptancePollMs) return null;
  polledAt.set(goal.id, cycle.clock);
  const pr = await acceptance.pullRequest(goal.acceptance!.pr);
  if (pr.state !== 'closed') return pr;
  const reason = `acceptance pull request #${goal.acceptance!.pr} was closed without merging`;
  await acceptance.closed(goal, goal.acceptance!.pr, reason);
  await note(goal, 'done', `${goal.key}'s ${reason}, so it goes back to drafting with that reason recorded`);
  return null;
}

async function awaiting(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, note: Note) {
  const result = pending.get(goal.id);
  if (result && 'judgement' in result) {
    if (!result.judgement) {
      pending.delete(goal.id); later(cycle, goal, 'judge', acceptanceRetryMs);
      return note(goal, 'failed', `The approver returned no judgement on ${goal.key}'s draft #${goal.acceptance!.pr}: ${result.runs.join('; ')}; it is judged again in an hour`);
    }
    if (!due(cycle, goal, 'verdict')) return;
    try { await acceptance.judge(goal, result.judgement); }
    catch (error) { later(cycle, goal, 'verdict', acceptanceStepRetryMs); return note(goal, 'failed', `The approver's ${result.judgement.verdict} of ${goal.key} could not be recorded: ${message(error)}; it is posted again in ten minutes`); }
    pending.delete(goal.id);
    return note(goal, 'done', `The approver ${result.judgement.verdict === 'approve' ? 'approved' : 'refused'} ${goal.key}'s acceptance draft #${goal.acceptance!.pr}: ${clip(result.judgement.reason, 600)}`);
  }
  if (live.has(goal.id)) return;
  if (!await polled(cycle, acceptance, goal, note) || !due(cycle, goal, 'judge')) return;
  launch(cycle, acceptance, goal, 'judge');
  await note(goal, 'done', `Launched the approver's judgement of ${goal.key}'s acceptance draft #${goal.acceptance!.pr}, drafted by ${goal.acceptance!.author}`);
}

async function planned(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, note: Note) {
  const { pr } = goal.acceptance!, head = goal.approval?.head ?? goal.acceptance!.head;
  if (!enqueued.has(`${pr}@${head}`) && due(cycle, goal, 'enqueue')) {
    try { await acceptance.enqueue(pr, head); enqueued.add(`${pr}@${head}`); await note(goal, 'done', `Enabled auto-merge of ${goal.key}'s approved acceptance pull request #${pr} at its approved head ${head.slice(0, 12)}`); }
    catch (error) { later(cycle, goal, 'enqueue', acceptanceStepRetryMs); return note(goal, 'failed', `Could not enable auto-merge of ${goal.key}'s acceptance pull request #${pr}: ${message(error)}; it is tried again in ten minutes`); }
  }
  const read = await polled(cycle, acceptance, goal, note);
  if (read?.state !== 'merged') return;
  await acceptance.merged(goal, pr, read.mergeSha);
  await note(goal, 'done', `${goal.key}'s acceptance pull request #${pr} merged; its cases ${goal.acceptance!.outcomes.map(outcome => outcome.case.id).join(', ')} are protected`);
}

export async function openAcceptancePullRequest(run: ChildRun, root: string, scratch: string, config: { repository: string; baseBranch: string }, goal: Goal, draft: AcceptanceDraft) {
  await run('git', ['-C', root, 'fetch', '--no-tags', 'origin', config.baseBranch]);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'graphyard-acceptance-'));
  try {
    await run('git', ['-C', root, 'worktree', 'add', '--detach', directory, `origin/${config.baseBranch}`]);
    const contract = await readFile(join(directory, contractFile), 'utf8').then(source => parseContract(source), () => null);
    const files = draftFiles(draft, contract);
    for (const file of files) {
      if (file.path !== contractFile && await stat(join(directory, file.path)).then(() => true, () => false)) throw new Error(`${file.path} already exists on ${config.baseBranch}; the draft must name a new case`);
      await writeFile(join(directory, file.path), file.content);
    }
    // One branch per draft revision, owned by the loop: a retry force-pushes it and reuses its open pull request.
    const branch = `graphyard/${goal.key.toLowerCase()}-acceptance-${goal.revision}`;
    await run('git', ['-C', directory, 'checkout', '-B', branch]);
    await run('git', ['-C', directory, 'add', '--', ...files.map(file => file.path)]);
    await run('git', ['-C', directory, 'commit', '-m', `${goal.key}: customer outcomes and required E2E cases\n\n${goal.statement}`]);
    const head = String(await run('git', ['-C', directory, 'rev-parse', 'HEAD'])).trim();
    await run('git', ['-C', directory, 'push', '--force', 'origin', `HEAD:refs/heads/${branch}`]);
    const open = JSON.parse(String(await run('gh', ['pr', 'list', '--repo', config.repository, '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1']))) as { number: number }[];
    if (open[0]) return { pr: open[0].number, branch, head };
    const body = [`Acceptance for ${goal.key}: ${goal.statement}`, '', ...draft.outcomes.map(outcome => `- **${outcome.title}** (${outcome.id}), proved by required uat case \`${outcome.case.id}\`: ${outcome.criteria.join('; ')}`), '',
      'Drafted by the acceptance role and judged by the approver identity, never its author; once approved it auto-merges at the approved head, and its cases and bindings are protected from then on.'].join('\n');
    const url = String(await run('gh', ['pr', 'create', '--repo', config.repository, '--base', config.baseBranch, '--head', branch, '--title', `${goal.key}: acceptance — ${clip(goal.statement, 80)}`, '--body', body])).trim();
    const pr = Number(url.match(/\/pull\/(\d+)/)?.[1]);
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error(`gh pr create answered ${clip(url, 200)}, which names no pull request`);
    return { pr, branch, head };
  } finally {
    await Promise.resolve(run('git', ['-C', root, 'worktree', 'remove', '--force', directory])).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

interface Calls {
  run: ChildRun; fetcher: typeof fetch;
  asCoordinator: (path: string) => Promise<any>;
  asOperatorAgent: (method: 'GET' | 'POST', path: string, body?: unknown, key?: string) => Promise<any>;
}
/**
 * The acceptance role's effects under the live configuration: runners as the diagnostician's (the
 * registry's acceptance or approver role when an operator defines one, else Pi on
 * `run.diagnostician`), drafts posted as the master's operator-agent identity and verdicts as the
 * approver identity, so the author of a draft never judges it, and GitHub through `gh`.
 */
export function acceptanceEffects(config: MasterConfig, root: string, calls: Calls): AcceptanceEffects {
  const { run } = calls, settings = diagnosticianSettings(config.run);
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
        const fleet = await selectFleetSession(config, name, { name, principal }, { work: goal.key });
        if (fleet) { const launched = registryHeadlessLaunch(fleet.account); return { runner: registryRunner(fleet.account), runtime: launched.command, model: launched.model, release: fleet.release }; }
      }
      const model = attempt === 'primary' ? settings.model : settings.fallbackModel;
      return { runner: piRunner({ command: settings.command, model }), runtime: 'pi', model };
    },
    open: (goal, draft) => openAcceptancePullRequest(run, root, worktreeRoot(root, config), config, goal, draft),
    draft: (goal, input) => calls.asOperatorAgent('POST', `goals/${goal.key}/draft`, input, `acceptance:${goal.id}:${goal.revision}`),
    judge: (goal, judgement) => asApprover(`goals/${goal.key}/${judgement.verdict}`, { reason: judgement.reason }, `acceptance:${goal.id}:${goal.revision}:judged`),
    pullRequest: read,
    enqueue: async (pr, head) => { await gh(['pr', 'merge', String(pr), '--auto', `--${config.mergeMethod ?? 'merge'}`, '--match-head-commit', head]); },
    close: async (pr, comment) => { if ((await read(pr)).state === 'open') await gh(['pr', 'close', String(pr), '--comment', comment, '--delete-branch']); },
    merged: (goal, pr, mergeSha) => calls.asOperatorAgent('POST', `goals/${goal.key}/merged`, { pr, mergeSha }, `acceptance:${goal.id}:merged`),
    closed: (goal, pr, reason) => calls.asOperatorAgent('POST', `goals/${goal.key}/closed`, { pr, reason }, `acceptance:${goal.id}:${goal.revision}:closed`),
  };
}
