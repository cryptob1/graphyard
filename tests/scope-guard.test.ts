import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MasterConfig, WorkerProfile } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1494: a Claude worker's PreToolUse hook denies an edit complete would refuse as outside
// plannedFiles, naming scope-request, and allows anything it cannot judge. The new exports are
// imported inside each test, so on a base without them the file still loads and each proof fails
// as a test case.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const cliPath = '/srv/graphyard/bin/graphyard.mjs';
const guardCommand = `node ${cliPath} scope-guard GY-9 4`;
const config = { cliPath, repository: 'owner/project', baseBranch: 'main', credentialFile: '/home/op/.config/graphyard/credentials/master.token',
  reviewer: { credentialFile: '/home/op/.config/graphyard/reviewer/reviewer.token' }, repositoryWorktreeRoot: null, run: {} } as unknown as MasterConfig;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** A repository whose origin/main holds the base files, checked out on a worker branch. */
async function fixture(label: string, files: Record<string, string>) {
  const root = await temporaryDirectory(label);
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'config', 'user.email', 'worker@example.com'); git(root, 'config', 'user.name', 'Worker');
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'base');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '--quiet', '-b', 'graphyard/gy-9-4');
  return root;
}
const payload = (tool: string, path: string, cwd: string, input: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: tool,
  tool_input: tool === 'NotebookEdit' ? { notebook_path: path, ...input } : { file_path: path, ...input } });

test('unit:worker-scope-hook-installed — a Claude worker\'s worktree settings and --settings role file each carry one PreToolUse scope-guard hook for its own item and epoch; operator hooks are kept and only Graphyard\'s entry is replaced', async () => {
  const { workerHarnessPlan, sessionHarnessPlan, prepareSessionHarness, installWorkerHarness } = await import('../src/master/harness.js') as any;
  const { writeHarnessPermissions } = await import('../src/harness.js') as any;
  const expected = { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: guardCommand, timeout: 30 }] };
  const plan = workerHarnessPlan({ cliPath, branch: 'graphyard/gy-9-4', baseBranch: 'main', credentialHome: '/home/op/.config/graphyard', key: 'GY-9', epoch: 4 });
  assert.equal(plan.hooks?.length, 1);
  assert.equal(plan.hooks[0].command, guardCommand);

  // The worktree settings: an operator hook and an earlier attempt's guard are already there.
  const worktree = await fixture('scope-guard-hook-worktree', { '.gitignore': '.claude/settings.local.json\n' });
  await mkdir(join(worktree, '.claude'), { recursive: true });
  const operatorHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo operator' }] };
  await writeFile(join(worktree, '.claude/settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [operatorHook, { matcher: 'Edit|Write', hooks: [{ type: 'command', command: `node ${cliPath} scope-guard GY-9 3` }] }],
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo after' }] }] } }));
  await writeHarnessPermissions(worktree, plan, true);
  let written = JSON.parse(await readFile(join(worktree, '.claude/settings.local.json'), 'utf8'));
  assert.deepEqual(written.hooks.PreToolUse, [operatorHook, expected], 'the operator hook is kept and the earlier guard is replaced by this epoch\'s');
  assert.deepEqual(written.hooks.PostToolUse, [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo after' }] }], 'other events are untouched');
  await writeHarnessPermissions(worktree, plan, true);
  written = JSON.parse(await readFile(join(worktree, '.claude/settings.local.json'), 'utf8'));
  assert.equal(written.hooks.PreToolUse.filter((entry: any) => entry.hooks.some((hook: any) => / scope-guard /.test(hook.command))).length, 1, 'writing again leaves one guard');

  // installWorkerHarness, as dispatch calls it, writes the same hook for the prepared epoch.
  const fresh = await fixture('scope-guard-hook-install', { '.gitignore': '.claude/settings.local.json\n' });
  const profile = { name: 'claude-primary', kind: 'claude', agentArgs: [] } as unknown as WorkerProfile;
  await installWorkerHarness(config, profile, 'GY-9', { path: fresh, epoch: 4 });
  const installed = JSON.parse(await readFile(join(fresh, '.claude/settings.local.json'), 'utf8'));
  assert.deepEqual(installed.hooks.PreToolUse, [expected]);

  // The --settings role file of the worker session carries the same single hook.
  const shared = { cliPath, repository: 'owner/project', baseBranch: 'main', credentialHome: '/home/op/.config/graphyard', credentialDirectories: [] };
  assert.deepEqual(sessionHarnessPlan({ ...shared, role: 'worker', kind: 'claude', branch: 'graphyard/gy-9-4', key: 'GY-9', epoch: 4 }).hooks.map((hook: any) => hook.command), [guardCommand]);
  const root = await temporaryDirectory('scope-guard-hook-role');
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(join(root, '.claude', 'settings.local.json'), '{}\n');
  const harness = await prepareSessionHarness(root, config, { role: 'worker', kind: 'claude', profile: 'claude-primary', branch: 'graphyard/gy-9-4', key: 'GY-9', epoch: 4 });
  assert.deepEqual(harness.args, ['--setting-sources', 'user', '--settings', harness.file]);
  const role = JSON.parse(await readFile(harness.file, 'utf8'));
  assert.deepEqual(role.hooks, { PreToolUse: [expected] });
  assert.ok(role.permissions.allow.length > 0, 'the role file keeps its permissions');

  // Other roles carry no guard.
  for (const roleName of ['reviewer', 'producer']) assert.equal(sessionHarnessPlan({ ...shared, role: roleName, kind: 'claude' }).hooks, undefined, roleName);
});

const baseline = (files: Record<string, number>) => `${JSON.stringify({ schema: 1, files }, null, 2)}\n`;

test('unit:scope-guard-parity — the guard allows a path outside the worktree, and inside it allows exactly what classifyScope would not refuse at complete, judged against plannedFiles read at the call', async () => {
  const { scopeGuard } = await import('../src/scope-guard.js') as any;
  const { hostScopeGuardReads } = await import('../src/cli/scope-guard.js') as any;
  const { localScopeFindings } = await import('../src/sync.js');
  const root = await fixture('scope-guard-parity', {
    'src/planned.ts': 'export const a = 1;\n', 'src/area/inside.ts': 'export const b = 1;\n', 'src/other.ts': 'export const c = 1;\n',
    'src/restored.ts': 'export const d = 1;\n', 'docs/index.md': '# Index\n', 'notes/book.ipynb': '{"cells":[]}\n',
    'tests/helpers/timing-baseline.json': baseline({ 'tests/old.test.ts': 100 }),
  });
  const plannedFiles = ['src/planned.ts', 'src/area/', 'tests/own.test.ts'];
  const generated = ['docs/index.md'];
  const item = { key: 'GY-9', plannedFiles, workspaces: [{ path: root, epoch: 4 }] };
  const reads = { ...hostScopeGuardReads({ api: async () => item }, 'GY-9'), generated: async () => generated };
  // Each case: the hook payload, and the content the edit leaves at the path.
  const cases: { name: string; tool: string; path: string; content: string | null; input?: Record<string, unknown> }[] = [
    { name: 'planned file', tool: 'Edit', path: 'src/planned.ts', content: 'export const a = 2;\n' },
    { name: 'inside a planned directory', tool: 'Write', path: 'src/area/inside.ts', content: 'export const b = 2;\n' },
    { name: 'new file inside a planned directory', tool: 'Write', path: 'src/area/new.ts', content: 'export const n = 1;\n' },
    { name: 'unplanned file the base holds', tool: 'Edit', path: 'src/other.ts', content: 'export const c = 2;\n' },
    { name: 'unplanned file, MultiEdit', tool: 'MultiEdit', path: 'src/other.ts', content: 'export const c = 2;\n' },
    { name: 'unplanned new file', tool: 'Write', path: 'src/brand-new.ts', content: 'export const e = 1;\n' },
    { name: 'generated file', tool: 'Edit', path: 'docs/index.md', content: '# Index\n\nmore\n' },
    { name: 'unplanned notebook', tool: 'NotebookEdit', path: 'notes/book.ipynb', content: '{"cells":[1]}\n' },
    { name: 'own test file', tool: 'Write', path: 'tests/own.test.ts', content: 'test;\n' },
    { name: 'timing baseline line of its own test', tool: 'Edit', path: 'tests/helpers/timing-baseline.json', content: baseline({ 'tests/old.test.ts': 100, 'tests/own.test.ts': 20 }) },
    { name: 'write restoring the base version', tool: 'Write', path: 'src/restored.ts', content: 'export const d = 1;\n', input: { content: 'export const d = 1;\n' } },
  ];
  const decisions = new Map<string, string>();
  for (const entry of cases) {
    const result = await scopeGuard({ key: 'GY-9', epoch: 4, cliPath, cwd: root, payload: payload(entry.tool, join(root, entry.path), root, entry.input) }, reads);
    decisions.set(entry.name, result.decision);
  }
  // A relative path is resolved against the payload's cwd.
  assert.equal((await scopeGuard({ key: 'GY-9', epoch: 4, cliPath, cwd: root, payload: payload('Edit', 'src/other.ts', root) }, reads)).decision, 'deny');
  // A path outside the worktree is never the guard's to judge.
  const outside = await temporaryDirectory('scope-guard-outside');
  const away = await scopeGuard({ key: 'GY-9', epoch: 4, cliPath, cwd: root, payload: payload('Write', join(outside, 'scratch.txt'), root) }, reads);
  assert.deepEqual([away.decision, away.exitCode], ['allow', 0]);

  // Apply every edit, then judge the resulting diff as complete (and sync) judge it.
  for (const entry of cases) { await mkdir(dirname(join(root, entry.path)), { recursive: true }); await writeFile(join(root, entry.path), entry.content!); }
  git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'edits');
  const raw = git(root, 'diff', '--raw', '-M', '-z', '--no-abbrev', 'refs/remotes/origin/main', 'HEAD');
  const numstat = git(root, 'diff', '--numstat', '-M', '-z', 'refs/remotes/origin/main', 'HEAD');
  const findings = await localScopeFindings(plannedFiles, raw, numstat, generated, async sha => git(root, 'cat-file', 'blob', sha));
  for (const entry of cases) {
    const refused = findings.some(finding => finding.path === entry.path && finding.refused);
    assert.equal(decisions.get(entry.name), refused ? 'deny' : 'allow', `${entry.name}: the guard ${decisions.get(entry.name)}s and complete ${refused ? 'refuses' : 'accepts'} ${entry.path}`);
  }
  assert.ok([...decisions.values()].includes('deny') && [...decisions.values()].includes('allow'), 'the table holds both outcomes');
});

test('unit:scope-guard-points-to-scope-request — a denial exits 2 with one message naming the path, the item, the exact scope-request command and that complete refuses; once the request is applied the next edit is allowed with no relaunch', async () => {
  const root = await fixture('scope-guard-cli', { 'src/planned.ts': 'a\n', 'src/other.ts': 'b\n' });
  const item = { key: 'GY-9', plannedFiles: ['src/planned.ts'], workspaces: [{ path: root, epoch: 4 }] };
  const server: Server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/work/GY-9' ? item : { error: 'not found' }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const env = { ...process.env, GRAPHYARD_URL: `http://127.0.0.1:${(server.address() as any).port}`, GRAPHYARD_TOKEN: 'worker-token' };
    const guard = (path: string) => new Promise<{ code: number | null; stderr: string }>(done => {
      const child = execFile(process.execPath, [launcher, 'scope-guard', 'GY-9', '4'], { cwd: root, env }, (error, _stdout, stderr) => done({ code: error ? (error as any).code ?? 1 : 0, stderr }));
      child.stdin!.end(payload('Edit', join(root, path), root));
    });
    const denied = await guard('src/other.ts');
    assert.equal(denied.code, 2, denied.stderr);
    assert.equal(denied.stderr.trim().split('\n').length, 1, 'one message');
    assert.match(denied.stderr, /src\/other\.ts/);
    assert.match(denied.stderr, /GY-9/);
    assert.ok(denied.stderr.includes(`node ${launcher} scope-request GY-9 4 src/other.ts --wait -- REASON`), denied.stderr);
    assert.match(denied.stderr, /complete refuses unplanned changes/);
    const planned = await guard('src/planned.ts');
    assert.equal(planned.code, 0, `a planned file is allowed: ${planned.stderr}`);
    // The scope request is applied: the item's plannedFiles now hold the path, and the same hook allows it.
    item.plannedFiles.push('src/other.ts');
    const allowed = await guard('src/other.ts');
    assert.deepEqual([allowed.code, allowed.stderr.trim()], [0, '']);
  } finally { server.close(); }
});

test('unit:scope-guard-fails-open — an item unread within the bound, an unknown item or an unrecognised payload is allowed with the reason on stderr; non-Claude workers get no hook', async () => {
  const { scopeGuard, scopeGuardReadMs } = await import('../src/scope-guard.js') as any;
  const { sessionHarnessPlan, installWorkerHarness, prepareSessionHarness } = await import('../src/master/harness.js') as any;
  assert.equal(scopeGuardReadMs, 5_000);
  const root = await fixture('scope-guard-open', { 'src/other.ts': 'b\n' });
  const reads = { item: () => new Promise(() => {}), toplevel: async () => root, base: async () => 'b\n', generated: async () => [] };
  const edit = payload('Edit', join(root, 'src/other.ts'), root);
  const slow = await scopeGuard({ key: 'GY-9', epoch: 4, cliPath, cwd: root, payload: edit, timeoutMs: 50 }, reads);
  assert.deepEqual([slow.decision, slow.exitCode], ['allow', 0]);
  assert.match(slow.message, /could not be read .*within/);
  const failed = await scopeGuard({ key: 'GY-9', epoch: 4, cliPath, cwd: root, payload: edit }, { ...reads, item: async () => { throw new Error('{"error":"Unknown work item"}'); } });
  assert.deepEqual([failed.decision, failed.exitCode], ['allow', 0]);
  assert.match(failed.message, /Unknown work item/);
  const unreadableBase = await scopeGuard({ key: 'GY-9', epoch: 4, cliPath, cwd: root, payload: edit }, { ...reads, item: async () => ({ key: 'GY-9', plannedFiles: [] }), base: async () => undefined });
  assert.equal(unreadableBase.decision, 'allow');
  for (const text of ['', 'not json', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), JSON.stringify({ tool_name: 'Edit', tool_input: {} })]) {
    const result = await scopeGuard({ key: 'GY-9', epoch: 4, cliPath, cwd: root, payload: text }, { ...reads, item: async () => ({ key: 'GY-9', plannedFiles: [] }) });
    assert.deepEqual([result.decision, result.exitCode], ['allow', 0], text);
    assert.match(result.message, /not a .*hook payload/);
  }
  // The real command against a control plane that never answers allows within its bound.
  const server = createServer(() => { /* never answers */ });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const started = Date.now();
    const env = { ...process.env, GRAPHYARD_URL: `http://127.0.0.1:${(server.address() as any).port}`, GRAPHYARD_TOKEN: 'worker-token' };
    const outcome = await new Promise<{ code: number; stderr: string }>(done => {
      const child = execFile(process.execPath, [launcher, 'scope-guard', 'GY-9', '4'], { cwd: root, env }, (error, _stdout, stderr) => done({ code: error ? (error as any).code ?? 1 : 0, stderr }));
      child.stdin!.end(edit);
    });
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.match(outcome.stderr, /allowed the edit: GY-9 could not be read/);
    assert.ok(Date.now() - started < 20_000, 'answered within the bound');
  } finally { server.closeAllConnections(); server.close(); }

  // Non-Claude worker profiles launch exactly as before: no generated rules, no hook, no role file.
  const shared = { cliPath, repository: 'owner/project', baseBranch: 'main', credentialHome: '/h', credentialDirectories: [] };
  for (const kind of ['codex', 'opencode', 'pi']) {
    const plan = sessionHarnessPlan({ ...shared, role: 'worker', kind, branch: 'graphyard/gy-9-4', key: 'GY-9', epoch: 4 });
    assert.equal(plan.hooks, undefined, kind); assert.equal(plan.file, null, kind);
  }
  const worktree = await fixture('scope-guard-open-codex', { '.gitignore': '.claude/settings.local.json\n' });
  const codex = await installWorkerHarness(config, { name: 'codex', kind: 'codex', agentArgs: [] }, 'GY-9', { path: worktree, epoch: 4 });
  assert.equal(codex.applied, false);
  await assert.rejects(readFile(join(worktree, '.claude/settings.local.json')), /ENOENT/);
  const projectRoot = await temporaryDirectory('scope-guard-open-role');
  await mkdir(join(projectRoot, '.claude'), { recursive: true });
  await writeFile(join(projectRoot, '.claude', 'settings.local.json'), '{}\n');
  const role = await prepareSessionHarness(projectRoot, config, { role: 'worker', kind: 'codex', profile: 'codex', branch: 'graphyard/gy-9-4', key: 'GY-9', epoch: 4 });
  assert.deepEqual([role.file, role.args], [null, []]);
});
