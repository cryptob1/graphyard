import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { completeCommand } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';

// GY-2980 AC-2: the one refusal the pre-submit rerun still makes is a failing case of the item's
// own proofs. A rerun that ran to completion and names such a case refuses, naming that case, its
// file and line — exactly as GY-2968 left it; only the rerun's own faults stopped refusing.

const head = 'a'.repeat(40);
const ownCase = { case: 'unit:own-proof — the behaviour', file: 'tests/own.test.ts', line: 12, durationMs: 5 };
const refused = (reason: string) => ({ state: 'refused', head: 'b'.repeat(40), refusal: { kind: 'merge', reason } });
const work = { id: 'id-1', key: 'GY-1', criteria: [{ id: 'AC-1', text: 'the item\'s own behaviour', proofs: ['unit:own-proof'] }], mergeLedger: refused('trial failed: tests tests/own.test.ts') } as never;

/** A worktree whose suite runner (tests/helpers/run-tests.ts) fails the item's own proof case, in node's own failing shape. */
async function worktree() {
  const root = await temporaryDirectory('complete-own-proof');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --import tsx tests/helpers/run-tests.ts' } }));
  await mkdir(join(root, 'tests', 'helpers'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../', import.meta.resolve('tsx'))), join(root, 'node_modules'));
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await writeFile(join(root, 'tests', 'helpers', 'run-tests.ts'), `
import { appendFileSync } from 'node:fs';
appendFileSync('rerun.log', JSON.stringify(process.argv.slice(2)) + '\\n');
console.log('✖ ${ownCase.case} (${ownCase.durationMs}ms)');
console.log('');
console.log('✖ failing tests:');
console.log('');
console.log('test at ${ownCase.file}:${ownCase.line}:5');
console.log('✖ ${ownCase.case} (${ownCase.durationMs}ms)');
process.exit(1);
`);
  await writeFile(join(root, 'tests', 'own.test.ts'), '');
  return root;
}

const context = (root: string, calls: { path: string; body: unknown }[]) => ({
  args: ['1', '--head', head],
  api: async (path: string, body: unknown) => { calls.push({ path, body }); return { key: 'GY-1', submission: { epoch: 1, head } }; },
  print: () => undefined,
  repositoryRoot: () => root,
}) as unknown as CliContext;

const reruns = async (root: string) => (await readFile(join(root, 'rerun.log'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);

test('unit:complete-rerun-still-refuses-own-proof-failure — a rerun that ran and reports one of the item\'s own proof cases failing refuses, naming that case', async () => {
  const root = await worktree();
  const calls: { path: string; body: unknown }[] = [];
  await assert.rejects(
    completeCommand.run(context(root, calls), work),
    /complete refused: the merge trial's failing tests still fail on this head: unit:own-proof — the behaviour at tests\/own\.test\.ts:12/);
  assert.deepEqual(calls, [], 'the refused complete submitted anyway');
  assert.deepEqual(await reruns(root), [['tests/own.test.ts']], 'the own-proof refusal took no retry');
});
