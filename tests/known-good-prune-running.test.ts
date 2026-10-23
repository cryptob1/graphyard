import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import { knownGoodDirectory, pinKnownGood, recordRunningPin } from '../src/master/known-good.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/** GY-2760: pinning newer releases never prunes the pin the running loop loaded its modules from. */
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const run: ChildRun = (command, args, options) => {
  if (command !== 'npm') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  if (args[0] === 'run') { mkdirSync(join(options!.cwd!, 'dist'), { recursive: true }); writeFileSync(join(options!.cwd!, 'dist', 'cli.js'), '// built\n'); }
  return '';
};
async function world() {
  const base = await temporaryDirectory('known-good-prune');
  const repository = join(base, 'repo'), installDir = join(base, 'install');
  mkdirSync(repository); git(repository, 'init', '-q', '-b', 'main');
  const shas: string[] = [];
  for (const name of ['a', 'b', 'c']) { writeFileSync(join(repository, `${name}.txt`), name); git(repository, 'add', '.'); git(repository, 'commit', '-q', '-m', name); shas.push(git(repository, 'rev-parse', 'HEAD')); }
  return { repository, installDir, shas, pins: knownGoodDirectory(installDir) };
}
const short = (sha: string) => sha.slice(0, 12);

test('unit:known-good-prune-running — newer pins keep the pin the running loop loaded from and the last good pin; pins no process runs are removed', async () => {
  const w = await world();
  await pinKnownGood({ installDir: w.installDir, repository: w.repository }, w.shas[0], run);
  const loop = { installDir: w.installDir, repository: w.repository, loadedFrom: join(realpathSync(join(w.pins, short(w.shas[0]))), 'a.txt') };
  await pinKnownGood(loop, w.shas[1], run);
  await pinKnownGood(loop, w.shas[2], run);
  assert.ok(existsSync(join(w.pins, short(w.shas[0]), 'a.txt')), 'the loop still runs from its pin');
  assert.equal(existsSync(join(w.pins, short(w.shas[1]))), false, 'a pin no process runs is removed');
  assert.ok(existsSync(join(w.pins, short(w.shas[2]))), 'the last good pin is kept');

  // The deploy unit pins from its own process; the pin the running loop recorded stays.
  const d = await world();
  await pinKnownGood({ installDir: d.installDir, repository: d.repository }, d.shas[0], run);
  recordRunningPin(d.installDir, join(realpathSync(join(d.pins, short(d.shas[0]))), 'a.txt'));
  await pinKnownGood({ installDir: d.installDir, repository: d.repository }, d.shas[1], run);
  await pinKnownGood({ installDir: d.installDir, repository: d.repository }, d.shas[2], run);
  assert.deepEqual(d.shas.map(sha => existsSync(join(d.pins, short(sha)))), [true, false, true], 'the deploy keeps the pin the running loop recorded');

  // No process runs from the first pin of a second install: two newer pins remove it.
  const v = await world();
  for (const sha of v.shas) await pinKnownGood({ installDir: v.installDir, repository: v.repository }, sha, run);
  assert.deepEqual(v.shas.map(sha => existsSync(join(v.pins, short(sha)))), [false, false, true], 'only the last good pin is kept');
});
