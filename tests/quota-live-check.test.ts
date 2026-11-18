import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withDatabase } from './helpers/postgres.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { observeAccount, type FleetClient } from '../src/fleet.js';
import { recordObservedExhaustion } from '../src/master/environments.js';
import { smokeRegistryAccount } from '../src/runner/roles.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { randomUUID } from 'node:crypto';

// Every provider is a local executable: the production smoke launcher still supplies the real
// runtime argv and account login environment. Two actual registries share only the host record.
test('quota-live-check: only each login’s live request holds it, across installs and resets', async () => {
  const root = await temporaryDirectory('quota-live-check');
  process.env[hostAccountsVariable] = await temporaryDirectory('host-records', root);
  const stores = await Promise.all([withDatabase('quota-live-one'), withDatabase('quota-live-two')]);
  const operator = { id: 'operator', role: 'admin' as const };
  try {
    for (const store of stores) await store.init();
    for (const kind of ['claude', 'codex', 'cursor', 'opencode', 'pi', 'muse', 'agy']) {
      const home = await temporaryDirectory(kind, root), provider = join(home, 'provider.cjs');
      const state = join(home, 'reply.json');
      await writeFile(provider, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst home = process.env.TEST_LOGIN;\nif (process.env.TEST_HOME_VARIABLE && process.env[process.env.TEST_HOME_VARIABLE] !== home) { console.error('wrong login home'); process.exit(1); }\nif (process.env.TEST_KIND === 'agy' && fs.realpathSync(path.join(process.env.HOME, '.gemini/antigravity-cli')) !== home) process.exit(1);\nconst reply = JSON.parse(fs.readFileSync(path.join(home, 'reply.json')));\nfs.appendFileSync(path.join(home, 'calls'), JSON.stringify(process.argv.slice(2))+'\\n');\nif (!reply.ok) { console.error(reply.error); process.exit(1); }\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'OK'}]}}));\n`);
      await chmod(provider, 0o700);
      const runtime = structuredClone(proposedRuntimes.find(runtime => runtime.name === kind) ?? { ...proposedRuntimes.find(runtime => runtime.name === 'pi')!, name: kind });
      runtime.launch.kind = kind;
      assert.ok(runtime, kind);
      runtime.launch.environment = { ...runtime.launch.environment, TEST_LOGIN: home, ...(kind !== 'agy' && runtime.launch.homeVariable ? { TEST_HOME_VARIABLE: runtime.launch.homeVariable } : {}), TEST_KIND: kind };
      const registries = stores.map(store => new AgentRegistry(store));
      for (const registry of registries) await registry.mutate(operator, 'apply', {
        runtimes: [runtime], models: [{ name: 'fixture', id: null }],
        accounts: [{ name: kind, runtime: kind, model: 'fixture', credential: { host: 'host', home } }],
        roles: [{ name: 'worker', accounts: [kind], concurrency: 1 }], reason: 'live check fixture',
      }, randomUUID());
      let now = Date.now();
      let calls = 0;
      const smoke = async (target: Parameters<typeof smokeRegistryAccount>[0]) => { calls++; return smokeRegistryAccount(target, { command: provider, timeoutMs: 5000 }); };
      const document = (index = 0) => registries[index].document(operator);
      const client: Pick<FleetClient, 'document' | 'observe'> = { document: () => document(), observe: request => registries[0].observe(operator, request, randomUUID()) };
      const reply = (ok: boolean, error: string | null = null) => writeFile(state, JSON.stringify({ ok, error }));
      const signal = () => recordObservedExhaustion({ credentialFile: '', hostId: 'host' }, kind,
        { at: new Date(now).toISOString(), role: 'worker', profile: 'fixture', work: null, reason: 'Quoted fixture: usage limit reached', resetsAt: null }, now, { registry: client, smoke });
      const check = async (index = 0) => {
        const doc = await document(index), account = doc.accounts.find(account => account.name === kind)!;
        const observed = await observeAccount(account, runtime, { now: () => now, smoke, quota: false, opencodeAuth: null, opencodeModels: null }, doc.accounts);
        await registries[index].observe(operator, { host: 'host', observations: [{ account: kind, quota: observed.quota }] }, randomUUID());
        return observed.quota;
      };
      await reply(true); await signal();
      assert.equal((await document()).accounts.find(account => account.name === kind)!.quota.state, 'available', `${kind}: a quoted limit cannot hold a passing account`);
      assert.equal((await check()).state, 'available', `${kind}: quoted narrative does not hold`);
      assert.equal(calls, 1);
      assert.equal((await check(1)).state, 'available'); assert.equal(calls, 1, 'second install reuses host result');
      const reset = new Date(now + 60_000).toISOString();
      await reply(false, `Usage limit reached; resets at ${reset}`); await signal();
      assert.equal((await check()).state, 'exhausted');
      assert.equal((await check(1)).resetsAt, reset);
      await reply(true); now += 59_999; const heldCalls = calls;
      assert.equal((await check()).state, 'exhausted', JSON.stringify({kind, now, reset, heldCalls, calls, doc: (await document()).accounts.find(a => a.name === kind)})); assert.equal(calls, heldCalls);
      now++; assert.equal((await check()).state, 'available'); assert.equal(calls, heldCalls + 1);
      assert.equal((await check(1)).state, 'available');
      await reply(false, 'Usage limit reached'); await signal();
      assert.equal((await check()).resetsAt, new Date(now + 30 * 60_000).toISOString());
      await reply(true); now += 30 * 60_000 - 1; const unknownCalls = calls;
      assert.equal((await check()).state, 'exhausted'); assert.equal(calls, unknownCalls);
      now++; assert.equal((await check()).state, 'available');
      // Operator marks are signals too, even when they name no reset.
      await registries[0].mutate(operator, 'account.quota', { name: kind, quota: { state: 'exhausted', resetsAt: null }, reason: 'operator suspects exhaustion' }, randomUUID());
      // The fixture clock advances independently of the database clock; stamp the signal after the cached result.
      const marked = (await document()).accounts.find(account => account.name === kind)!;
      marked.quota.observedAt = new Date(now + 1).toISOString();
      const released = await observeAccount(marked, runtime, { now: () => now + 1, smoke, quota: false });
      assert.equal(released.quota.state, 'available', `${kind}: passing request releases operator mark`);
      await registries[0].observe(operator, { host: 'host', observations: [{ account: kind, quota: released.quota }] }, randomUUID());
      assert.equal((await document()).accounts.find(account => account.name === kind)!.quota.state, 'available');
      now++;
      await reply(false, 'Not logged in. Please run login'); await signal();
      assert.equal((await check()).loggedIn, false);
      await reply(true); now += 30 * 60_000;
      assert.equal((await check()).loggedIn, true, `${kind}: login refreshes on next check`);
    }
  } finally { for (const store of stores) await store.close(); }
});


test('quota-live-check: quoted output from a real worker does not hold a passing login', async () => {
  const { headlessWorkers } = await import('./helpers/headless-workers.js');
  const workers = await headlessWorkers('quota-live-worker');
  try {
    await workers.configure([{ name: 'quotes-limit', kind: 'opencode', printed: 'Error: 429 FreeUsageLimitError: Free usage limit reached.', smokePass: true }]);
    const work = await workers.readyItem('GY-3467');
    await assert.rejects(workers.dispatch(work), /worker exited at once/, 'the failed process is a normal launch failure');
    const account = (await workers.registry.snapshot(workers.hostId)).accounts.find(account => account.name === 'quotes-limit')!;
    assert.equal(account.quota, 'available');
    assert.equal((await workers.stored(work.id)).capacity?.exhaustions?.length ?? 0, 0, 'quoted output does not park the work as out of credits');
  } finally { await workers.stop(); }
});
