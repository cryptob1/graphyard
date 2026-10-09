import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeTmpReclaim, readTempOwner, reclaimTmpDirectories, tempOwnerMarker, writeTempOwner } from '../src/tmp-reclaim.js';
// A namespace import: on a base without GY-1597's census the case fails, not the file's load.
import * as tmpReclaim from '../src/tmp-reclaim.js';
import { describeReclaim, readReclaimReports, readResources, readTmpInodes, reclaimResources, resourceAttention, settleTmpReclaim, takeTmpReclaim, type ResourceInputs } from '../src/master-resources.js';
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
