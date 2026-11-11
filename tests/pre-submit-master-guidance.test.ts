import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { dispatchWork, loadMasterConfig, setupMaster, type WorkerProfile } from '../src/master.js';
import type { FleetClient } from '../src/fleet.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { recordedRuns } from './helpers/headless-runs.js';

// Master guidance applied before an item's first submission reaches the next attempt's own request:
// real work in Postgres, the real launcher, and the headless worker run's request (GY-3259).

async function fixture() {
  const holder = await temporaryDirectory('session-resume'), root = join(holder, 'repository'), credentials = join(holder, 'credentials');
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials, herdrWorkspace: 'w1V' }, coordinatorStatus);
  const master = await loadMasterConfig(root), hostId = master.hostId ?? 'unknown-host';
  const credentialFile = join(holder, 'worker.token');
  await writeFile(credentialFile, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(dirname(master.credentialFile), { recursive: true });
  const profile: WorkerProfile = { name: 'claude-worker', principal: 'graphyard-worker-1', agentName: 'eng-claude', mode: 'launch', kind: 'claude', credentialFile, agentArgs: [], approvals: 'auto', environment: {} };
  let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', { runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: hostId, home: null } }, { name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: hostId, home: null } }],
    roles: [{ name: 'worker', accounts: ['claude-a', 'claude-b'], concurrency: 4 }], reason: 'fixture' }, { actor: 'operator', at: new Date().toISOString() }).registry;
  // An account marked limited is one the registry passes over, as it does a spent quota.
  const limited = new Set<string>();
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      const choice = chooseSession(registry, { ...request, exclude: [...request.exclude ?? [], ...limited] }, Date.now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const session: FleetSession = { id: `session-${registry.sessions.length + 1}`, role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: new Date().toISOString(), selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry = { ...registry, sessions: [...registry.sessions, session] };
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    // Every session ends with its attempt, so each dispatch chooses the role's first free account.
    end: async () => {},
  };
  const endSessions = () => { registry = { ...registry, sessions: [] }; };
  /** Dispatch `work` as attempt `epoch` in its own worktree; `release` records any claim given back. */
  const dispatch = async (work: any, epoch: number, claim?: () => Promise<Work>) => {
    endSessions();
    const at = new Date().toISOString(), path = join(root, `GY-1-${epoch}`), runs = recordedRuns();
    await mkdir(path, { recursive: true });
    let claims = 0;
    const prepare = async () => { claims++; return { epoch, path, base: 'c'.repeat(40), ...(claim ? { work: await claim() } : {}) }; };
    const dispatched = await dispatchWork(root, { ...work, epoch: epoch - 1 }, profile, { allWork: [work], prepare, release: async () => {}, observedAt: at, headless: runs.exec,
      probe: { registry: client, quota: false, cacheMs: 0, now: () => Date.parse(at) } as never });
    return { dispatched, claims, request: runs.runs[0]!.request };
  };
  return { root, limited, dispatch };
}

for (const proof of ['integration:pre-submit-master-guidance', 'e2e:pre-submit-master-guidance']) test(`${proof} — applied guidance reaches a real never-submitted retry's headless run request on any account`, async () => {
  let store: Store | undefined;
  const policy = repositoryPolicy();
  setRepositoryPolicy({ ...policy, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
  try {
    store = await withDatabase('session-resume'); await store.init();
    const engine = new Engine(store, 7200, 'owner/project');
    engine.operatorAuthorizer = async (_db, _now, actor) => actor;
    const master: Principal = { id: 'graphyard-master-project-operator', role: 'operator-agent', scope: { repositories: ['owner/project'], workItems: ['*'] } };
    const worker: Principal = { id: 'graphyard-worker-1', role: 'worker' };
    let work = await engine.execute(master, 'create', null, { reason: 'Exercise retry guidance', title: 'Verify preserved work', type: 'chore', criteria: [{ id: 'AC-1', text: 'Guidance reaches retries', proofs: ['integration:pre-submit-master-guidance', 'e2e:pre-submit-master-guidance'] }] }, randomUUID());
    work = await engine.execute(master, 'ready', work.id, { reason: 'Ready for retry guidance regression', expectedRevision: work.revision }, randomUUID());
    const { dispatch, limited } = await fixture();
    const claim = () => engine.execute(worker, 'claim', work.id, {}, randomUUID());
    const first = await dispatch(work, 1, claim);
    assert.equal(first.claims, 1);
    const guidance = 'Verify the preserved source head; operator handles private-container test placement. Do not repeat the scratch Git push.';
    work = await engine.execute(master, 'rework', work.id, { reason: 'Superseded operational instruction', previousWorkerStopped: true }, randomUUID());
    work = await engine.execute(master, 'rework', work.id, { reason: guidance, previousWorkerStopped: true }, randomUUID());
    work = (await store.list()).find(item => item.id === work.id)!;
    assert.equal(work.submission, null, 'guidance is recorded before any submission');
    const appliedAt = work.lastRework!.at;
    const retry = await dispatch(work, 2, claim);
    const assertGuidance = (request: string, epoch: number) => {
      assert.equal(request.split(guidance).length - 1, 1, 'the actual runtime request includes the latest applied instruction exactly once');
      assert.ok(request.includes(appliedAt), 'the guidance names its applied time');
      assert.ok(request.includes(`Applied master guidance for ${work.key} before its first submission`));
      assert.ok(request.includes(`complete ${work.key} ${epoch} --head`), 'the request names its own attempt');
      assert.ok(request.includes('a new source commit is not required'));
      assert.ok(!request.includes('Superseded operational instruction'));
      assert.doesNotMatch(request, /rework round of change #|resubmitting the same head answers nothing|Answer every point it names with a new commit/);
    };
    assertGuidance(retry.request, 2);
    // Another account carries the same applied guidance.
    work = await engine.execute(worker, 'release', work.id, { epoch: 2 }, randomUUID());
    limited.add('claude-a');
    const next = await dispatch(work, 3, claim);
    assert.equal(next.dispatched.account?.environment, 'claude-b');
    assertGuidance(next.request, 3);
  } finally {
    setRepositoryPolicy(policy);
    await store?.close();
  }
});
