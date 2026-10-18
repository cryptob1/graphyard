import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { syncWork } from '../src/cli/workspace.js';
import { scopeRequestCommand, scopeRequestPlanLine } from '../src/cli/session-commands.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { workerBeforePushSection } from '../src/master/worker-fast-gates.js';
import { reworkBriefSection } from '../src/master/rework-brief.js';
import { continueAfterDecline } from '../src/master/runtime-prompt.js';
import { completeCommand } from '../src/cli/complete.js';
import { managedInstructions } from '../src/repository-setup.js';
import { criteriaRuleSection } from '../src/review-threads.js';
import type { CliContext } from '../src/cli/context.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1991: an item's file list is a plan, not a lock. `sync` merges the shared base branch and
// judges only the merge: a commit that changes a file outside plannedFiles that the base holds is
// this branch's change to submit, never a refusal, and `--restore` is no longer offered. A real
// merge conflict is still reported. `scope-request` prints that line and posts nothing. No
// worker-facing text carries the old scope rule any more, and the reviewer's criteria rule says a
// file outside plannedFiles is not a finding by itself.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * A bare origin with a base commit, a worker clone on the item's branch, and the fake control
 * plane `sync` reads the item and the coordination snapshot from. The loop's fetch is performed
 * here, since sync itself fetches nothing: the shared ref is what it merges.
 */
async function repo(label: string) {
  const root = await realpath(await temporaryDirectory(label));
  const origin = join(root, 'origin.git'), main = join(root, 'main'), branch = join(root, 'branch');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'ignore' });
  git(main, 'config', 'user.email', 't@example.com'); git(main, 'config', 'user.name', 'T');
  await writeFile(join(main, 'README.md'), '# Fixture\n');
  await writeFile(join(main, 'planned.ts'), 'export const planned = 0;\n');
  git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base'); git(main, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, branch], { stdio: 'ignore' });
  git(branch, 'config', 'user.email', 't@example.com'); git(branch, 'config', 'user.name', 'T');
  git(branch, 'checkout', '-q', '-b', 'graphyard/gy-9-1');
  const work = { id: 'w9', key: 'GY-9', plannedFiles: ['planned.ts', 'tests/'], workspaces: [{ epoch: 1, host: 'h', path: branch, branch: 'graphyard/gy-9-1' }] };
  const runSync = async () => {
    const printed: any[] = [];
    const context = { command: 'sync', id: work.key, args: [], rest: [work.key], base: 'http://127.0.0.1:1', connection: null,
      api: async (path: string) => {
        if (path === 'status') return { baseBranch: 'main' };
        if (path === 'work-snapshot?view=coordination') return [];
        throw new Error(`unexpected request ${path}`);
      },
      print: (value: unknown) => printed.push(value) } as unknown as CliContext;
    const previous = { cwd: process.cwd(), exitCode: process.exitCode };
    process.exitCode = undefined;
    process.chdir(branch);
    try { await syncWork(context, work); return { printed, exitCode: process.exitCode ?? 0 }; }
    finally { process.chdir(previous.cwd); process.exitCode = previous.exitCode; }
  };
  return { root, main, branch, work, runSync };
}

test('unit:sync-ignores-planned-files — a commit changing a file outside plannedFiles that the base holds merges the base, lists no out-of-scope finding, reports ok, and offers no --restore', async () => {
  const { main, branch, runSync } = await repo('planned-not-lock');
  // The branch changes README.md, a file outside plannedFiles that the base branch holds.
  await writeFile(join(branch, 'README.md'), '# Changed outside the plan\n'); git(branch, 'add', '.'); git(branch, 'commit', '-q', '-m', 'outside the plan');
  // The base branch moves on; the loop fetches the shared store, sync itself fetches nothing.
  await writeFile(join(main, 'base-note.md'), 'from main\n'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base moves'); git(main, 'push', '-q', 'origin', 'main');
  git(branch, 'fetch', '-q', 'origin');
  const { printed, exitCode } = await runSync();
  assert.equal(exitCode, 0, JSON.stringify(printed));
  assert.equal(printed.length, 1);
  assert.equal(printed[0].merged, true, JSON.stringify(printed));
  assert.equal(printed[0].ok, true, 'ok reflects the merge alone');
  assert.equal(printed[0].files, undefined, 'no out-of-scope finding is listed');
  assert.equal(printed[0].refused, undefined, 'nothing is refused');
  assert.ok(!/--restore/.test(printed[0].next), printed[0].next);
  assert.match(printed[0].next, /complete GY-9 EPOCH --head/);
  // The base merged in, with the outside-plan change kept as the worker made it.
  git(branch, 'merge-base', '--is-ancestor', git(main, 'rev-parse', 'HEAD'), 'HEAD');
  assert.equal(git(branch, 'show', 'HEAD:README.md'), '# Changed outside the plan');
  assert.equal(git(branch, 'status', '--porcelain'), '');
});

test('unit:sync-ignores-planned-files — a real merge conflict is still reported', async () => {
  const { main, branch, runSync } = await repo('planned-not-lock-conflict');
  // Both sides edit README.md: a conflict sync cannot judge away.
  await writeFile(join(branch, 'README.md'), '# The branch side\n'); git(branch, 'add', '.'); git(branch, 'commit', '-q', '-m', 'branch side');
  await writeFile(join(main, 'README.md'), '# The base side\n'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base side'); git(main, 'push', '-q', 'origin', 'main');
  git(branch, 'fetch', '-q', 'origin');
  const { printed, exitCode } = await runSync();
  assert.equal(exitCode, 1);
  assert.equal(printed.length, 1);
  assert.equal(printed[0].merged, false);
  assert.deepEqual(printed[0].conflicts.map((entry: any) => entry.path), ['README.md']);
});

test('unit:scope-request-is-a-no-op — scope-request prints that plannedFiles is a plan and posts nothing, with or without --wait', async () => {
  const work = { id: 'w9', key: 'GY-9', epoch: 4 } as any;
  for (const args of [['4'], ['4', 'src/b.ts', '--', 'the reason'], ['4', '--wait'], ['4', 'src/b.ts', '--wait', '--', 'the reason'], ['4', '-']]) {
    const calls: unknown[] = [], printed: unknown[] = [];
    const context = { args, api: async (path: string, data?: unknown) => { calls.push({ path, data }); return {}; }, print: (value: unknown) => printed.push(value) } as unknown as CliContext;
    await scopeRequestCommand.run(context, work);
    assert.deepEqual(calls, [], `${args.join(' ')} posts nothing to the control plane`);
    assert.deepEqual(printed, [scopeRequestPlanLine], `${args.join(' ')} prints the one line`);
  }
  assert.equal(scopeRequestPlanLine, 'plannedFiles is a plan, not a lock: edit the file you need and submit; nothing needs requesting.');
});

test('unit:worker-text-has-no-scope-rules — the worker launch request, before-push text, rework brief, force-push remedy, complete help and the managed AGENTS.md block carry no scope rule, and the reviewer criteria rule says an outside file is not a finding by itself', () => {
  const cli = '/bin/graphyard.mjs';
  const rework = { id: 'd1', reason: 'Fix the flake the review named', approvedAt: new Date(0).toISOString() };
  const texts: [string, string][] = [
    ['the worker launch request', workerPrompt({ cliPath: cli, fastGates: true }, { key: 'GY-1', title: 'Scope' }, { principal: 'p' }, 1)],
    ['the worker launch request without the gates', workerPrompt({ cliPath: cli }, { key: 'GY-1', title: 'Scope' }, { principal: 'p' }, 1)],
    ['the worker launch request of a rework round', workerPrompt({ cliPath: cli, fastGates: true }, { key: 'GY-1', title: 'Scope', submission: { epoch: 1, pr: 7 } as any, pipeline: undefined }, { principal: 'p' }, 2, null, null, null, null, null, rework)],
    ['the worker before-push text', workerBeforePushSection(cli, 'GY-1')],
    ['the rework brief', reworkBriefSection({ submission: { epoch: 1, pr: 57 } as any, pipeline: undefined }, rework)],
    ['the force-push remedy', continueAfterDecline('GY-1', { text: 'git push --force origin graphyard/gy-1-1', answer: 'n' }, null)],
    ['the complete help', completeCommand.help.join(' ')],
    ['the managed AGENTS.md block', managedInstructions('', 'https://graphyard.example')],
  ];
  for (const [name, text] of texts) for (const phrase of ['scope-request', '--restore', 'outside plannedFiles']) {
    assert.ok(!text.includes(phrase), `${name} names ${phrase}`);
  }
  // The reviewer's criteria rule carries the one clause this item adds: judge the change.
  assert.match(criteriaRuleSection('GY-1', 'a'.repeat(40), []), /A change to a file outside plannedFiles is not a finding by itself; judge the change\./);
});
