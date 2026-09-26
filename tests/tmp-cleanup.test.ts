import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describeTmpReclaim, heldOpenPaths, readTempOwner, reclaimTmpDirectories, tempOwnerMarker, writeTempOwner } from '../src/tmp-reclaim.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-421: test runs used to leak their temporary directories — by 25 September 2026 the host held
// 11,511 /tmp/graphyard-* embedded-Postgres data dirs a run had left behind on failing or being
// killed, the tmpfs filled, and workers died on the quota error that produced. The suite answers
// this three ways, all proven here: the shared helper (tests/helpers/temp-dirs.ts) removes a
// file's directories in its after hook, failing or not; the runner (tests/helpers/run-tests.ts)
// sweeps the directories of runs whose owning process is gone before and after the suite; and the
// loop's reclaim pass (src/master-resources.ts, through src/tmp-reclaim.ts) removes what is old
// and unheld, bounded per cycle, reporting the bytes freed.

/** The directories the named test files create: their mkdtemp prefixes under the host's tmpdir. */
const dbTestDirNames = async (prefixes: readonly string[]) =>
  (await readdir(tmpdir())).filter(name => prefixes.some(prefix => name.startsWith(prefix))).sort();
/**
 * Spawn one test file the way the suite runner does — its own test context, never the caller's —
 * and wait for it to end. The port is spelled so the suite's port-collision scan (which reads the
 * per-file `?? GRAPHYARD_TEST_PORT ?? 15438) + offset` idiom) records no static resolution here:
 * this file creates no database of its own, and the two it spawns run on explicit overrides far
 * above every file's own offset, so they cannot collide with a parallel file.
 */
const suitePortBase = Number(process.env.GRAPHYARD_TEST_PORT) || 15438;
const runTestFile = (file: string, port: number, override: string) => new Promise<{ code: number; stderr: string }>(done => {
  // NODE_TEST_CONTEXT is this process's own test-runner inheritance: a child carrying it would
  // skip running files rather than nest a suite, and exit 0 having run nothing.
  const { NODE_TEST_CONTEXT: _inherited, ...environment } = process.env;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', file],
    { env: { ...environment, [override]: String(suitePortBase + port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += chunk; });
  child.on('close', code => done({ code: code ?? 1, stderr }));
});

test('unit:tests-clean-temp-dirs: after the suite\'s DB tests run, no directory they created remains', async () => {
  const prefixes = ['graphyard-deploy-observation-', 'graphyard-action-priority-'];
  const before = new Set(await dbTestDirNames(prefixes));
  // Two real database tests, each on its own port, run the way the suite runs them. Their after
  // hooks stop the embedded Postgres, which removes its data directory: when they end, nothing
  // they created is left on the tmpfs. A directory of a run still in flight — the same test file
  // running beside this one in the full suite — is held open by its live Postgres and named in no
  // verdict; a directory of an earlier run is not: it is the leak this criterion exists for.
  const runs = await Promise.all([
    runTestFile('tests/deploy-observation.test.ts', 150, 'GRAPHYARD_DEPLOY_OBSERVATION_TEST_PORT'),
    runTestFile('tests/action-priority.test.ts', 151, 'GRAPHYARD_ACTION_PRIORITY_TEST_PORT'),
  ]);
  for (const run of runs) assert.equal(run.code, 0, run.stderr.slice(-2_000));
  // A directory of a run still starting — the same test file running beside this one — is not yet
  // held by its Postgres; one settle delay later it is, and only a true leak stays unheld.
  const unheld = async () => {
    const held = await heldOpenPaths();
    return (await dbTestDirNames(prefixes)).filter(name => !before.has(name)).map(name => join(tmpdir(), name))
      .filter(directory => ![...held].some(path => path === directory || path.startsWith(`${directory}/`)));
  };
  let leaked = await unheld();
  if (leaked.length) { await delay(2_000); leaked = await unheld(); }
  assert.deepEqual(leaked, [], `the DB tests left temporary directories behind: ${leaked.join(', ')}`);
});

test('unit:tests-clean-temp-dirs: a test that fails still removes the directories its file created', async () => {
  // A child suite that creates directories through the shared helper and then fails: the after
  // hook runs on the failure all the same, so nothing is left for the next run.
  const scratch = await temporaryDirectory('tmp-cleanup-child');
  const child = join(scratch, 'failing.test.ts');
  await writeFile(child, `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDirectory } from ${JSON.stringify(fileURLToPath(import.meta.resolve('./helpers/temp-dirs.ts')))};
let first, second;
test('creates the directories', async () => {
  first = await temporaryDirectory('failing-child-a');
  second = await temporaryDirectory('failing-child-b');
  console.log(JSON.stringify({ first, second }));
});
test('this suite fails after creating its directories', () => { assert.fail('the run dies here, as a killed or failing run does'); });
`);
  const run = await new Promise<{ code: number; stdout: string }>(done => {
    const { NODE_TEST_CONTEXT: _inherited, ...environment } = process.env;
    const suite = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), child], { cwd: scratch, env: environment, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    suite.stdout.on('data', chunk => { stdout += chunk; });
    suite.on('close', code => done({ code: code ?? 1, stdout }));
  });
  assert.notEqual(run.code, 0, 'the child suite fails, as designed');
  const printed = run.stdout.split('\n').find(line => line.startsWith('{"first"'));
  const { first, second } = JSON.parse(printed!) as { first: string; second: string };
  assert.equal(existsSync(first), false, 'the first directory is removed by the after hook despite the failure');
  assert.equal(existsSync(second), false, 'the second directory is removed by the after hook despite the failure');
});

test('unit:tests-clean-temp-dirs: the runner removes directories left by runs whose owning process is gone, and only those', async () => {
  const root = await temporaryDirectory('sweep-root');
  // A corpse: a directory a run marked, whose owning process has since exited.
  const exited = spawn('true', { stdio: 'ignore' });
  await new Promise(done => exited.on('close', done));
  const dead = await mkdtemp(join(root, 'graphyard-corpse-'));
  const owner = await writeTempOwner(dead);
  owner.pid = exited.pid!; owner.startedAt = null;
  await writeFile(tempOwnerMarker(dead), JSON.stringify(owner));
  // A live one: marked by this very process.
  const live = await mkdtemp(join(root, 'graphyard-live-'));
  await writeTempOwner(live);
  const sweep = await reclaimTmpDirectories({ now: Date.now(), tmpRoot: root, prefixes: ['graphyard-'], limit: 10 });
  assert.deepEqual(sweep.removed.map(entry => entry.path), [dead], 'the corpse goes whatever its age');
  assert.deepEqual(sweep.errors, []);
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(live), true, 'a directory a live run owns is never touched');
  assert.equal((await readTempOwner(live))?.pid, process.pid, 'the live owner\'s marker stands');
});

test('unit:tmp-reclaim: the loop\'s reclaim pass removes an old, unheld directory and keeps a held one, bounded, reporting the bytes freed', async t => {
  const root = await temporaryDirectory('reclaim-root');
  // Old and unheld: eight hours old, no live holder — the pass takes it and reports its bytes.
  const old = join(root, 'graphyard-old-unheld');
  await mkdir(old); await writeFile(join(old, 'data.bin'), Buffer.alloc(4096, 1));
  const backdate = async (path: string, hours: number) => { const past = new Date(Date.now() - hours * 3_600_000); await utimes(path, past, past); };
  await backdate(old, 8);
  // Old but held: a live process works inside it, as an embedded Postgres does while its suite runs.
  const held = join(root, 'graphyard-held');
  await mkdir(held); await writeFile(join(held, 'data.bin'), Buffer.alloc(4096, 1));
  await backdate(held, 8);
  const holder = spawn('sleep', ['120'], { cwd: held, stdio: 'ignore' });
  t.after(() => { holder.kill('SIGKILL'); });
  // Young: too new for the age bound, whatever its holders.
  const young = join(root, 'graphyard-young');
  await mkdir(young);
  // Old with a live owner: the marker names this process, so the age never applies.
  const mine = join(root, 'graphyard-live-owner');
  await mkdir(mine); await writeTempOwner(mine); await backdate(mine, 8);
  // The tsx cache, stale: the same pass takes it.
  const tsx = join(root, 'tsx-1000');
  await mkdir(tsx); await writeFile(join(tsx, 'chunk.js'), 'export {};\n'); await backdate(tsx, 8);

  const report = await reclaimTmpDirectories({ now: Date.now(), tmpRoot: root });
  assert.deepEqual(report.removed.map(entry => entry.path), [old, tsx], 'the old unheld directory and the stale tsx cache go, oldest first');
  assert.deepEqual(report.errors, []);
  assert.equal(existsSync(held), true, 'a directory a live process holds open stays');
  assert.equal(existsSync(young), true, 'a directory younger than the age bound stays');
  assert.equal(existsSync(mine), true, 'a directory whose owning process still runs stays, however old');
  assert.ok(report.bytes >= 4096 + 'export {};\n'.length, `the report carries the bytes freed (${report.bytes})`);
  assert.match(describeTmpReclaim(report.removed.length, report.bytes) ?? '', /^freed .+ from 2 stale \/tmp directories$/);

  // The bound: one pass removes at most its limit, whatever the backlog, so a reclaim never stalls a cycle.
  const backlog = await temporaryDirectory('reclaim-bound-root');
  for (const name of ['graphyard-backlog-a', 'graphyard-backlog-b']) {
    const dir = join(backlog, name);
    await mkdir(dir); await backdate(dir, 8);
  }
  const bounded = await reclaimTmpDirectories({ now: Date.now(), tmpRoot: backlog, limit: 1 });
  assert.equal(bounded.removed.length, 1, 'one pass removes at most its limit');
  assert.equal(bounded.kept, 1, 'the rest waits for the next pass');
  assert.ok((await stat(bounded.removed[0].path).catch(() => null)) === null, 'the removed one is gone');
});
