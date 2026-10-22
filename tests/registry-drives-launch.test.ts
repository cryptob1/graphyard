import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FleetClient, FleetSelection } from '../src/fleet.js';
import { accountLaunch, loadMasterConfig, masterConfigSchema, saveProducerProfile, selectAccount, setupMaster, type MasterConfig } from '../src/master.js';
import { launchProducer } from '../src/producer.js';
import type { Work } from '../src/model.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, supersededByRequest, type AgentRegistry, type FleetSession, type RegistryMutation } from '../src/model/registry.js';
import { clearRuns } from '../src/runner/registry.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import type { FilesystemProbe } from '../src/install/worktree-root.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-170 AC-2: each registry role carries its launch policy — flags such as a permission mode or
 * an auto-approve switch, a tool allowlist and a model — and every launch of that role, in a Herdr
 * session or on the headless runner, takes its runtime, account, model and policy from the
 * registry revision it was chosen in. The registry here is the control plane's, in memory: the same
 * pure mutation and choice the server runs. A policy change between two launches changes the second
 * launch's command line with nothing restarted and no file edited; a role the registry does not
 * define still launches from the local profile.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x'), approverToken = 'approver-token-'.padEnd(40, 'x');
const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
const durable: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: 200e9 });
const scratch = await realpath(await temporaryDirectory('registry-launch'));
after(async () => { clearRuns(); await rm(scratch, { recursive: true, force: true }); });

/** The control plane's registry, in memory: mutations and choices through the same functions the server runs. */
function memoryRegistry(host: string) {
  let registry: AgentRegistry = emptyRegistry();
  const at = () => new Date().toISOString();
  const mutate = (kind: RegistryMutation, input: unknown) => { registry = applyRegistryMutation(registry, kind, input, { actor: 'operator', at: at() }).registry; return registry.revision; };
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      for (const superseded of supersededByRequest(registry, request)) Object.assign(superseded, { endedAt: at(), endReason: 'superseded' });
      const choice = chooseSession(registry, request, Date.now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision } satisfies FleetSelection;
      const session: FleetSession = { id: crypto.randomUUID(), role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: at(), selectedBy: 'coordinator', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry.sessions.push(session); registry.revision++;
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async (id, reason) => { const session = registry.sessions.find(entry => entry.id === id); if (session && !session.endedAt) Object.assign(session, { endedAt: at(), endReason: reason }); },
  };
  return { client, mutate, current: () => registry };
}

async function installation() {
  const root = join(scratch, `repository-${crypto.randomUUID().slice(0, 8)}`), credentials = join(root, '..', `credentials-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'registry launches\n');
  git('add', 'README.md'); git('-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.test', 'commit', '-q', '-m', 'initial');
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'workspace', run: { worktreeRoot: join(root, '..', 'worktrees') } }, coordinatorStatus, { probe: durable });
  const approverFile = join(credentials, 'approver.token');
  await writeFile(approverFile, approverToken, { mode: 0o600 });
  const file = join(root, '.graphyard/master.json'), config = JSON.parse(await readFile(file, 'utf8'));
  config.approver = { id: 'graphyard-approver-project', credentialFile: approverFile };
  // The local configuration names a Pi wrapper and model of its own: a role the registry defines never uses them.
  config.run = { ...config.run, runtimes: { approver: 'pi' }, pi: { command: 'pi-local-profile', model: 'local/profile-model' } };
  await writeFile(file, JSON.stringify(masterConfigSchema.parse(config), null, 2), { mode: 0o600 });
  return { root, config: await loadMasterConfig(root) };
}

/** Logged-in account homes: a Claude login and a Pi environment, as the probes read them. */
async function homes() {
  const claude = join(scratch, `claude-${crypto.randomUUID().slice(0, 8)}`), pi = join(scratch, `pi-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(claude, { recursive: true }); await mkdir(pi, { recursive: true });
  await writeFile(join(claude, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } }));
  await writeFile(join(pi, 'auth.json'), '{}');
  return { claude, pi };
}

function fleet(registry: ReturnType<typeof memoryRegistry>, host: string, home: { claude: string; pi: string }) {
  registry.mutate('apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude' || runtime.name === 'pi'),
    models: [{ name: 'opus', id: 'claude-opus-5' }, { name: 'sonnet', id: 'claude-sonnet-5' }, { name: 'glm', id: 'zai/glm-5.3' }, { name: 'glm-flash', id: 'zai/glm-5.3-flash' }],
    accounts: [{ name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host, home: home.claude } }, { name: 'pi-a', runtime: 'pi', model: 'glm', credential: { host, home: home.pi } }],
    roles: [{ name: 'approver', accounts: ['claude-b'], concurrency: 4, policy: { args: ['--verbose'], tools: ['Read', 'Grep'], model: null } }],
    reason: 'fixture',
  });
}

function herdr(calls: string[][]) {
  let pane = 0;
  return (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'tab') { pane++; return JSON.stringify({ result: { type: 'tab_created', root_pane: { pane_id: `pane-${pane}`, tab_id: `tab-${pane}` }, tab: { tab_id: `tab-${pane}` } } }); }
    if (args[0] === 'agent' && args[1] === 'list') return JSON.stringify({ result: { agents: [] } });
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
}
const valueOf = (args: string[], flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };

function item(key: string): Work {
  return { id: `id-${key}`, key, title: 'Registry launch', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-2', text: 'Launch', proofs: ['integration:registry-drives-launch'] }],
    policy: { checks: ['test'], review: true }, stage: 'review', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate: null,
    submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: [], observation: null, autoDispatch: { review: null, producers: [], history: [] } } as unknown as Work;
}

test('integration:registry-drives-launch — the local profile is used only for roles the registry does not define', async () => {
  const { config } = await installation(), home = await homes(), registry = memoryRegistry(config.hostId);
  fleet(registry, config.hostId, home);
  const probe = { registry: registry.client, quota: false as const, cacheMs: 0 };
  const profile = { name: 'worker-a', principal: 'implementer', kind: 'claude' as const, approvals: 'auto' as const, agentArgs: ['--profile-flag'], environment: { PROFILE_ONLY: '1' } };
  const cfg = config as MasterConfig;

  // The worker role is not in the registry: the profile's own arguments and environment launch it.
  const local = await selectAccount(cfg, 'worker', profile, probe);
  assert.equal(local.account, null);
  const fromProfile = accountLaunch(profile, local.account);
  assert.ok(fromProfile.args.includes('--profile-flag')); assert.equal(fromProfile.environment.PROFILE_ONLY, '1');

  // Once the registry defines it, the registry alone decides: the profile's arguments and environment are not used.
  registry.mutate('role.set', { role: { name: 'worker', accounts: ['claude-b'], concurrency: 2, policy: { args: ['--verbose'], tools: [], model: 'sonnet' } }, reason: 'Workers from the registry' });
  const chosen = await selectAccount(cfg, 'worker', profile, { ...probe, work: 'GY-721' });
  assert.equal(chosen.account?.name, 'claude-b');
  const fromRegistry = accountLaunch(profile, chosen.account);
  assert.ok(!fromRegistry.args.includes('--profile-flag')); assert.equal(fromRegistry.environment.PROFILE_ONLY, undefined);
  assert.ok(fromRegistry.args.includes('--verbose'));
  assert.equal(valueOf(fromRegistry.args, '--model'), 'claude-sonnet-5');
  assert.equal(fromRegistry.environment.CLAUDE_CONFIG_DIR, home.claude);
  await chosen.release?.('test done');
});

test('integration:registry-drives-launch — a producer role on a pi account runs headless for the unit group only; any other group is refused with its registry session given back, never started as a Herdr session (GY-397)', async () => {
  const { root, config } = await installation(), home = await homes(), registry = memoryRegistry(config.hostId);
  fleet(registry, config.hostId, home);
  registry.mutate('role.set', { role: { name: 'producer', accounts: ['pi-a'], concurrency: 4 }, reason: 'Producers on Pi' });
  const producerFile = join(scratch, `producer-${crypto.randomUUID().slice(0, 8)}.token`);
  await writeFile(producerFile, 'producer-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'codex', credentialFile: producerFile }, async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] } }));
  const profile = (await loadMasterConfig(root)).producers[0];
  const H = 'c'.repeat(40), B = 'd'.repeat(40), candidate = { sha: H, baseSha: B, pr: 397, branch: 'graphyard/gy-721-1', author: 'implementer' };
  const request = { id: 'request-GY-721-integration', kind: 'producer', sha: H, baseSha: B, policyRevision: 1, pr: 397, group: 'integration', proofs: ['integration:registry-drives-launch'], state: 'requested', requestedAt: new Date().toISOString(), reason: 'r' };
  const work = { ...item('GY-721'), candidate, submission: { epoch: 1, pr: 397 }, implementers: ['implementer'], autoDispatch: { review: null, producers: [request], history: [] },
    observation: { at: new Date().toISOString(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], prState: 'open', draft: false } } as unknown as Work;
  const calls: string[][] = [];
  await assert.rejects(launchProducer(root, work, request as any, profile, [], new Date().toISOString(), { run: herdr(calls), filesystem: durable, probe: { registry: registry.client, quota: false, cacheMs: 0 } }),
    /refuses to launch account pi-a for GY-721 integration proofs: runtime pi runs producer sessions headless for the unit group only/);
  assert.ok(!calls.some(args => args[0] === 'tab'), 'no Herdr tab was created');
  const session = registry.current().sessions.at(-1)!;
  assert.equal(session.role, 'producer'); assert.ok(session.endedAt, 'the chosen registry session is given back');
});
