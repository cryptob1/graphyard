// Trusted runner for unit contracts. It executes the protected inventory file against the
// candidate checkout prepared by prepare-acceptance.mjs and judges the TAP stream it produces.
// Like run-acceptance.mjs it receives no producer token: the report it writes is published by a
// separate job, and a passing report is accepted only from a job GitHub reports as successful.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contract } from './contracts.mjs';
import { judgeUnitCases } from './unit-contract.mjs';
import { abnormalTestExit, loaderDigest, npmCiArgs, npmCiEnvironment, repeatedRequiredTitle } from '../src/cli/test-isolation.ts';

const [metadataFile, candidateDirectory, output, proof] = process.argv.slice(2);
if (!metadataFile || !candidateDirectory || !output || !proof) throw new Error('Usage: run-unit-acceptance metadata.json candidate-directory output.json proof');
const selected = contract(proof);
if (selected.kind !== 'unit') throw new Error(`${proof} is not a unit contract; run-acceptance.mjs executes ${selected.kind ?? 'integration'} contracts`);
const harness = resolve(fileURLToPath(new URL('..', import.meta.url)));
const candidate = resolve(candidateDirectory);
const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
let cases = selected.requiredCases.map(id => ({ id, result: 'skipped' })), passed = false;
try {
  // Dependencies are installed before the inventory lands: the candidate's lifecycle scripts
  // (preinstall/postinstall/prepare, or a dependency's) run during `npm ci` and could otherwise
  // rewrite the file after it was copied. The full tree: an inherited omit/production config would
  // skip the devDependencies (or, from an .npmrc omit=optional, the platform packages) the suite
  // needs while npm still exits 0, and an ignore-scripts or bin-links=false setting would skip the
  // install scripts or node_modules/.bin links it runs on. What the harness contributes is fixed
  // before any candidate code runs: the inventory's bytes and the transpiler that loads it, with a
  // digest of every file that transpiler loads. The install runs as this job's user and can write
  // the harness checkout, so the loader is checked against that digest before the run and again
  // after it: a lifecycle script (or a process it left behind) that rewrote tsx, a dependency of it
  // or node itself fails the proof instead of substituting passing cases. This job holds no
  // Graphyard or GitHub credential for the install to read: the report is published by another job.
  const protectedInventory = await readFile(join(harness, selected.file));
  const transpiler = harnessTranspiler();
  execFileSync('npm', ['ci', '--include=dev', '--include=optional', '--no-dry-run', '--ignore-scripts=false', '--bin-links', '--no-audit', '--no-fund'], { cwd: candidate, env: npmCiEnvironment(), stdio: ['ignore', 'inherit', 'inherit'] });
  // The protected inventory replaces whatever the candidate carries at that path, so the cases
  // judged are the ones this checkout registers. The candidate's own source is what they import.
  // It is copied and byte-compared immediately before the run so nothing between the copy and the
  // test process can substitute the candidate's own version, and compared with the bytes read
  // before the install so a lifecycle script that rewrote the harness copy is caught too.
  await mkdir(dirname(join(candidate, selected.file)), { recursive: true });
  await copyFile(join(harness, selected.file), join(candidate, selected.file));
  if (!protectedInventory.equals(await readFile(join(candidate, selected.file)))) throw new Error(`${selected.file} in the candidate checkout does not match the protected inventory`);
  // The inventory file runs whole and its cases are judged by title: narrowing the run with
  // --test-name-pattern would report the file's other cases as skipped. Those other cases are the
  // ordinary CI suite's business, so the verdict is the required cases' alone, read from the TAP
  // stream on stdout — provided the run ended normally: a failing hook, a crash or unhandled
  // rejection after the last case, or a signal fails the proof whatever its cases printed.
  // The transpiler is the protected harness's own: a bare `--import tsx` from the candidate
  // checkout would resolve the tsx its lockfile installed, which loads before the inventory and
  // could hook module loading to substitute passing cases.
  assertLoaderUnchanged(transpiler, 'before the inventory ran');
  const run = spawnSync(process.execPath, ['--import', transpiler.href, '--test', '--test-reporter=tap', selected.file],
    { cwd: candidate, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  assertLoaderUnchanged(transpiler, 'while the inventory ran');
  process.stderr.write(run.stderr ?? '');
  cases = judgeUnitCases(selected, run.stdout ?? '');
  // A required title reported twice (a module the inventory imports registering its own case under
  // it) leaves no single verdict that is the protected case's: the proof does not pass.
  const repeated = repeatedRequiredTitle(run.stdout ?? '', selected.requiredCases.map(id => selected.titles[id]));
  if (repeated) throw new Error(repeated);
  const abnormal = abnormalTestExit(run.stdout ?? '', run.status, run.signal);
  if (abnormal) throw new Error(`${abnormal}; the inventory run did not end normally`);
  passed = cases.every(entry => entry.result === 'pass');
  console.log(`Trusted unit acceptance completed: ${cases.filter(entry => entry.result === 'pass').length}/${cases.length} ${proof} cases passed.`);
} catch (error) { console.error(`Trusted unit acceptance failed: ${error.message}. No passing evidence was produced.`); }
finally {
  if (!passed) process.exitCode = 1;
  const executed = cases.filter(entry => entry.result !== 'skipped').length;
  const result = { ...metadata, schema: 1, proof, result: passed ? 'pass' : 'fail', cases, executed, skipped: cases.length - executed };
  await writeFile(resolve(output), JSON.stringify(result, null, 2));
}

/**
 * tsx resolved from this harness checkout, installed from the harness's own lockfile when the job
 * has not installed it (the full tree, overriding any .npmrc: npmCiArgs): never from the
 * candidate's node_modules. `digest` is what it loads, recorded before any candidate code runs.
 */
function harnessTranspiler() {
  let href;
  try { href = import.meta.resolve('tsx'); } catch {
    execFileSync('npm', npmCiArgs, { cwd: harness, env: npmCiEnvironment(), stdio: ['ignore', 'inherit', 'inherit'] });
    href = import.meta.resolve('tsx');
  }
  return { href, digest: loaderDigest(href) };
}

function assertLoaderUnchanged(transpiler, when) {
  if (loaderDigest(transpiler.href) !== transpiler.digest) throw new Error(`the harness transpiler (${fileURLToPath(transpiler.href)}, its dependencies or the node binary) changed after the candidate's install, ${when}`);
}
