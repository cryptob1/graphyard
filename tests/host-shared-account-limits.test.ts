import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import { recordObservedExhaustion, selectAccount } from '../src/master/environments.js';
import { endRegistrySessionById } from '../src/master/registry-slot.js';
import { hostAccountExhaustion, hostAccountSessions, hostAccountsVariable, type HostAccountSession } from '../src/host-accounts.js';
import type { MasterConfig } from '../src/master/profiles.js';
import type { Principal } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';

// GY-3333: one machine runs several Graphyard installs that share the same login homes, and each
// counted an account's live sessions and quota holds only for itself — the core and hwd-backend
// installs on rexera-remote could run one Claude account at once, and a limit one observed was news
// to the other. The login home is now a host-level resource: every install registers its live
// session beside the home (the kernel drops the record when its launcher process dies), reads every
// install's sessions before choosing, and records an exhaustion it marks there until the time. Each
// install keeps its own registry and roles; an install alone on the host is unaffected.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const token = (install: number) => `${coordinator.id}-token-${install}-${'x'.repeat(24)}`;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const hostId = 'shared-host';
const now = () => new Date().toISOString();

interface Install { root: string; config: MasterConfig; registry: AgentRegistry; server: ReturnType<typeof server>; store: Store; url: string }
const installs: Install[] = [];
let scratch: string, home: string, holder: ChildProcess | undefined, held: { account: string; session: string } | undefined;

before(async () => {
  const store1 = await withDatabase('host-shared-1'), store2 = await withDatabase('host-shared-2');
  await store1.init(); await store2.init();
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  scratch = await temporaryDirectory('host-shared-account-limits', join(process.cwd(), '.graphyard'));
  // The one shared login home every install's registry names, and the host-level records beside it.
  home = await temporaryDirectory('claude-a', scratch);
  await writeFile(join(home, 'auth.json'), JSON.stringify({ fixture: 'login' }), { mode: 0o600 });
  process.env[hostAccountsVariable] = await temporaryDirectory('host-accounts', scratch);
  for (const [index, repository] of ['owner/one', 'owner/two'].entries()) {
    const store = index === 0 ? store1 : store2;
    const engine = new Engine(store, 120, repository);
    const http = server(engine, [{ ...coordinator, token: token(index + 1) }]);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const root = await temporaryDirectory(index === 0 ? 'one' : 'two', scratch);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', `https://github.com/${repository}.git`);
    await writeFile(join(root, 'README.md'), 'Fixture.\n');
    git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
    const credentials = await temporaryDirectory(index === 0 ? 'credentials-one' : 'credentials-two', scratch);
    await setupMaster(root, { url, token: token(index + 1), cliPath: launcher, hostId, credentialDirectory: credentials, run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
    installs.push({ root, config: await loadMasterConfig(root), registry: new AgentRegistry(store), server: http, store, url });
    // One account on the shared home, limited to a single session — the limit every install on the host counts.
    await installs[index]!.registry.mutate(coordinator, 'apply', {
      runtimes: [{ name: 'sharedkit', launch: { kind: 'sharedkit', args: [], environment: { HOME: home }, homeVariable: 'RUNTIME_HOME', modelFlag: null, login: null, loginFile: 'auth.json' } }],
      models: [{ name: 'fixture', id: 'fixture-model' }],
      accounts: [{ name: 'shared-a', runtime: 'sharedkit', model: 'fixture', credential: { host: hostId, home }, enabled: true, maxSessions: 1 }],
      roles: [{ name: 'worker', accounts: ['shared-a'], concurrency: 4 }],
      reason: 'fixture host-shared fleet' }, randomUUID());
  }
});

after(async () => {
  if (holder && holder.exitCode === null && holder.signalCode === null) { holder.kill('SIGKILL'); await once(holder, 'exit').catch(() => {}); }
  for (const install of installs) {
    await new Promise<void>(resolve => { install.server.closeAllConnections?.(); install.server.close(() => resolve()); });
    await install.store.close();
  }
});

/** One install's executor asks its own registry for a worker session, as every launch does. */
const select = async (install: number) => selectAccount(installs[install]!.config, 'worker', { name: 'launch' });
/** The registry session a selection was recorded under. */
const sessionOf = (selected: Awaited<ReturnType<typeof select>>) => selected.account && 'fleet' in selected.account ? selected.account.fleet.session : null;
/** The install a registry's account views and refusals are read back through. */
const fleet = async (install: number) => installs[install]!.registry.snapshot(hostId);
async function until<T>(what: string, read: () => Promise<T | null | undefined | false>): Promise<T> {
  for (let tries = 0; tries < 600; tries++) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  assert.fail(`never: ${what}`);
}

/** Install one holds a worker session on the shared account from a process of its own, ready to be killed. */
async function holdFromChild(): Promise<{ account: string; session: string }> {
  const ready = join(scratch, 'holder-ready.jsonl');
  await writeFile(ready, '');
  holder = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/host-account-holder.ts', import.meta.url)),
    JSON.stringify({ root: installs[0]!.root, ready })], { stdio: ['ignore', 'ignore', 'pipe'] });
  const errors: string[] = [];
  holder.stderr!.on('data', (chunk: Buffer) => errors.push(chunk.toString()));
  return until('the holder process selected its session', async () => {
    const text = (await readFile(ready, 'utf8')).trim();
    if (text) return JSON.parse(text.split('\n').at(-1)!) as { account: string; session: string };
    if (holder!.exitCode !== null || holder!.signalCode !== null) throw new Error(`the holder process exited: ${errors.join('')}`);
    return null;
  });
}

test('e2e:host-shared-account-limits — an install alone on the host is unaffected', async () => {
  const alone = await select(1);
  assert.equal(alone.account!.name, 'shared-a');
  assert.deepEqual((await hostAccountSessions(home)).map(session => session.install), ['owner/two'], 'only its own session holds the account');
  await alone.release!('the lone install selected and released');
  assert.deepEqual(await hostAccountSessions(home), [], 'the record went with the session');
});

test('e2e:host-shared-account-limits — a live session of the first install holds the account in the second, which names the holder', async () => {
  held = await holdFromChild();
  assert.equal(held.account, 'shared-a');
  const sessions: HostAccountSession[] = await hostAccountSessions(home);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.install, 'owner/one');
  // The second install's own selection passes the account over: one home, one session, every install counted.
  await assert.rejects(select(1), (error: Error) => {
    assert.match(error.message, /shared-a is at its session limit \(1 of 1 live, 1 held by the Graphyard install owner\/one\)/);
    return true;
  });
  // And its registry names the other install as the holder, in the refusal it recorded.
  const refusal = (await fleet(1)).refusals.at(-1)!;
  assert.match(refusal.reason, /held by the Graphyard install owner\/one/);
  assert.ok(refusal.skipped.some(entry => entry.account === 'shared-a'));
});

test('e2e:host-shared-account-limits — killing the holder releases the account at once, and so does ending its session', async () => {
  const killed = holder!;
  killed.kill('SIGKILL');
  await once(killed, 'exit');
  // The kernel dropped the record with the process: the second install selects the account, and the
  // dead record is reaped rather than counted.
  const taken = await select(1);
  assert.equal(taken.account!.name, 'shared-a');
  await taken.release!('the second install took the freed account');
  // The first install's registry session outlived its launcher; the sweep ends it the same way, and
  // the install can select its own account again.
  await endRegistrySessionById(installs[0]!.config, held!.session, 'the launcher process was killed');
  const again = await select(0);
  assert.equal(again.account!.name, 'shared-a');
  const sessions = await hostAccountSessions(home);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.install, 'owner/one');
  await assert.rejects(select(1), /held by the Graphyard install owner\/one/);
  await endRegistrySessionById(installs[0]!.config, sessionOf(again)!, 'the session ended');
  assert.deepEqual(await hostAccountSessions(home), [], 'the ended session cleared its host record');
  const next = await select(1);
  assert.equal(next.account!.name, 'shared-a');
  await next.release!('the account was free again');
});

test('e2e:host-shared-account-limits — an exhaustion one install marks until a time is ineligible in the other until that time', async () => {
  const until = new Date(Date.now() + 2_500).toISOString();
  await recordObservedExhaustion(installs[0]!.config, 'shared-a', { at: now(), resetsAt: until, reason: 'fixture limit notice: the shared plan is spent', role: 'worker', profile: 'launch', work: null }, Date.now(), {});
  assert.equal(hostAccountExhaustion(home)!.by, 'owner/one');
  // The other install reads the hold beside the home: its selection is refused, its registry records
  // the exhaustion with its reset, and the holder is named.
  await assert.rejects(select(1), (error: Error) => {
    assert.match(error.message, /shared-a is held exhausted until \S+ by the Graphyard install owner\/one: fixture limit notice/);
    assert.match(error.message, /quota is exhausted/);
    return true;
  });
  const account = (await fleet(1)).accounts.find(entry => entry.name === 'shared-a')!;
  assert.equal(account.quota, 'exhausted');
  assert.equal(account.resetsAt, until);
  assert.equal(account.eligible, false);
  // Past the time, the hold is over: the account is selectable in the second install again.
  await delay(2_700);
  const recovered = await select(1);
  assert.equal(recovered.account!.name, 'shared-a');
  await recovered.release!('the hold expired');
});
