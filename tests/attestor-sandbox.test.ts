import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// GY-966: inside a worker sandbox root's /tmp and /home stat as uid 65534, and the host
// attestor refuses every fixture beneath them. Every test that needs an attested run guards
// on that (tests/helpers/attestor-ancestry.ts); this runs those tests under the simulated
// sandbox (tests/helpers/unprivileged-stat.mjs) and requires them all to pass, each with its
// environment note, so a new ownership-dependent test without the guard fails here.

const root = fileURLToPath(new URL('..', import.meta.url));
const simulated = fileURLToPath(new URL('./helpers/unprivileged-stat.mjs', import.meta.url));

function nodeTest(args: string[]) {
  return new Promise<{ code: number | null; out: string }>((settled, refused) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', ...args],
      { cwd: root, env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${simulated}`.trim() } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('every attestor-ownership test passes under a simulated sandbox that stats /tmp and /home as uid 65534', async () => {
  const units = await nodeTest(['tests/runner-executor.test.ts', 'tests/runner-attestor.test.ts']);
  assert.equal(count(units.out, 'fail'), 0, units.out);
  assert.equal(units.code, 0, units.out);
  assert.ok(count(units.out, 'pass') > 0, units.out);
  // Thirteen executor tests, the sticky-ancestor test and all seven attestor tests took the
  // sandbox branch; none of them passed by running an attestation the host cannot make.
  assert.equal(notes(units.out), 21, units.out);

  const cli = await nodeTest(['--test-name-pattern=^the runner (holds authority while the host attestor|retries a lost acknowledgement)', 'tests/cli.test.ts']);
  assert.equal(count(cli.out, 'fail'), 0, cli.out);
  assert.equal(cli.code, 0, cli.out);
  assert.equal(count(cli.out, 'pass'), 2, cli.out);
  assert.equal(notes(cli.out), 2, cli.out);
});
