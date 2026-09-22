import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { broadScope, dispatchOrder, dispatchOverlap, scopeBreadth } from '../src/coordination.js';
import { candidateConflicts, fetchCandidateHeads, gitConflictProbe } from '../src/conflicts.js';
import { assertDispatchable, buildMasterStatus, dispatchSchedule, dispatchWork, masterConfigSchema, sequenceAdvice, setupMaster, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const later = iso(600_000), earlier = iso(-600_000);

function work(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(0),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
const claimed = (key: string, plannedFiles: string[], overrides: Partial<Work> = {}) => work(key, { stage: 'build', plannedFiles, epoch: 1, lease: { owner: `${key}-worker`, epoch: 1, expiresAt: later }, ...overrides });
const submitted = (key: string, plannedFiles: string[], sha = 'a'.repeat(40), overrides: Partial<Work> = {}) => work(key, { stage: 'review', plannedFiles, epoch: 1, submission: { epoch: 1, pr: 7 },
  candidate: { sha, baseSha: 'b'.repeat(40), pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, ...overrides });

test('unit:overlap-detection — planned-file overlap holds an item behind claimed and unmerged submitted items only', () => {
  const item = work('GY-1', { plannedFiles: ['src/cli/', 'docs/coordination.md'] });
  const live = claimed('GY-2', ['src/cli/master.ts']);
  const open = submitted('GY-3', ['docs/'], 'c'.repeat(40), { observation: { files: ['docs/coordination.md', 'docs/README.md'] } as any });
  const ready = work('GY-4', { plannedFiles: ['src/cli/'] });
  const expired = claimed('GY-5', ['src/cli/'], { lease: { owner: 'gone', epoch: 1, expiresAt: earlier } });
  const delivered = work('GY-6', { stage: 'done', plannedFiles: ['src/cli/'], submission: { epoch: 1, pr: 1 } });
  const disjoint = claimed('GY-7', ['web/pages/']);
  const quarantined = work('GY-8', { stage: 'build', plannedFiles: ['docs/coordination.md'], lease: { owner: 'old', epoch: 1, expiresAt: earlier }, containmentQuarantine: { owner: 'old', epoch: 1, at: earlier, settlementHash: 'a'.repeat(64) } as any });
  const all = [item, live, open, ready, expired, delivered, disjoint, quarantined];
  const ahead = dispatchOverlap(item, all, clock);
  assert.deepEqual(ahead.map(entry => [entry.key, entry.state, entry.paths, entry.theirs]), [
    ['GY-2', 'claimed', ['src/cli/'], ['src/cli/master.ts']],
    ['GY-3', 'submitted', ['docs/coordination.md'], ['docs/coordination.md']],
    ['GY-8', 'claimed', ['docs/coordination.md'], ['docs/coordination.md']],
  ], 'a ready peer, an expired lease, delivered work and a disjoint scope are not ahead of the item; a submitted item is judged by the files its candidate changed, not the docs/ it declared');
  assert.deepEqual(dispatchOverlap(ready, [ready, item], clock), [], 'two ready items hold nothing; dispatchOrder decides between them');
  assert.deepEqual(dispatchOverlap(work('GY-9'), all, clock), [], 'an item with no planned files overlaps nothing');
  const rework = submitted('GY-10', ['src/cli/'], 'd'.repeat(40), { reworkRequested: true, observation: { files: ['src/cli/index.ts'] } as any });
  assert.deepEqual(dispatchOverlap(rework, [rework, live], clock), [], 'rework is judged by the files its candidate changed, not the src/cli/ it declared: GY-2 on src/cli/master.ts is no conflict');
  assert.deepEqual(dispatchOverlap(rework, [rework, claimed('GY-11', ['src/cli/index.ts'])], clock).map(entry => entry.key), ['GY-11'], 'the same file changed on both sides still holds');
  assert.deepEqual(dispatchOverlap(work('GY-12', { plannedFiles: ['src/cli/index.ts'] }), [rework], clock), [], 'a reworked candidate nobody has claimed is a peer waiting for a worker, not an item ahead');
});

test('unit:overlap-detection — scope breadth flags root-level directories and orders smallest scope first within a priority', () => {
  assert.ok(broadScope('src/') && broadScope('docs/*') && broadScope('tests/**') && broadScope('/'));
  assert.ok(!broadScope('src/cli/') && !broadScope('src/master.ts') && !broadScope('docs/protocol/'));
  assert.deepEqual(scopeBreadth(['src/', 'src/cli/', 'docs/coordination.md', 'tests/']), { files: 1, directories: 3, broad: ['src/', 'tests/'], highConflict: true });
  assert.deepEqual(scopeBreadth(['src/sync.ts']), { files: 1, directories: 0, broad: [], highConflict: false });
  const wide = work('GY-wide', { plannedFiles: ['src/', 'tests/'] });
  const directory = work('GY-dir', { plannedFiles: ['src/cli/', 'src/master.ts'] });
  const files = work('GY-files', { plannedFiles: ['src/sync.ts', 'src/coordination.ts', 'tests/sync.test.ts'] });
  const single = work('GY-single', { plannedFiles: ['docs/coordination.md'], createdAt: iso(-60_000) });
  const olderSingle = work('GY-older', { plannedFiles: ['docs/master-agent.md'], createdAt: iso(-120_000) });
  const urgent = work('GY-urgent', { plannedFiles: ['src/', 'docs/', 'tests/'], priority: 0 });
  const order = [wide, directory, files, single, olderSingle, urgent].sort(dispatchOrder).map(item => item.key);
  assert.deepEqual(order, ['GY-urgent', 'GY-older', 'GY-single', 'GY-files', 'GY-dir', 'GY-wide'], 'operator priority first, then fewest root directories, directories, files, then age');
});

test('unit:overlap-detection — dispatch holds an overlapping item unless the operator allows the overlap, and the dispatch plan says why', async () => {
  const item = work('GY-1', { plannedFiles: ['src/cli/'] });
  const live = claimed('GY-2', ['src/cli/master.ts']);
  assert.throws(() => assertDispatchable(item, [item, live], iso(0)), /held by planned-file overlap with GY-2 \(claimed, build\) on src\/cli\/.*--allow-overlap/);
  assert.doesNotThrow(() => assertDispatchable(item, [item, live], iso(0), { allowOverlap: true }));
  assert.doesNotThrow(() => assertDispatchable(item, [item, live], iso(1_200_000)), 'an expired lease no longer holds the item');
  // The override is only for the overlap: every other refusal stands.
  const reserved = claimed('GY-3', ['web/'], { exclusiveResources: ['staging'] });
  assert.throws(() => assertDispatchable(work('GY-4', { exclusiveResources: ['staging'] }), [reserved], iso(0), { allowOverlap: true }), /exclusive resources/);
  const plan = dispatchSchedule([item, live, work('GY-5', { plannedFiles: ['docs/', 'docs/coordination.md'] }), work('GY-6', { plannedFiles: ['README.md'] })], clock);
  assert.deepEqual(plan.order.map(entry => [entry.key, entry.held]), [['GY-6', false], ['GY-1', true], ['GY-5', false]], 'the claimed item is not in the plan; the held item keeps its place in the order');
  assert.equal(plan.held[0].key, 'GY-1'); assert.deepEqual(plan.held[0].ahead.map(entry => entry.key), ['GY-2']); assert.match(plan.held[0].reason, /GY-2 \(claimed, build\) on src\/cli\/.*--allow-overlap/);
  assert.deepEqual(plan.highConflict, [{ key: 'GY-5', broad: ['docs/'] }]);

  // `master dispatch --allow-overlap` reaches the launcher as an option; without it the same
  // dispatch is refused before any tab is created.
  const root = await mkdtemp(join(tmpdir(), 'graphyard-overlap-')); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-overlap-credentials-'));
  try {
    execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
    const calls: string[][] = [];
    const herdr = (_command: string, args: string[]) => { calls.push(args); return JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'p1', tab_id: 't1' }, tab: { tab_id: 't1' } } : args[1] === 'get' ? { type: 'agent_info', agent: { pane_id: 'p1', agent_status: 'idle' } } : {} }); };
    const prepare = async () => ({ epoch: 2, path: join(root, 'assigned'), base: 'c'.repeat(40) });
    await assert.rejects(dispatchWork(root, item, profile, [], herdr, [item, live], prepare, async () => {}, 1, iso(0)), /held by planned-file overlap/);
    assert.equal(calls.length, 0, 'a held dispatch creates no session');
    const result = await dispatchWork(root, item, profile, [], herdr, [item, live], prepare, async () => {}, 1, iso(0), { allowOverlap: true });
    assert.match(result.ownership, /supervising/);
    assert.equal(result.overlap?.allowed, true); assert.deepEqual(result.overlap?.ahead.map(entry => entry.key), ['GY-2']); assert.match(result.overlap?.note ?? '', /lands second/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

function daemonConfig(credentialFile: string, workers: WorkerProfile[]): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers });
}
const launchProfile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });

test('integration:overlap-scheduler — the durable loop offers ready items smallest scope first and never dispatches over an overlap on its own', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-overlap-daemon-'));
  try {
    const token = join(directory, 'coordinator.token'); await writeFile(token, coordinatorToken, { mode: 0o600 });
    const credential = join(directory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    const master = daemonConfig(token, [launchProfile('one', credential), launchProfile('two', credential), launchProfile('three', credential)]);
    const wide = work('GY-wide', { plannedFiles: ['web/', 'browser-tests/'], createdAt: iso(-7_200_000) });
    const small = work('GY-small', { plannedFiles: ['docs/coordination.md'], createdAt: iso(-60_000) });
    const overlapping = work('GY-overlap', { plannedFiles: ['src/cli/workspace.ts'], createdAt: iso(-7_200_000) });
    const inFlight = submitted('GY-inflight', ['src/cli/']);
    let snapshotWork = [wide, small, overlapping, inFlight];
    const log: string[] = [];
    const effects: DaemonEffects = {
      agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: snapshotWork, now: iso(0) }),
      closeSession: () => {}, dispatch: async (item, profile) => { log.push(`${item.key}→${profile.name}`); },
      requestProof: () => {}, merge: async () => ({}), observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    };
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.deepEqual(log, ['GY-small→one', 'GY-wide→two'], 'the smaller scope is offered first although the wide item is older; the overlapping item is held with a profile still free');
    assert.equal(state.actions[`dispatch:${overlapping.id}:0`], undefined, 'a held item records no dispatch attempt');
    // The item ahead merges: the hold lifts and the loop dispatches the held item, still on its own.
    log.length = 0;
    snapshotWork = [wide, small, overlapping, { ...inFlight, stage: 'done' } as Work];
    await runCycle(master, state, effects, () => clock + 20_000);
    assert.deepEqual(log, ['GY-overlap→one']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('integration:overlap-scheduler — master status shows the overlap holding each item, broad scopes, and the conflict set of every open candidate', async () => {
  const held = work('GY-held', { plannedFiles: ['src/cli/master.ts', 'docs/'] });
  const live = claimed('GY-live', ['src/cli/']);
  const left = submitted('GY-left', ['src/sync.ts'], 'c'.repeat(40));
  const right = submitted('GY-right', ['src/sync.ts'], 'd'.repeat(40));
  const apart = submitted('GY-apart', ['web/'], 'e'.repeat(40));
  const report = candidateConflicts([held, live, left, right, apart], (a, b) => [a, b].includes('e'.repeat(40)) ? [] : ['src/sync.ts']);
  assert.deepEqual(report, { 'GY-left': { conflicts: [{ key: 'GY-right', files: ['src/sync.ts'] }], unprobed: [] }, 'GY-right': { conflicts: [{ key: 'GY-left', files: ['src/sync.ts'] }], unprobed: [] }, 'GY-apart': { conflicts: [], unprobed: [] } });
  const unprobed = candidateConflicts([left, right], () => null);
  assert.deepEqual(unprobed['GY-left'], { conflicts: [], unprobed: ['GY-right'] }, 'an unfetched head is reported as unprobed, never as conflict-free');
  const status = buildMasterStatus({ work: [held, live, left, right, apart], now: iso(0) }, [], [], {}, {}, { pending: [], completed: [] }, 'main', undefined, undefined, { report, available: true, reason: null });
  const row = (key: string) => status.work.find(entry => entry.key === key)!;
  assert.equal(row('GY-held').overlap.held, true); assert.deepEqual(row('GY-held').overlap.ahead.map(entry => [entry.key, entry.paths]), [['GY-live', ['src/cli/master.ts']]]); assert.match(row('GY-held').overlap.reason!, /--allow-overlap/);
  assert.deepEqual(row('GY-held').scope, { files: 1, directories: 1, broad: ['docs/'], highConflict: true });
  assert.equal(row('GY-live').overlap.held, false);
  assert.deepEqual(row('GY-left').conflicts, { candidates: ['GY-right'], files: [{ key: 'GY-right', files: ['src/sync.ts'] }], unprobed: [], probed: true });
  assert.deepEqual(row('GY-apart').conflicts?.candidates, []); assert.equal(row('GY-held').conflicts, null, 'only open candidates have a conflict set');
  assert.deepEqual(status.schedule.order.map(entry => entry.key), ['GY-held']); assert.deepEqual(status.schedule.highConflict, [{ key: 'GY-held', broad: ['docs/'] }]);
  assert.deepEqual(status.conflicts.sequence, ['GY-apart', 'GY-left', 'GY-right'], 'the fewest-conflict candidate lands first');
  assert.deepEqual(status.conflicts.conflicting, [{ key: 'GY-left', conflicts: ['GY-right'] }, { key: 'GY-right', conflicts: ['GY-left'] }]);
  assert.deepEqual(sequenceAdvice([]), { sequence: [], conflicting: [] });
  const unavailable = buildMasterStatus({ work: [left], now: iso(0) }, [], [], {}, {}, { pending: [], completed: [] }, 'main', undefined);
  assert.equal(unavailable.work[0].conflicts?.probed, false); assert.equal(unavailable.conflicts.available, false); assert.match(unavailable.conflicts.reason!, /not probed/);
});

test('integration:overlap-scheduler — the conflict probe is a real in-memory git merge of the two candidate heads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-merge-tree-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
    await writeFile(join(root, 'shared.txt'), 'a\nb\nc\n'); await writeFile(join(root, 'other.txt'), 'x\n'); git('add', '.'); git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'one'); await writeFile(join(root, 'shared.txt'), 'one\nb\nc\n'); git('commit', '-q', '-am', 'one'); const one = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main'); git('checkout', '-q', '-b', 'two'); await writeFile(join(root, 'shared.txt'), 'two\nb\nc\n'); git('commit', '-q', '-am', 'two'); const two = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main'); git('checkout', '-q', '-b', 'three'); await writeFile(join(root, 'other.txt'), 'y\n'); git('commit', '-q', '-am', 'three'); const three = git('rev-parse', 'HEAD');
    const probe = gitConflictProbe(root);
    assert.deepEqual(probe(one, two), ['shared.txt']); assert.deepEqual(probe(one, three), []); assert.equal(probe(one, 'f'.repeat(40)), null);
    assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'the probe touches no worktree');
    const items = [submitted('GY-one', ['shared.txt'], one), submitted('GY-two', ['shared.txt'], two), submitted('GY-three', ['other.txt'], three)];
    assert.deepEqual(candidateConflicts(items, probe)['GY-one'], { conflicts: [{ key: 'GY-two', files: ['shared.txt'] }], unprobed: [] });
    const fetched: string[][] = [];
    assert.deepEqual(fetchCandidateHeads(root, items, (_command, args) => { fetched.push(args); return ''; }), { fetched: true, reason: null });
    assert.deepEqual(fetched[0].slice(-3), ['+refs/heads/graphyard/gy-one-1:refs/remotes/origin/graphyard/gy-one-1', '+refs/heads/graphyard/gy-two-1:refs/remotes/origin/graphyard/gy-two-1', '+refs/heads/graphyard/gy-three-1:refs/remotes/origin/graphyard/gy-three-1']);
    assert.match(fetchCandidateHeads(root, items, () => { throw new Error('no network'); }).reason!, /could not be fetched: no network/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
