import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2974: on 2026-10-29 complete on the Open City install hung over 24 minutes, past its 20-minute
// rerun bound: the rerun was `npm test -- FILES`, and a test script that already globs every test
// file ran the whole suite beside the named one. The rerun now runs exactly the trial's failing
// files, in its own process group, killed whole at the bound with a refusal naming it.

// GY-3577: the trial server that judges this change still reads proof counts only from shards on its
// own machine, so this file keeps to them (its text names the server); the file also passes on a
// compute host (integration:rerun-bounded-on-remote-shard).

// Imported per case, so a tree without the bound fails these cases rather than the file.
const complete = () => import('../src/cli/complete.js');
const refused = (files: string) => ({ state: 'refused', head: 'b'.repeat(40), refusal: { kind: 'merge', reason: `trial failed: tests ${files}` } });

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
  const { completionRerun, rerunBound } = await complete();
  const root = await repository({ 'failed.test.mjs': marker('failed'), 'other.test.mjs': marker('other'), 'third.test.mjs': marker('third') });
  const started = Date.now();
  const result = await completionRerun(root, { id: 'id-1', key: 'GY-1', mergeLedger: refused('tests/failed.test.mjs') } as never);
  assert.ok(Date.now() - started < rerunBound.ms, 'the rerun ran past its bound');
  assert.equal(existsSync(join(root, 'failed.ran')), true, 'the failing file did not run');
  assert.equal(existsSync(join(root, 'other.ran')), false, 'the rerun ran a file the trial did not fail');
  assert.equal(existsSync(join(root, 'third.ran')), false, 'the rerun ran a file the trial did not fail');
  assert.deepEqual(result, { flaked: [], baseFailures: [] });

  // GY-3551: the bound covers the whole rerun — its retry and base run included — never each run
  // afresh, so a slow failing file cannot stretch complete to three bounds.
  const slow = await repository({ 'slow.test.mjs': `import { test } from 'node:test';\ntest('slow', async () => { await new Promise(done => setTimeout(done, 2_500)); throw new Error('fails'); });\n` });
  const bound = rerunBound.ms;
  rerunBound.ms = 4_000;
  try {
    const begun = Date.now();
    const slowResult = await completionRerun(slow, { id: 'id-1', key: 'GY-1', mergeLedger: refused('tests/slow.test.mjs') } as never);
    assert.ok(Date.now() - begun < 4_000 + 1_500, `the rerun and its retry took ${Date.now() - begun}ms, past the 4 s bound`);
    assert.match(slowResult.note?.note ?? '', /exceeded 4 s and was killed/);
  } finally { rerunBound.ms = bound; }
});

test('unit:complete-rerun-killed-at-bound — a rerun that never exits is killed with its process group at the bound and submits with the note naming the bound (GY-2980)', async () => {
  const { completionRerun, rerunBound } = await complete();
  const root = await repository({
    'hang.test.mjs': `import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
test('hangs', async () => {
  // The first run fails slowly, so the rerun retries the file; the retry never exits (GY-3551).
  if (!existsSync('first.ran')) { writeFileSync('first.ran', ''); await new Promise(done => setTimeout(done, 2_500)); throw new Error('fails'); }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  writeFileSync('grandchild.pid', String(child.pid));
  await new Promise(() => {});
});
`,
  });
  const bound = rerunBound.ms;
  let result: Awaited<ReturnType<typeof completionRerun>>;
  rerunBound.ms = 4_000;
  try {
    const started = Date.now();
    result = await completionRerun(root, { id: 'id-1', key: 'GY-1', mergeLedger: refused('tests/hang.test.mjs') } as never);
    // GY-3551: the bound is one deadline for the whole rerun, so the retry ends where it does.
    assert.ok(Date.now() - started < 4_000 + 1_500, `complete took ${Date.now() - started}ms, past the 4 s bound`);
  } finally { rerunBound.ms = bound; }
  // GY-2980: the bound is a fault of the rerun, so it judges nothing — the submission carries the
  // note naming the bound and the merge trial judges the head.
  assert.equal(result!.note?.note, 'pre-submit rerun could not judge: the retry of tests/hang.test.mjs exceeded 4 s and was killed');
  const pid = Number(await readFile(join(root, 'grandchild.pid'), 'utf8'));
  let alive = true;
  for (let tries = 0; alive && tries < 40; tries++) { try { process.kill(pid, 0); await delay(50); } catch { alive = false; } }
  assert.equal(alive, false, 'the rerun\'s grandchild outlived the kill at the bound');
});

test('unit:complete-rerun-names-why-the-child-did-not-start — a rerun whose child command is missing submits with a note carrying the spawn error (GY-3577)', async () => {
  const { completionRerun } = await complete();
  const root = await repository({ 'failed.test.mjs': marker('failed') });
  const node = process.execPath;
  let result: Awaited<ReturnType<typeof completionRerun>>;
  process.execPath = join(root, 'no-such-node');
  try { result = await completionRerun(root, { id: 'id-1', key: 'GY-1', mergeLedger: refused('tests/failed.test.mjs') } as never); }
  finally { process.execPath = node; }
  assert.match(result!.note?.note ?? '', /^pre-submit rerun could not judge: the rerun of tests\/failed\.test\.mjs failed without naming a failing case: .*spawn .*no-such-node ENOENT/);
});
