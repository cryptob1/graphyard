import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewStandard } from '../src/reviewer.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1987: the worker never saw the standard the independent reviewer judges it by, so a blocking
// finding cost a whole build, test and review round. `graphyard review self GY-N` prints that
// standard — the same reviewStandard text the reviewer's launch request is built from — for this
// worktree's HEAD against its merge-base with the item's base branch, prefixed with the one
// instruction to fix every finding the worker would mark BLOCKING before complete. It is a read:
// it exits 0, runs no model, posts nothing and records nothing. One case per proof:
// unit:review-self-prints-standard proves AC-2. AC-1 (the request text shared with the reviewer)
// is proved in tests/review-verdict.test.ts, AC-3 (the worker request naming the command) in
// tests/worker-prompt-gates.test.ts.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
// The second criterion declares a post-deploy verification (GY-1660): the standard the reviewer
// judges by gains the post-deploy rule, so review self must print it too — the worker on such an
// item judges its own diff by the same pre-merge evidence rule, never by a standard without it.
const criteria = [{ id: 'AC-1', text: 'The feature ships behind its setting', proofs: ['unit:feature'] }, { id: 'AC-2', text: 'The restarted loop serves the change', proofs: ['manual:post-deploy/loop-serves-change'] }];
const documentation = { id: 'DOCS' as const, text: 'Documentation reflects this change: the diff updates this repository\'s documentation for any user-visible behaviour it changes, or the worker states at submission that it alters no documented behaviour.', paths: ['docs/', 'README.md', 'AGENTS.md'], changelog: null };
const plannedFiles = ['src/feature.ts', 'docs/feature.md'];

test('unit:review-self-prints-standard — review self prints the reviewer standard for HEAD against the base merge-base, exits 0 and issues only reads', async t => {
  const work = await temporaryDirectory('review-self');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: work, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  // A local history with a fetched base: main, its origin/main ref, and a worker branch one commit ahead.
  git('init', '-b', 'main');
  git('config', 'user.email', 'worker@example.com');
  git('config', 'user.name', 'Worker');
  writeFileSync(join(work, 'README.md'), 'base\n');
  git('add', '--', 'README.md');
  git('commit', '--no-gpg-sign', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  git('checkout', '-b', 'graphyard/gy-1-1');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'feature.ts'), 'export const feature = 1;\n');
  git('add', '--', 'src/feature.ts');
  git('commit', '--no-gpg-sign', '-m', 'feature');
  const head = git('rev-parse', 'HEAD');

  // The fake control plane answers exactly what the command reads and records every request, so the
  // test can hold it to reads only.
  const requests: { method: string; path: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? 'GET', path: request.url ?? '/' });
    const body = request.url === '/api/status' ? { baseBranch: 'main' }
      : request.url === '/api/work/GY-1' ? {
        key: 'GY-1', title: 'Ship the feature', criteria, plannedFiles, documentation,
      } : {};
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  // The command runs as a spawned child while this process's event loop keeps serving the fake
  // control plane — a synchronous spawn would block the very server the child waits on.
  const child = spawn(process.execPath, [launcher, 'review', 'self', 'GY-1'], {
    cwd: work,
    env: { ...process.env, GRAPHYARD_URL: `http://127.0.0.1:${port}`, GRAPHYARD_TOKEN: 'g'.repeat(40) },
  });
  t.after(() => child.kill());
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let out = '', err = '';
    child.stdout.on('data', chunk => out += chunk);
    child.stderr.on('data', chunk => err += chunk);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: out, stderr: err }));
  });
  assert.equal(code, 0, `review self exits 0: ${stderr}`);
  const run = { status: code, stdout, stderr };
  assert.equal(run.status, 0, `review self exits 0: ${run.stderr}`);
  assert.ok(run.stdout.includes('Judge your own diff exactly as the independent reviewer will; fix every finding you would mark BLOCKING before you run complete.'), 'the printout opens with the one instruction');
  // The standard for this exact head and merge-base, criteria and obligation as the item holds them,
  // with the worktree's own (empty) set of verification maps.
  const standard = reviewStandard({ key: 'GY-1', head, base }, criteria, { obligation: documentation, files: null }, { maps: [], plannedFiles });
  assert.ok(run.stdout.includes(standard), 'the printout is reviewStandard for HEAD against the merge-base');
  assert.ok(run.stdout.includes(`[AC-1] ${criteria[0]!.text}`), 'the item\'s criterion is named by ID and text');
  assert.ok(run.stdout.includes(`[AC-2] ${criteria[1]!.text}`), 'the declared post-deploy criterion is named by ID and text too');
  assert.ok(run.stdout.includes('is a declared post-deploy verification'), 'the post-deploy rule is in the printed standard, so the worker judges the declared criterion on pre-merge evidence');
  assert.ok(run.stdout.includes(`[DOCS] ${documentation.text}`), 'the documentation obligation is judged beside the criteria');
  assert.ok(run.stdout.includes(`git diff ${base} ${head}`), 'the diff to read is HEAD against the merge-base with origin/main');
  assert.deepEqual(requests.map(entry => entry.method), requests.map(() => 'GET'), 'every request the command makes is a read');
  assert.deepEqual(requests.map(entry => entry.path).sort(), ['/api/status', '/api/work/GY-1', '/healthz'], 'it reads the item, the base branch and nothing else');
});
