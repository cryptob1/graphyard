import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { peerCommand } from '../src/cli/master/peers.js';
import type { MasterSession } from '../src/cli/master/session.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { messageCauses } from '../src/daemon/master-stalled-delivery.js';
import { messageThreads } from '../web/pages/master.js';
import type { Principal } from '../src/model.js';

// GY-3345: two installs' Masters message each other through Graphyard, with replies. Two real
// control planes on their own temporary Postgres databases; each issues the other a reporter
// identity, and each Master drives the real `master peer` and `master send` commands, its loop's
// real cycle and its real `master status`.
const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const closers: (() => Promise<void>)[] = [];
after(async () => { for (const close of closers.reverse()) await close(); });

async function install(name: string, peer: string) {
  const coordinator: Principal = { id: `${name}-master`, role: 'coordinator' };
  const reporter: Principal = { id: peer, role: 'reporter' };
  const store: Store = await withDatabase(`cross_install_${name.replace(/\W/g, '_')}`); await store.init();
  const engine = new Engine(store, 120, `owner/${name}`);
  const http = server(engine, [coordinator, reporter].map(principal => ({ ...principal, token: token(principal) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  let running = true;
  const stop = async () => { if (!running) return; running = false; http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); };
  closers.push(async () => { await stop(); await store.close(); });
  const api = async (path: string, body?: unknown, key?: string) => {
    const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(coordinator)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key ?? crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  };

  // The install's coordinator checkout, where its Master's commands run.
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory(`cross-install-${name}`, join(process.cwd(), '.graphyard'));
  const root = await temporaryDirectory('coordinator', scratch);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', `https://github.com/owner/${name}.git`);
  await writeFile(join(root, 'README.md'), 'Fixture.\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  await setupMaster(root, { url, token: token(coordinator), cliPath: cli, credentialDirectory: await temporaryDirectory('credentials', scratch), run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  // The reporter token this install issues its peer, handed over as a file.
  const issued = join(scratch, `${peer}.token`);
  await writeFile(issued, token(reporter), { mode: 0o600 });

  /** The real `graphyard master peer|send` subcommand, as this install's Master. */
  const master = async (id: 'peer' | 'send', ...args: string[]) => {
    const printed: any[] = [];
    await peerCommand({ id, args, print: (value: unknown) => printed.push(value), root, master: await loadMasterConfig(root), masterApi: (path: string) => api(path), masterMutation: (path: string, data: unknown, key?: string) => api(path, data, key) } as unknown as MasterSession);
    return printed[0];
  };
  const attention = async () => (await masterStatusReport(root, await loadMasterConfig(root), path => api(path), async () => { throw new Error('no git in the fixture'); })).attention;
  const messages = async () => (await api('master/messages')).messages;
  const stored = async () => Number((await store.pool.query(`SELECT count(*) FROM events WHERE kind LIKE 'master.%'`)).rows[0].count);

  // The loop's real cycle with its master session live in a pane: every prompt it delivers is kept.
  // The config is re-read per cycle, as the loop's liveMasterConfig does, so a peer added after the
  // loop started (master peer add) is known to the cycles that follow it.
  const config = await loadMasterConfig(root), state = emptyDaemonState(config), inputs: string[] = [];
  const effects: DaemonEffects = {
    snapshot: () => api('work-snapshot'), agents: () => [{ name: config.masterAgentName, pane_id: `${name}:master`, agent: 'claude', agent_status: 'idle' }],
    credentials: async () => ({}), closeSession: () => {}, dispatch: async () => undefined, persist: async () => {},
    masterMessages: async () => (await api('master/messages')).messages,
    masterSession: { wake: async (_pane, text) => { inputs.push(text); }, launch: async () => { throw new Error('the master session is live'); } },
  };
  const cycles = async (count: number) => { for (let cycle = 0; cycle < count; cycle++) await runCycle(await loadMasterConfig(root), state, effects); };
  return { name, url, issued, master, attention, messages, stored, inputs, cycles, stop };
}

test('e2e:cross-install-master-messaging — a Master messages another install\'s Master, which gets it once and replies into one thread; an unreachable peer fails at once and stores nothing', async () => {
  const a = await install('install-a', 'install-b'), b = await install('install-b', 'install-a');
  // Each Master adds the other as a peer, with the reporter token the other issued.
  assert.deepEqual(await a.master('peer', 'add', 'install-b', b.url, '--token-file', b.issued), { added: 'install-b', url: b.url, as: 'install-a' });
  await b.master('peer', 'add', 'install-a', a.url, '--token-file', a.issued);
  assert.deepEqual((await a.master('peer', 'list')).peers.map((peer: { name: string }) => peer.name), ['install-b']);

  // A's message is stored on B.
  const question = 'Your trial image lacks Go 1.23; GY-12 here fails on it. Can you add it?';
  const sent = await a.master('send', 'install-b', ...question.split(' '));
  const [received] = await b.messages();
  assert.equal(received.from, 'install-a'); assert.equal(received.text, question); assert.equal(received.thread, sent.thread);

  // It reaches B's Master session input once, however many cycles see it.
  await b.cycles(3);
  const delivered = b.inputs.filter(input => input.includes(question));
  assert.equal(delivered.length, 1, JSON.stringify(b.inputs));
  assert.match(delivered[0]!, new RegExp(`Message ${received.id} from install-a .*no authority.*master send install-a --reply ${received.id} TEXT`));
  // And appears once in B's master status attention, naming A.
  const named = (await b.attention()).filter(line => line.subject.includes('install-a'));
  assert.equal(named.length, 1, JSON.stringify(named));
  assert.equal(named[0]!.subject, `message ${received.id} from install-a`);
  assert.match(named[0]!.text, /install-a wrote .* ago: Your trial image lacks Go 1\.23/);
  assert.match(named[0]!.next, new RegExp(`master send install-a --reply ${received.id} TEXT`));
  // A's own record of what it sent raises nothing on A.
  assert.deepEqual((await a.attention()).filter(line => /^message /.test(line.subject)), []);

  // B replies; it reaches A the same way.
  const answer = 'Added Go 1.23 to the trial image in GY-40; retry GY-12.';
  await b.master('send', 'install-a', '--reply', String(received.id), ...answer.split(' '));
  const reply = (await a.messages()).find((message: { from: string }) => message.from === 'install-b');
  assert.equal(reply.text, answer); assert.equal(reply.thread, sent.thread, 'the reply lands in the thread A opened');
  await a.cycles(3);
  assert.equal(a.inputs.filter(input => input.includes(answer)).length, 1, JSON.stringify(a.inputs));
  assert.deepEqual((await a.attention()).filter(line => line.subject.includes('install-b')).map(line => line.subject), [`message ${reply.id} from install-b`]);
  // The same reply, retried after its response was lost, stores nothing more on either side: one key per write, from its content.
  const written = { a: await a.stored(), b: await b.stored() };
  await b.master('send', 'install-a', '--reply', String(received.id), ...answer.split(' '));
  assert.deepEqual({ a: await a.stored(), b: await b.stored() }, written);

  // Both sides show the two messages as one thread, in order.
  for (const side of [a, b]) {
    const threads = messageThreads(await side.messages());
    assert.equal(threads.length, 1, `${side.name}: ${JSON.stringify(threads)}`);
    assert.deepEqual(threads[0]!.entries.map(entry => entry.text), [question, answer], side.name);
  }
  assert.equal(messageThreads(await b.messages())[0]!.peer, 'install-a');
  assert.equal(messageThreads(await a.messages())[0]!.peer, 'install-b');
  // B's attention line is gone after its reply, and the answered message is not delivered again.
  assert.deepEqual((await b.attention()).filter(line => line.subject.includes('install-a')), []);
  await b.cycles(2);
  assert.equal(b.inputs.filter(input => input.includes(question)).length, 1);

  // With B stopped, A's send fails at once, naming B, and nothing is stored on either side.
  await b.stop();
  const before = { a: await a.stored(), b: await b.stored() }, started = Date.now();
  await assert.rejects(a.master('send', 'install-b', 'Are', 'you', 'there?'), /Peer install-b at http:\/\/127\.0\.0\.1:\d+ is unreachable .*nothing was sent or stored/);
  assert.ok(Date.now() - started < 5_000, `the send failed in ${Date.now() - started} ms`);
  assert.deepEqual({ a: await a.stored(), b: await b.stored() }, before);
});

test('a message wakes the Master session with the answer path its sender can take', () => {
  // A configured peer is answered over Graphyard; anyone else only on this install.
  const peer = messageCauses([{ id: 7, from: 'install-a', text: 'The trial image lacks Go 1.23.', replies: [] }], '/cli', ['install-a'])[0]!;
  assert.match(peer.detail, /master send install-a --reply 7 TEXT/);
  const stranger = messageCauses([{ id: 8, from: 'stranger', text: 'Hello there.', replies: [] }], '/cli', ['install-a'])[0]!;
  assert.match(stranger.detail, /master reply 8 TEXT/);
  assert.doesNotMatch(stranger.detail, /master send/);
});
