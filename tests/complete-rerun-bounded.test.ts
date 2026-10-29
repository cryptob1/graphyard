import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { completeCommand, rerunBound } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';

// GY-2974: on 2026-10-29 complete on the Open City install hung over 24 minutes, past its 20-minute
// rerun bound: the rerun was `npm test -- FILES`, and a test script that already globs every test
// file ran the whole suite beside the named one. The rerun now runs exactly the trial's failing
// files, in its own process group, killed whole at the bound with a refusal naming it.

const head = 'a'.repeat(40);
const refused = (files: string) => ({ state: 'refused', head: 'b'.repeat(40), refusal: { kind: 'merge', reason: `trial failed: tests ${files}` } });
const context = (root: string, calls: unknown[]) => ({
  args: ['1', '--head', head],
  api: async (path: string, body: unknown) => { calls.push({ path, body }); return { key: 'GY-1' }; },
  print: () => undefined,
  repositoryRoot: () => root,
}) as unknown as CliContext;

/** A repository whose `npm test` runs every test file, holding the given test files. */
async function repository(files: Record<string, string>) {
  const root = await temporaryDirectory('complete-rerun-bounded');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts: { test: 'node --test tests/' } }));
  await mkdir(join(root, 'tests'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, 'tests', name), body);
  return root;
}
const marker = (name: string) => `import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('${name}', () => { writeFileSync('${name}.ran', ''); });\n`;

test('unit:complete-rerun-runs-only-failing-files — the rerun runs just the trial\'s failing file, never the suite the test script globs, within the bound', async () => {
  const root = await repository({ 'failed.test.mjs': marker('failed'), 'other.test.mjs': marker('other'), 'third.test.mjs': marker('third') });
  const calls: unknown[] = [], started = Date.now();
  await completeCommand.run(context(root, calls), { id: 'id-1', key: 'GY-1', mergeLedger: refused('tests/failed.test.mjs') } as never);
  assert.ok(Date.now() - started < rerunBound.ms, 'the rerun ran past its bound');
  assert.equal(existsSync(join(root, 'failed.ran')), true, 'the failing file did not run');
  assert.equal(existsSync(join(root, 'other.ran')), false, 'the rerun ran a file the trial did not fail');
  assert.equal(existsSync(join(root, 'third.ran')), false, 'the rerun ran a file the trial did not fail');
  assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, head } }]);
});

test('unit:complete-rerun-killed-at-bound — a rerun that never exits is killed with its process group at the bound and refused, naming the bound, with nothing submitted', async () => {
  const root = await repository({
    'hang.test.mjs': `import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
test('hangs', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  writeFileSync('grandchild.pid', String(child.pid));
  await new Promise(() => {});
});
`,
  });
  const calls: unknown[] = [], bound = rerunBound.ms;
  rerunBound.ms = 3_000;
  try {
    const started = Date.now();
    await assert.rejects(completeCommand.run(context(root, calls), { id: 'id-1', key: 'GY-1', mergeLedger: refused('tests/hang.test.mjs') } as never),
      /complete refused: the rerun of tests\/hang\.test\.mjs exceeded 3 s and was killed/);
    assert.ok(Date.now() - started < 3_000 + 6_000, 'complete waited well past the bound');
  } finally { rerunBound.ms = bound; }
  assert.deepEqual(calls, [], 'a rerun past its bound was submitted');
  const pid = Number(await readFile(join(root, 'grandchild.pid'), 'utf8'));
  let alive = true;
  for (let tries = 0; alive && tries < 40; tries++) { try { process.kill(pid, 0); await delay(50); } catch { alive = false; } }
  assert.equal(alive, false, 'the rerun\'s grandchild outlived the kill at the bound');
});
