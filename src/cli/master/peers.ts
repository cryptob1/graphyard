// Concern: `graphyard master peer` and `master send` — this Master messaging another install's Master through Graphyard (GY-3345).
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { atomicPrivateWrite, loadStoredMasterConfig, readCredentialFile } from '../../master/config.js';
import { masterConfigSchema } from '../../master/profiles.js';
import { unhandled, type MasterSession } from './session.js';

type Peer = NonNullable<import('../../master/profiles.js').MasterConfig['peers']>[number];

/** One call to a peer install as the reporter identity it issued this one; an unreachable or refusing peer is named. */
async function peerCall(peer: Peer, path: string, body?: unknown) {
  const token = await readCredentialFile(peer.tokenFile);
  let response: Response;
  try {
    response = await fetch(`${peer.url.replace(/\/+$/, '')}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error instanceof Error ? error.message : String(error));
    throw new Error(`Peer ${peer.name} at ${peer.url} is unreachable (${cause}); nothing was sent or stored`);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`Peer ${peer.name} refused it (${response.status}): ${text.slice(0, 300)}; nothing was stored`);
  return JSON.parse(text);
}

async function savePeers(root: string, peers: Peer[]) {
  const config = await loadStoredMasterConfig(root);
  await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), masterConfigSchema.parse({ ...config, peers }));
}

export async function peerCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, master, masterApi, masterMutation } = session;
  const peers = master.peers ?? [];
  if (id === 'peer') {
    const [verb, name, url] = args;
    if (verb === 'list') return print({ peers });
    if (verb === 'remove') {
      if (!peers.some(peer => peer.name === name)) throw new Error(`There is no peer ${name}; master peer list names them`);
      await savePeers(root, peers.filter(peer => peer.name !== name));
      return print({ removed: name });
    }
    const tokenFile = args[args.indexOf('--token-file') + 1];
    if (verb !== 'add' || !name || !url || !args.includes('--token-file') || !tokenFile) throw new Error('Use master peer add NAME URL --token-file PATH, master peer list or master peer remove NAME');
    const peer = { name, url, tokenFile: isAbsolute(tokenFile) ? tokenFile : resolve(tokenFile) };
    // The token must be a reporter identity on that install: the one role that lets this Master message its Master.
    const status = await peerCall(peer, 'status');
    if (status.actor?.role !== 'reporter') throw new Error(`The token for peer ${name} is ${status.actor?.role ?? 'no'} identity on ${url}; ask that install for a reporter (principal add ID --role reporter)`);
    await savePeers(root, [...peers.filter(entry => entry.name !== name), peer]);
    return print({ added: name, url, as: status.actor.id });
  }
  if (id === 'send') {
    const reply = args.indexOf('--reply'), replyTo = reply >= 0 ? args[reply + 1] : undefined;
    const [name, ...words] = args.filter((_, index) => reply < 0 || (index !== reply && index !== reply + 1));
    const text = words.join(' ').trim();
    if (!name || !text || (reply >= 0 && !/^\d+$/.test(replyTo ?? ''))) throw new Error('Use master send NAME TEXT or master send NAME --reply MESSAGE-ID TEXT');
    const peer = peers.find(entry => entry.name === name);
    if (!peer) throw new Error(`There is no peer ${name}; add it with master peer add NAME URL --token-file PATH`);
    // A reply goes back under the thread of the message it answers; a new message opens a thread.
    const answered = replyTo ? ((await masterApi('master/messages')).messages as { id: number; thread: string }[]).find(entry => entry.id === Number(replyTo)) : undefined;
    if (replyTo && !answered) throw new Error(`There is no message ${replyTo} to reply to; master status lists them`);
    const thread = answered?.thread ?? randomUUID();
    // The peer stores it first: an unreachable peer fails here and nothing is recorded on either side.
    const sent = await peerCall(peer, 'master/messages', { text, thread });
    const recorded = replyTo ? await masterMutation(`master/messages/${replyTo}/reply`, { text }) : await masterMutation('master/messages', { text, thread, to: name });
    return print({ sent: name, thread, remote: sent.id, ...(replyTo ? { replied: Number(replyTo) } : { id: recorded.id }) });
  }
  return unhandled;
}
