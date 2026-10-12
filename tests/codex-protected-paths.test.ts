import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readlinkSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchPlan, nonInteractiveLaunch } from '../src/harness.js';
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

  // A file and a symlink (one dangling) in their places are left exactly as they are.
  const occupied = await temporaryDirectory('codex-occupied'), target = await temporaryDirectory('codex-target');
  await writeFile(join(occupied, '.agents'), 'a file\n');
  await symlink(join(target, 'missing'), join(occupied, '.codex'));
  await launch('codex', occupied);
  assert.ok((await lstat(join(occupied, '.agents'))).isFile());
  assert.equal(readFileSync(join(occupied, '.agents'), 'utf8'), 'a file\n');
  assert.ok((await lstat(join(occupied, '.codex'))).isSymbolicLink());
  assert.equal(readlinkSync(join(occupied, '.codex')), join(target, 'missing'));
  assert.ok(!existsSync(join(target, 'missing')), 'a dangling symlink is not followed to create its target');

  const linked = await temporaryDirectory('codex-linked'), real = await temporaryDirectory('codex-real');
  await symlink(real, join(linked, '.agents'));
  await launch('codex', linked);
  assert.equal(realpathSync(join(linked, '.agents')), realpathSync(real));
  assert.deepEqual(await readdir(real), []);
  assert.ok((await lstat(join(linked, '.codex'))).isDirectory());
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
