#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let child;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child?.kill(signal));
// Resolve the complete artifact before loading tsx. Retained artifacts also keep lazy imports safe.
for (let attempt = 0; ; attempt++) {
  let selected = root;
  try { selected = realpathSync(join(root, '.graphyard', 'cli-current')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const loader = createRequire(join(selected, 'package.json')).resolve('tsx');
  child = spawn(process.execPath, ['--import', loader, join(selected, 'src/cli.ts'), ...args], { stdio: 'inherit', env: { ...process.env, GRAPHYARD_LAUNCHER: '1' } });
  const code = await new Promise(resolve => {
    child.on('error', error => { console.error(error.message); resolve(1); });
    child.on('exit', code => resolve(code ?? 1));
  });
  if (code !== 75 || attempt >= 3) process.exit(code === 75 ? 1 : code);
  console.error(`[graphyard] release handover: retry ${attempt + 1}/3 in 500ms`);
  await new Promise(resolve => setTimeout(resolve, 500));
}
