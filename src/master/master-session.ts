
import { gateRecordPath, readGateRecord } from '../batch-gate.js';
import { dispatchCauses, deploymentCauses, batchGateCauses, type MasterCause } from '../daemon/master-stalled-delivery.js';
import { readDispatchCursor } from '../auto-dispatch.js';
import { servingReport } from '../deploy-watch.js';
import { dirname } from 'node:path';
import { type ChildRun } from '../child-runner.js';
import { nameForLaunch } from '../session-name.js';
import { masterHarness, masterPrompt } from './harness.js';
import { writeHarnessPermissions } from '../harness.js';
import { type FleetProbe, httpFleetClient, selectFleetSession } from '../fleet.js';
import { accountLaunch, heldAwareProbe, readEnvironmentLog } from './environments.js';
import { closeFailedLaunch, launchStartMs, type RequestDelivery, deliverPrompt, launchSession, withLaunchClose } from './launch.js';
import { type HerdrAgent, observeHerdrAgents } from './herdr.js';
import type { ExhaustionSignal } from '../model/capacity.js';
import { failureText } from './worktrees.js';
import type { MasterConfig } from './profiles.js';
import type { Work } from '../model.js';
import { simplicityParagraph } from '../review-prompt.js';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { adoptConversation, assertConversationRuntime, awaitConversation, captureConversation, continuationContext, conversationArgs, graphyardInput, masterInputs, masterRecords, type Continuity } from './conversation.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { MasterSessionState } from '../daemon/state.js';

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
    `Handover from the launcher that started this session: it relaunches the master when the session is gone, so continue from node ${input.cliPath} master status.`,
    `- Needs-you parks (human-only decisions): ${line.length > 480 ? `${line.slice(0, 479)}…` : line}`,
    `- Pending operator goals: ${input.work.filter(item => item.humanRequest?.kind === 'goals-and-priorities').map(item => `${item.key}: ${item.humanRequest!.needed}${item.humanRequest!.answer ? `; answer ${JSON.stringify(item.humanRequest!.answer)}` : '; pending decision'}`).join('; ').slice(0, 1000) || 'no separate goal recorded on this board; follow its priorities and inspect master status. Goals held only in unread history are unknown'}`,
    `- Your open items: ${input.work.filter(item => item.stage !== 'done').map(item => `${item.key}: ${item.title} [priority ${item.priority}; ${item.stage}; candidate ${item.candidate?.sha ?? 'none'}; merge ${item.mergeLedger?.state ?? 'not started'}; delivery ${item.delivery?.mergeSha ?? 'pending'}]`).join('; ').slice(0, 2000) || 'none'}`,
  ].join('\n');
}
/** The session's first request: the shared master prompt, the simplicity paragraph, then the handover. */
export const masterRequest = (config: MasterConfig, handover: string) => `${masterPrompt(config)} ${simplicityParagraph}${handover}`;

export interface MasterLaunch { agentName: string; pane: string; runtime: string; account: string | null; session: string | null; delivery: RequestDelivery; continuity?: Continuity }
/**
 * Launch the loop's own master session (GY-898): a visible Herdr pane on the registry's master
 * role account, the master's harness rules, the shared master prompt with the launcher's handover
 * as its first request. The launch is refused — never fallen back to another role's account —
 * while the registry does not decide the role, Herdr cannot be read, or the name is already
 * visible; a failed launch releases the registry session and closes what it created.
 */
export async function launchMasterSession(root: string, config: MasterConfig, herdr: { agents: HerdrAgent[]; available: boolean }, handover: string, run?: ChildRun, probe: FleetProbe = {}, previous: Continuity | null = null): Promise<MasterLaunch> {
  const retry = `${masterSetupCommand}, then let the loop's next cycle launch the session`;
  const name = nameForLaunch(retry, () => config.masterAgentName);
  if (!herdr.available) throw new Error(`Herdr's session inventory could not be read, so no master session is launched into it; the launch is made again once Herdr answers`);
  if (herdr.agents.some(agent => agent.name === name)) throw new Error(`Master session ${name} is already visible in Herdr; the loop adopts it instead of launching a second`);
  const selected = await selectFleetSession(config, 'master', { name: masterProfile, principal: config.operatorAgent?.id }, await heldAwareProbe(config, { runtime: herdr, ...(config.forPerson ? { group: config.forPerson } : {}), ...probe }));
  if (!selected) throw masterRoleUnconfigured(`No agent registry role decides the master session`);
  const kind = selected.account.kind;
  let plan: ReturnType<typeof accountLaunch>;
  // The same reach the human launch grants (startMaster): Codex's sandbox is widened to the private
  // state the master's own commands write beside its credential, and nothing beyond it.
  try { assertConversationRuntime(kind); plan = accountLaunch({ kind, approvals: 'auto', agentArgs: [], environment: {} }, selected.account, { writable: [dirname(config.credentialFile)] }); }
  catch (error) { await selected.release(`master session launch failed: ${failureText(error).slice(0, 300)}`); throw error; }
  let pane: string | undefined, tabId: string | undefined, delivery: RequestDelivery | undefined;
  const current = previous?.current ?? null;
  const resume = !!current && current.runtime === kind && current.account === selected.account.name;
  const launch = randomUUID(), since = Date.now();
  const nativeId = resume ? current!.nativeId : kind === 'claude' ? randomUUID() : null;
  const origins = resume ? current!.origins : masterInputs(root, launch);
  let continuity: Continuity;
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
    const context = current ? await continuationContext(current) : { handover: 'Previous master conversation: no recovered record supplied. Last unanswered person message: unknown unless established by the handover.', input: null };
    const request = await graphyardInput(origins, 'launch', masterRequest(config, `${handover}\n${context.handover}`));
    // The same harness the human launch writes (master start): the master's own commands, and the
    // deny rules that keep it from borrowing another identity — never a worker or producer credential.
    await writeHarnessPermissions(root, masterHarness(root, config, kind), true);

    // Confined exactly as `master start` launches it (GY-1658): the checkout read-only at the OS
    // level, its managed .graphyard state and the shared Git areas writable. A host that cannot
    // apply the confinement refuses the launch; the master is never started unconfined.
    ({ delivery } = await launchSession({ name, kind, args: [...plan.args, ...conversationArgs(kind, nativeId, resume)], text: request, workspace: config.herdrWorkspace, label: `Graphyard master · ${config.repository}`, environment: { GRAPHYARD_MASTER: '1', ...(config.forPerson ? { GRAPHYARD_FOR_PERSON: config.forPerson } : {}), GRAPHYARD_URL: config.url, GRAPHYARD_HOST_ID: config.hostId, ...plan.environment }, run, onPane: (nextPane, nextTab) => { pane = nextPane; tabId = nextTab; }, start: { directory: root, coordinatorRoot: root, retry, contract: plan.contract, environment: plan.environment, timeoutMs: launchStartMs(config), confinement: 'master', masterStateDirectory: dirname(config.credentialFile) } }));
    const discovered = await awaitConversation(kind, plan.environment, root, since, nativeId, launchStartMs(config), request);
    const conversation = { launch, runtime: kind, account: selected.account.name, ...discovered,
      record: resume ? current!.record : join(masterRecords(root), `${launch}.jsonl`), origins,
      predecessor: resume ? current!.predecessor : current?.launch ?? null, supersededBy: null,
      inherited: context.input ? { ...context.input, delivery: request.split('\n')[0] } : null };
    await captureConversation(conversation);
    continuity = { current: conversation, predecessor: resume ? previous!.predecessor : current ? { ...current, supersededBy: launch } : null };
  } catch (error) { throw await abandon(error, 'master session launch failed'); }
  return { agentName: name, pane: pane!, runtime: kind, account: selected.account.name, session: selected.account.fleet.session, delivery: delivery!, continuity: continuity! };
}

/** The loop's master-session effect (GY-898): `launch` starts the session with the handover folded into its first request, on the registry's `master` role. */
export interface MasterSessionEffects {
  initialize?: (master: MasterSessionState, handle?: HerdrAgent, prompts?: string[]) => Promise<Continuity>;
  launch: (handover: string, previous?: Continuity | null) => Promise<Omit<MasterLaunch, 'delivery'>>;
  /** Delivers an actionable cause even when the runtime still labels the pane working. */
  pendingCauses?: (work: Work[]) => Promise<MasterCause[]>;
  wake?: (target: string, text: string, continuity?: Continuity | null) => Promise<unknown>;
  /** Holds the session's account until a limit notice's reset (GY-2949), the way a worker's notice holds its account. */
  exhaust?: (account: string, notice: ExhaustionSignal) => Promise<unknown>;
  /** Ends the agent-registry session a closed or vanished pane ran under, so the role's next account can be selected (GY-2949). */
  end?: (session: string, reason: string) => Promise<unknown>;
  /** The live master-role registry sessions of this host and person, each ended before a launch whether or not the loop's state names it (GY-3091). */
  live?: () => Promise<{ id: string; selectedAt: string }[]>;
}
export const masterSessionEffects = (root: string, config: () => MasterConfig, run?: ChildRun): MasterSessionEffects => ({
  initialize: async (master, handle, prompts = []) => {
    const current = config();
    const log = await readEnvironmentLog(current);
    const selected = log.selected['master:master'];
    const account = master.account ?? selected?.environment ?? null;
    const registry = await httpFleetClient(current).document();
    const login = registry.accounts.find(entry => entry.name === account);
    const runtime = registry.runtimes.find(entry => entry.name === login?.runtime);
    const kind = master.runtime ?? handle?.agent ?? selected?.kind ?? runtime?.launch.kind;
    if (!kind) throw new Error('Cannot identify the existing master runtime; retaining its state instead of starting cold');
    assertConversationRuntime(kind);
    const variable = runtime?.launch.homeVariable ?? (kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME');
    const environment = { ...runtime?.launch.environment, ...(login?.credential.home ? { [variable]: login.credential.home } : {}) };
    const request = await readFile(master.launchRequestRecord ?? join(root, '.graphyard/launch', `${master.agentName ?? current.masterAgentName}.request`), 'utf8').catch(() => null);
    if (request !== null) {
      const record = join(masterRecords(root), `${createHash('sha256').update(request).digest('hex')}.request`);
      await mkdir(masterRecords(root), { recursive: true, mode: 0o700 });
      await writeFile(record, request, { flag: 'wx', mode: 0o400 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      master.launchRequestRecord = record;
    }
    return adoptConversation(root, { runtime: kind, account, environment, origins: masterInputs(root, current.masterAgentName),
      prompts: [...(request ? [{ origin: 'launch' as const, text: request }] : []), ...prompts.map(text => ({ origin: 'wake' as const, text }))] });
  },
  pendingCauses: async work => {
    const current = config();
    const [cursor, serving] = await Promise.all([readDispatchCursor(root, current), servingReport(root, current.repository, current.baseBranch)]);
    // GY-3119: a held batch gate and a revert rate above 1 in 5 wake the master.
    return [...dispatchCauses(work, cursor), ...deploymentCauses(serving.failedDeploy), ...batchGateCauses(readGateRecord(gateRecordPath(root)))];
  },
  wake: (target, text, continuity) => deliverPrompt(target, text, run, {
    beforeSubmit: (text, attempt) => graphyardInput(continuity?.current.origins ?? masterInputs(root, config().masterAgentName), attempt === 1 ? 'wake' : 'retry', text),
  }),
  launch: async (handover, previous) => {
    const { delivery: _, ...launched } = await launchMasterSession(root, config(), await observeHerdrAgents(run), handover, run, {}, previous);
    return launched;
  },
});
