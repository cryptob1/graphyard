import { AgentRegistry } from '../src/agent-registry.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { headlessInventory } from '../src/session-inventory.js';
import { after, before } from 'node:test';
import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { loadMasterConfig, observedExhaustions, setupMaster } from '../src/master.js';
import { launchReview, readReviewLedger, reconcileReviews, saveReviewerProfile, unpostedVerdict } from '../src/reviewer.js';
import { reviewBindingFile } from '../src/review-post.js';
import { liveRun } from '../src/runner/registry.js';
import { headlessArgs, headlessKind, headlessRunsDirectory, spawnHeadless, type HeadlessExec } from '../src/headless-session.js';
import { readRunMeta, runAlive } from '../src/runner/pi.js';
import { runDaemon } from '../src/daemon/run.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { loopRunAdoption } from '../src/daemon/run-adoption.js';
import { existsSync, readdirSync } from 'node:fs';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Headless reviews: one child run of the reviewer's runtime, no Herdr pane, its
// JSON answer posted through review post's own route under the launch's token and reviewer identity.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const reviewer = 'review-claude-1';
const now = () => new Date().toISOString();
let store: Store, http: ReturnType<typeof server>, url: string;
let root: string, credentials: string, base: string, head: string;

before(async () => {
  store = await withDatabase('headless-review'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  // A master over a real repository: the base, and a head that changes one file.
  root = await temporaryDirectory('headless-review-root'); credentials = await temporaryDirectory('headless-review-credentials');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Named spec file.\n');
  git('add', 'README.md'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'feature.ts'), 'export const flag = "headless-diff-marker";\n');
  git('add', 'feature.ts'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'head');
  head = git('rev-parse', 'HEAD');
  git('checkout', '-q', base);
  // A fresh checkout (the private trial's) has no .graphyard directory yet.
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w', run: { worktreeRoot: await temporaryDirectory('headless-review-checkouts', join(process.cwd(), '.graphyard')) } });
  const config = await loadMasterConfig(root);
  await new AgentRegistry(store).mutate(coordinator, 'apply', { runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'),
    models: [{ name: 'opus', id: 'opus' }], accounts: [{ name: 'reviewer-account', runtime: 'claude', model: 'opus', credential: { host: config.hostId, home: null } }],
    roles: [{ name: 'reviewer', accounts: ['reviewer-account'], concurrency: 4, policy: { args: ['--setting-sources', 'user'] } }], reason: 'headless test registry' }, randomUUID());
  await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: reviewer, kind: 'claude', agentArgs: ['--setting-sources', 'user'] });
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (root) await rm(root, { recursive: true, force: true });
  if (credentials) await rm(credentials, { recursive: true, force: true });
});

const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
const insert = async (work: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]); return work; };
function reviewItem(key: string): Work {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The flag reads headless', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'],
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['feature.ts'], scopeFiles: [{ path: 'feature.ts', status: 'added', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } } as unknown as Work;
}
/** Every child command this launcher ran: git really runs, Herdr is a refusal, so a pane would fail the launch. */
const commands: string[][] = [];
const run = (command: string, args: string[], options?: { cwd?: string }) => {
  commands.push([command, ...args]);
  if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  throw new Error(`no ${command} here: a headless launch opens no pane`);
};
/** A fake runtime: each run answers the next of `answers`, recording what it was started with. */
function runtime(answers: string[], gate?: Promise<void>) {
  const runs: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
  const exec: HeadlessExec = async (command, args, options) => {
    runs.push({ command, args, cwd: options.cwd, env: options.env });
    await gate;
    return answers[Math.min(runs.length - 1, answers.length - 1)]!;
  };
  return { exec, runs };
}
const until = async (what: string, check: () => Promise<boolean> | boolean) => {
  for (let tries = 0; tries < 200; tries++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(`timed out waiting for ${what}`);
};
const settled = async (id: string) => {
  await until('the review run to end', async () => (await readReviewLedger(root)).reviews.some(record => record.id === id && !liveRun(record.agentName) && (record.verdict || record.state !== 'pending')));
  return (await readReviewLedger(root)).reviews.find(record => record.id === id)!;
};

test('integration:headless-review — a review request is one headless run whose JSON verdict is recorded under the reviewer identity, with no Herdr pane, while the run is listed as a working session', async () => {
  const work = await insert(reviewItem('GY-9101'));
  let open!: () => void;
  const fake = runtime([`Judged it.\n{"verdict": "APPROVE", "body": "Reviewed head ${head} against base ${base}. AC-1 met: feature.ts sets the flag.", "findings": []}`], new Promise<void>(resolve => { open = resolve; }));
  const launched = await launchReview(root, work, 'reviewer-claude', [], now(), { run, headless: fake.exec, requestId: 'headless-request-1' });
  assert.equal(launched.pane, null, 'no pane');
  assert.equal(launched.delivery, 'request');
  assert.deepEqual(commands.filter(([command]) => command !== 'git'), [], 'no Herdr command ran');
  // While it runs, the run is a working session under its name, so slots and supervision see it.
  await until('the run to start', () => fake.runs.length === 1);
  assert.deepEqual(headlessInventory().sessions.find(session => session.name === launched.agentName), { name: launched.agentName, runtime: 'claude', state: 'working', pane: null, workspace: null });
  const [running] = (await readReviewLedger(root)).reviews;
  const token = JSON.parse(await readFile(join(running!.sessionDirectory, reviewBindingFile), 'utf8')).verdictToken as string;
  const [child] = fake.runs;
  assert.equal(child!.command, 'claude');
  assert.equal(child!.args.at(-2), '-p', 'print mode, the request its last argument');
  const prompt = child!.args.at(-1)!;
  assert.match(prompt, /\[AC-1\] The flag reads headless/, 'the request names the criteria');
  assert.ok(prompt.includes(`git diff ${base} ${head}`) && prompt.includes('+export const flag = "headless-diff-marker";'), 'the request carries the exact diff');
  assert.match(prompt, /Answer in one JSON object/);
  assert.doesNotMatch(prompt, /review post --event/, 'the run posts nothing itself');
  assert.equal(child!.cwd, launched.checkout);
  assert.ok(!JSON.stringify(child).includes(token), 'the child never holds the verdict token');
  assert.equal(child!.env.GRAPHYARD_REVIEW, undefined);
  open();

  const record = await settled(launched.review);
  assert.equal(fake.runs.length, 1, 'exactly one headless run');
  assert.equal(record.pane, null);
  assert.equal(record.verdict?.reviewer, reviewer);
  assert.equal(record.verdict?.state, 'APPROVED');
  const reviewed = await stored(work.id);
  const [review] = reviewed.observation!.reviews as { reviewer: string; sha: string; state: string; source?: string; id?: number }[];
  assert.deepEqual([review!.reviewer, review!.sha, review!.state, review!.source, review!.id], [reviewer, head, 'APPROVED', 'control-plane', record.verdict!.reviewId], 'the verdict landed through the review-verdict route under the reviewer identity');
  assert.equal(reviewed.reviewLaunch!.verdict!.state, 'APPROVED');
  // The next reconcile settles it as any answered session.
  const config = await loadMasterConfig(root);
  const reconciled = await reconcileReviews(root, config, { run, work: [reviewed], agents: [] });
  assert.equal(reconciled.reviews.find(entry => entry.id === launched.review)!.state, 'completed');
  assert.deepEqual(commands.filter(([command]) => command !== 'git'), [], 'still no Herdr command');
});

test('integration:headless-review — a malformed answer is run once more with the reason; one that never parses settles as an unanswered session, and the request relaunches', async () => {
  const config = await loadMasterConfig(root);
  const work = await insert(reviewItem('GY-9102'));
  const fake = runtime(['I think it is fine.', '```json\n{"verdict": "BLOCKING", "body": "Reviewed head against base. AC-1 unmet.", "findings": ["feature.ts:1 — the flag is never read"]}\n```']);
  const launched = await launchReview(root, work, 'reviewer-claude', [], now(), { run, headless: fake.exec, requestId: 'headless-request-2' });
  const record = await settled(launched.review);
  assert.equal(fake.runs.length, 2, 'the malformed answer was retried');
  assert.match(fake.runs[1]!.args.at(-1)!, /Your previous answer was not accepted: it printed no JSON object/);
  assert.equal(record.verdict?.state, 'CHANGES_REQUESTED');
  const [review] = (await stored(work.id)).observation!.reviews as { reviewer: string; state: string; blocking?: string[] }[];
  assert.deepEqual([review!.reviewer, review!.state, review!.blocking], [reviewer, 'CHANGES_REQUESTED', ['feature.ts:1 — the flag is never read']]);
  await reconcileReviews(root, config, { run, work: [await stored(work.id)], agents: [] });

  // An answer that never parses: the record fails as a session that finished without its verdict.
  const silent = await insert(reviewItem('GY-9103'));
  const broken = runtime(['{"verdict": "MAYBE"}']);
  const first = await launchReview(root, silent, 'reviewer-claude', [], now(), { run, headless: broken.exec, requestId: 'headless-request-3' });
  const failed = await settled(first.review);
  assert.equal(broken.runs.length, 2);
  assert.equal(failed.state, 'failed');
  assert.match(failed.resolution!, unpostedVerdict, 'the dispatcher relaunches it at once, as an unanswered session');
  assert.match(failed.resolution!, /headless claude: no answer accepted after 2 runs: its JSON answer does not match: verdict/);
  assert.deepEqual((await stored(silent.id)).observation!.reviews, [], 'nothing was posted');
  // The request's next attempt launches a fresh run.
  const retry = runtime(['{"verdict": "APPROVE", "body": "Reviewed head against base. AC-1 met.", "findings": []}']);
  const second = await launchReview(root, await stored(silent.id), 'reviewer-claude', [], now(), { run, headless: retry.exec, requestId: 'headless-request-3' });
  assert.equal((await settled(second.review)).verdict?.reviewer, reviewer);
  assert.equal(retry.runs.length, 1);
  assert.deepEqual(commands.filter(([command]) => command !== 'git'), [], 'no Herdr command ran');
});

test('integration:headless-review — each runtime runs its one-shot form, and the host exec returns a child\'s output or refuses a failed one naming its error', async () => {
  assert.deepEqual(headlessArgs('codex', ['--ask-for-approval', 'never', '--sandbox', 'workspace-write', '--add-dir', '/x'], 'REQUEST'), ['exec', '--sandbox', 'workspace-write', '--add-dir', '/x', '--skip-git-repo-check', 'REQUEST'], 'codex exec takes no approval flag: it never asks');
  assert.deepEqual(headlessArgs('claude', ['--permission-mode', 'bypassPermissions'], 'REQUEST'), ['--permission-mode', 'bypassPermissions', '-p', 'REQUEST']);
  assert.deepEqual(headlessArgs('pi', ['--model', 'm', '{request}'], 'REQUEST'), ['--model', 'm', 'REQUEST', '-p'], 'a registry contract places the request itself');
  assert.equal(headlessKind('gemini'), false, 'a runtime with no one-shot form keeps its pane session');
  const options = { cwd: root, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 10_000, signal: new AbortController().signal, run: join(root, '.graphyard', 'exec-probe', randomUUID()), detached: new AbortController().signal };
  assert.equal(await spawnHeadless(process.execPath, ['-e', 'process.stdin.on("data", () => process.exit(3)); process.stdin.on("end", () => console.log("{}"))'], options), '{}\n', 'stdin is closed: nothing waits on a person');
  await assert.rejects(spawnHeadless(process.execPath, ['-e', 'console.error("limit reached"); process.exit(2)'], options), /exited with code 2: limit reached/);
});

test('integration:headless-run-survives-loop-restart — a headless review in flight when the loop stops keeps running, the stop line counts it, and the next loop posts its verdict', async () => {
  // The earlier tests' answered sessions settle first, so the profile's one slot is free.
  const pending = (await readReviewLedger(root)).reviews.filter(entry => entry.state === 'pending').map(entry => entry.key);
  const items = (await store.pool.query('SELECT document FROM work_items')).rows.map(row => row.document as Work).filter(item => pending.includes(item.key));
  await reconcileReviews(root, await loadMasterConfig(root), { run, work: items, agents: [] });
  const work = await insert(reviewItem('GY-9113'));
  // A real detached child through the host exec, holding its answer until the test releases it.
  const scratch = await temporaryDirectory('headless-loop-restart');
  const script = join(scratch, 'fake-reviewer.mjs'), release = join(scratch, 'release');
  const answer = `{"verdict": "APPROVE", "body": "Reviewed head ${head} against base ${base}. AC-1 met: feature.ts sets the flag.", "findings": []}`;
  await writeFile(script, `import { existsSync } from 'node:fs';\nwhile (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 50));\nconsole.log(${JSON.stringify(answer)});\n`);
  const exec: HeadlessExec = (_command, _args, options) => spawnHeadless(process.execPath, [script], options);
  const launched = await launchReview(root, work, 'reviewer-claude', [], now(), { run, headless: exec, requestId: 'headless-request-restart' });
  const runs = headlessRunsDirectory(root);
  await until('the detached child to start', () => existsSync(runs) && readdirSync(runs).some(name => readRunMeta(join(runs, name)) !== null));
  const [directory] = readdirSync(runs).map(name => join(runs, name));
  const meta = readRunMeta(directory!)!;
  assert.ok(runAlive(meta), 'the child is live');

  // The loop stops (as its unit's restart stops it): the line counts the run it leaves running, and signals none.
  const config = { url, repository: 'owner/project', run: { intervalSeconds: 30 } } as never;
  const effects = { persist: async () => {}, snapshot: async () => { throw new Error('the control plane is offline'); }, agents: () => [], credentials: async () => ({}) } as unknown as DaemonEffects;
  const lines: string[] = [];
  await runDaemon(config, emptyDaemonState(config), effects, { once: true, intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], log: line => lines.push(line) });
  assert.ok(lines.some(line => /stopping: left 1 headless run\(s\) running, detached/.test(line)), lines.join('\n'));
  assert.equal(liveRun(launched.agentName), null, 'the stopped loop no longer holds the run');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(runAlive(meta), 'the child survived the loop\'s stop');
  assert.equal((await readReviewLedger(root)).reviews.find(record => record.id === launched.review)!.verdict ?? null, null, 'no verdict yet');

  // The next loop adopts it on start; the child answers, and that loop posts and records its verdict.
  const next: string[] = [];
  await runDaemon(config, emptyDaemonState(config), { ...effects, adoptRuns: loopRunAdoption(root, () => config) } as unknown as DaemonEffects,
    { once: true, intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], log: line => next.push(line) });
  assert.ok(next.some(line => line.includes(`adopted 1 headless run(s): ${launched.agentName} (reviewer for GY-9113)`)), next.join('\n'));
  assert.ok(next.some(line => /stopping: left 1 headless run\(s\) running, detached/.test(line)), 'its own stop counts the adopted run too');
  const [adopted] = await loopRunAdoption(root, () => config)();
  assert.equal(adopted!.name, launched.agentName);
  assert.equal(adopted!.live, true);
  await writeFile(release, '');
  await adopted!.settled;
  const record = (await readReviewLedger(root)).reviews.find(entry => entry.id === launched.review)!;
  assert.equal(record.verdict?.state, 'APPROVED');
  assert.equal(record.verdict?.reviewer, reviewer);
  const [review] = (await stored(work.id)).observation!.reviews as { reviewer: string; sha: string; state: string; source?: string }[];
  assert.deepEqual([review!.reviewer, review!.sha, review!.state, review!.source], [reviewer, head, 'APPROVED', 'control-plane'], 'the verdict landed under the reviewer identity');
  assert.equal(existsSync(directory!), false, 'the run directory goes once its answer is recorded');
  await rm(scratch, { recursive: true, force: true });
});


test('integration:headless-review — a run that stops on its provider\'s limit notice holds the account as a pane launch does, and is not run again on it', async () => {
  const config = await loadMasterConfig(root);
  // The earlier tests' answered sessions settle first, so the profile's one slot is free.
  const pending = (await readReviewLedger(root)).reviews.filter(entry => entry.state === 'pending').map(entry => entry.key);
  const items = (await store.pool.query('SELECT document FROM work_items')).rows.map(row => row.document as Work).filter(item => pending.includes(item.key));
  await reconcileReviews(root, config, { run, work: items, agents: [] });
  const work = await insert(reviewItem('GY-9107'));
  const resetsAt = new Date(Date.now() + 3 * 3_600_000);
  const runs: string[][] = [];
  // The runtime exits non-zero with the notice on its output, as `claude -p` does on a spent account.
  const exec: HeadlessExec = async (command, args) => { runs.push([command, ...args]); throw Object.assign(new Error('claude exited with code 1'), { output: `You've hit your session limit · resets ${resetsAt.toISOString()}\n` }); };
  const launched = await launchReview(root, work, 'reviewer-claude', [], now(), { run, headless: exec, requestId: 'headless-request-7' });
  const record = await settled(launched.review);
  assert.equal(runs.length, 1, 'a spent account is not run again');
  assert.equal(record.state, 'failed');
  assert.match(record.resolution!, /stopped on its provider's limit notice: You've hit your session limit/);
  const held = (await observedExhaustions(config))['reviewer-account'];
  assert.ok(held, 'the account is held');
  assert.equal(held.until, resetsAt.toISOString());
  // The next launch skips the held account: with no other account on the profile it is refused before anything runs.
  await assert.rejects(launchReview(root, await stored(work.id), 'reviewer-claude', [], now(), { run, headless: exec, requestId: 'headless-request-7' }), /No healthy agent account for reviewer profile reviewer-claude/);
  assert.equal(runs.length, 1);
});
