import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    await retryPendingPin(known, run, promoted);
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
  await retryPendingPin({ installDir, repository, now: () => new Date(now + 60 * minute) }, run, promoted);
  assert.equal([...builds.values()].reduce((a, b) => a + b, 0), total);
});
