import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterCredential, setupFromZeroChecks } from '../src/setup-from-zero.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1412 AC-1 (pilot gap G2): docs/setup-from-zero.md never tells an agent to drive the CLI with
 * the human operator's admin credential. Steps 3 and 10 use the master identity `install --apply`
 * records in .graphyard/master.json, and doctor reads as that identity when no token is set.
 */
const guide = await readFile(fileURLToPath(new URL('../docs/setup-from-zero.md', import.meta.url)), 'utf8');
const step = (n: number) => guide.split(/^## /m).find(section => section.startsWith(`${n}. `)) ?? '';

test('unit:setup-guide-no-operator-token — the guide names no operator token file and never passes one to an agent', () => {
  assert.doesNotMatch(guide, /operator\.token/i, 'no step names the operator token file');
  assert.doesNotMatch(guide, /GRAPHYARD_TOKEN(?:_FILE)?=/, 'no step exports a token for the agent to use');
  assert.doesNotMatch(guide, /operator credential \(the human's/i, 'the operator credential is never handed to the CLI');
  assert.doesNotMatch(guide, /~\/\.config\/graphyard/, 'credential paths come from the plan, never a hardcoded home path');
  assert.match(guide, /operator credential stays with the human/);
  for (const redirect of guide.matchAll(/--token-stdin\s*<\s*(\S.*)$/gm)) assert.match(redirect[1], /\.graphyard\/master\.json'\)\.credentialFile/, `--token-stdin reads only the master credential: ${redirect[0]}`);
});

test('unit:setup-guide-no-operator-token — steps 3 and 10 use the master identity install --apply records', () => {
  assert.match(step(3), /`--apply` records the master connection `\.graphyard\/master\.json`/);
  assert.match(step(3), /`gy doctor` reads as it/);
  assert.match(step(10), /--token-stdin < "\$\(node -p "require\('\.\/\.graphyard\/master\.json'\)\.credentialFile"\)"/);
  assert.match(step(4), /serves `http:\/\/127\.0\.0\.1:4311` and prints it; it opens no browser/);
});

test('unit:setup-guide-no-operator-token — doctor reads with the recorded master credential and credentials-file passes with it', async () => {
  const directory = await temporaryDirectory('setup-guide-master');
  const root = join(directory, 'repo'), credential = join(directory, 'masters', 'master.token');
  await mkdir(join(root, '.graphyard'), { recursive: true }); await mkdir(join(directory, 'masters'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await writeFile(credential, 'm'.repeat(40)); await chmod(credential, 0o600);
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ url: 'http://127.0.0.1:4310', credentialFile: credential }));

  assert.deepEqual(await masterCredential(root, 'http://127.0.0.1:4310', {}), { file: credential, token: 'm'.repeat(40) });
  assert.equal(await masterCredential(root, 'http://127.0.0.1:4310', { GRAPHYARD_TOKEN_FILE: '/elsewhere' }), null, 'an explicit credential wins');
  assert.equal(await masterCredential(root, 'https://other.example', {}), null, 'a master credential for another server is never sent');
  await chmod(credential, 0o644);
  assert.equal(await masterCredential(root, 'http://127.0.0.1:4310', {}), null, 'a credential readable by others is refused');
  await chmod(credential, 0o600);

  const checks = await setupFromZeroChecks({ root, env: {}, status: { actor: { role: 'coordinator' } }, reachable: true, masterCredential: credential, environments: join(directory, 'agents'), sandbox: () => null });
  const line = checks.find(check => check.id === 'credentials-file')!;
  assert.equal(line.status, 'pass'); assert.match(line.detail, /master credential .*\.graphyard\/master\.json/);
  assert.equal(checks.find(check => check.id === 'control-plane')!.detail, 'answered as role coordinator');
});
