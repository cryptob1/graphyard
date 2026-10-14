#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
// GY-1790: the supervisor units start this launcher from the held snapshot a restart went onto and
// hand it the checkout it serves in the environment, so launcher files the checkout holds dirty are
// never the code that boots a process. The checkout root is the handed one there, and this file's
// own directory's parent otherwise; the code that runs stays what this file's directory holds.
const checkout = process.env.GRAPHYARD_CHECKOUT_ROOT?.trim()
  ? pathToFileURL(`${process.env.GRAPHYARD_CHECKOUT_ROOT.trim().replace(/\/+$/, '')}/`)
  : new URL('../', import.meta.url);
// GY-1585: while the self-upgrade holds a restart for the release production serves, it names a
// snapshot of that release in .graphyard/held-cli.json, and every command runs the snapshot's code
// through bin/held-release-hooks.mjs, so the CLI processes the loop and the executors spawn speak
// the protocol the serving plane accepts. A loop its supervisor restarts during the hold runs the
// snapshot only when the snapshot's own loop reads the hold's cursor and keeps holding (`loop`);
// a release from before the hold would refuse that cursor, or restart onto the checkout, so such a
// loop runs the checkout's code, which holds. The deliberate restart comes after the pin is removed.
//
// GY-1790: the pin is read here, importing nothing from the checkout — the same reading
// bin/held-release-hooks.mjs exports as heldRelease, for the executor entry — because this file is
// the checkout's own launcher (config.cliPath): every command an operator or a session runs starts
// it, so the one thing it must never do while the pin stands is evaluate a sibling the checkout may
// hold dirty. The resolve hooks it registers are the pinned snapshot's, so an edited
// bin/held-release-hooks.mjs in the checkout loads nowhere; this file itself still runs for those
// commands, which is why master status asks for a dirty one to be returned to the commit. The
// supervised loop and executor starts never run it at all: their units start the snapshot's launcher.
const heldRelease = () => {
  try {
    const pin = JSON.parse(readFileSync(new URL('.graphyard/held-cli.json', checkout), 'utf8'));
    if (typeof pin?.root !== 'string' || typeof pin.commit !== 'string') return null;
    const snapshot = pathToFileURL(`${pin.root}/`).href;
    return existsSync(new URL('src/cli.ts', snapshot)) ? { commit: pin.commit, to: snapshot, loop: pin.loop === true } : null;
  } catch { return null; }
};
const held = () => {
  const pin = heldRelease();
  if (!pin || (args[0] === 'master' && args[1] === 'run' && !pin.loop)) return [];
  const data = { from: new URL('../', import.meta.url).href, to: pin.to };
  // The resolve hooks that redirect every module are the ones the pinned snapshot holds, not this
  // checkout's. A snapshot from before the hooks file existed keeps this checkout's (it is the
  // bootstrap either way).
  const hooks = existsSync(new URL('bin/held-release-hooks.mjs', pin.to)) ? new URL('bin/held-release-hooks.mjs', pin.to).href : new URL('held-release-hooks.mjs', import.meta.url).href;
  const register = `import { register } from 'node:module'; register(${JSON.stringify(hooks)}, { data: ${JSON.stringify(data)} });`;
  return ['--import', `data:text/javascript,${encodeURIComponent(register)}`];
};
const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), ...held(), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => process.exit(code ?? 1));
