import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { completeCommand, rerunFailingCases } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';

// GY-2968: on 2026-10-27 a finished item was refused because complete's automatic rerun hit one
// browser time-out in a case unrelated to the item (298/299 passing), and the refusal blamed an
// earlier refusal's file — a word-limit test that passed. The rerun now judges what its own run
// failed: a case outside the item's proofs retries once on the head and once on the base — a case
// that passes on the retry is a flake the submission records on the item's history, one the base
// fails too is recorded as a base failure — and only a case that fails the head again while the
// base passes it refuses, the refusal naming that case, its file and line, from this run.

const head = 'a'.repeat(40);

/** One failing case a fixture run reports: the case, where the run locates it, the timing it gives. */
const flakyCase = { case: 'unit:outside-proof — case A', file: 'tests/flaky.test.ts', line: 59, durationMs: 30000 };
const baseCase = { case: 'unit:outside-proof — case B', file: 'tests/broken-elsewhere.test.ts', line: 7, durationMs: 4500 };

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};

/** The runner a fixture repo commits: it fails the cases its run-numbered `rerun-fail.json` plan lists, plus every case the committed `base-fail.json` lists, in node's own failure shape. */
const runner = `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const files = process.argv.slice(2);
const prior = existsSync('rerun.log') ? readFileSync('rerun.log', 'utf8').split('\\n').filter(Boolean).length : 0;
appendFileSync('rerun.log', JSON.stringify(files) + '\\n');
const failing = [];
if (existsSync('rerun-fail.json')) failing.push(...(JSON.parse(readFileSync('rerun-fail.json', 'utf8'))[prior] ?? []));
if (existsSync('base-fail.json')) failing.push(...JSON.parse(readFileSync('base-fail.json', 'utf8')));
if (failing.length) {
  for (const failingCase of failing) console.log('✖ ' + failingCase.case + ' (' + failingCase.durationMs + 'ms)');
  console.log('');
  console.log('✖ failing tests:');
  console.log('');
  for (const failingCase of failing) {
    console.log('test at ' + failingCase.file + ':' + failingCase.line + ':5');
    console.log('✖ ' + failingCase.case + ' (' + failingCase.durationMs + 'ms)');
    console.log('  Error: the run failed this case');
  }
  process.exit(1);
}
`;

/**
 * A git repo whose commit is the base the rerun extracts: the base's own tree fails only what a
 * committed `base-fail.json` lists. The working tree adds the per-run `rerun-fail.json` plan the
 * base's tree never holds, so the head's runs and the base's run answer differently.
 */
async function worktree(rerunPlan: unknown[], baseFail: unknown[] = []) {
  const root = await temporaryDirectory('complete-retry');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node rerun-runner.mjs' } }));
  await writeFile(join(root, 'rerun-runner.mjs'), runner);
  if (baseFail.length) await writeFile(join(root, 'base-fail.json'), JSON.stringify(baseFail));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'base');
  if (rerunPlan.length) await writeFile(join(root, 'rerun-fail.json'), JSON.stringify(rerunPlan));
  return { root, base: git(root, 'rev-parse', 'HEAD') };
}

const refused = (reason: string, baseTip = 'c'.repeat(40)) => ({ state: 'refused', head: 'b'.repeat(40), baseTip, refusal: { kind: 'merge', reason } });

const workFor = (mergeLedger: unknown) => ({ id: 'id-1', key: 'GY-1', criteria: [{ id: 'AC-1', text: 'the item\'s own behaviour', proofs: ['unit:own-proof'] }], mergeLedger }) as never;

const context = (root: string, calls: { path: string; body: any }[]) => ({
  args: ['1', '--head', head],
  api: async (path: string, body: unknown) => { calls.push({ path, body }); return { key: 'GY-1', submission: { epoch: 1, head } }; },
  print: () => undefined,
  repositoryRoot: () => root,
}) as unknown as CliContext;

const reruns = async (root: string) => (await readFile(join(root, 'rerun.log'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);

test('unit:complete-rerun-retries-flake-and-names-failing-case — a case outside the item\'s proofs that passes on its retry is a flake the submission records, not a refusal', async () => {
  const { root } = await worktree([[flakyCase], []]);
  const calls: { path: string; body: any }[] = [];
  await completeCommand.run(context(root, calls), workFor(refused('trial failed: tests tests/docs-current-model.test.ts, tests/flaky.test.ts')));
  assert.equal(calls.length, 1, 'the flaked rerun refused the submission');
  assert.equal(calls[0]!.path, 'work/id-1/submit');
  // The history entry the submission carries names the flaked case, its file and line, and its timing.
  assert.deepEqual(calls[0]!.body.flaked, [flakyCase]);
  assert.equal(calls[0]!.body.baseFailures, undefined);
  assert.deepEqual(await reruns(root), [['tests/docs-current-model.test.ts', 'tests/flaky.test.ts'], ['tests/flaky.test.ts']],
    'the retry runs just the failing case\'s file, not the whole refusal list');
});

test('unit:complete-rerun-retries-flake-and-names-failing-case — a case that fails the head again and passes on the base refuses, naming that case, its file and line, none of the earlier refusal', async () => {
  const { root, base } = await worktree([[flakyCase], [flakyCase]]);
  const calls: { path: string; body: any }[] = [];
  await assert.rejects(
    completeCommand.run(context(root, calls), workFor(refused('trial failed: tests tests/docs-current-model.test.ts, tests/flaky.test.ts', base))),
    (error: Error) => {
      assert.match(error.message, /complete refused: unit:outside-proof — case A at tests\/flaky\.test\.ts:59 fails on this head again and passes on the base/);
      assert.doesNotMatch(error.message, /docs-current-model/, 'the refusal named the earlier refusal\'s passing file');
      return true;
    });
  assert.deepEqual(calls, [], 'the refused complete submitted anyway');
});

test('unit:complete-rerun-ignores-base-failures — a case outside the item\'s proofs that the base fails too is recorded with the submission, not refused', async () => {
  const { root, base } = await worktree([[baseCase], [baseCase]], [baseCase]);
  const calls: { path: string; body: any }[] = [];
  await completeCommand.run(context(root, calls), workFor(refused('trial failed: tests tests/broken-elsewhere.test.ts', base)));
  assert.equal(calls.length, 1, 'the base failure refused the submission');
  assert.equal(calls[0]!.path, 'work/id-1/submit');
  assert.deepEqual(calls[0]!.body.baseFailures, [baseCase]);
  assert.equal(calls[0]!.body.flaked, undefined);
});

test('unit:complete-rerun-retries-flake-and-names-failing-case — a failing case of the item\'s own proofs refuses at once, naming that case and its file and line', async () => {
  const ownCase = { case: 'unit:own-proof — the behaviour', file: 'tests/own.test.ts', line: 12, durationMs: 5 };
  const { root } = await worktree([[ownCase]]);
  const calls: { path: string; body: any }[] = [];
  await assert.rejects(
    completeCommand.run(context(root, calls), workFor(refused('trial failed: tests tests/own.test.ts'))),
    /complete refused: the merge trial's failing tests still fail on this head: unit:own-proof — the behaviour at tests\/own\.test\.ts:12/);
  assert.deepEqual(calls, [], 'the refused complete submitted anyway');
  assert.equal((await reruns(root)).length, 1, 'an own-proof failure retried instead of refusing at once');
});

test('unit:complete-rerun-retries-flake-and-names-failing-case — rerunFailingCases reads node\'s failing-tests summary, pairing each test at with its case, once', () => {
  const output = [
    '✔ unit:proof — other case (1ms)',
    '✖ integration:outside — timed out (30000.1ms)',
    '',
    '✖ failing tests:',
    '',
    'test at tests/touch-controls.test.ts:59:5',
    '✖ integration:outside — timed out (30000.1ms)',
    '  Error: timeout',
  ].join('\n');
  assert.deepEqual(rerunFailingCases(output, ['tests/touch-controls.test.ts']),
    [{ case: 'integration:outside — timed out', file: 'tests/touch-controls.test.ts', line: 59, durationMs: 30000 }]);
});

test('unit:complete-rerun-retries-flake-and-names-failing-case — rerunFailingCases reads a TAP failure, locating it through a stack frame in the run\'s files', () => {
  const output = [
    'not ok 1 - unit:tap — breaks',
    '  ---',
    '    at: |-',
    '      TestContext.<anonymous> (/repo/tests/tap.test.ts:9:5)',
    '  ...',
  ].join('\n');
  assert.deepEqual(rerunFailingCases(output, ['tests/tap.test.ts']),
    [{ case: 'unit:tap — breaks', file: 'tests/tap.test.ts', line: 9, durationMs: null }]);
});
