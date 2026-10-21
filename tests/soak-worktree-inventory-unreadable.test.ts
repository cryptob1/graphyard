import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { inventoryWorktrees, loadMasterConfig, setupMaster, worktreesDirectory, writeWorktreeInventoryCache } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { readDisk, readResources, resourceAttention } from '../src/master-resources.js';
import { worktreePassOf } from '../src/master/worktree-disk.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1793. The inventory the disk reading judges its plan on used to come from the cache the loop's
 * reclaim step keeps whatever the worktrees directory had become, so a directory that turned
 * unreadable under a drained cache read as nothing disposable and answered the warn-line fault for
 * the cache's currency window. Over simulated cycles of the real loop: a readable directory under a
 * drained pass answers the low reading; the directory turns unreadable (the pass failing with it, as
 * a real pass does) while the cache stands, and the reading is never answered however many cycles
 * pass; it becomes readable again and the cached reading answers once more; every system invariant
 * holds across the whole interval. Instants are relative to the clock this test runs on.
 */
const minute = 60_000, hour = 60 * minute, cycleMs = 4 * minute;
const totalBytes = 1_022_000_000_000, threshold = 10_000_000_000;

const work = (key: string, path: string, branch: string): Work =>
  ({ id: `id-${key}`, key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'build', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '',
    ready: false, epoch: 1, lease: null, workspaces: [{ host: 'vishrog', path, branch, epoch: 1, owner: 'graphyard-worker-1' }], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], }) as Work;

test('unit:soak-worktree-inventory-unreadable — over simulated cycles a worktrees directory that turns unreadable under a drained cache never answers the warn-line fault, and answers again when readable, with every system invariant holding', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-inventory-unreadable');
  const credentials = await temporaryDirectory('soak-inventory-unreadable-credentials');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    for (const [key, value] of [['user.email', 'soak@example.com'], ['user.name', 'Soak Test'], ['commit.gpgsign', 'false']]) execFileSync('git', ['config', key, value], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await writeFile(join(root, '.gitignore'), 'node_modules/\n.graphyard/\n');
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'graphyard', lockfileVersion: 3, packages: {} }, null, 2));
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    const config10 = await loadMasterConfig(root);
    config10.run.diskThresholdGb = 10;
    const start = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const trees = worktreesDirectory(root), aside = `${trees}-aside`;
    /** One finished-looking tree holding an install a pass could take: the item's lease is gone, so it is disposable once the directory is read. */
    const tree = join(trees, 'GY-93-1');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', tree, 'main'], { cwd: root });
    await mkdir(join(tree, 'node_modules', 'pg'), { recursive: true });
    await writeFile(join(tree, 'node_modules', 'pg', 'index.js'), 'shared');
    const item = { ...work('GY-93', tree, 'graphyard/gy-93-1'), lease: { owner: 'graphyard-worker-1', epoch: 1, expiresAt: iso(start + 6 * hour) } } as Work;
    let freeBytes = 9_900_000_000, unreadable = false;
    let now = start;
    const state = emptyDaemonState(config10);
    /** The directory turns unreadable the way a failing volume does: its name still resolves, and reading it fails with something other than ENOENT. */
    const turnUnreadable = async () => { await rename(trees, aside); await writeFile(trees, 'a file where the directory was'); unreadable = true; };
    const turnReadable = async () => { await rm(trees, { force: true }); await rename(aside, trees); unreadable = false; };
    const reportedAttention = async (snapshot: Work[]) => {
      const read = (await readDisk(root, config10, { reclaim: worktreePassOf(state.reclaim), open: state.faults.open }, { work: snapshot, now }))!;
      return { items: resourceAttention(readResources({ now, reviews: [], producers: [], agents: [], work: snapshot, plane: null, loop: null, revision: null,
        profiles: { workers: [], reviewers: [], producers: [] }, disk: { ...read, totalBytes, freeBytes } })) };
    };
    /** The cycle's pass: while readable it walks the real trees and leaves the cache it scanned (the install is left in place: the item holds its lease); while unreadable it fails, as a pass over such a directory does. */
    const reclaim = async () => {
      if (unreadable) throw new Error('Simulated EIO reading the worktrees directory');
      const entries = await inventoryWorktrees(root, now);
      await writeWorktreeInventoryCache(root, { at: iso(now), entries, held: [] });
      return { root: trees, at: iso(now), applied: true, scanned: entries.length, removed: [], kept: [], freeBefore: freeBytes, freeAfter: freeBytes, freedBytes: 0, errors: [],
        trees: { at: iso(now), limit: 2, removed: [], kept: [], backlog: 0, held: [], errors: [] } };
    };
    const effects = {
      agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {},
      recordDeployment: async () => {}, persist: async () => {},
      snapshot: async () => ({ work: [item], now: iso(now) }),
      observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
      controlPlane: async () => ({ build: { commit: null } }),
      reportedAttention, reclaim,
    } as unknown as DaemonEffects;
    const cycle = async () => {
      now += cycleMs;
      await runCycle(config10, state, effects, () => now);
      const violations = state.invariants.report.filter(check => !check.holds).map(check => `${check.invariant}: ${check.reading}`);
      assert.deepEqual(violations, [], `cycle at +${Math.round((now - start) / minute)} min: every system invariant holds`);
      const items = (await reportedAttention([item])).items.filter(entry => entry.subject === 'resource:worktree-disk').map(entry => entry.subject);
      const disk = (await readDisk(root, config10, { reclaim: worktreePassOf(state.reclaim), open: state.faults.open }, { work: [item], now }))!;
      const reading = readResources({ now, reviews: [], producers: [], agents: [], work: [item], plane: null, loop: null, revision: null,
        profiles: { workers: [], reviewers: [], producers: [] }, disk: { ...disk, totalBytes, freeBytes } }).find(entry => entry.resource === 'worktree-disk')!;
      const instances = Object.keys(state.faults.open).filter(key => key.startsWith('resource-bound|resource:worktree-disk|')).length;
      return { items, reading, instances };
    };
    // Phase A — readable, a pass has drained: the low reading is answered and nothing opens.
    for (let index = 0; index < 3; index++) {
      const step = await cycle();
      assert.deepEqual(step.items, [], `readable cycle ${index}: the drained pass answers the low reading`);
      assert.equal(step.instances, 0);
      assert.equal(step.reading.answered, true);
    }
    // Phase B — the directory turns unreadable under that cache, and stays so across the cache's whole currency window and beyond.
    await turnUnreadable();
    let raised = false;
    for (let index = 0; index < 12; index++) {
      const step = await cycle();
      assert.equal(step.reading.answered, undefined, `unreadable cycle ${index}: the cached empty reading never answers the fault`);
      if (step.instances === 1) raised = true;
      if (raised) assert.deepEqual(step.items, ['resource:worktree-disk'], `unreadable cycle ${index}: the raised line stays raised`);
    }
    assert.equal(raised, true, 'the unanswered low reading opened its instance while the directory was unreadable');
    // Phase C — readable again: the pass walks the trees, the reading is judged on the real inventory once more, and the one instance never multiplied.
    await turnReadable();
    for (let index = 0; index < 3; index++) {
      const step = await cycle();
      assert.equal(step.instances, 1, `recovery cycle ${index}: the same single instance`);
    }
    freeBytes = threshold + 2_000_000_000;
    for (let index = 0; index < 4; index++) await cycle();
    const recovered = await cycle();
    assert.deepEqual(recovered.items, [], 'recovered above the line, the registry line is silent');
    assert.equal(recovered.instances, 0, 'and the instance ended');
    assert.equal(state.faults.instances.filter(instance => instance.subject === 'resource:worktree-disk').length, 1, 'the whole interval left one instance on the record');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});
