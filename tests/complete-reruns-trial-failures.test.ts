import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { completeCommand, trialFailureTests } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';

// GY-2517: a rework after a failed merge trial re-runs the trial's failing test files before
// `complete` submits. On 2026-10-19 GY-2217 attempt 5 was submitted about a minute after its merge
// trial failed four test files, so the serial merge trial became the test runner and each failing
// head cost another trial slot. When the item's latest merge-writer refusal names failing test
// files (`trial failed: tests a, b`), `complete` runs exactly those files in the worktree first and
// refuses to submit while any fails; with no such refusal it runs nothing extra.

const head = 'a'.repeat(40);
const refused = (reason: string) => ({ state: 'refused', head: 'b'.repeat(40), refusal: { kind: 'merge', reason } });

/** A worktree whose suite runner (tests/helpers/run-tests.ts) is a stub recording its file arguments to `rerun.log`, failing those a `rerun-fail` control file lists, holding `files` as its own test files. */
async function worktree(fail: string[] = [], files: string[] = []) {
  const root = await temporaryDirectory('complete-rerun');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --import tsx tests/helpers/run-tests.ts' } }));
  await mkdir(join(root, 'tests', 'helpers'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../', import.meta.resolve('tsx'))), join(root, 'node_modules'));
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await writeFile(join(root, 'tests', 'helpers', 'run-tests.ts'), `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const files = process.argv.slice(2);
appendFileSync('rerun.log', JSON.stringify(files) + '\\n');
const failing = existsSync('rerun-fail') ? files.filter(name => readFileSync('rerun-fail', 'utf8').split('\\n').includes(name)) : [];
if (failing.length) { console.error('✖ failing tests:'); for (const name of failing) console.error('  ' + name); process.exit(1); }
`);
  if (fail.length) await writeFile(join(root, 'rerun-fail'), `${fail.join('\n')}\n`);
  for (const file of files) await writeFile(join(root, file), '');
  return root;
}

const context = (root: string, calls: { path: string; body: unknown }[]) => ({
  args: ['1', '--head', head],
  api: async (path: string, body: unknown) => { calls.push({ path, body }); return { key: 'GY-1', submission: { epoch: 1, pr: 7 } }; },
  print: () => undefined,
  repositoryRoot: () => root,
}) as unknown as CliContext;

const reruns = async (root: string) => (await readFile(join(root, 'rerun.log'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);

test('unit:complete-reruns-trial-failures — a trial refusal naming failing test files makes complete run exactly those files; a run that fails naming no case submits with the note (GY-2980)', async () => {
  const root = await worktree(['tests/still-fails.test.ts'], ['tests/docs-current-model.test.ts', 'tests/still-fails.test.ts']);
  const calls: { path: string; body: any }[] = [];
  await completeCommand.run(context(root, calls), { id: 'id-1', key: 'GY-1', mergeLedger: refused('trial failed: tests tests/docs-current-model.test.ts, tests/still-fails.test.ts') } as never);
  // GY-2980: the run's output names no failing case (a file-level failure, a runner fault), so it
  // can judge nothing — the submission carries the note and the merge trial judges the head.
  assert.equal(calls.length, 1, 'the unjudged rerun refused the submission');
  assert.equal(calls[0]!.path, 'work/id-1/submit');
  assert.equal(calls[0]!.body.rerunUnjudged.note,
    'pre-submit rerun could not judge: the rerun of tests/docs-current-model.test.ts, tests/still-fails.test.ts failed without naming a failing case');
  assert.deepEqual(await reruns(root), [['tests/docs-current-model.test.ts', 'tests/still-fails.test.ts']], 'exactly the refusal\'s files ran, once');
});

test('unit:complete-reruns-trial-failures — the same refusal with every named file passing submits, after running exactly those files', async () => {
  const root = await worktree([], ['tests/docs-current-model.test.ts', 'tests/worker-prompt-gates.test.ts']);
  const calls: { path: string; body: unknown }[] = [];
  await completeCommand.run(context(root, calls), { id: 'id-1', key: 'GY-1', mergeLedger: refused('trial failed: tests tests/docs-current-model.test.ts, tests/worker-prompt-gates.test.ts') } as never);
  assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, head } }]);
  assert.deepEqual(await reruns(root), [['tests/docs-current-model.test.ts', 'tests/worker-prompt-gates.test.ts']]);
});

test('unit:complete-reruns-trial-failures — with no trial refusal naming tests, complete runs nothing and submits', async () => {
  for (const ledger of [undefined, refused('trial failed: build step npm run build'), refused('trial failed: the merge conflicts in src/a.ts, src/b.ts'),
    refused('trial failed: the trial reached no verdict'), { state: 'pushed', head: 'b'.repeat(40), refusal: null }]) {
    const root = await worktree(['tests/a.test.ts']);
    const calls: { path: string; body: unknown }[] = [];
    await completeCommand.run(context(root, calls), { id: 'id-1', key: 'GY-1', mergeLedger: ledger } as never);
    assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, head } }], JSON.stringify(ledger));
    assert.equal(existsSync(join(root, 'rerun.log')), false, `complete ran test files without a refusal naming them: ${JSON.stringify(ledger)}`);
  }
});

test('unit:trial-failure-tests — only a `trial failed: tests …` merge refusal names files', async () => {
  assert.deepEqual(trialFailureTests(undefined), []);
  assert.deepEqual(trialFailureTests(null), []);
  assert.deepEqual(trialFailureTests({ kind: 'revert', reason: 'trial failed: tests tests/a.test.ts' }), []);
  assert.deepEqual(trialFailureTests({ kind: 'merge', reason: 'trial failed: build step npm run build' }), []);
  assert.deepEqual(trialFailureTests({ kind: 'merge', reason: 'trial failed: the merge conflicts in src/a.ts, src/b.ts' }), []);
  assert.deepEqual(trialFailureTests({ kind: 'merge', reason: 'trial failed: the trial reached no verdict' }), []);
  assert.deepEqual(trialFailureTests({ kind: 'merge', reason: `base failure: tests tests/a.test.ts fail on the base tip ${'c'.repeat(40)} too` }), []);
  assert.deepEqual(trialFailureTests({ kind: 'merge', reason: 'trial failed: tests tests/a.test.ts' }), ['tests/a.test.ts']);
  assert.deepEqual(trialFailureTests({ kind: 'merge', reason: 'trial failed: tests tests/docs-current-model.test.ts, tests/worker-prompt-gates.test.ts' }),
    ['tests/docs-current-model.test.ts', 'tests/worker-prompt-gates.test.ts']);
  // GY-2979: a GY-2960 refusal labels each failure `FILE: case title` and a first failing case rides
  // after the files, its own commas splitting into prose. An entry names its file — the text before
  // ': ', a path to an existing test file of the tree the rerun would run — and never its title.
  assert.deepEqual(trialFailureTests({ kind: 'merge', reason: 'trial failed: tests tests/a.test.ts: integration:case-one title, tests/a.test.ts: integration:case-two title' }), ['tests/a.test.ts']);
  assert.deepEqual(trialFailureTests({ kind: 'merge', reason: 'trial failed: tests tests/a.test.ts, tests/b.test.ts: integration:case title, its second clause' }), ['tests/a.test.ts', 'tests/b.test.ts']);
  const tree = await temporaryDirectory('trial-parse');
  await mkdir(join(tree, 'tests'));
  await writeFile(join(tree, 'tests', 'present.test.ts'), '');
  assert.deepEqual(trialFailureTests({ kind: 'merge', reason: 'trial failed: tests tests/present.test.ts: integration:case title, tests/gone.test.ts: integration:other title' }, tree), ['tests/present.test.ts']);
});
