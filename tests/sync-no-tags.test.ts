import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceCommands } from '../src/cli/workspace.js';
import type { CliContext } from '../src/cli/context.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1320: the confined worker sandbox leaves the common Git directory's `refs/tags` read-only, and
 * every release candidate publishes a new tag, so a fetch that follows tags fails sync. Sync's
 * fetch passes `--no-tags`, so a tag published after the last fetch never reaches the worker.
 */
test('unit:sync-fetch-ignores-new-tags — a tag published on origin never fails sync when refs/tags is read-only', async () => {
  const directory = await temporaryDirectory('sync-no-tags');
  const origin = join(directory, 'origin.git'), worker = join(directory, 'worker'), publisher = join(directory, 'publisher');
  const gitIn = (cwd: string) => (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = gitIn(worker);
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, worker], { stdio: 'ignore' });
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test'); git('checkout', '--quiet', '-B', 'main');
  await writeFile(join(worker, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'Initial'); git('push', '--quiet', 'origin', 'main');
  git('checkout', '--quiet', '-b', 'graphyard/gy-1320-1');
  await writeFile(join(worker, 'work.txt'), 'the worker change\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'Worker change');

  // The base moves on and a release candidate tags the new tip, as the RC pipeline does hourly.
  execFileSync('git', ['clone', '--quiet', origin, publisher], { stdio: 'ignore' });
  const publish = gitIn(publisher);
  publish('config', 'user.email', 'test@example.com'); publish('config', 'user.name', 'Test');
  await writeFile(join(publisher, 'landed.txt'), 'landed on the base\n');
  publish('add', '.'); publish('commit', '--quiet', '-m', 'Landed');
  publish('tag', 'rc/20261005T145542Z'); publish('push', '--quiet', 'origin', 'main', 'refs/tags/rc/20261005T145542Z');
  const landed = publish('rev-parse', 'HEAD');

  // As in the sandbox, the worker may not create a tag: refs/tags is read-only.
  const tags = join(worker, '.git', 'refs', 'tags');
  await mkdir(tags, { recursive: true });
  await chmod(tags, 0o555);
  const sync = workspaceCommands.find(command => command.name === 'sync');
  assert.ok(sync);
  const printed: any[] = [];
  const context = { command: 'sync', id: 'GY-1320', args: [], rest: ['GY-1320'], base: 'http://127.0.0.1:1', connection: null,
    api: async (path: string) => { if (path === 'status') return { baseBranch: 'main' }; throw new Error(`unexpected request ${path}`); },
    print: (value: unknown) => printed.push(value) } as unknown as CliContext;
  const previous = { cwd: process.cwd(), exitCode: process.exitCode };
  process.exitCode = undefined;
  process.chdir(worker);
  let exitCode: number | string | undefined;
  try { await sync.run(context, { key: 'GY-1320', plannedFiles: ['work.txt'], workspaces: [{ branch: 'graphyard/gy-1320-1', epoch: 1 }] }); }
  finally { exitCode = process.exitCode; process.chdir(previous.cwd); process.exitCode = previous.exitCode; await chmod(tags, 0o755); }

  assert.equal(exitCode ?? 0, 0, JSON.stringify(printed));
  assert.equal(printed.length, 1);
  assert.equal(printed[0].ok, true, JSON.stringify(printed[0]));
  // The base was fetched and merged, and the new tag was never fetched.
  assert.equal(git('rev-parse', 'refs/remotes/origin/main'), landed);
  assert.equal(execFileSync('git', ['merge-base', '--is-ancestor', landed, 'HEAD'], { cwd: worker }).length, 0);
  assert.equal(git('tag', '--list'), '');
});
