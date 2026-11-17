import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { evaluate } from '../src/model-boundary/gates.js';
import { attestationExercise } from '../src/master/autonomy.js';
import { currentEvidence } from '../src/model/evidence.js';
import { evaluateLandability } from '../src/model-boundary/landability.js';
import { landabilityRefusals } from '../src/model/landability.js';
import type { Evidence, Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3429: what the master checked for a manual: proof lives in the head, so its attestation
// binds the head and policy revision, not the base tip; trusted trial evidence keeps its base.

const repository = 'owner/manual-attest-survives-base';
const PROOF = 'manual:onboarding-files', E2E = 'e2e:fixture';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const master = { id: 'graphyard-master-attest-operator', role: 'operator-agent', sessionKind: 'ai', capabilities: [],
  scope: { repositories: [repository], workItems: ['*'] } } as unknown as Principal;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const id = () => randomUUID();
let store: Store, engine: Engine, fixtureRoot: string, checkout: string, head: string, base: string;

async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('manual-attest-survives-base'));
  const origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'src/store/attested.ts', 'export const attested = 1;\n', 'base');
  git(checkout, 'push', '-q', 'origin', 'main');
  base = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  const worktree = join(checkout, '.graphyard', 'worktrees', 'GY-1-1');
  git(checkout, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree);
  git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
  head = await commit(worktree, 'src/store/attested.ts', 'export const attested = 2;\n', 'the change');
  store = await withDatabase('manual-attest-survives-base'); await store.init();
  engine = new Engine(store, 120, repository);
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
});
after(async () => { if (store) await store.close(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

/** A submitted head the master attested on its first base, with the trial's e2e pass on that base. */
async function attested(branch: string): Promise<Work> {
  git(checkout, 'branch', '-f', branch, head);
  let work = await engine.execute(admin, 'create', null, { type: 'bug', title: 'Attested by the master', criteria: [{ id: 'AC-1', text: 'The onboarding files land where the guide says', proofs: [PROOF, E2E] }] }, id());
  work = await engine.execute(admin, 'ready', work.id, {}, id());
  const pulled = await engine.pullAssignment(worker, { work: work.id }, id());
  work = await engine.execute(worker, 'workspace', pulled.assigned!.id, { epoch: pulled.assigned!.epoch, host: 'test', path: `/tmp/manual-attest/${work.key}`, branch }, id());
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head }, id());
  work = await engine.execute(master, 'evidence', work.id, { proof: PROOF, sha: head, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision, result: 'pass', executed: 1, skipped: 0, reason: 'the onboarding files match the guide', ...attestationExercise(work, PROOF) }, id());
  return withTrial(work, work.candidate!.baseSha);
}
/** The trusted e2e pass for the head on BASE: the merge writer's trial and its evidence record. */
function withTrial(work: Work, baseSha: string): Work {
  const record = { id: id(), proof: E2E, sha: head, baseSha, policyRevision: work.policyRevision, result: 'pass', executed: 1, skipped: 0, trusted: true,
    producer: 'merge-trial', at: new Date().toISOString() } as unknown as Evidence;
  const mergeLedger = { ...work.mergeLedger, trial: { head, mergeSha: head, proofs: { [E2E]: { executed: 1, failed: 0, skipped: 0 } } } } as unknown as Work['mergeLedger'];
  return { ...work, mergeLedger, evidence: [...work.evidence, record] };
}
/** Main moved: the control plane observes the same head against the new base tip. */
function moved(work: Work, baseSha: string, sha = head): Work {
  const candidate = { ...work.candidate!, sha, baseSha };
  return { ...work, candidate, observation: { ...work.observation!, candidate, baseTip: baseSha, mergeBase: baseSha } };
}
async function mainMoves(): Promise<string> {
  await commit(checkout, `docs/${id()}.md`, 'another item merged\n', 'another item');
  git(checkout, 'push', '-q', 'origin', 'main');
  return git(checkout, 'rev-parse', 'refs/remotes/origin/main');
}
const acceptance = (work: Work) => landabilityRefusals(evaluateLandability(work, [work], new Date()), 'acceptance');
const owes = (work: Work, proof: string) => acceptance(work).some(reason => reason.includes(`${proof} needs trusted passing evidence`));

test('integration:manual-attest-survives-base — a manual: attestation on head H at base B1 still satisfies acceptance at base B2 under the same policy revision; a new head or policy revision needs a new one; automated proofs keep their base', { timeout: 300_000 }, async () => {
  const work = await attested('graphyard/gy-2-1');
  assert.deepEqual(acceptance(work), [], 'attested and trialled on B1');
  const b2 = await mainMoves();
  const onB2 = moved(work, b2);
  assert.equal(owes(onB2, PROOF), false, 'the attestation binds the head, not the base tip');
  assert.equal(currentEvidence(work, E2E, new Date())?.baseSha, base);
  assert.equal(currentEvidence(onB2, E2E, new Date()), undefined, 'trusted automated evidence still binds its base');
  assert.equal(owes(moved(work, b2, 'c'.repeat(40)), PROOF), true, 'a new head needs a new attestation');
  assert.equal(owes({ ...onB2, policyRevision: work.policyRevision + 1 }, PROOF), true, 'a new policy revision needs a new attestation');
});

test('e2e:attest-survives-main-move — after the master attests, main moves and the item proceeds through acceptance without a second attestation', { timeout: 300_000 }, async () => {
  const work = await attested('graphyard/gy-3-1');
  const b2 = await mainMoves();
  const retrialled = withTrial(moved(work, b2), b2);
  assert.equal(retrialled.evidence.filter(entry => entry.proof === PROOF).length, 1, 'one attestation only');
  assert.deepEqual(acceptance(retrialled), []);
  const gate = evaluate(retrialled, [retrialled], new Date()).gates.find(entry => entry.name === 'acceptance')!;
  assert.deepEqual(gate.reasons, [], 'the acceptance gate passes on the moved base');
  assert.equal(gate.passed, true);
});
