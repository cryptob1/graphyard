import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { remoteableTestFile, type HostReading } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { shardHosts, shardRepository } from './helpers/shard-hosts.js';

// GY-3536: a compute host's shard has no sandbox permission, so tests that import the trial runner
// or the sandboxed benchmarks fail there. They stay on this machine.

const proof = 'unit:trial-sandbox-tests-stay-local';
const repo = new URL('..', import.meta.url).pathname;
const sandboxed = ['tests/trial-runtime.test.ts', 'tests/hard-math-negative.test.ts'];
const reading = (name: string, cores: number): HostReading => ({ name, cores, busy: 0, steal: 0, celsius: 60, limit: 92, away: false });

test(`${proof} — tests that import the trial runner or the benchmarks are local-only; other files are placed as before`, async () => {
  for (const file of sandboxed) assert.equal(remoteableTestFile(await readFile(join(repo, file), 'utf8')), false, `${file} stays local`);
  assert.equal(remoteableTestFile("import { mergeQueue } from '../src/merge-writer/queue.js';\n"), false);
  assert.equal(remoteableTestFile("import { pinnedPython } from '../benchmarks/hard-math/python.js';\n"), false);
  assert.equal(remoteableTestFile('test("adds numbers", () => equal(1 + 1, 2))\n'), true);
  assert.equal(remoteableTestFile('import { docker } from "docker"\n'), false);
});

test(`${proof} — a trial with a ready compute host runs the two sandbox files on this machine and reports them passing`, { timeout: 120_000 }, async () => {
  const image = 'graphyard-trial:sandbox-local-fixture';
  const hosts = await shardHosts('sandbox-local-trial', ['box'], { [image]: `sha256:${'35a6'.repeat(16)}` });
  const pure = Array.from({ length: 4 }, (_, index) => `tests/plain-${index}.test.ts`);
  const files = [...pure, ...sandboxed];
  const answers = join(hosts.root, 'answers.jsonl');
  const { root, sha } = await shardRepository('sandbox-local-repo', [], {
    'scripts/tests.mjs': `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const remote = process.cwd().includes('/.graphyard/runs/');
const sandboxed = ${JSON.stringify(sandboxed)};
let failed = 0;
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  const passed = !(remote && sandboxed.includes(file));
  if (!passed) { console.log('bwrap: No permissions to create a new namespace: ' + file); failed++; }
  appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ file, remote, passed }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed, durationMs: 1 }) + '\\n');
}
process.exit(failed ? 1 : 0);
`,
    ...Object.fromEntries(pure.map(file => [file, 'test("adds", () => equal(1 + 1, 2))\n'])),
    ...Object.fromEntries(await Promise.all(sandboxed.map(async file => [file, await readFile(join(repo, file), 'utf8')]))),
  });
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
    if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, wrapper: undefined });
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
  };
  const previous = process.env.GRAPHYARD_TRIAL_IMAGE;
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
  try {
    const result = await runTrial({ root, base: await temporaryDirectory('sandbox-local-base'), mergeSha: sha, changedFiles: files, timeoutMs: 90_000, cores: 2, run, retries: 0,
      remote: { hosts: ['gy-compute@box'], read: async () => [reading('vishrog', 2), reading('gy-compute@box', 8)] } });
    assert.equal(result.build, 'pass', result.logTail);
    assert.deepEqual({ passed: result.tests.passed, failed: result.tests.failed }, { passed: files.length, failed: [] }, result.logTail);
    const lines = (await readFile(answers, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; remote: boolean; passed: boolean });
    for (const file of sandboxed) assert.deepEqual(lines.filter(line => line.file === file).map(line => [line.remote, line.passed]), [[false, true]], `${file} ran here and passed`);
    assert.ok(lines.some(line => line.remote), 'other files still went to the host');
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; }
});
