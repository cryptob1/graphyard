import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { concurrentOverlap } from '../src/coordination.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { assertDispatchable, dispatchWork, masterConfigSchema, setupMaster, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const later = iso(600_000), earlier = iso(-600_000);

function work(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(0),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
const claimed = (key: string, overrides: Partial<Work> = {}) => work(key, { stage: 'build', epoch: 1, lease: { owner: `${key}-worker`, epoch: 1, expiresAt: later }, ...overrides });
/** A submitted candidate observed to change `files`. */
const submitted = (key: string, files: string[], sha = 'a'.repeat(40), overrides: Partial<Work> = {}) => {
  const candidate = { sha, baseSha: 'b'.repeat(40), pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  return work(key, { stage: 'review', epoch: 1, submission: { epoch: 1, pr: 7 }, candidate, observation: { candidate, files, checks: [], reviews: [] } as any, ...overrides });
};
/** A claimed rework whose earlier candidate was observed to change `files`. */
const reworking = (key: string, files: string[], sha = 'f'.repeat(40)) => submitted(key, files, sha, { stage: 'build', reworkRequested: true, lease: { owner: `${key}-worker`, epoch: 2, expiresAt: later } });

test('unit:overlap-detection — overlap is reported from the files candidates were observed to change, against in-flight items only, and holds nothing', () => {
  const item = submitted('GY-1', ['src/cli/master.ts', 'docs/coordination.md'], '1'.repeat(40), { reworkRequested: true });
  const live = reworking('GY-2', ['src/cli/master.ts']);
  const open = submitted('GY-3', ['docs/coordination.md', 'docs/README.md'], 'c'.repeat(40));
  const ready = work('GY-4');
  const expired = submitted('GY-5', ['src/cli/master.ts'], '5'.repeat(40), { reworkRequested: true, lease: { owner: 'gone', epoch: 1, expiresAt: earlier } });
  const delivered = submitted('GY-6', ['src/cli/master.ts'], '6'.repeat(40), { stage: 'done' });
  const disjoint = submitted('GY-7', ['web/pages/index.tsx'], '7'.repeat(40));
  const all = [item, live, open, ready, expired, delivered, disjoint];
  assert.deepEqual(concurrentOverlap(item, all, clock).map(entry => [entry.key, entry.state, entry.paths, entry.theirs]), [
    ['GY-2', 'claimed', ['src/cli/master.ts'], ['src/cli/master.ts']],
    ['GY-3', 'submitted', ['docs/coordination.md'], ['docs/coordination.md']],
  ], 'a ready peer, an expired rework, delivered work and disjoint files are not ahead of the item');
  assert.doesNotThrow(() => assertDispatchable(item, all, iso(0)), 'the overlap is reported, never held on');
  assert.deepEqual(concurrentOverlap(work('GY-9'), all, clock), [], 'an item with no observed candidate overlaps nothing');
  assert.deepEqual(concurrentOverlap(submitted('GY-12', ['src/cli/master.ts'], '2'.repeat(40), { reworkRequested: true }), [expired], clock), [], 'a reworked candidate nobody has claimed is a peer waiting for a worker, not in flight');
});

test('unit:overlap-detection — dispatch never holds an overlapping item, exclusive resources still refuse, and the dispatch plan carries no holds', async () => {
  const item = submitted('GY-1', ['src/cli/master.ts'], '1'.repeat(40), { reworkRequested: true });
  const live = reworking('GY-2', ['src/cli/master.ts']);
  assert.doesNotThrow(() => assertDispatchable(item, [item, live], iso(0)));
  const reserved = claimed('GY-3', { exclusiveResources: ['staging'] });
  assert.throws(() => assertDispatchable(work('GY-4', { exclusiveResources: ['staging'] }), [reserved], iso(0)), /exclusive resources/);

  // `master dispatch` launches the overlapping item with no override and records the overlap.
  const root = await temporaryDirectory('overlap'); const credentialDirectory = await temporaryDirectory('overlap-credentials');
  try {
    execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
    const herdr = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'p1', tab_id: 't1' }, tab: { tab_id: 't1' } } : {} });
    const prepare = async () => ({ epoch: 2, path: join(root, 'assigned'), base: 'c'.repeat(40) });
    const result = await dispatchWork(root, item, profile, [], herdr, [item, live], prepare, async () => {}, 1, iso(0));
    assert.match(result.ownership, /supervising/);
    assert.deepEqual(result.overlap?.concurrent.map(entry => entry.key), ['GY-2']); assert.match(result.overlap?.note ?? '', /lands second/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

function daemonConfig(credentialFile: string, workers: WorkerProfile[]): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers });
}
const launchProfile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });

test('integration:overlap-scheduler — the durable loop offers ready items oldest first and dispatches an overlapping item beside the one in flight', async () => {
  const directory = await temporaryDirectory('overlap-daemon');
  try {
    const token = join(directory, 'coordinator.token'); await writeFile(token, coordinatorToken, { mode: 0o600 });
    const credential = join(directory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    const master = daemonConfig(token, [launchProfile('one', credential), launchProfile('two', credential), launchProfile('three', credential)]);
    const older = work('GY-older', { createdAt: iso(-7_200_000) });
    const newer = work('GY-newer', { createdAt: iso(-60_000) });
    const overlapping = submitted('GY-overlap', ['src/cli/index.ts'], '9'.repeat(40), { createdAt: iso(-3_600_000), reworkRequested: true });
    const inFlight = submitted('GY-inflight', ['src/cli/index.ts']);
    let snapshotWork = [older, newer, overlapping, inFlight];
    const log: string[] = [];
    const effects: DaemonEffects = {
      agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: snapshotWork, now: iso(0) }),
      closeSession: () => {}, dispatch: async (item, profile) => { log.push(`${item.key}→${profile.name}`); },
      persist: async () => {},
    };
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.deepEqual(log, ['GY-overlap→one', 'GY-older→two', 'GY-newer→three'], 'the returned rework first, then oldest first; the item overlapping GY-inflight is not held');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:overlap-holds-nothing — whatever the priority or pull-request state, an overlapping item is dispatchable', () => {
  const hotspot = 'src/master-daemon.ts';
  const ahead = [
    claimed('GY-161', { priority: 0 }),
    reworking('GY-179', [hotspot]),
    submitted('GY-166', ['src/'], '1'.repeat(40), { priority: 0, observation: { files: [hotspot], prState: 'open' } as any }),
    submitted('GY-168', ['src/'], '2'.repeat(40), { priority: 0, observation: { files: [hotspot], prState: 'closed' } as any, lease: { owner: 'w', epoch: 2, expiresAt: later } }),
  ];
  const candidates = [
    work('GY-172', { priority: 2 }),
    work('GY-177', { priority: 2 }),
    submitted('GY-175', ['src/'], '3'.repeat(40), { priority: 2, reworkRequested: true, observation: { files: [hotspot], prState: 'open' } as any }),
  ];
  const all = [...ahead, ...candidates];
  assert.ok(concurrentOverlap(candidates[2], all, clock).length > 0, 'GY-175 overlaps work in flight');
  for (const item of candidates) assert.doesNotThrow(() => assertDispatchable(item, all, iso(0)), `${item.key} is dispatchable`);
});
