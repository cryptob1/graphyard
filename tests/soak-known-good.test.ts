import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promotionCycle, promotionReads } from '../src/daemon/deployment.js';
import { localPromotionIdle, type LocalCandidate, type LocalReleasePorts } from '../src/daemon/promotion-local.js';
import { promotionStateSchema, type PromotionState } from '../src/daemon/state.js';
import { candidateSettings } from '../src/master/merge-writer-settings.js';
import { installDirectory } from '../src/install/secrets.js';
import { installIdFor } from '../src/install/types.js';
import type { MasterConfig } from '../src/master.js';
import type { ChildRun } from '../src/child-runner.js';
import { knownGoodDirectory, knownGoodState, pendingPin, pinKnownGood, pinningVerify, retryPendingPin } from '../src/master/known-good.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1529: the known-good coordinator over a simulated week of the loop's per-cycle shape. Each cycle
 * retries a pending pin, and a newly promoted SHA is verified (which pins it). Asserts: an already
 * pinned SHA is never rebuilt, each verified promotion advances the pin once, failed pins are retried
 * until they land, and only the current and previous worktrees remain.
 */
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const minute = 60_000;

test('unit:soak-known-good — repeated cycles never rebuild a pinned SHA, each promotion pins once, failed pins retry, and the worktrees stay at two', { timeout: 300_000 }, async () => {
  const base = await temporaryDirectory('soak-known-good');
  const repository = join(base, 'repo'), installDir = join(base, 'install');
  mkdirSync(repository); git(repository, 'init', '-q', '-b', 'main');
  const shas: string[] = [];
  for (let i = 0; i < 8; i++) { writeFileSync(join(repository, 'f.txt'), String(i)); git(repository, 'add', '.'); git(repository, 'commit', '-q', '-m', String(i)); shas.push(git(repository, 'rev-parse', 'HEAD')); }
  const builds = new Map<string, number>();
  let failing = new Set<string>();
  const run: ChildRun = (command, args, options) => {
    if (command === 'npm') {
      if (args[0] === 'run') {
        const sha = options!.cwd!.split('/').pop()!;
        builds.set(sha, (builds.get(sha) ?? 0) + 1);
        if ([...failing].some(failed => failed.startsWith(sha))) throw new Error('transient build failure');
        mkdirSync(join(options!.cwd!, 'dist'), { recursive: true }); writeFileSync(join(options!.cwd!, 'dist', 'cli.js'), '// built\n');
      }
      return '';
    }
    return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  };
  const start = Date.UTC(2030, 5, 1);
  let now = start, promoted = shas[0], widest = 0;
  const pins: string[] = [];
  await pinKnownGood({ installDir, repository, now: () => new Date(start) }, promoted, run);
  const cycles = (7 * 24 * 60) / 30;
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * 30 * minute;
    const known = { installDir, repository, now: () => new Date(now) };
    // A promotion every 8 hours; the second and fifth fail to pin until six hours later.
    const index = Math.min(shas.length - 1, Math.floor((cycle * 30) / (8 * 60)));
    failing = new Set([2, 5].includes(index) && (cycle * 30) % (8 * 60) < 6 * 60 ? [shas[index]] : []);
    await retryPendingPin(known, run);
    if (shas[index] !== promoted) {
      promoted = shas[index];
      await pinningVerify(known, run, async sha => ({ verified: true, served: sha }))(promoted);
    }
    const state = knownGoodState(installDir);
    if (state && pins.at(-1) !== state.sha) pins.push(state.sha);
    widest = Math.max(widest, readdirSync(knownGoodDirectory(installDir)).filter(entry => /^[0-9a-f]{12}$/.test(entry)).length);
  }
  assert.deepEqual(pins, shas, 'the pin advances through the promotions in order');
  assert.ok(widest <= 2, `at most the current and previous worktrees exist, saw ${widest}`);
  // A failing pin is retried at most once per ten-minute window and only until it lands; a good one builds once.
  for (const [sha, count] of builds) assert.ok(count <= 1 + 6 * 60 / 30, `${sha} built ${count} times`);
  assert.equal(builds.size, 8, 'one build family per promoted SHA');
  for (const index of [0, 1, 3, 4, 6, 7]) assert.equal(builds.get(shas[index].slice(0, 12)), 1, `promotion ${index} built once`);
  assert.equal(pendingPin(installDir), null, 'no pin is left failing');
  // Quiet cycles after the last pin build nothing.
  const total = [...builds.values()].reduce((a, b) => a + b, 0);
  await retryPendingPin({ installDir, repository, now: () => new Date(now + 60 * minute) }, run);
  assert.equal([...builds.values()].reduce((a, b) => a + b, 0), total);
});

/**
 * The real promotion loop (promotionReads + promotionCycle over a git origin and a coordinator clone,
 * fresh control-plane ports each cycle) with pinning integrated, over a simulated week. Promotions:
 * 2 verifies but its pin fails for hours; 3 is promoted (its tag written) while verification fails and
 * production still serves 2; the rest verify and pin. Asserts: no already pinned SHA is rebuilt, each
 * verified promotion pins once, the pending pin survives the superseding unverified promotion and
 * lands, a standing failure stays visible until it clears, worktrees stay at two, no promotion repeats,
 * and every cycle is bounded.
 */
test('unit:soak-known-good-real-loop — the real promotion loop pins each verified promotion once, retries a failed pin across a superseding unverified promotion, and keeps two worktrees', { timeout: 300_000 }, async t => {
  const base = await temporaryDirectory('soak-known-good-loop');
  const origin = join(base, 'origin.git'), root = join(base, 'root'), author = join(base, 'author'), configHome = join(base, 'config');
  const previousHome = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.GRAPHYARD_CONFIG_HOME = configHome;
  t.after(() => { mock.timers.reset(); if (previousHome === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = previousHome; });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, author], { stdio: 'ignore' });
  const commit = (n: number) => { writeFileSync(join(author, 'f.txt'), String(n)); git(author, 'add', '.'); git(author, 'commit', '-q', '-m', String(n)); git(author, 'push', '-q', 'origin', 'HEAD:main'); return git(author, 'rev-parse', 'HEAD'); };
  const shas = [commit(0)];
  execFileSync('git', ['clone', '-q', origin, root], { stdio: 'ignore' });
  const tag = (n: number, sha: string, at: string) => { git(author, 'tag', '-a', `rc-production/2030060${n}`, '-m', JSON.stringify({ id: `2030060${n}`, sha, at }), sha); git(author, 'push', '-q', 'origin', `refs/tags/rc-production/2030060${n}`); };
  tag(0, shas[0], '2030-06-01T00:00:00Z');
  const config = { repository: 'owner/project', baseBranch: 'main' } as MasterConfig;
  const installDir = installDirectory(installIdFor(config.repository));
  const start = Date.UTC(2030, 5, 1, 0, 0), cycleMs = 30 * minute, cycles = 7 * 48;
  mock.timers.enable({ apis: ['Date'], now: start });
  const builds = new Map<string, number>(), verifies: string[] = [], promotions: number[] = [];
  let failBuilds = new Set<string>(), unverified = new Set<string>(), served = shas[0], promotionCount = 0;
  const run: ChildRun = (command, args, options) => {
    if (command === 'npm') {
      if (args[0] === 'run') {
        const dir = options!.cwd!.split('/').pop()!;
        builds.set(dir, (builds.get(dir) ?? 0) + 1);
        if ([...failBuilds].some(failed => failed.startsWith(dir))) throw new Error('transient build failure');
        mkdirSync(join(options!.cwd!, 'dist'), { recursive: true }); writeFileSync(join(options!.cwd!, 'dist', 'cli.js'), '// built\n');
      }
      return '';
    }
    if (command === 'gh') throw new Error('github must not be touched in control-plane mode');
    return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  };
  const settings = candidateSettings({ candidates: { everyMerges: 1, idleMinutes: 0 } });
  const open: LocalCandidate[] = [];
  const ports = (): LocalReleasePorts => ({
    settings, history: async () => [],
    cut: async () => {
      if (open[0]) return { cut: false, resume: open[0] };
      const tip = git(root, 'rev-parse', 'refs/remotes/origin/main');
      if (tip === served || verifies.includes(`promoted:${tip}`)) return { cut: false, reason: 'nothing queued' };
      const candidate = { id: `c${shas.indexOf(tip)}`, sha: tip, cutAt: new Date(Date.now()).toISOString(), items: [] };
      open.push(candidate); return { cut: true, candidate };
    },
    uat: async () => ({ sha: open[0].sha }),
    validate: async () => ({ record: { result: 'passed', suites: [], e2e: null, followUp: null, deployedSha: open[0].sha }, followUp: null }),
    promote: async () => {
      const candidate = open.shift()!;
      promotionCount += 1; promotions.push(shas.indexOf(candidate.sha)); verifies.push(`promoted:${candidate.sha}`);
      tag(promotionCount, candidate.sha, new Date(Date.now()).toISOString());
      return { promoted: true, sha: candidate.sha };
    },
    verify: async sha => { const ok = !unverified.has(sha); if (ok) served = sha; return { served, verified: ok }; },
    revertInputs: async () => { throw new Error('nothing reverts in this day'); },
    revert: async () => { throw new Error('nothing reverts in this day'); },
  });
  await pinKnownGood({ installDir, repository: root }, shas[0], run);
  let state: PromotionState | null = null, widest = 0, standing = 0, longest = 0, slowest = 0;
  const pins: string[] = [];
  let pendingSeen = false, supersededWhilePending = false;
  for (let cycle = 0; cycle < cycles; cycle++) {
    const now = start + cycle * cycleMs;
    mock.timers.setTime(now);
    // A merge every 6 hours; the promotion of the third (index 2) pins late, the fourth's verification fails.
    if (cycle > 0 && (cycle * 30) % (6 * 60) === 0 && shas.length < 8) shas.push(commit(shas.length));
    failBuilds = new Set(cycle * 30 >= 12 * 60 && cycle * 30 < 22 * 60 ? [shas[2].slice(0, 12)] : []);
    unverified = new Set([shas[3]]);
    const options = { now, everyMinutes: 10, intervalMs: cycleMs, watchedTip: git(root, 'rev-parse', 'refs/remotes/origin/main') };
    const reads = () => { const reads = promotionReads(config, root, run, false, false, { merger: async () => 'control-plane', local: ports() })!; return reads; };
    const began = process.hrtime.bigint();
    const first = await promotionCycle(state, reads(), options);
    state = promotionStateSchema.parse(first.state);
    if (state.inFlight) { await localPromotionIdle(); state = promotionStateSchema.parse((await promotionCycle(state, reads(), { ...options, now: now + 1_000 })).state); }
    slowest = Math.max(slowest, Number(process.hrtime.bigint() - began) / 1e6);
    assert.equal(first.failure, null, `cycle ${cycle} did not fail: ${first.failure}`);
    const pinned = knownGoodState(installDir);
    if (pinned && pins.at(-1) !== pinned.sha) pins.push(pinned.sha);
    const failing = pendingPin(installDir);
    if (failing) { pendingSeen = true; standing += 1; longest = Math.max(longest, standing); if (verifies.includes(`promoted:${shas[3]}`) && failing.sha === shas[2]) supersededWhilePending = true; } else standing = 0;
    widest = Math.max(widest, readdirSync(knownGoodDirectory(installDir)).filter(entry => /^[0-9a-f]{12}$/.test(entry)).length);
    assert.ok(widest <= 2, `at most the current and previous worktrees exist, saw ${widest}`);
  }
  assert.deepEqual(promotions, [1, 2, 3, 4, 5, 6, 7], 'every merge was promoted once, in order');
  assert.ok(pendingSeen && supersededWhilePending, 'the pin of promotion 2 stayed pending across the unverified promotion of 3');
  assert.equal(pendingPin(installDir), null, 'no pin is left failing');
  assert.ok(longest <= 22 * 2, `a standing failure clears (longest ${longest} cycles)`);
  assert.deepEqual(pins, [shas[0], shas[1], shas[2], shas[4], shas[5], shas[6], shas[7]].filter(Boolean), 'each verified promotion advances the pin once, the unverified one never pins');
  for (const index of [1, 4, 5, 6, 7]) assert.equal(builds.get(shas[index].slice(0, 12)), 1, `promotion ${index} built once`);
  assert.ok((builds.get(shas[2].slice(0, 12)) ?? 0) <= 1 + (10 * 60) / 10 + 1, 'the failing pin retried at most once a window');
  assert.ok(slowest < 30_000, `every cycle stays bounded (${Math.round(slowest)} ms)`);
});
