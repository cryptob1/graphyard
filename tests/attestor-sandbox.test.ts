import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ancestryRefusal } from './helpers/attestor-ancestry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-966: inside a worker sandbox root's /tmp and /home stat as uid 65534, and the host
// attestor refuses every fixture beneath them. Every test that needs an attested run guards
// on that (tests/helpers/attestor-ancestry.ts); this runs those tests under the simulated
// sandbox (tests/helpers/unprivileged-stat.mjs) and requires them all to pass, each with its
// environment note, so a new ownership-dependent test without the guard fails here.

const root = fileURLToPath(new URL('..', import.meta.url));
const simulated = fileURLToPath(new URL('./helpers/unprivileged-stat.mjs', import.meta.url));

/** Run ARGS as a node test process; SANDBOXED loads the simulated sandbox into it and every child. */
function nodeTest(args: string[], sandboxed = true) {
  const options = `${process.env.NODE_OPTIONS ?? ''}${sandboxed ? ` --import ${simulated}` : ''}`.trim();
  return new Promise<{ code: number | null; out: string }>((settled, refused) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', ...args],
      { cwd: root, env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: options || undefined } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    child.on('error', refused);
    child.on('close', code => settled({ code, out }));
  });
}
const count = (out: string, name: string) => Number(out.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
const notes = (out: string) => out.match(/environment note \(GY-966\)/g)?.length ?? 0;

const runnerAttestorTests = '--test-name-pattern=^the runner (holds authority while the host attestor|retries a lost acknowledgement)';

test('unit:attestor-test-sandbox-conditional — the runner-attestor CLI test passes in full where the attestor ownership rule holds and passes with a recorded environment note where the sandbox stats /tmp and /home as uid 65534', async () => {
  // This host, unsimulated: where the ancestry of a fresh fixture holds, the tests run their
  // attested path and record no note; where this host is itself a sandbox, they note it.
  const holds = !await ancestryRefusal(await temporaryDirectory('gy-966'));
  const host = await nodeTest([runnerAttestorTests, 'tests/cli.test.ts'], false);
  assert.equal(count(host.out, 'fail'), 0, host.out);
  assert.equal(host.code, 0, host.out);
  assert.equal(count(host.out, 'pass'), 2, host.out);
  assert.equal(notes(host.out), holds ? 0 : 2, host.out);

  // The simulated sandbox: the same tests still pass, each asserting the attestor's ownership
  // refusal and recording its environment note in place of an attested run.
  const sandbox = await nodeTest([runnerAttestorTests, 'tests/cli.test.ts']);
  assert.equal(count(sandbox.out, 'fail'), 0, sandbox.out);
  assert.equal(sandbox.code, 0, sandbox.out);
  assert.equal(count(sandbox.out, 'pass'), 2, sandbox.out);
  assert.equal(notes(sandbox.out), 2, sandbox.out);
});

test('unit:sandbox-ownership-tests-guarded — every runner-executor and runner-attestor test asserting ownership of the oracle bundle paths passes under a simulated sandbox that stats /tmp and /home as uid 65534, with zero ownership-attributable failures', async () => {
  const units = await nodeTest(['tests/runner-executor.test.ts', 'tests/runner-attestor.test.ts']);
  assert.equal(count(units.out, 'fail'), 0, units.out);
  assert.equal(units.code, 0, units.out);
  assert.ok(count(units.out, 'pass') > 0, units.out);
  // Thirteen executor tests, the sticky-ancestor test and all seven attestor tests took the
  // sandbox branch; none of them passed by running an attestation the host cannot make.
  assert.equal(notes(units.out), 21, units.out);
});
