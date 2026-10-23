
import { dirname } from 'node:path';
import { type ChildRun } from '../child-runner.js';
import { nameForLaunch } from '../session-name.js';
import { masterHarness, masterPrompt } from './harness.js';
import { writeHarnessPermissions } from '../harness.js';
import { type FleetProbe, selectFleetSession } from '../fleet.js';
import { accountLaunch, heldAwareProbe } from './environments.js';
import { closeFailedLaunch, launchStartMs, type RequestDelivery, startAgentSession, withLaunchClose } from './launch.js';
import { createdHerdrTab, type HerdrAgent, herdrJson, observeHerdrAgents } from './herdr.js';
import { failureText } from './worktrees.js';
import type { MasterConfig } from './profiles.js';
import type { Work } from '../model.js';
import { simplicityParagraph } from '../reviewer.js';

/** The registry role and profile name the master session launches under. */
export const masterProfile = 'master';
export const masterSetupCommand = 'graphyard master registry role set master ACCOUNT[,ACCOUNT…] --reason REASON';
/** The unconfigured-role refusal, carrying its own flag so the loop records the setup wait, not a launch failure. */
export const masterRoleUnconfigured = (reason: string) =>
  Object.assign(new Error(`${reason}; the durable loop launches no master session until the registry names its accounts: ${masterSetupCommand} (registry accounts + concurrency, like worker/reviewer, pinned to one live session)`), { masterRoleUnconfigured: true });

/**
 * The handover after the master prompt: a replacement continues from master status, with the parks
 * only a human answers named. Every line is bounded, and nothing here carries a credential.
 */
export function masterHandover(input: { work: Work[]; cliPath: string }) {
  const parks = input.work.filter(item => item.stage !== 'done').flatMap(item => item.humanRequest && !item.humanRequest.answer ? [`${item.key} (${item.humanRequest.kind}: ${item.humanRequest.needed})`] : []);
  const line = parks.length ? parks.join('; ') : 'none';
  return [
    `Handover from the launcher that started this session: it relaunches the master when the session is gone, so continue from node ${input.cliPath} master status; there is no earlier memory to inherit.`,
    `- Needs-you parks (human-only decisions): ${line.length > 480 ? `${line.slice(0, 479)}…` : line}`,
  ].join('\n');
}
/** The session's first request: the shared master prompt, the simplicity paragraph, then the handover. */
export const masterRequest = (config: MasterConfig, handover: string) => `${masterPrompt(config)} ${simplicityParagraph}${handover}`;

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
  return { agentName: name, pane: pane!, runtime: kind, account: selected.account.name, session: selected.account.fleet.session, delivery: delivery! };
}

/** The loop's master-session effect (GY-898): `launch` starts the session with the handover folded into its first request, on the registry's `master` role. */
export interface MasterSessionEffects {
  launch: (handover: string) => Promise<{ agentName: string; pane: string; runtime: string; account: string | null; session: string | null }>;
}
export const masterSessionEffects = (root: string, config: () => MasterConfig, run?: ChildRun): MasterSessionEffects => ({
  launch: async handover => {
    const { agentName, pane, runtime, account, session } = await launchMasterSession(root, config(), await observeHerdrAgents(run), handover, run);
    return { agentName, pane, runtime, account, session };
  },
});
