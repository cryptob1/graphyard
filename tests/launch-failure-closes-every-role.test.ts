import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { fleet, requested } from './helpers/review-fleet.js';
import { launchSpecCheck } from '../src/spec-check.js';
import { loadMasterConfig } from '../src/master.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, proposedRuntimes, supersededByRequest, type FleetSession } from '../src/model/registry.js';
import type { FleetClient } from '../src/fleet.js';

async function claudeLogin(name: string) {
  const home = join(await temporaryDirectory('reviewer-login'), name);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `${name}-token`, refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } }), { mode: 0o600 });
  return home;
}

/** The control plane's registry in memory, through the same pure functions the server runs. */
function memoryRegistry(host: string, home: string) {
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'),
    models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'reviewer-account', runtime: 'claude', model: 'opus', credential: { host, home } }],
    roles: [{ name: 'reviewer', accounts: ['reviewer-account'], policy: { args: ['--setting-sources', 'user'] }, concurrency: 4 }],
    reason: 'fixture reviewer fleet',
  }, { actor: 'operator', at: new Date().toISOString() }).registry;
  const at = () => new Date().toISOString();
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      for (const superseded of supersededByRequest(registry, request)) Object.assign(superseded, { endedAt: at(), endReason: 'superseded' });
      const choice = chooseSession(registry, request, Date.now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const session: FleetSession = { id: randomUUID(), role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: at(), selectedBy: 'coordinator', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry.sessions.push(session);
      registry.revision++;
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async (id: string, reason: string) => {
      const session = registry.sessions.find(entry => entry.id === id);
      if (session && !session.endedAt) { session.endedAt = at(); session.endReason = reason; }
    },
  };
  return { registry, client, live: () => registry.sessions.filter(session => !session.endedAt) };
}

test('unit:launch-failure-closes-every-role — a spec-check start failure closes its pane before releasing the account claim and removes its token', async () => {
  const host = await fleet({ name: 'checker', agentName: 'spec-checker', kind: 'claude', agentArgs: ['--setting-sources', 'user'] }, null);
  const login = await claudeLogin('checker');
  try {
    const config = await loadMasterConfig(host.root);
    const registry = memoryRegistry(config.hostId, login);
    const order: string[] = [];
    const end = registry.client.end;
    registry.client.end = async (...args) => { order.push('release'); return end(...args); };
    const item = { ...requested(3026), id: randomUUID() };
    let registered = false;
    const run = (command: string, args: string[]) => {
      if (command === 'git') {
        if (args.includes('rev-parse')) return 'a'.repeat(40);
        return execFileSync(command, args, { encoding: 'utf8' });
      }
      if (args[0] === 'pane' && args[1] === 'run') {
        assert.ok(registered, 'registration precedes runtime start');
        assert.equal(registry.live().length, 1, 'the runtime starts under an account claim');
        order.push('start');
        throw new Error('fixture runtime start failed');
      }
      if (args[0] === 'pane' && args[1] === 'close') order.push('close');
      return host.run(command, args);
    };
    await assert.rejects(launchSpecCheck(host.root, item, 'checker', [], new Date().toISOString(), {
      run, probe: { registry: registry.client, quota: false, cacheMs: 0 },
      registerLaunch: async () => { registered = true; return { launch: 'spec-check-launch' }; },
    }), /fixture runtime start failed.*pane pane-1 was closed/);
    assert.deepEqual(order, ['start', 'close', 'release']);
    assert.deepEqual(host.closes, ['pane-1']);
    assert.equal(registry.live().length, 0);
    const created = host.calls.find(args => args[0] === 'tab' && args[1] === 'create')!;
    const binding = created.find(arg => arg.startsWith('GH_CONFIG_DIR='))!.slice('GH_CONFIG_DIR='.length);
    await assert.rejects(access(binding), { code: 'ENOENT' });
  } finally { await host.cleanup(); await rm(login, { recursive: true, force: true }); }
});
