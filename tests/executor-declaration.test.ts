import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { claimAction, renewClaim, settleAction, type ActionRow } from '../src/model/actions.js';
import { MERGE_PROTOCOL } from '../src/protocol-version.js';
import { executorDeclarationFile, readExecutorDeclaration } from '../src/repository-setup.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2164: GY-1981 removed the verify-deployment action kind, and a host whose
// .graphyard/executors.json still listed it crash-looped every executor slot: the strict
// z.enum rejected the whole kinds array and readExecutorDeclaration threw, so no slot on the
// host started and nothing dispatched for hours. Two proofs, one test each: a declaration
// naming a kind the code removed is read with only the known kinds, and a slot started from
// it runs and claims instead of exiting (unit:executor-declaration-drops-removed-kind); a
// declaration whose kinds are all unknown is read as kinds: null, every kind the executor
// handles (unit:executor-declaration-all-unknown-kinds).

const repository = 'owner/project';
const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'bin/graphyard.mjs');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const readBody = (req: IncomingMessage) => new Promise<string>(resolve => { let text = ''; req.on('data', chunk => text += chunk); req.on('end', () => resolve(text)); });
const json = (res: ServerResponse, status: number, body: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
const until = async (predicate: () => boolean, what: string, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await delay(100); }
};

/** A coordinator checkout whose executor declaration a host wrote by hand: master.json, its credential, and the shipped scripts linked in. */
async function coordinatorCheckout(url: string, kinds: string[]) {
  const checkout = await temporaryDirectory('executor-declaration');
  const credentials = await temporaryDirectory('executor-declaration-credentials');
  git(checkout, 'init', '-q'); git(checkout, 'remote', 'add', 'origin', `https://github.com/${repository}.git`);
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(join(checkout, '.graphyard'), { mode: 0o700 });
  await writeFile(join(checkout, '.graphyard/master.json'), JSON.stringify({ version: 1, url, credentialFile, cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234, hostId: 'unit-host', masterAgentName: 'graphyard-master-unit', autoMerge: true, mergeMethod: 'merge', workers: [], run: {} }), { mode: 0o600 });
  // Written by hand, or by an older checkout, never through writeExecutorDeclaration — so an
  // unknown kind reaches the reader exactly as it reached the crash-looping slots.
  await writeFile(join(checkout, executorDeclarationFile), `${JSON.stringify({ version: 1, count: 1, kinds, intervalSeconds: 1 }, null, 2)}\n`, { mode: 0o600 });
  // The script imports its TypeScript neighbours relative to its own real path, so the shipped
  // scripts directory is linked in rather than copied.
  await symlink(join(root, 'scripts'), join(checkout, 'scripts'));
  await symlink(join(root, 'examples'), join(checkout, 'examples'));
  return { checkout, credentials };
}

/** The control plane a slot needs: one pending resync row, and the claim, renew, settle and resync routes. */
function fakeControlPlane() {
  const now = () => new Date();
  const row: ActionRow = { id: 'a'.repeat(32), kind: 'resync', work: 'work-1', key: 'GY-1', inputs: { kind: 'resync', pr: null, sha: null, baseSha: null, baseTip: null, observedAt: null }, gate: 'build', refusal: 'Pull request has not been independently observed', reason: 'GY-1 needs a fresh provider reading', binding: 'resync:none', requestedBy: 'graphyard', requestedAt: now().toISOString(), state: 'pending', claim: null, attempts: 0, history: [] };
  const work = { id: 'work-1', key: 'GY-1', title: 'Fixture', stage: 'build', actionQueue: { actions: [row], history: [] } } as unknown as Work;
  const claims: { executor: string; host: string; kinds: string[]; serves: string[] }[] = [];
  const settled: string[] = [];
  const http = createServer(async (req, res) => {
    const path = req.url ?? '';
    if (req.method === 'GET' && path === '/api/status') return json(res, 200, { actor: { id: 'master', role: 'coordinator' }, repository, baseBranch: 'main', githubAppId: 1234, build: { commit: null, protocol: MERGE_PROTOCOL } });
    if (req.method === 'GET' && path === '/api/work-snapshot') return json(res, 200, { now: now().toISOString(), work: [work] });
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
    try {
      if (path === '/api/actions/claim') {
        claims.push({ executor: body.executor, host: body.host, kinds: body.kinds, serves: body.serves });
        const claimed = claimAction([work], { id: body.executor ?? 'master', host: body.host, principal: 'master' }, now(), { kinds: body.kinds, leaseMs: 60_000 });
        return json(res, 200, { action: claimed?.row ?? null, open: claimed ? 0 : 1, at: now().toISOString() });
      }
      const renew = /^\/api\/actions\/([0-9a-f]{32})\/renew$/.exec(path), settle = /^\/api\/actions\/([0-9a-f]{32})\/settle$/.exec(path);
      if (renew) return json(res, 200, renewClaim(work, renew[1], { executor: body.executor ?? 'master', principal: 'master' }, now(), 60_000));
      if (settle) { settled.push(String(body.result)); return json(res, 200, { action: settleAction(work, settle[1], { executor: body.executor ?? 'master', principal: 'master' }, body.result, body.reason, now()).action }); }
      if (path === '/api/work/work-1/resync') return json(res, 200, { observed: true });
      return json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
  });
  return { http, claims, settled };
}

test('unit:executor-declaration-drops-removed-kind — readExecutorDeclaration keeps only the kinds the running code knows, and a slot started from the declaration runs and claims instead of exiting', async () => {
  const plane = fakeControlPlane();
  await new Promise<void>(resolve => plane.http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(plane.http.address() as { port: number }).port}`;
  const { checkout, credentials } = await coordinatorCheckout(url, ['resync', 'verify-deployment']);
  // The read survives the removed kind: the known kind is kept, the removed one is dropped.
  const declaration = await readExecutorDeclaration(checkout);
  assert.deepEqual(declaration, { version: 1, count: 1, kinds: ['resync'], intervalSeconds: 1 });
  const env = { ...process.env, NOTIFY_SOCKET: '', GRAPHYARD_EXECUTOR_UNIT: '', GRAPHYARD_CHECKOUT_ROOT: '', GRAPHYARD_TOKEN: '', GRAPHYARD_TOKEN_FILE: '', GRAPHYARD_URL: '' };
  const log: string[] = [];
  const slot = spawn(process.execPath, [join(checkout, 'scripts/graphyard-executor.mjs'), '--slot', '1'], { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'] });
  slot.stdout.on('data', chunk => log.push(String(chunk)));
  slot.stderr.on('data', chunk => log.push(String(chunk)));
  try {
    // The slot starts — past the declaration read and the runnable-kind check — serving the kind the code knows.
    await until(() => log.join('').includes('serving resync every 1s as slot 1'), `the slot to start on a declaration naming a removed kind\n${log.join('')}`);
    await until(() => plane.claims.length > 0, `the slot to claim\n${log.join('')}`);
    assert.deepEqual(plane.claims[0].serves, ['resync'], `the slot serves only what the code runs; the removed name reached nothing\n${log.join('')}`);
    await until(() => plane.settled.includes('done'), `the claimed resync to run to a settlement\n${log.join('')}`);
    assert.equal(slot.exitCode, null, `the slot is running, not exited\n${log.join('')}`);
  } finally {
    slot.kill('SIGTERM');
    await until(() => slot.exitCode !== null || slot.signalCode !== null, 'the slot to stop', 15_000);
    await new Promise<void>(resolve => plane.http.close(() => resolve()));
    await rm(checkout, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true });
  }
});

test('unit:executor-declaration-all-unknown-kinds — a declaration whose kinds are all unknown is read as kinds: null, every kind the executor handles', async () => {
  const { checkout, credentials } = await coordinatorCheckout('http://127.0.0.1:9', ['verify-deployment', 'another-removed-kind']);
  try {
    assert.deepEqual(await readExecutorDeclaration(checkout), { version: 1, count: 1, kinds: null, intervalSeconds: 1 });
  } finally {
    await rm(checkout, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true });
  }
});
