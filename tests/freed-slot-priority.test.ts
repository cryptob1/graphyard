import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { Launcher, runCycle } from '../src/daemon/cycle.js';
import { dispatchKey } from '../src/daemon/reconcile.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { readySpecCheck } from './helpers/spec-check.js';

// GY-3149: two items waiting for a worker slot; the freed slot goes to the priority-0 one.
const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const work = (key: string, priority: number): Work => ({
  id: `id-${key}`, key, title: `Hotfix: ${key}`, description: '', type: 'feature', priority, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
  policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(-3_600_000),
  ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  specCheck: readySpecCheck(new Date().toISOString()), gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
} as Work);
const profile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });

test('unit:freed-slot-goes-to-highest-priority — a priority-1 item never launches while the priority-0 item waits for a slot, and the freed slot goes to the priority-0 item', async () => {
  const directory = await temporaryDirectory('freed-slot-priority');
  const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const credential = join(directory, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: cli, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile('worker-1', credential), profile('worker-2', credential)] });
  const items = [work('GY-1', 1), work('GY-0', 0)];
  let slots = 0;
  const launched: string[] = [], attempted: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [], credentials: async list => Object.fromEntries(list.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: items, now: iso(0) }),
    closeSession: () => {}, persist: async () => {},
    dispatch: async item => {
      attempted.push(item.key);
      if (slots === 0) throw Object.assign(new Error('role worker is at its concurrency limit (5 of 5 live)'), { roleAtCapacity: 'role worker is at its concurrency limit (5 of 5 live)' });
      slots -= 1; launched.push(item.key);
    },
  };
  const state = emptyDaemonState(master), launcher = new Launcher();
  for (let cycle = 0; cycle < 3; cycle++) { await runCycle(master, state, effects, () => clock, launcher); await launcher.idle(); }
  assert.equal(state.actions[dispatchKey(items[1])].state, 'waiting');
  assert.deepEqual(launched, []);
  assert.ok(!attempted.includes('GY-1'), 'the priority-1 item never asks for the slot');
  slots = 1;
  await runCycle(master, state, effects, () => clock, launcher); await launcher.idle();
  assert.deepEqual(launched, ['GY-0']);
});
