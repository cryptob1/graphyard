import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceCommands } from '../src/cli/workspace.js';
import type { CliContext } from '../src/cli/context.js';
import { restoreAndReport, restoreOutOfScope } from '../src/cli/sync-restore.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { localScopeFindings } from '../src/sync.js';
import { managedInstructions } from '../src/repository-setup.js';
import { continueAfterDecline } from '../src/master/runtime-prompt.js';

/**
 * GY-859: `graphyard sync --restore` takes the out-of-scope remedy itself — one plain commit on
 * top of the pushed branch — so no worker reaches for a force push.
 */
const planned = ['in-scope.txt'];

/**
 * Runs the real `sync` command from `cwd` with a stub control plane, and returns what it printed and
 * the exit code it set; the process's own cwd and exit code are restored afterwards.
 */
async function runSync(cwd: string, args: string[], work: { key: string; plannedFiles: string[]; workspaces: { branch: string; epoch: number }[] }) {
  const sync = workspaceCommands.find(command => command.name === 'sync');
  assert.ok(sync);
  const printed: any[] = [];
  const context = { command: 'sync', id: work.key, args, rest: [work.key, ...args], base: 'http://127.0.0.1:1', connection: null,
    api: async (path: string) => { if (path === 'status') return { baseBranch: 'main' }; throw new Error(`unexpected request ${path}`); },
    print: (value: unknown) => printed.push(value) } as unknown as CliContext;
  const previous = { cwd: process.cwd(), exitCode: process.exitCode };
  process.exitCode = undefined;
  process.chdir(cwd);
  try { await sync.run(context, work); return { printed, exitCode: process.exitCode ?? 0 }; }
  finally { process.chdir(previous.cwd); process.exitCode = previous.exitCode; }
}

test('unit:sync-restores-out-of-scope — two out-of-scope edits are restored in exactly one commit and a plain push updates the PR', async () => {
  const directory = await temporaryDirectory('sync-restore');
  const origin = join(directory, 'origin.git'), worker = join(directory, 'worker');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: worker, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, worker], { stdio: 'ignore' });
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test'); git('checkout', '--quiet', '-B', 'main');
  await writeFile(join(worker, 'in-scope.txt'), 'in scope\n');
  await writeFile(join(worker, 'shared.txt'), 'base\n');
  await writeFile(join(worker, 'kept.txt'), 'the base holds this\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'Initial'); git('push', '--quiet', 'origin', 'main');

  // The worker's pushed branch carries its in-scope change and two out-of-scope edits — a base
  // file rewritten and a base file deleted — beside a new file, which the scope rule allows.
  git('checkout', '--quiet', '-b', 'graphyard/gy-859-1');
  await writeFile(join(worker, 'in-scope.txt'), 'in scope, changed\n');
  await writeFile(join(worker, 'shared.txt'), 'edited out of scope\n');
  await writeFile(join(worker, 'new.txt'), 'a new file\n');
  git('rm', '--quiet', 'kept.txt');
  git('add', '.'); git('commit', '--quiet', '-m', 'Worker changes'); git('push', '--quiet', 'origin', 'graphyard/gy-859-1');
  const pushed = git('rev-parse', 'HEAD');
  // An unrelated uncommitted edit stays out of the restore commit.
  await writeFile(join(worker, 'in-scope.txt'), 'in scope, still editing\n');

  const baseTip = git('rev-parse', 'refs/remotes/origin/main');
  const diff = () => [git('diff', '--raw', '-M', '-z', '--no-abbrev', baseTip, 'HEAD'), git('diff', '--numstat', '-M', '-z', baseTip, 'HEAD')] as const;
  const [raw, numstat] = diff();
  const refused = localScopeFindings(planned, raw, numstat).filter(finding => finding.refused).map(finding => finding.path).sort();
  assert.deepEqual(refused, ['kept.txt', 'shared.txt']);

  // The shipped command itself (GY-1080): `sync GY-859 --restore` through its command harness, run
  // from the worker's checkout against a control plane that names main as the base.
  const reports = await runSync(worker, ['--restore'], { key: 'GY-859', plannedFiles: planned, workspaces: [{ branch: 'graphyard/gy-859-1', epoch: 1 }] });
  assert.equal(reports.exitCode, 0);
  assert.equal(reports.printed.length, 1);
  const report = reports.printed[0];
  assert.equal(report.ok, true);
  assert.deepEqual(report.restored, ['kept.txt', 'shared.txt']);
  assert.deepEqual(report.refused, []);
  assert.equal(report.head, git('rev-parse', 'HEAD'));
  assert.match(report.next, /plain git push \(a force push is never needed or allowed\)/);

  // Exactly one new commit, on top of the pushed head: history is not rewritten.
  assert.equal(git('rev-list', '--count', `${pushed}..HEAD`), '1');
  assert.equal(git('rev-parse', 'HEAD^'), pushed);
  const message = git('log', '-1', '--format=%B');
  for (const path of refused) assert.match(message, new RegExp(path.replace('.', '\\.')));
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['kept.txt', 'shared.txt']);

  // Only in-scope differences remain against the base.
  const [afterRaw, afterNumstat] = diff();
  const after = localScopeFindings(planned, afterRaw, afterNumstat);
  assert.deepEqual(after.map(finding => [finding.path, finding.kind]).sort(), [['in-scope.txt', 'in-scope'], ['new.txt', 'new']]);
  assert.equal(await readFile(join(worker, 'shared.txt'), 'utf8'), 'base\n');
  assert.equal(await readFile(join(worker, 'kept.txt'), 'utf8'), 'the base holds this\n');
  assert.equal(await readFile(join(worker, 'in-scope.txt'), 'utf8'), 'in scope, still editing\n');

  // A plain push — no --force, no --force-with-lease — updates the remote branch.
  const push = spawnSync('git', ['push', '--quiet', 'origin', 'graphyard/gy-859-1'], { cwd: worker, encoding: 'utf8' });
  assert.equal(push.status, 0, push.stderr);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/graphyard/gy-859-1').split('\t')[0], git('rev-parse', 'HEAD'));

  // Nothing left to restore adds no commit.
  const head = git('rev-parse', 'HEAD');
  assert.deepEqual(restoreOutOfScope(git, baseTip, []), []);
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('unit:sync-restores-out-of-scope — an out-of-scope rename restores the original path', async () => {
  const directory = await temporaryDirectory('sync-restore');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet', '--initial-branch=main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  await writeFile(join(directory, 'old-name.txt'), 'a file long enough to be detected as a rename\n'.repeat(4));
  git('add', '.'); git('commit', '--quiet', '-m', 'Initial');
  const baseTip = git('rev-parse', 'HEAD');
  git('mv', 'old-name.txt', 'new-name.txt'); git('commit', '--quiet', '-m', 'Rename');
  const raw = git('diff', '--raw', '-M', '-z', '--no-abbrev', baseTip, 'HEAD'), numstat = git('diff', '--numstat', '-M', '-z', baseTip, 'HEAD');
  const refused = localScopeFindings(planned, raw, numstat).filter(finding => finding.refused).map(finding => finding.path);
  assert.deepEqual(refused, ['old-name.txt']);
  // The `--restore` branch of sync: restore, classify again, and report a clean branch.
  // The exit code is read from a cleared slate, so an earlier test that set it cannot fail this one (GY-1080).
  const reports: any[] = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let exitCode: typeof process.exitCode;
  try { restoreAndReport(git, report => reports.push(report), { work: { key: 'GY-7', plannedFiles: planned }, baseBranch: 'main', baseTip, regenerated: [], generated: [], refused }); }
  finally { exitCode = process.exitCode; process.exitCode = previousExitCode; }
  assert.equal(exitCode ?? 0, 0);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].ok, true);
  assert.deepEqual(reports[0].restored, ['old-name.txt']);
  assert.deepEqual(reports[0].refused, []);
  assert.match(reports[0].next, /plain git push \(a force push is never needed or allowed\)/);
  assert.equal(git('show', 'HEAD:old-name.txt'), git('show', `${baseTip}:old-name.txt`));
  const after = localScopeFindings(planned, git('diff', '--raw', '-M', '-z', '--no-abbrev', baseTip, 'HEAD'), git('diff', '--numstat', '-M', '-z', baseTip, 'HEAD'));
  assert.ok(after.every(finding => !finding.refused));
});

test('unit:sync-restores-out-of-scope — a refused filename that is valid pathspec magic restores only itself', async () => {
  const directory = await temporaryDirectory('sync-restore');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet', '--initial-branch=main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  const magic = ':(top)**';
  await writeFile(join(directory, magic), 'base\n');
  await writeFile(join(directory, 'in-scope.txt'), 'base\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'Initial');
  const baseTip = git('rev-parse', 'HEAD');
  await writeFile(join(directory, magic), 'edited out of scope\n');
  await writeFile(join(directory, 'in-scope.txt'), 'in scope, changed\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'Worker changes');
  const refused = localScopeFindings(planned, git('diff', '--raw', '-M', '-z', '--no-abbrev', baseTip, 'HEAD'), git('diff', '--numstat', '-M', '-z', baseTip, 'HEAD')).filter(finding => finding.refused).map(finding => finding.path);
  assert.deepEqual(refused, [magic]);

  assert.deepEqual(restoreOutOfScope(git, baseTip, refused), [magic]);
  // As a pathspec `:(top)**` matches every file; read literally it names one, so the in-scope change survives.
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), [magic]);
  assert.equal(await readFile(join(directory, magic), 'utf8'), 'base\n');
  assert.equal(await readFile(join(directory, 'in-scope.txt'), 'utf8'), 'in scope, changed\n');
  assert.equal(git('show', 'HEAD:in-scope.txt'), 'in scope, changed');
});

test('unit:sync-restores-out-of-scope — a refused submodule is restored to the base gitlink in one commit', async () => {
  const directory = await temporaryDirectory('sync-restore');
  const library = join(directory, 'library'), worker = join(directory, 'worker');
  const at = (cwd: string) => (...args: string[]) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const lib = at(library), git = at(worker);
  for (const [cwd, run] of [[library, lib], [worker, git]] as const) {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', cwd]);
    run('config', 'user.email', 'test@example.com'); run('config', 'user.name', 'Test');
  }
  await writeFile(join(library, 'lib.txt'), 'one\n'); lib('add', '.'); lib('commit', '--quiet', '-m', 'One');
  const first = lib('rev-parse', 'HEAD');
  await writeFile(join(library, 'lib.txt'), 'two\n'); lib('commit', '--quiet', '-am', 'Two');
  const second = lib('rev-parse', 'HEAD');
  lib('checkout', '--quiet', first);

  await writeFile(join(worker, 'in-scope.txt'), 'base\n');
  git('submodule', 'add', '--quiet', library, 'vendor/library');
  git('add', '.'); git('commit', '--quiet', '-m', 'Initial');
  const baseTip = git('rev-parse', 'HEAD');
  // The worker moves the submodule out of scope.
  at(join(worker, 'vendor/library'))('checkout', '--quiet', second);
  git('add', 'vendor/library'); git('commit', '--quiet', '-m', 'Bump the library');
  const pushed = git('rev-parse', 'HEAD');
  const refused = localScopeFindings(planned, git('diff', '--raw', '-M', '-z', '--no-abbrev', baseTip, 'HEAD'), git('diff', '--numstat', '-M', '-z', baseTip, 'HEAD')).filter(finding => finding.refused).map(finding => finding.path);
  assert.deepEqual(refused, ['vendor/library']);

  assert.deepEqual(restoreOutOfScope(git, baseTip, refused), ['vendor/library']);
  assert.equal(git('rev-parse', 'HEAD^'), pushed);
  assert.equal(git('rev-parse', 'HEAD:vendor/library'), first);
  assert.equal(at(join(worker, 'vendor/library'))('rev-parse', 'HEAD'), first);
});

test('unit:worker-prompt-names-sync-restore — the worker instructions name sync --restore and rule out a force push', () => {
  const instructions = managedInstructions('', 'https://graphyard.example');
  assert.match(instructions, /sync GY-N --restore/);
  assert.match(instructions, /force push is never needed or\s+allowed/i);

  const sync = workspaceCommands.find(command => command.name === 'sync');
  assert.ok(sync);
  const help = sync.help.join('\n');
  assert.match(help, /sync GY-N --restore/);
  assert.match(help, /force push is never\s+needed or allowed/i);

  // A declined force push is answered with the remedy; any other declined command is not.
  const force = continueAfterDecline('GY-7', { text: 'git push --force-with-lease origin graphyard/gy-7-1 / 1. Yes / 2. No', answer: '2. No' }, '/work/GY-7');
  assert.match(force, /graphyard sync GY-7 --restore/);
  assert.match(force, /force push is never needed or allowed/i);
  const other = continueAfterDecline('GY-7', { text: 'rm -rf build / 1. Yes / 2. No', answer: '2. No' }, '/work/GY-7');
  assert.doesNotMatch(other, /--restore/);
});
