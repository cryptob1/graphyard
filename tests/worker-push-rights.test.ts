import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { harnessDecision } from '../src/harness.js';
import { blockerCommands, branchRestoration, buildMasterStatus, sessionHarnessPlan, unrunnableRemedies, workerHarnessPlan } from '../src/master.js';
import { parseLocalScopeDiff } from '../src/sync.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-128: the recovery the control plane authorizes for an ejected or contaminated tip — reset
// the assigned branch to the reviewed head, sync it onto the base, push — must be executable by
// the worker session it dispatches. Each test is named for the proof it produces.
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const exec = promisify(execFile);
const branch = 'graphyard/gy-9-4';
const plan = workerHarnessPlan({ cliPath: launcher, branch, baseBranch: 'main', credentialHome: '/home/x/.config/graphyard' });
const decision = (command: string, rules = plan) => harnessDecision(rules, command).decision;

test('unit:worker-may-force-with-lease-its-own-branch — the worker restores its assigned branch with a lease push only through restore-branch; every raw force, lease, deletion and base-branch push is denied', () => {
  const cli = `node ${launcher}`;
  // The one rewrite the worker may make: restore-branch, the CLI's lease push of the branch
  // registered for its live lease. A glob cannot limit a raw lease push to one ref, and a Claude
  // worker runs under bypassPermissions, where anything not denied runs; so every raw one is denied.
  assert.equal(decision(`${cli} restore-branch GY-9 4`), 'allow');
  assert.ok(plan.allow.some(entry => entry.rule === `Bash(${cli} restore-branch:*)`));
  assert.deepEqual(plan.allow.filter(entry => /--force/.test(entry.rule)), [], 'no raw force or lease push is allowed');
  // The ordinary pushes of its branch are unchanged.
  for (const command of [`git push origin ${branch}`, `git push -u origin ${branch}`, `git push origin HEAD:${branch}`]) assert.equal(decision(command), 'allow', command);
  // A force push in any spelling is denied, on the assigned branch too.
  for (const command of [`git push --force origin ${branch}`, `git push origin ${branch} --force`, `git push -f origin ${branch}`, `git push origin ${branch} -f`,
    `git push origin +${branch}`, `git push origin +HEAD:${branch}`, `git push --force-with-lease --force origin ${branch}`, `git push --force-if-includes --force-with-lease origin ${branch}`])
    assert.equal(decision(command), 'deny', command);
  // A lease push of any ref, the assigned one included, is refused outright — never merely unmatched.
  for (const command of [`git push --force-with-lease origin ${branch}`, 'git push --force-with-lease origin graphyard/gy-7-1', 'git push --force-with-lease origin HEAD:graphyard/gy-7-1',
    `git push --force-with-lease origin ${branch}:graphyard/gy-7-1`, `git push --force-with-lease origin ${branch} graphyard/gy-7-1`, `git push origin ${branch} --force-with-lease`,
    'git push --force-with-lease=graphyard/gy-7-1:abc origin graphyard/gy-7-1', `git push --force-with-lease=refs/heads/${branch}:abc origin HEAD:refs/heads/${branch}`])
    assert.equal(decision(command), 'deny', command);
  // Deleting or mirroring refs: denied in every form, the empty-source refspec included.
  for (const command of ['git push --mirror origin', 'git push --all origin', `git push origin --delete ${branch}`, `git push -d origin ${branch}`, `git push origin -d graphyard/gy-7-1`,
    `git push origin :${branch}`, 'git push origin :graphyard/gy-7-1', 'git push origin :refs/heads/release', 'git push origin :hot-fix'])
    assert.equal(decision(command), 'deny', command);
  // The base branch: denied in every form, its full ref spelling and a lease push included.
  for (const command of ['git push origin main', 'git push --force-with-lease origin main', 'git push --force-with-lease origin HEAD:main', 'git push origin HEAD:main', 'git push -u origin main',
    `git push origin ${branch} main`, 'git push origin refs/heads/main', 'git push origin HEAD:refs/heads/main', 'git push --force-with-lease origin refs/heads/main', 'git push origin :main'])
    assert.equal(decision(command), 'deny', command);
  // A compound command is judged per part: a denied part denies the whole.
  assert.equal(decision(`git fetch origin && ${cli} restore-branch GY-9 4`), 'allow');
  assert.equal(decision(`${cli} restore-branch GY-9 4 && git push --force origin main`), 'deny');
  // The launched worker session carries the same push rules as the worktree file.
  const session = sessionHarnessPlan({ role: 'worker', kind: 'claude', branch, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', credentialHome: '/home/x/.config/graphyard', credentialDirectories: ['/home/x/.config/graphyard'] });
  assert.equal(decision(`${cli} restore-branch GY-9 4`, session), 'allow');
  for (const command of [`git push --force origin ${branch}`, 'git push --force-with-lease origin graphyard/gy-7-1', 'git push origin :graphyard/gy-7-1']) assert.equal(decision(command, session), 'deny', command);
  // The restoration the rework reason carries is permitted command by command, with no human shell.
  const steps = branchRestoration({ cliPath: launcher, key: 'GY-9', epoch: 4, pr: 31, reviewedHead: 'f'.repeat(40) });
  assert.deepEqual(steps.map(step => decision(step)), steps.map(() => 'allow'), steps.join('\n'));
  assert.ok(steps.includes(`${cli} restore-branch GY-9 4`));
  assert.ok(!steps.some(step => /^git push/.test(step)), 'no raw push in the restoration');
});

// ---- A contaminated branch, restored end to end by the attempt a rework dispatches ------------
const operator: Principal = { id: 'push-rights-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'push-rights-worker', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, worker].map(principal => ({ ...principal, token: `push-rights-${principal.id}-${'x'.repeat(32)}` }));
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, scratch: string;
before(async () => {
  const port = Number(process.env.GRAPHYARD_WORKER_PUSH_RIGHTS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 61);
  scratch = await mkdtemp(join(tmpdir(), 'graphyard-push-rights-'));
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/push-rights');
  engine.principals = [operator, worker];
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close(); if (database) await database.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const identity = { GIT_AUTHOR_NAME: 'Push Rights', GIT_AUTHOR_EMAIL: 'push-rights@example.invalid', GIT_COMMITTER_NAME: 'Push Rights', GIT_COMMITTER_EMAIL: 'push-rights@example.invalid' };
const gitEnv = { ...process.env, ...identity };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, file: string, text: string, message: string) => execFileSync('sh', ['-c', 'printf "%s\\n" "$1" > "$2" && git add -- "$2" && git commit -q -m "$3"', 'commit', text, file, message], { cwd, env: gitEnv });
const tokenOf = (principal: Principal) => credentials.find(entry => entry.id === principal.id)!.token;

test('integration:authorized-rework-is-executable — a rework over an ejected, contaminated tip is carried out by the dispatched attempt alone: reset, sync, lease push, complete', async () => {
  // The repository: main holds both items' files; this item owns src-own.txt, another src-foreign.txt.
  const origin = join(scratch, 'origin.git'), seed = join(scratch, 'seed'), queue = join(scratch, 'queue'), attempt = join(scratch, 'attempt-2');
  git(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
  git(scratch, 'clone', '-q', origin, seed);
  git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  commit(seed, 'README.md', 'base', 'Seed'); commit(seed, 'src-own.txt', 'own v0', 'Own file'); commit(seed, 'src-foreign.txt', 'foreign v0', 'Foreign file');
  git(seed, 'push', '-q', 'origin', 'main');

  let work: Work = await engine.execute(operator, 'create', null, { title: 'Contaminated rework', plannedFiles: ['src-own.txt'], criteria: [{ id: 'AC-1', text: 'Own change', proofs: ['unit:own'] }] }, randomUUID());
  const foreign: Work = await engine.execute(operator, 'create', null, { title: 'Foreign unlanded', plannedFiles: ['src-foreign.txt'], criteria: [{ id: 'AC-1', text: 'Foreign change', proofs: ['unit:foreign'] }] }, randomUUID());
  const itemBranch = `graphyard/${work.key.toLowerCase()}-1`, pr = 4128;
  // The observer reads the real origin, as the provider would: the PR head, the base tip and the diff between them.
  const observeOrigin = async () => {
    const head = git(seed, 'ls-remote', origin, `refs/heads/${itemBranch}`).split('\t')[0], base = git(seed, 'ls-remote', origin, 'refs/heads/main').split('\t')[0];
    git(seed, 'fetch', '-q', origin, `+refs/heads/*:refs/remotes/observed/*`);
    const scopeFiles = parseLocalScopeDiff(git(seed, 'diff', '--raw', '-M', '-z', '--no-abbrev', base, head), git(seed, 'diff', '--numstat', '-M', '-z', base, head));
    return { candidate: { sha: head, baseSha: base, pr, branch: itemBranch, author: worker.id }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: scopeFiles.map(file => file.path), scopeFiles, baseTip: base, at: new Date().toISOString() } satisfies Observation;
  };
  engine.submissionObserver = observeOrigin;
  // The provider observation the control plane's sync job records for the submitted head.
  const observed = async () => { const latest = (await store.list()).find(item => item.id === work.id)!; return engine.observe(latest.id, latest.revision, await observeOrigin()); };

  // Epoch 1: the item's own change, reviewed at head R and submitted.
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'push-rights-host', path: join(scratch, 'attempt-1'), branch: itemBranch }, randomUUID());
  git(seed, 'checkout', '-q', '-b', itemBranch);
  commit(seed, 'src-own.txt', 'own v1', 'GY-A: own change');
  const reviewed = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '-q', 'origin', itemBranch);
  work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr }, randomUUID());
  work = await observed();
  assert.equal(work.candidate?.sha, reviewed);

  // The queue publishes a speculative tip onto the branch — carrying the other item's unlanded
  // commit — and then ejects it: the branch now holds content that is not this item's.
  git(scratch, 'clone', '-q', origin, queue);
  git(queue, 'checkout', '-q', '-b', 'graphyard/foreign', 'origin/main');
  commit(queue, 'src-foreign.txt', 'foreign v1 (unlanded)', `${foreign.key}: foreign change`);
  const unlanded = git(queue, 'rev-parse', 'HEAD');
  git(queue, 'checkout', '-q', '-b', 'tip', `origin/${itemBranch}`);
  git(queue, 'merge', '-q', '--no-edit', unlanded);
  const ejectedTip = git(queue, 'rev-parse', 'HEAD');
  git(queue, 'push', '-q', 'origin', `HEAD:${itemBranch}`);
  // …and the base moves on meanwhile.
  git(queue, 'checkout', '-q', '-B', 'main', 'origin/main');
  commit(queue, 'README.md', 'base moved', 'Another delivery lands');
  git(queue, 'push', '-q', 'origin', 'main');
  const base = git(queue, 'rev-parse', 'HEAD');

  // The authorized rework (the decision the approver approved applies as this command) and the attempt it dispatches.
  work = await engine.execute(operator, 'rework', work.id, { reason: `Ejected tip ${ejectedTip.slice(0, 12)} carries ${foreign.key}; restore to reviewed head ${reviewed.slice(0, 12)}`, previousWorkerStopped: true }, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  assert.equal(work.epoch, 2);
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 2, host: 'push-rights-host', path: attempt, branch: itemBranch }, randomUUID());
  // The rework workspace starts from the branch as it stands: the contaminated tip.
  git(scratch, 'clone', '-q', origin, attempt);
  git(attempt, 'checkout', '-q', '-B', itemBranch, `origin/${itemBranch}`);
  assert.equal(git(attempt, 'rev-parse', 'HEAD'), ejectedTip);

  // The dispatched session's harness and environment: its own worker credential and nothing else.
  const harness = sessionHarnessPlan({ role: 'worker', kind: 'claude', branch: itemBranch, cliPath: launcher, repository: 'owner/push-rights', baseBranch: 'main', credentialHome: join(scratch, 'credentials'), credentialDirectories: [join(scratch, 'credentials')] });
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GRAPHYARD_')));
  Object.assign(env, identity, { GRAPHYARD_URL: url, GRAPHYARD_TOKEN: tokenOf(worker) });
  const run = (command: string) => exec('bash', ['-c', command], { cwd: attempt, env, encoding: 'utf8' });

  // Without restore-branch there is no way through: a plain push is refused as non-fast-forward,
  // and every raw force or lease push is denied by the harness.
  git(attempt, 'reset', '-q', '--hard', reviewed);
  await assert.rejects(run(`git push origin ${itemBranch}`), /rejected|non-fast-forward|fetch first/);
  for (const command of [`git push --force origin ${itemBranch}`, `git push --force-with-lease origin ${itemBranch}`]) assert.equal(harnessDecision(harness, command).decision, 'deny', command);
  git(attempt, 'reset', '-q', '--hard', ejectedTip);
  // restore-branch pushes only the branch of the caller's live lease: from another branch, or for
  // an epoch this worker does not hold, it refuses and the remote is untouched.
  git(attempt, 'checkout', '-q', '-b', 'graphyard/elsewhere');
  await assert.rejects(run(`node ${launcher} restore-branch ${work.key} 2`), /Run restore-branch on/);
  git(attempt, 'checkout', '-q', itemBranch);
  await assert.rejects(run(`node ${launcher} restore-branch ${work.key} 1`), /lease|epoch/i);
  assert.equal(git(seed, 'ls-remote', origin, `refs/heads/${itemBranch}`).split('\t')[0], ejectedTip);

  // The restoration, exactly as the rework carries it: every step permitted by the worker's own
  // harness, run non-interactively in its worktree against the live control plane.
  const steps = branchRestoration({ cliPath: launcher, key: work.key, epoch: 2, pr, reviewedHead: reviewed });
  const outputs: string[] = [];
  for (const step of steps) {
    assert.equal(harnessDecision(harness, step).decision, 'allow', `${step} is permitted to the worker session`);
    const { stdout } = await run(step);
    outputs.push(stdout);
  }
  const synced = JSON.parse(outputs[steps.findIndex(step => / sync /.test(step))]);
  assert.equal(synced.ok, true, JSON.stringify(synced.refused));
  assert.equal(synced.baseTip, base);
  const restored = JSON.parse(outputs[steps.findIndex(step => / restore-branch /.test(step))]);
  assert.deepEqual({ branch: restored.branch, replaced: restored.replaced, head: restored.head }, { branch: itemBranch, replaced: ejectedTip, head: synced.head });

  // A submitted candidate whose head holds only the item's own change, on the current base.
  work = (await store.list()).find(item => item.id === work.id)!;
  assert.equal(work.submission?.epoch, 2);
  assert.equal(work.lease, null, 'complete ended the lease');
  work = await observed();
  const head = git(seed, 'ls-remote', origin, `refs/heads/${itemBranch}`).split('\t')[0];
  assert.equal(work.candidate?.sha, head);
  assert.equal(work.candidate?.baseSha, base);
  assert.equal(git(attempt, 'rev-parse', 'HEAD'), head, 'the pushed head is the worker\'s synced head');
  git(seed, 'fetch', '-q', origin, `+refs/heads/*:refs/remotes/after/*`);
  assert.doesNotThrow(() => git(seed, 'merge-base', '--is-ancestor', base, head), 'the head is on the current base');
  assert.doesNotThrow(() => git(seed, 'merge-base', '--is-ancestor', reviewed, head), 'the head carries the reviewed change');
  assert.throws(() => git(seed, 'merge-base', '--is-ancestor', unlanded, head), 'the other item\'s unlanded commit is gone from the ancestry');
  assert.throws(() => git(seed, 'merge-base', '--is-ancestor', ejectedTip, head), 'the ejected tip is gone from the ancestry');
  assert.deepEqual(git(seed, 'diff', '--name-only', base, head).split('\n').filter(Boolean), ['src-own.txt']);
  assert.equal(git(seed, 'show', `${head}:src-foreign.txt`), 'foreign v0');
  assert.equal(git(seed, 'show', `${head}:src-own.txt`), 'own v1');
  assert.deepEqual(work.observation?.scopeFiles?.map(file => file.path), ['src-own.txt']);
});

test('integration:unrunnable-remedy-reported — a blocker naming a command no launched session may run is reported in master status as a Graphyard defect', async () => {
  const blocked = async (title: string, reason: (branch: string) => string) => {
    let work: Work = await engine.execute(operator, 'create', null, { title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    const itemBranch = `graphyard/${work.key.toLowerCase()}-${work.epoch}`;
    work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'push-rights-host', path: join(scratch, `blocked-${title}`), branch: itemBranch }, randomUUID());
    // The worker records it through its own CLI, the way the launch instruction tells it to.
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GRAPHYARD_')));
    Object.assign(env, { GRAPHYARD_URL: url, GRAPHYARD_TOKEN: tokenOf(worker) });
    await exec(process.execPath, [launcher, 'blocked', work.key, String(work.epoch), reason(itemBranch)], { cwd: scratch, env });
    return { work: (await store.list()).find(item => item.id === work.id)!, branch: itemBranch };
  };
  const unrunnable = await blocked('force-refused', branch => `The command \`git push --force origin ${branch}\` was denied by the harness: Permission to use Bash has been denied`);
  const runnable = await blocked('lease-available', () => `\`node ${launcher} restore-branch GY-1 2\` failed: stale info; the remote moved`);
  const unquoted = await blocked('mirror-refused', () => 'git push --mirror origin was denied by the harness; nothing else can replace the refs');
  assert.deepEqual(blockerCommands(unrunnable.work.blocker!), [`git push --force origin ${unrunnable.branch}`]);
  assert.deepEqual(blockerCommands(unquoted.work.blocker!), ['git push --mirror origin']);

  const all = await store.list();
  const status = buildMasterStatus({ work: all, now: new Date().toISOString() }, [], [], {}, {}, { pending: [], completed: [] }, 'main', undefined, undefined, undefined, undefined, launcher);
  const reported = status.unrunnableRemedies.filter(entry => [unrunnable.work.key, runnable.work.key, unquoted.work.key].includes(entry.key));
  assert.deepEqual(reported.map(entry => entry.key), [unrunnable.work.key, unquoted.work.key], 'a blocker whose command the worker may run is an ordinary blocker');
  const [defect] = reported;
  assert.equal(defect.command, `git push --force origin ${unrunnable.branch}`);
  assert.equal(defect.role, 'worker');
  assert.equal(defect.rule, 'Bash(git push *--force*)');
  assert.deepEqual(defect.deniedBy.map(entry => entry.role), ['reviewer', 'producer', 'master']);
  assert.ok(defect.deniedBy.every(entry => entry.rule === 'Bash(git push:*)'));
  assert.equal(reported[1].rule, 'Bash(git push *--mirror*)');
  // The report reads as a defect with an agent owner, never as a wait on a human shell.
  const item = status.attentionItems.find(entry => entry.subject === unrunnable.work.key && /no session Graphyard launches may run/.test(entry.text))!;
  assert.ok(item, JSON.stringify(status.attentionItems));
  assert.match(item.text, new RegExp(`git push --force origin ${unrunnable.branch.replace(/[/-]/g, '\\$&')}`));
  assert.match(item.text, /worker .*Bash\(git push \*--force\*\)/);
  assert.match(item.text, /Graphyard defect, not a wait on a human shell/);
  assert.equal(item.human, false);
  assert.equal(item.role, 'master');
  assert.ok(status.counts.unrunnableRemedies >= 2);
  // The same judgement, pure: an unblocked or delivered item is never reported.
  assert.deepEqual(unrunnableRemedies([{ ...unrunnable.work, blocker: null }], { cliPath: launcher, baseBranch: 'main' }), []);
  assert.deepEqual(unrunnableRemedies([{ ...unrunnable.work, stage: 'done' }], { cliPath: launcher, baseBranch: 'main' }), []);
  // A worker runtime that loads no generated rules could run it, so nothing is reported for it.
  assert.equal(unrunnableRemedies([unrunnable.work], { cliPath: launcher, baseBranch: 'main', workerKinds: ['claude'] }).length, 1);
  assert.deepEqual(unrunnableRemedies([unrunnable.work], { cliPath: launcher, baseBranch: 'main', workerKinds: ['claude', 'codex'] }), []);
  // Nothing in the report points at a human: the item is not parked and no human request stands.
  assert.ok(!status.humanRequests.some(request => request.work === unrunnable.work.key || request.work === unrunnable.work.id));
});
