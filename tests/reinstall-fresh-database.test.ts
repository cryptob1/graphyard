import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { UpDependencies, UpEvent, UpRequest } from '../src/up.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1851: a repository reinstalled onto a fresh control-plane database, its install directory kept.
 * The control plane below is simulated: the coordinator's credential stays accepted (it is deployed
 * with the install, as GRAPHYARD_PRINCIPALS), while the operator-agent identity lived
 * in the database and are gone with it. `master init` and `master autonomy` are the real commands.
 */
// Loaded inside the test, so a tree without them fails as a test case, not at load.
const up = () => import('../src/up.js');

const SERVER = 'http://127.0.0.1:4310';
const OPERATOR_TOKEN = '/install/acme-shop/tokens/acme-shop-operator.token';
const ADMIN = 'a'.repeat(40), MASTER = 'm'.repeat(40);
const yieldTurn = () => new Promise<void>(accept => setImmediate(accept));

interface Plane { agents: { id: string; token: string; revoked?: boolean }[] }
/** The control plane: the admin and the coordinator always answer; an operator agent only while its database row exists and is not revoked; anything else is 401. */
const planeFetch = (plane: Plane): typeof fetch => async (input, init) => {
  const path = String(input).replace(`${SERVER}/api/`, ''), bearer = String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const answer = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const agent = plane.agents.find(entry => entry.token === bearer && !entry.revoked);
  if (bearer !== ADMIN && bearer !== MASTER && !agent) return answer({ error: 'A valid Graphyard bearer token is required' }, 401);
  if (path === 'status') return answer(bearer === ADMIN ? { actor: { id: 'acme-shop-operator', role: 'admin' } } : agent ? { actor: { id: agent.id, role: 'operator-agent' } }
    : { actor: { id: 'acme-shop-master', role: 'coordinator' }, repository: 'acme/shop', baseBranch: 'main', githubAppId: 1234 });
  if (path === 'operator-agents' && bearer === ADMIN) { if (body) plane.agents.push({ id: body.id, token: body.token }); return answer(body ? { id: body.id } : plane.agents.map(({ id, revoked }) => ({ id, capabilities: [], scope: {}, revision: 1, ...(revoked ? { revokedAt: '2026-10-16T00:00:00.000Z' } : {}) }))); }
  return answer({ error: 'forbidden' }, 403);
};

/** The checklist all green, as /api/status reports it once everything is installed and the loop runs. */
const green = (loop: boolean) => ({
  github: true, githubRepository: 'acme/shop', appPermissions: { missing: [], installationUrl: 'https://github.com/settings/installations/7' },
  reviewerApps: [{ id: 'claude', appId: 9 }], mergeWriter: { merger: 'github' },
  fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] },
  setup: { protection: 'checks', loop },
});

test('unit:reinstall-reissues-stale-credentials — up re-issues the coordinator and operator-agent credentials an install directory kept from an old database, archives the old cursor beside itself and starts a fresh one; accepted credentials are left alone', async () => {
  const { runUp, recordedCredentialAnswers } = await up();
  const { loadStoredMasterConfig, runAutonomyCommand, setupMaster } = await import('../src/master.js');
  const { daemonStatePath } = await import('../src/daemon/state.js');
  const root = await temporaryDirectory('reinstall-fresh'), credentials = await temporaryDirectory('reinstall-fresh-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/shop.git'], { cwd: root });

  let plane: Plane = { agents: [] };
  const calls: string[][] = [];
  const cursor = async () => daemonStatePath(await loadStoredMasterConfig(root));
  const writeCursor = async (cycle: number) => writeFile(await cursor(), JSON.stringify({ version: 1, url: SERVER, repository: 'acme/shop', cycle }), { mode: 0o600 });
  /**
   * The loop process as it really behaves: it holds the cursor in memory, reads the file only as it
   * starts (a fresh cursor when there is none) and writes its in-memory state as it stops
   * (src/daemon/run.ts persists in its finally block), whatever was done to the file meanwhile.
   */
  let loop: { cycle: number } | null = null;
  const stopLoop = async () => { if (loop) await writeCursor(loop.cycle); loop = null; };
  const startLoop = async () => {
    const text = await readFile(await cursor(), 'utf8').catch(() => null);
    loop = { cycle: text ? JSON.parse(text).cycle : 0 };
    await writeCursor(loop.cycle);
  };
  const cli: UpDependencies['cli'] = async (args, options = {}) => {
    calls.push(args);
    const joined = args.join(' ');
    if (args[0] === 'install' && args.includes('--plan')) return { code: 0, stdout: JSON.stringify({ installId: 'acme-shop', installDirectory: '/install/acme-shop', principals: [{ id: 'acme-shop-operator', role: 'admin', sessionKind: 'human' }, { id: 'acme-shop-master', role: 'coordinator', sessionKind: 'ai' }], preflight: [{ name: 'GitHub CLI', ok: true }] }) };
    if (args[0] === 'install' && args.includes('--apply')) return { code: 0, stdout: JSON.stringify({ ok: true }) };
    if (args[0] === 'master' && args[1] === 'init') {
      assert.equal(options.stdin, MASTER);
      await setupMaster(root, { url: SERVER, token: options.stdin!, cliPath: resolve(import.meta.dirname, '../bin/graphyard.mjs'), credentialDirectory: credentials }, planeFetch(plane));
      return { code: 0, stdout: '{}' };
    }
    if (args[0] === 'master' && args[1] === 'autonomy') {
      await runAutonomyCommand(root, await loadStoredMasterConfig(root), 'autonomy', args.slice(2), { coordinator: async () => ({}), readSecret: async () => options.stdin ?? '', agents: () => [], daemonLock: async () => null, fetcher: planeFetch(plane) });
      return { code: 0, stdout: '{}' };
    }
    if (joined === 'master restart') { await stopLoop(); await startLoop(); return { code: 0, stdout: '{}' }; }
    return { code: 0, stdout: '{}' };
  };
  let clock = 0, stops = 0, admin = true, listingFails = false;
  const fetcher = (): typeof fetch => async (input, init) => listingFails && String(input).endsWith('/api/operator-agents') ? new Response('{}', { status: 503 }) : planeFetch(plane)(input, init);
  const deps = (events: UpEvent[]): UpDependencies => ({
    root, pollMs: 1, emit: event => { events.push(event); }, cli,
    now: () => clock, sleep: async ms => { clock += ms; await yieldTurn(); },
    serverUrl: async () => SERVER, masterToken: async () => MASTER,
    operatorToken: async file => file === OPERATOR_TOKEN && admin ? ADMIN : null,
    status: async () => green(loop !== null),
    credentialAnswers: token => recordedCredentialAnswers(root, SERVER, fetcher(), token),
    stopLoop: async () => { stops++; await stopLoop(); return { unit: null }; },
    publishOnboarding: async () => null
  });
  const request: UpRequest = { repository: 'acme/shop', provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', browserProfile: null };
  const count = (command: string) => { const [first, second] = command.split(' '); return calls.filter(args => args[0] === first && (first === 'install' ? args.includes(second) : args[1] === second)).length; };
  const archives = async () => { const file = await cursor(); return (await readdir(dirname(file))).filter(name => name.startsWith(basename(file).replace(/\.json$/, '.archived-'))); };
  const credential = async () => (await readFile((await loadStoredMasterConfig(root)).operatorAgent!.credentialFile, 'utf8')).trim();

  // The first install, on the first database.
  const first = await runUp(request, deps([]));
  assert.equal(first.exitCode, 0, first.next);
  assert.deepEqual(plane.agents.map(agent => agent.id), ['graphyard-master-shop-operator']);
  const old = { operator: await credential() };
  // The loop ran a long while on it.
  loop!.cycle = 16602; await writeCursor(16602);

  // The database volume is removed and the plane starts on a fresh one: its operator agents are gone.
  plane = { agents: [] };
  assert.deepEqual((await recordedCredentialAnswers(root, SERVER, planeFetch(plane))).map(answer => `${answer.identity} ${answer.status}`), ['coordinator 200', 'operator-agent 401']);
  // The old loop runs on until it is stopped, and writes cycle 16603 from memory as it stops.
  loop!.cycle = 16603;
  const before = { apply: count('install --apply'), init: count('master init'), autonomy: count('master autonomy'), restart: count('master restart') };
  const events: UpEvent[] = [];
  const reinstall = await runUp(request, deps(events));
  assert.equal(reinstall.exitCode, 0, reinstall.next);
  const notes = events.flatMap(event => event.kind === 'note' ? [event.text] : []);
  assert.ok(notes.some(text => /refused the recorded operator-agent credential \(401\): it serves a fresh database, so this run re-issues the coordinator and operator-agent credentials/.test(text)), notes.join('\n'));
  // Re-issued through the bootstrap path: the install, master init (the coordinator) and master autonomy (the operator agent).
  assert.equal(count('install --apply'), before.apply + 1, 'the install runs again');
  assert.equal(count('master init'), before.init + 1, 'the coordinator credential is recorded again by master init');
  assert.equal(count('master autonomy'), before.autonomy + 1, 'master autonomy provisions the agent identities again');
  assert.deepEqual(plane.agents.map(agent => agent.id), ['graphyard-master-shop-operator'], 'the identity exists on the fresh database');
  assert.notEqual(await credential(), old.operator);
  assert.deepEqual((await recordedCredentialAnswers(root, SERVER, planeFetch(plane))).map(answer => answer.status), [200, 200], 'every recorded credential is accepted now');
  // The loop is stopped first, so its shutdown write lands before the archive: the cursor it wrote
  // last (cycle 16603) is archived beside itself, never deleted, and the loop starts on a fresh one.
  const archived = await archives();
  assert.equal(stops, 1, 'the loop is stopped once, before the archive');
  assert.equal(archived.length, 1, archived.join(', '));
  assert.equal(JSON.parse(await readFile(join(dirname(await cursor()), archived[0]), 'utf8')).cycle, 16603, 'the archive holds the stopped loop\'s last write');
  assert.equal(count('master restart'), before.restart + 1);
  assert.deepEqual(loop, { cycle: 0 }, 'the running loop holds a fresh cursor in memory');
  assert.equal(JSON.parse(await readFile(await cursor(), 'utf8')).cycle, 0, 'the loop runs on a fresh cursor');
  // and it stays fresh through the loop's own next restart, which persists the in-memory state.
  await stopLoop(); await startLoop();
  assert.equal(JSON.parse(await readFile(await cursor(), 'utf8')).cycle, 0, 'the old cursor never comes back');
  assert.ok(notes.some(text => /Re-issued the coordinator and operator-agent credentials for the fresh database; the loop started a fresh cursor; the old one \(cycle 16603\) is archived at \S+\.archived-/.test(text)), notes.join('\n'));
  assert.equal(JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8')).reissue, null, 'the re-issue is done');

  // Accepted credentials change nothing: no install, no new credential, no archive, no restart.
  const settled = { calls: calls.length, operator: await credential(), agents: plane.agents.length };
  const quiet: UpEvent[] = [];
  const again = await runUp(request, deps(quiet));
  assert.equal(again.exitCode, 0, again.next);
  assert.deepEqual(calls.slice(settled.calls).filter(args => args[0] === 'install' || ['init', 'autonomy', 'restart'].includes(args[1])), []);
  assert.equal(await credential(), settled.operator);
  assert.equal(plane.agents.length, settled.agents);
  assert.equal((await archives()).length, 1);
  assert.equal(stops, 1);
  assert.equal(JSON.parse(await readFile(await cursor(), 'utf8')).cycle, 0);
  assert.ok(!quiet.some(event => event.kind === 'note' && /fresh database/.test(event.text)));

  // A revoked identity also draws 401, but the plane still lists it: its database is not fresh, so nothing is re-issued.
  plane.agents.find(agent => agent.id === 'graphyard-master-shop-operator')!.revoked = true;
  const revoked: UpEvent[] = [];
  const kept = { calls: calls.length, operator: await credential() };
  const afterRevoke = await runUp(request, deps(revoked));
  assert.equal(afterRevoke.exitCode, 0, afterRevoke.next);
  assert.deepEqual(calls.slice(kept.calls).filter(args => args[0] === 'install' || ['init', 'autonomy', 'restart'].includes(args[1])), []);
  assert.equal(await credential(), kept.operator);
  assert.equal(stops, 1); assert.equal((await archives()).length, 1);
  assert.ok(revoked.some(event => event.kind === 'note' && /refused the recorded operator-agent credential \(401\) but still lists the identity: its database is not fresh/.test(event.text)), JSON.stringify(revoked));

  // With no admin credential, or a failed listing, the revoked identity's absence is unknown: nothing
  // is re-issued and up.json keeps its steps, so the run after the listing answers again still sees it listed.
  const upState = async () => JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8'));
  for (const [noAdmin, fails, why] of [[true, false, /admin credential is not on this machine/], [false, true, /GET \/api\/operator-agents failed/]] as const) {
    admin = !noAdmin; listingFails = fails;
    const blind: UpEvent[] = [], kept = { calls: calls.length, state: await upState() };
    await runUp(request, deps(blind));
    assert.deepEqual(calls.slice(kept.calls).filter(args => args[0] === 'install' || ['init', 'autonomy', 'restart'].includes(args[1])), []);
    assert.equal((await upState()).reissue ?? null, null); assert.deepEqual((await upState()).completed, kept.state.completed);
    assert.equal((await upState()).goal ?? null, kept.state.goal ?? null); assert.equal((await upState()).onboardingWork ?? null, kept.state.onboardingWork ?? null);
    assert.ok(blind.some(event => event.kind === 'note' && /refused the recorded operator-agent credential \(401\), but its operator-agent listing could not be read/.test(event.text) && why.test(event.text)), JSON.stringify(blind));
    assert.equal(stops, 1); assert.equal((await archives()).length, 1);
  }
  admin = true; listingFails = false;
  const recovered: UpEvent[] = [], kept2 = calls.length;
  assert.equal((await runUp(request, deps(recovered))).exitCode, 0);
  assert.deepEqual(calls.slice(kept2).filter(args => args[0] === 'install' || ['init', 'autonomy', 'restart'].includes(args[1])), []);
  assert.ok(recovered.some(event => event.kind === 'note' && /still lists the identity: its database is not fresh/.test(event.text)), JSON.stringify(recovered));
});

/**
 * A self-contained host install: its loop runs on the host under its user unit, never on this machine.
 * The host below is simulated: an in-memory file system behind the install's Transport, with the
 * loop unit running and holding its cursor in memory, writing it again as systemd stops it.
 */
const fakeHost = (checkout: string, unit: string, cursor: string) => {
  // master init and master autonomy ran here, in the host's checkout: the master's identities and their credential files are on the host only.
  const config = { credentialFile: cursor.replace(/\.daemon\.json$/, '.token'), operatorAgent: { id: 'graphyard-master-shop-operator', credentialFile: `${checkout}/.graphyard/operator-agent.token` } };
  const files = new Map<string, string>([[`${checkout}/.graphyard/master.json`, JSON.stringify(config)], [config.credentialFile, `${MASTER}\n`]]);
  const commands: string[] = [];
  let loop: { cycle: number } | null = null;
  const start = () => { const text = files.get(cursor); loop = { cycle: text ? JSON.parse(text).cycle : 0 }; files.set(cursor, JSON.stringify({ cycle: loop.cycle })); };
  const stop = () => { if (loop) files.set(cursor, JSON.stringify({ cycle: loop.cycle })); loop = null; };
  const transport = {
    description: 'fake host',
    putFile: async () => {},
    exec: async (program: string, args: string[]) => {
      // asUser runs `runuser -u graphyard -- sh -c SCRIPT CWD PROGRAM ARGS...`.
      const [command, ...rest] = program === 'runuser' ? args.slice(args.indexOf('-c') + 3) : [program, ...args];
      commands.push([command, ...rest].join(' '));
      if (command === 'cat') { const text = files.get(rest[0]); return text === undefined ? { stdout: '', stderr: `cat: ${rest[0]}: No such file or directory`, code: 1 } : { stdout: text, stderr: '', code: 0 }; }
      if (command === 'systemctl' && rest[1] === 'stop' && rest[2] === unit) { stop(); return { stdout: '', stderr: '', code: 0 }; }
      if (command === 'systemctl' && rest[1] === 'start' && rest[2] === unit) { start(); return { stdout: '', stderr: '', code: 0 }; }
      if (command === 'mv') { const [from, to] = rest.filter(arg => !arg.startsWith('-')); files.set(to, files.get(from)!); files.delete(from); return { stdout: '', stderr: '', code: 0 }; }
      return { stdout: '', stderr: `unexpected ${command}`, code: 127 };
    },
  };
  return { files, commands, transport, start, config, get loop() { return loop; }, set cycle(value: number) { loop!.cycle = value; } };
};

