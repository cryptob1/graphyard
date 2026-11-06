import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, fleetView } from '../src/model/registry.js';
import { accountStatus, chipTones, roleLaunch, unconfiguredRoles } from '../web/agent-status.js';
import { FleetOverview } from '../web/pages/fleet.js';

/**
 * GY-3181: a healthy install reads healthy on the Agents page. Its running master holds its own
 * 1-of-1 slot, the optional producer role is not configured, and pi was found on PATH without a
 * credential: none of these is an error, so the page's model marks no row bad.
 */

const HOST = 'agents-host', now = Date.parse('2030-05-04T12:00:00Z');
const iso = (offset: number) => new Date(now + offset).toISOString();

test('unit:tests/agents-page-neutral-states.test.ts — a running master, an unconfigured producer and a credential-less runtime read neutrally', () => {
  const launch = { args: [], environment: {}, homeVariable: null, modelFlag: '--model', login: null, loginFile: null };
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [{ name: 'claude', launch: { kind: 'claude', ...launch } }, { name: 'pi', launch: { kind: 'pi', ...launch } }],
    models: [{ name: 'opus', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'frontier', contextTokens: null } }],
    accounts: [
      { name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: HOST, home: '/agents/claude-a' } },
      { name: 'pi-a', runtime: 'pi', model: 'opus', credential: { host: HOST, home: null } },
    ],
    roles: [
      { name: 'master', accounts: ['claude-a'], concurrency: 1 },
      { name: 'worker', accounts: ['claude-a', 'pi-a'], concurrency: 2 },
      { name: 'reviewer', accounts: ['claude-a'], concurrency: 1 },
    ],
    reason: 'healthy install',
  }, { actor: 'operator', at: iso(-60 * 60_000) }).registry;
  registry.accounts.find(account => account.name === 'pi-a')!.smoke = { result: 'fail', reason: 'No API key found', at: iso(-5 * 60_000), by: 'coordinator' };
  registry.sessions.push({ id: '00000000-0000-4000-8000-000000031810', role: 'master', account: 'claude-a', runtime: 'claude', model: 'opus', host: HOST, work: null, principal: 'master',
    selectedAt: iso(-30 * 60_000), selectedBy: 'coordinator', reason: 'master session', skipped: [], endedAt: null, endReason: null });
  const fleet = fleetView(registry, now);

  const launches = fleet.roles.map(role => roleLaunch(role, fleet, now));
  assert.deepEqual(launches.filter(entry => entry.state === 'blocked').map(entry => entry.text), [], 'no role reads as an error');
  const master = launches.find(entry => entry.role === 'master')!;
  assert.equal(master.state, 'running');
  assert.match(master.text, /Running since/);

  const statuses = fleet.accounts.map(account => ({ name: account.name, status: accountStatus(account, fleet, now) }));
  assert.deepEqual(statuses.filter(entry => chipTones[entry.status.chip] === 'bad').map(entry => entry.name), [], 'no account reads as an error');
  assert.equal(statuses.find(entry => entry.name === 'pi-a')!.status.label, 'Not configured');

  assert.deepEqual(unconfiguredRoles(fleet), [{ role: 'producer', error: false }]);
  const page = renderToStaticMarkup(createElement(FleetOverview, { fleet, now }));
  assert.ok(!page.includes('tone-bad') && !page.includes('notice danger') && !page.includes('role="alert"'), 'the page draws nothing in red');
  assert.ok(page.includes('Running since') && page.includes('Not configured: producer'));
});
