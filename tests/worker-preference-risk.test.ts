import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchWork, loadMasterConfig, setupMaster, type WorkerProfile } from '../src/master.js';
import { readProfileLaunchRecords } from '../src/master/dispatch.js';
import type { FleetClient } from '../src/fleet.js';
import { expandTypedCommand } from './helpers/launch-shell.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { sensitiveRules } from '../src/model/risk-class.js';
import { piAttempts, workerPreference } from '../src/model/worker-preference.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1772: dispatch prefers Pi by the risk class of the change the item plans, not by its path lane.
 * The lane classifies a pull request's observed paths once there is one; before any launch the only
 * view of the change is `plannedFiles`, judged by the risk class's `sensitiveRules`. A normal planned
 * change gets its first two attempts on Pi whatever its lane; a sensitive planned path, an item that
 * plans no files, a third attempt and two failed starts go to the strong runtimes whatever its lane.
 */

const lanes = ['low', 'medium', 'high', null, undefined];
/** One path per sensitive rule, so each rule is shown to hold the first attempts off Pi. */
const sensitivePaths: Record<string, string> = {
  'persistence layer': 'src/store/work-store.ts', 'server auth, principals, API assembler, bootstrap or routes': 'src/server/auth.ts', 'operator agent': 'src/operator-agent.ts',
  'proof grants': 'src/proof-grants.ts', installation: 'src/install/host.ts', deployment: 'deploy/compose.yml', Dockerfile: 'Dockerfile', 'compose file': 'compose.yaml',
  'CI configuration': '.github/workflows/ci.yml', dependencies: 'package.json', 'merge path': 'src/main-guard.ts', 'merge writer': 'src/merge-writer/index.ts', migrations: 'migrations/0042_items.sql',
};
const normalFiles = ['src/master/dispatch.ts', 'src/model/worker-preference.ts', 'tests/worker-preference-risk.test.ts', 'docs/delegation.md'];
/** An item whose `lane` is never read: the preference judges the change, not the lane. */
const laneBlind = <T extends object>(work: T) => new Proxy(work, { get(target, property, receiver) { if (property === 'lane') throw new Error('workerPreference read the lane'); return Reflect.get(target, property, receiver); } });

test('unit:worker-preference-by-risk — a normal planned change is fast on its first two attempts whatever its lane; a sensitive planned path, no planned files, a third attempt and two failed starts are strong whatever its lane', () => {
  for (const lane of lanes) {
    // Normal planned files: the first two attempts go to Pi, whether counted as rework rounds, ended attempts or the coordination view's count.
    for (const made of [0, 1]) {
      assert.equal(workerPreference({ lane, plannedFiles: normalFiles, pipeline: { reworkRounds: made, attempts: [] } }), 'fast', `lane ${lane}, ${made} rework rounds: Pi`);
      assert.equal(workerPreference({ lane, plannedFiles: normalFiles, pipeline: { reworkRounds: 0, attempts: Array.from({ length: made }, () => ({})) } }), 'fast', `lane ${lane}, ${made} ended attempts: Pi`);
      assert.equal(workerPreference({ lane, plannedFiles: normalFiles, attemptCount: made }), 'fast', `lane ${lane}, attemptCount ${made}: Pi`);
      assert.equal(workerPreference({ lane, plannedFiles: normalFiles, attemptCount: made }, 1 - made), 'fast', 'a failed start counts as an attempt made; one plus one is still within the two');
    }
    // Any sensitive planned path, by every rule: the strong runtimes from the first attempt, beside however many normal files.
    for (const { rule, pattern } of sensitiveRules) {
      const path = sensitivePaths[rule];
      assert.ok(path && pattern.test(path), `the fixture names a path for rule ${rule}`);
      assert.equal(workerPreference({ lane, plannedFiles: [...normalFiles, path], pipeline: { reworkRounds: 0, attempts: [] } }), 'strong', `lane ${lane}, ${path} (${rule}): strong`);
    }
    // No planned files: a change nobody can see is the worst case.
    assert.equal(workerPreference({ lane, plannedFiles: [], pipeline: { reworkRounds: 0, attempts: [] } }), 'strong', `lane ${lane}, empty plannedFiles: strong`);
    assert.equal(workerPreference({ lane, pipeline: { reworkRounds: 0, attempts: [] } }), 'strong', `lane ${lane}, no plannedFiles at all: strong`);
    // The third attempt and after, however the attempts are counted.
    assert.equal(workerPreference({ lane, plannedFiles: normalFiles, pipeline: { reworkRounds: piAttempts, attempts: [] } }), 'strong', `lane ${lane}, third attempt by rework rounds: strong`);
    assert.equal(workerPreference({ lane, plannedFiles: normalFiles, pipeline: { reworkRounds: 0, attempts: [{}, {}] } }), 'strong', `lane ${lane}, third attempt by ended attempts: strong`);
    assert.equal(workerPreference({ lane, plannedFiles: normalFiles, attemptCount: 2 }), 'strong', `lane ${lane}, third attempt by the coordination view: strong`);
    assert.equal(workerPreference({ lane, plannedFiles: normalFiles, pipeline: { reworkRounds: 5, attempts: [] } }), 'strong');
    // Two start failures under this dispatch.
    assert.equal(workerPreference({ lane, plannedFiles: normalFiles, pipeline: { reworkRounds: 0, attempts: [] } }, 2), 'strong', `lane ${lane}, two failed starts: strong`);
  }
  // The lane is never read at all: every answer above is the same whatever the lane holds.
  assert.equal(workerPreference(laneBlind({ plannedFiles: normalFiles, pipeline: { reworkRounds: 0, attempts: [] } })), 'fast');
  assert.equal(workerPreference(laneBlind({ plannedFiles: ['src/store/work-store.ts'], pipeline: { reworkRounds: 0, attempts: [] } })), 'strong');
  assert.equal(workerPreference(laneBlind({ plannedFiles: [] })), 'strong');
});

/** A Herdr world on which every runtime comes up: the pane shows the runtime ready and the agent is found. */
function world() {
  const kinds: string[] = [];
  let now = Date.now();
  const json = (result: unknown) => JSON.stringify({ result });
  return { kinds, bounds: () => ({ clock: () => now, wait: (ms: number) => { now += ms; } }), run: (_command: string, args: string[]): string => {
    if (args[0] === 'tab' && args[1] === 'create') return json({ root_pane: { pane_id: 'w1V:pP1', tab_id: 'w1V:tP1' } });
    if (args[0] === 'pane' && args[1] === 'run') { kinds.push(expandTypedCommand(args[3]).kind); return ''; }
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    const kind = kinds.at(-1);
    if (!kind) return json({});
    if (args[0] === 'pane' && args[1] === 'process-info') return json({ process_info: { shell_pid: 10, foreground_process_group_id: 11, foreground_processes: [] } });
    if (args[0] === 'pane' && args[1] === 'read') return `${kind} ready\n`;
    if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: kind, agent_status: 'idle', pane_id: args[2] } });
    if (args[0] === 'agent' && args[1] === 'rename') return json({ agent: { agent: kind, name: args[3] } });
    return json({});
  } };
}

test('unit:dispatch-hands-planned-files — a real dispatch hands the item\'s plannedFiles to the preference, so a normal change in the high lane goes to Pi and a sensitive change in the low lane to a strong account, and the selection record names the preference it used', async () => {
  const holder = await temporaryDirectory('preference-dispatch'), root = join(holder, 'repository'), credentials = join(holder, 'credentials');
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials, herdrWorkspace: 'w1V' }, coordinatorStatus);
  const master = await loadMasterConfig(root), hostId = master.hostId ?? 'unknown-host';
  const workerDirectory = join(holder, 'worker-credentials'), credentialFile = join(workerDirectory, 'worker.token');
  await mkdir(workerDirectory, { mode: 0o700 });
  await writeFile(credentialFile, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(join(root, 'assigned'), { recursive: true });
  const profile: WorkerProfile = { name: 'registry-worker', principal: 'graphyard-worker-1', agentName: 'eng-pi', mode: 'launch', kind: 'pi', credentialFile, agentArgs: [], approvals: 'auto', environment: {} };
  const item = (key: string, lane: string, plannedFiles: string[]) => ({ id: `work-${key}`, key, title: 'Preference by risk', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles, lane, pipeline: { reworkRounds: 0, attempts: [] },
    criteria: [{ id: 'AC-2', text: 'Dispatch hands planned files', proofs: ['unit:dispatch-hands-planned-files'] }], policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] }) as any;

  const dispatch = async (work: any) => {
    const at = new Date().toISOString();
    await mkdir(dirname(master.credentialFile), { recursive: true });
    // The stored order names the strong account first: only the preference puts Pi ahead of it.
    let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', { runtimes: proposedRuntimes.filter(runtime => ['pi', 'claude'].includes(runtime.name)),
      models: [{ name: 'glm', id: 'zai/glm-5.3' }, { name: 'opus', id: 'claude-opus-5' }],
      accounts: [{ name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: hostId, home: null } }, { name: 'pi-a', runtime: 'pi', model: 'glm', credential: { host: hostId, home: null } }],
      roles: [{ name: 'worker', accounts: ['claude-b', 'pi-a'], concurrency: 4 }], reason: 'fixture' }, { actor: 'operator', at }).registry;
    const requests: { prefer?: string; work: string | null }[] = [];
    const client: FleetClient = {
      document: async () => structuredClone(registry),
      select: async request => {
        requests.push({ prefer: request.prefer, work: request.work });
        const choice = chooseSession(registry, request, Date.now());
        if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
        const session: FleetSession = { id: `session-${requests.length}`, role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
          selectedAt: at, selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
        registry = { ...registry, sessions: [...registry.sessions, session] };
        return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
      },
      end: async id => { registry = { ...registry, sessions: registry.sessions.map(session => session.id === id ? { ...session, endedAt: at, endReason: 'ended' } : session) }; },
    };
    let claims = 0;
    const prepare = async () => ({ epoch: ++claims, path: join(root, 'assigned'), base: 'c'.repeat(40) });
    const herdr = world();
    const dispatched = await dispatchWork(root, work, profile, [], herdr.run, [work], prepare, async () => {}, 5_000, at, { start: herdr.bounds(), probe: { registry: client, quota: false, cacheMs: 0, now: () => Date.parse(at) } as never });
    const record = (await readProfileLaunchRecords(root, [profile]))[profile.name];
    return { dispatched, kinds: herdr.kinds, requests, record };
  };

  // A high-lane item whose planned files are all normal: the preference the dispatch hands the registry is fast, and Pi takes it.
  const normal = await dispatch(item('GY-1', 'high', ['src/master/dispatch.ts', 'tests/worker-preference-risk.test.ts']));
  assert.deepEqual(normal.requests, [{ prefer: 'fast', work: 'GY-1' }], 'the selection request carries the preference the planned files decided');
  assert.deepEqual(normal.kinds, ['pi']);
  assert.equal(normal.dispatched.account!.environment, 'pi-a');
  assert.equal(normal.dispatched.account!.prefer, 'fast', 'the dispatch\'s selection names the preference it used');
  assert.equal(normal.record.prefer, 'fast', 'the dispatch record names it too');
  assert.equal(normal.record.account, 'pi-a');

  // A low-lane item whose planned files include a sensitive path: strong, so the strong account takes it although Pi is eligible.
  const sensitive = await dispatch(item('GY-2', 'low', ['src/master/dispatch.ts', 'src/store/work-store.ts']));
  assert.deepEqual(sensitive.requests, [{ prefer: 'strong', work: 'GY-2' }]);
  assert.deepEqual(sensitive.kinds, ['claude']);
  assert.equal(sensitive.dispatched.account!.environment, 'claude-b');
  assert.equal(sensitive.dispatched.account!.prefer, 'strong');
  assert.equal(sensitive.record.prefer, 'strong');

  // A low-lane item planning no files is the worst case: strong as well.
  const unplanned = await dispatch(item('GY-3', 'low', []));
  assert.deepEqual(unplanned.requests, [{ prefer: 'strong', work: 'GY-3' }]);
  assert.equal(unplanned.dispatched.account!.environment, 'claude-b');
  assert.equal(unplanned.record.prefer, 'strong');

  // The source hands the item itself to the preference, so plannedFiles reach it, and the lane is not what it reads.
  const source = await readFile(new URL('../src/master/dispatch.ts', import.meta.url), 'utf8');
  assert.match(source, /prefer = workerPreference\(work, startFailures\.length\)/, 'dispatch.ts hands the item, planned files included, to workerPreference');
  const preference = await readFile(new URL('../src/model/worker-preference.ts', import.meta.url), 'utf8');
  assert.ok(!/work\.lane/.test(preference), 'the preference never reads the lane');
  assert.match(preference, /plannedFiles/, 'the preference reads the planned files');
});
