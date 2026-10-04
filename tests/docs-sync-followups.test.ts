import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChild, ChildProcessError, type ChildRun } from '../src/child-runner.js';
import { localConflictPaths } from '../src/docs-sync.js';
import { GitHub } from '../src/github.js';

// GY-1062: follow-ups from the review of GY-566's docs-sync. Each test is named for the proof it produces.

test('unit:docs-sync-conflict-probe-async — the loop\'s conflict probe runs every git call through the asynchronous child runner', async () => {
  const calls: string[][] = [];
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 1);
  const run: ChildRun = async (command, args, options) => {
    calls.push([command, ...args]);
    assert.equal(options?.timeoutMs, 60_000, 'each git call keeps its bound');
    await new Promise(resolve => setTimeout(resolve, 5));
    if (args.includes('merge-tree')) throw new ChildProcessError(command, args, { stdout: 'tree\0docs/a.md\0docs/b.md\0docs/a.md\0', stderr: '', status: 1, signal: null, timedOut: false });
    return '';
  };
  const pending = localConflictPaths('/repo', 'graphyard/gy-1-1', 'h'.repeat(40), 'b'.repeat(40), run);
  assert.ok(pending instanceof Promise, 'the probe returns at once and resolves later');
  assert.deepEqual(await pending, ['docs/a.md', 'docs/b.md']);
  clearInterval(ticker);
  assert.ok(ticks > 0, 'the event loop kept running while the probe waited on git');
  assert.deepEqual(calls.map(call => call[3]), ['fetch', 'fetch', 'cat-file', 'cat-file', 'merge-tree']);
  assert.ok(calls.every(call => call[0] === 'git' && call[1] === '-C' && call[2] === '/repo'));

  const missing: ChildRun = async (command, args) => { if (args.includes('cat-file')) throw new Error('missing'); return ''; };
  assert.equal(await localConflictPaths('/repo', 'b', 'h', 'b', missing), null, 'a commit that cannot be had answers null');
  const clean: ChildRun = async () => '';
  assert.deepEqual(await localConflictPaths('/repo', 'b', 'h', 'b', clean), [], 'a clean merge answers []');
  const failed: ChildRun = async (command, args) => { if (args.includes('merge-tree')) throw new ChildProcessError(command, args, { stdout: '', stderr: 'fatal', status: 128, signal: null, timedOut: false }); return ''; };
  assert.equal(await localConflictPaths('/repo', 'b', 'h', 'b', failed), null, 'a failed probe answers null');
});

test('unit:docs-sync-conflict-probe-git — the probe names the paths git itself reports conflicting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gy-docs-probe-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '--quiet', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
    await writeFile(join(root, 'page.md'), 'one\n'); await writeFile(join(root, 'code.ts'), 'a\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'base');
    git('checkout', '--quiet', '-b', 'item');
    await writeFile(join(root, 'page.md'), 'item\n'); await writeFile(join(root, 'code.ts'), 'item\n');
    git('commit', '--quiet', '-am', 'item');
    const head = git('rev-parse', 'HEAD');
    git('checkout', '--quiet', 'main');
    await writeFile(join(root, 'page.md'), 'main\n');
    git('commit', '--quiet', '-am', 'main');
    const base = git('rev-parse', 'HEAD');
    // No origin exists: the fetches fail and the commits already here serve.
    assert.deepEqual(await localConflictPaths(root, 'item', head, base, runChild), ['page.md'], 'only the path that really conflicts, not every path both sides changed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:docs-sync-patch-id-docs-pages — the kept-approval patch-id leaves out only docs pages, not every file under docs/', async () => {
  const client = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used' });
  const code = { filename: 'src/a.ts', status: 'modified', changes: 1, patch: '@@ -1 +1 @@\n-a\n+b' };
  const page = (text: string) => ({ filename: 'docs/guide.md', status: 'modified', changes: 1, patch: `@@ -1 +1 @@\n-x\n+${text}` });
  const asset = (text: string) => ({ filename: 'docs/data/routes.json', status: 'modified', changes: 1, patch: `@@ -1 +1 @@\n-{}\n+${text}` });
  const compare: Record<string, unknown[]> = {
    'B0...R': [code, page('reviewed'), asset('{"a":1}')],
    'B1...S': [code, page('synced'), asset('{"a":1}')],
    'B1...T': [code, page('synced'), asset('{"a":2}')],
  };
  client.request = async (path: string) => ({ status: 'ahead', files: compare[path.slice('/compare/'.length).split('?')[0]] ?? [] });
  const reviewed = await client.nonDocsPatchId('B0', 'R');
  assert.ok(reviewed);
  assert.equal(await client.nonDocsPatchId('B1', 'S'), reviewed, 'a docs page the sync rewrote does not change the patch-id');
  assert.notEqual(await client.nonDocsPatchId('B1', 'T'), reviewed, 'a non-Markdown file under docs/ the sync changed does');
});
