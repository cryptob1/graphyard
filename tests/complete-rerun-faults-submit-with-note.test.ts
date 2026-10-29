import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { symlink } from 'node:fs/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { importAt } from './helpers/base-tree.js';
import { completeCommand, rerunBound } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';

// GY-2980: complete's pre-submit rerun (GY-2517) is an optimization — the merge trial runs the
// whole suite anyway — yet its own faults refused finished heads three times in three hours on
// 2026-10-29: a whole-suite hang past the bound, and a runner error, node's own "Could not find",
// that parses to no failing case (GY-101). A fault of the rerun itself is no refusal: complete
// submits and records `pre-submit rerun could not judge: <reason>` with the run's last 20 lines on
// the item's history, and the merge trial judges the head. On the base commit both faults refuse.

// GY-2980's base: the tip this change branches from, where a rerun fault still refuses.
const baseCommit = '1f25cf7ef9e2453dc92e7730e9495a9ee424a519';
const head = 'a'.repeat(40);
const refused = (files: string) => ({ state: 'refused', head: 'b'.repeat(40), refusal: { kind: 'merge', reason: `trial failed: tests ${files}` } });

/**
 * A worktree holding tests/gone.test.ts — a file the trial's refusal names, as a worktree a trial
 * failed on holds it — whose suite runner (tests/helpers/run-tests.ts) always fails node's way,
 * `Could not find '<file>'. ` for each of its arguments, naming no case.
 */
async function worktree() {
  const root = await temporaryDirectory('complete-rerun-note');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --import tsx tests/helpers/run-tests.ts' } }));
  await mkdir(join(root, 'tests', 'helpers'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../', import.meta.resolve('tsx'))), join(root, 'node_modules'));
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await writeFile(join(root, 'tests', 'helpers', 'run-tests.ts'), `
import { appendFileSync } from 'node:fs';
const files = process.argv.slice(2);
appendFileSync('rerun.log', JSON.stringify(files) + '\\n');
for (const file of files) console.error("Could not find '" + file + "'. ");
process.exit(1);
`);
  await writeFile(join(root, 'tests', 'gone.test.ts'), '');
  return root;
}

/** A worktree whose suite runner records its arguments and never exits, so the rerun runs past any bound. */
async function hangingWorktree() {
  const root = await temporaryDirectory('complete-rerun-note-hang');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts: { test: 'node --import tsx tests/helpers/run-tests.ts' } }));
  await mkdir(join(root, 'tests', 'helpers'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../', import.meta.resolve('tsx'))), join(root, 'node_modules'));
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await writeFile(join(root, 'tests', 'helpers', 'run-tests.ts'), `
import { appendFileSync } from 'node:fs';
appendFileSync('rerun.log', JSON.stringify(process.argv.slice(2)) + '\\n');
setInterval(() => {}, 1_000);
await new Promise(() => {});
`);
  await writeFile(join(root, 'tests', 'hang.test.ts'), '');
  return root;
}

const context = (root: string, calls: { path: string; body: any }[]) => ({
  args: ['1', '--head', head],
  api: async (path: string, body: unknown) => { calls.push({ path, body }); return { key: 'GY-1', submission: { epoch: 1, head } }; },
  print: () => undefined,
  repositoryRoot: () => root,
}) as unknown as CliContext;

test('unit:complete-rerun-faults-submit-with-note — a rerun whose runner exits non-zero with Could not find and names no case submits, the note carrying the reason and the run\'s lines', async () => {
  const root = await worktree();
  const calls: { path: string; body: any }[] = [];
  await completeCommand.run(context(root, calls), { id: 'id-1', key: 'GY-1', mergeLedger: refused('tests/gone.test.ts') } as never);
  assert.equal(calls.length, 1, 'the unjudged rerun refused the submission');
  assert.equal(calls[0]!.path, 'work/id-1/submit');
  assert.deepEqual(calls[0]!.body, {
    epoch: 1, head,
    rerunUnjudged: {
      note: 'pre-submit rerun could not judge: the rerun of tests/gone.test.ts failed without naming a failing case',
      output: "Could not find 'tests/gone.test.ts'.",
    },
  });
});

test('unit:complete-rerun-faults-submit-with-note — a rerun that exceeds its bound is killed at the bound and submits with the note naming it', async () => {
  const root = await hangingWorktree();
  const calls: { path: string; body: any }[] = [];
  const bound = rerunBound.ms;
  rerunBound.ms = 3_000;
  try {
    await completeCommand.run(context(root, calls), { id: 'id-1', key: 'GY-1', mergeLedger: refused('tests/hang.test.ts') } as never);
  } finally { rerunBound.ms = bound; }
  assert.equal(calls.length, 1, 'the unjudged rerun refused the submission');
  assert.equal(calls[0]!.path, 'work/id-1/submit');
  assert.equal(calls[0]!.body.rerunUnjudged.note, 'pre-submit rerun could not judge: the rerun of tests/hang.test.ts exceeded 3 s and was killed');
});

test('unit:complete-rerun-faults-submit-with-note — on the base commit both faults refuse', async () => {
  const base = await importAt(baseCommit, 'src/cli/complete.js');
  const baseComplete = (base.completeCommand as typeof completeCommand).run.bind(base.completeCommand);
  // The runner fault: the base found no parseable case in the Could not find output and refused.
  {
    const root = await worktree();
    const calls: { path: string; body: any }[] = [];
    await assert.rejects(baseComplete(context(root, calls), { id: 'id-1', key: 'GY-1', mergeLedger: refused('tests/gone.test.ts') } as never),
      (error: Error) => {
        assert.match(error.message, /complete refused: the merge trial's failing tests still fail on this head/);
        assert.match(error.message, /Could not find 'tests\/gone\.test\.ts'/);
        return true;
      });
    assert.deepEqual(calls, [], 'the refused base complete submitted anyway');
  }
  // The bound: the base threw the bound refusal, naming it, and submitted nothing.
  {
    const root = await hangingWorktree();
    const calls: { path: string; body: any }[] = [];
    const baseBound = base.rerunBound as typeof rerunBound, bound = baseBound.ms;
    baseBound.ms = 3_000;
    try {
      await assert.rejects(baseComplete(context(root, calls), { id: 'id-1', key: 'GY-1', mergeLedger: refused('tests/hang.test.ts') } as never),
        /complete refused: the rerun of tests\/hang\.test\.ts exceeded 3 s and was killed/);
    } finally { baseBound.ms = bound; }
    assert.deepEqual(calls, [], 'the refused base complete submitted anyway');
  }
});
