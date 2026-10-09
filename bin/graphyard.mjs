#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
// GY-1585: while the self-upgrade holds a restart for the release production serves, it names a
// snapshot of that release in .graphyard/held-cli.json, and every command runs the snapshot's code
// through bin/held-release-hooks.mjs, so the CLI processes the loop and the executors spawn speak
// the protocol the serving plane accepts. So does a loop its supervisor restarts during the hold:
// the deliberate restart once the hold lifts comes after the pointer is removed.
const held = () => {
  try {
    const pin = JSON.parse(readFileSync(new URL('../.graphyard/held-cli.json', import.meta.url), 'utf8'));
    if (typeof pin?.root !== 'string') return [];
    const to = pathToFileURL(`${pin.root}/`).href;
    if (!existsSync(new URL('src/cli.ts', to))) return [];
    const data = { from: new URL('../', import.meta.url).href, to };
    const register = `import { register } from 'node:module'; register(${JSON.stringify(new URL('held-release-hooks.mjs', import.meta.url).href)}, { data: ${JSON.stringify(data)} });`;
    return ['--import', `data:text/javascript,${encodeURIComponent(register)}`];
  } catch { return []; }
};
const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), ...held(), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => process.exit(code ?? 1));
