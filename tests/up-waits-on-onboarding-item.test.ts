import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { LoopCodeReading } from '../src/repository-setup.js';
import { upExitCodes, type UpDependencies, type UpEvent, type UpRequest, type UpResult } from '../src/up.js';

/**
 * GY-2938: `up`'s onboarding wait reads the onboarding work item from the control plane and moves on
 * when GY-1 reaches done — it never reads a GitHub pull request (there is none: the change is
 * submitted by head sha). A GY-1 that stays in build past the --wait bound ends the run with exit 3
 * naming GY-1 and its gate reason.
 */
// Loaded inside each test, so a tree without them fails as a test case, not at load.
const up = () => import('../src/up.js');

const yieldTurn = () => new Promise<void>(accept => setImmediate(accept));
const SERVER = 'http://127.0.0.1:4310';
const COMMIT = 'c'.repeat(40);
/** A reading whose loop already runs this CLI's code: the master-loop step passes it. */
const cleanReading = (): LoopCodeReading => ({
  loop: { unit: 'graphyard-master-acme-shop.service', path: '/units/graphyard-master-acme-shop.service', checkout: '/install/graphyard' },
  loopCommit: 'a'.repeat(40),
  cli: { root: '/install/graphyard', commit: 'a'.repeat(40) },
  repository: 'acme/shop',
  loopStale: null,
  error: null,
});

/** The onboarding item as the control plane answers it: first in build, then done. */
const building = {
  key: 'GY-1', title: 'Add Graphyard onboarding', stage: 'build', createdAt: '2026-01-01T00:00:00Z', closure: null,
  workspaces: [{ epoch: 1, branch: 'graphyard/onboarding' }],
  gates: [
    { name: 'build', passed: true, reasons: [] },
    { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] },
    { name: 'test', passed: true, reasons: [] },
    { name: 'merge', passed: false, reasons: ['The merge writer has not observed the current candidate'] },
  ],
};
const done = { ...building, stage: 'done', gates: building.gates.map(gate => ({ ...gate, passed: true, reasons: [] })) };

interface UpWorld {
  /** Each work-snapshot answer, in call order; the last one repeats. */
  work: (typeof building | typeof done)[];
  reads: number;
}

const world = (work: UpWorld['work']): UpWorld => ({ work, reads: 0 });

function dependencies(root: string, events: UpEvent[], w: UpWorld, over: Partial<UpDependencies> = {}): UpDependencies {
  let clock = 0;
  return {
    root, pollMs: 1, humanWaitMs: 50, machineWaitMs: 200,
    emit: event => events.push(event),
    now: () => clock,
    sleep: async ms => { clock += ms; await yieldTurn(); },
    serverUrl: async () => SERVER,
    masterToken: async () => 'm'.repeat(40),
    status: async () => ({
      githubRepository: 'acme/shop',
      mergeWriter: { merger: 'control-plane' },
      fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-b'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, eligible: true }, { name: 'claude-b', enabled: true, loggedIn: true, eligible: true }] },
      setup: { protection: 'checks', loop: true },
    }),
    // No pull request is ever read: any gh invocation fails the run.
    gh: async () => { throw new Error('gh ran during up'); },
    publishOnboarding: async () => ({ commit: COMMIT }),
    fileOnboarding: async () => ({ key: 'GY-1' }),
    work: async () => { w.reads++; return [w.work.length > 1 ? w.work.shift() : w.work[0]]; },
    signIn: async () => `${SERVER}/#sign-in=${'s'.repeat(43)}`,
    installDirectory: () => '/install/acme-shop',
    cli: async args => ({ code: 0, stdout: args.includes('--apply') && args[0] === 'init' ? '{"delivery":{"workflows":[]}}' : '{}' }),
    loopCode: async () => cleanReading(),
    ...over,
  };
}

const request = (): UpRequest => ({ repository: 'acme/shop', provider: 'compose', agent: true, reviewer: 'claude', master: 'claude', browserProfile: null, merger: 'control-plane' });

/** A root whose up state records every step but onboarding done, so a run reaches the onboarding step alone. */
async function resumedRoot(label: string, state: Record<string, unknown> = {}) {
  const root = await temporaryDirectory(label);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'up.json'), JSON.stringify({
    version: 1, repository: 'acme/shop', provider: 'compose', merger: 'control-plane', noHerdr: false, goal: null,
    completed: ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'master-autonomy'], ...state,
  }));
  return root;
}

const stepEvents = (events: UpEvent[]) => events.filter((event): event is Extract<UpEvent, { kind: 'step' }> => event.kind === 'step');

test('unit:up-waits-on-onboarding-item-not-pr — up files the onboarding commit, proceeds to the accounts step, and its wait moves on when the control plane moves GY-1 to done, reading no pull request', async () => {
  const { runUp } = await up();
  const w = world([building, done]);
  const events: UpEvent[] = [];
  const root = await resumedRoot('up-waits-onboarding-done');
  const result: UpResult = await runUp(request(), dependencies(root, events, w));
  assert.equal(result.exitCode, upExitCodes.green, result.next);
  const steps = stepEvents(events).map(event => `${event.step}:${event.state}`);
  const onboardingDone = steps.indexOf('onboarding:done'), accountsStart = steps.indexOf('accounts:start');
  assert.ok(onboardingDone >= 0 && accountsStart > onboardingDone, `up proceeds to the accounts step after onboarding: ${steps.join(' ')}`);
  const waits = events.filter((event): event is Extract<UpEvent, { kind: 'onboarding' }> => event.kind === 'onboarding');
  assert.ok(waits.length >= 1, 'the wait shows the onboarding item');
  assert.deepEqual(waits[waits.length - 1].wait.waitingFor, [], 'the last reading waits for nothing: GY-1 is done');
  assert.equal(result.onboarding?.merged, true, 'the run answers the onboarding change as merged');
  assert.ok(w.reads >= 2, `the wait polled the control plane's work (${w.reads} reads)`);
  // The run state: the item stays recorded, and no pull request (nor a separate published commit) is.
  const state = JSON.parse(await readFile(join(root, '.graphyard', 'up.json'), 'utf8'));
  assert.equal(state.onboardingWork, 'GY-1');
  assert.ok(!('onboardingCommit' in state), 'no published commit is recorded: the item is the only truth the wait reads');
  assert.ok(!('onboardingPullRequest' in state), 'no pull request is recorded');
});

test('unit:up-waits-on-onboarding-item-not-pr — a GY-1 that stays in build past the --wait bound ends the run with exit 3 naming GY-1 and its gate reason', async () => {
  const { runUp } = await up();
  const w = world([building]);
  const events: UpEvent[] = [];
  const root = await resumedRoot('up-waits-onboarding-stuck');
  const result: UpResult = await runUp(request(), dependencies(root, events, w, { humanWaitMs: 5 }));
  assert.equal(result.exitCode, upExitCodes.waiting, result.next);
  assert.match(result.next, /GY-1/, 'the timeout names the onboarding item');
  assert.match(result.next, /Independent approval of the current commit is required/, 'the timeout names the gate reason');
});
