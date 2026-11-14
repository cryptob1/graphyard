import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { atomicPrivateWrite, setupMaster } from '../src/master.js';
import { copyTemplateCluster } from '../src/e2e/warm-postgres.js';
import { postgresBinaries, startCluster, type LocalPaths } from '../src/install/local-runtime.js';
import { installDirectory } from '../src/install/secrets.js';
import { installIdFor } from '../src/install/types.js';
import { reserveTestPorts } from '../src/cli/test-isolation.js';
import { moveInstall } from '../src/install/move.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const tokens = { operator: `operator-${'o'.repeat(40)}`, master: `master-${'m'.repeat(40)}`, worker: `worker-${'w'.repeat(40)}` };

/** A control plane on the cluster whose data directory is DATA: the server the install runs, its database in the install directory. */
async function controlPlane(data: string, port: number) {
  const cluster = await startCluster({ data } as LocalPaths, port, await postgresBinaries());
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/postgres`); await store.init();
  const http = server(new Engine(store, 120, 'owner/project'), [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: tokens.operator },
    { id: 'master', role: 'coordinator', token: tokens.master },
    { id: 'worker', role: 'worker', token: tokens.worker },
  ]);
  await new Promise<void>(accept => http.listen(0, '127.0.0.1', accept));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const ok = async (path: string, body?: unknown, token = tokens.operator) => {
    const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any; assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`); return result;
  };
  const stop = async () => { http.closeAllConnections(); await new Promise<void>(accept => http.close(() => accept())); await store.close(); await cluster.stop(); };
  return { url, ok, stop };
}

test('e2e:install-move-host — install move copies the database, files and credentials, sets hostId and re-points every account', async () => {
  const scratch = await temporaryDirectory('move-host'), ports = await reserveTestPorts();
  const configHome = join(scratch, 'config'), root = join(scratch, 'checkout'), masters = join(scratch, 'masters'), units = join(scratch, 'units'), target = join(scratch, 'target');
  const directory = installDirectory(installIdFor('owner/project'), configHome), data = join(directory, 'postgres', 'data');
  let running: Awaited<ReturnType<typeof controlPlane>> | null = null;
  try {
    // The source install: its database in the install directory, a master with an operator-agent and a worker credential, one account.
    await mkdir(join(directory, 'postgres'), { recursive: true, mode: 0o700 }); await mkdir(units, { recursive: true });
    await copyTemplateCluster(data, ports.base);
    running = await controlPlane(data, ports.base);
    const source = running;
    execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const bound = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    await setupMaster(root, { url: source.url, token: tokens.master, cliPath: launcher, credentialDirectory: masters, hostId: 'source-host', herdrWorkspace: 'workspace-graphyard' }, bound as typeof fetch);
    const config = JSON.parse(await readFile(join(root, '.graphyard/master.json'), 'utf8'));
    const operatorCredential = join(masters, 'operator-agent.token'), workerCredential = join(scratch, 'workers', 'only-worker.token');
    await mkdir(join(scratch, 'workers'), { recursive: true, mode: 0o700 });
    await writeFile(operatorCredential, `operator-agent-${'a'.repeat(40)}`, { mode: 0o600 }); await writeFile(workerCredential, tokens.worker, { mode: 0o600 });
    await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...config, operatorAgent: { id: 'master-agent', credentialFile: operatorCredential },
      workers: [{ name: 'only-worker', principal: 'worker', agentName: 'only-worker', mode: 'launch', kind: 'claude', credentialFile: workerCredential, agentArgs: [], approvals: 'auto', environment: {} }] });
    await atomicPrivateWrite(join(root, '.graphyard/connection.json'), { url: source.url, cliPath: launcher, hostId: 'source-host' });
    await source.ok('agent-registry/apply', { runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'default', id: null }],
      accounts: [{ name: 'claude-a', runtime: 'claude', model: 'default', credential: { host: 'source-host', home: null } }], roles: [{ name: 'worker', accounts: ['claude-a'], concurrency: 1 }], reason: 'fixture' });
    const item = await source.ok('work', { title: 'Moves with the install', type: 'chore', priority: 2, criteria: [{ id: 'AC-1', text: 'Moves', proofs: ['unit:move'] }] });
    await source.ok(`work/${item.id}/ready`, { reason: 'Ready' });
    const claimed = await source.ok(`work/${item.id}/claim`, {}, tokens.worker);
    const stop = async () => { await source.stop(); running = null; };
    const dependencies = { configHome, unitDirectory: units, stop };

    // A leased item refuses the move, and nothing is copied.
    await assert.rejects(moveInstall(root, { to: 'target-host', into: target }, dependencies), new RegExp(`${item.key} is leased to worker`));
    assert.equal(existsSync(target), false);
    await source.ok(`work/${item.id}/release`, { epoch: claimed.epoch }, tokens.worker);

    // --plan lists the database, install files and each credential file, and changes nothing.
    const plan = await moveInstall(root, { to: 'target-host', into: target, plan: true }, dependencies);
    assert.deepEqual(plan.database, { kind: 'directory', path: join(directory, 'postgres') });
    assert.ok(plan.files.includes(root) && plan.files.includes(directory), 'the checkout and the install directory are listed');
    assert.deepEqual(plan.credentials, [config.credentialFile, operatorCredential, workerCredential].sort());
    assert.deepEqual(plan.accounts, ['claude-a']); assert.deepEqual(plan.refusals, []); assert.equal(plan.applied, false);
    assert.equal(existsSync(target), false, 'the plan copies nothing');
    assert.equal((await source.ok('agent-registry/document', undefined, tokens.master)).accounts[0].credential.host, 'source-host', 'the plan re-points nothing');
    assert.equal(JSON.parse(await readFile(join(root, '.graphyard/master.json'), 'utf8')).hostId, 'source-host');

    // Applied to a directory standing in for the target host.
    const moved = await moveInstall(root, { to: 'target-host', into: target }, dependencies);
    assert.equal(moved.applied, true); assert.equal(running, null, 'the move stopped the install before copying');
    for (const file of plan.credentials) assert.equal((await stat(join(target, file))).mode & 0o777, 0o600, `${file} is on the target with mode 0600`);
    for (const file of ['master.json', 'connection.json']) assert.equal(JSON.parse(await readFile(join(target, root, '.graphyard', file), 'utf8')).hostId, 'target-host', `${file} names the target host`);
    assert.ok(existsSync(join(target, data, 'PG_VERSION')), 'the database directory is on the target');

    // The target's control plane has the database contents, every account on the target host, and none refused for it.
    running = await controlPlane(join(target, data), ports.base);
    const moving = running;
    assert.ok((await moving.ok('work-snapshot', undefined, tokens.master)).work.some((entry: { key: string }) => entry.key === item.key), 'the item moved with the database');
    assert.deepEqual((await moving.ok('agent-registry/document', undefined, tokens.master)).accounts.map((account: any) => account.credential.host), ['target-host']);
    const fleet = await moving.ok('agent-registry?host=target-host', undefined, tokens.master);
    assert.deepEqual(fleet.accounts.filter((account: any) => /placed on/.test(account.ineligible ?? '')), [], 'no account is refused for the target host');
  } finally {
    await (running as Awaited<ReturnType<typeof controlPlane>> | null)?.stop().catch(() => {});
    ports.release();
    await rm(scratch, { recursive: true, force: true });
  }
});
