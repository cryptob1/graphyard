import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { atomicPrivateWrite } from '../src/master/config.js';
import { dispatchWork } from '../src/master/dispatch.js';
import type { HeadlessExec } from '../src/headless-session.js';
import { masterConfigSchema, observedExhaustions, type MasterConfig } from '../src/master.js';
import { accountHeldForRole } from '../src/model/capacity.js';
import { proposedRuntimes } from '../src/model/registry.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Exercise the real limit-stop preservation, capacity transaction and successor handoff with real Git,
// through the headless worker dispatch (GY-3259): the run stops on its limit and the same dispatch moves on.
const HOST = 'loop-host';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const workerB: Principal = { id: 'worker-b', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA, workerB].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

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
  store = await withDatabase('worker-credit-handoff');
  await store.init();
  engine = new Engine(store, 7200, 'owner/credit-work');
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});

after(async () => { http?.close(); await store?.close(); });

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
    const ready = await ok(operator, 'POST', `work/${filed.id}/ready`, {}) as Work;

    const secrets = await temporaryDirectory(`credit-secrets-${shape}`);
    const config = masterConfigSchema.parse({
      version: 1, url, credentialFile: join(secrets, 'coordinator.token'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
      repository: 'owner/credit-work', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: 'graphyard-master-credit',
      workers: [{ name: 'builder', principal: workerA.id, agentName: 'agent-builder', mode: 'launch', kind: 'claude', credentialFile: join(secrets, 'builder.token'), accounts: ['claude-c', 'claude-d'] }],
    }) as MasterConfig;
    for (const name of ['claude-c', 'claude-d']) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
    }
    // GY-3030: the control-plane registry is the only authority for accounts and their exhaustion, so
    // the executor's two accounts are this control plane's registry, read with the coordinator token.
    await writeFile(config.credentialFile, token(coordinator), { mode: 0o600 });
    await writeFile(config.workers[0]!.credentialFile!, token(workerA), { mode: 0o600 });
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await atomicPrivateWrite(join(root, '.graphyard', 'master.json'), config);
    await ok(operator, 'POST', 'agent-registry/apply', {
      runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'default', id: null }],
      accounts: ['claude-c', 'claude-d'].map(name => ({ name, runtime: 'claude', model: 'default', credential: { host: HOST, home: join(root, name) } })),
      roles: [{ name: 'worker', accounts: ['claude-c', 'claude-d'], concurrency: 4 }], reason: 'The executor\'s two accounts',
    });
    const clock = Date.now();
    // The first attempt's run stops at once on its provider's limit notice; the second runs on.
    const runs: { args: string[]; account?: string }[] = [];
    const exec: HeadlessExec = async (_command, args, options) => {
      runs.push({ args, account: options.env.CLAUDE_CONFIG_DIR });
      if (runs.length > 1) return '';
      appendFileSync(join(options.run, 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), stream: 'stderr', text: "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model." })}\n`);
      throw new Error('exited with code 1');
    };
    // Each attempt claims under the worker's own identity; the first works in the tree prepared above, the second in its own.
    const prepare = async () => {
      const claimed = await ok(workerA, 'POST', `work/${filed.id}/claim`, {}) as Work;
      const path = claimed.epoch === 1 ? worktree : join(root, 'attempt-2'), at = claimed.epoch === 1 ? branch : 'graphyard/attempt-2';
      if (claimed.epoch !== 1) git(['worktree', 'add', '-q', '-b', at, path, base], root);
      const registered = await ok(workerA, 'POST', `work/${filed.id}/workspace`, { epoch: claimed.epoch, host: HOST, path, branch: at }) as Work;
      return { epoch: claimed.epoch, path, base, branch: at, work: registered };
    };
    const launched = await dispatchWork(root, ready, config.workers[0]!, { allWork: [ready], observedAt: new Date(clock).toISOString(), headless: exec, prepare, release: async () => {},
      probe: { quota: false, now: () => clock, cacheMs: 0 } as never, capacity: event => ok(coordinator, 'POST', `work/${filed.id}/capacity`, event) });
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
    assert.equal(launched.account?.environment, 'claude-d', 'the successor runs on the next account in the same dispatch');
    assert.deepEqual(runs.map(run => run.account), [join(root, 'claude-c'), join(root, 'claude-d')]);
    assert.equal(accountHeldForRole(await observedExhaustions(config, clock), 'claude-c', clock), true);
    assert.equal(after.epoch, 2);
    assert.equal(after.lease?.owner, workerA.id);
    const handoff = runs[1]!.args.at(-1)!;
    assert.ok(handoff.includes(`its work is kept as commit ${saved}`));
    assert.ok(handoff.includes('git log and git show'));
    assert.ok(handoff.includes('cherry-pick or git merge instead of redoing it'));
    // Removing the ended tree leaves the named branch/commit available to the successor.
    git(['worktree', 'remove', worktree], root);
    assert.equal(git(['rev-parse', branch], root), saved);
  });
}
