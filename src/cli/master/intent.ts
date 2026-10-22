// Concern: `graphyard master` intent subcommands — autonomy, promote, adopt, close — applied at once with the master's identity.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { agentToken, intentInput, autonomySubcommands, runAutonomyCommand, listHerdrAgents, promoteToAutonomy, assertPromotionRoute } from '../../master.js';
import { readDaemonState } from '../../master-daemon.js';
import { wholeDocument } from '../../model/work-summary.js';
import { postDeployCriterionRefusal, postDeployOnlyRefusal, type Work } from '../../model/work.js';
import { readSecretFromStdin } from '../context.js';
import { closeRequest } from '../master-close.js';
import { unhandled, type MasterSession } from './session.js';

/**
 * `master create FILE REASON` and `master requirements GY-N FILE REASON`: the intent file is posted
 * as written. A criterion whose outcome is a live-install observation is refused unless declared
 * post-deploy (GY-1660), and so is an item of nothing but declared verifications (GY-1685).
 */
export async function derivedIntent(id: 'create' | 'requirements', args: string[],
  deps: { coordinator: (path: string) => Promise<any>; mutate: (path: string, data: unknown, requestId?: string, credential?: string) => Promise<any>; token: () => Promise<string> }) {
  const file = id === 'create' ? args[0] : args[1], reason = args.slice(id === 'create' ? 1 : 2).join(' ').trim();
  if (!file || id === 'requirements' && !args[0]) throw new Error(id === 'create' ? 'Use master create FILE REASON' : 'Use master requirements GY-N FILE REASON');
  if (!reason) throw new Error(`master ${id} needs a REASON; every agent decision is attributable`);
  const input = JSON.parse(await readFile(file, 'utf8'));
  const listed: Work | undefined = id === 'requirements' ? (await deps.coordinator('work-snapshot')).work.find((item: Work) => item.id === args[0] || item.key === args[0]) : undefined;
  // A settled delivery is a summary in the snapshot (GY-422); its requirements are read whole.
  const work = listed && await wholeDocument(listed, deps.coordinator);
  if (id === 'requirements' && !work) throw new Error(`Unknown work item ${args[0]}`);
  const { plannedFiles: _retired, ...intent } = work ? intentInput('requirements', work, input) : input;
  const postDeploy = postDeployCriterionRefusal(intent.criteria ?? []) ?? postDeployOnlyRefusal(intent.criteria ?? []);
  if (postDeploy) throw new Error(postDeploy);
  return deps.mutate(work ? `work/${work.id}/requirements` : 'work', { ...intent, reason }, process.env.GRAPHYARD_REQUEST_ID ?? randomUUID(), await deps.token());
}

/** The master's own intent, applied at once with its operator-agent identity. */
export async function intentCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, master, masterToken, masterApi, masterMutation, coordinator } = session;
  if (id === 'create' || id === 'requirements') return print(await derivedIntent(id, args, { coordinator: masterApi, mutate: masterMutation, token: () => agentToken(root, master, 'operatorAgent') }));
  // GY-1502: a supervised install's autonomy apply is the promotion's, behind its checks and audit.
  if (id === 'autonomy') assertPromotionRoute(master, args);
  if ((autonomySubcommands as readonly string[]).includes(id ?? '')) return print(await runAutonomyCommand(root, master, id!, args,
    { coordinator: masterApi, readSecret: () => readSecretFromStdin(10_000), agents: listHerdrAgents, daemonLock: async () => (await readDaemonState(root, master)).lock }));
  if (id === 'promote') {
    // GY-1502: the operator's one audited transition to autonomy, with the admin credential read once from stdin; there is no demotion.
    if (args.some(arg => arg !== '--admin-token-stdin')) throw new Error('Use master promote --admin-token-stdin; it takes no other argument and there is no demotion');
    return print(await promoteToAutonomy(root, args.includes('--admin-token-stdin') ? await readSecretFromStdin(10_000) : undefined));
  }
  if (id === 'adopt') {
    // GY-1849: bind one existing pull request to one held item on its same branch and head, with the
    // original source's key and URL kept on the item. The control plane re-reads the live head itself
    // and refuses a moved one or a second owner, naming the holder; repeating the same adoption is a no-op.
    const flags = ['--pr', '--head', '--source-key', '--source-url'];
    const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] ?? null : null; };
    const [key] = args;
    const reason = args.filter((arg, at) => at > 0 && !flags.includes(arg) && !flags.includes(args[at - 1]!)).join(' ');
    const pr = Number(value('--pr')), head = value('--head'), sourceKey = value('--source-key'), sourceUrl = value('--source-url');
    if (!key || key.startsWith('--') || !Number.isInteger(pr) || pr <= 0 || !head || !/^[0-9a-f]{40}$/.test(head) || !reason.trim())
      throw new Error('Use master adopt GY-N --pr NUMBER --head SHA [--source-key KEY --source-url URL] REASON');
    return print(await masterMutation(`work/${encodeURIComponent(key)}/adopt`, { pr, head, ...(sourceKey ? { sourceKey } : {}), ...(sourceUrl ? { sourceUrl } : {}), reason },
      randomUUID(), master.operatorAgent ? await agentToken(root, master, 'operatorAgent') : masterToken));
  }
  if (id === 'close') {
    // The master's own operator-agent identity when provisioned, else its coordinator credential.
    const { key, body } = closeRequest(args);
    return print(await masterMutation(`work/${encodeURIComponent(key)}/close`, body, randomUUID(), master.operatorAgent ? await agentToken(root, master, 'operatorAgent') : masterToken));
  }
  return unhandled;
}
