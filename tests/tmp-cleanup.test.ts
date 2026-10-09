import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeTmpReclaim, readTempOwner, reclaimTmpDirectories, tempOwnerMarker, writeTempOwner } from '../src/tmp-reclaim.js';
// A namespace import: on a base without GY-1597's census the case fails, not the file's load.
import * as tmpReclaim from '../src/tmp-reclaim.js';
import { describeReclaim, describeStandingTmpPass, readReclaimReports, readResources, readTmpInodes, reclaimResources, resourceAttention, settleTmpReclaim, takeTmpReclaim, type ResourceInputs } from '../src/master-resources.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { standingTmpKey } from '../src/daemon/cycle-reclaim.js';

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
  // Every entry is as old as the unheld one, so only the live holder can keep it.
  await mkdir(held); await writeFile(join(held, 'data.bin'), Buffer.alloc(4096, 1));
  await backdate(join(held, 'data.bin'), 8); await backdate(held, 8);
  const holder = spawn('sleep', ['120'], { cwd: held, stdio: 'ignore' });
  t.after(() => { holder.kill('SIGKILL'); });
  await once(holder, 'spawn');
  // Young: too new for the age bound, whatever its holders.
  const young = join(root, 'graphyard-young');
  await mkdir(young);
  // Old with a live owner: the marker names this process, so the age never applies.
  const mine = join(root, 'graphyard-live-owner');
  await mkdir(mine); await writeTempOwner(mine); await backdate(mine, 8);
  // The tsx cache, stale: the same pass ages its old file, and the directory stays (GY-1512).
  const tsx = join(root, 'tsx-1000');
  await mkdir(tsx); await writeFile(join(tsx, 'chunk.js'), 'export {};\n'); await backdate(join(tsx, 'chunk.js'), 8); await backdate(tsx, 8);
  // A tsx cache in use: its directory's own mtime is old, tsx rewrote one entry a minute ago, and its stale entry goes.
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
  assert.deepEqual(report.removed.map(entry => entry.path), [unverified, old, join(tsx, 'chunk.js'), join(busy, 'stale.js')], 'the old unheld directories go oldest first, then the tsx caches\' stale files');
  assert.equal(existsSync(tsx), true, 'a stale tsx cache directory is never taken whole');
  assert.equal(existsSync(join(busy, 'fresh.js')), true, 'a tsx cache\'s freshly written entry stays, however old its directory');
  assert.deepEqual(report.errors, []);
  assert.equal(existsSync(held), true, 'a directory a live process holds open stays');
  assert.equal(existsSync(young), true, 'a directory younger than the age bound stays');
  assert.equal(existsSync(mine), true, 'a directory whose owning process still runs stays, however old');
  assert.ok(report.bytes >= 4096 + 'export {};\n'.length, `the report carries the bytes freed (${report.bytes})`);
  assert.match(describeTmpReclaim(report.removed.length, report.bytes) ?? '', /^freed .+ from 4 stale \/tmp entries$/);

  // The holder alone kept it: once the process that held it exits, the next pass takes it.
  holder.kill('SIGKILL'); await once(holder, 'exit');
  const released = await reclaimTmpDirectories({ now: Date.now(), tmpRoot: root });
  assert.deepEqual(released.removed.map(entry => entry.path), [held], 'the same directory goes once no live process holds it');
  assert.equal(existsSync(held), false);

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
  const during = await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, { tmpRoot: root });
  assert.deepEqual(during.tmp, { removed: 0, bytes: 0 }, 'the cycle did not wait for the pass in flight');
  release(); await settleTmpReclaim();
  const after = await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, { tmpRoot: root });
  assert.deepEqual(after.tmp, { removed: 2, bytes: 5e8 });
  assert.match(describeReclaim(after) ?? '', /freed 0\.5 GB from 2 stale \/tmp entries/);
  assert.deepEqual(after.errors, []);
  const recorded = await readReclaimReports(root);
  assert.deepEqual(recorded.at(-1)?.tmp, { removed: 2, bytes: 5e8 }, 'the reclaim record carries the bytes freed');
  await settleTmpReclaim();
});

// GY-1401: the loop's pass failed `ENOTEMPTY` on the same stale entry every cycle — a verify tree
// still filling while `rm` walked it — and its half-finished removal made the entry look freshly
// written, so it stood in the resources report as a permanent error line.
const staleTree = async (root: string, name: string) => {
  const entry = join(root, name), deepest = join(entry, 'work', '.graphyard', 'verify', 'tree');
  await mkdir(deepest, { recursive: true });
  for (let index = 0; index < 50; index++) await writeFile(join(deepest, `file-${index}`), 'x');
  const past = new Date(Date.now() - 8 * 3_600_000);
  for (const path of [deepest, join(entry, 'work', '.graphyard', 'verify'), join(entry, 'work', '.graphyard'), join(entry, 'work'), entry]) await utimes(path, past, past);
  return { entry, deepest };
};

test('unit:tmp-reclaim-nonempty-entry-removed — a stale entry whose nested verify tree gains files while it is removed is removed, not abandoned', async () => {
  const root = await temporaryDirectory('reclaim-nonempty');
  const { entry, deepest } = await staleTree(root, 'graphyard-filling');
  // A writer that keeps adding files to the nested tree while the removal walks it, for longer than one rm attempt. It
  // writes below the entry's own children, so the scan still judges the entry stale by the mtimes it reads.
  let writes = 0, writing = true;
  const write = () => {
    if (!writing) return;
    for (const dir of [deepest, join(entry, 'work', '.graphyard')]) try { writeFileSync(join(dir, `late-${writes++}`), 'y'); } catch { /* removed already */ }
    setImmediate(write);
  };
  setImmediate(write);
  const stop = setTimeout(() => { writing = false; }, 100);
  try {
    const report = await reclaimTmpDirectories({ now: Date.now(), tmpRoot: root, held: new Set(), unfinished: new Set() });
    assert.deepEqual(report.errors, [], 'the removal retried the refilling tree rather than failing ENOTEMPTY');
    assert.deepEqual(report.removed.map(removed => removed.path), [entry]);
    assert.equal(existsSync(entry), false, 'the non-empty stale entry is gone');
    assert.ok(writes > 0, 'files were created while the removal ran');
  } finally { writing = false; clearTimeout(stop); }
});

test('unit:tmp-reclaim-error-isolated — one entry\'s removal failure leaves the rest of the pass reclaimed, names only that entry, and the next pass takes it', { skip: process.getuid?.() === 0 && 'root removes a read-only directory\'s entries' }, async t => {
  const root = await temporaryDirectory('reclaim-isolated');
  const { entry: stuck, deepest } = await staleTree(root, 'graphyard-stuck');
  const { entry: other } = await staleTree(root, 'graphyard-other');
  // The nested tree cannot be emptied this pass: its directory refuses removal of its entries.
  await chmod(deepest, 0o555);
  t.after(() => chmod(deepest, 0o755).catch(() => {}));
  const unfinished = new Set<string>();
  const first = await reclaimTmpDirectories({ now: Date.now(), tmpRoot: root, held: new Set(), unfinished, retryMs: 20 });
  assert.deepEqual(first.removed.map(removed => removed.path), [other], 'the remaining removable entry is still reclaimed in the same pass');
  assert.equal(first.errors.length, 1);
  assert.ok(first.errors[0].startsWith(`${stuck}: `), `the report names only the failing entry: ${first.errors[0]}`);
  assert.equal(existsSync(other), false);
  // Whatever blocked it clears; the half-finished removal left the entry looking freshly written,
  // so only the carried retry takes it — the next pass, not hours later, and no standing error.
  await chmod(deepest, 0o755);
  await utimes(stuck, new Date(), new Date());
  const second = await reclaimTmpDirectories({ now: Date.now(), tmpRoot: root, held: new Set(), unfinished });
  assert.deepEqual(second.errors, [], 'the entry does not accrue as a standing error across two consecutive passes');
  assert.deepEqual(second.removed.map(removed => removed.path), [stuck]);
  assert.equal(existsSync(stuck), false);
  assert.equal(unfinished.size, 0, 'nothing is left carried once it is removed');
});

// GY-1597: a pass that removes 0 entries while /tmp stays below its inode headroom must neither
// repeat silently nor leave the leaker unnamed.
const leakingRoot = async (name: string) => {
  const tmp = await temporaryDirectory(name);
  // One large leaker directory, a family of same-stem siblings, and a cache of fresh files: nothing the pass may take.
  const leaker = join(tmp, 'chrome-cache');
  await mkdir(join(leaker, 'deep'), { recursive: true });
  for (let index = 0; index < 40; index++) await writeFile(join(leaker, 'deep', `blob-${index}`), 'x');
  for (let index = 0; index < 12; index++) await writeFile(join(tmp, `core-dump-${index}a7f`), 'x');
  const uid = process.getuid?.();
  if (uid !== undefined) { await mkdir(join(tmp, `tsx-${uid}`)); for (let index = 0; index < 5; index++) await writeFile(join(tmp, `tsx-${uid}`, `fresh-${index}`), 'x'); }
  return { tmp, leaker };
};
const lowVolume = async () => ({ files: 4000, ffree: 100 });

test('unit:tmp-leaks — a pass below the inode headroom that removes 0 entries escalates through every step in the same run and names the top /tmp consumers by path, entry count and owner', async () => {
  const { tmp, leaker } = await leakingRoot('zero-pass-escalates');
  const report = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set(), limit: 100, workMs: 150, volume: lowVolume });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed, [], 'nothing here is the pass\'s to take');
  assert.deepEqual(report.escalated?.map(step => step.limit), [2_000, 20_000], 'the cap rose at each step, in the same run');
  assert.deepEqual(report.escalated?.map(step => step.cacheAgeMs), [3_600_000, 600_000], 'the cache age fell at each step');
  assert.equal(report.boundStands, true);
  const owner = userInfo().username;
  assert.deepEqual(report.consumers?.slice(0, 2), [
    { path: leaker, entries: 1 + 1 + 40, owner },
    { path: `${join(tmp, 'core-dump')}* (12 top-level)`, entries: 12, owner },
  ], 'the largest consumers lead, siblings of one stem counted as one family');
  assert.equal(existsSync(leaker), true, 'naming a consumer removes nothing');
  // A census is bounded: past its entry budget it names what it reached as capped.
  const capped = await tmpReclaim.tmpConsumers([tmp], 10);
  assert.ok(capped.some(consumer => consumer.capped), 'a census past its bound says so');
  // Top-level entries count against the same budget: a root of flat files stops at the bound, and every family it names is capped.
  const flat = await temporaryDirectory('zero-pass-flat');
  for (let index = 0; index < 12; index++) await writeFile(join(flat, `leak-${index}x`), 'x');
  const stopped = await tmpReclaim.tmpConsumers([flat], 5);
  assert.equal(stopped.reduce((total, consumer) => total + consumer.entries, 0), 5, 'the census counted no more top-level entries than its bound');
  assert.ok(stopped.length > 0 && stopped.every(consumer => consumer.capped), 'a census stopped among top-level entries marks what it names as capped');
});

test('unit:tmp-cleanup — the loop records the escalated pass and the consumers it named, and the tmp-inodes attention carries them', async () => {
  const root = await temporaryDirectory('zero-pass-attention');
  await mkdir(join(root, '.graphyard'));
  const { tmp, leaker } = await leakingRoot('zero-pass-attention-tmp');
  const options = { tmpRoot: tmp, tmpPass: (pass: Parameters<typeof reclaimTmpDirectories>[0]) => reclaimTmpDirectories({ ...pass, held: new Set(), volume: lowVolume }) };
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  const inodes = await readTmpInodes(root, tmp, lowVolume);
  assert.deepEqual(inodes?.latest?.escalated?.map(step => step.removed), [0, 0]);
  assert.equal(inodes?.latest?.consumers?.[0]?.path, leaker);
  const input: ResourceInputs = { now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: inodes, profiles: { workers: [], reviewers: [], producers: [] } };
  const reading = readResources(input).find(entry => entry.id === 'tmp-inodes')!;
  assert.equal(reading.state, 'low');
  const [line] = resourceAttention([reading]);
  assert.match(line?.text ?? '', /below the inode headroom it escalated to 20000 per cycle and tsx cache files older than 10 minutes \(0 \+ 0 removed by the escalated steps\)/);
  assert.match(line?.text ?? '', new RegExp(`the top /tmp consumers are ${leaker} \\(42 entries, owner ${userInfo().username}\\)`));
  assert.match(reading.reclaim, /escalates .* names the top \/tmp consumers/, 'the registry describes the escalation');
});

test('unit:tmp-cleanup — a zero-removal pass that leaves /tmp between a tenth and a quarter free still raises the tmp-inodes attention naming the consumers', async () => {
  const root = await temporaryDirectory('zero-pass-gap');
  await mkdir(join(root, '.graphyard'));
  const { tmp, leaker } = await leakingRoot('zero-pass-gap-tmp');
  // 209,715 of 1,048,576 free: above a tenth, below the 262,144 quarter-free headroom.
  const gapVolume = async () => ({ files: 1_048_576, ffree: 209_715 });
  const options = { tmpRoot: tmp, tmpPass: (pass: Parameters<typeof reclaimTmpDirectories>[0]) => reclaimTmpDirectories({ ...pass, held: new Set(), volume: gapVolume }) };
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  const inodes = await readTmpInodes(root, tmp, gapVolume);
  assert.equal(inodes?.latest?.removed, 0);
  assert.equal(inodes?.measuredScanned, true, 'the pass is current over the measured directory');
  const input: ResourceInputs = { now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: inodes, profiles: { workers: [], reviewers: [], producers: [] } };
  const reading = readResources(input).find(entry => entry.id === 'tmp-inodes')!;
  assert.equal(reading.state, 'low');
  assert.ok(!reading.answered, 'a pass that removed 0 and named consumers answers nothing');
  const [line] = resourceAttention([reading]);
  assert.equal(line?.subject, 'resource:tmp-inodes');
  assert.match(line?.text ?? '', new RegExp(`the top /tmp consumers are ${leaker} \\(42 entries`));
  // The same reading after a pass that took entries back stays answered, as GY-1379 set out.
  const progressed: ResourceInputs = { ...input, tmp: { ...inodes!, latest: { ...inodes!.latest!, removed: 3 } } };
  assert.equal(resourceAttention(readResources(progressed).filter(entry => entry.id === 'tmp-inodes')).length, 0);
});

// GY-1600: on 9 October 2026 the loop's /tmp pass removed 0 entries at 19:34Z while /tmp stood at
// 98,830 of 1,048,576 inodes free, and the cycle recorded nothing: describeReclaim has nothing to
// say about a pass that took nothing, so the ledger fell silent exactly while the bound stood.
test('unit:tmp-reclaim-zero-escalates — a /tmp pass that removes 0 entries while the inode bound stands is recorded in the cycle\'s action ledger with what it scanned and why nothing was eligible; one with the bound clear records nothing', async () => {
  const root = await temporaryDirectory('zero-pass-ledger');
  const credentials = await temporaryDirectory('zero-pass-ledger-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const config = await loadMasterConfig(root);
  const { tmp, leaker } = await leakingRoot('zero-pass-ledger-tmp');
  // A test temp this pass scans and keeps: younger than its age bound.
  await mkdir(join(tmp, 'graphyard-young'));
  const pass = (volume: typeof lowVolume) => async () => {
    const options = { tmpRoot: tmp, tmpPass: (each: Parameters<typeof reclaimTmpDirectories>[0]) => reclaimTmpDirectories({ ...each, held: new Set(), volume }) };
    await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
    await settleTmpReclaim();
    return reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  };
  const cycle = async (reclaim: () => ReturnType<typeof reclaimResources>) => {
    const state = emptyDaemonState(config), clock = Date.now();
    const effects = {
      agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }), closeSession: () => {},
      dispatch: async () => {}, requestProof: () => {}, recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(clock).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
      reclaimResources: reclaim,
    } as unknown as DaemonEffects;
    await runCycle(config, state, effects, () => clock);
    return Object.entries(state.actions).filter(([key]) => key.startsWith('reclaim:tmp:')).map(([, action]) => action);
  };

  // Below the headroom: the pass escalates, removes 0 and names the consumers, and the cycle records it.
  const recorded = await cycle(pass(lowVolume));
  await settleTmpReclaim();
  assert.equal(recorded.length, 1, 'the zero-removal pass under the standing bound is in the ledger');
  const [action] = recorded;
  assert.equal(action.kind, 'reclaim');
  assert.equal(action.state, 'done');
  assert.match(action.detail, /^\/tmp reclaim removed 0 entries while the inode bound stands/);
  assert.match(action.detail, new RegExp(`scanned ${tmp}; its last step, over the roots still below headroom, examined 1 entry with this user's test temp names, 1 kept`), 'it names what it scanned and kept, and which sweep the counts are');
  assert.match(action.detail, /no tsx cache file of this user's it could remove \(each younger than 10 minutes or held open by a live process\)/, 'it says why nothing was eligible without claiming one unmeasured cause');
  assert.doesNotMatch(action.detail, /old enough/);
  assert.match(action.detail, /escalated to 20000 per cycle and tsx cache files older than 10 minutes \(0 \+ 0 removed\)/);
  assert.match(action.detail, new RegExp(`top consumers: ${leaker} \\(42 entries, owner ${userInfo().username}\\)`));
  assert.equal(existsSync(join(tmp, 'graphyard-young')), true, 'recording the pass removes nothing');

  // The bound clear: a pass that removed 0 has nothing to report, as before.
  const clear = await pass(async () => ({ files: 1_048_576, ffree: 900_000 }))();
  await settleTmpReclaim();
  assert.equal(clear.tmpPass?.boundStands, false);
  assert.equal(describeStandingTmpPass(clear), null);
  // A pass that took entries back is reported by describeReclaim, never as a standing zero.
  assert.equal(describeStandingTmpPass({ ...clear, tmp: { removed: 3, bytes: 3 }, tmpPass: { ...clear.tmpPass!, boundStands: true } }), null);
  assert.deepEqual(await cycle(async () => clear), [], 'a pass with the bound clear adds no record');
});

// GY-1600 review of 52628aeeacc3: the zero-removal record must not grow the ledger by one row per
// cycle while the bound stands for days. Three simulated days of the real loop's cycles, the bound
// standing on all of them but two stretches where it clears: every system invariant holds after
// every cycle, each run of standing passes is one row whose attempts count its passes, a run that
// ends is filed under its last pass, and a pass with errors fails its row without a second fault.
test('unit:tmp-reclaim-zero-escalates — over three days of standing zero-removal /tmp passes the ledger holds one row per run of them and every system invariant holds', { timeout: 120_000 }, async () => {
  const root = await temporaryDirectory('zero-pass-soak');
  const credentials = await temporaryDirectory('zero-pass-soak-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const config = await loadMasterConfig(root);
  const minute = 60_000, day = 24 * 60 * minute, cycleMs = 5 * minute, start = Date.now();
  // The bound clears for an hour on each of the first two days; one pass on day three meets an error.
  const clear = (at: number) => [day / 2, day + day / 2].some(from => at - start >= from && at - start < from + 60 * minute);
  const erring = start + 2 * day + day / 2;
  let now = start;
  const reclaimResources = async () => {
    const stands = !clear(now), errors = now === erring ? ['Tmp reclaim: /tmp/graphyard-held: EBUSY'] : [];
    return { at: new Date(now).toISOString(), reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: 0, bytes: 0 }, errors,
      tmpPass: { roots: ['/tmp'], scanned: 3, kept: 3, boundStands: stands, ...(stands ? { escalated: [{ limit: 20_000, cacheAgeMs: 10 * minute, removed: 0 }], consumers: [{ path: '/tmp/leaker', entries: 90_000, owner: 'someone' }] } : {}) } };
  };
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date(now).toISOString() }), closeSession: () => {},
    dispatch: async () => {}, requestProof: () => {}, recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    reclaimResources,
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config), violations: string[] = [];
  let cycles = 0, mostRows = 0;
  for (; now < start + 3 * day; now += cycleMs, cycles++) {
    await runCycle(config, state, effects, () => now);
    for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycles}: ${check.invariant} — ${check.reading}`);
    mostRows = Math.max(mostRows, Object.keys(state.actions).filter(key => key.startsWith('reclaim:tmp:')).length);
  }
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.ok(cycles > 800, `three days of cycles ran: ${cycles}`);
  const rows = Object.entries(state.actions).filter(([key]) => key.startsWith('reclaim:tmp:'));
  // Three runs of standing passes, split by the two clear hours: two filed, one still standing.
  assert.equal(rows.length, 3, `one row per run of standing passes: ${rows.map(([key]) => key)}`);
  assert.equal(mostRows, 3, 'the ledger never held more than one row per run');
  const filed = rows.filter(([key]) => key !== standingTmpKey);
  assert.equal(filed.length, 2);
  for (const [key, action] of filed) assert.equal(key, `reclaim:tmp:${action.at}`, 'a finished run is filed under its last pass');
  const current = state.actions[standingTmpKey];
  assert.ok(current, 'the run still standing has its row');
  const cleared = 2 * (60 * minute / cycleMs), standingPasses = cycles - cleared;
  assert.equal(filed.reduce((total, [, action]) => total + action.attempts, 0) + current.attempts, standingPasses, 'every standing pass is counted, none twice');
  assert.match(current.detail, new RegExp(`^Pass ${current.attempts} in a row: /tmp reclaim removed 0 entries while the inode bound stands`));
  assert.match(current.detail, /top consumers: \/tmp\/leaker/);
  assert.equal(current.state, 'done', 'a later clean pass leaves the run done');
  // The erring pass failed the run's row while it was the latest, and its fault is the resources row's alone.
  assert.equal(Object.values(state.actions).filter(action => action.kind === 'reclaim' && action.state === 'failed').length, 1, 'only the resources row records the failure');
  assert.equal(state.faults.instances.filter(entry => entry.faultClass === 'resources').length <= 1, true, 'the erring pass is at most one resources fault');
});

test('unit:tmp-reclaim-zero-escalates — a standing zero-removal pass with errors fails its row and adds no fault of its own', async () => {
  const root = await temporaryDirectory('zero-pass-errors');
  const credentials = await temporaryDirectory('zero-pass-errors-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const config = await loadMasterConfig(root), clock = Date.now();
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }), closeSession: () => {},
    dispatch: async () => {}, requestProof: () => {}, recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(clock).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    reclaimResources: async () => ({ at: new Date(clock).toISOString(), reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: 0, bytes: 0 }, errors: ['Tmp reclaim: /tmp/graphyard-held: EBUSY'],
      tmpPass: { roots: ['/tmp'], scanned: 1, kept: 1, boundStands: true } }),
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => clock);
  const row = state.actions[standingTmpKey];
  assert.equal(row?.state, 'failed', 'a pass that met errors is not recorded as done');
  assert.match(row.detail, /1 could not be reclaimed: Tmp reclaim: \/tmp\/graphyard-held: EBUSY/);
  assert.equal(row.faultClass, undefined, 'the row carries no fault of its own');
  assert.equal(state.faults.failing[standingTmpKey], undefined);
  assert.deepEqual(Object.entries(state.actions).filter(([, action]) => action.kind === 'reclaim' && action.state === 'failed').map(([key]) => key.split(':').slice(0, 2).join(':')).sort(), ['reclaim:resources', 'reclaim:tmp'], 'the resources row and the /tmp row');
});
