import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { affectedTests, changedFiles } from '../scripts/test-affected.mjs';
import { guideText } from '../src/guide.js';
import { submissionPolicyRule } from '../src/master/harness.js';
import { masterInstructions } from '../src/master/instructions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3139: a worker's full `npm test` held a host verification slot for 20-50 minutes and produced no
// trusted evidence; the merge writer's trial runs the affected selection anyway. Workers now run
// `npm run test:affected -- <bound proof test files>`: the tests scripts/ci-tests.mjs selects for the
// files changed against the merge-base with origin/main, plus the named files.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
}

test('unit:worker-affected-tests — selects the tests reached by committed, uncommitted and untracked changes against the merge-base with origin/main, plus the named test files, and the full suite when the selection says so', async () => {
  const root = await temporaryDirectory('worker-affected');
  await write(root, {
    'package.json': '{}',
    'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n', 'src/c.ts': 'export const c = 1;\n',
    'tests/a.test.ts': "import { a } from '../src/a.js';\nvoid a;\n",
    'tests/b.test.ts': "import { b } from '../src/b.js';\nvoid b;\n",
    'tests/c.test.ts': "import { c } from '../src/c.js';\nvoid c;\n",
    'tests/proof.test.ts': 'export {};\n',
  });
  git(root, 'init', '-q', '-b', 'main');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.deepEqual(affectedTests(root), { mode: 'affected', reason: '0 changed file(s) are documentation only', files: [] }, 'an unchanged checkout runs nothing');

  // Committed: src/a.ts; uncommitted: src/b.ts; untracked: notes.md (documentation selects nothing).
  await write(root, { 'src/a.ts': 'export const a = 2;\n' });
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change a');
  await write(root, { 'src/b.ts': 'export const b = 2;\n', 'notes.md': '# notes\n' });
  assert.deepEqual(changedFiles(root), ['notes.md', 'src/a.ts', 'src/b.ts']);
  const selection = affectedTests(root, ['tests/proof.test.ts']);
  assert.equal(selection.mode, 'affected');
  assert.deepEqual(selection.files, ['tests/a.test.ts', 'tests/b.test.ts', 'tests/proof.test.ts'], 'exactly the affected tests plus the named proof file');

  // An untracked file outside the dependency map runs the whole suite, as the trial's selection does.
  await write(root, { 'src/new.ts': 'export const n = 1;\n' });
  const full = affectedTests(root, ['tests/proof.test.ts']);
  assert.equal(full.mode, 'full');
  assert.deepEqual(full.files, ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/proof.test.ts']);
});

test('unit:worker-affected-tests — the npm script, AGENTS.md, the guide and the worker and master instructions point workers at test:affected with their bound proof test files', async () => {
  const root = join(import.meta.dirname, '..');
  const scripts = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:affected'], 'node scripts/test-affected.mjs');
  assert.equal(scripts.test, 'node --import tsx tests/helpers/run-tests.ts', 'npm test stays the whole suite');
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /`npm run test:affected -- <your bound proof test files>` for domain\/API changes/);
  assert.match(guideText('proof'), /npm run test:affected -- with the bound proof test files/);
  assert.match(submissionPolicyRule, /run the build and npm run test:affected -- BOUND_PROOF_TEST_FILES, not npm test\./);
  assert.match(masterInstructions.replace(/\s+/g, ' '), /Workers check their change with `npm run test:affected` and their bound proof test files, not npm test/);
});
