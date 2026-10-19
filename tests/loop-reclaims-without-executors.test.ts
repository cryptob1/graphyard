import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { daemonEffects, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { apiRoutes } from '../src/server/index.js';
import { matchRoute } from '../src/server/routes.js';
import { supervisedUnits } from '../src/install/host.js';
import { perInstallUnits } from '../src/install/units.js';
import type { Work } from '../src/model.js';

/**
 * GY-1984. One loop: the executor fleet and its action-claim queue are gone. The one handler the loop
 * did not already run — reclaiming a lapsed lease — is the loop's reclaim step now: it sends the
 * control plane's resync for the item in the cycle that sees the lapse, and the loop's own dispatch
 * step offers the freed item again. Nothing claims action rows any more.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'bin/graphyard.mjs');
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

async function setup() {
  const directory = await temporaryDirectory('loop-reclaims');
  const file = join(directory, 'alpha.token');
  await writeFile(file, 'alpha-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const workers = [{ name: 'alpha', principal: 'alpha-principal', agentName: 'agent-alpha', mode: 'launch', kind: 'claude', credentialFile: file, agentArgs: [], environment: {} } as unknown as WorkerProfile];
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', herdrWorkspace: 'w1',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers });
  return { directory, master };
}

/** An item held by an attempt whose lease lapsed ten minutes ago with nothing submitted. */
const lapsed = (): Work => ({
  id: 'work-1984', key: 'GY-1984', title: 'One loop', description: '', type: 'chore', priority: 1,
  dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
  policy: { checks: ['test'], review: true }, plannedFiles: ['src/a.ts'], stage: 'build', revision: 3, policyRevision: 1,
  createdAt: iso(-3_600_000), updatedAt: iso(-600_000), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 1,
  lease: { owner: 'alpha-principal', epoch: 1, expiresAt: iso(-600_000) },
  lastAssignment: { owner: 'alpha-principal', epoch: 1, claimedAt: iso(-3_600_000) },
  sessions: [], workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
} as unknown as Work);

function harness(item: { current: Work[] }) {
  const log = { reclaimed: [] as string[], dispatches: [] as string[] };
  const effects: DaemonEffects = {
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: item.current, now: new Date(clock).toISOString() }),
    closeSession: () => {},
    dispatch: async (work, profile) => { log.dispatches.push(`${work.key}:${profile.name}`); },
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    recordSession: async () => {},
    // The control plane's reconciliation clears the lapse, as `POST work/:id/resync` does.
    reclaimLease: async work => {
      log.reclaimed.push(work.key);
      item.current = item.current.map(entry => entry.id === work.id ? { ...entry, lease: null, revision: entry.revision + 1 } as Work : entry);
      return { work: item.current[0] };
    },
  };
  return { log, effects };
}

test('unit:loop-reclaims-without-executors — a lapsed lease is resynced by the loop\'s reclaim step in the cycle that sees it, with no executor running, and the loop\'s own dispatch offers the item again', async () => {
  const { master } = await setup();
  const item = { current: [lapsed()] };
  const { log, effects } = harness(item);
  const state = emptyDaemonState(master);
  await runCycle(master, state, effects, () => clock);
  assert.deepEqual(log.reclaimed, ['GY-1984'], 'the cycle that sees the lapse asks for the reconciliation once');
  assert.ok(Object.keys(state.actions).some(key => key === 'reclaim:lease:work-1984:1'), 'the reclaim is recorded on the cursor');
  assert.equal(item.current[0].lease, null);

  await runCycle(master, state, effects, () => clock + 60_000);
  assert.deepEqual(log.reclaimed, ['GY-1984'], 'a cleared lease is never resynced again');
  assert.deepEqual(log.dispatches, ['GY-1984:alpha'], 'implementation dispatch is the loop\'s own step');
});

test('unit:loop-reclaims-without-executors — the production reclaim is one empty-body POST work/:id/resync', async () => {
  const { directory, master } = await setup();
  const posts: { path: string; data: unknown }[] = [];
  const effects = daemonEffects(directory, master, { snapshot: async () => ({ work: [], now: iso(0) }), mutate: async (path: string, data: unknown) => { posts.push({ path, data }); return {}; } } as Parameters<typeof daemonEffects>[2]);
  await effects.reclaimLease!(lapsed());
  assert.deepEqual(posts, [{ path: 'work/work-1984/resync', data: {} }]);
});

test('unit:executor-fleet-removed — the executor process, fleet, presence model and unit template are gone, the action claim routes answer nothing, and a host install supervises the loop alone', () => {
  for (const file of ['src/executor.ts', 'src/executor-fleet.ts', 'scripts/graphyard-executor.mjs', 'src/model/executor-presence.ts', 'examples/master/graphyard-executor@.service'])
    assert.equal(existsSync(join(root, file)), false, `${file} is deleted`);
  // The operator-agent guard matches every /api/ path and passes it on (`Next`); only a resource route answers one.
  const routed = (method: string, path: string) => apiRoutes.some(module => module.name !== 'operator-agent-scope' && module.routes.some(route => matchRoute(route, method, path)));
  const row = 'a'.repeat(32);
  for (const path of ['/api/actions/claim', '/api/actions/presence', `/api/actions/${row}/renew`, `/api/actions/${row}/settle`, `/api/actions/${row}/remedy`])
    assert.equal(routed('POST', path), false, `POST ${path} has no route`);
  // What remains: the read-only action rows and the resync the loop's reclaim sends.
  assert.equal(routed('GET', '/api/actions'), true);
  assert.equal(routed('POST', '/api/work/work-1984/resync'), true);
  const layout = { userUnitDirectory: '/home/graphyard/.config/systemd/user' } as Parameters<typeof supervisedUnits>[0];
  assert.deepEqual(supervisedUnits(layout, perInstallUnits('owner/project')).map(unit => unit.role), ['master loop']);
  assert.doesNotMatch(readFileSync(join(root, 'src/install/host.ts'), 'utf8'), /graphyard-executor\.mjs/, 'the host install runs no executor installer');
});
