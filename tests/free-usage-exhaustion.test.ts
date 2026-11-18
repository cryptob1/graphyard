import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { loadMasterConfig, saveWorkerProfile, setupMaster } from '../src/master/config.js';
import { dispatchWork, prepareWorkerLaunch, workerCommand, workerRunHandle, type WorkerRun } from '../src/master/dispatch.js';
import { detectRuntimeExhaustion } from '../src/master/runtime-prompt.js';
import { detectExhaustion } from '../src/model/capacity.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { spawnHeadless, startHeadlessSession } from '../src/headless-session.js';
import { liveRun } from '../src/runner/registry.js';
import type { Principal, Work } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';

// GY-3302: hwd-backend retried accounts across six items after `429 FreeUsageLimitError`. A
// free-usage notice is the account's exhaustion like any limit notice: held at once, before any
// other item can select it, and the work moves to an eligible account. An account whose model has
// no concrete id is flagged in master status and on the Agents page as running the runtime's default.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const freeNotice = 'Error: 429 FreeUsageLimitError: Free usage limit reached. Subscribe to OpenCode Go to keep using this model.';
let store: Store, http: ReturnType<typeof server>, registry: AgentRegistry;
let root: string, scratch: string, bin: string, url: string, hostId: string;
const homes = new Map<string, string>();

before(async () => {
  store = await withDatabase('free-usage-exhaustion'); await store.init();
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  scratch = await temporaryDirectory('free-usage-exhaustion', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  bin = await temporaryDirectory('bin', scratch);
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  http = server(engine, [coordinator, worker].map(principal => ({ ...principal, token: token(principal) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Fixture.\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const credentials = await temporaryDirectory('credentials', scratch);
  await setupMaster(root, { url, token: token(coordinator), cliPath: launcher, credentialDirectory: credentials, run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  hostId = (await loadMasterConfig(root)).hostId;
  const credentialFile = join(credentials, 'worker-a.token');
  await writeFile(credentialFile, token(worker), { mode: 0o600 });
  await saveWorkerProfile(root, { name: 'launch', principal: worker.id, agentName: 'eng-a', mode: 'launch', kind: 'claude', credentialFile }, async () => ({ actor: worker }));
  registry = new AgentRegistry(store);
});
after(async () => {
  if (http) await new Promise<void>(resolve => { http.closeAllConnections?.(); http.close(() => resolve()); });
  if (store) await store.close();
});

const api = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(coordinator)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
async function readyItem(key: string): Promise<Work> {
  const at = now();
  const work = { id: randomUUID(), key, title: `Item ${key}`, description: 'Write change.txt.', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'change.txt exists', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] } as unknown as Work;
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  return work;
}

/**
 * One registry account per entry, each with a fixture model executable for its runtime kind: it
 * leaves uncommitted work, then either prints `failure` (after `failAfterMs`, mid-run) and exits 1,
 * or commits and submits its head as the leased worker.
 */
async function configure(entries: { name: string; kind: string; failure?: string; failAfterMs?: number }[], modelId: string | null = 'fixture-model') {
  const accounts = (await registry.document(coordinator)).accounts.filter(account => !entries.some(entry => entry.name === account.name)).map(({ quota, quotaDecision, smoke, unjudged, ...account }) => ({ ...account, enabled: false }));
  const runtimes = [];
  for (const entry of entries) {
    const home = await temporaryDirectory(entry.name, scratch); homes.set(entry.name, home);
    await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-key' }));
    await mkdir(join(home, 'opencode'), { recursive: true });
    await writeFile(join(home, 'opencode/auth.json'), JSON.stringify({ anthropic: { type: 'api', key: 'fixture-key' } }));
    await writeFile(join(bin, entry.kind), `#!${process.execPath}
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const home = process.env.RUNTIME_HOME, args = process.argv.slice(2);
if (args.includes('Reply with the single word OK.')) { if (${JSON.stringify(entry.failure ?? '')}) { console.error(${JSON.stringify(entry.failure ?? '')}); process.exit(1); } console.log('OK'); process.exit(0); }
fs.appendFileSync(home + '/starts', '1');
fs.writeFileSync(home + '/started.json', JSON.stringify({ args }));
const [, key, epoch] = /complete (GY-\\d+) (\\d+) --head/.exec(args.join(' ')) ?? [];
console.log('fixture ${entry.kind} working on ' + key + ' epoch ' + epoch);
fs.writeFileSync('notes-' + epoch + '.txt', 'partial work of epoch ' + epoch + '\\n');
(async () => {
  if (${JSON.stringify(entry.failure ?? '')}) {
    await new Promise(resolve => setTimeout(resolve, ${entry.failAfterMs ?? 0}));
    console.error(${JSON.stringify(entry.failure ?? '')}); process.exit(1);
  }
  fs.writeFileSync('change.txt', 'done by ${entry.kind}\\n');
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['-c', 'user.name=w', '-c', 'user.email=w@example.invalid', 'commit', '-qm', 'work']);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const response = await fetch(process.env.GRAPHYARD_URL + '/api/work/' + key + '/submit', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GRAPHYARD_TOKEN, 'Content-Type': 'application/json', 'Idempotency-Key': key + ':' + epoch }, body: JSON.stringify({ epoch: Number(epoch), head }) });
  console.log('submitted ' + head + ' ' + response.status);
})();
`, { mode: 0o755 });
    runtimes.push({ name: entry.name, launch: { kind: entry.kind, args: [], headlessArgs: ['one-task', '--prompt', '{request}'],
      environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, homeVariable: 'RUNTIME_HOME', modelFlag: '--model' } });
    accounts.push({ enabled: true, maxSessions: null, name: entry.name, runtime: entry.name, model: 'fixture', credential: { host: hostId, home } });
  }
  await registry.mutate(coordinator, 'apply', { runtimes, accounts, models: [{ name: 'fixture', id: modelId }],
    roles: [{ name: 'worker', accounts: entries.map(entry => entry.name), concurrency: 4 }], reason: 'fixture free-usage fleet' }, randomUUID());
  await registry.observe(coordinator, { host: hostId, observations: entries.map(entry => ({ account: entry.name, quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } })) }, randomUUID());
}

const runs = new Map<string, WorkerRun>();
/** One host dispatch invocation, as the loop makes it. */
async function dispatch(work: Work) {
  const config = await loadMasterConfig(root);
  return dispatchWork(root, work, config.workers[0]!, { allWork: [work], observedAt: now(), headless: spawnHeadless,
    prepare: (at, key, profile, _run, claimBy, keep, cycle) => prepareWorkerLaunch(at, key, profile, (command, args, options) => command === 'git' && args[0] === 'fetch' ? '' : workerCommand(command, args, options), claimBy, keep, cycle),
    capacity: async event => { const result = await api('POST', `work/${work.id}/capacity`, event); assert.equal(result.status, 200, JSON.stringify(result.body)); },
    onRun: async run => { runs.set(work.id, run); const result = await api('POST', `work/${work.id}/session`, workerRunHandle(work, config.workers[0]!, hostId, run)); assert.equal(result.status, 200, JSON.stringify(result.body)); } });
}
async function until<T>(what: string, read: () => Promise<T | null | undefined | false>): Promise<T> {
  for (let tries = 0; tries < 600; tries++) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`never: ${what}`);
}
async function submitted(id: string, epoch: number) {
  const item = await until(`${id} epoch ${epoch} submitted`, async () => { const item = await stored(id); return item.submission?.epoch === epoch && !liveRun('eng-a') && item; });
  // The loop marks the ended run finished (daemon/cycle.ts), which frees its registry session for the next item.
  const result = await api('POST', `work/${id}/session`, workerRunHandle(item, (await loadMasterConfig(root)).workers[0]!, hostId, { ...runs.get(id)!, outcome: 'submitted' }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return item;
}
const starts = async (name: string) => (await readFile(join(homes.get(name)!, 'starts'), 'utf8').catch(() => '')).length;
const account = async (name: string) => (await registry.snapshot(hostId)).accounts.find(entry => entry.name === name)!;

test('e2e:free-usage-exhaustion — the shared classifier reads 429 FreeUsageLimitError as exhaustion, keeps a named reset, and never a generic 429 or network failure', () => {
  const at = Date.parse('2030-01-01T00:00:00Z');
  for (const runtime of ['opencode', 'pi', 'claude', 'codex', null]) {
    const notice = detectRuntimeExhaustion(`working on GY-1\n${freeNotice}\n`, runtime, at);
    assert.ok(notice, `${runtime ?? 'an unnamed runtime'} reads the free-usage notice`);
    assert.equal(notice.resetsAt, null, 'a notice naming no reset is not given a fabricated one');
    assert.ok(detectRuntimeExhaustion('AI_APICallError: 429 FreeUsageLimitError\n', runtime, at), 'the bare error name is the provider speaking');
  }
  assert.ok(detectExhaustion(`${freeNotice}\n`, at), 'a pane session reads it too');
  assert.equal(detectRuntimeExhaustion('Free usage limit reached. Resets in 2h.\n', 'opencode', at)?.resetsAt, new Date(at + 2 * 3_600_000).toISOString(), 'an explicit reset is respected');
  for (const unrelated of ['Error: 429 Too Many Requests', 'Error: fetch failed: ECONNRESET', 'Error: 503 Service Unavailable', 'I read about the free usage limit reached by other users in the docs and moved on.'])
    assert.equal(detectRuntimeExhaustion(`${unrelated}\n`, 'opencode', at), null, `no exhaustion without a quota notice: ${unrelated}`);
});

test('e2e:free-usage-exhaustion — a worker account that prints 429 FreeUsageLimitError is held before any other item selects it; six queued items never repeat it', async () => {
  await configure([{ name: 'free-tier', kind: 'opencode', failure: `fixture opencode starting\n${freeNotice}` }, { name: 'paid', kind: 'muse' }]);
  const items = await Promise.all([1, 2, 3, 4, 5, 6].map(index => readyItem(`GY-97${index}0`)));
  const first = await dispatch(items[0]!);
  // Within the one dispatch: the free-tier run ended on its notice, its account was held, and the successor took the item.
  assert.equal(await starts('free-tier'), 1);
  assert.equal(first.runtime, 'muse');
  assert.equal(first.epoch, 2);
  const held = await account('free-tier');
  assert.equal(held.eligible, false, 'the free-tier account is held');
  assert.equal(held.quota, 'exhausted');
  assert.equal(held.resetUnknown, true, 'its reset reads unknown: the notice named none');
  assert.match(held.evidence ?? '', /FreeUsageLimitError.*reset unknown, held until /);
  assert.match(renderToStaticMarkup(createElement((await import('../web/pages/fleet.js')).AccountCard, { account: held })), /Resets: unknown \(held until /);
  const exhaustion = (await stored(items[0]!.id)).capacity?.exhaustions?.find(entry => entry.epoch === 1);
  assert.equal(exhaustion?.account, 'free-tier');
  assert.match(exhaustion?.reason ?? '', /FreeUsageLimitError/);
  assert.equal(exhaustion?.resetsAt, null);
  assert.equal(exhaustion?.partialWork?.state, 'committed', 'the first run\'s work is retained on its branch');
  await submitted(items[0]!.id, 2);
  for (const item of items.slice(1)) {
    const launched = await dispatch(item);
    assert.equal(launched.runtime, 'muse', `${item.key} starts on the eligible account`);
    assert.equal(launched.epoch, 1, `${item.key} never tried the held account first`);
    await submitted(item.id, 1);
  }
  assert.equal(await starts('free-tier'), 1, 'the free-tier account started once across all six items');
  assert.equal(await starts('paid'), 6);
});

test('e2e:free-usage-exhaustion — a quota notice mid-run keeps the work, holds the account until its named reset, and the successor resumes it', async () => {
  await configure([{ name: 'midrun', kind: 'muse', failure: 'Error: 429 FreeUsageLimitError: Free usage limit reached. Try again in 3h.', failAfterMs: 11_000 }, { name: 'after', kind: 'opencode' }]);
  const work = await readyItem('GY-9790');
  const launched = await dispatch(work);
  assert.equal(launched.runtime, 'muse', 'the run outlived its startup observation');
  const exhaustion = await until('the mid-run notice is recorded', async () => (await stored(work.id)).capacity?.exhaustions?.find(entry => entry.epoch === 1 && entry.account === 'midrun'));
  assert.equal(exhaustion.partialWork?.state, 'committed', 'the work done before the notice is kept');
  const resetsAt = Date.parse(exhaustion.resetsAt!);
  assert.ok(Math.abs(resetsAt - (Date.now() + 3 * 3_600_000)) < 60_000, `the named reset is respected: ${exhaustion.resetsAt}`);
  const held = await account('midrun');
  assert.equal(held.eligible, false);
  assert.equal(held.resetsAt, exhaustion.resetsAt);
  assert.equal(held.resetUnknown, false);
  await until('the run ended', async () => !liveRun('eng-a'));
  const next = await dispatch(await stored(work.id));
  assert.equal(next.runtime, 'opencode');
  assert.equal(next.epoch, 2);
  const brief = (JSON.parse(await readFile(join(homes.get('after')!, 'started.json'), 'utf8')).args as string[]).join(' ');
  assert.ok(brief.includes(exhaustion.partialWork!.commit!.slice(0, 12)), 'the successor brief names the retained commit');
  await submitted(work.id, 2);
  assert.equal(await starts('midrun'), 1);
});

test('e2e:free-usage-exhaustion — an unrelated 429 is no exhaustion: the account stays selectable', async () => {
  await configure([{ name: 'flaky', kind: 'opencode', failure: 'Error: 429 Too Many Requests' }, { name: 'spare', kind: 'muse' }]);
  const work = await readyItem('GY-9795');
  await assert.rejects(dispatch(work), /exited at once/);
  const flaky = await account('flaky');
  assert.equal(flaky.eligible, true, 'a generic 429 holds nothing');
  assert.notEqual(flaky.quota, 'exhausted');
  assert.equal((await stored(work.id)).capacity?.exhaustions?.length ?? 0, 0);
});

test('e2e:free-usage-exhaustion — a reviewer stopped on a free-usage notice holds its account and the review runs on the next', async () => {
  const directory = await temporaryDirectory('review', scratch), reviewBin = await temporaryDirectory('review-bin', scratch), nextBin = await temporaryDirectory('review-next', scratch);
  await writeFile(join(reviewBin, 'pi'), `#!/bin/sh\necho "fixture pi reviewing"\necho ${JSON.stringify(freeNotice)} >&2\nexit 1\n`, { mode: 0o755 });
  await writeFile(join(nextBin, 'pi'), '#!/bin/sh\necho \'{"verdict":"approve"}\'\n', { mode: 0o755 });
  const holds: { reason: string; resetsAt: string | null }[] = [], moves: string[] = [];
  const session = await startHeadlessSession({ name: 'review-free', work: 'GY-9799', subject: 'review', kind: 'pi', account: 'pi-free', args: [], environment: { PATH: `${reviewBin}:/usr/bin:/bin` },
    directory, root, route: 'review', context: {}, prompt: 'Review GY-9799.', exec: spawnHeadless,
    holdAccount: async notice => { holds.push(notice); },
    moveAccount: async (reason, cause) => { moves.push(`${cause}: ${reason}`); return { kind: 'pi', account: 'pi-paid', args: [], environment: { PATH: `${nextBin}:/usr/bin:/bin` } }; },
    answer: async output => JSON.parse(output.trim()).verdict as string });
  assert.equal(await session.settled, 'approve');
  assert.equal(holds.length, 1);
  assert.match(holds[0]!.reason, /FreeUsageLimitError/);
  assert.equal(holds[0]!.resetsAt, null);
  assert.equal(moves.length, 1);
  assert.match(moves[0]!, /^limit: /);
});

test('e2e:free-usage-exhaustion — an account whose model has no id is flagged as the runtime default in master status and the Agents page', async () => {
  await configure([{ name: 'unpinned', kind: 'opencode' }], null);
  const fleet = await registry.snapshot(hostId);
  const unpinned = fleet.accounts.find(entry => entry.name === 'unpinned')!;
  assert.equal(unpinned.modelId, null);
  const { unspecifiedModelAttention } = await import('../src/cli/master-status.js');
  const lines = unspecifiedModelAttention(fleet);
  assert.equal(lines.length, 1, 'only the enabled account serving a role is flagged');
  assert.equal(lines[0]!.subject, 'account unpinned');
  assert.match(lines[0]!.text, /no model id, so runtime unpinned picks its own default model, which may be a free model/);
  assert.match(lines[0]!.text, /may be unknown/, 'the actual provider and model are not asserted');
  assert.match(lines[0]!.next, /model set fixture --id ID/);
  const { AccountCard } = await import('../web/pages/fleet.js');
  const card = renderToStaticMarkup(createElement(AccountCard, { account: unpinned }));
  assert.match(card, /runtime default model/);
  assert.match(card, /data-default-model/);
  const pinned = renderToStaticMarkup(createElement(AccountCard, { account: { ...unpinned, modelId: 'glm-5.3' } }));
  assert.doesNotMatch(pinned, /data-default-model/);
  assert.deepEqual(unspecifiedModelAttention({ accounts: [{ ...unpinned, modelId: 'glm-5.3' }] }), []);
});
