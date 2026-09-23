import { agentOwner, herdrWorkspaceHealth, type AttentionItem, type MasterConfig } from '../master.js';
import { reviewerBindingHealth } from '../reviewer.js';
import { loopSupervision, loopSupervisionAttention, type LoopSupervisorHost } from '../supervisor.js';

/**
 * The `setup` section of master status: installation state that silently stops every launch or
 * leaves the loop unsupervised — an App registered but never bound, a bound App whose credential
 * is gone, a Herdr workspace that no longer exists, and (GY-114) the loop's supervisor, read from
 * the host on every run rather than assumed. Each condition is also an attention item addressed
 * to the master, naming the command that repairs it; `attention` lists them in that order.
 */
export async function setupHealth(root: string, master: MasterConfig, supervisorHost?: LoopSupervisorHost) {
  const reviewer = await reviewerBindingHealth(master);
  const supervisor = await loopSupervision({ root, cliPath: master.cliPath }, supervisorHost);
  const supervisorAttention = loopSupervisionAttention(supervisor);
  const herdrWorkspace = herdrWorkspaceHealth(master);
  const setup = { reviewer, supervisor, herdrWorkspace,
    attention: [...reviewer.attention, ...supervisorAttention.map(item => item.text), ...(herdrWorkspace.exists === false ? [herdrWorkspace.reason!] : [])] };
  // An unsupervised loop stays stopped; each supervisor state names its own repair.
  const attention: AttentionItem[] = supervisorAttention.map(item => ({ subject: 'setup', text: item.text, ...agentOwner('master', item.next) }));
  for (const text of reviewer.attention) attention.push({ subject: 'setup', text, ...agentOwner('master', 'graphyard master reviewer setup (or graphyard master reviewer bind FILE --key-stdin) to bind the reviewer App') });
  if (herdrWorkspace.exists === false) attention.push({ subject: 'setup', text: herdrWorkspace.reason!, ...agentOwner('master', 'Set herdrWorkspace in .graphyard/master.json to a workspace herdr workspace list shows; master run adopts it on its next tick') });
  return { setup, attention };
}
