import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readlinkSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LaunchRefusedError, launchPlan, nonInteractiveLaunch } from '../src/harness.js';
import { startAgentSession } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1717: Codex's workspace-write sandbox protects `.agents` and `.codex` under its working
 * directory, and bubblewrap cannot create a missing one under a read-only mount, so every command
 * of a session started without them failed. A codex launch creates each missing one first.
 *
 * unit:codex-protected-paths-created — before a codex launch in a directory lacking `.agents` or
 * `.codex`, both exist afterwards; ones already present, including a file or symlink, are untouched.
 * unit:codex-protected-paths-codex-only — other runtimes' launches create nothing.
 * unit:codex-protected-paths-symlink-refused — a codex launch where either is a symlink, dangling or
 * not, is refused naming the path and saying to remove the symlink, which is left unmodified.
 */

const codexProtectedPaths = ['.agents', '.codex'];

const launch = async (kind: string, cwd: string) => {
  const directory = await temporaryDirectory(`${kind}-launch`), home = await temporaryDirectory(`${kind}-home`);
  const run = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: {} });
  const environment = { HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, AGY_CONFIG_DIR: home };
  return startAgentSession(`review-${kind}-1-2e26881a`, kind, `pane-${kind}`, launchPlan(kind).args, 'Review GY-1717', run, { directory, cwd, environment, confinement: false });
};

test('unit:codex-protected-paths-created — a codex launch creates the missing .agents and .codex in its working directory and leaves ones already present untouched', async () => {
  // Neither present: both are created as empty directories before the runtime starts.
  const bare = await temporaryDirectory('codex-bare');
  await launch('codex', bare);
  for (const name of codexProtectedPaths) {
    assert.ok((await lstat(join(bare, name))).isDirectory(), `${name} was created`);
    assert.deepEqual(await readdir(join(bare, name)), [], `${name} is empty`);
  }

  // One present as a directory with content: it is kept, and only the other is created.
  const partial = await temporaryDirectory('codex-partial');
  await mkdir(join(partial, '.agents'));
  await writeFile(join(partial, '.agents', 'skill.md'), 'kept\n');
  await launch('codex', partial);
  assert.deepEqual(await readdir(join(partial, '.agents')), ['skill.md']);
  assert.ok((await lstat(join(partial, '.codex'))).isDirectory());

  // A file in its place is left exactly as it is, and the launch goes ahead.
  const filed = await temporaryDirectory('codex-filed');
  await writeFile(join(filed, '.agents'), 'a file\n');
  await launch('codex', filed);
  assert.ok((await lstat(join(filed, '.agents'))).isFile());
  assert.equal(readFileSync(join(filed, '.agents'), 'utf8'), 'a file\n');
  assert.ok((await lstat(join(filed, '.codex'))).isDirectory());

  // A symlink in its place is left exactly as it is (the launch itself is refused; see below).
  const symlinked = await temporaryDirectory('codex-symlinked'), elsewhere = await temporaryDirectory('codex-elsewhere');
  await symlink(elsewhere, join(symlinked, '.codex'));
  await assert.rejects(launch('codex', symlinked), LaunchRefusedError);
  assert.equal(readlinkSync(join(symlinked, '.codex')), elsewhere);
  assert.deepEqual(await readdir(elsewhere), []);
});

test('unit:codex-protected-paths-codex-only — no other runtime\'s launch creates .agents or .codex', async () => {
  const others = Object.keys(nonInteractiveLaunch).filter(kind => kind !== 'codex');
  assert.ok(others.includes('claude'));
  for (const kind of others) {
    const cwd = await temporaryDirectory(`${kind}-cwd`);
    await launch(kind, cwd);
    for (const name of codexProtectedPaths) assert.ok(!existsSync(join(cwd, name)), `${kind} created ${name}`);
  }
});

test('unit:codex-protected-paths-symlink-refused — a codex launch where .agents or .codex is a symlink, dangling or not, is refused naming it, and the symlink is not modified', async () => {
  // Bubblewrap rejects a protected path through a symlink, so the launch is refused by name instead
  // of starting a sandbox that fails, and the symlink is left exactly as it is.
  const refused = (path: string) => (error: unknown) => error instanceof LaunchRefusedError && error.kind === 'codex' && error.message.includes(path) && /remove the symlink/.test(error.message);
  const dangling = await temporaryDirectory('codex-dangling'), target = await temporaryDirectory('codex-target');
  await symlink(join(target, 'missing'), join(dangling, '.codex'));
  await assert.rejects(launch('codex', dangling), refused(join(dangling, '.codex')));
  assert.ok((await lstat(join(dangling, '.codex'))).isSymbolicLink());
  assert.equal(readlinkSync(join(dangling, '.codex')), join(target, 'missing'));
  assert.ok(!existsSync(join(target, 'missing')), 'a dangling symlink is not followed to create its target');
  assert.ok((await lstat(join(dangling, '.agents'))).isDirectory(), 'the missing one is still created');

  const linked = await temporaryDirectory('codex-linked'), real = await temporaryDirectory('codex-real');
  await symlink(real, join(linked, '.agents'));
  await assert.rejects(launch('codex', linked), refused(join(linked, '.agents')));
  assert.equal(realpathSync(join(linked, '.agents')), realpathSync(real));
  assert.deepEqual(await readdir(real), []);
  assert.ok((await lstat(join(linked, '.codex'))).isDirectory());
});
