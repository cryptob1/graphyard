import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, runAutonomyCommand, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { syncWork } from '../src/cli/workspace.js';
import type { CliContext } from '../src/cli/context.js';
import type { Principal, Work } from '../src/model.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3298: `master hold` keeps a released item out of dispatch without touching its history,
// candidate or live lease; `master message` reaches the item's worker at its next sync, which
// acknowledges it under its epoch; an unread message survives a restart and carries into the
// successor's prompt; `master release` resumes dispatch.
const repository = 'owner/hold-and-message';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const workerB: Principal = { id: 'worker-b', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA, workerB].map(principal => ({ ...principal, token: `hold-${principal.id}-${'x'.repeat(32)}` }));
const token = (id: string) => credentials.find(credential => credential.id === id)!.token;
const loopId = 'hold-and-message-operator';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, root: string, checkout: string, config: MasterConfig;

const request = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...(path === 'work-snapshot' ? { [coordinationViewHeader]: 'coordination' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const call = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const { status, body: parsed } = await request(bearer, method, path, body);
  assert.equal(status, 200, JSON.stringify(parsed));
  return parsed;
};
const reload = async (id: string): Promise<Work> => call(token(operator.id), 'GET', `work/${id}`);
/** The real `graphyard master` subcommand, authenticated as the loop's operator-agent identity. */
const master = (id: string, ...args: string[]) => runAutonomyCommand(checkout, config, id, args, {
  coordinator: path => call(token(coordinator.id), 'GET', path), readSecret: async () => '', agents: () => [], daemonLock: async () => null });
const lapse = (id: string) => store.pool.query(`UPDATE work_items SET document=jsonb_set(document, '{lease,expiresAt}', to_jsonb($2::text)) WHERE id=$1`, [id, new Date(Date.now() - 1000).toISOString()]);
const startServer = async () => {
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  config = { ...config, url };
};

/** The worker's real sync in its workspace, against the control plane under its own credential. */
async function sync(worker: Principal, id: string, workspace: string) {
  const printed: any[] = [], cwd = process.cwd();
  const api = async (path: string, body?: unknown) => path === 'status' ? { baseBranch: 'main' } : call(token(worker.id), body === undefined ? 'GET' : 'POST', path, body);
  process.chdir(workspace);
  try { await syncWork({ api, print: (value: unknown) => printed.push(value), base: url, args: [] } as unknown as CliContext, await api(`work/${id}`)); }
  finally { process.chdir(cwd); }
  return printed[0];
}
async function claimWithWorkspace(worker: Principal, id: string, name: string) {
  const claimed = await call(token(worker.id), 'POST', `work/${id}/claim`, {});
  const epoch = claimed.lease.epoch, branch = `graphyard/${name}-${epoch}`, workspace = join(root, `${name}-${epoch}`);
  git(checkout, 'worktree', 'add', '-q', '-b', branch, workspace);
  git(workspace, 'config', 'user.email', 't@example.com'); git(workspace, 'config', 'user.name', 'T');
  await writeFile(join(workspace, `${name}-${epoch}.txt`), 'work\n'); git(workspace, 'add', '-A'); git(workspace, 'commit', '-q', '-m', 'work');
  await call(token(worker.id), 'POST', `work/${id}/workspace`, { epoch, host: 'test', path: workspace, branch });
  return { epoch, workspace, head: git(workspace, 'rev-parse', 'HEAD') };
}

before(async () => {
  root = await realpath(await temporaryDirectory('hold-and-message-worker'));
  const origin = join(root, 'origin.git'); checkout = join(root, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await writeFile(join(checkout, 'README.md'), '# Fixture\n'); git(checkout, 'add', '-A'); git(checkout, 'commit', '-q', '-m', 'base'); git(checkout, 'push', '-q', 'origin', 'main');
  store = await withDatabase('hold-and-message-worker'); await store.init();
  engine = new Engine(store, 300, repository); engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  const secrets = await realpath(await temporaryDirectory('hold-and-message-secrets'));
  const agentToken = `loop-agent-${randomUUID()}`, credentialFile = join(secrets, 'operator.token');
  await mkdir(secrets, { recursive: true }); await writeFile(credentialFile, agentToken); await chmod(credentialFile, 0o600);
  const profile = { name: 'one', principal: workerB.id, agentName: 'agent-one', mode: 'launch', kind: 'claude', credentialFile: '/srv/one.token', agentArgs: [], approvals: 'auto', environment: {} } as WorkerProfile;
  config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: '/outside/c.token', cliPath: '/outside/graphyard.mjs', repository, baseBranch: 'main', githubAppId: 1234, hostId: 'h', masterAgentName: 'm', autoMerge: true, mergeMethod: 'merge',
    operatorAgent: { id: loopId, credentialFile }, workers: [profile, { ...profile, name: 'two', agentName: 'agent-two' }] });
  await startServer();
  await call(token(operator.id), 'POST', 'operator-agents', { id: loopId, displayName: 'Loop', capabilities: [], scope: { repositories: [repository], workItems: ['*'] }, token: agentToken, reason: 'the loop applies its decisions' });
});
after(async () => { http?.close(); await store?.close(); if (root) await rm(root, { recursive: true, force: true }); });

test('integration:hold-and-message-worker — a held item is skipped by dispatch for several cycles with its lease, history and candidate kept; its worker reads and acknowledges the master message at sync, a restart keeps an unread one, the successor inherits it, and release resumes dispatch', async () => {
  const file = (title: string) => call(token(operator.id), 'POST', 'work', { title, type: 'chore', description: 'A fixture item',
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:hold-and-message-worker', 'e2e:fixture'] }], policy: { checks: ['test'], review: true } }) as Promise<Work>;
  const item = await file('Held while leased'), submitted = await file('Held with a candidate');
  await master('release', item.key, 'Ready to build'); await master('release', submitted.key, 'Ready to build');

  // A submitted item is held: its candidate stays.
  const built = await claimWithWorkspace(workerA, submitted.id, 'candidate');
  await call(token(workerA.id), 'POST', `work/${submitted.id}/submit`, { epoch: built.epoch, head: built.head });
  await master('hold', submitted.key, 'An external outage blocks every attempt');
  assert.equal((await reload(submitted.id)).candidate?.sha, built.head, 'the hold keeps the candidate');

  // A live worker is held: it keeps its lease.
  const a = await claimWithWorkspace(workerA, item.id, 'item');
  const held = await master('hold', item.key, 'The upstream API is down; GY-9 burned eight attempts on it');
  assert.equal(held.hold, true); assert.equal(held.heldBy, loopId); assert.match(held.holdReason, /upstream API is down/);
  assert.equal(held.lease.owner, workerA.id); assert.equal(held.lease.epoch, a.epoch, 'the live worker keeps its lease');
  assert.equal(held.nextAction, null, 'nothing is queued for a held item');

  // Unauthorized mutations are refused: a worker or the coordinator can neither hold, release nor message.
  for (const principal of [workerA, coordinator]) {
    for (const [command, body] of [['hold', { reason: 'no' }], ['message', { text: 'no' }], ['ready', { reason: 'no' }]] as const)
      assert.equal((await request(token(principal.id), 'POST', `work/${item.id}/${command}`, body)).status, 403, `${principal.id} may not ${command}`);
  }
  // The master messages the worker; a control plane restart before the worker reads it keeps it.
  await master('message', item.key, 'Stop retrying the upstream call; stub it behind the existing adapter');
  http.close(); await startServer();
  // The worker's next sync shows it with author and time, and acknowledges it under its epoch.
  const first = await sync(workerA, item.id, a.workspace);
  assert.equal(first.merged, true);
  assert.deepEqual(first.messages.map((message: any) => [message.id, message.by, message.text]), [['m1', loopId, 'Stop retrying the upstream call; stub it behind the existing adapter']]);
  assert.ok(Date.parse(first.messages[0].at));
  const acknowledged = (await reload(item.id)).messages!.find(message => message.id === 'm1')!;
  assert.equal(acknowledged.acknowledged?.by, workerA.id); assert.equal(acknowledged.acknowledged?.epoch, a.epoch);
  assert.equal((await sync(workerA, item.id, a.workspace)).messages, undefined, 'an acknowledged message is not shown again');
  // A second message the worker never reads: its attempt ends, and no retired epoch claims it.
  await master('message', item.key, 'Keep the adapter change to one file');
  await lapse(item.id);

  // A held item cannot be claimed by anyone.
  const refusedClaim = await request(token(workerB.id), 'POST', `work/${item.id}/claim`, {});
  assert.equal(refusedClaim.status, 409); assert.match(refusedClaim.body.error, /is held/);

  // The loop skips it, cycle after cycle; history, candidate and workspaces are kept.
  const dispatched: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => { const snapshot = await call(token(coordinator.id), 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: snapshot.now }; },
    closeSession: () => {}, release: async () => {},
    dispatch: async work => { dispatched.push(work.key); return undefined; },
    persist: async () => {},
  };
  const state = emptyDaemonState(config);
  const historyBefore = (await call(token(operator.id), 'GET', `events?work=${item.id}&view=rows`)).length;
  for (let cycle = 0; cycle < 3; cycle++) await runCycle(config, state, effects);
  assert.deepEqual(dispatched, [], 'three cycles dispatch neither held item');
  const skipped = await reload(item.id);
  assert.equal(skipped.hold, true); assert.equal(skipped.workspaces.length, 1, 'the workspace is kept');
  assert.equal((await reload(submitted.id)).candidate?.sha, built.head, 'the candidate is kept');
  assert.ok((await call(token(operator.id), 'GET', `events?work=${item.id}&view=rows`)).length >= historyBefore, 'history is kept');

  // Release resumes ordinary dispatch.
  const released = await master('release', item.key, 'The upstream API is back');
  assert.equal(released.hold, undefined); assert.equal(released.holdReason, undefined);
  await runCycle(config, state, effects);
  assert.ok(dispatched.includes(item.key), 'the released item is dispatched again');
  assert.ok(!dispatched.includes(submitted.key), 'the still-held item is not');

  // The successor inherits the unread guidance in its prompt, and its sync acknowledges it under its own epoch.
  const b = await claimWithWorkspace(workerB, item.id, 'item');
  const successor = await reload(item.id);
  const unread = successor.messages!.find(message => message.id === 'm2')!;
  assert.equal(unread.acknowledged, undefined, 'the retired epoch never received it');
  const prompt = workerPrompt(config, successor, { principal: workerB.id }, b.epoch);
  assert.match(prompt, /Unread messages from the master .*Keep the adapter change to one file/);
  assert.doesNotMatch(prompt, /Stop retrying the upstream call/, 'an acknowledged message is not repeated');
  const second = await sync(workerB, item.id, b.workspace);
  assert.deepEqual(second.messages.map((message: any) => message.id), ['m2']);
  assert.deepEqual((await reload(item.id)).messages!.find(message => message.id === 'm2')!.acknowledged?.epoch, b.epoch);

  // The held state and the message history are readable from the item's history.
  const kinds = (await call(token(operator.id), 'GET', `events?work=${item.id}&view=rows`)).map((event: { kind: string }) => event.kind);
  for (const kind of ['hold', 'message', 'ready']) assert.ok(kinds.includes(kind), `history records ${kind}`);
  const stillHeld = await reload(submitted.id);
  assert.equal(stillHeld.hold, true); assert.match(stillHeld.holdReason!, /external outage/);
});
