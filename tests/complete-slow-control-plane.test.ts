import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3330: a control plane slower than the CLI's own request bound (`cliRequestTimeoutMs`, 120 s)
// must not strand a finished head. This case runs the real CLI against a stub plane whose
// idempotency receipts behave like the server's own (src/store/mutations.ts `once`): the first
// request for a key applies the submission, every later one is answered from that record. The
// client's timeout is the real one, so each scenario waits it out once; both run at once to stay
// inside a targeted run's per-file bound.

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const work = { id: 'id-1', key: 'GY-1', stage: 'build', lease: { epoch: 1, owner: 'stub-worker' } };
const submitted = { id: 'id-1', key: 'GY-1', stage: 'review', submission: { epoch: 1, pr: 7 }, lease: null };

/** A committed, clean worktree: what `complete --head` submits is its HEAD. */
async function committedWorktree(label: string) {
  const root = await temporaryDirectory(label);
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  await writeFile(join(root, '.gitignore'), '.graphyard/\n');
  git('add', '.gitignore');
  git('commit', '--quiet', '--allow-empty', '-m', 'the change');
  return { root, head: git('rev-parse', 'HEAD') };
}

/**
 * The control-plane stub for one scenario. `answerAfterMs` answers the first submit — applied and
 * answered by the stub only then, past the client's 120 s bound — while every later submit is
 * answered at once (the first slow answer of the fault). `applyAtOnce` applies the first submit
 * immediately — before the client can time out — and never answers it, so the retry meets a
 * submission already on record.
 */
async function slowPlane(head: string, first: { answerAfterMs: number } | { applyAtOnce: true }) {
  const submissions: { key: string | undefined; body: any }[] = [];
  const receipts = new Map<string, unknown>();
  const applied = { count: 0 };
  // One receipt per idempotency key, as the plane's own `once` keeps them: the first request for a
  // key applies the submission exactly once, and a repeat is answered from the record.
  const answer = (key: string) => {
    if (!receipts.has(key)) { applied.count++; receipts.set(key, submitted); }
    return receipts.get(key);
  };
  let late: NodeJS.Timeout | undefined;
  const server: Server = createServer(async (req, res) => {
    res.on('error', () => {});
    const send = (body: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/healthz') return send({});
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.method === 'GET' && req.url === '/api/work/GY-1') return send(work);
    if (req.method === 'POST' && req.url === '/api/work/id-1/submit') {
      const key = req.headers['idempotency-key'];
      submissions.push({ key: key as string | undefined, body: JSON.parse(raw) });
      if (submissions.length > 1) return send(answer(String(key)));
      if ('applyAtOnce' in first) return void answer(String(key)); // applied now; never answered
      late = setTimeout(() => send(answer(String(key))), first.answerAfterMs); // answered past the client bound
      late.unref();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    submissions, applied,
    close: () => { if (late) clearTimeout(late); return new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); },
  };
}

/** Run the real `complete` against the stub, as a worker's last action, from its own worktree. */
async function completeAgainst(url: string, root: string, head: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: 'stub-worker-token-0123456789abcdef' };
  delete env.GRAPHYARD_TOKEN_FILE; delete env.GRAPHYARD_REQUEST_ID;
  try {
    return await exec(process.execPath, [launcher, 'complete', 'GY-1', '1', '--head', head], { cwd: root, env, timeout: 240_000 });
  } catch (error: any) {
    return assert.fail(`complete exited ${error.code}: ${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
}

async function firstAnswerPastTheClientBound() {
  const { root, head } = await committedWorktree('complete-slow-late');
  const plane = await slowPlane(head, { answerAfterMs: 126_000 });
  try {
    const done = await completeAgainst(plane.url, root, head);
    assert.equal(JSON.parse(done.stdout).submission.pr, 7, 'complete reports the submission');
    assert.equal(plane.submissions.length, 2, 'the first submit went unanswered, so complete sent it again');
    assert.deepEqual(plane.submissions[0], plane.submissions[1], 'both submits repeat one idempotency key and body');
    assert.equal(plane.submissions[0].key, `complete:id-1:1:${head}`, 'the key is the one complete derives for this attempt and head');
    assert.equal(plane.submissions[0].body.head, head);
    assert.equal(plane.applied.count, 1, 'the head was submitted exactly once');
    assert.match(`${done.stdout}\n${done.stderr}`, /retry/, 'the output names the retry');
  } finally { await plane.close(); }
}

async function firstRequestAppliedBeforeTheTimeout() {
  const { root, head } = await committedWorktree('complete-slow-applied');
  const plane = await slowPlane(head, { applyAtOnce: true });
  try {
    const done = await completeAgainst(plane.url, root, head);
    assert.equal(plane.submissions.length, 2, 'the lost answer made complete send the submission again');
    assert.equal(plane.submissions[0].key, plane.submissions[1].key, 'the retry repeats the first request\'s idempotency key');
    assert.equal(plane.applied.count, 1, 'the submission the plane applied before the timeout stays the only one');
    assert.match(`${done.stdout}\n${done.stderr}`, /already recorded/, 'the retry reports the submission as already recorded');
    assert.equal(JSON.parse(done.stdout).submission.pr, 7);
  } finally { await plane.close(); }
}

test('e2e:complete-slow-control-plane — complete retries a submission a slow control plane did not answer: one late answer, one already applied, each submitted exactly once under one key', async () => {
  const scenario = (label: string, run: () => Promise<void>) => run().catch(error => assert.fail(`${label}: ${error?.stack ?? error}`));
  await Promise.all([
    scenario('the first answer past the client bound', firstAnswerPastTheClientBound),
    scenario('the first request applied before the timeout', firstRequestAppliedBeforeTheTimeout),
  ]);
});
