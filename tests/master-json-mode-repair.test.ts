import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, rename, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';

// GY-3349: a master.json saved at a wider mode by its owner is set back to 0600 with one log line,
// by the loop's config load and by `master status`, instead of failing every cycle and command.
const source = fileURLToPath(new URL('..', import.meta.url));
const coordinator = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const mode = async (file: string) => (await stat(file)).mode & 0o777;

test('master.json at 0644 is repaired to 0600 by the loop config load and master status; a symlink is refused', async () => {
  const root = await temporaryDirectory('master-json-mode'), credentials = await temporaryDirectory('master-json-mode-cred');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  // An unreachable server: `master status` reports it rather than failing, so only the config read decides.
  await setupMaster(root, { url: 'http://127.0.0.1:9', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: join(source, 'bin/graphyard.mjs'), credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinator as typeof fetch);
  const file = join(root, '.graphyard/master.json');

  await chmod(file, 0o644);
  const logged: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try { assert.equal((await loadMasterConfig(root)).repository, 'owner/project'); } finally { console.error = original; }
  assert.equal(await mode(file), 0o600);
  assert.deepEqual(logged.filter(line => line.includes(file)), [`[graphyard] ${file} had mode 0644; set it to 0600`]);

  await chmod(file, 0o644);
  const status = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), join(source, 'src/cli.ts'), 'master', 'status'], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  assert.doesNotMatch(status.stderr, /must be a regular file/, status.stderr);
  assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
  assert.equal(await mode(file), 0o600);
  assert.equal(status.stderr.split('\n').filter(line => line.includes('set it to 0600')).length, 1, status.stderr);

  const target = join(root, '.graphyard/master.target.json');
  await rename(file, target); await symlink(target, file);
  await assert.rejects(loadMasterConfig(root), /must be a regular file owned by this user/);
});
