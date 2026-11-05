import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { completionRerun, rerunTrialFiles } from '../src/cli/complete.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const runner = fileURLToPath(new URL('./helpers/run-tests.ts', import.meta.url));
const selected = 'tests/selected.test.mjs';

test('integration:complete-owned-recheck-scratch — each run owns and cleans its home and sticky scratch, including runner faults', async () => {
  const root = await temporaryDirectory('complete-owned');
  for (const fail of [false, true]) {
    let home = '', scratch = '';
    const result = await rerunTrialFiles(root, [selected], async (_command, args, options) => {
      assert.deepEqual(args.slice(-2), ['--test', selected]);
      assert.equal(options?.cwd, root);
      assert.equal(options?.group, true);
      const env = options!.env!;
      home = env.HOME!; scratch = env.TMPDIR!;
      assert.ok(home.startsWith('/var/tmp/gy-r'));
      assert.ok(home.length < 40);
      assert.ok(statSync(scratch).mode & 0o1000);
      assert.equal(env.TMP, scratch); assert.equal(env.TEMP, scratch);
      assert.equal(env.XDG_CONFIG_HOME, join(home, '.config'));
      assert.equal(env.NODE_TEST_CONTEXT, undefined);
      assert.equal(env.GIT_CONFIG_COUNT, process.env.GIT_CONFIG_COUNT);
      assert.ok(existsSync(home) && existsSync(scratch));
      await writeFile(join(home, 'writable'), 'yes');
      if (fail) throw Object.assign(new Error('runner fault'), { timedOut: true });
      return 'passed';
    });
    assert.equal(result.ok, !fail);
    if (fail) assert.equal(result.timedOut, true);
    assert.equal(existsSync(home), false); assert.equal(existsSync(scratch), false);
    assert.equal(existsSync(join(root, '.graphyard/verify')), false);
  }
});

test('e2e:complete-owned-recheck-scratch — actual CLI under read-only operator HOME reproduces EROFS, then submits a passing exact selection and refuses a genuine failure', async () => {
  const base = await temporaryDirectory('complete-confined');
  const root = join(base, 'work'), operator = join(base, 'operator');
  await mkdir(join(root, 'tests/helpers'), { recursive: true });
  await mkdir(join(operator, '.gy/tmp'), { recursive: true });
  await chmod(join(operator, '.gy/tmp'), 0o1777);
  await writeFile(join(operator, 'sentinel'), 'operator untouched');
  await symlink(fileURLToPath(new URL('../../', import.meta.resolve('tsx'))), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'source.txt'), 'head source');
  await writeFile(join(root, '.gitignore'), 'node_modules\n.graphyard\n*.ran\nfail\nfault\n');
  // Use the real suite runner, including durableTestTmpdir, with a runner that chooses tmpfs
  // scratch first. It must relocate under the runtime HOME rather than the operator HOME.
  await writeFile(join(root, 'tests/helpers/run-tests.ts'), `
import { runTests } from ${JSON.stringify(runner)};
process.env.TMPDIR = '/tmp';
if ((await import('node:fs')).existsSync('fault')) throw new Error('fixture runner could not start');
process.exitCode = (await runTests({ args: process.argv.slice(2) })).code;
`);
  await writeFile(join(root, selected), `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { temporaryDirectory } from ${JSON.stringify(fileURLToPath(new URL('./helpers/temp-dirs.ts', import.meta.url)))};
test('integration:complete-owned-recheck-scratch selected case', async () => {
  // Before the fix, this is the actual EROFS under the read-only operator's .gy/tmp.
  await temporaryDirectory('probe', join(homedir(), '.gy/tmp'));
  assert.notEqual(homedir(), ${JSON.stringify(operator)});
  assert.equal(tmpdir(), join(homedir(), '.gy/tmp'));
  assert.equal(statSync(tmpdir()).uid, process.getuid());
  assert.ok(statSync(tmpdir()).mode & 0o1000, 'owned scratch stays sticky');
  writeFileSync(join(tmpdir(), 'scratch-write-probe'), 'owned writable scratch');
  assert.equal(readFileSync('source.txt', 'utf8'), 'head source');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync('selected.ran', JSON.stringify({ home: homedir(), tmp: tmpdir(), head }));
  assert.equal(existsSync('fail'), false, 'genuine selected failure');
});
`);
  await writeFile(join(root, 'tests/unselected.test.mjs'), `throw new Error('unselected file ran');`);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture head');
  const head = git('rev-parse', 'HEAD');
  const submissions: { epoch: number; head: string; rerunUnjudged?: { note: string } }[] = [];
  const work = {
    id: 'work-1', key: 'GY-1', criteria: [{ proofs: ['integration:complete-owned-recheck-scratch'] }],
    mergeLedger: { refusal: { kind: 'merge', reason: `trial failed: tests ${selected}: integration:complete-owned-recheck-scratch selected case, tests/missing.test.mjs, ../outside.test.mjs` } },
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') return response.end('{}');
    if (request.method === 'GET' && request.url === '/api/work/GY-1') return response.end(JSON.stringify(work));
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.method === 'POST' && request.url === '/api/work/work-1/worker-verification') {
      // The host runner's part, outside the worker's confinement: the trial's rerun of the
      // refused selection on the requested head, answered as the server relays it.
      const input = JSON.parse(body);
      try {
        const rerun = await completionRerun(root, work);
        return response.end(JSON.stringify({ record: { key: 'GY-1', head: input.head, clean: true, at: new Date().toISOString(), ran: [], outstanding: [] }, rerun }));
      } catch (error: any) { response.statusCode = 422; return response.end(JSON.stringify({ error: error.message })); }
    }
    if (request.method === 'POST' && request.url === '/api/work/work-1/submit') {
      submissions.push(JSON.parse(body)); return response.end(JSON.stringify({ key: 'GY-1', submission: { head } }));
    }
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, HOME: operator, TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp',
    GRAPHYARD_URL: `http://127.0.0.1:${(server.address() as any).port}`, GRAPHYARD_TOKEN: 'disposable-worker',
    GRAPHYARD_TOKEN_FILE: undefined, GRAPHYARD_REPOSITORY_ROOT: root, NODE_TEST_CONTEXT: undefined };
  const confined = (args: string[]) => exec('bwrap', ['--ro-bind', '/', '/', '--bind', root, root,
    '--bind', '/var/tmp', '/var/tmp', '--ro-bind', operator, operator, '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-user', '--unshare-pid', '--die-with-parent',
    '--chdir', root, '--', process.execPath, ...args], { cwd: root, env, maxBuffer: 4 * 1024 * 1024 });
  try {
    // The former recheck's unchanged environment fails with the same filesystem refusal.
    await assert.rejects(confined(['--import', 'tsx', 'tests/helpers/run-tests.ts', selected]),
      (error: any) => /EROFS: read-only file system.*mkdtemp/.test(error.stdout + error.stderr));
    const passed = await confined([launcher, 'complete', 'GY-1', '1', '--head', head]);
    assert.equal(JSON.parse(passed.stdout).submission.head, head);
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0], { epoch: 1, head });
    const ran = JSON.parse(await readFile(join(root, 'selected.ran'), 'utf8'));
    assert.equal(ran.head, head);
    assert.equal(existsSync(ran.home), false); assert.equal(existsSync(ran.tmp), false);
    assert.deepEqual(await readdir(join(root, '.graphyard/verify')), ['GY-1.json'], 'only the returned record, never rerun scratch');
    await writeFile(join(root, 'fail'), 'fail');
    await assert.rejects(confined([launcher, 'complete', 'GY-1', '1', '--head', head]),
      (error: any) => /complete refused:.*failing tests still fail/.test(error.stderr) && /genuine selected failure/.test(error.stderr));
    assert.equal(submissions.length, 1, 'a real selected failure must not submit');
    assert.deepEqual(await readdir(join(root, '.graphyard/verify')), ['GY-1.json'], 'only the returned record, never rerun scratch');
    // A runner fault retains the existing unjudged-note policy instead of becoming a pass.
    await writeFile(join(root, 'fault'), 'fault');
    await confined([launcher, 'complete', 'GY-1', '1', '--head', head]);
    assert.equal(submissions.length, 2);
    assert.match(submissions[1]!.rerunUnjudged!.note, /failed without naming a failing case/);
    assert.deepEqual(await readdir(join(root, '.graphyard/verify')), ['GY-1.json'], 'only the returned record, never rerun scratch');
    assert.equal(await readFile(join(operator, 'sentinel'), 'utf8'), 'operator untouched');
    assert.deepEqual(await readdir(join(operator, '.gy/tmp')), []);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
