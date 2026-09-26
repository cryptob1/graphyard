import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FleetClient, FleetSelection } from '../src/fleet.js';
import { accountLaunch, launchApprover, loadMasterConfig, masterConfigSchema, selectAccount, setupMaster, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, supersededByRequest, type AgentRegistry, type FleetSession, type RegistryMutation } from '../src/model/registry.js';
import { registryHeadlessLaunch } from '../src/runner/roles.js';
import { clearRuns } from '../src/runner/registry.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
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
const decision = '0e3b2c1a-7f00-4a70-8170-000000000170';
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
/** The runtime command line a Herdr launch typed, as the pane's shell hands it to the runtime. */
const typed = (calls: string[][]) => expandTypedCommand(calls.filter(args => args[0] === 'pane' && args[1] === 'run').at(-1)![3]);
const tabEnvironment = (calls: string[][]) => { const tab = calls.filter(args => args[0] === 'tab').at(-1)!; return Object.fromEntries(tab.flatMap((arg, index) => tab[index - 1] === '--env' ? [arg.split(/=(.*)/s).slice(0, 2)] : [])); };
const valueOf = (args: string[], flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };

function item(key: string): Work {
  return { id: `id-${key}`, key, title: 'Registry launch', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: [], criteria: [{ id: 'AC-2', text: 'Launch', proofs: ['integration:registry-drives-launch'] }],
    policy: { checks: ['test'], review: true }, stage: 'review', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate: null,
    submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: [], observation: null, autoDispatch: { review: null, producers: [], history: [] } } as unknown as Work;
}

test('integration:registry-drives-launch — a role\'s policy change in the registry changes the next Herdr launch\'s command line (flags, tools, model) with no restart, and the launch takes its runtime, account and model from the registry revision it selected', async () => {
  const { root, config } = await installation(), home = await homes(), registry = memoryRegistry(config.hostId);
  fleet(registry, config.hostId, home);
  const probe = { registry: registry.client, quota: false as const, cacheMs: 0 };

  const calls: string[][] = [];
  const first = await launchApprover(root, item('GY-701'), decision, undefined, [], herdr(calls), probe);
  assert.equal(first.runtime, 'claude', 'the registry\'s account decides the runtime, not run.runtimes');
  const one = typed(calls);
  assert.equal(one.kind, 'claude');
  assert.ok(one.args.includes('--verbose'), 'the role policy\'s flag');
  assert.equal(valueOf(one.args, '--allowedTools'), 'Read,Grep', 'the role policy\'s tool allowlist on the runtime\'s tools flag');
  assert.equal(valueOf(one.args, '--model'), 'claude-opus-5', 'the account\'s own model, while the policy names none');
  assert.equal(valueOf(one.args, '--permission-mode'), 'bypassPermissions', 'the runtime\'s non-interactive contract still applies');
  assert.equal(tabEnvironment(calls).CLAUDE_CONFIG_DIR, home.claude, 'the account\'s login home');
  const firstSession = registry.current().sessions.at(-1)!;
  assert.deepEqual([firstSession.role, firstSession.account, firstSession.model], ['approver', 'claude-b', 'opus']);

  // The operator changes the role's policy in the registry: a stricter permission mode flag set, a wider tool list and another model.
  const revision = registry.mutate('role.set', { role: { name: 'approver', accounts: ['claude-b'], concurrency: 4, policy: { args: ['--disallowedTools', 'WebFetch'], tools: ['Read', 'Grep', 'Bash(git:*)'], model: 'sonnet' } }, reason: 'Approvers read and run git only, on the cheaper model' });
  calls.length = 0;
  await launchApprover(root, item('GY-702'), decision.replace('0170', '0171'), undefined, [], herdr(calls), probe);
  const two = typed(calls);
  assert.ok(!two.args.includes('--verbose'), 'the old flag is gone');
  assert.equal(valueOf(two.args, '--disallowedTools'), 'WebFetch', 'the new flag');
  assert.equal(valueOf(two.args, '--allowedTools'), 'Read,Grep,Bash(git:*)');
  assert.equal(valueOf(two.args, '--model'), 'claude-sonnet-5', 'the role policy\'s model replaces the account\'s');
  const secondSession = registry.current().sessions.at(-1)!;
  assert.deepEqual([secondSession.account, secondSession.model], ['claude-b', 'sonnet'], 'the selection records the policy\'s model');
  assert.ok(registry.current().revision > revision, 'the launch was chosen in the revision after the change');

  // A policy that limits tools on a runtime with no tools flag is refused, and its session given back.
  registry.mutate('runtime.set', { runtime: { ...proposedRuntimes.find(runtime => runtime.name === 'claude')!, launch: { ...proposedRuntimes.find(runtime => runtime.name === 'claude')!.launch, toolsFlag: null } }, reason: 'no tools flag' });
  await assert.rejects(launchApprover(root, item('GY-703'), decision.replace('0170', '0172'), undefined, [], herdr([]), probe), /names no tools flag, so the session would run with every tool/);
  assert.ok(registry.current().sessions.at(-1)!.endedAt, 'the refused launch gave its registry session back');
});

test('integration:registry-drives-launch — a registry role on a pi account runs on the headless runner with the account\'s home, the chosen model and the role policy, not the local run.pi; a policy change changes the next run\'s command line', async () => {
  const { root, config } = await installation(), home = await homes(), registry = memoryRegistry(config.hostId);
  fleet(registry, config.hostId, home);
  registry.mutate('role.set', { role: { name: 'approver', accounts: ['pi-a'], concurrency: 4, policy: { args: ['--thinking', 'low'], tools: ['read', 'bash'], model: null } }, reason: 'Approvers on Pi' });
  // A stand-in `pi` on PATH records the command line and environment each run starts with.
  const bin = join(scratch, `bin-${crypto.randomUUID().slice(0, 8)}`), record = join(bin, 'launched.jsonl');
  await mkdir(bin);
  await writeFile(join(bin, 'fake-pi.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.PI_CODING_AGENT_DIR ?? null }) + '\\n');\nprocess.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');\n`);
  await writeFile(join(bin, 'pi'), `#!/bin/sh\nexec '${process.execPath}' '${join(bin, 'fake-pi.mjs')}' "$@"\n`); await chmod(join(bin, 'pi'), 0o755);
  const path = process.env.PATH; process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    const probe = { registry: registry.client, quota: false as const, cacheMs: 0 };
    const first = await launchApprover(root, item('GY-711'), decision, undefined, [], herdr([]), probe);
    assert.equal(first.runtime, 'pi'); assert.equal(first.pane, null);
    assert.equal(first.account?.environment, 'pi-a');
    await first.settled;
    const runs = async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const [one] = await runs();
    assert.equal(one.home, home.pi, 'the account\'s login home on the runtime\'s home variable');
    assert.equal(valueOf(one.args, '--model'), 'zai/glm-5.3', 'the registry\'s model, not run.pi\'s');
    assert.equal(valueOf(one.args, '--thinking'), 'low');
    assert.equal(valueOf(one.args, '--tools'), 'read,bash');
    assert.ok(!JSON.stringify(one.args).includes('local/profile-model'));
    assert.ok(registry.current().sessions.at(-1)!.endedAt, 'the run\'s registry session ends with the run');

    registry.mutate('role.set', { role: { name: 'approver', accounts: ['pi-a'], concurrency: 4, policy: { args: [], tools: ['read'], model: 'glm-flash' } }, reason: 'Read-only approvers on the flash model' });
    await (await launchApprover(root, item('GY-712'), decision.replace('0170', '0173'), undefined, [], herdr([]), probe)).settled;
    const [, two] = await runs();
    assert.equal(valueOf(two.args, '--model'), 'zai/glm-5.3-flash');
    assert.equal(valueOf(two.args, '--tools'), 'read');
    assert.ok(!two.args.includes('--thinking'));

    // The pure plan the runner starts from says the same.
    const account = { name: 'pi-a', kind: 'pi', home: home.pi, fleet: { runtime: 'pi', contract: proposedRuntimes.find(runtime => runtime.name === 'pi')!.launch, model: 'glm', modelId: 'zai/glm-5.3', session: 's', reason: 'r', policy: { args: ['--x'], tools: ['read'], model: null } } };
    assert.deepEqual(registryHeadlessLaunch(account), { command: 'pi', model: 'zai/glm-5.3', args: ['--x', '--tools', 'read'], environment: { PI_CODING_AGENT_DIR: home.pi } });
  } finally { process.env.PATH = path; }
});

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
