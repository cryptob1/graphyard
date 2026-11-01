import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun } from '../src/child-runner.ts';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.ts';
import { mergeOne, nextToMerge, runMergeTrial } from '../src/merge-writer/executor.ts';

const token = process.argv[2], url = process.env.TARGET_URL;
assert.ok(token && url, 'Run this case through the E2E runner against scripts/e2e-serve.mjs');
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

let item = await call('work', token, {
  title: `Scratch delivery ${randomUUID()}`, type: 'chore',
  description: 'Exercise delivery in the disposable local repository.',
  criteria: [{ id: 'AC-1', text: 'The submitted change works and is served', proofs: ['unit:scratch-delivery', 'e2e:scratch-delivery'] }],
  policy: { checks: ['test'], review: true },
});
const work = `work/${item.id}`;
await call(`${work}/ready`, token, {});
const claim = await call('assignments/claim', workerToken, { work: item.id });
assert.equal(claim.assigned?.id, item.id, JSON.stringify(claim));
const epoch = claim.assigned.epoch, branch = `graphyard/${item.key.toLowerCase()}-${epoch}`;
const trials = join(root, '..', 'trials');
await mkdir(trials, { recursive: true });
const events = [];
const ports = mergeWriterReads({ baseBranch: 'main', repository: 'scratch/delivery', run: { mergeWriter: { deployKeyFile: join(trials, 'unused-key') } } }, root, defaultChildRun, {
  base: trials, merger: async () => 'control-plane',
  // These are the real trial and real children, with all scratch files under the serve directory.
  trial: input => runMergeTrial({ ...input, checkoutRoots: [trials], temporaryRoots: [trials], retries: 0 }),
  record: async (_item, event) => { await call(`${work}/merge-record`, coordinatorToken, event); events.push(event); },
});

const baseTip = await ports.fetch();
const workspace = join(root, '..', item.key);
await git('worktree', 'add', '-q', '-b', branch, workspace, baseTip);
const workerGit = async (...args) => (await defaultChildRun('git', ['-C', workspace, ...args])).trim();
await call(`${work}/workspace`, workerToken, { epoch, branch, host: 'scratch', path: workspace });
const change = `export const delivered = true;\n// ${item.key}\n`;
await writeFile(join(workspace, 'src/store/change.mjs'), change);
await workerGit('add', 'src/store/change.mjs');
await workerGit('commit', '-q', '-m', `Deliver ${item.key}`);
const head = await workerGit('rev-parse', 'HEAD');
item = await call(`${work}/submit`, workerToken, { epoch, head });
assert.equal(item.candidate.sha, head);
assert.equal(item.lease, null, 'submission ends the worker lease');
assert.equal(nextToMerge([item], {}, Date.now()), null, 'a submitted head waits for review');

const reviewToken = randomBytes(32).toString('hex');
await call(`${work}/review-launch`, coordinatorToken, {
  reviewer: 'e2e-independent-reviewer', head, baseTip,
  tokenHash: createHash('sha256').update(reviewToken).digest('hex'), expiresAt: new Date(Date.now() + 120_000).toISOString(),
});
await call(`${work}/review-verdict`, reviewToken, { event: 'APPROVE', body: 'The scratch change and its test agree.', sha: head, token: reviewToken });
item = await call(work, token);
assert.equal(item.observation.reviews[0].sha, head);
assert.equal(item.observation.reviews[0].reviewer, 'e2e-independent-reviewer');
assert.equal(nextToMerge([item], {}, Date.now())?.id, item.id, JSON.stringify(item.gates));

// Fault injection for AC-1: run the same case with the bare repository genuinely unwritable.
async function writable(path, enabled) {
  const entries = await readdir(path, { withFileTypes: true });
  if (enabled) await chmod(path, 0o755);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await writable(child, enabled);
    else await chmod(child, enabled ? 0o644 : 0o444);
  }
  if (!enabled) await chmod(path, 0o555);
}
const unwritable = process.argv.includes('--unwritable');
try {
  if (unwritable) await writable(origin, false);
  const merged = await mergeOne(ports, item);
  assert.equal(merged.outcome, 'merged', JSON.stringify(merged));
  assert.deepEqual(events.map(event => event.kind), ['intent', 'trial', 'pushed', 'reconciled']);
  const trial = events.find(event => event.kind === 'trial');
  assert.equal(trial.build, 'pass');
  assert.deepEqual(trial.proofs['unit:scratch-delivery'], { executed: 1, failed: 0 });
  assert.deepEqual(trial.proofs['e2e:scratch-delivery'], { executed: 1, failed: 0 });
  const tip = (await defaultChildRun('git', ['--git-dir', origin, 'rev-parse', 'refs/heads/main'])).trim();
  assert.equal(tip, merged.mergeSha, 'the bare origin holds the merge commit');
  assert.equal(await git('show', `${tip}:src/store/change.mjs`), change.trim());
  const delivered = await call(work, token);
  assert.equal(delivered.stage, 'done');
  assert.equal(delivered.delivery.mergeSha, tip);
  assert.equal(delivered.mergeLedger.state, 'reconciled');
  console.log(`PASS ${item.key}: claimed epoch ${epoch}, reviewed ${head}, trial passed, origin/main and delivery hold ${tip}`);
} catch (error) {
  console.error(`Delivery pipeline failed: ${error.message.replace(/\n/g, ' ')}`);
  process.exitCode = 1;
} finally {
  if (unwritable) await writable(origin, true);
}
