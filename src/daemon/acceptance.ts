// Concern: the acceptance role (GY-1417) — each open goal gets one headless drafting run that turns it
// into customer outcomes, one required uat E2E case per outcome and the release-contract bindings,
// opened as one pull request linked to the goal; an independent approver judges the draft, and the
// loop records the pull request merged, from which point the cases are protected.
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { caseDirectory, contractFile, parseContract } from '../e2e/case.js';
import { acceptanceDraftSchema, draftFiles, type AcceptanceDraft, type Goal } from '../model/goal.js';
import type { DiagnosticianSettings } from '../runner/payloads.js';
import type { Runner } from '../runner/types.js';
import type { ChildRun } from '../child-runner.js';
import { type DaemonAction, message } from './state.js';
import { record } from './effects.js';
import type { Cycle } from './cycle.js';

// ---------------------------------------------------------------------------
// Built like the diagnostician (src/daemon/diagnosis.ts): within the cycle, every goal in acceptance
// drafting gets one headless run — the registry's acceptance role when an operator defines one, else
// Pi on `run.diagnostician.model`, falling back once to its `fallbackModel` — given the goal, any
// refusal of its last draft, and the outcomes and cases the repository already holds. It returns
// its draft through `graphyard_acceptance`. The loop writes the cases under e2e/cases/ and appends
// the bindings to e2e/contract.json on a branch from the base, opens one pull request, and posts the
// draft as the master's operator-agent identity — the draft's author, who can never approve it. An
// approver on another identity approves it (`graphyard goal approve`), the pull request merges, and
// the loop records it merged: the goal's cases and bindings are protected from then on.
// ---------------------------------------------------------------------------

export const acceptanceRole = 'acceptance';
export const acceptanceTool = 'graphyard_acceptance';
/** How long a drafting run that returned nothing waits before the goal is drafted again. */
export const acceptanceRetryMs = 60 * 60_000;
/** What one run submits: the goal it drafts for and its outcomes, each with its case. */
export const acceptancePayloadSchema = z.object({ goal: z.string().min(1).max(40), outcomes: z.unknown() }).strict()
  .transform(({ goal, outcomes }) => ({ goal, ...acceptanceDraftSchema.parse({ outcomes }) }));

export interface AcceptanceRun { runner: Runner; runtime: string; model: string; release?: (reason: string) => Promise<unknown> }
export interface AcceptanceEffects {
  settings: Pick<DiagnosticianSettings, 'enabled' | 'model' | 'fallbackModel' | 'timeoutMinutes'>;
  /** The repository checkout the role reads: the loop's own. */
  cwd: string;
  /** The open goals. */
  goals: () => Promise<Goal[]>;
  runner: (attempt: 'primary' | 'fallback', goal: Goal) => Promise<AcceptanceRun>;
  /** Writes the draft's files on a branch from the base and opens its pull request. */
  open: (goal: Goal, draft: AcceptanceDraft) => Promise<{ pr: number; branch: string }>;
  /** Posts the draft as the master's operator-agent identity. */
  draft: (goal: Goal, input: AcceptanceDraft & { pr: number; branch: string }) => Promise<Goal>;
  pullRequest: (pr: number) => Promise<{ state: 'open' | 'closed' | 'merged'; mergeSha: string | null }>;
  merged: (goal: Goal, pr: number, mergeSha: string | null) => Promise<Goal>;
}

interface Outcome { draft: AcceptanceDraft | null; runs: string[] }
const live = new Map<string, Promise<void>>();
const outcomes = new Map<string, Outcome>();
const failedAt = new Map<string, number>();
/** Every drafting run this process has in flight, settled: a test's way to wait for them. */
export async function draftsSettled() { await Promise.all([...live.values()]); }
/** Test seam: forget every run, outcome and retry hold. */
export function clearDrafts() { live.clear(); outcomes.clear(); failedAt.clear(); }

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** What the repository already declares, so a draft names new outcomes and cases. */
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

/** The primary run, then the fallback once when the primary returns no valid draft. */
async function runDraft(acceptance: AcceptanceEffects, goal: Goal, prompt: string): Promise<Outcome> {
  const runs: string[] = [];
  for (const attempt of ['primary', 'fallback'] as const) {
    let chosen: AcceptanceRun;
    try { chosen = await acceptance.runner(attempt, goal); } catch (error) { runs.push(`no ${attempt} runner: ${message(error)}`); continue; }
    const run = chosen.runner.start(prompt, { cwd: acceptance.cwd, env: { GRAPHYARD_PI_ROLE: acceptanceRole }, tool: acceptanceTool, timeoutMs: acceptance.settings.timeoutMinutes * 60_000,
      validate: payload => {
        const parsed = acceptancePayloadSchema.parse(payload);
        if (parsed.goal !== goal.key) throw new Error(`the draft names ${parsed.goal}, not ${goal.key}`);
        return { outcomes: parsed.outcomes };
      } });
    const result = await run.result();
    await Promise.resolve(chosen.release?.(`the ${attempt} acceptance draft of ${goal.key} ended`)).catch(() => {});
    if (result.ok) return { draft: result.payload, runs };
    runs.push(`${chosen.model} ${result.failure.reason}: ${clip(result.failure.detail, 300)}`);
    if (result.failure.reason === 'cancelled') break;
  }
  return { draft: null, runs };
}

/**
 * Within the cycle: launch a drafting run for each goal in acceptance drafting, turn each finished
 * draft into its pull request and posted draft, and record each approved draft's pull request merged.
 */
export async function acceptanceStep(cycle: Cycle) {
  const { state, effects, now, performed } = cycle;
  const acceptance = effects.acceptance;
  if (!acceptance?.settings.enabled) return;
  const note = async (goal: Goal, outcome: DaemonAction['state'], detail: string) => {
    const key = `acceptance:${goal.id}`;
    performed.push(await record(state, key, { kind: 'decision', work: goal.key, principal: null, state: outcome, detail: clip(detail, 1000), attempts: (state.actions[key]?.attempts ?? 0) + (outcome === 'failed' ? 1 : 0), cycle: state.cycle }, now(), effects.persist));
  };
  for (const goal of await acceptance.goals()) {
    await cycle.isolate('decision', null, `the acceptance of ${goal.key}`, async () => {
      if (goal.stage === 'acceptance-drafting') return drafting(cycle, acceptance, goal, note);
      if (goal.stage !== 'planned' || !goal.acceptance) return;
      const pr = await acceptance.pullRequest(goal.acceptance.pr);
      if (pr.state !== 'merged') return;
      await acceptance.merged(goal, goal.acceptance.pr, pr.mergeSha);
      await note(goal, 'done', `${goal.key}'s acceptance pull request #${goal.acceptance.pr} merged; its cases ${goal.acceptance.outcomes.map(outcome => outcome.case.id).join(', ')} are protected`);
    });
  }
}

async function drafting(cycle: Cycle, acceptance: AcceptanceEffects, goal: Goal, note: (goal: Goal, outcome: DaemonAction['state'], detail: string) => Promise<void>) {
  const outcome = outcomes.get(goal.id);
  if (outcome) {
    outcomes.delete(goal.id);
    if (!outcome.draft) { failedAt.set(goal.id, cycle.clock); return note(goal, 'failed', `The acceptance role returned no draft for ${goal.key}: ${outcome.runs.join('; ')}; it is drafted again in an hour`); }
    let opened: { pr: number; branch: string };
    try { opened = await acceptance.open(goal, outcome.draft); }
    catch (error) { failedAt.set(goal.id, cycle.clock); return note(goal, 'failed', `The acceptance draft for ${goal.key} could not be opened as a pull request: ${message(error)}`); }
    await acceptance.draft(goal, { ...outcome.draft, ...opened });
    return note(goal, 'done', `Opened acceptance pull request #${opened.pr} for ${goal.key}: ${outcome.draft.outcomes.map(entry => `${entry.id} (case ${entry.case.id})`).join(', ')}; it awaits an approver other than its author`);
  }
  if (live.has(goal.id) || cycle.clock - (failedAt.get(goal.id) ?? -Infinity) < acceptanceRetryMs) return;
  const prompt = acceptancePrompt(cycle.config, goal, await declared(acceptance.cwd));
  const running = runDraft(acceptance, goal, prompt).catch(error => ({ draft: null, runs: [message(error)] }))
    .then(result => { outcomes.set(goal.id, result); }).finally(() => live.delete(goal.id));
  live.set(goal.id, running);
  await note(goal, 'done', `Launched the acceptance role for ${goal.key} on ${acceptance.settings.model}, falling back to ${acceptance.settings.fallbackModel}`);
}

/**
 * The production `open`: a detached worktree of the base in a scratch directory, the draft's files
 * written there (refused when a case file already exists), one commit on a fresh branch, pushed, and
 * the pull request opened with `gh`. The scratch worktree is removed whatever happens.
 */
export async function openAcceptancePullRequest(run: ChildRun, root: string, config: { repository: string; baseBranch: string }, goal: Goal, draft: AcceptanceDraft) {
  await run('git', ['-C', root, 'fetch', '--no-tags', 'origin', config.baseBranch]);
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-acceptance-'));
  try {
    await run('git', ['-C', root, 'worktree', 'add', '--detach', directory, `origin/${config.baseBranch}`]);
    const contract = await readFile(join(directory, contractFile), 'utf8').then(source => parseContract(source), () => null);
    const files = draftFiles(draft, contract);
    for (const file of files) {
      if (file.path !== contractFile && await stat(join(directory, file.path)).then(() => true, () => false)) throw new Error(`${file.path} already exists on ${config.baseBranch}; the draft must name a new case`);
      await writeFile(join(directory, file.path), file.content);
    }
    const branch = `graphyard/${goal.key.toLowerCase()}-acceptance-${goal.revision}`;
    await run('git', ['-C', directory, 'checkout', '-b', branch]);
    await run('git', ['-C', directory, 'add', '--', ...files.map(file => file.path)]);
    await run('git', ['-C', directory, 'commit', '-m', `${goal.key}: customer outcomes and required E2E cases\n\n${goal.statement}`]);
    await run('git', ['-C', directory, 'push', 'origin', `HEAD:refs/heads/${branch}`]);
    const body = [`Acceptance for ${goal.key}: ${goal.statement}`, '', ...draft.outcomes.map(outcome => `- **${outcome.title}** (${outcome.id}), proved by required uat case \`${outcome.case.id}\`: ${outcome.criteria.join('; ')}`), '',
      `Drafted by the acceptance role. An approver other than its author approves it with \`graphyard goal approve ${goal.key}\`; once merged these cases and bindings are protected.`].join('\n');
    const url = String(await run('gh', ['pr', 'create', '--repo', config.repository, '--base', config.baseBranch, '--head', branch, '--title', `${goal.key}: acceptance — ${clip(goal.statement, 80)}`, '--body', body])).trim();
    const pr = Number(url.match(/\/pull\/(\d+)/)?.[1]);
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error(`gh pr create answered ${clip(url, 200)}, which names no pull request`);
    return { pr, branch };
  } finally {
    await Promise.resolve(run('git', ['-C', root, 'worktree', 'remove', '--force', directory])).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
