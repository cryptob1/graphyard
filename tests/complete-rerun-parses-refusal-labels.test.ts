import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { importAt } from './helpers/base-tree.js';
import { completeCommand } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';

// GY-2979: since GY-2960 the trial's refusal labels each failure `FILE: case title`, and since
// GY-2974 complete re-runs the refusal's entries as runner paths — so `complete GY-101 10 --head
// 37467d0447d8` on the Open City install was refused with "Could not find 'tests/touch-controls.
// test.ts: integration:touch-controls-drive-input touch stick walks, …'" while the file itself
// passed. The rerun must pass the files, not the labels; against the base commit the label is
// still passed whole and node's own "Could not find" refusal comes back.

// GY-2979's base: the tip this hotfix branches from, where the rerun still takes the labels whole.
const baseCommit = '14887ec67a3ba0fb9eaa7e8f6c86a7e768242136';
const head = 'a'.repeat(40);
const refusal = 'trial failed: tests tests/a.test.ts: integration:case-one title, tests/a.test.ts: integration:case-two title';

/**
 * A worktree holding tests/a.test.ts whose suite runner (tests/helpers/run-tests.ts) is a stub
 * recording its file arguments to `rerun.log` and answering for each whether it exists, failing
 * node's way — `Could not find '<argument>'` — for one that does not.
 */
async function worktree() {
  const root = await temporaryDirectory('complete-labels');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --import tsx tests/helpers/run-tests.ts' } }));
  await mkdir(join(root, 'tests', 'helpers'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../', import.meta.resolve('tsx'))), join(root, 'node_modules'));
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await writeFile(join(root, 'tests', 'helpers', 'run-tests.ts'), `
import { appendFileSync, existsSync } from 'node:fs';
const files = process.argv.slice(2);
appendFileSync('rerun.log', JSON.stringify(files) + '\\n');
const missing = files.filter(file => !existsSync(file));
if (missing.length) { for (const file of missing) console.error("Could not find '" + file + "'. "); process.exit(1); }
`);
  await writeFile(join(root, 'tests', 'a.test.ts'), '');
  return root;
}

const work = { id: 'id-1', key: 'GY-1', mergeLedger: { state: 'refused', head: 'b'.repeat(40), refusal: { kind: 'merge', reason: refusal } } } as never;

const context = (root: string, calls: { path: string; body: unknown }[]) => ({
  args: ['1', '--head', head],
  api: async (path: string, body: unknown) => { calls.push({ path, body }); return { key: 'GY-1', submission: { epoch: 1, head } }; },
  print: () => undefined,
  repositoryRoot: () => root,
}) as unknown as CliContext;

const reruns = async (root: string) => (await readFile(join(root, 'rerun.log'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);

test('unit:complete-rerun-parses-refusal-labels-to-files — a GY-2960 trial refusal labelled FILE: case title re-runs the file once and submits when it passes, while the base passes the labels and is refused Could not find', async () => {
  const root = await worktree();
  const calls: { path: string; body: unknown }[] = [];
  // The head: both labels name the one file, so the rerun invokes the runner with exactly that
  // path and, it passing, the submission proceeds.
  await completeCommand.run(context(root, calls), work);
  assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, head } }], 'the passing rerun did not submit');
  // The base commit: the labels go to the runner whole and the refusal is node's Could not find.
  const base = await importAt(baseCommit, 'src/cli/complete.js');
  await assert.rejects(
    (base.completeCommand as typeof completeCommand).run(context(root, calls), work),
    (error: Error) => {
      assert.match(error.message, /complete refused: the merge trial's failing tests still fail on this head/);
      assert.match(error.message, /Could not find 'tests\/a\.test\.ts: integration:case-one title'/);
      return true;
    });
  assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, head } }], 'the refused base complete submitted anyway');
  assert.deepEqual(await reruns(root), [
    ['tests/a.test.ts'],
    ['tests/a.test.ts: integration:case-one title', 'tests/a.test.ts: integration:case-two title'],
  ], 'the head ran the file, the base ran the labels');
});
