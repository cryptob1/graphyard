import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { inventoryWorktrees, loadMasterConfig, planWorktreeReclaim, setupMaster, worktreeRemovalReason, worktreesDirectory, writeWorktreeInventoryCache, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { disposableWorktrees, readDisk, readResources, resourceAttention } from '../src/master-resources.js';
import { diskRecoveryBandBytes, worktreePassCurrentMs, worktreePassOf } from '../src/master/worktree-disk.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1784 (review of fa5f5848). The worktree-disk gate is judged every cycle from three moving
 * parts — the reclaim pass the cycle records into the cursor, the plan over the current inventory
 * and work snapshot, and the fault record the last cycles left — so its lifetime is a soak's
 * question, not a unit one: over simulated cycles of the real loop, a drained pass that answers,
 * a finished worktree that turns disposable under it, a standing fault held inside the recovery
 * band whatever fresh or ageing passes say, and the exhaustion floor that overrides the answer,
 * with one wobble across the line staying one instance. Every cycle runs the real reclaim step,
 * the real registry reading over a real inventory of real trees, the real derived disk-pressure
 * line and the real fault record, and every system invariant must hold. The stale-pass shape a
 * cycling loop cannot produce on its own (the interval logic refreshes the pass before the faults
 * step judges) is reached here the way a real loop reaches it: the pass failing to run while the
 * cycles continue. Instants are relative to the clock this test runs on; no calendar date is
 * constructed.
 */
const minute = 60_000, hour = 60 * minute, cycleMs = 4 * minute;
const totalBytes = 1_022_000_000_000, threshold = 10_000_000_000, band = diskRecoveryBandBytes(threshold);

const workspace = (path: string, branch: string, epoch: number) => ({ host: 'vishrog', path, branch, epoch, owner: 'graphyard-worker-1' });
const work = (key: string, path: string, branch: string, overrides: Partial<Work> = {}): Work =>
  ({ id: `id-${key}`, key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, 
    stage: 'build', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '',
    ready: false, epoch: 1, lease: null, workspaces: [workspace(path, branch, 1)], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], ...overrides }) as Work;

test('unit:soak-worktree-disk — over simulated cycles the disk gate answers a drained pass and the pass that drains the plan it took back, opens for a stale pass with the volume low, holds a standing fault inside the band whatever the pass then does, raises at the floor, and keeps one wobble one instance, with every system invariant holding', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-worktree-disk');
  const credentials = await temporaryDirectory('soak-worktree-disk-credentials');
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
    // The warn line is the scenario's; every other pacing config (the interval the observation budget derives from) stays the loop's own.
    const config10 = await loadMasterConfig(root);
    config10.run.diskThresholdGb = 10;
    const start = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const trees = worktreesDirectory(root);
    /** Two assignment trees, each holding a dependency directory a fresh install recreates. */
    const treeA = join(trees, 'GY-91-1'), treeB = join(trees, 'GY-92-1');
    for (const tree of [treeA, treeB]) {
      execFileSync('git', ['worktree', 'add', '-q', '--detach', tree, 'main'], { cwd: root });
      await mkdir(join(tree, 'node_modules', 'pg'), { recursive: true });
      await writeFile(join(tree, 'node_modules', 'pg', 'index.js'), 'shared');
    }
    /** GY-91's attempt finishes during the soak: the item is done and its lease is gone, so its tree turns disposable under a pass that removed nothing. GY-92 holds its lease throughout. */
    const itemA = (done: boolean) => work('GY-91', treeA, 'graphyard/gy-91-1', done ? { stage: 'done' } : { lease: { owner: 'graphyard-worker-1', epoch: 1, expiresAt: iso(start + 4 * hour) } });
    const itemB = work('GY-92', treeB, 'graphyard/gy-92-1', { lease: { owner: 'graphyard-worker-1', epoch: 1, expiresAt: iso(start + 4 * hour) } });
    // The simulated volume: the host's free bytes are the scenario's, everything else is read for real.
    let freeBytes = 9_900_000_000, finished = false, passFails = false;
    let now = start;
    const state = emptyDaemonState(config10);
    /** The registry reading the loop would report this cycle: the real plan over the real trees, the pass and standing line from the cursor state, the volume from the scenario. */
    const reportedAttention = async (work: Work[]) => {
      const read = (await readDisk(root, config10, { reclaim: worktreePassOf(state.reclaim), open: state.faults.open }, { work, now }))!;
      return { items: resourceAttention(readResources({ now, reviews: [], producers: [], agents: [], work, plane: null, loop: null, revision: null,
        profiles: { workers: [], reviewers: [], producers: [] }, disk: { ...read, totalBytes, freeBytes } })) };
    };
    /** The cycle's reclaim pass: the real plan decides what is disposable; taking it removes the real directories and reports what it took, and leaves the inventory cache as the real pass does — what it scanned, with what it took gone. */
    const reclaim = async (work: Work[]) => {
      if (passFails) throw new Error('Simulated EIO walking the worktrees');
      let entries = await inventoryWorktrees(root, now);
      // As the real pass does first: a finished tree is removed outright, so its install goes with it.
      const goners = planWorktreeReclaim(entries, work, { now, idleMs: 3 * hour }).filter(entry => worktreeRemovalReason(entry, work, new Set(), 3 * hour, now) !== null);
      for (const gone of goners) execFileSync('git', ['worktree', 'remove', '--force', gone.path], { cwd: root });
      entries = entries.filter(entry => !goners.some(gone => gone.path === entry.path));
      const disposable = planWorktreeReclaim(entries, work, { now, idleMs: 3 * hour }).filter(entry => entry.disposable);
      const removed: string[] = [];
      for (const candidate of disposable) {
        await rm(join(candidate.path, 'node_modules'), { recursive: true, force: true });
        removed.push(join(candidate.path, 'node_modules'));
      }
      await writeWorktreeInventoryCache(root, { at: iso(now), entries: entries.map(entry => removed.some(path => path.startsWith(`${entry.path}/`)) ? { ...entry, dependencies: [] } : entry), held: [] });
      return { root: trees, at: iso(now), applied: true, scanned: entries.length, removed, kept: [], freeBefore: freeBytes, freeAfter: freeBytes,
        freedBytes: removed.length ? 2_000_000_000 : 0, errors: [],
        trees: { at: iso(now), limit: 2, removed: goners.map(gone => ({ path: gone.path, key: gone.key, reason: gone.detail, head: null })), kept: [], backlog: 0, held: [], errors: [] } };
    };
    const effects = {
      agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
      // The plan beside the pass, as production wires it (effects-production.ts): the derived line
      // judges the same plan the registry reading does, never the pass alone.
      worktreeReclaimable: (work: Work[], at: number) => disposableWorktrees(root, config10, { work, now: at }),
      snapshot: async () => ({ work: [itemA(finished), itemB], now: iso(now) }),
      observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
      controlPlane: async () => ({ build: { commit: null } }),
      reportedAttention, reclaim,
    } as unknown as DaemonEffects;
    /** One cycle: run it, then read the gate back out of the record — the registry line, the reading, the open instances on both lines, and every invariant. */
    const cycle = async (step = cycleMs) => {
      now += step;
      const snapshot = [itemA(finished), itemB];
      await runCycle(config10, state, effects, () => now);
      const violations = state.invariants.report.filter(check => !check.holds).map(check => `${check.invariant}: ${check.reading}`);
      assert.deepEqual(violations, [], `cycle at +${Math.round((now - start) / minute)} min: every system invariant holds`);
      const items = (await reportedAttention(snapshot)).items.filter(item => item.subject === 'resource:worktree-disk').map(item => item.subject);
      const disk = (await readDisk(root, config10, { reclaim: worktreePassOf(state.reclaim), open: state.faults.open }, { work: snapshot, now }))!;
      const reading = readResources({ now, reviews: [], producers: [], agents: [], work: snapshot, plane: null, loop: null, revision: null,
        profiles: { workers: [], reviewers: [], producers: [] }, disk: { ...disk, totalBytes, freeBytes } }).find(entry => entry.resource === 'worktree-disk')!;
      const openSubjects = Object.keys(state.faults.open).map(key => key.split('|').slice(0, 2).join('|'));
      return { items, reading, instances: openSubjects.filter(subject => subject === 'resource-bound|resource:worktree-disk').length,
        derived: openSubjects.filter(subject => subject === 'disk-pressure|disk').length,
        stale: !!state.reclaim && now - Date.parse(state.reclaim.at) >= worktreePassCurrentMs,
        standing: Object.keys(state.faults.open).some(key => key.startsWith('resource-bound|resource:worktree-disk|')) };
    };
    /** The cycles a transition needs to land through the loop's own pacing, asserting the condition holds at the cycle it lands on. */
    const until = async (name: string, condition: (step: Awaited<ReturnType<typeof cycle>>) => boolean, bound = 10) => {
      let last: Awaited<ReturnType<typeof cycle>> | undefined;
      for (let index = 0; index < bound; index++) { last = await cycle(); if (condition(last)) return last; }
      assert.fail(`${name}: the gate never reached its expected state within ${bound} cycles — last: ${JSON.stringify({ items: last!.items, answered: last!.reading.answered, detail: last!.reading.detail, state: last!.reading.state, instances: last!.instances })}`);
    };
    // Phase A — the item holds its lease, so nothing is disposable: the drained pass answers the low reading, five cycles in a row, and no instance opens.
    for (let index = 0; index < 5; index++) {
      const step = await cycle();
      assert.deepEqual(step.items, [], `answer cycle ${index}: the reading raises nothing`);
      assert.equal(step.instances, 0, `answer cycle ${index}: no instance`);
      assert.equal(step.derived, 0, `answer cycle ${index}: the derived line is silent with it`);
      assert.equal(step.reading.answered, true, `answer cycle ${index}: the pass is current and drained over a plan that counts nothing`);
    }
    // Phase B — GY-91 finishes: its tree turns disposable. The pass and the faults step run in one
    // cycle, so the cycle that gains reach also takes the install, and the reading answers — a
    // current pass above the floor whose plan it drained to empty is the drain finished, whatever it
    // removed, not reach left (GY-1828, the item's two worktree-volume instances): no instance opens
    // for a dip the loop reclaims away in the same cycle, end to end through the real loop.
    finished = true;
    const drainedAway = await cycle();
    assert.deepEqual(drainedAway.items, [], 'the cycle that takes the gained reach opens no instance');
    assert.equal(drainedAway.instances, 0, 'the drained-to-empty pass is the drain, not reach left');
    assert.equal(drainedAway.derived, 0, 'the derived line is silent with it');
    assert.equal(drainedAway.reading.answered, true, 'the same-cycle pass answers the reading it drained to empty');
    assert.match(drainedAway.reading.detail!, /nothing is reclaimable now \(the loop's latest worktree-reclaim pass at .* took back 1 worktrees removed\)/);
    // The one instance this soak owes the line opens the way a real loop's own failure opens it: the
    // pass stops recording (its step throws every cycle) while the volume stays low, and past its
    // currency bound a low reading stands — a stale pass answers nothing. A plan the pass could not
    // take in its judgement window (a backlog past the pass's bound, a tree finishing between the
    // pass and the faults step) raises the same way, on reach, which the unit tests pin.
    passFails = true;
    const opened = await until('the stale pass', step => step.instances === 1);
    passFails = false;
    assert.deepEqual(opened.items, ['resource:worktree-disk'], 'the stale pass raises the registry line');
    assert.equal(opened.derived, 1, 'the derived line opens with it, judged on the same pass');
    assert.equal(opened.reading.answered, undefined, 'a stale pass never answers');
    assert.match(opened.reading.detail!, /that pass is past its 30-minute currency bound, so the reading stands until the next pass/);
    // The pass runs again and takes nothing — the install went the cycle the finish landed — so the
    // fresh drained pass finds the volume held below the line with the fault standing: it holds.
    const taken = await until('the taken install', step => /found nothing reclaimable/.test(step.reading.detail ?? ''), 3);
    assert.equal(taken.instances, 1, 'the taken install opens no further instance');
    assert.equal(taken.derived, 1);
    assert.equal(taken.reading.answered, undefined, 'a standing fault is never answered, however fresh the drained pass');
    // Phase C — the volume recovers above the line, partway into the band: the standing instance holds to the recovery line.
    freeBytes = threshold + band / 2;
    for (let index = 0; index < 2; index++) {
      const step = await cycle();
      assert.deepEqual(step.items, ['resource:worktree-disk'], `band cycle ${index}: the reading is still low inside the band`);
      assert.equal(step.instances, 1, `band cycle ${index}: the same instance, no new one`);
      assert.equal(step.reading.state, 'low');
      assert.equal(step.reading.warnBelow, threshold + band, 'the reading recovers only past the band while its fault stands');
      assert.match(step.reading.detail!, /within the 1\.0 GB recovery band above the 10\.0 GB line/);
    }
    // The pass then fails to run while the cycles continue, as a real loop's pass fails: past its currency bound it answers nothing, and the instance is still the same one.
    passFails = true;
    let sawStale = false;
    for (let index = 0; index < 9 && !sawStale; index++) {
      const step = await cycle();
      if (!step.stale) assert.match(step.reading.detail!, /within the 1\.0 GB recovery band above the 10\.0 GB line/);
      else {
        sawStale = true;
        assert.deepEqual(step.items, ['resource:worktree-disk'], 'the stale pass answers nothing');
        assert.match(step.reading.detail!, /that pass is past its 30-minute currency bound, so the reading stands until the next pass/);
      }
      assert.equal(step.instances, 1, `ageing cycle ${index}: the standing instance holds, stale or current`);
    }
    assert.equal(sawStale, true, 'the pass went stale past its bound while the cycles continued');
    // The pass runs again: fresh and drained, and the fault still stands inside the band.
    passFails = false;
    const fresh = await cycle();
    assert.deepEqual(fresh.items, ['resource:worktree-disk']);
    assert.equal(fresh.instances, 1, 'a fresh drained pass ends nothing inside the band');
    // Phase D — recovered past the band: the instance ends. The derived line judges the pass's own
    // record, so it ends when a pass recorded above the line lands, a refresh after the reading does.
    freeBytes = threshold + band + 200_000_000;
    const recovered = await until('the recovery', step => step.instances === 0 && !step.standing);
    assert.deepEqual(recovered.items, [], 'past the recovery line the reading is not low');
    const settled = await until('the derived line ends', step => step.derived === 0);
    assert.deepEqual(settled.items, [], 'recovered, the registry line stays silent too');
    // Phase E — the GY-1782 wobble, a dip under the line with a current drained pass and no standing fault: answered, one instance still.
    freeBytes = 9_950_000_000;
    for (let index = 0; index < 2; index++) {
      const step = await cycle();
      assert.deepEqual(step.items, [], `wobble cycle ${index}: the drained pass answers the dip`);
      assert.equal(step.instances, 0, `wobble cycle ${index}: one wobble across the line is still one instance in the record`);
      assert.equal(step.reading.answered, true);
    }
    // Phase F — the exhaustion floor: at or below half the line the reading raises whatever the pass answered, as its own instance.
    freeBytes = 4_900_000_000;
    const floored = await until('the floor', step => step.instances === 1);
    assert.deepEqual(floored.items, ['resource:worktree-disk'], 'the floor raises the reading whatever the pass answered');
    assert.match(floored.reading.detail!, /at or below the 5\.0 GB exhaustion floor, which raises attention whatever that pass answered/);
    freeBytes = threshold + band + 300_000_000;
    const cleared = await until('the floor recovers', step => step.instances === 0);
    assert.deepEqual(cleared.items, [], 'recovered, the floor instance ends too');
    // The whole soak left two instances on the record and no more: the answered dips never opened one.
    assert.equal(state.faults.instances.filter(instance => instance.subject === 'resource:worktree-disk').length, 2);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});
