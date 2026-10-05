import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { selfVerification, verifyWorkingTree } from '../src/cli/verify.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1174: three nonexercising-proof faults in 24 hours (GY-1132, GY-1131, GY-1142) shared one
// cause — a proof bound to a criterion it cannot exercise was found only when the producer's
// stripped run survived, after a full validation cycle. Each instance is rebuilt here in a
// throwaway repository: its proof passes on the head, as the base's `graphyard verify` reported,
// and the candidate's verify now runs it against the base's sources with the change's tests and
// reports it unexercised before submission. A proof that does exercise the change still passes.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
}
/** A repository whose origin/main holds `base`, with `change` committed on a work branch on top. */
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

test('manual:fault-class-proof GY-1132 — a proof of behaviour that predates the change is reported unexercised before submission; one of the change itself passes', async () => {
  const root = await repository('gy1132', {
    // The base already backs off a failing row with retryAt.
    'src/actions.mjs': `export const claimable = (rows, now) => rows.filter(row => !row.retryAt || row.retryAt <= now);\n`,
  }, {
    // The change adds yielding: a failing row is ordered behind the others.
    'src/actions.mjs': `export const claimable = (rows, now) => rows.filter(row => !row.retryAt || row.retryAt <= now).sort((a, b) => (a.failures ?? 0) - (b.failures ?? 0));\n`,
    'tests/actions.test.mjs': caseFile(`import { claimable } from '../src/actions.mjs';`, 'unit:failing-dispatch-row-yields-to-others backs off a failing row',
      `  assert.deepEqual(claimable([{ id: 'a', retryAt: 5 }, { id: 'b' }], 1).map(row => row.id), ['b']);`)
      + `test('unit:dispatch-row-order puts the failing row last', () => {\n  assert.deepEqual(claimable([{ id: 'a', failures: 2 }, { id: 'b' }], 1).map(row => row.id), ['b', 'a']);\n});\n`,
  });
  const record = await verifyWorkingTree({ key: 'GY-1', criteria: [{ id: 'AC-2', proofs: ['unit:failing-dispatch-row-yields-to-others', 'unit:dispatch-row-order'] }] }, root);
  const [instance, control] = record.ran;
  assert.equal(instance.result, 'pass', 'the instance: its cases pass on the head, which is all the base verify checked');
  assert.equal(instance.exercise?.result, 'pass');
  assert.deepEqual(instance.exercise?.reverted, ['src/actions.mjs']);
  assert.match(instance.unexercised ?? '', /unit:failing-dispatch-row-yields-to-others does not exercise AC-2: it also passed against the base/);
  assert.equal(control.result, 'pass'); assert.equal(control.exercise?.result, 'fail'); assert.equal(control.unexercised, undefined);
  const verification = await selfVerification(root, 'GY-1');
  assert.equal(verification.state, 'failing');
  assert.match(verification.reason, /unit:failing-dispatch-row-yields-to-others passed on HEAD and against the base without the change/);
});

test('manual:fault-class-proof GY-1131 — a proof that feeds hand-built records to an unchanged function is reported unexercised', async () => {
  const root = await repository('gy1131', {
    'src/faults.mjs': `export const cycleFaults = records => records.filter(record => record.conflict).length;\n`,
    'src/refresh.mjs': `export const refresh = entry => ({ ...entry });\n`,
  }, {
    // The change is in the refresh path; the proof never calls it.
    'src/refresh.mjs': `export const refresh = entry => ({ ...entry, conflict: false });\n`,
    'tests/faults.test.mjs': caseFile(`import { cycleFaults } from '../src/faults.mjs';`, 'unit:base-conflict-class-quiet-after-refresh counts no conflict',
      `  assert.equal(cycleFaults([{ conflict: false }, { conflict: false }]), 0);`),
  });
  const record = await verifyWorkingTree({ key: 'GY-1', criteria: [{ id: 'AC-4', proofs: ['unit:base-conflict-class-quiet-after-refresh'] }] }, root);
  assert.equal(record.ran[0].result, 'pass');
  assert.deepEqual(record.ran[0].exercise?.reverted, ['src/refresh.mjs']);
  assert.match(record.ran[0].unexercised ?? '', /does not exercise AC-4/);
  assert.equal((await selfVerification(root, 'GY-1')).state, 'failing');
});

test('manual:fault-class-proof GY-1142 — an aggregate docs metric that one paragraph cannot move is reported unexercised; a test-only change is not judged', async () => {
  const root = await repository('gy1142', {
    'docs/reference.md': `# Reference\n\nSome words.\n`,
    'tests/docs.test.mjs': caseFile(`import { readFileSync } from 'node:fs';`, 'unit:docs-word-budget stays within budget',
      `  assert.ok(readFileSync('docs/reference.md', 'utf8').split(/\\s+/).length < 1000);`),
  }, {
    'docs/reference.md': `# Reference\n\nSome words.\n\n## Pipeline speed\n\nThe decisions step is bounded at 10 s.\n`,
  });
  const record = await verifyWorkingTree({ key: 'GY-1', criteria: [{ id: 'AC-2', proofs: ['unit:docs-word-budget'] }] }, root);
  assert.equal(record.ran[0].result, 'pass');
  assert.deepEqual(record.ran[0].exercise?.reverted, ['docs/reference.md']);
  assert.match(record.ran[0].unexercised ?? '', /unit:docs-word-budget does not exercise AC-2/);

  // A change of tests alone reverts nothing, so verify makes no exercise claim about it.
  const testsOnly = await repository('gy1142-tests', { 'README.md': '# R\n' }, {
    'tests/only.test.mjs': caseFile('', 'unit:tests-only passes', '  assert.ok(true);'),
  });
  const plain = await verifyWorkingTree({ key: 'GY-1', criteria: [{ id: 'AC-1', proofs: ['unit:tests-only'] }] }, testsOnly);
  assert.equal(plain.ran[0].result, 'pass'); assert.equal(plain.ran[0].exercise, undefined); assert.equal(plain.ran[0].unexercised, undefined);
  assert.equal((await selfVerification(testsOnly, 'GY-1')).state, 'passing');
});
