import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadMasterConfig, prepareWorkerLaunch, saveWorkerProfile, setupMaster, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { Launcher } from '../src/daemon/cycle.js';
import { cycleBaseTip, retainedCycleFetches } from '../src/master/worktrees.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1836 (review of 2fe33ca30b47, PRRT_kwDOUZby-s6tZi5k). The loop's launcher runs a worker launch
 * after the cycle that chose it, cycles later under load, so the cycle's one fetch of the base
 * branch has to outlive that cycle for every launch it queued. Over simulated days of the real loop
 * — `runCycle` with one `Launcher` carried across its cycles, as `runDaemon` carries it, at a launch
 * concurrency of one — every dispatch prepares through the real `prepareWorkerLaunch` on the
 * snapshot's instant, while origin's base branch moves before every cycle and each launch holds the
 * launcher for a cycle, so launches queue across cycles. Every cycle: at most one fetch of origin
 * per cycle, every worktree a cycle queued created at the tip that cycle's fetch held, never older
 * than the base at its snapshot, and a cycle whose launches still wait keeps its fetch past the
 * bound however many other snapshots prepare meanwhile; once its launches settle, it holds nothing.
 * Only git and the CLI stand in, at the child runner, recording what the launcher asked of them.
 * Instants are relative to the clock this test runs on; no calendar date is constructed.
 */
const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const minute = 60_000, hour = 60 * minute, day = 24 * hour, cycleMs = 5 * minute;
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));

function work(key: string, at: string): Work {
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:one-fetch-per-cycle'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
  } as Work;
}

test('unit:soak-worktree-prepare-cycles — over simulated days the real loop, its launches queued across cycles, fetches origin at most once per cycle, prepares every launch a cycle queued from that cycle\'s fetched tip however many cycles later it runs, keeps a cycle\'s fetch past the bound while its launches wait, and holds nothing once they settle', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-worktree-prepare-cycles');
  const credentials = await temporaryDirectory('soak-worktree-prepare-cycles-credentials');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: cli, credentialDirectory: credentials }, coordinatorStatus as typeof fetch);
    for (const name of ['one', 'two', 'three']) {
      const credentialFile = join(credentials, `${name}.token`), token = `worker-${name}-token-`.padEnd(40, 'x');
      await writeFile(credentialFile, token, { mode: 0o600 });
      await saveWorkerProfile(root, { name, principal: `worker-${name}`, agentName: `soak-worker-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} } as WorkerProfile,
        async given => ({ actor: { id: given === token ? `worker-${name}` : 'wrong', role: 'worker' } }));
    }
    const installed = await loadMasterConfig(root);
    const config = { ...installed, run: { ...installed.run, launchConcurrency: 1 } };

    // The world: origin's base branch, which moves before every cycle; the items released over the day.
    const start = Date.now();
    let now = start, originTip = '', tipNumber = 0;
    const iso = (ms: number) => new Date(ms).toISOString();
    const advanceOrigin = () => { originTip = (++tipNumber).toString(16).padStart(40, '0'); };
    const released: Work[] = [];
    const claimed = new Set<string>();
    let next = 9_200;
    const release = (count: number) => { for (let index = 0; index < count; index++) released.push(work(`GY-${next++}`, iso(now - 4 * hour))); };

    // What the launcher asked of git and the CLI: each fetch on the cycle it was made for, and each worktree with the base it was created at.
    const fetches: { cycle: string; tip: string }[] = [];
    const worktrees = new Map<string, { cycle: string; base: string; branch: string }>();
    /** The tip of origin when each cycle's snapshot was read. */
    const snapshotTips = new Map<string, string>();
    const runFor = (cycle: string, principal = 'worker') => (command: string, args: string[]) => {
      if (command === 'git') {
        if (args[0] === 'fetch') fetches.push({ cycle, tip: originTip });
        return args[0] === 'rev-parse' ? `${fetches.filter(entry => entry.cycle === cycle).at(-1)?.tip ?? originTip}\n` : '';
      }
      if (args[1] === 'claim') { claimed.add(args[2]); return JSON.stringify({ epoch: 1, lease: { owner: principal } }); }
      if (args[1] === 'worktree') {
        const branch = `graphyard/${args[2].toLowerCase()}-${args[3]}`;
        worktrees.set(args[2], { cycle, base: args[4], branch });
        return JSON.stringify({ path: join(root, 'assigned', `${args[2]}-${args[3]}`), branch });
      }
      return '{}';
    };
    // Each launch holds the launcher until the world lets one go, one per cycle, so the next
    // cycle's choices wait behind it: the queue a loaded host builds.
    const holding: (() => void)[] = [];
    const effects: DaemonEffects = {
      agents: () => [], credentials: async items => Object.fromEntries(items.map(item => [item.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: released.filter(item => !claimed.has(item.key)), now: iso(now) }),
      closeSession: () => {},
      // As production wires it (effects-production.ts): the launch prepares on the snapshot's instant.
      dispatch: async (item, profile, _free, snapshot) => {
        await prepareWorkerLaunch(root, item.key, profile.name, runFor(snapshot.now, profile.principal), undefined, undefined, snapshot.now);
        await new Promise<void>(resolve => holding.push(resolve));
      },
      requestProof: () => {}, observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    };
    const state = emptyDaemonState(config), launcher = new Launcher();
    /** Lets the oldest running launch finish and waits until the next one is prepared and holding, or nothing is left. */
    const settleOne = async () => {
      const before = worktrees.size;
      holding.shift()?.();
      for (let waited = 0; waited < 400 && launcher.pending && (worktrees.size === before || !holding.length); waited++) await delay(5);
    };
    const cycle = async () => {
      now += cycleMs;
      advanceOrigin();
      snapshotTips.set(iso(now), originTip);
      await runCycle(config, state, effects, () => now, launcher);
      const violations = state.invariants.report.filter(check => !check.holds).map(check => `${check.invariant}: ${check.reading}`);
      assert.deepEqual(violations, [], `cycle at +${Math.round((now - start) / minute)} min: every system invariant holds`);
      // At most one fetch for any cycle, whenever its launches ran.
      const perCycle = new Map<string, number>();
      for (const entry of fetches) perCycle.set(entry.cycle, (perCycle.get(entry.cycle) ?? 0) + 1);
      assert.deepEqual([...perCycle].filter(([, count]) => count > 1), [], `cycle at +${Math.round((now - start) / minute)} min: no cycle fetched origin twice`);
      await settleOne();
    };
    /** Every worktree a cycle queued was created at the tip that cycle's one fetch held, on its item's branch, and never older than the base at its snapshot. */
    const assertWorktrees = (label: string) => {
      for (const [key, { cycle: instant, base, branch }] of worktrees) {
        const fetched = fetches.filter(entry => entry.cycle === instant);
        assert.equal(fetched.length, 1, `${label}: ${key}'s cycle fetched origin once`);
        assert.equal(base, fetched[0].tip, `${label}: ${key} was created at its cycle's fetched tip`);
        assert.ok(parseInt(base, 16) >= parseInt(snapshotTips.get(instant)!, 16), `${label}: ${key}'s base is never older than the base at its snapshot`);
        assert.equal(branch, `graphyard/${key.toLowerCase()}-1`, `${label}: ${key}'s worktree holds its item's branch`);
      }
    };

    // Day 1. The first cycle sees six items with three profiles free: it queues three launches, and
    // they run one per cycle, so its last runs two cycles after it was chosen.
    release(6);
    await cycle();
    const firstCycle = iso(now);
    assert.equal(launcher.pending, 3, 'the first cycle queued a launch on each of its three profiles');
    // Its first launch fetched and holds the launcher; while the other two wait, more snapshots
    // than the bound keeps prepare in this process, and the cycle that queued them keeps its fetch
    // all the same.
    for (let waited = 0; waited < 400 && !holding.length; waited++) await delay(5);
    assert.deepEqual(fetches.map(entry => entry.cycle), [firstCycle], 'the first cycle\'s first launch made its one fetch');
    for (let index = 1; index <= retainedCycleFetches + 2; index++) await cycleBaseTip(root, 'main', iso(now - day + index), runFor(`other-${index}`));
    for (let index = 0; index < 10; index++) { if (index % 3 === 0) release(2); await cycle(); }
    const fromFirst = [...worktrees].filter(([, entry]) => entry.cycle === firstCycle);
    assert.equal(fromFirst.length, 3, 'every launch the first cycle queued ran');
    assert.ok(new Set(fromFirst.map(([, entry]) => entry.base)).size === 1, 'the first cycle\'s launches share its one fetched tip');
    assert.ok(fromFirst[2][1].base !== originTip, 'its last launch ran cycles later, after origin had moved, and still prepared from its own cycle\'s tip');
    assertWorktrees('day 1');

    // The queue drains: the first cycle holds nothing now, so the bound has dropped its fetch, and
    // a preparation on that instant — nothing queued on it — fetches for itself.
    while (launcher.pending) await settleOne();
    await launcher.idle();
    const before = fetches.length;
    await cycleBaseTip(root, 'main', firstCycle, runFor('released'));
    assert.equal(fetches.length, before + 1, 'once its launches settled the first cycle holds no fetch');

    // Days 2 and 3: the same queueing, a day on each time, with every invariant holding.
    for (const offset of [day, 2 * day]) {
      now = start + offset;
      release(6);
      for (let index = 0; index < 12; index++) { if (index % 4 === 0) release(2); await cycle(); }
      while (launcher.pending) await settleOne();
      await launcher.idle();
      assertWorktrees(`day ${offset / day + 1}`);
    }
    const launched = [...worktrees.keys()];
    assert.ok(launched.length >= 30, `the three days launched through the real preparation: ${launched.length}`);
    assert.deepEqual([...claimed].sort(), [...launched].sort(), 'every launch that claimed built its worktree');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(credentials, { recursive: true, force: true });
  }
});
