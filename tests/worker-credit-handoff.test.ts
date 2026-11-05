import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from './helpers/warm-postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { daemonEffects, type DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { masterConfigSchema, workerPrompt, observedExhaustions, selectAccount, recordEnvironmentLog, selectionKey, type MasterConfig } from '../src/master.js';
import { accountHeldForRole } from '../src/model/capacity.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Exercise the real limit-stop effect, capacity transaction and successor handoff with real Git.
const HOST = 'loop-host';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const workerB: Principal = { id: 'worker-b', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA, workerB].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(principal, method, path, body);
  assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3042;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('credit-work-db'), user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('credit_work');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/credit_work`);
  await store.init();
  engine = new Engine(store, 7200, 'owner/credit-work');
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});

after(async () => { http?.close(); await store?.close(); await database?.stop(); });

for (const shape of ['uncommitted', 'committed-and-uncommitted', 'clean', 'clean-with-commits']) {
  test(`e2e:worker-credit-handoff — ${shape} survives a limit stop and reaches another account`, async () => {
    await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
    const root = await temporaryDirectory(`credit-${shape}`);
    const branch = 'graphyard/attempt-1', worktree = join(root, 'attempt');
    git(['init', '-q', '-b', 'main'], root);
    git(['config', 'user.email', 'fixture@graphyard.invalid'], root);
    git(['config', 'user.name', 'Graphyard Fixture'], root);
    await writeFile(join(root, 'finding.txt'), 'base\n');
    git(['add', 'finding.txt'], root);
    git(['commit', '-q', '-m', 'base'], root);
    const base = git(['rev-parse', 'HEAD'], root);
    git(['worktree', 'add', '-b', branch, worktree], root);
    let committed = base;
    if (shape.includes('committed-and') || shape === 'clean-with-commits') {
      await writeFile(join(worktree, 'finding.txt'), 'committed finding\n');
      git(['add', 'finding.txt'], worktree);
      git(['commit', '-q', '-m', 'finding so far'], worktree);
      committed = git(['rev-parse', 'HEAD'], worktree);
    }
    const dirty = shape.includes('uncommitted');
    if (dirty) {
      await writeFile(join(worktree, 'finding.txt'), 'unfinished finding\n');
      await writeFile(join(worktree, 'untracked.txt'), 'new finding\n');
    }

    const filed = await ok(operator, 'POST', 'work', { title: `Keep ${shape} work`, type: 'chore', criteria: [{ id: 'AC-1', text: 'Work is kept', proofs: ['e2e:worker-credit-handoff'] }] }) as Work;
    await ok(operator, 'POST', `work/${filed.id}/ready`, {});
    await ok(workerA, 'POST', `work/${filed.id}/claim`, {});
    const session = { id: 'worker-a:1', kind: 'implementation', principal: workerA.id, epoch: 1, runtime: 'claude', host: HOST, pane: 'pane-credit', agentName: 'agent-credit', subject: filed.title, state: 'running' };
    await ok(workerA, 'POST', `work/${filed.id}/session`, session);
    await ok(workerA, 'POST', `work/${filed.id}/workspace`, { epoch: 1, host: HOST, path: worktree, branch });

    const config = masterConfigSchema.parse({
      version: 1, url, credentialFile: join(root, 'coordinator.token'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
      repository: 'owner/credit-work', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: 'graphyard-master-credit',
      workers: [{ name: 'builder', principal: workerB.id, agentName: 'agent-builder', mode: 'launch', kind: 'claude', credentialFile: join(root, 'builder.token'), accounts: ['claude-c', 'claude-d'] }],
      environments: [{ name: 'claude-c', kind: 'claude', home: join(root, 'claude-c') }, { name: 'claude-d', kind: 'claude', home: join(root, 'claude-d') }],
    }) as MasterConfig;
    for (const name of ['claude-c', 'claude-d']) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
    }
    config.workers.push({ ...config.workers[0]!, name: 'spent-builder', principal: workerA.id });
    await recordEnvironmentLog(config, [], [], { key: selectionKey('worker', 'spent-builder'), environment: 'claude-c', kind: 'claude', at: new Date().toISOString(), work: filed.key });
    const clock = Date.now();
    const snapshot = async () => {
      const response = await ok(coordinator, 'GET', 'work-snapshot');
      return { work: response.work as Work[], now: new Date(clock).toISOString() };
    };
    const mutate = (path: string, data: unknown) => ok(coordinator, 'POST', path, data);
    const real = daemonEffects(root, config, { snapshot, mutate });
    const herdr = [{ name: 'agent-credit', pane_id: 'pane-credit', agent_status: 'idle' }];
    const closed: string[] = [], handoffs: string[] = [], accounts: (string | undefined)[] = [];
    const effects: DaemonEffects = {
      ...real,
      agents: () => herdr as any, herdr: () => ({ agents: herdr as any, available: true }),
      credentials: async () => ({ builder: { available: true, reason: null } }),
      closeSession: pane => { closed.push(pane); },
      promptSession: async () => { assert.fail('the limit stop needs no re-prompt'); },
      sessionScreen: () => "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.",
      dispatch: async (work, profile) => {
        const chosen = await selectAccount(config, 'worker', profile, { quota: false, now: () => clock, cacheMs: 0, work: work.key });
        accounts.push(chosen.account?.name);
        const next = await ok(workerB, 'POST', `work/${work.id}/claim`, {}) as Work;
        handoffs.push(workerPrompt({ cliPath: config.cliPath }, next, { principal: workerB.id }, next.epoch));
        return { pane: null, epoch: next.epoch };
      },
      dispatchTick: async () => {}, sweepCheckouts: async () => {}, masterSession: undefined, mergeWriter: null,
      persist: async () => {}, removeWorktree: undefined,
    };
    const state: DaemonState = emptyDaemonState(config);
    await runCycle(config, state, effects, () => clock);
    // The next snapshot sees the released lease and dispatches the replacement.
    await runCycle(config, state, effects, () => clock);
    const after = await reload(filed.id);
    const partial = after.capacity?.exhaustions[0]?.partialWork;
    const saved = git(['rev-parse', 'HEAD'], worktree);
    assert.equal(partial?.state, dirty ? 'committed' : 'clean');
    assert.equal(partial?.commit, saved);
    assert.equal(partial?.branch, branch);
    assert.equal(partial?.path, worktree);
    assert.equal(git(['status', '--porcelain'], worktree), '');
    assert.equal(git(['merge-base', committed, saved], root), committed, 'prior commits are ancestors of the saved work');
    if (dirty) {
      assert.equal(git(['show', `${saved}:finding.txt`], root), 'unfinished finding');
      assert.equal(git(['show', `${saved}:untracked.txt`], root), 'new finding');
    } else assert.equal(saved, committed, 'clean trees keep their existing HEAD without a synthetic commit');
    assert.deepEqual(accounts, ['claude-d'], JSON.stringify(state.actions));
    assert.equal(accountHeldForRole(await observedExhaustions(config, clock), 'claude-c', clock), true);
    assert.equal(after.epoch, 2);
    assert.equal(after.lease?.owner, workerB.id);
    assert.deepEqual(closed, ['pane-credit']);
    assert.equal(handoffs.length, 1);
    assert.ok(handoffs[0]!.includes(`its work is kept as commit ${saved}`));
    assert.ok(handoffs[0]!.includes('git log and git show'));
    assert.ok(handoffs[0]!.includes('cherry-pick or git merge instead of redoing it'));
    // Removing the ended tree leaves the named branch/commit available to the successor.
    git(['worktree', 'remove', worktree], root);
    assert.equal(git(['rev-parse', branch], root), saved);
  });
}
