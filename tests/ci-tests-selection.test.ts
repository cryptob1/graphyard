import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { changedDeclarations, dependencyMap, listTestFiles, selectAffected } from '../scripts/ci-tests.mjs';
import { replay } from '../scripts/selection-replay.mjs';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3192: the trial's selection picked a median 91% of the test files for a small change, and 35% of
// merges ran everything: any path a test or helper named in text was followed transitively, and a
// file outside the map ran the whole suite. A test now depends on what it imports — through each
// module only the declarations the names it takes reach — and on the paths a test reads as data; a
// file outside the map selects the tests importing or naming it; with a base, a change selects the
// tests needing the declarations it touches.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
}
const project = {
  'package.json': '{}',
  'src/a.ts': "import { helper } from './helper.js';\nexport function a() { return helper(); }\nexport function unrelated() { return 2; }\n",
  'src/helper.ts': 'export const helper = () => 1;\n',
  'src/hub.ts': "export * from './a.js';\nexport { lazy as later } from './lazy.js';\n",
  'src/lazy.ts': "export const lazy = 1;\nexport const idle = 2;\n",
  'src/k.ts': 'export class K {\n  used() { return 1; }\n  other() { return 2; }\n}\n',
  'src/orphan.ts': 'export const orphan = 1;\n',
  'scripts/tool.mjs': "import { orphan } from '../src/orphan.ts';\nconsole.log(orphan);\n",
  'fixtures/case.json': '{}\n',
  'tests/static.test.ts': "import { a } from '../src/hub.js';\na();\n",
  'tests/dynamic.test.ts': "const { lazy } = await import('../src/lazy.js');\nvoid lazy;\n",
  'tests/data.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync(new URL('../fixtures/case.json', import.meta.url));\n",
  'tests/names.test.ts': "import { join } from 'node:path';\nexport const tool = join('scripts', 'tool.mjs');\n",
  'tests/method.test.ts': "import { K } from '../src/k.js';\nnew K().used();\n",
};

test('unit:ci-tests-selection — a static import, a literal dynamic import, a path read as data, a file outside the map and package.json select exactly their tests', async () => {
  const root = await temporaryDirectory('selection');
  try {
    await write(root, project);
    const tests = listTestFiles(root), map = dependencyMap(root, tests), pick = (...changed: string[]) => selectAffected(changed, map, tests).files;
    // A static import, through a re-exporting hub to the module defining the name, and what that module imports.
    assert.deepEqual(pick('src/a.ts'), ['tests/static.test.ts']);
    assert.deepEqual(pick('src/helper.ts'), ['tests/static.test.ts']);
    // A literal dynamic import.
    assert.deepEqual(pick('src/lazy.ts'), ['tests/dynamic.test.ts']);
    // A path a test reads as data.
    assert.deepEqual(pick('fixtures/case.json'), ['tests/data.test.ts']);
    // A file no test reaches: the tests naming it or a file importing it; nothing names src/k-less files.
    assert.deepEqual(pick('scripts/tool.mjs'), ['tests/names.test.ts']);
    assert.deepEqual(pick('src/orphan.ts'), ['tests/names.test.ts'], 'imported by scripts/tool.mjs, which a test names');
    // The install runs everything.
    assert.deepEqual(selectAffected(['package.json'], map, tests), { mode: 'full', reason: 'package.json changes the install, the test runner or configuration', files: tests });
    assert.deepEqual(pick('README.md'), [], 'documentation selects nothing');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:ci-tests-selection — against a base, a change selects only the tests needing the declarations it touches', async () => {
  const root = await temporaryDirectory('selection-base');
  try {
    await write(root, project);
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
    const tests = listTestFiles(root), map = dependencyMap(root, tests);
    const pick = async (files: Record<string, string>) => {
      await write(root, files);
      const changed = Object.keys(files), picked = selectAffected(changed, map, tests, changedDeclarations(changed, 'HEAD', root)).files;
      git(root, 'checkout', '-q', '--', '.');
      return picked;
    };
    assert.deepEqual(await pick({ 'src/a.ts': project['src/a.ts'].replace('return 2', 'return 3') }), [], 'unrelated() is needed by no test');
    assert.deepEqual(await pick({ 'src/a.ts': project['src/a.ts'].replace('return helper()', 'return helper() + 1') }), ['tests/static.test.ts']);
    assert.deepEqual(await pick({ 'src/lazy.ts': project['src/lazy.ts'].replace('idle = 2', 'idle = 3') }), [], 'the dynamic import takes lazy only');
    assert.deepEqual(await pick({ 'src/k.ts': project['src/k.ts'].replace('return 2', 'return 3') }), [], 'no reached code reads K#other');
    assert.deepEqual(await pick({ 'src/k.ts': project['src/k.ts'].replace('return 1', 'return 0') }), ['tests/method.test.ts']);
    assert.deepEqual(await pick({ 'src/a.ts': `import { lazy } from './lazy.js';\n${project['src/a.ts'].replace('return 2', 'return lazy')}` }), [], 'an import touches the declarations using it');
    assert.deepEqual(await pick({ 'src/a.ts': `${project['src/a.ts']}console.log('loaded');\n` }), ['tests/static.test.ts'], 'a statement run on load touches every test loading the module');
    // A base git cannot answer narrows nothing.
    assert.deepEqual(selectAffected(['src/a.ts'], map, tests, changedDeclarations(['src/a.ts'], 'no-such-revision', root)).files, ['tests/static.test.ts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:ci-tests-selection — the replay reports files and test minutes for both selectors, how many ran everything, and every culprit merge whose main failure the new selector skips', async () => {
  const root = await temporaryDirectory('selection-replay');
  try {
    // The old selector: every change runs every test.
    await write(root, { ...project, 'scripts/ci-tests.mjs': "export const dependencyMap = () => new Map();\nexport const selectAffected = (changed, map, tests) => ({ mode: 'full', reason: 'old', files: tests });\n",
      'tests/helpers/timing-baseline.json': JSON.stringify({ files: { 'tests/static.test.ts': 60_000, 'tests/dynamic.test.ts': 120_000, 'tests/data.test.ts': 60_000, 'tests/names.test.ts': 60_000, 'tests/method.test.ts': 60_000 } }) });
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
    const old = git(root, 'rev-parse', 'HEAD').trim();
    git(root, 'rm', '-q', 'tests/helpers/timing-baseline.json'); git(root, 'commit', '-qm', 'drop the baseline');
    const merge = async (key: string, files: Record<string, string>) => {
      git(root, 'checkout', '-q', '-b', key.toLowerCase());
      await write(root, files); git(root, 'commit', '-qam', key);
      git(root, 'checkout', '-q', 'main'); git(root, 'merge', '-q', '--no-ff', '-m', `Merge ${key}: change`, key.toLowerCase());
    };
    await merge('GY-1', { 'src/lazy.ts': project['src/lazy.ts'].replace('lazy = 1', 'lazy = 2') });
    await merge('GY-2', { 'package.json': '{ "private": true }' });
    const result = await replay({ root, merges: 10, old, failures: [{ file: 'tests/dynamic.test.ts', item: 'GY-9', culprit: 'GY-1' }, { file: 'tests/static.test.ts', item: 'GY-8', culprit: 'GY-1' }] });
    assert.equal(result.tests, 5);
    assert.deepEqual(result.rows.map(row => [row.key, row.now.files.length, row.minutes]), [['GY-2', 5, 6], ['GY-1', 1, 2]]);
    assert.deepEqual([result.new, result.old], [{ files: 1, minutes: 2, everything: 1 }, { files: 5, minutes: 6, everything: 2 }]);
    assert.deepEqual(result.checks.map(check => [check.item, check.kept]), [['GY-9', true], ['GY-8', false]]);
    assert.deepEqual(result.lost.map(check => check.file), ['tests/static.test.ts'], 'GY-1 never reached static.test.ts, so a failure there is no dependency the new selector lost');
  } finally { await rm(root, { recursive: true, force: true }); }
});
