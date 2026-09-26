import { randomUUID } from 'node:crypto';
import { defaultPiModel, piRunner } from './pi.js';
import type { FleetLaunchAccount } from '../fleet.js';
import { registryToolsArgs } from '../master/environments.js';
import { z } from 'zod';
import { claimRunWatch, liveRun, runsDirectory, superviseRun, writeRunOwner, type Applied, type RunAdopter } from './registry.js';
import { decidePayloadSchema, evidencePayloadSchema, graphyardTools, piRuntimeSchema, type DecidePayload, type EvidencePayload } from './payloads.js';
import { runRecord, type RunOptions, type RunResult, type Runner } from './types.js';

/**
 * The narrow roles on the headless runner (GY-169): the approver and the unit proof producer. A
 * run's submission is applied by the loop through the route a terminal session would have used,
 * with the role's own credential — `approve` as the approver identity, `evidence` as the producer
 * principal — so the server applies exactly what it applies today: it refuses an approver that
 * requested, implemented or produced evidence for the decision, and it trusts evidence by the
 * producer's grants and the exercise rule, never by what the run says.
 */

export function narrowRunner(pi: unknown): Runner {
  const configured = piRuntimeSchema.parse(pi ?? {});
  return piRunner({ command: configured.command, model: configured.model });
}

/**
 * A narrow role's headless run on the account the agent registry chose for it (GY-170): the
 * runtime's executable, the account's login home on the runtime's home variable, the model the
 * choice names, and the role policy's flags and tool allowlist — all from the registry revision the
 * choice was made in, never from `run.pi`, which configures only a role the registry does not define.
 * A policy that limits tools on a runtime with no tools flag is refused, as the Herdr path refuses it.
 */
export function registryHeadlessLaunch(account: FleetLaunchAccount) {
  const { contract, policy, modelId } = account.fleet;
  const args = [...contract.args, ...(policy?.args ?? []), ...registryToolsArgs(account)];
  const environment: Record<string, string> = { ...contract.environment, ...(contract.homeVariable && account.home ? { [contract.homeVariable]: account.home } : {}) };
  return { command: contract.kind, model: modelId ?? defaultPiModel, args, environment };
}
export function registryRunner(account: FleetLaunchAccount): Runner {
  const launch = registryHeadlessLaunch(account);
  return piRunner({ command: launch.command, model: launch.model, args: launch.args, environment: launch.environment });
}

export type { Applied } from './registry.js';
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Start a run for one role session, registered under its session name so the loop's supervision
 * sees it, and apply its submission when it ends. `settled` resolves to the record the session
 * keeps: the run's last events, its result, and what became of each submission.
 *
 * With the loop's `root` (GY-453) the run is recorded in the run registry on disk with its owner
 * and the `context` its role needs to apply the result, so a restart that leaves the run going
 * (it is detached) is followed by an adoption that applies it — once, whichever process sees it end.
 */
export function startNarrowRun<T>(input: { runner: Runner; name: string; role: 'approver' | 'producer'; work: string; subject: string; prompt: string; options: RunOptions<T>;
  apply: (result: RunResult<T>) => Promise<Applied[]>; root?: string; context?: Record<string, unknown> }) {
  const live = liveRun(input.name);
  if (live) throw new Error(`A ${live.role} run named ${input.name} is already running for ${live.work}`);
  const startedAt = new Date().toISOString();
  const run = input.runner.start(input.prompt, input.root ? { ...input.options, runs: runsDirectory(input.root) } : input.options);
  if (run.directory) {
    // Watched here from its start, so no adopter elsewhere takes it once its owner is on disk.
    try { claimRunWatch(run.directory); writeRunOwner(run.directory, { name: input.name, role: input.role, work: input.work, subject: input.subject, context: input.context ?? {}, startedAt }); }
    catch { /* the run is still watched here; only its adoption after a restart is lost */ }
  }
  const settled = superviseRun({ runner: input.runner, run, name: input.name, role: input.role, work: input.work, subject: input.subject, startedAt, apply: input.apply });
  return { run, settled, record: runRecord(input.runner.name, run, null, startedAt, null) };
}

async function post(url: string, token: string, path: string, body: unknown, fetcher: typeof fetch) {
  const response = await fetcher(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const result = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`);
  return result;
}

/** The approver's verdict, applied as the approver identity on the route `master approve`/`master refuse` use. */
export async function applyDecision(url: string, token: string, work: { id: string }, payload: DecidePayload, fetcher: typeof fetch = fetch): Promise<Applied> {
  const subject = `decision ${payload.decision}`;
  try {
    await post(url, token, `work/${encodeURIComponent(work.id)}/approve`, payload.approve ? { decision: payload.decision, reason: payload.reason } : { action: 'refuse', decision: payload.decision, reason: payload.reason }, fetcher);
    return { subject, outcome: 'applied', detail: `${payload.approve ? 'approved' : 'refused'}: ${payload.reason}` };
  } catch (error) { return { subject, outcome: 'refused', detail: failure(error) }; }
}

/** One proof's result, submitted as the producer principal on the route `graphyard evidence` uses. */
export async function submitEvidence(url: string, token: string, work: { id: string }, payload: EvidencePayload, environment: string, fetcher: typeof fetch = fetch): Promise<Applied> {
  const subject = `proof ${payload.proof}`;
  try {
    await post(url, token, `work/${encodeURIComponent(work.id)}/evidence`, { ...payload, environment: payload.environment ?? environment.slice(0, 100) }, fetcher);
    return { subject, outcome: 'applied', detail: `${payload.result} (${payload.executed} executed, ${payload.skipped} skipped; exercise ${payload.exercise.result})` };
  } catch (error) { return { subject, outcome: 'refused', detail: failure(error) }; }
}

/** The approver's run options: its submission must answer the decision it was launched for. */
export const approverRunOptions = (cwd: string, decision: string, env: Record<string, string>, timeoutMs: number): RunOptions<DecidePayload> => ({
  cwd, env: { ...env, GRAPHYARD_PI_ROLE: 'approver' }, tool: graphyardTools.decide, timeoutMs,
  validate: payload => {
    const parsed = decidePayloadSchema.parse(payload);
    if (parsed.decision !== decision) throw new Error(`the verdict names decision ${parsed.decision}, not ${decision}`);
    return parsed;
  },
});

/** What an approver run's adoption after a restart needs (GY-453): never the token, which the adopter reads itself. */
export const approverRunContext = (url: string, workId: string, decision: string, timeoutMs: number) => ({ url, workId, decision, timeoutMs });
const approverRunContextSchema = z.object({ url: z.string(), workId: z.string(), decision: z.string(), timeoutMs: z.number().int().positive() }).passthrough();
/**
 * How a restarted loop takes back a headless approver run (GY-453, registry.ts adoptRuns): its
 * verdict is validated against the decision it was launched for and applied as the approver
 * identity, exactly as the launch would have applied it.
 */
export function approverRunAdopter(token: () => Promise<string>, fetcher?: typeof fetch): RunAdopter {
  return async owner => {
    const context = approverRunContextSchema.parse(owner.context);
    return { options: approverRunOptions('', context.decision, {}, context.timeoutMs),
      apply: async result => result.ok ? [await applyDecision(context.url, await token(), { id: context.workId }, result.payload as DecidePayload, fetcher)] : [] };
  };
}

/** The producer's run options: each submission must be one of its proofs on its exact binding. */
export const producerRunOptions = (cwd: string, binding: { sha: string; baseSha: string; policyRevision: number; proofs: string[] }, env: Record<string, string>, timeoutMs: number): RunOptions<EvidencePayload> => ({
  cwd, env: { ...env, GRAPHYARD_PI_ROLE: 'producer' }, tool: graphyardTools.evidence, timeoutMs,
  validate: payload => {
    const parsed = evidencePayloadSchema.parse(payload);
    if (!binding.proofs.includes(parsed.proof)) throw new Error(`${parsed.proof} is not a proof of this request (${binding.proofs.join(', ')})`);
    if (parsed.sha.toLowerCase() !== binding.sha.toLowerCase() || parsed.baseSha.toLowerCase() !== binding.baseSha.toLowerCase() || parsed.policyRevision !== binding.policyRevision)
      throw new Error(`${parsed.proof} was submitted for ${parsed.sha.slice(0, 12)} on ${parsed.baseSha.slice(0, 12)} under policy ${parsed.policyRevision}, not the requested binding`);
    return parsed;
  },
});

export function piApproverPrompt(config: { repository: string; cliPath: string }, key: string, decision: string, identity: string) {
  const cli = `node ${config.cliPath}`;
  return `You are the independent Graphyard approver for ${config.repository}, acting as ${identity}. Judge decision ${decision} on ${key}: run ${cli} master decisions ${key}, read the item with ${cli} status ${key}, its pull request and history, and weigh the requester's reason against the item's criteria and the operator's goals. `
    + `Then call the graphyard_decide tool exactly once with decision "${decision}", approve true if the decision is justified or false if it is not, and your reason; a decline is a call with approve false, never an exit without one. Graphyard applies your verdict as ${identity}, so do not run master approve or master refuse yourself. `
    + 'Never approve a decision you requested, implemented, or produced evidence for; never edit, push, merge, review, or submit evidence. Stop after the call.';
}

export function piProducerPrompt(config: { repository: string }, binding: { key: string; pr: number; sha: string; baseSha: string; policyRevision: number; group: string; proofs: string[] },
  criteria: { id: string; text: string; proofs: string[] }[], checkout: { directory: string; worktree: string }, repository: string) {
  const stripped = `${checkout.directory}/exercise`;
  const attached = criteria.filter(criterion => criterion.proofs.some(proof => binding.proofs.includes(proof)));
  return `You are an independent Graphyard proof producer for ${config.repository}. Produce evidence for work item ${binding.key} (pull request #${binding.pr}) at exact head ${binding.sha} against base ${binding.baseSha} under policy revision ${binding.policyRevision}, for the ${binding.group} proof group: ${binding.proofs.join(', ')}. `
    + `The criteria these proofs establish: ${attached.map(criterion => `${criterion.id} (${criterion.proofs.filter(proof => binding.proofs.includes(proof)).join(', ')}): ${criterion.text}`).join(' ')} `
    + `Work in a detached worktree of the exact head at ${checkout.worktree}: git -C ${repository} fetch origin ${binding.sha} && git -C ${repository} worktree add --detach ${checkout.worktree} ${binding.sha}. Install and build there, then run what establishes each proof — start from the tests named for it (grep the proof name under tests/) — with every GRAPHYARD_* and HERDR_* variable unset and a free GRAPHYARD_TEST_PORT. `
    + 'Do not edit, commit, push, rebase or merge the candidate, and never weaken, skip or narrow a test to make a proof pass. '
    + `A proof that passes against an unchanged tree proves nothing, so for each proof also run it in a second detached worktree of the same head at ${stripped} (git -C ${repository} worktree add --detach ${stripped} ${binding.sha}) with the behaviour its criterion describes removed — revert or stub exactly the lines of the change that implement it. `
    + `Then call the graphyard_submit_evidence tool once per proof with proof, sha "${binding.sha}", baseSha "${binding.baseSha}", policyRevision ${binding.policyRevision}, result pass or fail, executed as the cases that actually ran, skipped, and exercise {criterion, behaviour, result, executed} as the stripped run's true outcome; a failing or incomplete run is submitted as result fail, never omitted. Graphyard submits it as your producer principal and its gates decide whether it is trusted. `
    + `Keep everything you write inside ${checkout.directory}. When every proof is submitted, remove both worktrees with git -C ${repository} worktree remove --force ${checkout.worktree} and git -C ${repository} worktree remove --force ${stripped}, and stop.`;
}
