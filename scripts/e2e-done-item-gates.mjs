// GY-3281: a done item shows its gates as passed. One fixture item is driven through the real
// flight — claim, submit, an independent review, the merge writer's own build-and-test trial, the
// push and its reconciliation — against the scratch control plane scripts/e2e-serve.mjs hosts, with
// proofs no principal in that plane is authorized to produce (so the filed item carries proof
// gaps). The delivered document the item page and the work row render then shows the merge gate
// passed with the pushed sha and no proof gap, whatever the `pushed` save's gates last said.
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
const title = `E2E case done-item-gates-clean run ${run}`;

let item = await call('work', token, {
  title, type: 'chore', description: 'Exercise the delivered item\'s gates on the disposable local repository.',
  criteria: [{ id: 'AC-1', text: 'The delivered change works and is served', proofs: ['unit:scratch-delivery', 'e2e:scratch-delivery'] }],
  policy: { checks: ['test'], review: true },
});
const work = `work/${item.id}`;
// The gap this case exists for: the plane's admin proves nothing, so both proofs are filed as gaps.
assert.deepEqual(item.proofGaps, ['unit:scratch-delivery', 'e2e:scratch-delivery'], JSON.stringify(item));

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
assert.equal(merged.outcome, 'merged', JSON.stringify(merged));
const tip = (await defaultChildRun('git', ['--git-dir', origin, 'rev-parse', 'refs/heads/main'])).trim();
assert.equal(tip, merged.mergeSha, 'the bare origin holds the pushed merge commit');

// The delivered document: the merge gate passed with the pushed sha, and no proof gap anywhere.
const delivered = await call(work, token);
assert.equal(delivered.stage, 'done');
assert.equal(delivered.delivery.mergeSha, tip, 'the delivery names the pushed sha');
assert.equal(delivered.mergeLedger.state, 'reconciled');
const merge = delivered.gates.find(gate => gate.name === 'merge');
assert.deepEqual([merge.passed, merge.reasons], [true, []], `the gates: ${JSON.stringify(delivered.gates)}`);
assert.ok(!JSON.stringify(delivered.gates).includes('merge writer has not pushed'), 'no stale push refusal');
assert.ok(delivered.gates.every(gate => gate.passed), `a done item shows no pending gate: ${JSON.stringify(delivered.gates)}`);
assert.deepEqual(delivered.proofGaps, [], 'the merged trial executed both proofs, so no gap remains');

// The work row: the same document the list serves for the settled delivery.
const listed = (await call('work', token)).find(entry => entry.id === item.id);
assert.ok(listed, 'the delivered item stays in the work list');
const listedMerge = listed.gates.find(gate => gate.name === 'merge');
assert.deepEqual([listedMerge.passed, listedMerge.reasons], [true, []], `the row's gates: ${JSON.stringify(listed.gates)}`);
assert.equal(listed.delivery.mergeSha, tip);
assert.deepEqual(listed.proofGaps, [], 'the row shows no proof gap');
console.log(`PASS ${item.key}: delivered ${tip.slice(0, 12)} with the merge gate passed and no proof gap`);
