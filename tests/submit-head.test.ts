import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { MergerSettings, recordedMergerMode } from '../src/merger-mode.js';
import { allocateChangeNumber } from '../src/merge-writer/change-numbers.js';
import { absentHeadRefusal, gitRunnerFor, observeHead, type GitRunner } from '../src/merge-writer/local-observation.js';
import { evaluate, mergeLedgerRefusals, pushRefusal, trialRefusal, type Observation, type Principal, type Work } from '../src/model.js';
import { completeCommand, completionBody } from '../src/cli/complete.js';
import { syncWork } from '../src/cli/workspace.js';
import type { CliContext } from '../src/cli/context.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1523: `complete GY-N EPOCH --head SHA` while the control plane is the merge writer. The engine
 * accepts `{epoch, head}` only in that mode (and `{epoch, pr}` only in github mode), allocates one
 * change number per (item, head) into `candidate.pr`, observes the head from the coordinator's own
 * object store with no GitHub, ends the lease in the same transaction, and the gates read the merge
 * ledger where they read GitHub's checks and mergeability for a github-mode observation.
 */
const repository = 'owner/project';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let pg: EmbeddedPostgres, store: Store, engine: Engine, settings: MergerSettings;
/** A checkout laid out like the coordinator's: an origin, the clone whose refs/remotes/origin/main is the base tip, and a worker's commit in the shared object store. */
let checkout: string, baseTip: string, head: string, staleHead: string, fixtureRoot: string;

async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}
before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('submit-head'));
  const origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  const first = await commit(checkout, 'README.md', '# Fixture\n', 'base');
  await commit(checkout, 'src/app.ts', 'export const app = 1;\n', 'app');
  git(checkout, 'push', '-q', 'origin', 'main');
  baseTip = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  // The worker's branch is a linked worktree of the checkout: its commits land in the shared object store, nothing is pushed.
  const worktree = join(checkout, '.graphyard', 'worktrees', 'GY-1-1');
  git(checkout, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree);
  git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
  head = await commit(worktree, 'src/app.ts', 'export const app = 2;\n', 'change');
  // A head branched before the base tip moved: it does not contain the tip.
  const stale = join(checkout, '.graphyard', 'worktrees', 'GY-2-1');
  git(checkout, 'worktree', 'add', '-q', '-b', 'graphyard/gy-2-1', stale, first);
  git(stale, 'config', 'user.email', 't@example.com'); git(stale, 'config', 'user.name', 'T');
  staleHead = await commit(stale, 'src/other.ts', 'export const other = 1;\n', 'stale');

  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1523;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('submit-head-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('submit_head_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/submit_head_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  settings = new MergerSettings(store);
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

const setMerger = async (merger: 'github' | 'control-plane') => { if ((await recordedMergerMode(store.pool)).merger !== merger) await settings.change(operator, { merger, reason: `test wants ${merger}` }, randomUUID()); };
/** An item claimed by the worker with its workspace registered on `branch`, ready to submit. */
async function assigned(n: number, branch = `graphyard/gy-${n}-1`) {
  let w = await engine.execute(operator, 'create', null, { title: `Head submission ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  const pulled = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  assert.equal(pulled.assigned?.id, w.id, JSON.stringify(pulled.refused)); w = pulled.assigned!;
  return engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/head-${n}`, branch }, randomUUID());
}
const numbers = async () => (await store.pool.query('SELECT number::int AS number, work_id, head FROM change_numbers ORDER BY number')).rows as { number: number; work_id: string; head: string }[];

test('integration:submit-head-mode-gate — submit takes exactly one of pr or head; a head is refused under the github merger naming graphyard master merger, a pr under the control-plane merger naming --head, and the mode is read in the transaction', async () => {
  await setMerger('github');
  const w = await assigned(1, 'graphyard/gy-1-1');
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1 }, randomUUID()), /exactly one of pr \(a pull request number\) or head \(a 40-hex commit\)/);
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 7, head }, randomUUID()), /exactly one of pr/);
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, head: 'not-a-sha' }, randomUUID()), /head/);
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, head }, randomUUID()), (error: any) => {
    assert.match(error.message, /A head is submitted only while the control plane is the merge writer; this install's merger is github, so push the branch and complete GY-\d+ 1 with its pull request number, or switch the writer with graphyard master merger/);
    assert.equal(error.status, 409); return true;
  });
  let item = (await store.workDocument(w.id))!;
  assert.equal(item.submission, null); assert.ok(item.lease, 'a refused submission leaves the lease live');
  assert.equal((await numbers()).length, 0, 'nothing was allocated under the github merger');
  await setMerger('control-plane');
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 7 }, randomUUID()), (error: any) => {
    assert.match(error.message, /A pull request is submitted only while GitHub is the merge writer; this install's merger is control-plane, so complete GY-\d+ 1 --head instead/);
    assert.equal(error.status, 409); return true;
  });
  item = (await store.workDocument(w.id))!;
  assert.equal(item.submission, null);
  const submitted = await engine.execute(worker, 'submit', w.id, { epoch: 1, head }, randomUUID());
  assert.deepEqual(submitted.submission, { epoch: 1, pr: (await numbers())[0].number });
});

test('integration:change-number-allocated-once — a head submission allocates one change number per (work, head), sets candidate and submission from it, ends the lease in the same transaction, replays from its receipt and refuses a head the object store lacks naming the branch ref', async () => {
  await setMerger('control-plane');
  const w = await assigned(3, 'graphyard/gy-3-1');
  const before = (await numbers()).length;
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, head: 'f'.repeat(40) }, randomUUID()), (error: any) => {
    assert.equal(error.message, absentHeadRefusal('f'.repeat(40), 'graphyard/gy-3-1'));
    assert.match(error.message, /refs\/heads\/graphyard\/gy-3-1 should hold it/); assert.equal(error.status, 422); return true;
  });
  assert.equal((await numbers()).length, before, 'an absent head allocates nothing');
  const key = randomUUID();
  const submitted = await engine.execute(worker, 'submit', w.id, { epoch: 1, head }, key);
  const rows = await numbers();
  const own = rows.filter(row => row.work_id === w.id);
  assert.equal(own.length, 1); assert.equal(own[0].head, head);
  const number = own[0].number;
  assert.ok(number > 0 && rows.every(row => row.work_id === w.id || row.number !== number), 'the number is the item\'s own, from the shared sequence');
  assert.deepEqual(submitted.candidate, { sha: head, baseSha: baseTip, pr: number, branch: 'graphyard/gy-3-1', author: worker.id });
  assert.deepEqual(submitted.submission, { epoch: 1, pr: number });
  assert.equal(submitted.lease, null, 'the lease ends in the submit transaction');
  assert.equal(submitted.epoch, 1);
  // The replay returns the receipt: no new row, no second observation.
  const replayed = await engine.execute(worker, 'submit', w.id, { epoch: 1, head }, key);
  assert.deepEqual(replayed.candidate, submitted.candidate); assert.deepEqual(replayed.submission, submitted.submission);
  assert.equal((await numbers()).filter(row => row.work_id === w.id).length, 1);
  // The allocation itself is idempotent per (work, head) and sequential across heads.
  assert.equal(await allocateChangeNumber(store.pool, w.id, head), number);
  const next = await allocateChangeNumber(store.pool, w.id, staleHead);
  assert.ok(next > number, `${staleHead.slice(0, 12)} on the same item takes the next number (${next} > ${number})`);
  assert.equal(await allocateChangeNumber(store.pool, w.id, staleHead), next);
  // The heartbeat after complete is refused as the attempt ending, as after a pull-request submission.
  await assert.rejects(engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, randomUUID()), /ended when GY-\d+ was submitted/);
});

test('unit:local-observation-fields — observeHead builds the control-plane observation from git alone: source, candidate, files and scopeFiles from the raw and numstat diffs against refs/remotes/origin/BASE, baseTip and its containment, and the inert GitHub fields; an absent head refuses naming the branch ref', async () => {
  const runner = gitRunnerFor(checkout);
  const at = new Date('2026-10-08T12:00:00.000Z');
  const observation = await observeHead(runner, { head, base: 'main', branch: 'graphyard/gy-1-1', author: 'implementer', at });
  assert.equal(observation.source, 'control-plane');
  assert.deepEqual(observation.candidate, { sha: head, baseSha: baseTip, pr: 0, branch: 'graphyard/gy-1-1', author: 'implementer' });
  assert.deepEqual(observation.files, ['src/app.ts']);
  assert.equal(observation.scopeFiles!.length, 1);
  const file = observation.scopeFiles![0];
  assert.equal(file.path, 'src/app.ts'); assert.equal(file.status, 'modified'); assert.equal(file.additions, 1); assert.equal(file.deletions, 1); assert.equal(file.binary, false);
  assert.equal(file.sha, git(checkout, 'rev-parse', `${head}:src/app.ts`)); assert.equal(file.baseSha, git(checkout, 'rev-parse', `${baseTip}:src/app.ts`));
  assert.equal(observation.baseTip, baseTip); assert.equal(observation.baseTipContained, true);
  assert.deepEqual([observation.protected, observation.checks, observation.reviews, observation.merged, observation.mergeSha, observation.mergeable, observation.at], [false, [], [], false, null, true, at.toISOString()]);
  assert.equal(observation.prState, undefined); assert.equal(observation.draft, undefined);
  const stale = await observeHead(runner, { head: staleHead, base: 'main', branch: 'graphyard/gy-2-1', author: 'implementer' });
  assert.equal(stale.baseTipContained, false, 'a head branched before the tip moved does not contain it');
  assert.equal(stale.candidate.baseSha, baseTip, 'the candidate is still bound to the base tip the diff was taken against');
  assert.ok(stale.files.includes('src/other.ts'));
  await assert.rejects(observeHead(runner, { head: 'a'.repeat(40), base: 'main', branch: 'graphyard/gy-9-1', author: 'implementer' }), (error: any) => {
    assert.equal(error.message, absentHeadRefusal('a'.repeat(40), 'graphyard/gy-9-1')); assert.match(error.message, /refs\/heads\/graphyard\/gy-9-1/); assert.equal(error.status, 422); return true;
  });
  // A runner whose git answers nothing useful refuses the same way, never with a raw git error.
  const silent: GitRunner = async () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });
  await assert.rejects(observeHead(silent, { head, base: 'main', branch: 'graphyard/gy-1-1', author: 'implementer' }), new RegExp(absentHeadRefusal(head, 'graphyard/gy-1-1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const noBase: GitRunner = async args => args[0] === 'rev-parse' && args[3] === `${head}^{commit}` ? { status: 0, stdout: `${head}\n`, stderr: '' } : { status: 128, stdout: '', stderr: '' };
  await assert.rejects(observeHead(noBase, { head, base: 'main', branch: 'graphyard/gy-1-1', author: 'implementer' }), /holds no refs\/remotes\/origin\/main/);
});

test('integration:submit-head-observed-locally — the submit transaction stores the control-plane observation as the candidate\'s, bound to the allocated number; the gates then wait on the merge writer, and a GitHub reading of the pull request bearing that number never replaces it', async () => {
  await setMerger('control-plane');
  const w = await assigned(4, 'graphyard/gy-4-1');
  const submitted = await engine.execute(worker, 'submit', w.id, { epoch: 1, head }, randomUUID());
  const observation = submitted.observation!;
  assert.equal(observation.source, 'control-plane');
  assert.deepEqual(observation.candidate, submitted.candidate);
  assert.equal(observation.candidate.pr, submitted.submission!.pr);
  assert.deepEqual(observation.files, ['src/app.ts']); assert.equal(observation.scopeFiles?.[0].path, 'src/app.ts');
  assert.equal(observation.baseTip, baseTip); assert.equal(observation.baseTipContained, true);
  assert.deepEqual([observation.protected, observation.checks, observation.reviews, observation.merged, observation.mergeable], [false, [], [], false, true]);
  assert.equal(submitted.headObserved?.sha, head, 'the worker bound reads the head as first observed now');
  const gate = (name: string) => submitted.gates.find(entry => entry.name === name)!;
  assert.deepEqual(gate('test').reasons, [trialRefusal(head, baseTip)]);
  assert.ok(gate('merge').reasons.includes(pushRefusal(head)), JSON.stringify(gate('merge').reasons));
  assert.ok(!gate('merge').reasons.some(reason => /GitHub|Pull request is not mergeable/.test(reason)), 'no GitHub reason stands for a control-plane observation');
  assert.ok(!gate('build').reasons.some(reason => /independently observed|compared against the base/.test(reason)), JSON.stringify(gate('build').reasons));
  // A GitHub observation of pull request #<number> is another pull request: it is not saved over the control plane's reading.
  const github: Observation = { candidate: { ...submitted.candidate!, sha: 'c'.repeat(40) }, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, prState: 'open', draft: false, files: ['src/app.ts'], at: new Date().toISOString() };
  const after = await engine.observe(w.id, submitted.revision, github);
  assert.equal(after.observation?.source, 'control-plane'); assert.equal(after.candidate?.sha, head);
});

/** A submitted item as the gates read it, with the observation's `source` deciding which writer's facts they want. */
function submittedWork(source: 'control-plane' | undefined, ledger: Work['mergeLedger'] = undefined, overrides: Partial<Observation> = {}): Work {
  const sha = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-10-08T12:00:00.000Z';
  const candidate = { sha, baseSha: base, pr: 41, branch: 'graphyard/gy-41-1', author: 'implementer' };
  const observation: Observation = { ...(source ? { source } : {}), candidate, checks: [], reviews: [], protected: source ? false : true, mergeable: source ? true : false, merged: false, mergeSha: null, baseTip: base, baseTipContained: true, files: ['src/a.ts'],
    scopeFiles: [{ path: 'src/a.ts', status: 'modified', sha: 'd'.repeat(40), baseSha: 'e'.repeat(40), additions: 1, deletions: 1, binary: false }], at, ...overrides };
  return { id: 'id-41', key: 'GY-41', title: 'Gates', description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:gates'] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'test', revision: 3, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 41 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation, blocker: null, gates: [], violations: [], ...(ledger === undefined ? {} : { mergeLedger: ledger }) } as unknown as Work;
}
const reasonsOf = (work: Work) => Object.fromEntries(evaluate(work, [work], new Date('2026-10-08T12:30:00.000Z'), [15368]).gates.map(gate => [gate.name, gate.reasons]));

test('unit:gates-control-plane-ledger — with observation.source control-plane the test gate waits on the merge ledger\'s trial of exactly this head on exactly this base tip and the merge gate on its reconciled push; no GitHub check or mergeability reason stands', () => {
  const sha = 'a'.repeat(40), base = 'b'.repeat(40);
  const none = reasonsOf(submittedWork('control-plane'));
  assert.deepEqual(none.test, [`merge writer has not trialled ${sha.slice(0, 12)} on ${base.slice(0, 12)}`]);
  assert.ok(none.merge.includes(`merge writer has not pushed ${sha.slice(0, 12)}`), JSON.stringify(none.merge));
  assert.ok(!none.merge.some(reason => /GitHub|mergeable/.test(reason)) && !none.test.some(reason => /CI check/.test(reason)), JSON.stringify(none));
  assert.deepEqual(reasonsOf(submittedWork('control-plane', null)).test, none.test, 'a null ledger is no trial');
  const state = { key: 'GY-41', head: sha, baseTip: base, mergeSha: 'f'.repeat(40), risk: 'routine', intentAt: '2026-10-08T12:10:00.000Z', pushedAt: null, observedTip: null, refusal: null, events: 1 };
  assert.deepEqual(reasonsOf(submittedWork('control-plane', { ...state, state: 'intent' })).test, [], 'a recorded intent is the passing trial of this head on this tip');
  assert.ok(reasonsOf(submittedWork('control-plane', { ...state, state: 'intent' })).merge.includes(pushRefusal(sha)), 'trialled but not pushed');
  assert.deepEqual(reasonsOf(submittedWork('control-plane', { ...state, state: 'intent', baseTip: 'c'.repeat(40) })).test, [trialRefusal(sha, base)], 'a trial on another tip does not count');
  assert.deepEqual(reasonsOf(submittedWork('control-plane', { ...state, state: 'intent', head: 'c'.repeat(40) })).test, [trialRefusal(sha, base)], 'a trial of another head does not count');
  assert.deepEqual(reasonsOf(submittedWork('control-plane', { ...state, state: 'refused', refusal: { kind: 'merge', reason: 'tests failed on the merged tree' } })).test, [trialRefusal(sha, base)], 'a refused merge is no passing trial');
  assert.ok(reasonsOf(submittedWork('control-plane', { ...state, state: 'pushed', pushedAt: '2026-10-08T12:20:00.000Z' })).merge.includes(pushRefusal(sha)), 'pushed but not yet reconciled');
  const reconciled = reasonsOf(submittedWork('control-plane', { ...state, state: 'reconciled', pushedAt: '2026-10-08T12:20:00.000Z', observedTip: 'f'.repeat(40) }));
  assert.deepEqual(reconciled.test, []); assert.ok(!reconciled.merge.includes(pushRefusal(sha)), JSON.stringify(reconciled.merge));
  assert.deepEqual(mergeLedgerRefusals(undefined, { sha, baseSha: base }), { test: [trialRefusal(sha, base)], merge: [pushRefusal(sha)] });
});

test('unit:gates-github-snapshot — with source undefined every reason string the gates give a submitted, observed github-mode candidate is unchanged', () => {
  const sha = 'a'.repeat(40);
  const snapshot = {
    ready: [],
    build: [],
    review: ['Independent approval of the current commit is required'],
    test: ['Required CI check test has not passed on the current candidate'],
    merge: ['Pull request is not mergeable against the current base'],
  };
  assert.deepEqual(reasonsOf(submittedWork(undefined)), snapshot);
  // A merge ledger entry changes nothing for a GitHub observation: GitHub's checks and mergeability decide.
  assert.deepEqual(reasonsOf(submittedWork(undefined, { key: 'GY-41', state: 'reconciled', head: sha, baseTip: 'b'.repeat(40), mergeSha: 'f'.repeat(40), risk: 'routine', intentAt: '2026-10-08T12:10:00.000Z', pushedAt: '2026-10-08T12:20:00.000Z', observedTip: 'f'.repeat(40), refusal: null, events: 3 })), snapshot);
  assert.deepEqual(reasonsOf(submittedWork(undefined, undefined, { mergeable: true, checks: [{ name: 'test', result: 'success', appId: 15368 }] })), { ...snapshot, test: [], merge: [] });
  assert.deepEqual(reasonsOf(submittedWork(undefined, undefined, { mergeable: false, mergeabilityUnknown: true })).merge, ['GitHub is computing mergeability against the current base; the next observation reads it again']);
  const unobserved = submittedWork(undefined); unobserved.candidate = { ...unobserved.candidate!, sha: 'c'.repeat(40) };
  assert.deepEqual(reasonsOf(unobserved).merge, ['GitHub has not been observed at the current candidate', 'Pull request is not mergeable against the current base']);
});

test('unit:complete-head-cli — complete GY-N EPOCH --head [SHA] sends {epoch, head} with the SHA defaulting to the worktree HEAD, complete GY-N EPOCH PR sends the body it always did, and the command still reports self-verification beside the control plane\'s answer', async () => {
  const headOf = () => head;
  assert.deepEqual(completionBody(['2', '123'], headOf), { epoch: 2, pr: 123 });
  assert.deepEqual(completionBody(['2', '123', '--no-docs', 'no documented behaviour changed'], headOf), { epoch: 2, pr: 123, documentation: 'no documented behaviour changed' });
  assert.deepEqual(JSON.stringify(completionBody(['2', '123'], headOf)), JSON.stringify({ epoch: 2, pr: 123 }), 'the PR body is byte-identical');
  assert.deepEqual(completionBody(['2', '--head'], headOf), { epoch: 2, head });
  assert.deepEqual(completionBody(['2', '--head', staleHead], headOf), { epoch: 2, head: staleHead });
  assert.deepEqual(completionBody(['2', `--head=${staleHead}`], headOf), { epoch: 2, head: staleHead });
  assert.deepEqual(completionBody(['2', '--head', '--no-docs', 'none'], headOf), { epoch: 2, head, documentation: 'none' });
  assert.deepEqual(completionBody(['2', '--no-docs', 'none', '--head'], headOf), { epoch: 2, head, documentation: 'none' });
  assert.throws(() => completionBody(['2', '123', '--head'], headOf), /either a PR number or --head \[SHA\], not both/);
  assert.throws(() => completionBody(['2', '--head', 'abc'], headOf), /40-hex commit/);
  assert.throws(() => completionBody(['2', '123', '--bogus'], headOf), /bogus/);
  // The command: the worktree's HEAD is read from the repository root, the body is posted to submit, and the answer carries selfVerification.
  const calls: { path: string; body: unknown }[] = [], printed: any[] = [];
  const worktree = join(checkout, '.graphyard', 'worktrees', 'GY-1-1');
  const context = { args: ['1', '--head'], api: async (path: string, body: unknown) => { calls.push({ path, body }); return { key: 'GY-1', submission: { epoch: 1, pr: 5 } }; }, print: (value: unknown) => printed.push(value), repositoryRoot: () => worktree } as unknown as CliContext;
  await completeCommand.run(context, { id: 'id-1', key: 'GY-1' } as any);
  assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, head } }]);
  assert.equal(printed[0].submission.pr, 5); assert.equal(printed[0].selfVerification.state, 'not-run');
  // The PR form through the same command.
  calls.length = 0;
  await completeCommand.run({ ...context, args: ['1', '77'] } as CliContext, { id: 'id-1', key: 'GY-1' } as any);
  assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, pr: 77 } }]);
});

test('unit:sync-control-plane-no-fetch — sync reads mergeWriter from /api/status: under control-plane it fetches nothing and merges the shared refs/remotes/origin/BASE, listing plannedFiles as before and pointing at complete --head; under github or an older server without the field it fetches', async () => {
  const root = await realpath(await temporaryDirectory('sync-control-plane'));
  const cwd = process.cwd();
  try {
    const origin = join(root, 'origin.git'), clone = join(root, 'clone'), other = join(root, 'other');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
    git(clone, 'config', 'user.email', 't@example.com'); git(clone, 'config', 'user.name', 'T');
    await commit(clone, 'README.md', '# Fixture\n', 'base'); git(clone, 'push', '-q', 'origin', 'main');
    const sharedTip = git(clone, 'rev-parse', 'refs/remotes/origin/main');
    git(clone, 'checkout', '-q', '-b', 'graphyard/gy-9-1');
    await commit(clone, 'src/x.ts', 'export const x = 1;\n', 'work');
    // Origin moves on; the clone's refs/remotes/origin/main (the shared ref) still names the old tip.
    execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' });
    git(other, 'config', 'user.email', 't@example.com'); git(other, 'config', 'user.name', 'T');
    const moved = await commit(other, 'docs/new.md', 'new\n', 'advance'); git(other, 'push', '-q', 'origin', 'main');
    const work = { id: 'id-9', key: 'GY-9', plannedFiles: ['src/'], workspaces: [{ epoch: 1, branch: 'graphyard/gy-9-1', host: 'h', path: clone, owner: 'implementer' }], lease: null };
    const run = async (status: Record<string, unknown>) => {
      const printed: any[] = [];
      await syncWork({ api: async (path: string) => { assert.equal(path, 'status'); return status; }, print: (value: unknown) => printed.push(value), base: 'http://graphyard.test', args: [] } as unknown as CliContext, work);
      return printed[0];
    };
    process.chdir(clone);
    const controlPlane = await run({ baseBranch: 'main', mergeWriter: { merger: 'control-plane', line: 'The control plane is the merge writer' } });
    assert.equal(controlPlane.fetched, false); assert.equal(controlPlane.merged, true); assert.equal(controlPlane.ok, true);
    assert.equal(controlPlane.baseTip, sharedTip, 'the shared ref was merged as it stood');
    assert.equal(git(clone, 'rev-parse', 'refs/remotes/origin/main'), sharedTip, 'nothing was fetched');
    assert.throws(() => git(clone, 'merge-base', '--is-ancestor', moved, 'HEAD'), 'the moved origin tip is not in HEAD');
    assert.deepEqual(controlPlane.files.map((finding: any) => [finding.path, finding.kind]), [['src/x.ts', 'in-scope']], 'the plannedFiles listing ran');
    assert.match(controlPlane.next, /Nothing is pushed while the control plane is the merge writer: complete GY-9 EPOCH --head/);
    assert.ok(!/Push, then/.test(controlPlane.next));
    const older = await run({ baseBranch: 'main' });
    assert.equal(older.fetched, true); assert.equal(older.baseTip, moved, 'a status without mergeWriter fetches, as before');
    assert.doesNotThrow(() => git(clone, 'merge-base', '--is-ancestor', moved, 'HEAD'));
    assert.match(older.next, /Push, then complete GY-9 EPOCH PR\./);
    const github = await run({ baseBranch: 'main', mergeWriter: { merger: 'github', line: null } });
    assert.equal(github.fetched, true); assert.match(github.next, /Push, then complete GY-9 EPOCH PR\./);
  } finally { process.chdir(cwd); await rm(root, { recursive: true, force: true }); }
});
