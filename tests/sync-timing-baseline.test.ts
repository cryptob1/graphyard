import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { changedTestFiles, resolveTimingBaseline, timingBaselineCompanion, timingBaselinePath } from '../src/model/timing-companion.js';
import { hasConflictMarkers, parseLocalScopeDiff } from '../src/sync.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(repositoryRoot, 'bin/graphyard.mjs');
const regeneratedEntry = `${timingBaselinePath} (the base tip's file with this branch's own test-file lines)`;

// A minimal baseline exactly as the repository writes it: JSON.stringify(…, null, 2) with a trailing
// newline — the one shape a conflicted sync resolves by itself. Key order is write order: the base
// tip's lines keep their places, a branch's new line is appended, as scripts/ci-tests.mjs merges.
const baseline = (files: Record<string, number>) => `${JSON.stringify({ schema: 1, files }, null, 2)}\n`;

/** Rewrites one baseline line on a side, the way a worker's own commit records a duration. */
const writeLine = async (cwd: string, testPath: string, duration: number) => {
  const file = join(cwd, timingBaselinePath), value = JSON.parse(await readFile(file, 'utf8'));
  value.files[testPath] = duration;
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

// A small repository whose merge base records three test files in the baseline, an origin, and a
// workspace branch; no generated-files declaration, so only the baseline resolution is exercised.
// The fixture lives under the repository's ignored .graphyard rather than the host's temporary
// directory: a tmp reclaim pass that cannot see this run's owner through the sandbox's pid
// namespace takes a marked graphyard-* directory at once, however young, and the CLI children
// these tests spawn would lose their working directory under it mid-test.
async function fixtureRepository() {
  const parent = join(repositoryRoot, '.graphyard/tmp');
  await mkdir(parent, { recursive: true });
  const root = await temporaryDirectory('sync-timing', parent);
  const origin = join(root, 'origin.git'), main = join(root, 'main'), branch = join(root, 'branch');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'ignore' });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const cwd of [main]) { git(cwd, 'config', 'user.email', 't@example.com'); git(cwd, 'config', 'user.name', 'T'); }
  await mkdir(join(main, 'tests/helpers'), { recursive: true });
  await writeFile(join(main, timingBaselinePath), baseline({ 'tests/alpha.test.ts': 100, 'tests/beta.test.ts': 100, 'tests/omega.test.ts': 100 }));
  git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base'); git(main, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, branch], { stdio: 'ignore' }); git(branch, 'config', 'user.email', 't@example.com'); git(branch, 'config', 'user.name', 'T');
  git(branch, 'checkout', '-q', '-b', 'graphyard/gy-1-1');
  const addTest = async (cwd: string, name: string, duration: number) => {
    await writeFile(join(cwd, `tests/${name}`), `import { test } from 'node:test';\n\ntest('${name}', () => {});\n`);
    await writeLine(cwd, `tests/${name}`, duration);
  };
  return { root, main, branch, git, addTest };
}

async function fakeServer(work: () => Work[]) {
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') return res.end(JSON.stringify({ actor: { id: 'worker-a', role: 'worker' }, baseBranch: 'main' }));
    if (req.url === '/api/work-snapshot') return res.end(JSON.stringify({ now: new Date().toISOString(), work: work() }));
    // The item a command names is read alone (GY-1377).
    const single = /^\/api\/work\/([^/]+)$/.exec(req.url ?? '');
    res.end(JSON.stringify(single ? work().find(item => item.id === decodeURIComponent(single[1]) || item.key === decodeURIComponent(single[1])) : work()));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}`, GRAPHYARD_TOKEN: 'test-only' };
  for (const name of ['GRAPHYARD_TOKEN_FILE', 'GRAPHYARD_REQUEST_ID', 'HERDR_ENV', 'GRAPHYARD_HERDR_AGENT_KIND', 'GRAPHYARD_GENERATED_FILES']) delete env[name];
  return { env, close: () => new Promise<void>(resolve => http.close(() => resolve())) };
}

// The loop fetches the shared object store before each sync; sync itself fetches nothing.
const sync = (cwd: string, env: NodeJS.ProcessEnv) => exec('git', ['fetch', '-q', '--no-tags', 'origin'], { cwd }).then(() => exec(process.execPath, [launcher, 'sync', 'GY-1'], { cwd, env })).then(result => ({ code: 0, output: JSON.parse(result.stdout) }), (error: any) => ({ code: error.code as number, output: JSON.parse(error.stdout) }));

test('unit:sync-resolves-timing-baseline-conflict — the resolver writes the base tip\u2019s file plus only the branch\u2019s own test-file lines, dropping foreign edits', () => {
  const base = baseline({ 'tests/alpha.test.ts': 100, 'tests/beta.test.ts': 150, 'tests/omega.test.ts': 100 });
  const branch = baseline({ 'tests/alpha.test.ts': 999, 'tests/beta.test.ts': 100, 'tests/mid-branch.test.ts': 500, 'tests/omega.test.ts': 100 });
  const files = [{ path: 'tests/mid-branch.test.ts', status: 'added' as const }, { path: 'src/cli/workspace.ts', status: 'modified' as const }];
  const resolved = resolveTimingBaseline(base, branch, files);
  assert.equal(resolved, baseline({ 'tests/alpha.test.ts': 100, 'tests/beta.test.ts': 150, 'tests/omega.test.ts': 100, 'tests/mid-branch.test.ts': 500 }), 'the branch\u2019s own line is appended; the foreign source file is ignored');
  assert.equal(timingBaselineCompanion(base, resolved!, ['tests/mid-branch.test.ts']).allowed, true);
  // A deletion or rename by the branch removes the old line; an unparseable or differently
  // formatted side leaves the conflict for the worker.
  const moved = [{ path: 'tests/mid-branch.test.ts', status: 'added' as const }, { path: 'tests/beta.test.ts', status: 'removed' as const }];
  assert.equal(resolveTimingBaseline(base, branch, moved), baseline({ 'tests/alpha.test.ts': 100, 'tests/omega.test.ts': 100, 'tests/mid-branch.test.ts': 500 }));
  const renamed = resolveTimingBaseline(base, baseline({ 'tests/alpha.test.ts': 100, 'tests/mid-branch.test.ts': 500, 'tests/omega.test.ts': 100 }), [{ path: 'tests/mid-branch.test.ts', previousPath: 'tests/beta.test.ts', status: 'renamed' as const }]);
  assert.equal(renamed, baseline({ 'tests/alpha.test.ts': 100, 'tests/omega.test.ts': 100, 'tests/mid-branch.test.ts': 500 }));
  assert.equal(resolveTimingBaseline('<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> origin/main\n', branch, files), null, 'conflict markers do not parse');
  assert.equal(resolveTimingBaseline(base, branch, []), base, 'no own test files: the base tip\u2019s file is kept byte-for-byte');
  assert.equal(resolveTimingBaseline(JSON.stringify({ schema: 1, files: {} }), branch, files), null, 'a base tip this writer does not emit is left for the worker');
});

test('unit:sync-resolves-timing-baseline-conflict \u2014 the base and the branch each add a test file\u2019s line next to each other: sync resolves the baseline itself, commits, and the guard passes', async () => {
  const { root, main, branch, git, addTest } = await fixtureRepository();
  const item = { id: 'w1', key: 'GY-1', stage: 'build', ready: true, plannedFiles: ['tests/mid-branch.test.ts', timingBaselinePath], dependencies: [], workspaces: [{ epoch: 1, host: 'h', path: branch, branch: 'graphyard/gy-1-1' }], observation: null, submission: null } as unknown as Work;
  const server = await fakeServer(() => [item]);
  try {
    // Both sides insert a line at the same sorted position of the shared files map, so git conflicts.
    await addTest(branch, 'mid-branch.test.ts', 500);
    git(branch, 'add', '.'); git(branch, 'commit', '-q', '-m', 'branch adds its test');
    await addTest(main, 'mid-main.test.ts', 300);
    git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'main adds its test'); git(main, 'push', '-q', 'origin', 'main');
    git(branch, 'fetch', '-q', 'origin');
    assert.throws(() => git(branch, 'merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', 'origin/main'), (error: any) => /timing-baseline/.test(error.stdout), 'git itself reports the baseline conflict');
    const result = await sync(branch, server.env);
    assert.equal(result.code, 0, JSON.stringify(result.output));
    assert.equal(result.output.merged, true); assert.equal(result.output.ok, true);
    assert.deepEqual(result.output.regenerated, [regeneratedEntry]);
    assert.deepEqual(result.output.files.map((entry: any) => [entry.path, entry.kind]), [[timingBaselinePath, 'in-scope'], ['tests/mid-branch.test.ts', 'in-scope']]);
    assert.equal(git(branch, 'status', '--porcelain'), '', 'the merge is committed');
    assert.equal(git(branch, 'rev-list', '--merges', '--count', 'HEAD'), '1');
    // The merged file holds the base tip's file plus exactly the branch's own test-file line, and
    // passes timingBaselineCompanion against the base tip with the candidate's own test files.
    const baseText = execFileSync('git', ['-C', branch, 'show', `origin/main:${timingBaselinePath}`], { encoding: 'utf8' });
    const mergedText = await readFile(join(branch, timingBaselinePath), 'utf8');
    assert.ok(!hasConflictMarkers(mergedText));
    assert.deepEqual(JSON.parse(mergedText), { schema: 1, files: { 'tests/alpha.test.ts': 100, 'tests/beta.test.ts': 100, 'tests/mid-main.test.ts': 300, 'tests/mid-branch.test.ts': 500, 'tests/omega.test.ts': 100 } });
    const candidate = parseLocalScopeDiff(git(branch, 'diff', '--raw', '-M', '-z', '--no-abbrev', 'origin/main', 'HEAD'), '');
    assert.deepEqual(changedTestFiles(candidate), ['tests/mid-branch.test.ts']);
    assert.equal(timingBaselineCompanion(baseText, mergedText, changedTestFiles(candidate)).allowed, true);
    // A second sync with nothing to merge changes nothing.
    const again = await sync(branch, server.env);
    assert.equal(again.code, 0); assert.deepEqual(again.output.regenerated, []); assert.equal(git(branch, 'rev-list', '--count', 'HEAD'), '4');
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('unit:sync-timing-baseline-keeps-other-conflicts \u2014 sync resolves only the baseline: a line altered for another test file keeps the base tip\u2019s value, and every other conflict is reported as today', async () => {
  const { root, main, branch, git, addTest } = await fixtureRepository();
  const item = { id: 'w1', key: 'GY-1', stage: 'build', ready: true, plannedFiles: ['tests/mid-branch.test.ts', timingBaselinePath, 'docs/notes.md'], dependencies: [], workspaces: [{ epoch: 1, host: 'h', path: branch, branch: 'graphyard/gy-1-1' }], observation: null, submission: null } as unknown as Work;
  const shipped = { id: 'w9', key: 'GY-9', stage: 'done', plannedFiles: ['docs/notes.md'], workspaces: [], delivery: { mergeSha: '', mergedAt: '' } } as unknown as Work;
  const server = await fakeServer(() => [item, shipped]);
  try {
    // The branch adds its own test file and line, alters a foreign line (alpha, a file it does not
    // touch), and edits docs/notes.md; main adds a different test file's line, rebalances beta, and
    // edits the same line of docs/notes.md, which nobody can regenerate.
    await addTest(branch, 'mid-branch.test.ts', 500);
    await writeLine(branch, 'tests/alpha.test.ts', 999);
    await mkdir(join(branch, 'docs'), { recursive: true }); await writeFile(join(branch, 'docs/notes.md'), 'branch note\n');
    git(branch, 'add', '.'); git(branch, 'commit', '-q', '-m', 'branch edits');
    await mkdir(join(main, 'docs'), { recursive: true }); await writeFile(join(main, 'docs/notes.md'), 'main note\n');
    await addTest(main, 'mid-main.test.ts', 300);
    await writeLine(main, 'tests/beta.test.ts', 150);
    git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'main edits'); git(main, 'push', '-q', 'origin', 'main');
    (shipped as any).delivery.mergeSha = git(main, 'rev-parse', 'HEAD');
    const first = await sync(branch, server.env);
    assert.equal(first.code, 1); assert.equal(first.output.merged, false);
    assert.deepEqual(first.output.conflicts, [{ path: 'docs/notes.md', generated: false, shippedBy: ['GY-9'], landedSince: true }], 'the other conflict is reported exactly as today, naming the item that landed it');
    assert.deepEqual(first.output.regenerated, [regeneratedEntry], 'the baseline alone was resolved');
    const staged = await readFile(join(branch, timingBaselinePath), 'utf8');
    assert.ok(!hasConflictMarkers(staged));
    assert.deepEqual(JSON.parse(staged).files, { 'tests/alpha.test.ts': 100, 'tests/beta.test.ts': 150, 'tests/mid-main.test.ts': 300, 'tests/mid-branch.test.ts': 500, 'tests/omega.test.ts': 100 },
      'the branch\u2019s foreign 999 is dropped for the base tip\u2019s 100; main\u2019s rebalance and addition stand; the branch\u2019s own line is applied');
    // The worker resolves the remaining conflict and reruns sync: it finishes the merge.
    await writeFile(join(branch, 'docs/notes.md'), 'resolved note\n');
    git(branch, 'add', 'docs/notes.md');
    const second = await sync(branch, server.env);
    assert.equal(second.code, 0, JSON.stringify(second.output)); assert.equal(second.output.merged, true); assert.equal(second.output.ok, true);
    assert.equal(git(branch, 'status', '--porcelain'), ''); assert.equal(git(branch, 'rev-list', '--merges', '--count', 'HEAD'), '1');
    assert.deepEqual(JSON.parse(await readFile(join(branch, timingBaselinePath), 'utf8')).files, { 'tests/alpha.test.ts': 100, 'tests/beta.test.ts': 150, 'tests/mid-main.test.ts': 300, 'tests/mid-branch.test.ts': 500, 'tests/omega.test.ts': 100 });
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('unit:sync-resolves-timing-baseline-conflict — a gap-fill line the branch added for a test file neither the merge base nor the base tip records is kept, and a line whose test file the merge result no longer holds is dropped', () => {
  const mergeBase = baseline({ 'tests/alpha.test.ts': 100, 'tests/beta.test.ts': 100 });
  const base = baseline({ 'tests/alpha.test.ts': 120, 'tests/beta.test.ts': 100 });
  const branch = baseline({ 'tests/alpha.test.ts': 100, 'tests/beta.test.ts': 300, 'tests/unrecorded.test.ts': 40, 'tests/mid-branch.test.ts': 500 });
  const files = [{ path: 'tests/mid-branch.test.ts', status: 'added' as const }, { path: 'tests/beta.test.ts', status: 'modified' as const }];
  const resolved = resolveTimingBaseline(base, branch, files, { mergeBase });
  assert.equal(resolved, baseline({ 'tests/alpha.test.ts': 120, 'tests/beta.test.ts': 300, 'tests/mid-branch.test.ts': 500, 'tests/unrecorded.test.ts': 40 }), 'the gap fill for an existing, unrecorded test stands beside the branch’s own lines');
  assert.equal(timingBaselineCompanion(base, resolved!, changedTestFiles(files)).allowed, true, 'the companion rule allows the gap fill');
  // The base deleted beta, and the worker kept the deletion: its line goes, whatever the branch wrote.
  const kept = resolveTimingBaseline(baseline({ 'tests/alpha.test.ts': 120 }), branch, files, { mergeBase, exists: path => path !== 'tests/beta.test.ts' });
  assert.equal(kept, baseline({ 'tests/alpha.test.ts': 120, 'tests/mid-branch.test.ts': 500, 'tests/unrecorded.test.ts': 40 }));
});

test('unit:sync-timing-baseline-keeps-other-conflicts — a test file the base deleted and the branch changed holds the baseline in conflict beside it; once the worker keeps the deletion, the rerun resolves the baseline with no line for the deleted test', async () => {
  const { root, main, branch, git, addTest } = await fixtureRepository();
  const item = { id: 'w1', key: 'GY-1', stage: 'build', ready: true, plannedFiles: ['tests/gone.test.ts', timingBaselinePath], dependencies: [], workspaces: [{ epoch: 1, host: 'h', path: branch, branch: 'graphyard/gy-1-1' }], observation: null, submission: null } as unknown as Work;
  const server = await fakeServer(() => [item]);
  try {
    await addTest(main, 'gone.test.ts', 200);
    git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'main adds gone'); git(main, 'push', '-q', 'origin', 'main');
    git(branch, 'pull', '-q', 'origin', 'main');
    // The branch changes the test and its line; main deletes both and adds a neighbouring line.
    await writeFile(join(branch, 'tests/gone.test.ts'), `import { test } from 'node:test';\n\ntest('gone, changed', () => {});\n`);
    await writeLine(branch, 'tests/gone.test.ts', 900);
    git(branch, 'add', '.'); git(branch, 'commit', '-q', '-m', 'branch changes gone');
    git(main, 'rm', '-q', 'tests/gone.test.ts');
    const file = join(main, timingBaselinePath), value = JSON.parse(await readFile(file, 'utf8'));
    delete value.files['tests/gone.test.ts']; value.files['tests/gamma.test.ts'] = 50;
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'main deletes gone'); git(main, 'push', '-q', 'origin', 'main');
    const first = await sync(branch, server.env);
    assert.equal(first.code, 1); assert.equal(first.output.merged, false);
    assert.deepEqual(first.output.conflicts.map((entry: any) => entry.path).sort(), ['tests/gone.test.ts', timingBaselinePath], 'the baseline waits beside its conflicted test');
    assert.deepEqual(first.output.regenerated, []);
    // The worker keeps the base's deletion and reruns sync: the baseline is resolved against it.
    git(branch, 'rm', '-q', 'tests/gone.test.ts');
    const second = await sync(branch, server.env);
    assert.equal(second.code, 0, JSON.stringify(second.output)); assert.equal(second.output.merged, true);
    assert.deepEqual(second.output.regenerated, [regeneratedEntry]);
    assert.equal(git(branch, 'status', '--porcelain'), '');
    assert.deepEqual(JSON.parse(await readFile(join(branch, timingBaselinePath), 'utf8')).files, { 'tests/alpha.test.ts': 100, 'tests/beta.test.ts': 100, 'tests/omega.test.ts': 100, 'tests/gamma.test.ts': 50 }, 'no line remains for the deleted test');
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
