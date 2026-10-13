import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseTree, currentBaseTree } from '../src/cli/planned-files-intent.js';

// GY-1764: a terminal nonRepository refusal rests on a tree read after a successful fetch. A failed
// fetch leaves the last fetched tree, which may lag a base that has since gained the requested file.
const runner = (fetchFails: boolean, files: string[]) => (async (_cmd: string, args: string[]) => {
  if (args[0] === 'fetch') { if (fetchFails) throw new Error('network down'); return ''; }
  return files.join('\0') + '\0';
}) as never;

test('a refreshed base tree is current and readable for a terminal refusal', async () => {
  const tree = await currentBaseTree('/r', 'main', runner(false, ['a.ts']));
  assert.equal(tree.fresh, true);
  assert.ok(tree.files.has('a.ts'));
});

test('a failed fetch leaves the tree stale: baseTree still reads it, currentBaseTree refuses so the ask waits', async () => {
  const stale = runner(true, ['a.ts']);
  assert.equal((await baseTree('/r', 'main', stale)).fresh, false);
  await assert.rejects(currentBaseTree('/r', 'main', stale), /could not be refreshed/);
});

test('a base that gained the file after the failed fetch is decidable once the fetch succeeds', async () => {
  await assert.rejects(currentBaseTree('/r', 'main', runner(true, ['a.ts'])));
  const tree = await currentBaseTree('/r', 'main', runner(false, ['a.ts', 'new-root.md']));
  assert.ok(tree.files.has('new-root.md'));
});
