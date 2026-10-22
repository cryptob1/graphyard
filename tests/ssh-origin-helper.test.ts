import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deployKeySshCommand } from '../src/merge-writer/executor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { keylessSshCommand, sshOrigin } from './helpers/ssh-origin.js';

/**
 * The tests/helpers/ssh-origin.ts door (GY-1932): a local bare repository that serves
 * git-upload-pack/git-receive-pack only to a caller whose GIT_SSH_COMMAND presents the merge
 * writer's deploy key, and refuses every other caller with `Host key verification failed.`.
 */
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text);
  git(cwd, 'add', '--', path);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Run one child, capturing its output. */
const child = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
  const run = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  run.stdout.on('data', chunk => { stdout += chunk; });
  run.stderr.on('data', chunk => { stderr += chunk; });
  const timer = options.timeoutMs ? setTimeout(() => run.kill('SIGKILL'), options.timeoutMs) : undefined;
  timer?.unref();
  run.once('close', (code, signal) => { if (timer) clearTimeout(timer); resolve({ status: code ?? (signal ? 1 : null), stdout, stderr }); });
  run.once('error', error => { if (timer) clearTimeout(timer); resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }); });
});

test('unit:ssh-origin-helper — the ssh-origin door serves clone, fetch and push to a caller presenting the deploy key, and refuses a caller with no key and one with an impostor key with `Host key verification failed.` and exit 255, recording every caller and whether it presented the key', { timeout: 120_000 }, async () => {
  const door = await sshOrigin(await temporaryDirectory('ssh-origin-helper'));
  assert.equal(door.deployKeySshCommand, deployKeySshCommand(door.deployKeyFile), 'the door opens with production\'s own deploy-key GIT_SSH_COMMAND');
  const env = (sshCommand?: string) => ({ ...process.env, PATH: `${door.bin}:${process.env.PATH}`, ...(sshCommand ? { GIT_SSH_COMMAND: sshCommand } : {}) });
  // A caller presenting the deploy key clones the empty repository through the door, pushes to it, and fetches from it.
  const seed = join(door.repository, '..', 'seed');
  execFileSync('git', ['clone', '-q', door.url, seed], { env: env(door.deployKeySshCommand), stdio: 'ignore' });
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  const head = await commit(seed, 'README.md', '# through the door\n', 'base');
  execFileSync('git', ['-C', seed, 'push', '-q', '-u', 'origin', 'main'], { env: env(door.deployKeySshCommand), stdio: 'ignore' });
  execFileSync('git', ['-C', seed, 'fetch', '-q', '--all'], { env: env(door.deployKeySshCommand), stdio: 'ignore' });
  assert.equal(git(door.repository, 'rev-parse', 'refs/heads/main'), head, 'the push landed on the local bare repository the door serves');
  // A caller without any key, and one with an impostor key, are refused exactly as the sandboxes were.
  const keyless = await child('git', ['-C', seed, 'ls-remote', door.url], { env: env(keylessSshCommand), timeoutMs: 60_000 });
  assert.notEqual(keyless.status, 0, 'a caller with no deploy key reads nothing');
  assert.match(keyless.stderr, /Host key verification failed\./, 'the refusal names the host key, as the sandboxes observed');
  assert.match(keyless.stderr, /Could not read from remote repository\./, 'git reports the dead transport');
  const impostor = await child('git', ['-C', seed, 'ls-remote', door.url], { env: env(`ssh -i ${join(door.repository, '..', 'not-the-key')} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`), timeoutMs: 60_000 });
  assert.notEqual(impostor.status, 0, 'a caller with the wrong key reads nothing');
  assert.match(impostor.stderr, /Host key verification failed\./);
  // Every caller is recorded, with whether it presented the deploy key.
  const calls = await door.accesses();
  const served = calls.filter(entry => entry.presented);
  assert.ok(served.length >= 3, `the clone, the push and the fetch went through the door: ${JSON.stringify(calls)}`);
  assert.ok(served.every(entry => entry.outcome === 'served'), 'every credentialed caller was served');
  assert.ok(served.some(entry => entry.service === 'git-upload-pack'), 'reads are served through git-upload-pack');
  assert.ok(served.some(entry => entry.service === 'git-receive-pack'), 'pushes are served through git-receive-pack');
  const refused = calls.filter(entry => !entry.presented);
  assert.deepEqual(refused.map(entry => [entry.service, entry.outcome]), [['git-upload-pack', 'refused'], ['git-upload-pack', 'refused']], 'the keyless and impostor callers are recorded refused');
  assert.ok(refused.every(entry => entry.outcome === 'refused'), 'no keyless caller was served');
});
