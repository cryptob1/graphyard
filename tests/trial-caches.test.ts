import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial, trialMerge, type TrialRun } from '../src/merge-writer/trial.js';
import { dependencyImagesDirectory } from '../src/merge-writer/trial-caches.js';
import { cpuPerMergedItem, cpuPressureStep } from '../src/daemon/cpu-pressure.js';
import type { DaemonState } from '../src/daemon/state.js';

// GY-3418: trials redid the same work — an install on an unchanged lockfile, and the same tests on
// the same tree in the merge trial and the batch gate. Two caches keyed by content spare it: the
// dependency image committed by trial image and lockfile, and passing test files keyed by their own
// content, the sources they import and the dependency key. Master status shows CPU-seconds per merged item.

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

/**
 * A repository whose pre-merge test check selects every test file and runs them with a stand-in
 * runner that fails a file containing FAIL and records each file it ran in `ran.log`.
 * tests/a imports src/a; tests/b imports src/b, which imports src/shared; tests/c fails.
 */
async function repository() {
  const root = await temporaryDirectory('trial-caches-repo'), base = await temporaryDirectory('trial-caches-base'), ran = join(base, 'ran.log');
  const files: Record<string, string> = {
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'node -e ""' } }),
    'package-lock.json': '{"lockfileVersion":3,"v":1}\n',
    'graphyard.json': JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [{ check: 'test', command: 'node scripts/run-tests.mjs', source: 'script', reason: 'fixture',
      selection: { command: 'node scripts/select.mjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$' } }] } } }),
    'scripts/select.mjs': "import { readdirSync } from 'node:fs'; for (const file of readdirSync('tests')) console.log('tests/' + file);\n",
    'scripts/run-tests.mjs': `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const files = readFileSync(process.argv[process.argv.indexOf('--files-from') + 1], 'utf8').split('\\n').filter(Boolean);
const results = files.map(file => ({ file, durationMs: 1, passed: !readFileSync(file, 'utf8').includes('FAIL') }));
for (const result of results) { appendFileSync(${JSON.stringify(ran)}, result.file + '\\n'); console.log((result.passed ? 'ok - ' : 'not ok - ') + result.file); }
writeFileSync(process.argv[process.argv.indexOf('--durations') + 1], results.map(result => JSON.stringify(result)).join('\\n') + '\\n');
process.exit(results.every(result => result.passed) ? 0 : 1);
`,
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': "import { shared } from './shared.js';\nexport const b = shared;\n",
    'src/shared.ts': 'export const shared = 1;\n',
    'tests/a.test.ts': "import { a } from '../src/a.js';\n",
    'tests/b.test.ts': "import { b } from '../src/b.js';\n",
    'tests/c.test.ts': '// FAIL\n',
  };
  git(root, 'init', '-q', '-b', 'main');
  write(root, files);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  return { root, base, ran, tip: git(root, 'rev-parse', 'HEAD') };
}
const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
};

/** Children run directly, not in the trial container; `npm ci` is a stand-in that installs one module and is counted. */
function runner() {
  const installs: string[] = [];
  const run: ChildRun = async (command, args, { wrapper: _wrapper, ...options } = {}) => {
    if (command === 'npm' && args[0] === 'ci') {
      installs.push(options.cwd!);
      mkdirSync(join(options.cwd!, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(options.cwd!, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
      return 'added 1 package';
    }
    return defaultChildRun(command, args, options);
  };
  return { run, installs };
}

/** One head on the tip of `main` changing `files`, merged and trialled; the merge lands on main (as a merged item's does). */
async function mergeAndTrial(fixture: Awaited<ReturnType<typeof repository>>, run: ChildRun, files: Record<string, string>): Promise<{ verdict: TrialRun; ran: string[] }> {
  const tip = git(fixture.root, 'rev-parse', 'main');
  git(fixture.root, 'checkout', '-q', '-b', `head-${Object.keys(files).join('-').replace(/\W/g, '')}-${Date.now()}`, tip);
  write(fixture.root, files);
  git(fixture.root, 'add', '-A'); git(fixture.root, 'commit', '-qm', 'change');
  const head = git(fixture.root, 'rev-parse', 'HEAD');
  git(fixture.root, 'checkout', '-q', '--detach', tip);
  const merged = await trialMerge(async args => git(fixture.root, ...args), { head, baseTip: tip });
  assert.ok('mergeSha' in merged);
  writeFileSync(fixture.ran, '');
  const verdict = await runTrial({ root: fixture.root, base: fixture.base, mergeSha: merged.mergeSha, baseTip: tip, changedFiles: Object.keys(files),
    timeoutMs: 120_000, key: 'GY-1', groupSize: 10, environment: { PATH: process.env.PATH! }, run, retries: 0, secretScan: false });
  git(fixture.root, 'update-ref', 'refs/heads/main', merged.mergeSha);
  return { verdict, ran: readFileSync(fixture.ran, 'utf8').split('\n').filter(Boolean).sort() };
}

test('integration:warm-deps-local — two trials of different heads with the same trial image and lockfile install once, the second reusing the committed dependency image; a lockfile change installs again', { timeout: 120_000 }, async () => {
  const fixture = await repository(), { run, installs } = runner();
  const first = await mergeAndTrial(fixture, run, { 'src/a.ts': 'export const a = 2;\n' });
  assert.equal(first.verdict.build, 'pass', first.verdict.logTail);
  assert.equal(installs.length, 1, 'the first trial installs');
  assert.match(first.verdict.logTail, /dependency image \w+ committed/);
  assert.equal(readdirSync(dependencyImagesDirectory(fixture.base)).filter(name => !name.startsWith('.')).length, 1, 'one dependency image is committed');

  const second = await mergeAndTrial(fixture, run, { 'src/b.ts': "import { shared } from './shared.js';\nexport const b = shared + 1;\n" });
  assert.equal(second.verdict.build, 'pass', second.verdict.logTail);
  assert.equal(installs.length, 1, 'the second head, same image and lockfile, installs nothing');
  assert.match(second.verdict.logTail, /dependency image \w+ reused: .*nothing is installed/);
  assert.doesNotMatch(second.verdict.logTail, /\$ npm ci/, 'no install step ran beyond the lookup');

  const third = await mergeAndTrial(fixture, run, { 'package-lock.json': '{"lockfileVersion":3,"v":2}\n' });
  assert.equal(third.verdict.build, 'pass', third.verdict.logTail);
  assert.equal(installs.length, 2, 'a lockfile change installs again');
});

test('integration:test-result-cache — a file that passed in a trial is skipped later while its content, imports and dependency key stand; an imported source change runs it; failed and never-run files always run; only trials populate the cache', { timeout: 120_000 }, async () => {
  const fixture = await repository(), { run } = runner();
  const first = await mergeAndTrial(fixture, run, { 'src/a.ts': 'export const a = 2;\n' });
  assert.deepEqual(first.ran, ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'], 'nothing cached yet: every selected file runs');
  assert.deepEqual(first.verdict.tests.failed, ['tests/c.test.ts'], first.verdict.logTail);

  // src/shared.ts is imported by tests/b only through src/b: b runs, a is cached, c failed before and runs; d is new.
  const second = await mergeAndTrial(fixture, run, { 'src/shared.ts': 'export const shared = 2;\n', 'tests/d.test.ts': "import { a } from '../src/a.js';\n" });
  assert.deepEqual(second.ran, ['tests/b.test.ts', 'tests/c.test.ts', 'tests/d.test.ts'], second.verdict.logTail);
  assert.match(second.verdict.logTail, /test-result cache: 1 file\(s\) .*tests\/a\.test\.ts/);

  // The batch gate is the same trial: the tree unchanged, every passing file is cached and only the failing one runs.
  const gate = await mergeAndTrial(fixture, run, { 'src/unrelated.ts': 'export {};\n' });
  assert.deepEqual(gate.ran, ['tests/c.test.ts'], gate.verdict.logTail);

  // A change whose effect imports cannot trace (docs, data) runs every selected file.
  const docs = await mergeAndTrial(fixture, run, { 'README.md': 'changed\n' });
  assert.deepEqual(docs.ran, ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/d.test.ts']);

  // A new dependency key (lockfile) runs everything again.
  const lock = await mergeAndTrial(fixture, run, { 'package-lock.json': '{"lockfileVersion":3,"v":3}\n', 'src/x.ts': 'export {};\n' });
  assert.equal(lock.ran.length, 4, lock.verdict.logTail);

  // Only the trial records passes: no worker-session path (verify, complete, worker verification) writes the cache.
  const writers = execFileSync('git', ['grep', '-l', 'recordPasses(', '--', 'src'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  assert.deepEqual(writers, ['src/merge-writer/trial-caches.ts', 'src/merge-writer/trial.ts']);
});

test('e2e:cpu-per-merged-item — after two merges whose second changes one source file, the second trial skips the unaffected cached tests and installs nothing, and master status shows CPU-seconds per merged item with the target', { timeout: 120_000 }, async () => {
  const fixture = await repository(), { run, installs } = runner();
  write(fixture.root, { 'tests/c.test.ts': '// passes now\n' });
  git(fixture.root, 'commit', '-qam', 'c passes');
  const first = await mergeAndTrial(fixture, run, { 'src/a.ts': 'export const a = 2;\n' });
  assert.deepEqual(first.verdict.tests, { passed: 3, failed: [], files: 3 }, first.verdict.logTail);
  const second = await mergeAndTrial(fixture, run, { 'src/a.ts': 'export const a = 3;\n' });
  assert.deepEqual(second.ran, ['tests/a.test.ts'], 'only the test importing the changed source runs');
  assert.equal(installs.length, 1, 'the second trial installs nothing');

  // The loop tallies the host's busy CPU-seconds each cycle; master status divides them by the merges.
  const day = Date.parse('2026-11-16T12:00:00Z');
  const stat = (busy: number, idle: number) => `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\n`;
  const readings = [stat(0, 0), stat(100_000, 50_000), stat(150_000, 90_000)];
  const state = { cpuPressure: null, cpuSeconds: { days: {} }, cycle: 1 } as unknown as DaemonState;
  for (const [index, text] of readings.entries()) {
    await cpuPressureStep({ state, now: () => day + index * 86_400_000, log: () => {},
      effects: { cpuPressure: async () => ({ pressure: 'some avg10=1.00 avg60=1.00 avg300=1.00 total=1\n', stat: text, celsius: null }) } as never });
  }
  assert.deepEqual(state.cpuSeconds.days, { '2026-11-17': 1000, '2026-11-18': 500 });
  const figure = cpuPerMergedItem(state.cpuSeconds.days, ['2026-11-17T10:00:00Z', '2026-11-17T11:00:00Z', '2026-11-18T10:00:00Z', '2026-11-18T11:00:00Z', '2026-11-18T12:00:00Z'], day + 2 * 86_400_000);
  assert.deepEqual({ ...figure, line: undefined }, { sevenDays: 300, firstDay: 500, target: 250, line: undefined });
  assert.equal(figure!.line, "300 CPU-seconds per merged item over the last 7 days; target 250 or less, half the first day's 500 (2026-11-17)");
});
