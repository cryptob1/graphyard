import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultPiModel, piRunner, piSmoke, type PiRunnerOptions, type SmokeResult } from './pi.js';
import type { FleetLaunchAccount } from '../fleet.js';
import { registryToolsArgs } from '../master/environments.js';
import { endRun, liveRun, registerRun } from './registry.js';
import { decidePayloadSchema, evidencePayloadSchema, graphyardTools, piRuntimeSchema, type DecidePayload, type EvidencePayload } from './payloads.js';
import { runRecord, type Run, type RunOptions, type RunRecord, type RunResult, type Runner } from './types.js';

/**
 * The narrow roles on the headless runner (GY-169): the approver and the unit proof producer. A
 * run's submission is applied by the loop through the route a terminal session would have used,
 * with the role's own credential — `approve` as the approver identity, `evidence` as the producer
 * principal — so the server applies exactly what it applies today: it refuses an approver that
 * requested, implemented or produced evidence for the decision, and it trusts evidence by the
 * producer's grants and the exercise rule, never by what the run says.
 */

export function narrowRunner(pi: unknown, where: RunSurface = {}): Runner {
  const configured = piRuntimeSchema.parse(pi ?? {});
  return piRunner({ command: configured.command, model: configured.model, ...where });
}

/** Where a headless run writes its log and which surface it runs on (GY-713): `headlessSurface` builds it. */
export type RunSurface = Pick<PiRunnerOptions, 'log' | 'surface'>;

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
/**
 * The provider key an account's registry entry names by reference (GY-446), read from its file in
 * the account's login home at the moment a run starts, as the one variable the runtime reads. The
 * file must be a regular file of mode 0600; its content appears in no error, record or log.
 */
export function accountKeyEnvironment(account: Pick<FleetLaunchAccount, 'name' | 'home' | 'key'>): Record<string, string> {
  if (!account.key) return {};
  if (!account.home) throw new Error(`${account.name} names key file ${account.key.file} but no login home to read it from`);
  const file = resolve(account.home, account.key.file);
  let value: string;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.mode & 0o077) throw new Error(`${file} must be a regular file with mode 0600 (chmod 600 ${file})`);
    value = readFileSync(file, 'utf8').trim();
  } catch (error) { throw new Error(`${account.name}'s key file cannot be read: ${error instanceof Error ? error.message.replace(/^ENOENT: /, '') : 'unreadable'}`); }
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${account.name}'s key file ${file} must hold the key alone, on one line`);
  return { [account.key.variable]: value };
}
/** A registry account's headless runner: every run reads the account's key afresh, into its own environment only. */
export function registryRunner(account: FleetLaunchAccount, where: RunSurface = {}): Runner {
  const launch = registryHeadlessLaunch(account);
  return { name: 'pi', start: (prompt, options) => piRunner({ command: launch.command, model: launch.model, args: launch.args, environment: { ...launch.environment, ...accountKeyEnvironment(account) }, ...where }).start(prompt, options) };
}
/**
 * The one-prompt smoke test of a registry account (GY-446): its runtime, login home, key and model,
 * none of a role's policy. A key file that cannot be read fails the test with that reason.
 */
export async function smokeRegistryAccount(account: FleetLaunchAccount, options: { cwd?: string; timeoutMs?: number; command?: string; commandArgs?: string[] } = {}): Promise<SmokeResult> {
  const launch = registryHeadlessLaunch({ ...account, fleet: { ...account.fleet, policy: undefined } });
  let key: Record<string, string>;
  try { key = accountKeyEnvironment(account); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  return piSmoke({ command: options.command ?? launch.command, commandArgs: options.commandArgs, model: launch.model, args: launch.args, environment: { ...launch.environment, ...key } },
    { cwd: options.cwd ?? account.home ?? undefined, timeoutMs: options.timeoutMs, redact: Object.values(key) });
}
/**
 * How a headless run ended, as the registry counts it (GY-446): with a result, without one, or —
 * for a run the loop itself cancelled — not the account's doing, so not counted.
 */
export const runOutcome = (record: RunRecord): 'result' | 'no-result' | undefined =>
  record.result?.ok ? 'result' : record.result?.reason === 'cancelled' ? undefined : 'no-result';

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
  registerRun({ name: input.name, role: input.role, work: input.work, subject: input.subject, run: run as Run<unknown>, runtime: input.runner.name, startedAt, ...(input.checkout ? { checkout: input.checkout } : {}) });
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
