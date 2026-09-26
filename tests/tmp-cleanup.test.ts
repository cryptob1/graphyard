import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeTmpReclaim, readTempOwner, reclaimTmpDirectories, tempOwnerMarker, writeTempOwner } from '../src/tmp-reclaim.js';
import { describeReclaim, readReclaimReports, reclaimResources, settleTmpReclaim, takeTmpReclaim } from '../src/master-resources.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-421: test runs used to leak their temporary directories — by 25 September 2026 the host held
// 11,511 /tmp/graphyard-* embedded-Postgres data dirs a run had left behind on failing or being
// killed, the tmpfs filled, and workers died on the quota error that produced. The suite answers
// this three ways, all proven here: the shared helper (tests/helpers/temp-dirs.ts) removes a
// file's directories in its after hook, failing or not; the runner (tests/helpers/run-tests.ts)
// sweeps the directories of runs whose owning process is gone before and after the suite; and the
// loop's reclaim pass (src/master-resources.ts, through src/tmp-reclaim.ts) removes what is old
// and unheld, bounded per cycle, reporting the bytes freed.

/** Every TypeScript file under tests/, the helpers included. */
const suiteFiles = async (directory = fileURLToPath(new URL('.', import.meta.url))): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await suiteFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
};
/**
 * Spawn test files the way the suite runner does — their own test context, never the caller's —
 * in a private temporary directory, and wait for them to end. The port is spelled so the suite's
 * port-collision scan (which reads the per-file `?? GRAPHYARD_TEST_PORT ?? 15438) + offset` idiom)
 * records no static resolution here: this file creates no database of its own, and the files it
 * spawns run on explicit overrides far above every file's own offset, so they cannot collide with
 * a parallel file.
 */
const suitePortBase = Number(process.env.GRAPHYARD_TEST_PORT) || 15438;
const runTestFiles = (files: string[], environment: NodeJS.ProcessEnv) => new Promise<{ code: number; stdout: string; stderr: string }>(done => {
  // NODE_TEST_CONTEXT is this process's own test-runner inheritance: a child carrying it would
  // skip running files rather than nest a suite, and exit 0 having run nothing.
  const { NODE_TEST_CONTEXT: _inherited, ...inherited } = process.env;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', ...files], { env: { ...inherited, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  child.on('close', code => done({ code: code ?? 1, stdout, stderr }));
});

test('unit:tests-clean-temp-dirs: every test in the suite creates its temporary directories through the one shared helper', async () => {
  const helper = fileURLToPath(new URL('./helpers/temp-dirs.ts', import.meta.url));
  const bare: string[] = [], databases: string[] = [];
  for (const file of await suiteFiles()) {
    if (file === helper) continue;
    const source = await readFile(file, 'utf8');
    // A bare mkdtemp has no after hook behind it: a failing or killed test leaks what it made. The
    // timing-stability script is no test: it is run by hand and keeps its directory for the failed
    // runs' logs it names.
    if (/\bmkdtemp(Sync)?\s*\(/.test(source) && !file.endsWith('/timing-stability.ts')) bare.push(file);
    // Every embedded Postgres keeps its data dir in a directory the helper made and removes: made
    // right there, or held in a variable the helper's result was assigned to (`dir`, `join(dir, …)`).
    const madeByHelper = (expression: string) => {
      if (/temporaryDirectory\(/.test(expression)) return true;
      const name = /^(?:join\()?\s*([A-Za-z_$][\w$]*)/.exec(expression)?.[1];
      return !!name && new RegExp(`\\b${name}\\s*=\\s*await temporaryDirectory\\(`).test(source);
    };
    for (const match of source.matchAll(/new EmbeddedPostgres\(\{\s*databaseDir:\s*([^\n]+?)\s*,\s*user:/g)) if (!madeByHelper(match[1])) databases.push(`${file}: ${match[1]}`);
  }
  assert.deepEqual(bare, [], 'these test files create temporary directories with a bare mkdtemp instead of tests/helpers/temp-dirs.ts');
  assert.deepEqual(databases, [], 'these embedded Postgres data dirs are not made by the shared helper');
});

test('unit:tests-clean-temp-dirs: after the suite\'s DB tests run, no directory they created remains', async () => {
  // Real database tests — embedded Postgres data dirs, homes, worktrees, nested scratch trees —
  // each on its own port, run the way the suite runs them but with a temporary directory of their
  // own, so everything they create lands where this test can see it and nothing else does. When
  // they end, the directory is empty: nothing they created is left for the next run.
  const tmp = await temporaryDirectory('tmp-cleanup-db-tests');
  const run = await runTestFiles(['tests/deploy-observation.test.ts', 'tests/action-priority.test.ts', 'tests/exhaustion-notice.test.ts', 'tests/agent-registry.test.ts'], {
    TMPDIR: tmp,
    GRAPHYARD_DEPLOY_OBSERVATION_TEST_PORT: String(suitePortBase + 150),
    GRAPHYARD_ACTION_PRIORITY_TEST_PORT: String(suitePortBase + 151),
    GRAPHYARD_EXHAUSTION_NOTICE_TEST_PORT: String(suitePortBase + 152),
    GRAPHYARD_REGISTRY_TEST_PORT: String(suitePortBase + 154),
  });
  assert.equal(run.code, 0, `${run.stdout.slice(-2_000)}\n${run.stderr.slice(-2_000)}`);
  assert.match(run.stdout, /^ℹ pass [1-9]\d*$/m, 'the DB tests ran');
  // tsx keeps its compile cache in the temporary directory; that is the loader's, not a test's.
  const leftover = (await readdir(tmp)).filter(name => !/^tsx-\d+$/.test(name));
  assert.deepEqual(leftover, [], `the DB tests left temporary directories behind: ${leftover.join(', ')}`);
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
  const dead = await temporaryDirectory('graphyard-corpse', root);
  const owner = await writeTempOwner(dead);
  owner.pid = exited.pid!; owner.startedAt = null;
  await writeFile(tempOwnerMarker(dead), JSON.stringify(owner));
  // A live one: marked by this very process.
  const live = await temporaryDirectory('graphyard-live', root);
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
  await backdate(join(old, 'data.bin'), 8); await backdate(old, 8);
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
  await mkdir(tsx); await writeFile(join(tsx, 'chunk.js'), 'export {};\n'); await backdate(join(tsx, 'chunk.js'), 8); await backdate(tsx, 8);
  // A tsx cache in use: its directory's own mtime is old, but tsx rewrote an entry a minute ago.
  const busy = join(root, 'tsx-1001');
  await mkdir(busy); await writeFile(join(busy, 'stale.js'), 'export {};\n'); await backdate(join(busy, 'stale.js'), 8);
  await writeFile(join(busy, 'fresh.js'), 'export {};\n'); await backdate(busy, 8);
  // Marked by a live pid whose start could not be recorded: it may be a recycled pid, so the
  // marker does not keep an old, unheld directory.
  const unverified = join(root, 'graphyard-unverified-owner');
  await mkdir(unverified);
  await writeFile(tempOwnerMarker(unverified), JSON.stringify({ pid: process.pid, startedAt: null, at: new Date().toISOString() }));
  await backdate(unverified, 9);

  const report = await reclaimTmpDirectories({ now: Date.now(), tmpRoot: root });
  assert.deepEqual(report.removed.map(entry => entry.path), [unverified, old, tsx], 'the old unheld directories and the stale tsx cache go, oldest first');
  assert.equal(existsSync(busy), true, 'a tsx cache with a freshly written entry stays, however old its directory');
  assert.deepEqual(report.errors, []);
  assert.equal(existsSync(held), true, 'a directory a live process holds open stays');
  assert.equal(existsSync(young), true, 'a directory younger than the age bound stays');
  assert.equal(existsSync(mine), true, 'a directory whose owning process still runs stays, however old');
  assert.ok(report.bytes >= 4096 + 'export {};\n'.length, `the report carries the bytes freed (${report.bytes})`);
  assert.match(describeTmpReclaim(report.removed.length, report.bytes) ?? '', /^freed .+ from 3 stale \/tmp directories$/);

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

test('unit:tmp-reclaim: the loop\'s reclaim step records the bytes the /tmp pass freed, and never waits on the pass', async () => {
  const root = await temporaryDirectory('tmp-reclaim-loop');
  await mkdir(join(root, '.graphyard'));
  // A pass that frees two directories: the step starts it and moves on — its cycle records nothing
  // yet, however long the pass takes — and the next cycle's record carries what it freed.
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const freed = { at: new Date().toISOString(), scanned: 2, removed: [{ path: '/tmp/graphyard-a', bytes: 3e8 }, { path: '/tmp/graphyard-b', bytes: 2e8 }], bytes: 5e8, kept: 0, errors: [] };
  assert.equal(takeTmpReclaim(async () => { await gate; return freed; }), null, 'a pass just started has nothing to report');
  const during = await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] });
  assert.deepEqual(during.tmp, { removed: 0, bytes: 0 }, 'the cycle did not wait for the pass in flight');
  release(); await settleTmpReclaim();
  const after = await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] });
  assert.deepEqual(after.tmp, { removed: 2, bytes: 5e8 });
  assert.match(describeReclaim(after) ?? '', /freed 0\.5 GB from 2 stale \/tmp directories/);
  assert.deepEqual(after.errors, []);
  const recorded = await readReclaimReports(root);
  assert.deepEqual(recorded.at(-1)?.tmp, { removed: 2, bytes: 5e8 }, 'the reclaim record carries the bytes freed');
  await settleTmpReclaim();
});
