import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { Launcher, runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { dispatchSort } from '../src/coordination.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3504: the submitted-first rank (GY-1891) holds only while an item has fewer than four rework
// rounds; from the fourth it sorts with fresh work by starvation, heat and age, so an item that
// cannot converge no longer starves everything else of its priority.
const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const fresh = (key: string, ageMinutes: number) =>
  workFixture({ key, priority: 1, createdAt: iso(-ageMinutes * 60_000), updatedAt: iso(0), stageEnteredAt: iso(-ageMinutes * 60_000) });
/** Returned for rework `rounds` times; the newest item, so age alone would put it last. */
const reworked = (key: string, rounds: number) => workFixture({ key, priority: 1, createdAt: iso(-60_000), updatedAt: iso(0), stageEnteredAt: iso(-60_000),
  pipeline: { attempts: [{ epoch: rounds, owner: `${key}-worker`, claimedAt: iso(-120_000), endedAt: iso(-60_000), end: 'submitted' }], submittedAt: iso(-120_000), resubmittedAt: iso(-60_000), reworkRounds: rounds, interventions: { blocked: 0, requirements: 0 } } });
const profile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });

/** Runs the real loop cycle with `workers` worker profiles until nothing is left to launch; returns each cycle's launches. */
async function launches(items: Work[], workers: number) {
  const directory = await temporaryDirectory('rework-yields-to-fresh');
  const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const credential = join(directory, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: cli, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: Array.from({ length: workers }, (_, index) => profile(`worker-${index + 1}`, credential)) });
  let waiting = [...items];
  const cycles: string[][] = [];
  const effects: DaemonEffects = {
    agents: () => [], credentials: async list => Object.fromEntries(list.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: waiting, now: iso(0) }),
    closeSession: () => {}, persist: async () => {},
    // A launched item leaves the ready set, as a claimed lease takes it out of dispatch; its slot frees by the next cycle.
    dispatch: async item => { cycles.at(-1)!.push(item.key); waiting = waiting.filter(other => other.key !== item.key); },
  };
  const state = emptyDaemonState(master), launcher = new Launcher();
  while (waiting.length && cycles.length < items.length) { cycles.push([]); await runCycle(master, state, effects, () => clock, launcher); await launcher.idle(); }
  return cycles;
}

test('integration:rework-yields-to-fresh — with one free slot a 3-round rework goes first, then five fresh priority-1 items in age order, and a 6-round rework only after them', async () => {
  const items = [reworked('GY-six', 6), fresh('GY-f3', 30), fresh('GY-f1', 50), reworked('GY-three', 3), fresh('GY-f5', 10), fresh('GY-f2', 40), fresh('GY-f4', 20)];
  const order = ['GY-three', 'GY-f1', 'GY-f2', 'GY-f3', 'GY-f4', 'GY-f5', 'GY-six'];
  assert.deepEqual(dispatchSort(items, new Set(), clock).map(item => item.key), order, 'dispatchSort: rounds 1-3 keep the attempted-first rank, from round 4 the item sorts with fresh work by age');
  assert.deepEqual((await launches(items, 1)).flat(), order, 'the loop offers its one slot in that order');
  assert.deepEqual(dispatchSort([reworked('GY-four', 4), fresh('GY-old', 50)], new Set(), clock).map(item => item.key), ['GY-old', 'GY-four'], 'the fourth round already yields');
  assert.deepEqual(dispatchSort([reworked('GY-six', 6), workFixture({ ...fresh('GY-p2', 50), priority: 2 })], new Set(), clock).map(item => item.key), ['GY-six', 'GY-p2'], 'priority still decides first');
});

test('e2e:rework-yields-to-fresh — with two worker slots the loop launches two fresh equal-priority items before a ready item on its fifth rework round, and the rework when a slot frees', async () => {
  const cycles = await launches([reworked('GY-rework', 5), fresh('GY-fresh-a', 30), fresh('GY-fresh-b', 20)], 2);
  assert.deepEqual(cycles, [['GY-fresh-a', 'GY-fresh-b'], ['GY-rework']]);
});
