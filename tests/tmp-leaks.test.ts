import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopTmpReclaimOptions, readReclaimReports, readResources, readTmpInodes, reclaimResources, resourceAttention, settleTmpReclaim, type ResourceInputs } from '../src/master-resources.js';
import { reclaimTmpDirectories, testTempMinAgeMs, writeTempOwner } from '../src/tmp-reclaim.js';
// A namespace import: on a base without GY-1368's export the case fails, not the file's load.
import * as tmpReclaim from '../src/tmp-reclaim.js';
import { runnerPasswordFileAgeMs, sweepLeftoverTempDirectories } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1074: on 1 October 2026 /tmp reached three quarters of its inodes within hours — test runs'
// landing-merge-result*, native-*, pg-password*, playwright profiles and graphyard-*/gy-* entries —
// and the per-user quota broke every worker shell. Two answers are proven here: the test files
// that leaked and the embedded-Postgres setup leave nothing in the tmpdir they ran with, and the
// loop's reclaim pass removes this user's stale test temp entries by name and age, reporting the
// count and the /tmp inode headroom in master status.

/** Spawn test files as the suite runner does, in their own test context, and wait for them to end. */
const runTestFiles = (files: string[], environment: NodeJS.ProcessEnv, cwd = process.cwd()) => new Promise<{ code: number; stdout: string; stderr: string }>(done => {
  const { NODE_TEST_CONTEXT: _inherited, ...inherited } = process.env;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', ...files], { cwd, env: { ...inherited, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  child.on('close', code => done({ code: code ?? 1, stdout, stderr }));
});
/** The tmpdir's entries, without tsx's compile cache: that is the loader's, not a test's. */
const snapshot = async (directory: string) => (await readdir(directory)).filter(name => !/^tsx-\d+$/.test(name)).sort();
const backdate = async (path: string, ms: number) => { const past = new Date(Date.now() - ms); await utimes(path, past, past); };
const freePort = () => new Promise<number>((done, fail) => {
  const server = createServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => done(port)); });
});

test('unit:tests-leave-no-temp-files — landing-merge-result and github tests leave no new entry in os.tmpdir()', async () => {
  const tmp = await temporaryDirectory('leak-snapshot');
  const before = await snapshot(tmp);
  const run = await runTestFiles(['tests/landing-merge-result.test.ts', 'tests/github.test.ts'], { TMPDIR: tmp });
  assert.equal(run.code, 0, `${run.stdout.slice(-2_000)}\n${run.stderr.slice(-2_000)}`);
  assert.match(run.stdout, /^ℹ pass [1-9]\d*$/m, 'the tests ran');
  assert.match(run.stdout, /^ℹ skipped 0$/m);
  assert.deepEqual(await snapshot(tmp), before, 'the tests left entries in their tmpdir');
});

test('unit:tests-leave-no-temp-files — an embedded Postgres made through the test helper leaves no pg-password file, and the runner takes one a killed init left', async () => {
  const tmp = await temporaryDirectory('pg-password-snapshot');
  const scratch = await temporaryDirectory('pg-password-child');
  const child = join(scratch, 'database.test.ts');
  // The suite's own shape of a database test: the data dir from the helper, started, stopped.
  await writeFile(child, `
import { test } from 'node:test';
import EmbeddedPostgres from ${JSON.stringify(import.meta.resolve('embedded-postgres'))};
import { temporaryDirectory } from ${JSON.stringify(import.meta.resolve('./helpers/temp-dirs.ts'))};
test('starts and stops a database', async () => {
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('pg-password-db'), user: 'graphyard', password: 'testing-only', port: Number(process.env.PG_PASSWORD_CHILD_PORT), persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.stop();
});
`);
  const before = await snapshot(tmp);
  const run = await runTestFiles([child], { TMPDIR: tmp, PG_PASSWORD_CHILD_PORT: String(await freePort()) }, scratch);
  assert.equal(run.code, 0, `${run.stdout.slice(-2_000)}\n${run.stderr.slice(-2_000)}`);
  assert.match(run.stdout, /^ℹ pass 1$/m, 'the database test ran');
  const after = await snapshot(tmp);
  assert.deepEqual(after.filter(name => name.startsWith('pg-password')), [], 'no pg-password file is left');
  assert.deepEqual(after, before, 'nothing else is left either');

  // A process killed between initdb's password write and its unlink leaves the file: the runner
  // takes it once it is older than any init, and never a fresh one another run's initdb may read.
  const stale = join(tmp, 'pg-password-killed'), fresh = join(tmp, 'pg-password-initialising'), other = join(tmp, 'unrelated-file');
  for (const path of [stale, fresh, other]) await writeFile(path, 'testing-only\n');
  await backdate(stale, runnerPasswordFileAgeMs + 60_000); await backdate(other, runnerPasswordFileAgeMs + 60_000);
  assert.deepEqual(await sweepLeftoverTempDirectories('in the test', tmp), [stale]);
  assert.equal(existsSync(fresh), true, 'a password file younger than the bound stays');
  assert.equal(existsSync(other), true, 'a name the sweep does not own stays');
});

test('unit:loop-sweeps-stale-test-temp — the loop removes this user\'s test temp entries older than two hours by name, never younger ones or other names, and master status reports the count and /tmp inode headroom', async () => {
  const root = await temporaryDirectory('loop-test-temp');
  await mkdir(join(root, '.graphyard'));
  const tmp = join(root, 'tmp');
  await mkdir(tmp);
  const old = testTempMinAgeMs + 30 * 60_000, young = testTempMinAgeMs - 30 * 60_000;
  const make = async (name: string, kind: 'file' | 'dir', age: number) => {
    const path = join(tmp, name);
    if (kind === 'dir') { await mkdir(path); await writeFile(join(path, 'entry'), 'x'); await backdate(join(path, 'entry'), age); }
    else await writeFile(path, 'x');
    await backdate(path, age);
    return path;
  };
  const stale = [
    await make('graphyard-leftover-a1', 'dir', old), await make('gy-scratch-b2', 'dir', old),
    await make('landing-merge-result-c3', 'dir', old), await make('native-review-d4', 'dir', old),
    await make('native-96d922de.json', 'file', old), await make('pg-password-e5', 'file', old),
    await make('playwright_chromiumdev_profile-f6', 'dir', old),
  ];
  const kept = [
    // Younger than two hours, each pattern's name notwithstanding.
    await make('graphyard-young', 'dir', young), await make('pg-password-young', 'file', young), await make('native-young', 'dir', young),
    // Old, but not a test temp name.
    await make('voice-recording', 'dir', old), await make('notes.txt', 'file', old), await make('gyro-data', 'dir', old), await make('my-native-file', 'file', old),
  ];
  // The loop's own pass over this root: started by one cycle, recorded by the next.
  const options = { tmpRoot: tmp, tmpPass: (pass: Parameters<typeof reclaimTmpDirectories>[0]) => reclaimTmpDirectories({ ...pass, held: new Set() }) };
  assert.deepEqual(loopTmpReclaimOptions([tmp]).tmpRoots, [tmp]);
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  const report = await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  assert.deepEqual(report.errors, []);
  assert.equal(report.tmp.removed, stale.length, 'every stale test temp entry went in one pass');
  for (const path of stale) assert.equal(existsSync(path), false, `${path} is removed`);
  for (const path of kept) assert.equal(existsSync(path), true, `${path} stays`);
  assert.equal((await readReclaimReports(root)).at(-1)?.tmp.removed, stale.length, 'the reclaim record carries the count removed');

  // Master status: the tmp-inodes reading names the free inodes and the count the pass removed.
  // The volume is stubbed: a test tmpdir may sit on a filesystem without fixed inodes (btrfs reports none).
  const inodes = await readTmpInodes(root, tmp, async () => ({ files: 1_048_576, ffree: 354_178 }));
  assert.ok(inodes, 'the temporary directory\'s inodes are read');
  assert.deepEqual({ ...inodes, removedAt: typeof inodes.removedAt, latest: inodes.latest && { ...inodes.latest, at: inodes.latest.at === inodes.removedAt } },
    { path: tmp, totalInodes: 1_048_576, freeInodes: 354_178, removed: stale.length, removedAt: 'string', latest: { removed: stale.length, at: true, roots: [tmp] }, measuredScanned: true, own: { entries: kept.length, testTemp: 3, capped: false } });
  assert.equal(await readTmpInodes(root, tmp, async () => ({ files: 0, ffree: 0 })), null, 'a filesystem without fixed inodes reads as unknown');
  const input: ResourceInputs = { now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: inodes, profiles: { workers: [], reviewers: [], producers: [] } };
  const reading = readResources(input).find(entry => entry.id === 'tmp-inodes');
  assert.ok(reading, 'master status reads /tmp inodes');
  assert.equal(reading.headroom, inodes.freeInodes, 'the headroom is the free inodes');
  assert.match(reading.detail ?? '', new RegExp(`${inodes.freeInodes} of ${inodes.totalInodes} inodes free; .*removed ${stale.length} entries`));
  // The warning line is a quarter of the inodes free: below it the reading raises attention.
  const low = readResources({ ...input, tmp: { ...inodes, totalInodes: 1000, freeInodes: 200 } }).find(entry => entry.id === 'tmp-inodes');
  assert.equal(low?.state, 'low');
  // GY-1081: the latest pass's own count is reported, so an empty pass after the removal shows 0
  // as current while the last count that was not 0 stays named.
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  const later = await readTmpInodes(root, tmp, async () => ({ files: 1_048_576, ffree: 354_178 }));
  assert.equal(later?.latest?.removed, 0, 'the latest pass removed nothing');
  assert.equal(later?.removed, stale.length, 'the last pass to remove anything is still named');
  assert.notEqual(later?.latest?.at, later?.removedAt);
  // This user's own entries in the directory: every kept entry, three of them with test temp names.
  assert.deepEqual(later?.own, { entries: kept.length, testTemp: 3, capped: false });
  const laterDetail = readResources({ ...input, tmp: later }).find(entry => entry.id === 'tmp-inodes')?.detail ?? '';
  assert.match(laterDetail, new RegExp(`${kept.length} entries at its top level are this user's \\(3 with test temp names\\); the per-user quota itself is not readable`));
  assert.match(laterDetail, /the loop's latest \/tmp pass removed 0 entries at .*; the last pass to remove anything removed 7 entries at /);
  assert.deepEqual((await readTmpInodes(root, tmp, async () => ({ files: 10, ffree: 5 }), (process.getuid?.() ?? 0) + 1))?.own, { entries: 0, testTemp: 0, capped: false }, 'another user\'s entries are not counted as this user\'s');
});

test('unit:loop-sweeps-stale-test-temp — the pass considers only this user\'s entries: another uid\'s stale test temp entries are never scanned or removed', async () => {
  const tmp = await temporaryDirectory('loop-test-temp-uid');
  const stale = [join(tmp, 'graphyard-other-user'), join(tmp, 'pg-password-other-user')];
  await mkdir(stale[0]); await writeFile(stale[1], 'x');
  for (const path of stale) await backdate(path, testTempMinAgeMs + 30 * 60_000);
  // The same entries as another uid would own them: the pass reads its uid from the process, so for
  // one pass the process reports another, and the filter alone keeps the entries out.
  const getuid = process.getuid!, realUid = getuid();
  let other;
  process.getuid = () => realUid + 1;
  try { other = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set() }); } finally { process.getuid = getuid; }
  assert.deepEqual({ scanned: other.scanned, removed: other.removed.length, errors: other.errors }, { scanned: 0, removed: 0, errors: [] });
  for (const path of stale) assert.equal(existsSync(path), true, `${path} is not this pass's to remove`);
  // As this user's entries, the same pass removes them.
  const own = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set() });
  assert.equal(own.removed.length, stale.length);
});

test('unit:tmp-reclaim-scans-every-root — with TMPDIR elsewhere one pass removes stale test temps from /tmp too, keeps young, owned and held entries in both, scans a root once when TMPDIR is /tmp, and status names the roots', async () => {
  const root = await temporaryDirectory('every-root');
  await mkdir(join(root, '.graphyard'));
  // Stand-ins: `own` for the loop's TMPDIR (/var/tmp on 6 October 2026), `shared` for /tmp.
  const own = join(root, 'var-tmp'), shared = join(root, 'tmp');
  await mkdir(own); await mkdir(shared);
  // The loop's default roots are its own tmpdir and /tmp, whatever TMPDIR says.
  const savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = own;
  try { assert.deepEqual(loopTmpReclaimOptions().tmpRoots, [own, '/tmp']); }
  finally { if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir; }
  const roots = tmpReclaim.hostTmpRoots(own, shared);
  assert.deepEqual(roots, [own, shared]);

  const old = testTempMinAgeMs + 30 * 60_000, young = testTempMinAgeMs - 30 * 60_000;
  const make = async (directory: string, name: string, age: number) => {
    const path = join(directory, name);
    await mkdir(path); await writeFile(join(path, 'entry'), 'x');
    await backdate(join(path, 'entry'), age); await backdate(path, age);
    return path;
  };
  const stale: string[] = [], kept: string[] = [], held = new Set<string>();
  for (const directory of roots) {
    stale.push(await make(directory, 'native-leaked', old));
    kept.push(await make(directory, 'native-young', young));
    // Owned by this live process: kept whatever its age.
    const owned = await make(directory, 'graphyard-owned', old);
    await writeTempOwner(owned); await backdate(owned, old);
    kept.push(owned);
    // Ownerless and old, but a live process holds a file inside it open.
    const holding = await make(directory, 'native-held', old);
    held.add(join(holding, 'entry'));
    kept.push(holding);
  }
  const options = { tmpRoots: roots, tmpPass: (pass: Parameters<typeof reclaimTmpDirectories>[0]) => reclaimTmpDirectories({ ...pass, held }) };
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  const report = await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  assert.deepEqual(report.errors, []);
  assert.equal(report.tmp.removed, stale.length, 'one pass removed the stale entry from each root');
  for (const path of stale) assert.equal(existsSync(path), false, `${path} is removed`);
  for (const path of kept) assert.equal(existsSync(path), true, `${path} stays`);

  // TMPDIR resolving to /tmp — the same path, or a symlink to it — is one root, scanned once.
  const link = join(root, 'tmp-link');
  await symlink(shared, link);
  for (const same of [tmpReclaim.hostTmpRoots(shared, shared), tmpReclaim.hostTmpRoots(link, shared)]) {
    const once = await reclaimTmpDirectories({ tmpRoots: same, held });
    assert.deepEqual(once.roots, [same[0]]);
    assert.equal(once.scanned, 3, 'each of the root\'s three candidates is scanned once');
    assert.deepEqual(once.removed, []);
  }

  // Master status names the directory it measured and the roots the latest pass scanned.
  const volume = async () => ({ files: 1000, ffree: 200 });
  const covered = await readTmpInodes(root, shared, volume);
  assert.deepEqual({ roots: covered?.latest?.roots, measuredScanned: covered?.measuredScanned }, { roots: roots, measuredScanned: true });
  const input: ResourceInputs = { now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: covered, profiles: { workers: [], reviewers: [], producers: [] } };
  const reading = readResources(input).find(entry => entry.id === 'tmp-inodes');
  assert.match(reading?.detail ?? '', new RegExp(`^measured ${shared}: 200 of 1000 inodes free; .*the loop's latest /tmp pass removed ${stale.length} entries at [^;]*, scanning ${own} and ${shared}`));
  assert.doesNotMatch(reading?.detail ?? '', /did not scan/);
  // A pass over the loop's own tmpdir alone — the 6 October fault — is visible against /tmp.
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, { ...options, tmpRoots: [own] });
  await settleTmpReclaim();
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, { ...options, tmpRoots: [own] });
  await settleTmpReclaim();
  const missed = await readTmpInodes(root, shared, volume);
  assert.equal(missed?.measuredScanned, false);
  const low = readResources({ ...input, tmp: missed }).find(entry => entry.id === 'tmp-inodes')!;
  assert.equal(low.state, 'low');
  const [line] = resourceAttention([low]);
  assert.match(line?.text ?? '', new RegExp(`measured ${shared}: .*scanning ${own}; that pass did not scan ${shared}`));
});

test('unit:tmp-reclaim-scans-every-root — the pass\'s work bound counts removing only: scanning both roots, however slow, never spends it before the first removal', async () => {
  const root = await temporaryDirectory('work-bound');
  const roots = [join(root, 'var-tmp'), join(root, 'tmp')];
  const stale: string[] = [];
  for (const directory of roots) {
    await mkdir(directory);
    const path = join(directory, 'native-leaked');
    await mkdir(path); await writeFile(join(path, 'entry'), 'x');
    const old = testTempMinAgeMs + 30 * 60_000;
    await backdate(join(path, 'entry'), old); await backdate(path, old);
    stale.push(path);
  }
  // Every clock read lands a second later: the scan of two roots alone outlasts a 500 ms bound.
  const realNow = Date.now, start = realNow();
  let reads = 0;
  Date.now = () => start + 1000 * ++reads;
  let report;
  try { report = await reclaimTmpDirectories({ now: start, tmpRoots: roots, held: new Set(), workMs: 500 }); }
  finally { Date.now = realNow; }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed.map(entry => entry.path), [stale[0]], 'the first removal runs; the one bound then holds across both roots');
  assert.equal(existsSync(stale[1]), true);
});
