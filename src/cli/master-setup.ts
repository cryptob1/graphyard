import { agentOwner, herdrWorkspaceHealth, humanOwner, type AttentionItem, type MasterConfig } from '../master.js';
import { reviewerBindingHealth } from '../reviewer.js';
import { loopSupervision, loopSupervisionAttention, type LoopSupervisorEvidence, type LoopSupervisorHost } from '../supervisor.js';
import { readDaemonState } from '../master-daemon.js';
import { detectLoopSupervisorUnit } from '../daemon/upgrade.js';
import type { MainGuardReadiness } from '../main-guard.js';

/**
 * The `setup` section of master status: installation state that silently stops every launch or
 * leaves the loop unsupervised — an App registered but never bound, a bound App whose credential
 * is gone, a Herdr workspace that no longer exists, and (GY-114) the loop's supervisor, read from
 * the host on every run rather than assumed. Each condition is also an attention item addressed
 * to the master, naming the command that repairs it; `attention` lists them in that order. A
 * missing browser profile is the operator's to give (it lends the master their signed-in GitHub
 * session), so it is recorded here for them rather than asked for in the master's chat (GY-184).
 * An armed main guard without its revert approver App (GY-1335), read from the control plane's
 * status, is named here too: every revert it opens would be refused by main's last-push-approval
 * rule, so it is raised before a merge breaks main, not after.
 */
export const browserProfileMissing = 'No browser profile is configured: App permission updates, installation acceptance, and page-only protection changes cannot run through master browser until the operator lends the master a signed-in Chrome profile';
export const browserProfileNext = (cliPath: string) => `node ${cliPath} master init --token-stdin --browser-profile PROFILE`;
/**
 * What the loop's cursor records of its own supervision (GY-1400), for a probe that could not reach
 * the user manager: the unit the reading process runs under, when it is the loop or its child, and
 * whether the loop's last self-upgrade re-executed it through its unit.
 */
export async function loopSupervisorEvidence(root: string, master: MasterConfig, unit = detectLoopSupervisorUnit()): Promise<LoopSupervisorEvidence> {
  const state = await readDaemonState(root, master).catch(() => null);
  return { unit, reexecuted: state?.upgrade?.last?.self === true };
}

export async function setupHealth(root: string, master: MasterConfig, supervisorHost?: LoopSupervisorHost, coordinator?: { mainGuard?: MainGuardReadiness | null } | null,
  evidence: (root: string, master: MasterConfig) => Promise<LoopSupervisorEvidence | null> = loopSupervisorEvidence) {
  const reviewer = await reviewerBindingHealth(master);
  const supervisor = await loopSupervision({ root, cliPath: master.cliPath }, supervisorHost);
  // The cursor is read only when this vantage could not reach the user manager.
  const supervisorAttention = loopSupervisionAttention(supervisor, supervisor.unreachable ? await evidence(root, master).catch(() => null) : null);
  const herdrWorkspace = await herdrWorkspaceHealth(master);
  const mainGuard = coordinator?.mainGuard ?? null, revertApprover = mainGuard?.attention ?? null;
  const setup = { reviewer, supervisor, herdrWorkspace, mainGuard,
    attention: [...reviewer.attention, ...supervisorAttention.map(item => item.text), ...(herdrWorkspace.exists === false ? [herdrWorkspace.reason!] : []), ...(revertApprover ? [revertApprover] : [])] };
  // An unsupervised loop stays stopped; each supervisor state names its own repair.
  const attention: AttentionItem[] = supervisorAttention.map(item => ({ subject: 'setup', text: item.text, ...agentOwner('master', item.next) }));
  for (const text of reviewer.attention) attention.push({ subject: 'setup', text, ...agentOwner('master', 'graphyard master reviewer setup (or graphyard master reviewer bind FILE --key-stdin) to bind the reviewer App') });
  if (herdrWorkspace.exists === false) attention.push({ subject: 'setup', text: herdrWorkspace.reason!, ...agentOwner('master', 'Set herdrWorkspace in .graphyard/master.json to a workspace herdr workspace list shows; master run adopts it on its next tick') });
  if (revertApprover) attention.push({ subject: 'setup', text: revertApprover, ...agentOwner('master', 'Set GRAPHYARD_REVERT_APPROVER_APP_ID, GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID and GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY (or _FILE) on the control-plane deployment to an App installed on the repository other than the control-plane App (the reviewer App serves), redeploy, then rerun graphyard doctor') });
  if (!master.browser) attention.push({ subject: 'setup', text: browserProfileMissing, ...humanOwner('issuing credentials to people', browserProfileNext(master.cliPath)) });
  return { setup, attention };
}
