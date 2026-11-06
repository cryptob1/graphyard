import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { othersDeclaredFiles, verificationSlotsDirectory } from '../src/master/verification-slots.js';
import { runTrial, trialAffordableFiles, trialShardBreadth } from '../src/merge-writer/trial.js';
import { launchTrialRun, trialRunsDirectory, type TrialRunSpec } from '../src/merge-writer/trial-run.js';

// GY-3184: a trial's shards are sized by the host's memory alone. Workers' test runs declare their
// files on the verification slots, and taking those declarations off the trial's budget again cut a
// trial on a host with 36 GiB free to one lane.

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const testFiles = [...'abcdefghi'].map(letter => `tests/${letter}.test.ts`);
const installedModules = resolve(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), '..');

/** A repository whose pre-merge test check selects its changed test files and runs them in shards with a stand-in runner. */
async function repository() {
  const root = await temporaryDirectory('trial-lanes-repo'), base = await temporaryDirectory('trial-lanes-base');
  const files: Record<string, string> = {
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'node -e ""' } }),
    'package-lock.json': '{"lockfileVersion":3}\n',
    'graphyard.json': JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [{ check: 'test', command: 'node scripts/run-tests.mjs', source: 'script', reason: 'fixture',
      selection: { command: 'node scripts/select.mjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$' } }] } } }),
    'scripts/select.mjs': "for (const file of process.argv.slice(2)) if (file.startsWith('tests/')) console.log(file);\n",
    'scripts/run-tests.mjs': "import { readFileSync, writeFileSync } from 'node:fs'; const at = process.argv.indexOf('--files-from'); const files = readFileSync(process.argv[at + 1], 'utf8').split('\\n').filter(Boolean);\n"
      + "for (const file of files) console.log('ok - ' + file); const records = process.argv.indexOf('--durations'); writeFileSync(process.argv[records + 1], files.map(file => JSON.stringify({ file, durationMs: 1, passed: true })).join('\\n') + '\\n');\n",
    ...Object.fromEntries(testFiles.map(file => [file, 'x\n'])),
  };
  git(root, 'init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  symlinkSync(installedModules, join(root, 'node_modules'));
  return { root, base, mergeSha: git(root, 'rev-parse', 'HEAD') };
}

const gib = 2 ** 30;
const memory = async () => ({ totalBytes: 62 * gib, availableBytes: 36 * gib });

/** Another run on the host: a live process holding a verification slot under `directory` with `files` declared, until stopped. */
async function otherRun(directory: string, files: number) {
  const ready = join(directory, '..', 'other-run-ready');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { acquireVerificationSlot, declareSlotFiles } from ${JSON.stringify(join(import.meta.dirname, '..', 'src/master/verification-slots.ts'))};
    import { writeFileSync } from 'node:fs';
    const held = await acquireVerificationSlot({ directory: ${JSON.stringify(directory)}, slots: 4, label: 'worker suite' });
    declareSlotFiles(held, ${files});
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `], { stdio: 'ignore' });
  for (let waited = 0; !existsSync(ready) && waited < 30_000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(existsSync(ready), 'the other run declared its files');
  return async () => { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; };
}

test('unit:trial-lanes-ignore-declared — with 36 GiB available of 62 GiB and other runs declaring 60 suite files, the trial budget is memory-only and 9 shards on 8 cores run in 4 lanes', { timeout: 120_000 }, async () => {
  // (36 GiB − max(10% of 62 GiB, 4 GiB) − 1 GiB) / 0.75 GiB a file.
  const budget = await trialAffordableFiles(memory);
  assert.equal(budget, Math.floor((36 - 6.2 - 1) / 0.75));
  assert.deepEqual(trialShardBreadth(8, 9, budget), { lanes: 4, breadth: 2 });
  // The trial itself, while another run holds 60 declared files on the slots it reads: still 4 lanes.
  const fixture = await repository();
  const slots = verificationSlotsDirectory(fixture.base);
  const stop = await otherRun(slots, 60);
  try {
    assert.equal(await othersDeclaredFiles(slots), 60);
    const timings: string[] = [];
    const verdict = await runTrial({ root: fixture.root, base: fixture.base, mergeSha: fixture.mergeSha, changedFiles: testFiles, timeoutMs: 120_000, key: 'GY-1',
      cores: 8, groupSize: 1, memory, environment: { PATH: process.env.PATH! }, onTiming: step => timings.push(step) });
    assert.deepEqual(verdict.tests, { passed: 9, failed: [], files: 9 }, verdict.logTail);
    assert.deepEqual(timings.filter(step => /lanes/.test(step)), ['tests: 4 lanes, breadth 2']);
  } finally { await stop(); }
});

test('unit:trial-lanes-ignore-declared — a trial\'s steps.jsonl carries one timing entry naming its lanes and breadth', { timeout: 120_000 }, async () => {
  const fixture = await repository();
  const spec: TrialRunSpec = { version: 1, key: 'GY-1', head: fixture.mergeSha, mergeSha: fixture.mergeSha, baseTip: null,
    changedFiles: testFiles, proofs: [], e2eProofs: [], timeoutMs: 120_000, reproduce: false,
    cores: 8, root: fixture.root, base: fixture.base, hidden: [], startedAt: new Date().toISOString() };
  const handle = launchTrialRun({ runsRoot: trialRunsDirectory(fixture.root), spec, pollMs: 100 });
  for (let waited = 0; !existsSync(join(handle.directory, 'spec.json')) && waited < 10_000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  const verdict = await handle.trial();
  assert.deepEqual(verdict.tests, { passed: 9, failed: [], files: 9 }, verdict.logTail);
  const timings = (await readFile(join(handle.directory, 'steps.jsonl'), 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { timing?: string; durationMs?: number }).filter(entry => entry.timing !== undefined);
  const lanes = timings.filter(entry => /lanes/.test(entry.timing!));
  assert.equal(lanes.length, 1, JSON.stringify(timings));
  const [, count, breadth] = /^tests: (\d+) lanes, breadth (\d+)$/.exec(lanes[0]!.timing!) ?? [];
  assert.ok(Number(count) >= 1 && Number(breadth) >= 1, lanes[0]!.timing);
  assert.ok(readFileSync(join(handle.directory, 'result.json'), 'utf8').includes('"ok":true'));
});
