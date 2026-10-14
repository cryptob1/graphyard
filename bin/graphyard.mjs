#!/usr/bin/env node
import { spawn } from 'node:child_process';import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { heldRelease } from './held-release-hooks.mjs';
const args = process.argv.slice(2);
// GY-1585: while the self-upgrade holds a restart for the release production serves, it names a
// snapshot of that release in .graphyard/held-cli.json, and every command runs the snapshot's code
// through bin/held-release-hooks.mjs, so the CLI processes the loop and the executors spawn speak
// the protocol the serving plane accepts. A loop its supervisor restarts during the hold runs the
// snapshot only when the snapshot's own loop reads the hold's cursor and keeps holding (`loop`);
// a release from before the hold would refuse that cursor, or restart onto the checkout, so such a
// loop runs the checkout's code, which holds. The deliberate restart comes after the pin is removed.
const held = () => {
  const pin = heldRelease(new URL('../', import.meta.url));
  if (!pin || (args[0] === 'master' && args[1] === 'run' && !pin.loop)) return [];
  const data = { from: new URL('../', import.meta.url).href, to: pin.to };
  // GY-1790: the resolve hooks that redirect every module are the ones the pinned snapshot holds,
  // not this checkout's: while the pin stands, what loads is decided by the commit the restart
  // pinned, so an edited bin/held-release-hooks.mjs in the checkout never runs. A snapshot from
  // before the hooks file existed keeps this checkout's (it is the bootstrap either way).
  const hooks = existsSync(new URL('bin/held-release-hooks.mjs', pin.to)) ? new URL('bin/held-release-hooks.mjs', pin.to).href : new URL('held-release-hooks.mjs', import.meta.url).href;
  const register = `import { register } from 'node:module'; register(${JSON.stringify(hooks)}, { data: ${JSON.stringify(data)} });`;
  return ['--import', `data:text/javascript,${encodeURIComponent(register)}`];
};
const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), ...held(), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => process.exit(code ?? 1));
