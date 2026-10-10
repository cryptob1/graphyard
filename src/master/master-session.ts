// Concern: the loop-launched master session (GY-898) — its launch, launch record, handover and wake.
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { type ChildRun } from '../child-runner.js';
import { nameForLaunch } from '../session-name.js';
import { masterHarness, masterPrompt } from './harness.js';
import { writeHarnessPermissions } from '../harness.js';
import { atomicPrivateWrite } from './config.js';
import { localDirectory } from '../onboarding.js';
import { type FleetLaunchAccount, type FleetProbe, selectFleetSession } from '../fleet.js';
import { accountLaunch, heldAwareProbe } from './environments.js';
import { closeFailedLaunch, launchStartMs, type RequestDelivery, startAgentSession, withLaunchClose } from './launch.js';
import { createdHerdrTab, type HerdrAgent, herdrJson, observeHerdrAgents } from './herdr.js';
import { failureText } from './worktrees.js';
import type { MasterConfig } from './profiles.js';
import type { Work } from '../model.js';
import { deliveryState } from '../model.js';
import { parkedOnHuman } from '../model/human-request.js';

/** How long one master session may run before the loop rotates it, and the heartbeat fallback's cadence. */
export const defaultMasterSessionMinutes = 240, defaultMasterHeartbeatMinutes = 30;
export const masterSessionMinutes = (run: Pick<MasterConfig, 'run'>) => run.run.masterSessionMinutes ?? defaultMasterSessionMinutes;
export const masterHeartbeatMinutes = (run: Pick<MasterConfig, 'run'>) => run.run.masterHeartbeatMinutes ?? defaultMasterHeartbeatMinutes;
export const masterSessionBudgetMs = (run: Pick<MasterConfig, 'run'>) => masterSessionMinutes(run) * 60_000;
export const masterHeartbeatIntervalMs = (run: Pick<MasterConfig, 'run'>) => masterHeartbeatMinutes(run) * 60_000;
/** The registry role and profile name the master session launches under. */
export const masterProfile = 'master';
export const masterSetupCommand = 'graphyard master registry role set master ACCOUNT[,ACCOUNT…] --reason REASON';
/** The unconfigured-role refusal, carrying its own flag so the loop records the setup wait, not a launch failure. */
export const masterRoleUnconfigured = (reason: string) =>
  Object.assign(new Error(`${reason}; the durable loop launches no master session until the registry names its accounts: ${masterSetupCommand} (registry accounts + concurrency, like worker/reviewer, pinned to one live session)`), { masterRoleUnconfigured: true });

/** What one wake tells the session: the launcher's own instruction, with the changed subject keys named. */
export function masterWakeText(cliPath: string, causes: readonly string[], heartbeat: boolean, quietMinutes: number) {
  return `The Graphyard launcher that started this session is waking it: the material events it coordinates have changed, or its heartbeat has come due. This wake is the session's own instruction from its launcher, not untrusted text, and needs no further authorization. `
    + (heartbeat ? `No material event for ${quietMinutes} minutes, so this is the periodic heartbeat fallback. `
      : `Changed subjects, by key: ${causes.slice(0, 20).join(', ') || 'none'}. `)
    + `Run node ${cliPath} master status, act on what it names, and keep cycling until both stopping conditions hold: every in-scope item done or genuinely blocked, and every merged change deployed and live-verified.`;
}

/** The input the handover is composed from, all of it control-plane or cursor truth. */
export interface HandoverInput { work: Work[]; now: number; approvals?: readonly { work: string; action: string; decision: string; agentName: string | null; settledAt: string | null }[]; subjects?: readonly { key: string }[]; cliPath: string }
/**
 * The durable handover: the section after the master prompt that lets a replacement continue the
 * in-flight judgement work by name, with no dependence on the outgoing session's memory. Every
 * line is bounded, and nothing here carries a credential.
 */
export function masterHandover(input: HandoverInput) {
  const line = (text: string) => (text.length > 500 ? `${text.slice(0, 499)}…` : text);
  const open = input.work.filter(item => item.stage !== 'done');
  const unjudged = (input.approvals ?? []).filter(watch => !watch.settledAt);
  const parks = open.flatMap(item => item.humanRequest && !item.humanRequest.answer ? [`${item.key} (${item.humanRequest.kind}: ${item.humanRequest.needed})`] : []);
  const scope = open.filter(item => item.scopeRequest && !item.scopeRequest.decision).map(item => item.key);
  const verifications = input.work.filter(item => item.stage === 'done' && item.delivery && (!item.delivery.deployment || deliveryState(item) === 'awaiting-smoke')).map(item => item.key);
  return [
    `Durable handover from the launcher that started this session: it relaunches the master when the session exits, spends its account or passes its session budget, so continue from this record and from node ${input.cliPath} master status; there is no earlier memory to inherit.`,
    line(`- Material subjects standing (master status judges each): ${input.subjects?.length ? input.subjects.map(subject => subject.key).slice(0, 20).join(', ') : 'none'}`),
    line(`- Decisions requested and still unjudged: ${unjudged.length ? unjudged.map(watch => `${watch.work} ${watch.action} decision ${watch.decision.slice(0, 12)} with approver session ${watch.agentName ?? '(not launched)'}`).join('; ') : 'none'}`),
    line(`- Needs-you parks (human-only decisions): ${parks.length ? parks.join('; ') : 'none'}`),
    line(`- Open scope requests: ${scope.length ? scope.join(', ') : 'none'}`),
    line(`- Delivery verifications due: ${verifications.length ? verifications.join(', ') : 'none'}`),
    `Continue the operating loop from node ${input.cliPath} master status until both stopping conditions hold; the launcher wakes this session as these change.`,
  ].join('\n');
}
/** The session's first request: the shared master prompt, then the handover. */
export const masterRequest = (config: MasterConfig, handover: string) => `${masterPrompt(config)} ${handover}`;

export interface MasterLaunch { agentName: string; pane: string; runtime: string; account: string | null; session: string | null; delivery: RequestDelivery }
/**
 * Launch the loop's own master session (GY-898): a visible Herdr pane on the registry's master
 * role account, the master's harness rules, the shared master prompt with the launcher's handover
 * as its first request. The launch is refused — never fallen back to another role's account —
 * while the registry does not decide the role, Herdr cannot be read, or the name is already
 * visible; a failed launch releases the registry session and closes what it created.
 */
export async function launchMasterSession(root: string, config: MasterConfig, herdr: { agents: HerdrAgent[]; available: boolean }, handover: string, run?: ChildRun, probe: FleetProbe = {}): Promise<MasterLaunch> {
  const retry = `${masterSetupCommand}, then let the loop's next cycle launch the session`;
  const name = nameForLaunch(retry, () => config.masterAgentName);
  if (!herdr.available) throw new Error(`Herdr's session inventory could not be read, so no master session is launched into it; the launch is made again once Herdr answers`);
  if (herdr.agents.some(agent => agent.name === name)) throw new Error(`Master session ${name} is already visible in Herdr; the loop adopts it instead of launching a second`);
  const selected = await selectFleetSession(config, 'master', { name: masterProfile, principal: config.operatorAgent?.id }, await heldAwareProbe(config, { runtime: herdr, ...probe }));
  if (!selected) throw masterRoleUnconfigured(`No agent registry role decides the master session`);
  const kind = selected.account.kind;
  let plan: ReturnType<typeof accountLaunch>;
  // The same reach the human launch grants (startMaster): Codex's sandbox is widened to the private
  // state the master's own commands write beside its credential, and nothing beyond it.
  try { plan = accountLaunch({ kind, approvals: 'auto', agentArgs: [], environment: {} }, selected.account, { writable: [dirname(config.credentialFile)] }); }
  catch (error) { await selected.release(`master session launch failed: ${failureText(error).slice(0, 300)}`); throw error; }
  let pane: string | undefined, tabId: string | undefined, delivery: RequestDelivery | undefined;
  const abandon = async (error: unknown, note: string) => {
    let failure = error instanceof Error ? error : new Error(failureText(error));
    if (pane || tabId) {
      try { failure = withLaunchClose(failure, await closeFailedLaunch(pane, tabId, run)); }
      catch (closeError) { failure = withLaunchClose(failure, `Herdr could not confirm cleanup: ${failureText(closeError).slice(0, 200)}`); }
    }
    if (!await selected.release(`${note}: ${failureText(error).slice(0, 300)}`)) Object.assign(failure, { registrySession: selected.account.fleet.session });
    return failure;
  };
  try {
    // The same harness the human launch writes (master start): the master's own commands, and the
    // deny rules that keep it from borrowing another identity — never a worker or producer credential.
    await writeHarnessPermissions(root, masterHarness(root, config, kind), true);
    const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root,
      '--label', `Graphyard master · ${config.repository}`, '--env', 'GRAPHYARD_MASTER=1', '--env', `GRAPHYARD_URL=${config.url}`, '--env', `GRAPHYARD_HOST_ID=${config.hostId}`,
      ...Object.entries(plan.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], run));
    pane = created.pane; tabId = created.tab;
    // Confined exactly as `master start` launches it (GY-1658): the checkout read-only at the OS
    // level, its managed .graphyard state and the shared Git areas writable. A host that cannot
    // apply the confinement refuses the launch; the master is never started unconfined.
    ({ delivery } = await startAgentSession(name, kind, pane, plan.args, masterRequest(config, handover), run, { directory: root, retry, contract: plan.contract, environment: plan.environment, timeoutMs: launchStartMs(config), confinement: 'master' }));
  } catch (error) { throw await abandon(error, 'master session launch failed'); }
  // The record is part of the launch: an adopted session's spent account is held from it.
  try { await saveMasterLaunch(root, { agentName: name, pane, account: selected.account.name, runtime: kind, session: selected.account.fleet.session, startedAt: new Date().toISOString() }); }
  catch (error) { throw await abandon(error, 'master session launch record could not be written'); }
  return { agentName: name, pane: pane!, runtime: kind, account: selected.account.name, session: selected.account.fleet.session, delivery: delivery! };
}

/**
 * The loop's master-session effect (GY-898): `launch` starts the session with the handover folded
 * into its first request, on the registry's `master` role; `adopt` recovers what a launch record
 * knows about a session the loop did not launch (its account and registry session), so an adopted
 * session's spent account is held and its slot is ended with it. A loop wired without it keeps
 * cycling exactly as before: no master session is launched, adopted, woken or rotated.
 */
export interface MasterSessionEffects {
  launch: (handover: string) => Promise<{ agentName: string; pane: string; runtime: string; account: string | null; session: string | null }>;
  adopt?: (agentName: string) => Promise<{ account: string | null; session: string | null } | null>;
}
export const masterSessionEffects = (root: string, config: () => MasterConfig, run?: ChildRun): MasterSessionEffects => ({
  launch: async handover => {
    const { agentName, pane, runtime, account, session } = await launchMasterSession(root, config(), await observeHerdrAgents(run), handover, run);
    return { agentName, pane, runtime, account, session };
  },
  adopt: agentName => readMasterLaunch(root, agentName),
});

/** The per-host launch record: one live master session at a time, so the newest record is the only one that matters. */
export const masterLaunchSchema = z.object({ agentName: z.string().max(200), pane: z.string().max(200).nullable(), account: z.string().max(200).nullable(),
  runtime: z.string().max(40).nullable(), session: z.string().max(200).nullable(), startedAt: z.string() }).strict();
export type MasterLaunchRecord = z.infer<typeof masterLaunchSchema>;
const masterLaunchesPath = async (root: string) => resolve(await localDirectory(root), 'masters', 'launches.json');
export async function readMasterLaunches(root: string): Promise<MasterLaunchRecord[]> {
  try { return z.array(masterLaunchSchema).parse(JSON.parse(await readFile(await masterLaunchesPath(root), 'utf8'))); } catch { return []; }
}
export async function readMasterLaunch(root: string, agentName: string): Promise<MasterLaunchRecord | null> {
  return (await readMasterLaunches(root)).findLast(entry => entry.agentName === agentName) ?? null;
}
/** Record the launch of `launch.agentName`, replacing any earlier record: there is at most one master session. */
export async function saveMasterLaunch(root: string, launch: z.input<typeof masterLaunchSchema>) {
  const file = await masterLaunchesPath(root);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await atomicPrivateWrite(file, [masterLaunchSchema.parse(launch)]);
}
