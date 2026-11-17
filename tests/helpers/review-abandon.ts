// GY-3428: a real control plane, the real dispatch tick and headless fixture runtimes, for the
// tests of a review request the loop abandoned and `master review` relaunching it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './postgres.js';
import { temporaryDirectory } from './temp-dirs.js';
import { AgentRegistry } from '../../src/agent-registry.js';
import { Engine } from '../../src/engine.js';
import { loadMasterConfig, setupMaster } from '../../src/master/config.js';
import type { Principal, Work } from '../../src/model.js';
import { registeredReview } from '../../src/master/autonomy.js';
import { readReviewLedger, saveReviewerProfile, updateReviewLedger, type ReviewRecord } from '../../src/reviewer.js';
import { liveRun } from '../../src/runner/registry.js';
import { spawnHeadless } from '../../src/headless-session.js';
import { headlessInventory } from '../../src/session-inventory.js';
import { runDispatchTick } from '../../src/dispatch/tick.js';
import { emptyDispatchCursor, type DispatchCursor } from '../../src/dispatch/cursor.js';
import { dispatchEffects } from '../../src/dispatch/effects.js';
import { server } from '../../src/server.js';
import type { Store } from '../../src/store.js';

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url));

export async function reviewAbandonHarness(name: string) {
  const store: Store = await withDatabase(name); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  const http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory(name, join(process.cwd(), '.graphyard'));
  const root = await temporaryDirectory('coordinator', scratch), bin = await temporaryDirectory('bin', scratch);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Named spec file.');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'Dockerfile'), 'export const flag = "held";');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'head');
  const head = git('rev-parse', 'HEAD'); git('checkout', '-q', base);
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: await temporaryDirectory('credentials', scratch), herdrWorkspace: 'w', run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  const hostId = (await loadMasterConfig(root)).hostId;
  const registry = new AgentRegistry(store);
  await saveReviewerProfile(root, { name: 'reviewer', agentName: 'independent-reviewer', kind: 'claude', agentArgs: [] });

  const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
  const mutate = async (path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${coordinatorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };

  /** An item in review whose head holds one live review request. */
  async function insertReviewItem(key: string) {
    const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
    const request = { id: randomUUID(), kind: 'review' as const, provider: 'github' as const, reason: 'fixture needs independent review', pr: 7, sha: head, baseSha: base, policyRevision: 1, state: 'requested' as const, requestedAt: now() };
    const work = { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
      criteria: [{ id: 'AC-1', text: 'The flag reads held', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
      stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
      workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
      scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'],
      autoDispatch: { review: request, producers: [], history: [] },
      observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
        files: ['Dockerfile'], scopeFiles: [{ path: 'Dockerfile', status: 'added', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } } as unknown as Work;
    await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
    return work;
  }

  /** The reviewer accounts: each a fixture model executable that fails at once with `failure`, or approves. */
  async function configure(entries: { name: string; kind: string; failure?: string }[]) {
    const accounts = (await registry.document(coordinator)).accounts.filter(account => !entries.some(entry => entry.name === account.name)).map(({ quota, quotaDecision, smoke, unjudged, ...account }) => ({ ...account, enabled: false }));
    const runtimes = [];
    for (const entry of entries) {
      const home = await temporaryDirectory(entry.name, scratch);
      await writeFile(join(home, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-key' } }));
      await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-key', anthropic: { type: 'api', key: 'fixture-key' } }));
      await mkdir(join(home, 'opencode'));
      await writeFile(join(home, 'opencode/auth.json'), JSON.stringify({ anthropic: { type: 'api', key: 'fixture-key' } }));
      await writeFile(join(bin, entry.kind), `#!${process.execPath}
if (${JSON.stringify(entry.failure ?? '')}) { console.error(${JSON.stringify(entry.failure ?? '')}); process.exit(1); }
console.log(JSON.stringify({ verdict: 'APPROVE', body: 'Reviewed head ${head} against base ${base}. AC-1 met.', findings: [] }));
`, { mode: 0o755 });
      runtimes.push({ name: entry.name, launch: { kind: entry.kind, args: [], headlessArgs: ['one-task', '--prompt', '{request}'],
        environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, homeVariable: 'RUNTIME_HOME', modelFlag: '--model', toolsFlag: '--tools' } });
      accounts.push({ enabled: true, maxSessions: null, name: entry.name, runtime: entry.name, model: 'fixture', credential: { host: hostId, home } } as never);
    }
    await registry.mutate(coordinator, 'apply', { runtimes, accounts, models: [{ name: 'fixture', id: 'fixture-model' }],
      roles: [{ name: 'reviewer', accounts: entries.map(entry => entry.name), concurrency: 4, policy: { args: [], tools: ['read'] } }], reason: 'fixture runtime matrix' }, randomUUID());
    await registry.observe(coordinator, { host: hostId, observations: entries.map(entry => ({ account: entry.name, quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } })) }, randomUUID());
  }

  /** Sessions already recorded failed for the item's request, each `ranMs` long, ending `minutesAgo` before now. */
  async function recordFailures(work: Work, count: number, ranMs: number, resolution: string) {
    const request = (await stored(work.id)).autoDispatch!.review!;
    await updateReviewLedger(root, ledger => {
      for (let attempt = 1; attempt <= count; attempt++) {
        const closedAt = Date.now() - (count - attempt + 1) * 60 * 60_000, requestedAt = closedAt - ranMs;
        ledger.reviews.push({ id: randomUUID(), key: work.key, pr: 7, sha: head, baseSha: base, policyRevision: 1, profile: 'reviewer', agentName: `independent-reviewer-${attempt}`, pane: null,
          sessionDirectory: join(root, '.graphyard', 'gone-sessions', randomUUID()), requestedAt: new Date(requestedAt).toISOString(), tokenExpiresAt: new Date(requestedAt + 3_600_000).toISOString(),
          state: 'failed', closedAt: new Date(closedAt).toISOString(), resolution, requestId: request.id, attempt, mode: 'control-plane' } as ReviewRecord);
      }
    });
    return request;
  }

  /** One dispatch tick over the stored item. */
  async function tick(work: Work, cursor: DispatchCursor) {
    const config = await loadMasterConfig(root);
    const run = (command: string, args: string[], options?: { cwd?: string }) => execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
    const effects = dispatchEffects(root, config, { snapshot: async () => ({ work: [await stored(work.id)], now: now() }), mutate, run, headless: spawnHeadless });
    effects.inventory = async () => headlessInventory();
    return runDispatchTick(config, cursor, effects);
  }

  /** `master review GY-N` from the confined master session, which never launches a reviewer itself. */
  async function masterReview(work: Work) {
    const config = await loadMasterConfig(root);
    process.env.GRAPHYARD_CONFINEMENT = 'master';
    try { return await registeredReview(config, [work.key], { work: [await stored(work.id)] }, mutate, async () => assert.fail('the confined master launched a reviewer itself')); }
    finally { delete process.env.GRAPHYARD_CONFINEMENT; }
  }

  /** The item's review record for `requestId` once its run has ended. */
  async function settled(key: string, requestId: string) {
    for (let tries = 0; tries < 400; tries++) {
      const record = (await readReviewLedger(root)).reviews.find(entry => entry.key === key && entry.requestId === requestId);
      if (record && !liveRun(record.agentName) && (record.verdict || record.state !== 'pending')) return record;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return assert.fail('the review did not settle');
  }

  const cursor = async () => emptyDispatchCursor(await loadMasterConfig(root));
  const close = async () => { await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); };
  return { root, configure, insertReviewItem, recordFailures, tick, masterReview, settled, stored, cursor, close };
}
