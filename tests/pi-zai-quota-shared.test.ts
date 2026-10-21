import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { observeAccount } from '../src/fleet.js';
import { loadMasterConfig, setupMaster, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, failoverKey, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';
import { accountIneligibility } from '../src/model/registry-sessions.js';
import { applyRegistryMutation, emptyRegistry, foldObservation } from '../src/model/registry.js';

// GY-2871: pi-a and pi-b ran zai/glm-5.3-flash on the operator's shared Z.AI credit, but pi-a's own key
// answered the quota endpoint with no limits, so both read quota unknown and stayed eligible while
// opencode-a read the credit spent. Dispatch kept launching Pi workers on a claude profile; each printed
// pi's 429 code 1310 and sat at its prompt, judged against the profile's claude notices, until the idle bound ran out.

const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const reset = iso(3 * 86_400_000);
const keys = { opencode: 'opencode-credit-key', pi: 'pi-own-key' };

test('unit:pi-zai-quota-shared — a Pi account on a zai/ model reads the shared Z.AI credit: exhausted until its reset and ineligible for the worker role, then available again', async () => {
  const opencodeHome = await temporaryDirectory('zai-opencode'), piHome = await temporaryDirectory('zai-pi');
  await mkdir(join(opencodeHome, 'opencode'), { recursive: true });
  await writeFile(join(opencodeHome, 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { key: keys.opencode } }));
  await writeFile(join(piHome, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: keys.pi } }));
  let credit = { percentage: 100, nextResetTime: Date.parse(reset) };
  // The credit's key reports it; pi's own key answers with no limits, as pi-a's did.
  const probe = (async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ code: 200, data: {
    limits: (init?.headers as Record<string, string>).Authorization === `Bearer ${keys.opencode}` ? [{ type: 'CREDIT_LIMIT', ...credit }] : [] } }))) as typeof fetch;
  const launch = (kind: string) => ({ kind, args: [], environment: {}, homeVariable: 'HOME_DIR', modelFlag: '--model', login: null, loginFile: null });
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [{ name: 'opencode', launch: launch('opencode') }, { name: 'pi', launch: launch('pi') }],
    models: [{ name: 'glm-flash', id: 'zai/glm-5.3-flash', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'fast', contextTokens: null } }],
    accounts: [
      { name: 'opencode-a', runtime: 'opencode', model: 'glm-flash', credential: { host: 'host', home: opencodeHome }, enabled: true },
      { name: 'pi-a', runtime: 'pi', model: 'glm-flash', credential: { host: 'host', home: piHome }, enabled: true },
    ],
    roles: [{ name: 'worker', accounts: ['opencode-a', 'pi-a'], concurrency: 2 }],
    reason: 'test setup',
  }, { actor: 'operator', at: iso(-3_600_000) }).registry;
  const [opencode, pi] = registry.accounts;
  const observe = async (offsetMs: number) => {
    for (const account of [opencode, pi]) {
      const runtime = registry.runtimes.find(entry => entry.name === account.runtime)!;
      const { quota } = await observeAccount(account, runtime, { fetch: probe, cacheMs: 0, now: () => clock + offsetMs }, registry.accounts, 'zai/glm-5.3-flash');
      foldObservation(account, quota, { actor: 'coordinator', at: iso(offsetMs) });
    }
  };

  await observe(0);
  assert.equal(pi.quota?.state, 'exhausted', 'the Pi account reads the spent credit, not unknown');
  assert.equal(pi.quota?.resetsAt, reset, 'held until the credit resets');
  assert.ok(accountIneligibility(registry, pi, clock + 1_000, 'host'), 'the Pi account is not eligible for the worker role');

  credit = { percentage: 10, nextResetTime: Date.parse(reset) };
  await observe(60_000);
  assert.equal(pi.quota?.state, 'available', 'available again once the probe reports the credit available');
  assert.equal(accountIneligibility(registry, pi, clock + 61_000, 'host'), null);
});

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const envelope = 'Error: 429 {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2030-01-04 00:00:00"}';

test('unit:pi-zai-quota-shared — a live worker pane ending on pi\'s 429 code 1310 envelope is failed over at the next liveness check and its account held until the reset; prose about a limit is not', async () => {
  const root = await temporaryDirectory('zai-liveness'), credentials = await temporaryDirectory('zai-liveness-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  // A claude profile whose registry selection launched a Pi session, as graphyard-opencode-1's did.
  const profile = { name: 'opencode-primary', principal: 'worker-a', agentName: 'graphyard-opencode-1', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' } as WorkerProfile;
  const config: MasterConfig = { ...await loadMasterConfig(root), workers: [profile] };

  for (const [tail, spent] of [[envelope, true], ['The limit exhausted path is covered; Weekly/Monthly Limit Exhausted handling is tested.', false]] as const) {
    const work = { id: 'work-GY-1', key: 'GY-1', title: 'Pi on spent credit', description: '', type: 'bug', priority: 0, dependencies: [],
      criteria: [{ id: 'AC-1', text: 'Done', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'build', revision: 4, policyRevision: 1,
      createdAt: iso(-7_200_000), updatedAt: iso(), stageEnteredAt: iso(-60_000), ready: true, epoch: 2, lease: { owner: 'worker-a', epoch: 2, expiresAt: iso(600_000) },
      workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [] } as unknown as Work;
    const agents: HerdrAgent[] = [{ name: 'graphyard-opencode-1', pane_id: 'pane-1', agent: 'pi', agent_status: 'idle', cwd: '/repo/.graphyard/worktrees/GY-1-2' }];
    const held: { account: string; resetsAt: string | null }[] = [], prompted: string[] = [];
    const effects: DaemonEffects = {
      agents: () => agents, credentials: async () => ({}), snapshot: async () => ({ work: [work], now: iso() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
      sessionOutput: () => `● Reading GY-1 before editing.\n\n${tail}\n`,
      selectedAccount: async () => ({ environment: 'pi-a', kind: 'pi' }),
      holdAccount: async (account, observed) => { held.push({ account, resetsAt: observed.resetsAt }); },
      reportCapacity: async () => work,
      preserveWork: async () => ({ state: 'clean', detail: 'nothing uncommitted' }),
      promptSession: async (_agent, text) => { prompted.push(text); },
    };
    const state = emptyDaemonState(config);
    await runCycle(config, state, effects, () => clock);
    const failover = state.actions[failoverKey('worker', work, 2)];
    if (spent) {
      assert.equal(failover?.state, 'done', failover?.detail);
      assert.deepEqual(held, [{ account: 'pi-a', resetsAt: reset }], 'the launch account is held until the notice\'s UTC reset');
      assert.deepEqual(prompted, [], 'no idle re-prompt is waited for');
    } else {
      assert.equal(failover, undefined, 'an agent\'s prose about a limit is not its provider\'s notice');
      assert.deepEqual(held, []);
    }
  }
});
