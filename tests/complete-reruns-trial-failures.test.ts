import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

/** A worktree whose `npm test` is a runner recording its file arguments to `rerun.log`, failing those a `rerun-fail` control file lists. */
async function worktree(fail: string[] = []) {
  const root = await temporaryDirectory('complete-rerun');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node rerun-runner.mjs' } }));
  await writeFile(join(root, 'rerun-runner.mjs'), `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const files = process.argv.slice(2);
appendFileSync('rerun.log', JSON.stringify(files) + '\\n');
const failing = existsSync('rerun-fail') ? files.filter(name => readFileSync('rerun-fail', 'utf8').split('\\n').includes(name)) : [];
if (failing.length) { console.error('✖ failing tests:'); for (const name of failing) console.error('  ' + name); process.exit(1); }
`);
  if (fail.length) await writeFile(join(root, 'rerun-fail'), `${fail.join('\n')}\n`);
  return root;
}

const context = (root: string, calls: { path: string; body: unknown }[]) => ({
  args: ['1', '--head', head],
  api: async (path: string, body: unknown) => { calls.push({ path, body }); return { key: 'GY-1', submission: { epoch: 1, pr: 7 } }; },
  print: () => undefined,
  repositoryRoot: () => root,
}) as unknown as CliContext;

const reruns = async (root: string) => (await readFile(join(root, 'rerun.log'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);

test('unit:complete-reruns-trial-failures — a trial refusal naming failing test files makes complete run exactly those files on the head and refuse while one still fails', async () => {
  const root = await worktree(['tests/still-fails.test.ts']);
  const calls: { path: string; body: unknown }[] = [];
  await assert.rejects(
    completeCommand.run(context(root, calls), { id: 'id-1', key: 'GY-1', mergeLedger: refused('trial failed: tests tests/docs-current-model.test.ts, tests/still-fails.test.ts') } as never),
    /complete refused: the merge trial's failing tests still fail on this head \(tests\/docs-current-model\.test\.ts, tests\/still-fails\.test\.ts\)/);
  assert.deepEqual(calls, [], 'the refused complete submitted anyway');
  assert.deepEqual(await reruns(root), [['tests/docs-current-model.test.ts', 'tests/still-fails.test.ts']], 'exactly the refusal\'s files ran, once');
});

test('unit:complete-reruns-trial-failures — the same refusal with every named file passing submits, after running exactly those files', async () => {
  const root = await worktree();
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

test('unit:trial-failure-tests — only a `trial failed: tests …` merge refusal names files', () => {
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
});
