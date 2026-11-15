// Concern: `graphyard master peer` and `master send` — this Master messaging another install's Master through Graphyard (GY-3345), and issuing a peer install on this host its reporter identity from this session (GY-3385).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { atomicPrivateText, atomicPrivateWrite, loadStoredMasterConfig, readCredentialFile } from '../../master/config.js';
import { peerTokenDirectory } from '../../master/confinement.js';
import { masterConfigSchema } from '../../master/profiles.js';
import { unhandled, type MasterSession } from './session.js';

type Peer = NonNullable<import('../../master/profiles.js').MasterConfig['peers']>[number];

/** One write's Idempotency-Key, from what it writes: a send retried after its response was lost replays the stored copy instead of storing a second. */
const keyOf = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 36);

/** One call to a peer install as the reporter identity it issued this one; an unreachable or refusing peer is named. */
async function peerCall(peer: Peer, path: string, body?: unknown) {
  const token = await readCredentialFile(peer.tokenFile);
  let response: Response;
  try {
    response = await fetch(`${peer.url.replace(/\/+$/, '')}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(body === undefined ? {} : { 'Idempotency-Key': keyOf(body) }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
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

/** An install's config directory — the one holding its `masters` credentials — from its master.json credential path. */
const installDirectoryOf = (credentialFile: string) => dirname(dirname(resolve(credentialFile)));

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
    // GY-3385: from this Master's own session, issue another install on this host its reporter
    // identity — minted through the control plane, placed under that install's config directory
    // with mode 0600 — and record the peer here. Its Master records its own side the same way.
    if (verb === 'issue') {
      const at = args.indexOf('--root'), given = at >= 0 ? args[at + 1] : undefined;
      if (!given) throw new Error('Use master peer issue --root DIR, where DIR is the peer install\'s coordinator checkout on this host');
      const peerRoot = resolve(given);
      if (peerRoot === resolve(root)) throw new Error('That is this install\'s own checkout; master peer issue peers another install on this host');
      let stored: { url?: unknown; repository?: unknown; credentialFile?: unknown };
      try { stored = JSON.parse(await readFile(resolve(peerRoot, '.graphyard/master.json'), 'utf8')); }
      catch { throw new Error(`${peerRoot} holds no readable .graphyard/master.json; name another install's coordinator checkout on this host`); }
      const peerName = typeof stored.repository === 'string' ? basename(stored.repository) : '';
      if (typeof stored.url !== 'string' || !/^https?:\/\//.test(stored.url) || !/^[\w.-]{1,60}$/.test(peerName) || typeof stored.credentialFile !== 'string' || !isAbsolute(stored.credentialFile))
        throw new Error(`${peerRoot}/.graphyard/master.json does not name another install's control plane URL, repository and credential file`);
      const myName = basename(master.repository), mine = installDirectoryOf(master.credentialFile), theirs = installDirectoryOf(stored.credentialFile);
      // The entry is recorded before anything is minted or placed: its configDirectory is what a
      // later launch of this session grants writable, so a first run from a session launched
      // before the peer existed still earns the grant the rerun writes the token under.
      await savePeers(root, [...peers.filter(peer => peer.name !== peerName), { name: peerName, url: stored.url, tokenFile: join(peerTokenDirectory(mine), `${peerName}.token`), configDirectory: theirs }]);
      const minted = await masterMutation('reporter-identities', { id: peerName }) as { id: string; token: string };
      const tokenFile = join(peerTokenDirectory(theirs), `${myName}.token`);
      try { await atomicPrivateText(tokenFile, minted.token); }
      catch (error) {
        throw new Error(`The reporter token for ${peerName} could not be placed at ${tokenFile} (${error instanceof Error ? error.message : String(error)}). The peer is recorded; a master session's confinement grants a peer's directory only once master.json names it, so close this master pane (the loop relaunches the session granted) and rerun master peer issue --root ${peerRoot}`);
      }
      return print({ issued: peerName, url: stored.url, reporter: minted.id, tokenFile, next: `Its Master records this side from its own session: master peer issue --root ${resolve(root)}` });
    }
    const tokenFile = args[args.indexOf('--token-file') + 1];
    if (verb !== 'add' || !name || !url || !args.includes('--token-file') || !tokenFile) throw new Error('Use master peer add NAME URL --token-file PATH, master peer issue --root DIR, master peer list or master peer remove NAME');
    const peer = { name, url, tokenFile: isAbsolute(tokenFile) ? tokenFile : resolve(tokenFile) };
    // The token must be a reporter identity on that install: the one role that lets this Master message its Master.
    const status = await peerCall(peer, 'status');
    if (status.actor?.role !== 'reporter') throw new Error(`The token for peer ${name} is ${status.actor?.role ?? 'no'} identity on ${url}; ask that install for a reporter (on this host its Master runs master peer issue --root <this checkout>, elsewhere principal add ID --role reporter)`);
    await savePeers(root, [...peers.filter(entry => entry.name !== name), peer]);
    return print({ added: name, url, as: status.actor.id });
  }
  if (id === 'send') {
    const reply = args.indexOf('--reply'), replyTo = reply >= 0 ? args[reply + 1] : undefined;
    const [name, ...words] = args.filter((_, index) => reply < 0 || (index !== reply && index !== reply + 1));
    const text = words.join(' ').trim();
    if (!name || !text || (reply >= 0 && !/^\d+$/.test(replyTo ?? ''))) throw new Error('Use master send NAME TEXT or master send NAME --reply MESSAGE-ID TEXT');
    const peer = peers.find(entry => entry.name === name);
    if (!peer) throw new Error(`There is no peer ${name}; add it with master peer add NAME URL --token-file PATH, or issue its identity with master peer issue --root DIR`);
    if (!existsSync(peer.tokenFile)) throw new Error(`The token file for peer ${name} is not there (${peer.tokenFile}); its Master issues it with master peer issue --root ${resolve(root)}`);
    // A reply goes back under the thread of the message it answers; a new message opens a thread.
    const answered = replyTo ? ((await masterApi('master/messages')).messages as { id: number; thread: string }[]).find(entry => entry.id === Number(replyTo)) : undefined;
    if (replyTo && !answered) throw new Error(`There is no message ${replyTo} to reply to; master status lists them`);
    const thread = answered?.thread ?? randomUUID();
    // The peer stores it first: an unreachable peer fails here and nothing is recorded on either side.
    const sent = await peerCall(peer, 'master/messages', { text, thread });
    // The local record of what was sent answers a retry the same way: one key per write, from its content.
    const record = replyTo ? { path: `master/messages/${replyTo}/reply`, data: { text } } : { path: 'master/messages', data: { text, thread, to: name } };
    const recorded = await masterMutation(record.path, record.data, keyOf(record));
    return print({ sent: name, thread, remote: sent.id, ...(replyTo ? { replied: Number(replyTo) } : { id: recorded.id }) });
  }
  return unhandled;
}
