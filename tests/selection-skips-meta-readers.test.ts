import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { changedDeclarations, dependencyMap, listTestFiles, repositoryRoot, selectAffected } from '../scripts/ci-tests.mjs';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3541: a change adding one test file and one e2e case selected every test that lists tests/ or
// e2e/cases/ — about 57 meta tests — in each item's trial. A listing reads the directory, not each
// file in it: an item's trial (narrowed against its base) skips the tests whose only link to a changed
// file is listing its directory, and the batch gate (no base) still runs them.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
}

test('unit:selection-skips-meta-readers — a new test file, a new e2e case and a source edit select no test that only lists tests/ or e2e/cases/; the batch gate still runs them', async () => {
  const root = await temporaryDirectory('selection-meta');
  await write(root, {
    'package.json': '{}',
    'src/a.ts': 'export function a() { return 1; }\n',
    'e2e/cases/old.json': '{}\n',
    'tests/a.test.ts': "import { a } from '../src/a.js';\na();\n",
    'tests/test-list.test.ts': "import { readdirSync } from 'node:fs';\nreaddirSync('tests');\n",
    'tests/case-list.test.ts': "import { readdirSync } from 'node:fs';\nreaddirSync('e2e/cases');\n",
    'tests/case-reader.test.ts': "import { readFileSync, readdirSync } from 'node:fs';\nreaddirSync('e2e/cases');\nreadFileSync('e2e/cases/new.json');\n",
  });
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  await write(root, { 'src/a.ts': 'export function a() { return 2; }\n', 'tests/new.test.ts': "import { a } from '../src/a.js';\na();\n", 'e2e/cases/new.json': '{}\n' });
  git(root, 'add', '.');
  const tests = listTestFiles(root), map = dependencyMap(root, tests);
  const changed = ['src/a.ts', 'tests/new.test.ts', 'e2e/cases/new.json'];
  const gate = selectAffected(changed, map, tests).files, trial = selectAffected(changed, map, tests, changedDeclarations(changed, 'HEAD', root)).files;
  // Before: the listing tests ride along with every added file. After: only the trial's own tests and a test naming the new case.
  assert.deepEqual(gate, ['tests/a.test.ts', 'tests/case-list.test.ts', 'tests/case-reader.test.ts', 'tests/new.test.ts', 'tests/test-list.test.ts'], 'the batch gate runs the listing tests');
  assert.deepEqual(trial, ['tests/a.test.ts', 'tests/case-reader.test.ts', 'tests/new.test.ts'], 'an item\'s trial skips tests whose only link is a listing');
  // An edit to a listing test still selects it.
  await write(root, { 'tests/test-list.test.ts': "import { readdirSync } from 'node:fs';\nreaddirSync('tests').sort();\n" });
  assert.deepEqual(selectAffected(['tests/test-list.test.ts'], map, tests, changedDeclarations(['tests/test-list.test.ts'], 'HEAD', root)).files, ['tests/test-list.test.ts']);
});

test('selection-skips-meta-readers — on this repository, the trial selection for a new test file, a new e2e case and a source edit holds fewer than 60 test files', async () => {
  const root = await temporaryDirectory('selection-meta-repo');
  git(repositoryRoot, 'clone', '-q', '--shared', '--no-checkout', repositoryRoot, root);
  git(root, 'checkout', '-q', '--detach', git(repositoryRoot, 'rev-parse', 'HEAD').trim());
  await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'));
  const base = git(root, 'rev-parse', 'HEAD').trim(), source = 'src/model/timing-companion.ts';
  const text = await readFile(join(root, source), 'utf8');
  // The selector under test is this checkout's, committed or not.
  await write(root, {
    'scripts/ci-tests.mjs': await readFile(join(repositoryRoot, 'scripts/ci-tests.mjs'), 'utf8'),
    [source]: text.replace('testFile(path) && ', 'testFile(path) === true && '),
    'tests/gy-3541-probe.test.ts': "import { test } from 'node:test';\ntest('probe', () => {});\n",
    'e2e/cases/gy-3541-probe.json': '{ "id": "gy-3541-probe", "title": "probe", "steps": [] }\n',
  });
  git(root, 'add', '.'); git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'probe');
  const changed = [source, 'tests/gy-3541-probe.test.ts', 'e2e/cases/gy-3541-probe.json'];
  // The command the merge writer's trial runs, with the base tip it sets.
  const out = execFileSync(process.execPath, ['scripts/ci-tests.mjs', 'affected', ...changed], { cwd: root, encoding: 'utf8', env: { ...process.env, GRAPHYARD_SELECTION_BASE: base } });
  const files = out.split('\n').filter(line => /^tests\/.+\.test\.ts$/.test(line));
  assert.ok(out.startsWith('affected:'), out.split('\n')[0]);
  assert.ok(files.includes('tests/gy-3541-probe.test.ts'), 'the new test file runs');
  assert.ok(files.length < 60, `the trial runs ${files.length} test files: ${out.split('\n')[0]}`);
});
