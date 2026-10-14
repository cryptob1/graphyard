import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchWork, loadMasterConfig, setupMaster, type WorkerProfile } from '../src/master.js';
import type { FleetClient } from '../src/fleet.js';
import { expandTypedCommand } from './helpers/launch-shell.js';
import { coordinatorConfinementRefusal } from '../src/master/profiles.js';
import { runtimeSandboxes, verifyWorkerSandbox, WorkerSandboxError } from '../src/worker-sandbox.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1746: Pi is a first-class worker runtime. Its launch is confined as any runtime without a
 * sandbox of its own is, and dispatch tries Pi accounts first only for a normal risk planned change
 * (GY-1772: judged from plannedFiles, never the path lane) on its first two attempts; a sensitive
 * planned change, a third or later attempt and a role with no eligible Pi account go to the strong
 * runtimes, and an account that fails to start gives way to the next.
 */

const host = 'host-1';
function fleet(): AgentRegistry {
  const home = (name: string) => ({ host, home: `/homes/${name}` });
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude' || runtime.name === 'codex' || runtime.name === 'pi'),
    models: [{ name: 'opus', id: 'claude-opus-5' }, { name: 'gpt', id: 'gpt-5' }, { name: 'glm', id: 'zai/glm-5.3' }],
    accounts: [{ name: 'claude-b', runtime: 'claude', model: 'opus', credential: home('claude-b') }, { name: 'codex-a', runtime: 'codex', model: 'gpt', credential: home('codex-a') },
      { name: 'pi-a', runtime: 'pi', model: 'glm', credential: home('pi-a') }, { name: 'pi-b', runtime: 'pi', model: 'glm', credential: home('pi-b') }],
    // The stored order names the strong accounts first: the preference, not the stored order, puts Pi ahead.
    roles: [{ name: 'worker', accounts: ['claude-b', 'pi-a', 'codex-a', 'pi-b'], concurrency: 4 }],
    reason: 'fixture',
  }, { actor: 'operator', at: new Date().toISOString() }).registry;
}
// Imported when a case runs, so a checkout without the rule fails the case rather than the file.
const { workerPreference } = await import('../src/model/worker-preference.js').then(module => module as unknown as { workerPreference?: (work: object, startFailures?: number) => 'fast' | 'strong' }).then(module => ({ workerPreference: module.workerPreference ?? (() => 'fast' as const) }));
const pick = (registry: AgentRegistry, work: object, exclude: string[] = []) =>
  chooseSession(registry, { role: 'worker', host, prefer: workerPreference(work, exclude.length), exclude } as never, Date.now());

test('unit:pi-worker-confined — the pi runtime is known to the worker sandbox and a Pi worker is probed behind the coordinator confinement; a host that cannot confine it refuses the launch', async () => {
  const pi = runtimeSandboxes.pi;
  assert.ok(pi, 'worker-sandbox.ts has an entry for pi');
  assert.equal(pi.mode(['--model', 'zai/glm-5.3']), null, 'pi restricts no writes itself');
  assert.deepEqual(pi.grant(['/worktree']), [], 'pi is granted no sandbox directories');

  // The probe runs inside the confinement words the launch carries, and a refusal names the path.
  const ran: string[][] = [];
  const confinement = ['bwrap', '--unshare-pid', '--'];
  verifyWorkerSandbox({ kind: 'pi', args: [], confinement }, '/worktree', ['/worktree'], (command, args) => { ran.push([command, ...args]); return 'writable\n'; });
  assert.deepEqual(ran[0].slice(0, 3), confinement, 'the Pi worker is probed behind the read-only-mount confinement');
  assert.throws(() => verifyWorkerSandbox({ kind: 'pi', args: [], confinement }, '/worktree', ['/worktree'], () => 'unwritable\t/worktree\tRead-only file system\n'), (error: unknown) => error instanceof WorkerSandboxError && error.runtime === 'pi' && error.path === '/worktree');

  // A host without the means to confine a runtime that has no sandbox of its own never starts it.
  const base = await temporaryDirectory('pi-confined');
  execFileSync('git', ['init', '-q', '-b', 'main', base]);
  const refusal = await coordinatorConfinementRefusal({ kind: 'pi', args: [], coordinatorRoot: base, sessionDirectory: join(base, 'worktree'), platform: 'linux', bwrap: null });
  assert.match(refusal ?? '', /A pi session cannot be launched .* never starts a session unconfined/s);
});

test('unit:pi-first-worker-order — a normal risk planned change on its first two attempts is tried on Pi accounts first; a sensitive planned change, a third or later attempt and a role with no eligible Pi account go to the strong accounts', () => {
  const registry = fleet();
  // GY-1772: the class of the planned files decides, not the lane; a low lane with a sensitive planned path is strong, a high lane with normal planned files is fast.
  const normal = ['src/master/dispatch.ts', 'tests/pi-worker-dispatch.test.ts'], sensitive = ['src/master/dispatch.ts', 'src/store/work-store.ts'];
  for (const lane of ['low', 'medium', 'high']) for (const reworkRounds of [0, 1]) {
    const choice = pick(registry, { lane, plannedFiles: normal, pipeline: { reworkRounds } });
    assert.equal(choice.account?.name, 'pi-a', `lane ${lane}, normal planned files, attempt ${reworkRounds + 1} goes to Pi`);
  }
  assert.equal(pick(registry, { lane: 'low', plannedFiles: sensitive, pipeline: { reworkRounds: 0 } }).account?.name, 'claude-b', 'a sensitive planned change goes to the strong accounts');
  assert.equal(pick(registry, { lane: 'low', plannedFiles: [], pipeline: { reworkRounds: 0 } }).account?.name, 'claude-b', 'an item planning no files goes to the strong accounts');
  assert.equal(pick(registry, { lane: 'low', plannedFiles: normal, pipeline: { reworkRounds: 2 } }).account?.name, 'claude-b', 'a third attempt goes to the strong accounts');
  assert.equal(pick(registry, { lane: 'medium', plannedFiles: normal, pipeline: { reworkRounds: 4 } }).account?.name, 'claude-b');
  // Attempts that ended without a rework round (an expired or blocked epoch) count too: the third attempt goes to the strong accounts.
  const attempt = (end: string) => ({ epoch: 1, owner: 'w', end, claimedAt: '', endedAt: '' });
  assert.equal(pick(registry, { lane: 'low', plannedFiles: normal, pipeline: { reworkRounds: 0, attempts: [attempt('expired'), attempt('blocked')] } }).account?.name, 'claude-b', 'two failed attempts leave the third on the strong accounts');
  assert.equal(pick(registry, { lane: 'low', plannedFiles: normal, pipeline: { reworkRounds: 0, attempts: [attempt('expired')] } }).account?.name, 'pi-a', 'one earlier attempt leaves the second on Pi');

  // No eligible Pi account: the strong accounts take a normal first attempt, and nothing is refused.
  const withoutPi = structuredClone(registry);
  for (const account of withoutPi.accounts.filter(entry => entry.runtime === 'pi')) account.enabled = false;
  const fallback = pick(withoutPi, { lane: 'low', plannedFiles: normal, pipeline: { reworkRounds: 0 } });
  assert.equal(fallback.account?.name, 'claude-b');
  assert.match(fallback.skipped.map(entry => entry.account).join(), /pi-a,pi-b/);

  // A strong item is held when no strong account is eligible: Pi never takes it.
  const strongSpent = structuredClone(registry);
  for (const account of strongSpent.accounts.filter(entry => entry.runtime !== 'pi')) account.enabled = false;
  const held = pick(strongSpent, { lane: 'low', plannedFiles: sensitive, pipeline: { reworkRounds: 0 } });
  assert.equal(held.account, null, 'a sensitive item waits for a strong account instead of falling to Pi');
  // The attempt count the coordination view keeps (the view drops the pipeline) counts as attempts, and so do launches this dispatch already spent.
  assert.equal(pick(registry, { lane: 'low', plannedFiles: normal, attemptCount: 2 }).account?.name, 'claude-b');
  assert.equal(pick(registry, { lane: 'low', plannedFiles: normal, attemptCount: 1 }).account?.name, 'pi-a');
  assert.equal(workerPreference({ plannedFiles: normal, attemptCount: 0 }, 2), 'strong', 'two failed Pi starts leave the third launch to the strong accounts');

  // Other roles keep their stored order whatever is preferred.
  registry.roles.push({ name: 'reviewer', accounts: ['claude-b', 'pi-a'], concurrency: 2 } as AgentRegistry['roles'][number]);
  assert.equal(chooseSession(registry, { role: 'reviewer', host, prefer: 'fast' }, Date.now()).account?.name, 'claude-b');
});

/** A Herdr world on which the listed runtimes never come up (their pane keeps echoing the command), and a pi launch can be refused outright. */
function world(healthy: Set<string>, refusePi?: string, exitPi = false) {
  const kinds: string[] = [];
  let typedCommand = '', now = Date.now();
  const json = (result: unknown) => JSON.stringify({ result });
  return { kinds, bounds: () => ({ clock: () => now, wait: (ms: number) => { now += ms; } }), run: (_command: string, args: string[]): string => {
    if (args[0] === 'tab' && args[1] === 'create') return json({ root_pane: { pane_id: 'w1V:pP1', tab_id: 'w1V:tP1' } });
    if (args[0] === 'pane' && args[1] === 'run') {
      const kind = expandTypedCommand(args[3]).kind;
      kinds.push(kind); typedCommand = args[3];
      if (kind === 'pi' && refusePi) throw new Error(refusePi);
      return '';
    }
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    const kind = kinds.at(-1);
    if (!kind) return json({});
    if (args[0] === 'pane' && args[1] === 'process-info') return json({ process_info: kind === 'pi' && exitPi ? { shell_pid: 10, foreground_process_group_id: 10 } : { shell_pid: 10, foreground_process_group_id: 11, foreground_processes: [] } });
    if (args[0] === 'pane' && args[1] === 'read') return kind === 'pi' && exitPi ? `vish@host ~/code/project ❯ ${typedCommand}\npi: command not found\nvish@host ~/code/project ❯\n` : healthy.has(kind) ? `${kind} ready\n` : `vish@host ~/code/project ❯ ${typedCommand}\n`;
    if (args[0] === 'agent' && args[1] === 'get') return healthy.has(kind) ? json({ agent: { agent: kind, agent_status: 'idle', pane_id: args[2] } }) : JSON.stringify({ error: { code: 'agent_not_found', message: `agent target ${args[2]} not found` } });
    if (args[0] === 'agent' && args[1] === 'rename') return json({ agent: { agent: kind, name: args[3] } });
    return json({});
  } };
}

test('unit:pi-launch-failure-falls-back — a Pi launch that never starts, or is refused before it starts, records the failure on the account and the same real dispatch launches the next account', async () => {
  // One marked parent holds the repository and the credentials, so the loop's reclaim pass sees one directory, not an empty-looking sibling.
  const holder = await temporaryDirectory('pi-dispatch'), root = join(holder, 'repository'), credentials = join(holder, 'credentials');
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials, herdrWorkspace: 'w1V' }, coordinatorStatus);
  const master = await loadMasterConfig(root), hostId = master.hostId ?? 'unknown-host';
  // The worker's token lives beside, not inside, the coordinator's credential directory: the launcher sweeps the former.
  const workerDirectory = join(holder, 'worker-credentials'), credentialFile = join(workerDirectory, 'worker.token');
  await mkdir(workerDirectory, { mode: 0o700 });
  await writeFile(credentialFile, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(join(root, 'assigned'), { recursive: true });
  const profile: WorkerProfile = { name: 'registry-worker', principal: 'graphyard-worker-1', agentName: 'eng-pi', mode: 'launch', kind: 'pi', credentialFile, agentArgs: [], approvals: 'auto', environment: {} };
  const item = { id: 'work-1746', key: 'GY-1746', title: 'Pi first', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['src/'], lane: 'low', pipeline: { reworkRounds: 0, attempts: [] },
    criteria: [{ id: 'AC-3', text: 'Fallback', proofs: ['unit:pi-launch-failure-falls-back'] }], policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] } as any;

  const dispatch = async (refusePi?: string, exitPi = false, piAccounts = ['pi-a', 'pi-b']) => {
    const at = new Date().toISOString();
    await mkdir(dirname(master.credentialFile), { recursive: true });
    let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', { runtimes: proposedRuntimes.filter(runtime => ['pi', 'claude'].includes(runtime.name)),
      models: [{ name: 'glm', id: 'zai/glm-5.3' }, { name: 'opus', id: 'claude-opus-5' }],
      accounts: [{ name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: hostId, home: null } }, ...piAccounts.map(name => ({ name, runtime: 'pi', model: 'glm', credential: { host: hostId, home: null } }))],
      roles: [{ name: 'worker', accounts: ['claude-b', ...piAccounts], concurrency: 4 }], reason: 'fixture' }, { actor: 'operator', at }).registry;
    const chosen: string[] = [], ended: string[] = [];
    const client: FleetClient = {
      document: async () => structuredClone(registry),
      select: async request => {
        const choice = chooseSession(registry, request, Date.now());
        if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
        const session: FleetSession = { id: `session-${chosen.length + 1}`, role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
          selectedAt: at, selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
        registry = { ...registry, sessions: [...registry.sessions, session] };
        chosen.push(choice.account.name);
        return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
      },
      end: async id => { ended.push(id); registry = { ...registry, sessions: registry.sessions.map(session => session.id === id ? { ...session, endedAt: at, endReason: 'ended' } : session) }; },
    };
    let claims = 0;
    const prepare = async () => ({ epoch: ++claims, path: join(root, 'assigned'), base: 'c'.repeat(40) });
    const herdr = world(new Set(['claude']), refusePi, exitPi);
    const dispatched = await dispatchWork(root, item, profile, [], herdr.run, [item], prepare, async () => {}, 5_000, at, { start: herdr.bounds(), probe: { registry: client, quota: false, cacheMs: 0, now: () => Date.parse(at) } as never });
    return { dispatched, kinds: herdr.kinds, chosen, ended, claims };
  };

  // Both Pi accounts never come up: each is recorded and the strong account takes the same dispatch.
  const never = await dispatch();
  assert.deepEqual(never.kinds, ['pi', 'pi', 'claude'], 'Pi is tried first, then the next Pi account, then the strong account, in one dispatch');
  assert.equal(never.dispatched.account!.environment, 'claude-b');
  assert.deepEqual(never.dispatched.fallback!.failed.map(failure => failure.account), ['pi-a', 'pi-b']);
  // A Pi launch the host refuses before any session starts — it cannot confine the runtime — also falls through.
  const refused = await dispatch('A pi session cannot be launched on this host: Graphyard never starts a session unconfined');
  assert.deepEqual(refused.kinds, ['pi', 'pi', 'claude']);
  assert.equal(refused.dispatched.account!.environment, 'claude-b');
  assert.deepEqual(refused.dispatched.fallback!.failed.map(failure => [failure.account, failure.kind]), [['pi-a', 'pi'], ['pi-b', 'pi']], 'the refusal is recorded on each Pi account the dispatch passed over');
  // A Pi session that exits back to the shell before it is ready also falls through.
  const exited = await dispatch(undefined, true);
  assert.deepEqual(exited.kinds, ['pi', 'pi', 'claude']);
  assert.deepEqual(exited.dispatched.fallback!.failed.map(failure => failure.account), ['pi-a', 'pi-b']);
  // Three Pi accounts: the two launches the dispatch spent on Pi are all it gets; the third launch goes to the strong account.
  const three = await dispatch(undefined, true, ['pi-a', 'pi-b', 'pi-c']);
  assert.deepEqual(three.kinds, ['pi', 'pi', 'claude'], 'no third Pi start within one dispatch');
});

test('unit:pi-default-worker-roles — a Pi account joins the worker role by default on connection and in a discovery proposal', async () => {
  const { connectDefaultRoles } = await import('../src/fleet.js');
  assert.ok(connectDefaultRoles('fast', 'pi').includes('worker'));
  assert.ok(!connectDefaultRoles('fast', 'opencode').includes('worker'), 'a Settings-connected fast OpenCode account stays out of the worker role');
  const { proposedRuntimeRoles } = await import('../src/model/registry-proposal.js');
  assert.ok(proposedRuntimeRoles.pi?.includes('worker'));
});

test('unit:pi-coordination-view-attempts — the coordination view keeps the attempts already made', async () => {
  const { coordinationWork } = await import('../src/server/work-view.js') as any;
  const view = coordinationWork?.({ key: 'GY-1', stage: 'ready', evidence: [], pipeline: { reworkRounds: 0, attempts: [{}, {}] } }, { evidence: 0, dispatchHistory: 0, queueHistory: 0, actionHistory: 0, sessions: 0 });
  assert.equal(view?.attemptCount, 2);
});

test('unit:pi-coordination-projection-attempts — the saved-document projection keeps the attempt count a worker preference reads', async () => {
  const { coordinationProjection } = await import('../src/store/locked-read.js');
  const { workerPreference } = await import('../src/model/worker-preference.js');
  const projected = coordinationProjection({ key: 'GY-1', lane: 'low', plannedFiles: ['src/master/dispatch.ts'], stage: 'ready', evidence: [], pipeline: { reworkRounds: 0, attempts: [{}, {}] } } as any) as any;
  assert.equal(projected.attemptCount, 2);
  assert.deepEqual(projected.plannedFiles, ['src/master/dispatch.ts'], 'the projection keeps the planned files the preference reads (GY-1772)');
  assert.equal(workerPreference(projected), 'strong', 'two ended attempts and no rework round still send the third to the strong profiles');
  assert.equal(workerPreference({ ...projected, attemptCount: 1 }), 'fast', 'the projected planned files let a normal change\'s second attempt go to Pi');
});

test('unit:pi-old-server-selection — a control plane that rejects the preference fields is asked again without them', async () => {
  const { httpFleetClient } = await import('../src/fleet.js');
  const holder = await temporaryDirectory('pi-old-server'), credentialFile = join(holder, 'token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const bodies: any[] = [];
  const fetcher = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body); bodies.push(body);
    return 'prefer' in body ? new Response(JSON.stringify({ error: 'Unrecognized key: prefer' }), { status: 400 }) : new Response(JSON.stringify({ selected: false }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = httpFleetClient({ url: 'https://graphyard.example', credentialFile }, fetcher);
  const result = await client.select({ role: 'worker', host, work: 'GY-1', group: null, principal: null, prefer: 'fast', exclude: ['pi-a'], observations: [] });
  assert.equal(result.selected, false);
  assert.equal(bodies.length, 2);
  assert.ok(!('prefer' in bodies[1]) && !('exclude' in bodies[1]));
});
