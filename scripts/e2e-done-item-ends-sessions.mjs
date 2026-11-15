// GY-3388: a done item records no running session. One fixture item is driven through the real
// flight — claim, a running implementation session handle, submit, an independent review, the merge
// writer's trial, the push and its reconciliation — against the scratch control plane
// scripts/e2e-serve.mjs hosts. The worker's session is still recorded running when the item is
// delivered, as GY-3317's was; the delivered item then lists no running session, and the count
// master status shows for workers (src/cli/master-status.ts, over the same work-snapshot) leaves it out.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun } from '../src/child-runner.ts';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.ts';
import { mergeOne } from '../src/merge-writer/executor.ts';
import { scratchTrial } from './e2e-delivery-fixture.mjs';

const [token, run] = process.argv.slice(2), url = process.env.TARGET_URL;
assert.ok(token && run && url, 'Run this case through the E2E runner against scripts/e2e-serve.mjs');
const { delivery } = JSON.parse(await readFile('.graphyard/e2e-serve.json', 'utf8'));
const { root, origin, workerToken, coordinatorToken } = delivery;
const git = async (...args) => (await defaultChildRun('git', ['-C', root, ...args])).trim();
const call = async (path, credential, body) => {
  const response = await fetch(new URL(`/api/${path}`, url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
  return result;
};
const title = `E2E case done-item-ends-sessions run ${run}`;

let item = await call('work', token, {
  title, type: 'chore', description: 'Exercise the delivered item\'s gates on the disposable local repository.',
  criteria: [{ id: 'AC-1', text: 'The delivered change works and is served', proofs: ['unit:scratch-delivery', 'e2e:scratch-delivery'] }],
  policy: { checks: ['test'], review: true },
});
const work = `work/${item.id}`;

await call(`${work}/ready`, token, {});
const claim = await call('assignments/claim', workerToken, { work: item.id });
assert.equal(claim.assigned?.id, item.id, JSON.stringify(claim));
const epoch = claim.assigned.epoch, branch = `graphyard/${item.key.toLowerCase()}-${epoch}`;
const trials = join(root, '..', 'trials');
await mkdir(trials, { recursive: true });
const ports = mergeWriterReads({ baseBranch: 'main', repository: 'scratch/delivery', run: { mergeWriter: { deployKeyFile: join(trials, 'unused-key') } } }, root, defaultChildRun, {
  base: trials, merger: async () => 'control-plane', trial: scratchTrial(trials),
  record: async (_item, event) => { await call(`${work}/merge-record`, coordinatorToken, event); },
});
const baseTip = await ports.fetch();
const workspace = join(root, '..', `${item.key}-${epoch}`);
await git('worktree', 'add', '-q', '-b', branch, workspace, baseTip);
const workerGit = async (...args) => (await defaultChildRun('git', ['-C', workspace, ...args])).trim();
await call(`${work}/workspace`, workerToken, { epoch, branch, host: 'scratch', path: workspace });
// The worker's own implementation session, running under its attempt, as every launch records it.
const sessionId = `e2e-worker:${epoch}`;
await call(`${work}/session`, workerToken, { id: sessionId, kind: 'implementation', epoch, runtime: 'scratch', host: 'scratch', subject: title });
const change = `export const delivered = true;\n// ${item.key} ${run}\n`;
await writeFile(join(workspace, 'src/store/change.mjs'), change);
await workerGit('add', 'src/store/change.mjs');
await workerGit('commit', '-q', '-m', `Deliver ${item.key}`);
const head = await workerGit('rev-parse', 'HEAD');
item = await call(`${work}/submit`, workerToken, { epoch, head });
assert.equal(item.candidate.sha, head);

// The delta touches src/store/, which the serving plane's own policy classes sensitive, so the
// exact-head approval is recorded before the merge — the flight a real sensitive item takes.
const reviewToken = randomBytes(32).toString('hex');
await call(`${work}/review-launch`, coordinatorToken, {
  reviewer: 'e2e-independent-reviewer', head, baseTip,
  tokenHash: createHash('sha256').update(reviewToken).digest('hex'), expiresAt: new Date(Date.now() + 120_000).toISOString(),
});
await call(`${work}/review-verdict`, reviewToken, { event: 'APPROVE', body: 'The scratch change and its test agree.', sha: head, token: reviewToken });

const merged = await mergeOne(ports, item);
assert.equal(merged.outcome, "merged", JSON.stringify(merged));

// The delivered item lists no running session; its worker's handle is ended, not dropped.
const delivered = await call(work, token);
assert.equal(delivered.stage, 'done');
const handle = delivered.sessions.find(entry => entry.id === sessionId);
assert.equal(handle?.state, 'finished', `the worker session on a done item: ${JSON.stringify(delivered.sessions)}`);
assert.deepEqual(delivered.sessions.filter(entry => entry.state === 'running'), [], 'a done item lists no running session');

// master status counts workers as the running implementation sessions of the work snapshot.
const snapshot = await call('work-snapshot', coordinatorToken);
const counted = snapshot.work.filter(entry => entry.id === item.id)
  .flatMap(entry => (entry.sessions ?? []).filter(session => session.state === 'running' && session.kind === 'implementation'));
assert.deepEqual(counted, [], 'master status workers no longer counts the done item\'s session');
console.log(`PASS ${item.key}: delivered with its worker session ended and uncounted`);
