import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1887: the per-file durations record said passed:true for a file whose own test failed, so a
// timing artifact contradicted the test log (run 39014555162 recorded tests/reconcile-tick-cause.test.ts
// as passing in durations-4.jsonl beside test-4.log's failing unit:slow-tick-names-cause). The
// reporter took the status from the file-level test:complete alone; a file whose tests failed can
// complete without details.passed false. The status now comes from every test:fail event in the file.
//
// Each case runs the real reporter over a real node:test event stream, wired exactly as the runner
// wires it: `node --test --test-reporter=tests/helpers/file-durations.mjs --test-reporter-destination=FILE`
// (the arguments tests/helpers/run-tests.ts builds; tests/helpers/ordered-tests.mjs composes the same
// reporter over the same events for a shard).

/** The reporter's record for one file, as one JSON line of a `--durations` output. */
interface Record { file: string; durationMs: number; passed: boolean }

const reporter = fileURLToPath(new URL('./helpers/file-durations.mjs', import.meta.url));

/** Runs `node --test` over the fixture files with the reporter module writing to `destination`; resolves with the run's stderr. */
function runWithReporter(root: string, fixtures: readonly string[], reporterModule: string, destination: string, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    // A fixture whose test fails, or that fails to load, makes the run exit 1: expected here, the record is what is judged.
    // A run started inside a test file carries its parent's NODE_TEST_CONTEXT, which makes `node --test` skip every file.
    const { NODE_TEST_CONTEXT: _outer, ...inherited } = environment;
    const child = spawn(process.execPath, ['--test', `--test-reporter=${reporterModule}`, `--test-reporter-destination=${destination}`, ...fixtures.map(file => join(root, file))], { cwd: root, env: inherited, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(stderr));
  });
}

/** Runs the reporter over the fixtures and parses its output; a run that wrote no output fails with the run's stderr. */
async function recorded(root: string, fixtures: readonly string[], reporterModule: string, destination: string, environment?: NodeJS.ProcessEnv): Promise<Map<string, Record>> {
  const stderr = await runWithReporter(root, fixtures, reporterModule, destination, environment);
  let text: string;
  try { text = await readFile(destination, 'utf8'); } catch { throw new Error(`the run wrote no durations record: ${stderr}`); }
  return new Map(text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record).map(record => [record.file, record]));
}

/** The fixtures: a file where a nested test fails among passing ones, one where all pass, one that fails to load. */
async function writeFixtures(root: string): Promise<void> {
  await writeFile(join(root, 'mixed.test.mjs'), `import { test } from 'node:test';\ntest('passes', () => {});\ntest('fails', () => { throw new Error('intended failure'); });\ntest('passes too', () => {});\n`);
  await writeFile(join(root, 'allpass.test.mjs'), `import { test } from 'node:test';\ntest('passes', () => {});\ntest('also passes', async () => {});\n`);
  // A syntax error: the file never loads, and no test inside it runs.
  await writeFile(join(root, 'broken.test.mjs'), `import { test } from 'node:test';\ntest('never runs', () => {});\nconst = ;\n`);
}

test('unit:file-durations-passed-false-on-any-failed-test — the durations record marks a file failed when any test inside it fails, and passing only when every test passes', async () => {
  const root = await temporaryDirectory('file-durations-status');
  await writeFixtures(root);
  const destination = join(root, 'durations.jsonl');

  // The statuses as the stream reports them: a nested failure, an all-passing file, a load failure.
  const records = await recorded(root, ['mixed.test.mjs', 'allpass.test.mjs', 'broken.test.mjs'], reporter, destination);
  assert.deepEqual([...records.keys()].sort(), ['allpass.test.mjs', 'broken.test.mjs', 'mixed.test.mjs'], 'every file that ran is recorded once');
  assert.equal(records.get('mixed.test.mjs')!.passed, false, 'a file with one failing test among passing ones is recorded passed:false');
  assert.equal(records.get('allpass.test.mjs')!.passed, true, 'a file whose tests all pass is recorded passed:true');
  assert.equal(records.get('broken.test.mjs')!.passed, false, 'a file that fails to load is recorded passed:false');
  for (const record of records.values()) assert.ok(Number.isInteger(record.durationMs) && record.durationMs >= 0, `${record.file} records a whole duration: ${JSON.stringify(record)}`);

  // The recorded bug's shape: a file-level completion that says passed although a test inside the
  // file failed. The flip reporter replays the real stream with the file-level completion forced
  // to details.passed true, what the run 39014555162 runner reported; the status must still come
  // from the file's test:fail events. The flip log proves the input really carried the lie. (A load
  // failure's fail event is its own file-level test, delivered after its completion, whose passed
  // false the completion itself already records — the flip covers the nested failure the record missed.)
  const flipped = join(root, 'flip-file-level-completion.mjs'), flipLog = join(root, 'flip-log.jsonl');
  await writeFile(flipped, `import { appendFile } from 'node:fs/promises';
import inner from ${JSON.stringify(reporter)};
export default async function* flipFileLevelCompletion(source) {
  const events = [];
  for await (const event of source) events.push(event);
  for (const event of events) if (event.type === 'test:complete' && event.data.nesting === 0 && event.data.name === event.data.file) {
    event.data.details.passed = true;
    await appendFile(process.env.FLIP_LOG, \`\${JSON.stringify({ file: event.data.file })}\\n\`);
  }
  yield* inner(events);
}
`);
  const flippedDestination = join(root, 'flipped.jsonl');
  const flippedRecords = await recorded(root, ['mixed.test.mjs'], flipped, flippedDestination, { ...process.env, FLIP_LOG: flipLog });
  const flippedFiles = (await readFile(flipLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).file.split(/[\\/]/).pop()).sort();
  const flippedMixed = flippedRecords.get('mixed.test.mjs');
  assert.deepEqual(flippedFiles, ['mixed.test.mjs'], 'the flip reporter really rewrote the completion');
  assert.ok(flippedMixed, 'the flipped run recorded the mixed fixture');
  assert.equal(flippedMixed!.passed, false, 'a file whose nested test failed is recorded passed:false even when its completion event claims passed:true');
});
