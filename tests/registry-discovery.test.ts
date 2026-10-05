import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryCommand } from '../src/cli/master-registry.js';
import { boundDaemonState, daemonStateSchema, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { workingOutputReadMs } from '../src/daemon/cycle-sessions.js';
import type { MasterConfig, HerdrAgent } from '../src/master.js';
import type { Work } from '../src/model.js';
import { applyRegistryMutation, emptyRegistry, fleetRoles, type AgentRegistry } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-170 AC-1: `master registry propose` turns this installation's ~/.coding_agents tree into a
 * registry — every Claude, Codex, Cursor, OpenCode and Pi environment as an account of its runtime,
 * with the credential held by reference (host and home) — and `--apply` stores it as one registry
 * revision. Every credential file in the fixture holds a secret-shaped value; none of it may reach
 * the proposal, which carries only what the readiness probes decide: logged in or not.
 */

const HOST = 'agent-host-1';
const scratch = await temporaryDirectory('registry-discovery');
after(() => rm(scratch, { recursive: true, force: true }));

const secrets: string[] = [];
const secret = (label: string) => { const value = `sk-ant-${label}-${'x'.repeat(24)}-SECRET`; secrets.push(value); return value; };
async function file(path: string, content: unknown) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
}

/** The environments this installation actually has (see ~/.coding_agents/README.md), each logged in, plus one Pi environment nobody logged in to. */
async function codingAgents() {
  const root = join(scratch, '.coding_agents');
  for (const name of ['claude-a', 'claude-b', 'claude-c'])
    await file(join(root, name, '.credentials.json'), { claudeAiOauth: { accessToken: secret(`${name}-access`), refreshToken: secret(`${name}-refresh`), expiresAt: Date.now() + 3_600_000 } });
  await file(join(root, 'codex', 'auth.json'), { tokens: { access_token: secret('codex-access'), refresh_token: secret('codex-refresh') } });
  await file(join(root, 'cursor-a', 'cli-config.json'), { authInfo: { userId: 'user-1', email: 'agent@example.test', accessToken: secret('cursor-access') } });
  for (const name of ['opencode-a', 'opencode-b']) await file(join(root, name, 'opencode', 'auth.json'), { anthropic: { type: 'api', key: secret(`${name}-key`) } });
  for (const name of ['pi-a', 'pi-b']) {
    await file(join(root, name, 'auth.json'), { zai: { type: 'api_key', key: secret(`${name}-key`) } });
    await file(join(root, name, 'settings.json'), { theme: 'dark', note: secret(`${name}-settings`) });
  }
  await mkdir(join(root, 'pi-c'), { recursive: true });
  // Files that are nobody's login are never looked at either.
  await file(join(root, 'claude-a', 'history.jsonl'), `${JSON.stringify({ text: secret('history') })}\n`);
  await file(join(root, 'README.md'), '# not an environment');
  return root;
}

test('unit:registry-discovers-agent-environments — propose discovers every ~/.coding_agents environment (Claude, Codex, Cursor, OpenCode, Pi), proposes runtimes, accounts by reference, models and a worker/reviewer/approver/producer mapping, --apply writes it as a registry revision, and no credential content reaches the proposal', async () => {
  const directory = await codingAgents(), home = join(scratch, 'home');
  await mkdir(home, { recursive: true });
  // Only the fixture is looked at: no runtime default home, no provider, no executable on this machine.
  const saved = process.env.XDG_DATA_HOME; delete process.env.XDG_DATA_HOME;
  const written: { path: string; data: any }[] = [];
  let registry: AgentRegistry = emptyRegistry();
  const api = {
    read: async (path: string) => { assert.equal(path, 'agent-registry/document'); return registry; },
    write: async (path: string, data: any) => {
      written.push({ path, data });
      const { reason, ...proposal } = data;
      registry = applyRegistryMutation(registry, 'apply', { ...proposal, reason }, { actor: 'coordinator', at: new Date().toISOString() }).registry;
      return { revision: registry.revision, registry };
    },
  };
  const options = { home, executables: () => false };
  try {
    const preview = await registryCommand({ hostId: HOST }, ['propose', '--directory', directory], api, options) as any;
    assert.equal(preview.applied, false, 'a proposal alone stores nothing');
    assert.equal(written.length, 0);

    // Discovery: every environment directory, with its runtime and home; the one nobody logged in to is reported with how to log it in.
    assert.deepEqual(preview.discovered.map((login: any) => [login.name, login.runtime, login.home, login.loggedIn, login.source]), [
      ['claude-a', 'claude', join(directory, 'claude-a'), true, 'environment'],
      ['claude-b', 'claude', join(directory, 'claude-b'), true, 'environment'],
      ['claude-c', 'claude', join(directory, 'claude-c'), true, 'environment'],
      ['codex', 'codex', join(directory, 'codex'), true, 'environment'],
      ['cursor-a', 'cursor', join(directory, 'cursor-a'), true, 'environment'],
      ['opencode-a', 'opencode', join(directory, 'opencode-a'), true, 'environment'],
      ['opencode-b', 'opencode', join(directory, 'opencode-b'), true, 'environment'],
      ['pi-a', 'pi', join(directory, 'pi-a'), true, 'environment'],
      ['pi-b', 'pi', join(directory, 'pi-b'), true, 'environment'],
      ['pi-c', 'pi', join(directory, 'pi-c'), false, 'environment'],
    ]);
    assert.equal(preview.discovered.find((login: any) => login.name === 'pi-c').login, `PI_CODING_AGENT_DIR=${join(directory, 'pi-c')} pi, then /login`);

    // Runtimes, each with its launch contract; Pi is its own `pi` runtime kind.
    const proposal = preview.proposal;
    assert.deepEqual(proposal.runtimes.map((runtime: any) => runtime.name), ['claude', 'codex', 'cursor', 'opencode', 'pi']);
    assert.deepEqual(proposal.runtimes.find((runtime: any) => runtime.name === 'pi').launch,
      { kind: 'pi', args: [], environment: {}, homeVariable: 'PI_CODING_AGENT_DIR', modelFlag: '--model', login: 'PI_CODING_AGENT_DIR={home} pi, then /login', loginFile: 'auth.json', toolsFlag: '--tools' });
    assert.equal(proposal.runtimes.find((runtime: any) => runtime.name === 'claude').launch.homeVariable, 'CLAUDE_CONFIG_DIR');

    // Accounts: one per logged-in environment, the credential by reference only — host and home.
    assert.deepEqual(proposal.accounts.map((account: any) => [account.name, account.runtime, account.model, account.credential]), [
      ['claude-a', 'claude', 'claude-default', { host: HOST, home: join(directory, 'claude-a') }],
      ['claude-b', 'claude', 'claude-default', { host: HOST, home: join(directory, 'claude-b') }],
      ['claude-c', 'claude', 'claude-default', { host: HOST, home: join(directory, 'claude-c') }],
      ['codex', 'codex', 'codex-default', { host: HOST, home: join(directory, 'codex') }],
      ['cursor-a', 'cursor', 'cursor-default', { host: HOST, home: join(directory, 'cursor-a') }],
      ['opencode-a', 'opencode', 'opencode-default', { host: HOST, home: join(directory, 'opencode-a') }],
      ['opencode-b', 'opencode', 'opencode-default', { host: HOST, home: join(directory, 'opencode-b') }],
      ['pi-a', 'pi', 'pi-default', { host: HOST, home: join(directory, 'pi-a') }],
      ['pi-b', 'pi', 'pi-default', { host: HOST, home: join(directory, 'pi-b') }],
    ]);
    for (const account of proposal.accounts) assert.deepEqual(Object.keys(account.credential).sort(), ['home', 'host'], `${account.name} holds a reference, nothing more`);
    assert.deepEqual(proposal.models.map((model: any) => model.name), ['claude-default', 'codex-default', 'cursor-default', 'opencode-default', 'pi-default']);

    // The role mapping: worker, reviewer, approver and producer are all mapped; Pi serves the narrow roles.
    const roles = Object.fromEntries(proposal.roles.map((role: any) => [role.name, role.accounts]));
    for (const role of ['worker', 'reviewer', 'approver', 'producer']) assert.ok(roles[role]?.length, `role ${role} is mapped`);
    const full = ['claude-a', 'claude-b', 'claude-c', 'codex', 'cursor-a', 'opencode-a', 'opencode-b'];
    assert.deepEqual(roles.worker, full); assert.deepEqual(roles.reviewer, full);
    assert.deepEqual(roles.approver, [...full, 'pi-a', 'pi-b']); assert.deepEqual(roles.producer, [...full, 'pi-a', 'pi-b']);
    // The master role is never proposed (GY-898): the operator names its accounts themselves.
    assert.deepEqual(proposal.roles.map((role: any) => role.name), fleetRoles.filter(name => name !== 'master'));

    // Nothing a credential home holds beyond what the readiness probe decides reaches the proposal.
    const shown = JSON.stringify(preview);
    for (const value of secrets) assert.ok(!shown.includes(value), `the proposal never carries ${value.slice(0, 20)}…`);
    assert.ok(!/accessToken|refreshToken|access_token|"key"/.test(shown), 'no credential field name either');

    // --apply writes the proposal as one registry revision.
    const applied = await registryCommand({ hostId: HOST }, ['propose', '--directory', directory, '--apply'], api, options) as any;
    assert.equal(applied.applied, true);
    assert.deepEqual(written.map(entry => entry.path), ['agent-registry/apply']);
    assert.equal(applied.revision, 1);
    assert.deepEqual(registry.accounts.map(account => account.name), proposal.accounts.map((account: any) => account.name));
    assert.deepEqual(registry.roles.map(role => role.name), fleetRoles.filter(name => name !== 'master'), 'the applied proposal proposes no master role (GY-898)');
    assert.equal(registry.lastMutation?.kind, 'apply');
    const stored = JSON.stringify(registry);
    for (const value of secrets) assert.ok(!stored.includes(value), 'the stored revision never carries a credential');

    // Proposing again finds the registry already holding every login: nothing more to write.
    const again = await registryCommand({ hostId: HOST }, ['propose', '--directory', directory, '--apply'], api, options) as any;
    assert.equal(again.applied, false); assert.equal(written.length, 1);
    assert.match(again.next, /already holds every login/);
  } finally {
    if (saved !== undefined) process.env.XDG_DATA_HOME = saved;
  }
});

// The master role's own session (GY-898), scoped in a block so its helpers stay its own.
{
  // GY-898: the loop launches, adopts, wakes and rotates its own master session. One case per proof:
  // unit:master-session-supervised-and-rotated, unit:master-wake-on-event.

  const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
  const clock0 = Date.parse('2030-01-01T00:00:00Z');
  const iso = (offsetMs = 0) => new Date(clock0 + offsetMs).toISOString();

  function item(key: string): Work {
    return {
      id: `work-${key}`, key, title: `Master session ${key}`, description: '', type: 'feature', priority: 0, dependencies: [],
      criteria: [{ id: 'AC-1', text: 'Done', proofs: ['manual:x'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
      stage: 'build', revision: 1, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 0,
      lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
      gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
    } as unknown as Work;
  }

  const config = (run: Partial<MasterConfig['run']> = {}): MasterConfig => ({ hostId: 'machine-a', autoMerge: true, mergeMethod: 'merge', workers: [], reviewers: [], producers: [],
    repository: 'owner/project', baseBranch: 'main', url: 'https://graphyard.example', credentialFile: '/dev/null', cliPath: launcher, githubAppId: 1234,
    masterAgentName: 'graphyard-master-test', run: { intervalSeconds: 20, ...run } } as unknown as MasterConfig);

  interface Harness {
    agents: HerdrAgent[];
    launches: string[];
    wakes: string[];
    closed: string[];
    ended: [string, string][];
    held: [string, { reason: string; role: string; profile: string }][];
    outputs: Record<string, string>;
    unavailable?: boolean;
    refuseEnd?: boolean;
    failLaunch?: boolean;
  }

  function effects(config: MasterConfig, state: { master: Harness }, work: Work[], at: { value: number }, extra: Partial<DaemonEffects> = {}): DaemonEffects {
    return {
      agents: () => state.master.agents,
      herdr: () => state.master.unavailable ? { agents: [], available: false } : { agents: state.master.agents, available: true },
      credentials: async () => ({}),
      snapshot: async () => ({ work, now: new Date(at.value).toISOString() }),
      closeSession: pane => { state.master.closed.push(pane); state.master.agents = state.master.agents.filter(agent => agent.pane_id !== pane); },
      dispatch: async () => {},
      requestProof: () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(at.value).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {},
      requestSmoke: () => {},
      sessionOutput: async (agent: HerdrAgent) => state.master.outputs[agent.name ?? ''] ?? '',
      promptSession: async (agent: HerdrAgent, text: string) => { state.master.wakes.push(text); },
      endRegistrySession: async (session: string, reason: string) => {
        if (state.master.refuseEnd) throw new Error('the registry answered 503');
        state.master.ended.push([session, reason]);
      },
      holdAccount: async (account: string, observed: { reason: string; role: string; profile: string }) => { state.master.held.push([account, observed]); },
      masterSession: { launch: async handover => {
        state.master.launches.push(handover);
        if (state.master.failLaunch) throw Object.assign(new Error('the runtime never started'), { registrySession: `reg-orphan-${state.master.launches.length}` });
        return { agentName: config.masterAgentName!, pane: `pane-${state.master.launches.length}`, runtime: 'claude', account: 'claude-a', session: `reg-${state.master.launches.length}` };
      } },
      persist: async () => {},
      ...extra,
    };
  }

  const sessionAgent = (config: MasterConfig, pane: string, status = 'idle'): HerdrAgent => ({ name: config.masterAgentName, pane_id: pane, agent: 'claude', agent_status: status });

  test('unit:master-session-supervised-and-rotated — the loop launches its master session from a durable handover, adopts at most one, restarts it when it exits, fails it over on a limit notice, rotates it at its budget (deferred while a merge is in flight), and never launches a second', async () => {
    const cfg = config({ masterSessionMinutes: 30, masterHeartbeatMinutes: 30 });
    const state = emptyDaemonState(cfg);
    const harness: Harness = { agents: [], launches: [], wakes: [], closed: [], ended: [], held: [], outputs: {} };
    const work = [item('GY-1')];
    const at = { value: clock0 };
    const loop = effects(cfg, { master: harness }, work, at);
    const cycle = (offsetMs: number) => { at.value = clock0 + offsetMs; return runCycle(cfg, state, loop, () => at.value); };

    // Cycle 1: nothing holds the role, so the handover is composed from the snapshot and one session launched.
    await cycle(0);
    assert.equal(harness.launches.length, 1, 'exactly one master session is launched');
    assert.match(harness.launches[0], /Durable handover/);
    assert.match(harness.launches[0], /dispatch:GY-1/, 'the handover names the standing subjects');
    assert.equal(state.master.agentName, cfg.masterAgentName);
    assert.equal(state.master.pane, 'pane-1');
    assert.equal(state.master.account, 'claude-a');
    assert.equal(state.master.session, 'reg-1');
    assert.equal(state.master.rotations, 1);
    assert.deepEqual(harness.wakes, [], 'a replacement is not woken for the subjects its handover named');

    // Cycle 2: the session is live; nothing new, so no second launch and no wake.
    harness.agents = [sessionAgent(cfg, 'pane-1')];
    await cycle(20_000);
    assert.equal(harness.launches.length, 1, 'at most one master session runs');
    assert.deepEqual(harness.wakes, []);

    // Cycle 3: a second dispatchable item appears — exactly one wake, naming the changed subject.
    work.push(item('GY-2'));
    await cycle(40_000);
    assert.equal(harness.wakes.length, 1);
    assert.match(harness.wakes[0], /dispatch:GY-2/, 'the wake names its cause');
    assert.match(harness.wakes[0], /not untrusted text/);
    assert.deepEqual(state.master.lastWake, { at: iso(40_000), causes: ['dispatch:GY-2'], heartbeat: false });

    // Cycle 4: nothing changed, so nothing wakes again.
    await cycle(60_000);
    assert.equal(harness.wakes.length, 1, 'an unchanged cause never wakes twice');

    // Cycle 5: the pane is working, so the wake for GY-3 waits; cycle 6 delivers it.
    work.push(item('GY-3'));
    harness.agents = [sessionAgent(cfg, 'pane-1', 'working')];
    await cycle(80_000);
    assert.equal(harness.wakes.length, 1, 'a wake is not typed into a working pane');
    harness.agents = [sessionAgent(cfg, 'pane-1')];
    await cycle(100_000);
    assert.equal(harness.wakes.length, 2);
    assert.match(harness.wakes[1], /dispatch:GY-3/);

    // Herdr unavailable: an inventory that could not be read is not an exit. However many cycles
    // it lasts, the healthy session is neither counted as a miss, rotated nor relaunched beside.
    harness.unavailable = true;
    for (const offset of [200_000, 220_000, 240_000]) await cycle(offset);
    assert.equal(harness.launches.length, 1, 'an unobservable master is never relaunched');
    assert.deepEqual(harness.ended, [], 'an unobservable master keeps its registry session');
    assert.equal(state.master.misses, 0, 'an unreadable inventory is never a liveness miss');
    assert.equal(state.master.pane, 'pane-1');
    harness.unavailable = false;
    await cycle(260_000);
    assert.equal(harness.launches.length, 1, 'the next reading that answers finds the same session');

    // Exit: the session is gone from Herdr. One miss waits; the second rotates and relaunches.
    harness.agents = [];
    await cycle(300_000);
    assert.equal(harness.launches.length, 1, 'the first miss launches nothing');
    assert.deepEqual(harness.ended, [], 'the first miss ends nothing');
    await cycle(320_000);
    assert.deepEqual(harness.ended.map(entry => entry[0]), ['reg-1'], 'the rotation ends the registry session');
    assert.match(harness.ended[0][1], /exited/);
    assert.equal(harness.launches.length, 2, 'the role relaunches from the durable handover');
    assert.equal(state.master.rotations, 2);
    assert.equal(state.master.lastEnd?.cause, 'exited');
    assert.match(state.master.lastEnd!.detail, /gone from Herdr on two consecutive readings/);

    // Quota: the relaunched session stops on its provider's limit notice — account held, pane closed, relaunched.
    harness.agents = [sessionAgent(cfg, 'pane-2')];
    harness.outputs[cfg.masterAgentName!] = 'Error: usage limit has been reached. Your limit resets at 4pm';
    await cycle(340_000);
    assert.equal(state.master.lastEnd?.cause, 'exhausted');
    assert.deepEqual(harness.closed, ['pane-1', 'pane-2'], 'the spent session pane is closed (the exited pane was closed with it)');
    assert.deepEqual(harness.held.map(([account]) => account), ['claude-a'], 'the account it spent is held');
    assert.equal(harness.held[0][1].role, 'master');
    assert.equal(harness.held[0][1].profile, 'master');
    assert.match(harness.held[0][1].reason, /usage limit/);
    assert.equal(harness.launches.length, 3);
    assert.equal(state.master.rotations, 3);
    harness.outputs = {};

    // Budget: the session is live but past its 30-minute budget. A guarded merge in flight defers the
    // rotation one cycle; once none is, the rotation closes the pane and relaunches.
    harness.agents = [sessionAgent(cfg, 'pane-3')];
    const mergeKey = 'merge:work-GY-1';
    // A guarded merge GitHub has not performed yet is recorded waiting, and that is what defers the rotation.
    state.actions[mergeKey] = { kind: 'merge', work: 'GY-1', principal: null, state: 'waiting', detail: 'Guarded merge pending for GY-1', attempts: 1, cycle: state.cycle, at: iso(), epoch: null };
    await cycle(340_000 + 31 * 60_000);
    assert.equal(harness.launches.length, 3, 'the rotation defers while a guarded merge is in flight');
    assert.equal(state.master.lastEnd?.cause, 'exhausted');
    delete state.actions[mergeKey];
    await cycle(340_000 + 32 * 60_000);
    assert.equal(state.master.lastEnd?.cause, 'budget');
    assert.match(state.master.lastEnd!.detail, /past its 30-minute session budget/);
    assert.deepEqual(harness.closed, ['pane-1', 'pane-2', 'pane-3']);
    assert.equal(harness.launches.length, 4, 'the role relaunches after the deferred rotation');
    assert.equal(state.master.rotations, 4);
    assert.equal(state.master.pane, 'pane-4');

    // Adoption: with the record cleared and a session the loop did not launch visible under the
    // configured name, the loop adopts it — never a second.
    state.master = { ...state.master, agentName: null, pane: null, startedAt: null };
    harness.agents = [sessionAgent(cfg, 'pane-human')];
    const adopted = await cycle(340_000 + 33 * 60_000);
    assert.equal(harness.launches.length, 4, 'no second master session is launched');
    assert.equal(state.master.agentName, cfg.masterAgentName);
    assert.equal(state.master.adopted, true);
    assert.equal(state.master.pane, 'pane-human');
    assert.ok(adopted.actions.some(action => action.kind === 'session' && /Adopted master session/.test(action.detail)));

    // Exit in place: the adopted session's runtime has left its pane — Herdr still lists the pane,
    // with no agent in it and status unknown. That reads as a miss, never as a live pane: one miss
    // waits, the second rotates, the pane it left is closed so the name frees, and the role
    // relaunches from the durable handover.
    harness.agents = [{ name: cfg.masterAgentName, pane_id: 'pane-human', agent: null, agent_status: 'unknown' }];
    await cycle(340_000 + 33 * 60_000 + 130_000);
    assert.equal(harness.launches.length, 4, 'the first reading of a runtime-less pane launches nothing');
    await cycle(340_000 + 33 * 60_000 + 260_000);
    assert.equal(state.master.lastEnd?.cause, 'exited');
    assert.match(state.master.lastEnd!.detail, /runtime has left pane pane-human/);
    assert.ok(harness.closed.includes('pane-human'), 'the pane the runtime left is closed so the relaunch can take the name');
    assert.equal(harness.launches.length, 5, 'the role relaunches from the durable handover');
    assert.equal(state.master.rotations, 5);
    assert.equal(state.master.pane, 'pane-5');

    // A release the registry refuses is never forgotten: the role runs one session at a time, so a
    // leaked row would refuse every relaunch. The rotation keeps it owed on the cursor, the next
    // cycles end it again, and it leaves the cursor once the registry takes it back.
    const t5 = 340_000 + 33 * 60_000 + 260_000;
    const endedSessions = (): string[] => harness.ended.map(entry => entry[0]);
    const owed = (): string[] => state.master.unreleased.map(entry => entry.session);
    harness.agents = [];
    harness.refuseEnd = true;
    await cycle(t5 + 400_000);
    await cycle(t5 + 420_000);
    assert.equal(state.master.lastEnd?.cause, 'exited');
    assert.deepEqual(owed(), ['reg-5'], 'the refused release stays owed on the cursor');
    assert.equal(harness.launches.length, 6);
    await cycle(t5 + 440_000);
    assert.deepEqual(owed(), ['reg-5'], 'still owed while the registry refuses');
    assert.equal(state.actions['master:release']?.state, 'waiting');
    assert.match(state.actions['master:release']!.detail, /reg-5/);
    harness.refuseEnd = false;
    await cycle(t5 + 460_000);
    assert.deepEqual(owed(), [], 'the owed release clears once the registry takes it back');
    assert.ok(endedSessions().includes('reg-5'), 'the owed session is ended');
    assert.equal(state.actions['master:release']?.state, 'done');

    // A failed launch whose cleanup could not end its registry session hands that id back: owed the same way, then ended.
    harness.agents = [];
    harness.failLaunch = true;
    harness.refuseEnd = true;
    const t6 = t5 + 460_000;
    await cycle(t6 + 400_000);
    await cycle(t6 + 420_000);
    assert.equal(state.master.lastEnd?.cause, 'exited');
    assert.equal(state.actions['master:launch']?.state, 'failed');
    assert.deepEqual(owed().sort(), ['reg-6', 'reg-orphan-7']);
    harness.refuseEnd = false;
    harness.failLaunch = false;
    await cycle(t6 + 440_000);
    assert.deepEqual(owed(), [], 'every owed session is ended once the registry answers');
    assert.ok(endedSessions().includes('reg-orphan-7'));
    assert.equal(harness.launches.length, 8, 'the role relaunches once its slot is free');
    assert.equal(state.master.agentName, cfg.masterAgentName);
  });

  test('unit:master-retrying-exhaustion-rotated — a master session Herdr still reports working, whose runtime retries on a limit banner, is failed over at once: the account is held and the role relaunches; a working master with a bare notice is left alone (GY-1223)', async () => {
    const cfg = config({ masterSessionMinutes: 240 });
    const state = emptyDaemonState(cfg);
    const harness: Harness = { agents: [], launches: [], wakes: [], closed: [], ended: [], held: [], outputs: {} };
    const at = { value: clock0 };
    const loop = effects(cfg, { master: harness }, [item('GY-1')], at);
    const cycle = (offsetMs: number) => { at.value = clock0 + offsetMs; return runCycle(cfg, state, loop, () => at.value); };
    await cycle(0);
    assert.equal(harness.launches.length, 1);
    harness.agents = [sessionAgent(cfg, 'pane-1', 'working')];

    // Working, with a notice its runtime is not retrying on: text the session printed, left alone.
    harness.outputs[cfg.masterAgentName!] = '● Weekly usage limit reached is handled now\n';
    await cycle(20_000);
    assert.equal(harness.launches.length, 1, 'a working master without a retry marker is never rotated');
    assert.equal(state.master.rotations, 1);

    // OpenCode on a spent account: Herdr says working, the screen tail says retrying.
    harness.outputs[cfg.masterAgentName!] = `  ■⬝⬝⬝⬝⬝⬝⬝  Weekly/Monthly Limit Exhausted. Your limit will reset at 2030-01-03 08:27:35 [retrying in 4s attempt #5]${' '.repeat(96)}esc interrupt • OpenCode 1.18.32  \n`;
    // A working master's screen is read at most once per workingOutputReadMs, as worker panes are.
    await cycle(40_000);
    assert.equal(harness.launches.length, 1, 'the banner waits for the next due read of a working master');
    await cycle(20_000 + workingOutputReadMs);
    assert.equal(state.master.lastEnd?.cause, 'exhausted');
    assert.match(state.master.lastEnd!.detail, /is retrying on its provider's limit notice: Weekly\/Monthly Limit Exhausted/);
    assert.deepEqual(harness.closed, ['pane-1'], 'the spinning pane is closed');
    assert.deepEqual(harness.held.map(([account]) => account), ['claude-a'], 'the account it spent is held');
    assert.equal(harness.launches.length, 2, 'the role relaunches without waiting for its budget');
  });

  test('unit:master-wake-on-event — a material event produces exactly one wake naming its cause, an unchanged cycle none, a changed state one more, and the heartbeat is only the silence fallback', async () => {
    const cfg = config({ masterHeartbeatMinutes: 5 });
    const state = emptyDaemonState(cfg);
    const harness: Harness = { agents: [], launches: [], wakes: [], closed: [], ended: [], held: [], outputs: {} };
    const work = [item('GY-1')];
    const at = { value: clock0 };
    const loop = effects(cfg, { master: harness }, work, at);
    const cycle = (offsetMs: number) => { at.value = clock0 + offsetMs; return runCycle(cfg, state, loop, () => at.value); };

    // The session is launched with a handover that already names the standing subjects.
    await cycle(0);
    assert.equal(harness.launches.length, 1);
    harness.agents = [sessionAgent(cfg, 'pane-1')];

    // Unchanged cycle: no wake at all.
    await cycle(20_000);
    assert.equal(harness.wakes.length, 0, 'an unchanged cycle produces no wake');

    // The event: a second claimable item. Exactly one wake, recorded on the cursor, naming the cause.
    work.push(item('GY-2'));
    const woken = await cycle(40_000);
    const wakes = woken.actions.filter(action => action.kind === 'wake');
    assert.equal(wakes.length, 1, 'exactly one wake action is recorded');
    assert.match(wakes[0].detail, /dispatch:GY-2/, 'the recorded wake names its cause');
    assert.equal(harness.wakes.length, 1);
    assert.deepEqual(state.master.lastWake, { at: iso(40_000), causes: ['dispatch:GY-2'], heartbeat: false });

    // Unchanged again: still exactly one.
    await cycle(60_000);
    assert.equal(harness.wakes.length, 1);
    assert.equal(woken.actions.filter(action => action.kind === 'wake').length >= 0, true);

    // Heartbeat: silence past the configured window produces the one fallback wake, then the clock resets.
    await cycle(40_000 + 6 * 60_000);
    assert.equal(harness.wakes.length, 2, 'the heartbeat is the fallback after the quiet window');
    assert.match(harness.wakes[1], /heartbeat/);
    assert.equal(state.master.lastWake?.heartbeat, true);
    assert.deepEqual(state.master.lastWake?.causes, []);
    await cycle(40_000 + 6 * 60_000 + 20_000);
    assert.equal(harness.wakes.length, 2, 'the heartbeat clock resets, so silence does not wake every cycle');
  });

  test('a backlog of more actionable subjects than any count bound wakes the master once, and quiet cycles after it none, with every cursor write fitted to its schema', async () => {
    const cfg = config({ masterHeartbeatMinutes: 60 });
    const state = emptyDaemonState(cfg);
    const harness: Harness = { agents: [], launches: [], wakes: [], closed: [], ended: [], held: [], outputs: {} };
    const work = Array.from({ length: 150 }, (_, index) => item(`GY-${index + 1}`));
    const at = { value: clock0 };
    // Every write goes through the cursor's bound and schema, as `graphyard master run` persists it.
    const loop = effects(cfg, { master: harness }, work, at, { persist: async written => { daemonStateSchema.parse(boundDaemonState(written)); } });
    const cycle = (offsetMs: number) => { at.value = clock0 + offsetMs; return runCycle(cfg, state, loop, () => at.value); };
    await cycle(0);
    harness.agents = [sessionAgent(cfg, 'pane-1')];
    for (const offset of [20_000, 40_000, 60_000]) await cycle(offset);
    assert.deepEqual(harness.wakes, [], 'a 150-subject backlog the handover named never reads as changed');
    assert.equal(Object.keys(state.master.subjects).length, 150, 'every standing subject keeps its digest');
    work.push(item('GY-151'));
    await cycle(80_000);
    for (const offset of [100_000, 120_000, 140_000]) await cycle(offset);
    assert.equal(harness.wakes.length, 1, 'the one event wakes once, and the cycles after it are quiet');
    assert.match(harness.wakes[0], /dispatch:GY-151/);
  });
}
