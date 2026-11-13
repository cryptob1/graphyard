import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import { spawnHeadless, startHeadlessSession, startHeadlessWorker, workerRunsDirectory } from '../src/headless-session.js';
import { collectUsage } from '../src/usage-capture.js';
import type { CostSummary } from '../src/model/token-costs.js';
import type { Principal, Work } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { CostsView, ItemCostsView } from '../web/pages/costs.js';

// GY-3289: a fixture install whose stub runtimes report usage the way the real ones do — a Codex
// worker's `turn.completed` event, a Claude Code reviewer's `result` object, the master session's
// Claude Code transcript, and a Muse worker that reports nothing — through the real headless
// runner, run log, loop report and control plane. The Costs section, the item page and
// `master usage` then show the tokens and their cost from the registry's price sheet.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `coordinator-token-${'x'.repeat(32)}`;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const exec = promisify(execFile);
let store: Store, http: ReturnType<typeof server>, url: string, root: string, scratch: string, bin: string;

before(async () => {
  store = await withDatabase('project-token-costs'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  scratch = await temporaryDirectory('project-token-costs', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch); bin = await temporaryDirectory('bin', scratch);
  execFileSync('git', ['-C', root, 'init', '-q', '--initial-branch=main']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/owner/project.git']);
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: await temporaryDirectory('credentials', scratch), run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  const host = (await loadMasterConfig(root)).hostId, account = (name: string, runtime: string, model: string, extra = {}) => ({ name, runtime, model, credential: { host, home: null }, ...extra });
  const launch = (kind: string) => ({ name: kind, launch: { kind, args: [], environment: {}, homeVariable: null, modelFlag: null, login: null, loginFile: null } });
  // The price sheet: two priced models with the day their prices were read, and one nobody priced.
  await new AgentRegistry(store).mutate(coordinator, 'apply', { runtimes: ['claude', 'codex', 'muse'].map(launch),
    models: [
      { name: 'opus', id: 'claude-opus-5-5', cost: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5, asOf: new Date().toISOString().slice(0, 10) } },
      { name: 'gpt', id: 'gpt-5.6-sol', cost: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.4, cacheWritePerMTok: 5, asOf: new Date().toISOString().slice(0, 10) } },
      { name: 'ember', id: null },
    ],
    accounts: [account('codex-api', 'codex', 'gpt'), account('claude-max', 'claude', 'opus', { plan: 'Claude Max', monthlyFee: 200 }), account('claude-api', 'claude', 'opus'), account('muse-sub', 'muse', 'ember')],
    roles: [], reason: 'token cost fixture' }, randomUUID());
});
after(async () => {
  if (http) await new Promise<void>(resolve => { http.closeAllConnections?.(); http.close(() => resolve()); });
  if (store) await store.close();
});

const stub = (name: string, lines: unknown[]) => writeFile(join(bin, name), `#!${process.execPath}\nfor (const line of ${JSON.stringify(lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)))}) console.log(line);\n`, { mode: 0o755 });
const until = async (what: string, done: () => boolean | Promise<boolean>) => { for (let tries = 0; tries < 400; tries++) { if (await done()) return; await new Promise(resolve => setTimeout(resolve, 50)); } assert.fail(`timed out waiting for ${what}`); };
const costs = async (query = ''): Promise<CostSummary> => (await fetch(`${url}/api/costs${query}`, { headers: { Authorization: `Bearer ${coordinatorToken}` } })).json() as Promise<CostSummary>;

test('e2e:project-token-costs — the Costs section, the item page and master usage show what a worker, a reviewer and the master session spent, priced from the registry\'s price sheet', async () => {
  // A delivered item the worker and the reviewer ran for.
  const at = new Date().toISOString(), key = 'GY-9801', checkout = await temporaryDirectory('worktree', scratch);
  const work = { id: randomUUID(), key, title: 'Priced item', description: 'd', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'done', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, stage: 'done', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate: null,
    submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [] } as unknown as Work;
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);

  // The stub runtimes: each prints what the real one prints of its own usage.
  await stub('codex', [{ type: 'thread.started', thread_id: 't' }, { type: 'item.completed', item: { type: 'agent_message', text: 'Committed and submitted.' } },
    { type: 'turn.completed', usage: { input_tokens: 1_200_000, cached_input_tokens: 200_000, output_tokens: 100_000 } }]);
  const verdict = '{"verdict": "APPROVE", "body": "AC-1 met.", "findings": []}';
  await stub('claude', [{ type: 'result', subtype: 'success', is_error: false, result: verdict, usage: { input_tokens: 100_000, output_tokens: 50_000 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 100_000, outputTokens: 50_000, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 200_000, costUSD: 9 } } }]);
  await stub('muse', ['Done: no usage line, as Muse prints none.']);
  // The worker's supervisor here only keeps the run log, as `graphyard watch` does around the runtime.
  const supervisor = join(scratch, 'log-supervisor.mjs');
  await writeFile(supervisor, `import { spawn } from 'node:child_process';\nimport { runLogLines } from ${JSON.stringify(fileURLToPath(new URL('../src/session-watch.ts', import.meta.url)))};\nconst [command, ...args] = process.argv.slice(3);\nconst child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });\nfor (const stream of ['stdout', 'stderr']) runLogLines(child[stream], stream, process.env.GRAPHYARD_RUN_LOG);\nchild.on('close', code => process.exit(code ?? 1));\n`);
  const environment = { PATH: `${bin}:/usr/bin:/bin`, CODEX_HOME: await temporaryDirectory('codex-home', scratch), CLAUDE_CONFIG_DIR: await temporaryDirectory('claude-home', scratch) };
  const worker = (kind: string, account: string, args: string[]) => startHeadlessWorker({ name: `eng-${kind}`, work: key, subject: `${key}: Priced item`, epoch: 1, principal: 'worker-a', account, kind, args, environment,
    directory: checkout, supervisor: [process.execPath, '--import', 'tsx', supervisor, '--'], prompt: 'Implement it.', root, exec: spawnHeadless, timeoutMs: 60_000, startupMs: 100 });
  const runs = [await worker('codex', 'codex-api', ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']), await worker('muse', 'muse-sub', ['--approval-mode', 'never', '--trust-workspace'])];
  await until('the worker runs to end', () => runs.every(run => existsSync(join(workerRunsDirectory(root), run.id, 'exit'))));

  // The reviewer: one headless session whose JSON report wraps its verdict; the answer posted is the verdict itself.
  const review = await startHeadlessSession({ name: 'review-claude-1', work: key, subject: 'review-1', kind: 'claude', account: 'claude-max', args: ['--permission-mode', 'bypassPermissions'], environment,
    directory: checkout, prompt: 'Review it.', answer: async output => output, root, route: 'review', context: {}, exec: spawnHeadless });
  assert.equal((await review.settled).trim(), verdict, 'the reviewer\'s answer is read out of its runtime\'s JSON report');

  // The master session's own transcript: Claude Code repeats a message's usage on each of its rows.
  const transcript = join(scratch, 'master.jsonl'), message = (id: string, usage: object) => JSON.stringify({ type: 'assistant', uuid: randomUUID(), timestamp: at, message: { id, model: 'claude-experimental-1', usage } });
  await writeFile(transcript, [message('m1', { input_tokens: 1000, output_tokens: 500 }), message('m1', { input_tokens: 1000, output_tokens: 500 }), message('m2', { input_tokens: 2000, output_tokens: 1500 }), ''].join('\n'));
  const master = { launch: 'l', runtime: 'claude', account: 'claude-api', nativeId: 'native-1', transcript, record: transcript, origins: transcript, predecessor: null, supersededBy: null };

  // The loop's report, as its cycle makes it.
  await collectUsage(root, await loadMasterConfig(root), master, { now: Date.now() });
  assert.deepEqual(await readdir(join(root, '.graphyard', 'usage-outbox')), [], 'a reported review run is not reported again');

  const summary = await costs();
  const all = summary.windows.all;
  assert.deepEqual([all.input, all.output, all.cacheRead, all.cacheWrite], [1_000_000 + 100_000 + 3000, 100_000 + 50_000 + 2000, 200_000 + 1_000_000, 200_000], 'every session\'s tokens, the master\'s repeated message once');
  assert.equal(all.cost.toFixed(2), '8.68', 'the worker at 4/20/0.4 and the reviewer at 4/20/0.2/5 per million');
  assert.equal(all.apiEquivalent.toFixed(2), '2.60', 'the flat-plan reviewer account\'s part');
  assert.equal(all.unpriced, 5000, 'the master\'s model has no price: unknown, never zero');
  assert.equal(all.notReported, 1, 'the Muse run reported nothing');
  assert.deepEqual([all.shipped, all.perShipped?.toFixed(2)], [1, '8.68']);
  assert.deepEqual({ ...summary.windows.today, name: 'all' }, all, 'everything was spent today');
  assert.deepEqual(summary.roles.map(line => [line.name, line.cost.toFixed(2)]), [['Workers', '6.08'], ['Reviewers', '2.60'], ['Master', '0.00']]);
  assert.deepEqual(summary.models.map(line => line.name), ['gpt', 'opus', 'claude-experimental-1', 'ember']);
  assert.deepEqual(summary.accounts.map(line => [line.name, line.flat, line.monthlyFee]), [['codex-api', false, null], ['claude-max', true, 200], ['claude-api', false, null], ['muse-sub', false, null]]);

  // The dashboard's Costs section.
  const page = renderToStaticMarkup(createElement(CostsView, { costs: summary, error: '', now: Date.now() })).replace(/<!-- -->/g, '');
  for (const text of ['$8.68', '2.65M tokens', '$2.60 API-equivalent', 'price unknown for 5,000', '$8.68 per shipped item (1)', 'Those plans cost $200 a month', 'By role', 'By model', 'By account',
    '$2.60 API-equivalent · plan $200/month', '1 session not reported', 'Price sheet']) assert.ok(page.includes(text), `the Costs section shows ${text}`);
  assert.match(page, /data-cost-line="claude-experimental-1">.*?<td>price unknown<\/td>/, 'the unpriced model reads price unknown');
  assert.match(page, /data-price="ember">.*?price unknown/, 'a model without a price is listed as such, and due a check');

  // The item page's own figures.
  const item = renderToStaticMarkup(createElement(ItemCostsView, { costs: await costs(`?work=${key}`) })).replace(/<!-- -->/g, '');
  for (const text of ['Tokens and cost', '$8.68 ($2.60 API-equivalent)', 'Workers: 1.30M tokens · $6.08', 'Reviewers: 1.35M tokens · $2.60 API-equivalent']) assert.ok(item.includes(text), `the item page shows ${text}`);
  assert.ok(!item.includes('Master'), 'the master session belongs to no item');

  // `master usage`.
  const { stdout } = await exec(process.execPath, [launcher, 'master', 'usage', '--days', '7'], { cwd: root });
  for (const text of ['All time: 2.65M tokens', '$8.68 ($2.60 API-equivalent) · price unknown for 5,000 tokens', '$8.68 per shipped item (1)', 'the plans cost $200/month', 'By role, last 7 days:', 'Workers: 1.30M tokens',
    'claude-experimental-1: 5,000 tokens (3,000 in, 2,000 out, 0 cache read, 0 cache write) · price unknown', 'claude-max: 1.35M tokens', '$2.60 API-equivalent · plan $200/month', 'ember: price unknown', 'opus (claude-opus-5-5): 4 / 20 / 0.2 / 5 as of'])
    assert.ok(stdout.includes(text), `master usage shows ${text}:\n${stdout}`);
});
