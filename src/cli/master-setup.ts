import { agentOwner, herdrWorkspaceHealth, humanOwner, type AttentionItem, type MasterConfig } from '../master.js';
import { reviewerBindingHealth } from '../reviewer.js';
import { loopSupervision, loopSupervisionAttention, type LoopSupervisorHost } from '../supervisor.js';
import { triageConcurrency } from '../triage.js';

/**
 * The `setup` section of master status: installation state that silently stops every launch or
 * leaves the loop unsupervised — an App registered but never bound, a bound App whose credential
 * is gone, a Herdr workspace that no longer exists, and (GY-114) the loop's supervisor, read from
 * the host on every run rather than assumed. Each condition is also an attention item addressed
 * to the master, naming the command that repairs it; `attention` lists them in that order. A
 * missing browser profile is the operator's to give (it lends the master their signed-in GitHub
 * session), so it is recorded here for them rather than asked for in the master's chat (GY-184).
 */
export const browserProfileMissing = 'No browser profile is configured: App permission updates, installation acceptance, and page-only protection changes cannot run through master browser until the operator lends the master a signed-in Chrome profile';
export const browserProfileNext = (cliPath: string) => `node ${cliPath} master init --token-stdin --browser-profile PROFILE`;
/**
 * What drives triage of machine-filed backlog items (GY-431): the loop's triage step runs only on
 * the research account `run.research` names. Without it nothing triages them — each review
 * follow-up and recurring-fault item waits for a person's release or close and, past a day, only
 * raises attention — so setup says so rather than leaving it to be discovered from that attention.
 */
export function triageSetup(master: Pick<MasterConfig, 'run'>) {
  const configured = !!master.run?.research;
  return { configured, drivenBy: 'run.research' as const,
    text: configured ? `The loop triages machine-filed items on the research account (run.research, model ${master.run.research!.model}), ${master.run.research!.triageConcurrency ?? triageConcurrency} at once`
      : 'Triage of machine-filed items is off: run.research is not set, so review follow-ups and recurring-fault items wait for graphyard master release or master close and, past a day untriaged, raise attention. Set run.research in .graphyard/master.json to have the loop triage them' };
}
export async function setupHealth(root: string, master: MasterConfig, supervisorHost?: LoopSupervisorHost) {
  const reviewer = await reviewerBindingHealth(master);
  const supervisor = await loopSupervision({ root, cliPath: master.cliPath }, supervisorHost);
  const supervisorAttention = loopSupervisionAttention(supervisor);
  const herdrWorkspace = await herdrWorkspaceHealth(master);
  const setup = { reviewer, supervisor, herdrWorkspace, triage: triageSetup(master),
    attention: [...reviewer.attention, ...supervisorAttention.map(item => item.text), ...(herdrWorkspace.exists === false ? [herdrWorkspace.reason!] : [])] };
  // An unsupervised loop stays stopped; each supervisor state names its own repair.
  const attention: AttentionItem[] = supervisorAttention.map(item => ({ subject: 'setup', text: item.text, ...agentOwner('master', item.next) }));
  for (const text of reviewer.attention) attention.push({ subject: 'setup', text, ...agentOwner('master', 'graphyard master reviewer setup (or graphyard master reviewer bind FILE --key-stdin) to bind the reviewer App') });
  if (herdrWorkspace.exists === false) attention.push({ subject: 'setup', text: herdrWorkspace.reason!, ...agentOwner('master', 'Set herdrWorkspace in .graphyard/master.json to a workspace herdr workspace list shows; master run adopts it on its next tick') });
  if (!master.browser) attention.push({ subject: 'setup', text: browserProfileMissing, ...humanOwner('issuing credentials to people', browserProfileNext(master.cliPath)) });
  return { setup, attention };
}
