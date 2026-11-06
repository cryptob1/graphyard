import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands } from '../src/cli/index.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3172: `graphyard login --help` used to run login and mint a real single-use admin sign-in
// link. The launcher answers a subcommand's help flag itself, so neither command runs.

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

test("unit:tests/cli-subcommand-help.test.ts — login --help and open -h print the command's help and never call signInLink", async () => {
  // signInLink mints its link with POST /api/sign-in-links, so any request this stub receives is
  // a sign-in link a help flag minted.
  const requests: string[] = [];
  const http = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/healthz' ? {} : { code: 'stub-code', principal: 'operator', expiresAt: '2030-01-01T00:10:00.000Z' }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const cwd = await temporaryDirectory('cli-subcommand-help');
  // On the unfixed CLI `open` hands the minted link to the browser opener; a failing stand-in keeps that run from opening one.
  const bin = join(cwd, 'bin');
  await mkdir(bin);
  for (const opener of ['xdg-open', 'open']) { const path = join(bin, opener); await writeFile(path, '#!/bin/sh\nexit 1\n'); await chmod(path, 0o755); }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GRAPHYARD_TOKEN: 'fixture', GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}` };
  const helpOf = (name: string) => commands.find(entry => entry.name === name)!.help.join('\n');
  try {
    const login = await exec(process.execPath, [launcher, 'login', '--help'], { cwd, env });
    assert.equal(login.stdout, `${helpOf('login')}\n`, 'login --help prints login\'s help');
    const open = await exec(process.execPath, [launcher, 'open', '-h'], { cwd, env });
    assert.equal(open.stdout, `${helpOf('open')}\n`, 'open -h prints open\'s help');
    assert.deepEqual(requests, [], 'a help flag reaches no control plane, so no sign-in link is minted');
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});
