import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { UpDependencies, UpEvent, UpRequest } from '../src/up.js';

/**
 * GY-3003 AC-1: `up` has one step list and no GitHub App or browser code path, and the master
 * browser flows are gone. For a fresh repository, up's request parsing and step planning observe
 * the deploy-key, host-supervisor and master-autonomy steps planned — and no App, manifest or
 * browser step. Proof: unit:up-control-plane-steps.
 */

const SERVER = 'http://127.0.0.1:4310';

test('unit:up-control-plane-steps — up parses one request shape and plans exactly the control-plane steps for a fresh repository', async () => {
  const { upRequestFromArgs, upSteps, runUp } = await import('../src/up.js');

  // Request parsing: no App, manifest or browser input is parsed or carried.
  const request: UpRequest = upRequestFromArgs(['--repo', 'acme/fresh']);
  assert.deepEqual(request, { repository: 'acme/fresh', provider: 'compose', agent: false, master: 'claude' });
  for (const flag of ['--browser-profile p', '--github-mobile', '--no-wait', '--reuse-app slug', '--sudo-code 123456']) {
    assert.throws(() => upRequestFromArgs(['--repo', 'acme/fresh', ...flag.split(' ')]), /Unknown option/, flag);
  }

  // The one step list: the deploy key sits between the host supervisor and master autonomy, and
  // no step creates an App, serves a manifest or drives a browser.
  assert.deepEqual(upSteps, ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'master-autonomy', 'onboarding', 'accounts', 'harness', 'master-loop']);
  assert.ok(upSteps.indexOf('deploy-key') > upSteps.indexOf('host-supervisor') && upSteps.indexOf('deploy-key') < upSteps.indexOf('master-autonomy'));
  for (const step of upSteps) assert.ok(!/app|manifest|browser/i.test(step), step);

  // Step planning on a fresh repository: a full run walks exactly that list, in order.
  const root = await temporaryDirectory('up-control-plane-steps');
  const events: UpEvent[] = [];
  const result = await runUp(request, dependencies(root, events));
  assert.equal(result.exitCode, 0, result.next);
  const planned = events.filter((event): event is Extract<UpEvent, { kind: 'step' }> => event.kind === 'step' && event.state === 'start').map(event => event.step);
  assert.deepEqual(planned, [...upSteps]);
  for (const step of ['deploy-key', 'host-supervisor', 'master-autonomy']) assert.ok(events.some(event => event.kind === 'step' && event.step === step && event.state === 'done'), `${step} is planned and run`);
  assert.ok(!/manifest|browser|github mobile|confirm-access|sudo|drive/i.test(JSON.stringify(events)), JSON.stringify(events));
});

/** A simulated host whose fresh run goes green: the repository exists, the plane answers, the loop runs. */
function dependencies(root: string, events: UpEvent[]): UpDependencies {
  let clock = 0;
  return {
    root, pollMs: 1, emit: event => { events.push(event); }, now: () => clock, sleep: async ms => { clock += ms; },
    serverUrl: async () => SERVER, masterToken: async () => 'm'.repeat(40), operatorToken: async () => 'a'.repeat(40),
    status: async () => ({
      fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, eligible: true }] },
      setup: { loop: true },
    }),
    publishOnboarding: async () => null,
    // The control plane is the merge writer: the repository exists and the deploy key is registered.
    gh: async () => ({ code: 0, stdout: '{}' }), git: async () => ({ code: 0, stdout: '', stderr: '' }),
    installDirectory: () => join(root, 'install'), ensureDeployKey: async () => 'registered',
    async cli(args) {
      if (args[0] === 'install' && args.includes('--plan')) return { code: 0, stdout: JSON.stringify({ preflight: [{ name: 'GitHub CLI', ok: true }] }) };
      return { code: 0, stdout: '{}' };
    },
  };
}
