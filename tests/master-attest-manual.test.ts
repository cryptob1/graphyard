import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { runAutonomyCommand, type MasterConfig } from '../src/master.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { currentEvidence } from '../src/model/evidence.js';
import { evaluateLandability } from '../src/model-boundary/landability.js';
import { landabilityRefusals } from '../src/model/landability.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3037: the fixtures here file items, and every item owes an e2e proof; they declare the serve one needs.
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3238: `graphyard master attest GY-N manual:NAME REASON` applies the master's attest decision
// with its operator-agent identity. The evidence command records the manual: proof as a trusted
// attestation on the exact current head, the item's proof requirement is met, and a worker
// identity is still refused for manual: proofs.

const repository = 'owner/master-attest';
const PROOF = 'manual:onboarding-files';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const operatorAgent = { id: 'graphyard-master-attest-operator', role: 'operator-agent', sessionKind: 'ai', capabilities: [],
  scope: { repositories: [repository], workItems: ['*'] } } as unknown as Principal;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const id = () => randomUUID();

let store: Store, engine: Engine, fixtureRoot: string, checkout: string, head: string, baseTip: string;

async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('master-attest-manual'));
  const origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'README.md', '# Fixture\n', 'base');
  // src/store/ is sensitive under the repository's own policy, so this change's acceptance gate
  // demands exactly the manual: attestation the master records.
  await commit(checkout, 'src/store/attested.ts', 'export const attested = 1;\n', 'store');
  git(checkout, 'push', '-q', 'origin', 'main');
  baseTip = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  const worktree = join(checkout, '.graphyard', 'worktrees', 'GY-1-1');
  git(checkout, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree);
  git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
  head = await commit(worktree, 'src/store/attested.ts', 'export const attested = 2;\n', 'the change');

  store = await withDatabase('master-attest-manual'); await store.init();
  engine = new Engine(store, 120, repository);
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
});
after(async () => { if (store) await store.close(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

/** A sensitive head the implementer submitted: claimed, workspace registered, head observed by the control plane. */
async function submitted(): Promise<Work> {
  let work = await engine.execute(admin, 'create', null, { type: 'bug', title: 'Attested by the master', criteria: [{ id: 'AC-1', text: 'The onboarding files land where the guide says', proofs: [PROOF, 'e2e:fixture'] }] }, id());
  work = await engine.execute(admin, 'ready', work.id, {}, id());
  const pulled = await engine.pullAssignment(worker, { work: work.id }, id());
  assert.equal(pulled.assigned?.id, work.id, JSON.stringify(pulled.refused));
  work = await engine.execute(worker, 'workspace', pulled.assigned!.id, { epoch: pulled.assigned!.epoch, host: 'test', path: '/tmp/master-attest-manual', branch: 'graphyard/gy-1-1' }, id());
  return engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head }, id());
}

/** The acceptance family's refusal reasons, as the landability verdict words them. */
const acceptance = (work: Work) => landabilityRefusals(evaluateLandability(work, [work], new Date()), 'acceptance');

test('integration:master-attest-manual — master attest records the manual: proof with the operator-agent identity on the exact current head and the proof requirement is met; a worker is still refused for manual: proofs', { timeout: 300_000 }, async () => {
  const item = await submitted();
  assert.deepEqual(item.candidate, { sha: head, baseSha: baseTip, pr: item.submission!.pr, branch: 'graphyard/gy-1-1', author: worker.id });
  const before = acceptance(item);
  assert.ok(before.some(reason => reason.includes(`${PROOF} needs a trusted passing attestation`)), JSON.stringify(before));

  // The CLI subcommand posts exactly the engine command, with the operator agent's own credential.
  const posted: { path: string; body: any; token: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/api\//, ''), body = JSON.parse(String(init.body)), token = String((init.headers as Record<string, string>).Authorization).slice(7);
    posted.push({ path, body, token });
    const [, workId, command] = path.split('/');
    return new Response(JSON.stringify(await engine.execute(operatorAgent, command as 'evidence', workId, body, id())), { status: 200 });
  }) as unknown as typeof fetch;
  const root = await temporaryDirectory('master-attest-root'), credentialFile = join(await temporaryDirectory('master-attest-credential'), 'operator-agent.token');
  await writeFile(credentialFile, `${'o'.repeat(40)}\n`, { mode: 0o600 });
  execFileSync('git', ['init', '--quiet', root]);
  const config = { url: 'http://127.0.0.1:1', operatorAgent: { id: operatorAgent.id, credentialFile } } as unknown as MasterConfig;
  const deps = { coordinator: async () => ({ now: new Date().toISOString(), work: [await store.workDocument(item.id)] }), readSecret: async () => '', agents: () => [], daemonLock: async () => null, fetcher };
  const reason = 'the onboarding files match the guide the operator accepted';
  const attested = await runAutonomyCommand(root, config, 'attest', [item.key, PROOF, ...reason.split(' ')], deps) as Work;

  assert.deepEqual(posted.map(call => [call.path, call.token]), [[`work/${item.id}/evidence`, 'o'.repeat(40)]], 'sent once, with the operator agent credential');
  const input = posted[0]!.body;
  assert.deepEqual([input.proof, input.reason, input.sha, input.baseSha, input.policyRevision, input.result], [PROOF, reason, head, baseTip, item.policyRevision, 'pass']);
  assert.equal(input.exercise?.result, 'fail', 'the attestation carries its exercise record');

  const record = attested.evidence.at(-1)!;
  assert.deepEqual([record.proof, record.producer, record.trusted, record.result, record.sha, record.baseSha, record.policyRevision, record.reason],
    [PROOF, operatorAgent.id, true, 'pass', head, baseTip, item.policyRevision, reason], 'recorded as the master\'s attestation on the exact current head');
  assert.equal(currentEvidence(attested, PROOF, new Date())?.id, record.id, 'the proof requirement reads this record');
  const after = acceptance(attested);
  assert.ok(!after.some(entry => entry.includes(PROOF)), JSON.stringify(after));
  assert.ok(after.some(entry => entry.includes('e2e:fixture')), 'the rest of the acceptance gate still stands');
  const history = (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id = $1 ORDER BY seq', [item.id])).rows;
  const entry = history.at(-1)!;
  assert.deepEqual([entry.actor, entry.kind, entry.payload.details?.reason], [operatorAgent.id, 'evidence', reason], 'the history entry names the operator agent and its reason');

  // A worker identity is still refused for a manual: proof, whatever head it names.
  await assert.rejects(engine.execute(worker, 'evidence', item.id, { proof: PROOF, sha: head, baseSha: baseTip, policyRevision: item.policyRevision, result: 'pass', executed: 1, skipped: 0 }, id()),
    /A manual: proof is the master's attestation, never a worker's record: graphyard master attest/);
  // The operator-agent identity attests only manual: proofs, and only on the exact current head.
  await assert.rejects(engine.execute(operatorAgent, 'evidence', item.id, { proof: 'e2e:fixture', sha: head, baseSha: baseTip, policyRevision: item.policyRevision, result: 'pass', executed: 1, skipped: 0, reason: 'not a manual proof' }, id()),
    /The master attests only manual: proofs/);
  await assert.rejects(engine.execute(operatorAgent, 'evidence', item.id, { proof: PROOF, sha: 'c'.repeat(40), baseSha: baseTip, policyRevision: item.policyRevision, result: 'pass', executed: 1, skipped: 0, reason: 'another head' }, id()),
    new RegExp(`An attestation is recorded on ${item.key}'s current candidate`));
  // An attest without a reason is refused before it reaches the control plane.
  await assert.rejects(runAutonomyCommand(root, config, 'attest', [item.key, PROOF], deps), /master attest needs a REASON/);
});
