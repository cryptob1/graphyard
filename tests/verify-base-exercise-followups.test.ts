import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { baseTree, selfVerification, testSide, verifyWorkingTree } from '../src/cli/verify.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1240: the follow-ups from GY-1174's review. The base exercise of `graphyard verify` keeps its
// scratch tree inside the worktree, records every base run it does not make as indeterminate with
// its reason, records an abnormal base run as such, spends no base runs once a proof failed on
// HEAD, treats nested tests and fixtures as test-side, and lets a worker declare a proof that
// guards preserved behaviour, which the producer's exercise rule (GY-135) accepts.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
}
async function repository(label: string, base: Record<string, string>, change: Record<string, string>) {
  const root = join(await temporaryDirectory(label), 'work');
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@test'); git(root, 'config', 'user.name', 'T');
  await write(root, base);
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'graphyard/gy-1-1');
  await write(root, change);
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'change');
  return root;
}
const caseFile = (imports: string, title: string, body: string) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${imports}\ntest('${title}', () => {\n${body}\n});\n`;
const guard = () => repository('gy1240-guard', { 'src/sum.mjs': `export const sum = (a, b) => a + b;\n` }, {
  'src/sum.mjs': `export const sum = (a, b) => a + b;\nexport const twice = a => sum(a, a);\n`,
  'tests/sum.test.mjs': caseFile(`import { sum } from '../src/sum.mjs';`, 'unit:sum-preserved still adds', '  assert.equal(sum(1, 2), 3);'),
});

test('unit:verify-base-exercise-followups — the base tree lives in the worktree and a base run not made is recorded as indeterminate with its reason', async () => {
  const root = await guard();
  const record = await verifyWorkingTree({ key: 'GY-1', criteria: [{ id: 'AC-1', proofs: ['unit:sum-preserved'] }] }, root);
  assert.equal(record.ran[0].exercise?.result, 'pass', 'the base run was made');
  // The scratch tree was under .graphyard/verify and is gone; only the record remains.
  assert.deepEqual(readdirSync(join(root, '.graphyard', 'verify')), ['GY-1.json']);

  // No base to measure from: recorded, not dropped.
  const unresolved = await verifyWorkingTree({ key: 'GY-1', criteria: [{ id: 'AC-1', proofs: ['unit:sum-preserved'] }] }, root, undefined, { baseBranch: 'absent' });
  assert.equal(unresolved.ran[0].exercise?.result, 'indeterminate');
  assert.match(unresolved.ran[0].exercise?.reason ?? '', /origin\/absent could not be resolved/);
  const verification = await selfVerification(root, 'GY-1');
  assert.equal(verification.state, 'passing');
  assert.match(verification.reason, /unjudged for exercise: unit:sum-preserved/);

  // A base tree with nowhere to go yields its reason, not null.
  const blocked = await guard();
  const base = git(blocked, 'rev-parse', 'refs/remotes/origin/main');
  await writeFile(join(blocked, '.graphyard'), 'not a directory');
  const broken = await baseTree(blocked, base);
  assert.equal(broken?.tree, null);
  assert.match(broken?.reason ?? '', /no scratch directory for the base tree/);
});

test('unit:verify-base-exercise-followups — a proof declared with preserves is not reported unexercised; an undeclared one still is', async () => {
  const root = await guard();
  const criteria = [{ id: 'AC-1', proofs: ['unit:sum-preserved'] }];
  const undeclared = await verifyWorkingTree({ key: 'GY-1', criteria }, root);
  assert.match(undeclared.ran[0].unexercised ?? '', /--preserves unit:sum-preserved/);
  const declared = await verifyWorkingTree({ key: 'GY-1', criteria }, root, undefined, { preserves: ['unit:sum-preserved'] });
  assert.equal(declared.ran[0].unexercised, undefined);
  assert.equal(declared.ran[0].exercise, undefined, 'a declared guard is not run against the base');
  assert.match(declared.ran[0].preserved ?? '', /predates the change/);
  assert.deepEqual(declared.preserves, ['unit:sum-preserved']);
  assert.equal((await selfVerification(root, 'GY-1')).state, 'passing');
  await assert.rejects(verifyWorkingTree({ key: 'GY-1', criteria }, root, undefined, { preserves: ['unit:other'] }), /--preserves names unit:other/);
});

test('unit:verify-base-exercise-followups — an abnormal base run is recorded as such, and no base run is made once a proof failed on HEAD', async () => {
  const root = await repository('gy1240-abnormal', { 'README.md': '# R\n' }, {
    'src/added.mjs': `export const added = () => 1;\n`,
    'tests/added.test.mjs': caseFile(`import { added } from '../src/added.mjs';`, 'unit:added-module works', '  assert.equal(added(), 1);')
      + `test('unit:always-fails fails', () => { assert.fail('no'); });\n`,
  });
  const record = await verifyWorkingTree({ key: 'GY-1', criteria: [{ id: 'AC-1', proofs: ['unit:added-module'] }] }, root);
  assert.equal(record.ran[0].exercise?.result, 'fail');
  assert.ok(record.ran[0].exercise?.abnormal, 'the base run could not load the module the change adds');
  assert.equal(record.ran[0].unexercised, undefined);

  const failing = await verifyWorkingTree({ key: 'GY-1', criteria: [{ id: 'AC-1', proofs: ['unit:added-module', 'unit:always-fails'] }] }, root);
  assert.equal(failing.ran[1].result, 'fail');
  assert.equal(failing.ran[0].exercise?.result, 'indeterminate');
  assert.match(failing.ran[0].exercise?.reason ?? '', /unit:always-fails failed on HEAD/);
  assert.ok(!existsSync(join(root, '.graphyard', 'verify', 'tree')));
});

test('unit:verify-base-exercise-followups — nested tests and fixtures are test-side, sources are not', () => {
  for (const path of ['tests/a.ts', 'packages/x/tests/a.ts', 'src/fixtures/a.json', 'packages/x/test/a.ts', 'src/__tests__/a.ts', 'src/a.test.ts']) assert.ok(testSide(path), path);
  for (const path of ['src/a.ts', 'src/cli/test-isolation.ts', 'src/testing.ts', 'docs/tests.md']) assert.ok(!testSide(path), path);
});
