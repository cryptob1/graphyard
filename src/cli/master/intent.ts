// Concern: `graphyard master` intent and two-party decision subcommands — autonomy, scope, close, withdraw, refuse.
import { randomUUID } from 'node:crypto';
import { agentToken, autonomySubcommands, runAutonomyCommand, listHerdrAgents, readCredentialFile } from '../../master.js';
import { readDaemonState } from '../../master-daemon.js';
import { readProducerLedger } from '../../producer.js';
import { readDispatchCursor } from '../../auto-dispatch.js';
import { approveScopeRequest } from '../master-status.js';
import { derivedIntent } from '../planned-files-intent.js';
import { readSecretFromStdin } from '../context.js';
import { closeRequest } from '../master-close.js';
import { assertHandAction, handDecision } from '../hand-actions.js';
import { unhandled, type MasterSession } from './session.js';

/** The master's own intent (create, requirements, scope) and the decisions it requests, withdraws or refuses. */
export async function intentCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, master, masterToken, masterApi, masterMutation, coordinator } = session;
  if (id === 'create' || id === 'requirements') return print(await derivedIntent(root, master, id, args, { coordinator: masterApi, mutate: masterMutation, token: () => agentToken(root, master, 'operatorAgent') }));
  // Evidence and merge decisions on a system-driven item are the loop's to request (GY-175),
  // judged on the same work document the decision is built from.
  const assertDecision = async (work: any, action: string, input: unknown, now: number) => {
    const loop = { sessions: (await readProducerLedger(root)).producers, failures: (await readDispatchCursor(root, master)).failures, now, requestsDecisions: !!master.operatorAgent };
    const owned = handDecision(work, action, input, loop); if (owned) assertHandAction(work, owned);
  };
  if ((autonomySubcommands as readonly string[]).includes(id ?? '')) return print(await runAutonomyCommand(root, master, id!, args,
    { coordinator: masterApi, readSecret: () => readSecretFromStdin(10_000), agents: listHerdrAgents, daemonLock: async () => (await readDaemonState(root, master)).lock, assertDecision }));
  if (id === 'scope') return print(await approveScopeRequest(root, master, args, { coordinator: masterApi }));
  if (id === 'close') {
    // The master's own operator-agent identity when provisioned, else its coordinator credential.
    const { key, body } = closeRequest(args);
    return print(await masterMutation(`work/${encodeURIComponent(key)}/close`, body, randomUUID(), master.operatorAgent ? await agentToken(root, master, 'operatorAgent') : masterToken));
  }
  if (id === 'withdraw') {
    // Runs under the operator-agent identity that made the request; the server resolves GY-N.
    if (!args[0] || !args[1] || !args.slice(2).join(' ').trim()) throw new Error('Use master withdraw GY-N DECISION REASON');
    return print(await masterMutation(`work/${encodeURIComponent(args[0])}/decide`, { action: 'withdraw', decision: args[1], reason: args.slice(2).join(' ') }, randomUUID(), await agentToken(root, master, 'operatorAgent')));
  }
  if (id === 'refuse') {
    // The approver's decline is a recorded write, never a session that ends without approving
    // (GY-141). Like approve, it runs only under the approver session's own credential.
    if (process.env.GRAPHYARD_MASTER === '1') throw new Error('The master never judges its own decisions; to take one back, graphyard master withdraw GY-N DECISION REASON');
    const file = process.env.GRAPHYARD_TOKEN_FILE;
    if (!file) throw new Error('master refuse runs in an approver session, which carries its own credential file in GRAPHYARD_TOKEN_FILE');
    if (!args[0] || !args[1] || !args.slice(2).join(' ').trim()) throw new Error('Use master refuse GY-N DECISION REASON');
    const token = await readCredentialFile(file);
    for (const own of [master.credentialFile, master.operatorAgent?.credentialFile]) if (own && token === await readCredentialFile(own).catch(() => null)) throw new Error('That is one of the master\'s own credentials; refusals come from the approver identity');
    return print(await masterMutation(`work/${encodeURIComponent(args[0])}/approve`, { action: 'refuse', decision: args[1], reason: args.slice(2).join(' ') }, randomUUID(), token));
  }
  return unhandled;
}
