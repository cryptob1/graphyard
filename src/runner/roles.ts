import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defaultPiModel, piRunner } from './pi.js';
import type { FleetLaunchAccount } from '../fleet.js';
import { registryToolsArgs } from '../master/environments.js';
import { endRun, liveRun, registerRun } from './registry.js';
import { decidePayloadSchema, evidencePayloadSchema, graphyardTools, piRuntimeSchema, type DecidePayload, type EvidencePayload } from './payloads.js';
import { runRecord, type Run, type RunOptions, type RunRecord, type RunResult, type Runner } from './types.js';
import { faultClasses } from '../model/fault-classes.js';

/**
 * The pipeline doctor's contract (GY-711, src/daemon/doctor.ts): the structured report its headless
 * run submits through `graphyard_doctor_report`, the `run.doctor` settings, and the run record the
 * loop keeps. The loop re-validates every payload; the Pi extension holds the matching tool schema
 * and the role's command allowlist (integrations/pi).
 */

/** The tool name the doctor's Pi session submits its report through. */
export const doctorTool = 'graphyard_doctor_report';

const line = (max: number) => z.string().trim().min(1).max(max);
export const doctorFindingsSchema = z.object({
  /** The work item key the finding is on, or a status-level subject such as `installation`. */
  subject: line(200),
  /** The check whose fault bound the finding passed: blocked, worker, ci, review-request, launch, proofs, mergeable, decision, containment, refusal, overdue. */
  check: z.enum(['blocked', 'worker', 'ci', 'review-request', 'launch', 'proofs', 'mergeable', 'decision', 'containment', 'refusal', 'overdue']),
  detail: line(2000),
  /** Whether the doctor could not act on it: a human-only decision, or a fault class with no item. */
  unactionable: z.boolean().default(false),
}).strict();
export type DoctorFinding = z.infer<typeof doctorFindingsSchema>;
export const doctorActionSchema = z.object({
  subject: line(200),
  /** The sanctioned command the doctor ran, as it ran it. */
  command: line(500),
  outcome: z.enum(['applied', 'refused']),
  detail: line(1000),
}).strict();
export type DoctorAction = z.infer<typeof doctorActionSchema>;
export const doctorFileSchema = z.object({
  /** The fault class the finding belongs to, deduplicated against the open items naming it. */
  faultClass: z.enum(faultClasses),
  title: line(200), description: line(20000),
  /** A fault the doctor files is urgent: 0 (P0) or 1 (P1). */
  priority: z.number().int().min(0).max(1),
  criteria: z.array(z.object({ id: z.string().trim().regex(/^[A-Z]+-\d+$/), text: line(4000), proofs: z.array(line(200)).min(1).max(10) }).strict()).min(1).max(20),
  plannedFiles: z.array(line(500)).min(1).max(100),
}).strict();
export type DoctorFile = z.infer<typeof doctorFileSchema>;
export const doctorReportPayloadSchema = z.object({
  findings: z.array(doctorFindingsSchema).max(200).default([]),
  actions: z.array(doctorActionSchema).max(200).default([]),
  filed: z.array(doctorFileSchema).max(20).default([]),
}).strict();
export type DoctorReportPayload = z.infer<typeof doctorReportPayloadSchema>;

/**
 * `run.doctor` in .graphyard/master.json (GY-711): the pipeline doctor runs every
 * `intervalMinutes` (10 by default), headless on Pi with `model`, and a run that ends without a
 * valid report runs once more on the stronger `fallbackModel`. The registry's doctor role, when an
 * operator defines one, chooses the primary run's account and model instead. `timeoutMinutes`
 * bounds one run. An installation turns the doctor off with `enabled: false`.
 */
export const doctorSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().trim().min(1).max(500).optional(),
  intervalMinutes: z.number().int().min(5).max(1440).default(10),
  model: z.string().trim().min(1).max(200).default('zai/glm-5.3-flash'),
  fallbackModel: z.string().trim().min(1).max(200).default('zai/glm-5.3'),
  timeoutMinutes: z.number().int().min(1).max(60).default(20),
}).strict();
export type DoctorSettings = z.infer<typeof doctorSettingsSchema> & { command: string };
/** The doctor settings in force: `run.doctor` over its defaults, Pi's command from `run.pi` when it names none. */
export function doctorSettings(run: { doctor?: unknown; pi?: { command?: string } } | undefined): DoctorSettings {
  const parsed = doctorSettingsSchema.parse(run?.doctor ?? {});
  return { ...parsed, command: parsed.command ?? run?.pi?.command ?? 'pi' };
}

/**
 * What the loop keeps of one doctor run (GY-711): when it ran, what it found, did and filed, and
 * how it ended. Kept bounded on the cursor, posted to the control plane for the dashboard, and
 * summarised by `master status`.
 */
export const doctorStates = ['running', 'reported', 'failed'] as const;
export const doctorRunRecordSchema = z.object({
  at: z.string().max(40), state: z.enum(doctorStates),
  runs: z.array(z.object({ runtime: z.string().max(40), model: z.string().max(200), result: z.string().max(40), detail: z.string().max(500) }).strict()).max(4).default([]),
  findings: z.array(doctorFindingsSchema).max(50).default([]),
  actions: z.array(doctorActionSchema).max(50).default([]),
  filed: z.array(z.object({ faultClass: z.enum(faultClasses), title: z.string().max(200), work: z.string().max(50).nullable().default(null), deduplicated: z.boolean().default(false) }).strict()).max(20).default([]),
  detail: z.string().max(1000).default(''),
}).strict();
export type DoctorRunRecord = z.infer<typeof doctorRunRecordSchema>;
export const retainedDoctorRuns = 20;

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

export type Applied = RunRecord['applied'][number];
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Start a run for one role session, registered under its session name so the loop's supervision
 * sees it, and apply its submission when it ends. `settled` resolves to the record the session
 * keeps: the run's last events, its result, and what became of each submission.
 */
export function startNarrowRun<T>(input: { runner: Runner; name: string; role: 'approver' | 'producer'; work: string; subject: string; prompt: string; options: RunOptions<T>; checkout?: string;
  apply: (result: RunResult<T>) => Promise<Applied[]> }) {
  const live = liveRun(input.name);
  if (live) throw new Error(`A ${live.role} run named ${input.name} is already running for ${live.work}`);
  const run = input.runner.start(input.prompt, input.options), startedAt = new Date().toISOString();
  registerRun({ name: input.name, role: input.role, work: input.work, subject: input.subject, run: run as Run<unknown>, ...(input.checkout ? { checkout: input.checkout } : {}) });
  const settled = run.result().then(async result => {
    let applied: Applied[];
    try { applied = await input.apply(result); }
    catch (error) { applied = [{ subject: input.subject, outcome: 'refused', detail: failure(error) }]; }
    const record = runRecord(input.runner.name, run, result, startedAt, new Date().toISOString(), applied);
    endRun(input.name, record);
    return record;
  });
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

export function piApproverPrompt(config: { repository: string; cliPath: string }, key: string, decision: string, identity: string, repository?: string) {
  const cli = `node ${config.cliPath}`;
  return `You are the independent Graphyard approver for ${config.repository}, acting as ${identity}. Judge decision ${decision} on ${key}: run ${cli} master decisions ${key}, read the item with ${cli} status ${key}, its pull request and history, and weigh the requester's reason against the item's criteria and the operator's goals. `
    + (repository ? `Your working directory is a scratch directory of your own; the repository is at ${repository} and is read-only to you: read it with git -C ${repository}, never write, move or remove anything in it. ` : '')
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
