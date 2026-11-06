import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { freePort } from '../src/cli/test-isolation.js';
import { defaultRepositoryPolicy } from '../src/model/repository-policy.js';
import { setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeOne, runMergeTrial, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { masterConfigSchema } from '../src/master.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { countJunitCases, countProofCases, junitCases } from '../src/proof-runner.js';
import { runProof } from '../src/cli/verify.js';
import type { Principal, Work } from '../src/model.js';

const own = 'unit:tests/proof-runner-counts.test.ts';
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Stands in for vitest's CLI, which this repository does not depend on: real `npx` runs it from the
// fixture's node_modules, it reads the title of each case and whether it fails from the test file,
// prints no TAP, exits non-zero on a failing case and writes vitest's JUnit shape when asked.
const fakeVitest = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const output = process.argv.find(arg => arg.startsWith('--outputFile='))?.slice(13);
const files = process.argv.slice(3).filter(arg => !arg.startsWith('--'));
if (process.argv.includes('--crash')) process.exit(2);
const cases = (files.length ? files : ['src/proof.test.ts']).flatMap(file => [...readFileSync(file, 'utf8').matchAll(/test\\('([^']+)', (pass|fail)\\)/g)].map(([, name, how]) => ({ file, name, failed: how === 'fail' })));
console.log('Tests ' + cases.filter(entry => !entry.failed).length + ' passed');
if (output) writeFileSync(output, '<?xml version="1.0"?><testsuites><testsuite name="s">' + cases.map(entry => '<testcase classname="' + entry.file + '" name="suite &gt; ' + entry.name + '" time="0.1">' + (entry.failed ? '<failure message="no"/>' : '') + '</testcase>').join('') + '</testsuite></testsuites>');
process.exit(cases.some(entry => entry.failed) ? 1 : 0);
`;

interface Fixture { origin: string; checkout: string; baseTip: string; write: (path: string, value: string) => Promise<void> }
/** A repository with a base commit on origin: the given files, and a local `vitest` when package.json declares it. */
async function repository(directory: string, files: Record<string, string>): Promise<Fixture> {
  const origin = join(directory, 'origin.git'), checkout = join(directory, 'checkout');
  await mkdir(directory, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.com');
  const write = async (path: string, value: string) => { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), value); };
  for (const [path, value] of Object.entries(files)) await write(path, value);
  if (files['package.json']?.includes('vitest')) { await write('node_modules/.bin/vitest', fakeVitest); await chmod(join(checkout, 'node_modules/.bin/vitest'), 0o755); }
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'base'); git(checkout, 'push', '-q', 'origin', 'main');
  return { origin, checkout, baseTip: git(origin, 'rev-parse', 'main'), write };
}
const vitestPackage = (test = 'vitest run') => JSON.stringify({ scripts: { test }, devDependencies: { vitest: '^3.0.0' } });
const vitestProof = (how: 'pass' | 'fail') => `test('unit:declared works', ${how});\n`;
/** A merge writer's child runner for a worker that already runs confined: fixture commands run directly. */
const direct: ChildRun = async (command, args, options) => {
  if (existsSync('/etc/graphyard-trial') || !options?.wrapper?.length) return defaultChildRun(command, args, options);
  const harness = '/graphyard-harness/node_modules/tsx/dist/loader.mjs';
  if (args.includes(harness)) {
    // The bound E2E's script resolves the trusted harness here; it exits once its server stops.
    const script = args.at(-1)!;
    await writeFile(script, (await readFile(script, 'utf8')).replaceAll('/graphyard-harness', fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')));
    args = args.map(arg => arg === harness ? fileURLToPath(new URL(import.meta.resolve('tsx'))) : arg);
    options = { ...options, timeoutMs: 15_000 };
  }
  return defaultChildRun(command, args, { ...options, wrapper: [] });
};
/** One trial of a change on top of the fixture's base, on the merge writer's own `runMergeTrial`. */
async function trial(fixture: Fixture, directory: string, proofs: string[], run: ChildRun = direct, reproduce = false) {
  await fixture.write('change.txt', 'change'); git(fixture.checkout, 'add', '.'); git(fixture.checkout, 'commit', '-qm', 'change');
  return runMergeTrial({ root: fixture.checkout, base: join(directory, 'managed'), mergeSha: git(fixture.checkout, 'rev-parse', 'HEAD'), changedFiles: ['change.txt'], proofs, proofFiles: [], baseTip: fixture.baseTip, timeoutMs: 120_000, key: 'GY-1', retries: 0, attribute: false, reproduce, environment: { PATH: process.env.PATH! }, run, remove: async () => {} });
}

test(`${own} — a vitest repository's passing proof records executed >= 1 and the head merges; a failing one is refused with its count; a proof no test names is refused with that reason`, { timeout: 600_000 }, async () => {
  const root = await temporaryDirectory('proof-runner-counts'), servePort = await freePort();
  let store: Store | undefined, http: ReturnType<typeof server> | undefined;
  try {
    store = await withDatabase('proof-runner-counts'); await store.init();
    const engine = new Engine(store, 120, 'owner/proofs');
    const token = 'fixture-coordinator-' + 'x'.repeat(32);
    http = server(engine, [{ ...coordinator, token }]);
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    setRepositoryPolicy({ ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
    let branchNumber = 0;
    for (const mode of ['passing', 'failing', 'unnamed'] as const) {
      const directory = join(root, mode);
      // Even a check that exits successfully cannot turn a failing case into accepted proof.
      const { origin, checkout, baseTip, write } = await repository(directory, { 'package.json': vitestPackage(mode === 'failing' ? 'vitest run; true' : 'vitest run'), 'src/proof.test.ts': vitestProof(mode === 'failing' ? 'fail' : 'pass'),
        // The trial serves the real head before running its bound command case.
        'serve.cjs': `require('node:http').createServer((q,s)=>s.end('ok')).listen(${servePort}, '127.0.0.1');\n`,
        'graphyard.json': JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.cjs', url: `http://127.0.0.1:${servePort}`, readySeconds: 1 } } }),
        'e2e/cases/fixture.json': JSON.stringify({ id: 'fixture', title: 'Fixture', target: 'any', required: false, steps: [{ kind: 'command', name: 'served head command', run: 'node --eval 0' }] }) });
      engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
      const branch = `graphyard/gy-${++branchNumber}-1`, proof = mode === 'unnamed' ? 'unit:absent' : 'unit:declared';
      git(checkout, 'checkout', '-qb', branch, baseTip);
      await write('change.txt', 'change'); git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'change');
      const head = git(checkout, 'rev-parse', 'HEAD');
      let work = await engine.execute(operator, 'create', null, { type: 'chore', title: mode, criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof, 'e2e:fixture'] }, { id: 'AC-2', text: 'Observe after deployment', proofs: ['manual:post-deploy/observed'] }] }, randomUUID());
      work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
      work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
      await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'fixture', path: join(directory, branch), branch }, randomUUID());
      work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head }, randomUUID());
      git(checkout, 'checkout', '-q', 'main');
      const trials: MergeRecordEvent[] = [];
      const reads = mergeWriterReads(masterConfigSchema.parse({ version: 1, repository: 'owner/proofs', baseBranch: 'main', url, credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run: { mergeWriter: { deployKeyFile: join(directory, 'unused-key') } } }), checkout, direct, {
        base: join(directory, 'managed'),
        trial: input => runMergeTrial({ ...input, retries: 0, attribute: false }),
        record: async (_, event) => {
          if (event.kind === 'trial') trials.push(event);
          const answer = await fetch(`${url}/api/work/${work.id}/merge-record`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(event) });
          assert.equal(answer.status, 200, await answer.text());
        },
      });
      const outcome = await mergeOne(reads, work);
      assert.equal(outcome.outcome, mode === 'passing' ? 'merged' : 'refused', `${mode}: ${JSON.stringify(outcome)}`);
      const recorded: Work = (await store.workDocument(work.id))!, last = trials.at(-1)!;
      assert.ok(last.kind === 'trial' && last.outcome === 'verdict');
      const counts = last.proofs[proof];
      assert.equal(git(origin, 'rev-parse', 'main') === baseTip, mode !== 'passing', 'only a positive passing count moves main');
      if (mode === 'passing') assert.deepEqual(counts, { executed: 1, failed: 0 });
      if (mode === 'failing') { assert.deepEqual(counts, { executed: 1, failed: 1 }); assert.match(recorded.mergeLedger!.refusal!.reason, /unit:declared.*the trial ran 1 and 1 failed/); }
      if (mode === 'unnamed') { assert.deepEqual(counts, { executed: 0, failed: 0, reason: 'no test file names it' }); assert.match(recorded.mergeLedger!.refusal!.reason, /unit:absent.*no test file names it/); }
    }
  } finally {
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(`${own} — a failing check and a crashing runner each keep what the runner said: its count, or that it ended abnormally`, { timeout: 120_000 }, async () => {
  const root = await temporaryDirectory('proof-runner-abnormal');
  try {
    const failing = await repository(join(root, 'failing'), { 'package.json': vitestPackage(), 'src/proof.test.ts': vitestProof('fail') });
    const failed = await trial(failing, join(root, 'failing'), ['unit:declared']);
    assert.deepEqual(failed.proofs['unit:declared'], { executed: 1, failed: 1 });
    assert.deepEqual(failed.tests.failed, ['test']);
    const crashing = await repository(join(root, 'crashing'), { 'package.json': vitestPackage(), 'src/proof.test.ts': vitestProof('pass') });
    const crashed = await trial(crashing, join(root, 'crashing'), ['unit:declared'], (command, args, options) => direct(command, command === 'npx' ? [...args, '--crash'] : args, options));
    assert.deepEqual(crashed.proofs['unit:declared'], { executed: 0, failed: 0, reason: 'the runner ended abnormally' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test(`${own} — the run on the base tip counts through the runner too: a vitest proof that also passes there is not reproduced`, { timeout: 120_000 }, async () => {
  const root = await temporaryDirectory('proof-runner-base');
  try {
    const fixture = await repository(root, { 'package.json': vitestPackage(), 'src/proof.test.ts': vitestProof('pass') });
    const run = await trial(fixture, root, ['unit:declared'], direct, true);
    assert.deepEqual(run.notReproduced, { proofs: ['unit:declared'], tip: fixture.baseTip });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test(`${own} — pytest's JUnit report: proof unit:report counts test_unit_report and not test_unit_report_ready`, { timeout: 120_000 }, async () => {
  const report = '<?xml version="1.0"?><testsuites><testsuite name="pytest"><testcase classname="tests.test_report" name="test_unit_report" time="0.01"/><testcase classname="tests.test_report" name="test_unit_report_ready" time="0.01"><failure message="no">boom</failure></testcase><testcase classname="tests.test_report" name="test_unit_other" time="0"><skipped/></testcase></testsuite></testsuites>';
  assert.deepEqual(countJunitCases(junitCases(report), 'unit:report', 'pytest'), { executed: 1, failed: 0, skipped: 0 });
  assert.deepEqual(countJunitCases(junitCases(report), 'unit:report-ready', 'pytest'), { executed: 1, failed: 1, skipped: 0 });
  assert.deepEqual(countJunitCases(junitCases(report), 'unit:other', 'pytest'), { executed: 0, failed: 0, skipped: 1 });
  // pytest itself is no dependency here: the trial's `python -m pytest` answers with that report.
  const root = await temporaryDirectory('proof-runner-pytest');
  try {
    const fixture = await repository(root, { 'tests/test_report.py': 'def test_unit_report(): pass\ndef test_unit_report_ready(): assert False\n', 'tests/test_other.py': 'def test_unit_other(): pass\n' });
    const invoked: string[][] = [];
    const run = await trial(fixture, root, ['unit:report'], async (command, args, options) => {
      if (command !== 'python') return direct(command, args, options);
      invoked.push(args);
      await writeFile(args.find(arg => arg.startsWith('--junitxml='))!.slice(11), report);
      return '';
    });
    assert.deepEqual(run.proofs['unit:report'], { executed: 1, failed: 0 });
    assert.equal(invoked.length, 1);
    assert.deepEqual([invoked[0]![0], invoked[0]![1], invoked[0]!.at(-1)], ['-m', 'pytest', 'tests/test_report.py'], 'only the file that names the proof runs');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test(`${own} — a repository whose checks print TAP gets identical counts and no second runner invocation, whatever else it declares`, { timeout: 120_000 }, async () => {
  const root = await temporaryDirectory('proof-runner-tap');
  try {
    const tap = "TAP version 13\nok 1 - unit:declared works\nnot ok 2 - unit:broken works\n";
    const fixture = await repository(root, { 'package.json': vitestPackage('node tap.cjs'), 'tap.cjs': `console.log(${JSON.stringify(tap)});\n`, 'src/proof.test.ts': vitestProof('pass') });
    const children: string[] = [];
    const run = await trial(fixture, root, ['unit:declared', 'unit:broken'], (command, args, options) => { children.push(command); return direct(command, args, options); });
    assert.deepEqual(run.proofs, { 'unit:declared': { executed: 1, failed: 0 }, 'unit:broken': { executed: 1, failed: 1 } });
    assert.deepEqual(['unit:declared', 'unit:broken'].map(proof => countProofCases(tap, proof)), [{ executed: 1, failed: 0, skipped: 0 }, { executed: 1, failed: 1, skipped: 0 }]);
    assert.ok(!children.includes('npx') && !children.includes('python'), children.join(' '));
    assert.equal(children.filter(command => command === 'npm').length, 1, 'the check runs once');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test(`${own} — graphyard verify counts a vitest proof through the same function: a pass, a failure and a proof no test names`, { timeout: 120_000 }, async () => {
  const root = await temporaryDirectory('proof-runner-verify');
  try {
    const { checkout, write } = await repository(root, { 'package.json': vitestPackage(), 'src/proof.test.ts': vitestProof('pass') });
    const passing = await runProof(checkout, 'unit:declared', ['src/proof.test.ts']);
    assert.deepEqual(passing, { result: 'pass', executed: 1, failed: 0, skipped: 0, files: ['src/proof.test.ts'] });
    assert.deepEqual(await runProof(checkout, 'unit:absent', []), { result: 'fail', executed: 0, failed: 0, skipped: 0, files: [], abnormal: 'no test file names it' });
    await write('src/proof.test.ts', vitestProof('fail'));
    assert.deepEqual(await runProof(checkout, 'unit:declared', ['src/proof.test.ts']), { result: 'fail', executed: 1, failed: 1, skipped: 0, files: ['src/proof.test.ts'] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
