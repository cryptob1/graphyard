import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverSessionName, assertSessionName, atomicPrivateWrite, distinctSessionName, launchApprover, saveWorkerProfile, loadMasterConfig, masterConfigSchema, producerProfileSchema, reviewerProfileSchema, sessionName, sessionNameLimit, sessionNameRefusal, SessionNameRefusedError, setupMaster, startAgentSession, startMaster, workerProfileSchema, type HerdrAgent, type MasterConfig, type MasterRun } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { daemonSummary, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { approverLaunchAttention } from '../src/cli/master-status.js';
import { buildProposal, proposedWorkerProfileSchema } from '../src/onboarding.js';
import { escalationTriggers, type Work } from '../src/model.js';

// GY-101: a per-decision approver session name that no runtime would accept meant no approver
// could be launched at all, so every two-party decision stood unjudged. One case per proof:
// unit:approver-name-bounded-and-unique, unit:generated-session-names-valid,
// integration:approver-launch-refusal-visible.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const uuid = (label: string) => `${label.padEnd(8, '0').slice(0, 8)}-4cb5-4f21-9b0e-0f2a6c8d4e15`;
/** The runtime's own rule, written out here so the tests judge the names against it, not against the builder. */
const launchable = (name: string) => /^[a-z][a-z0-9_-]{0,31}$/.test(name);

const hour = 3_600_000;
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();

async function repository(prefix: string, remote = 'owner/project') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${remote}.git`], { cwd: root });
  return root;
}

test('unit:approver-name-bounded-and-unique — an approver session name fits the runtime\'s 32-character limit for every work key and decision id, names one decision only, and still shows its item', () => {
  const decision = uuid('4cb51514'), other = uuid('9f0ab27c');

  // The name this defect was found on: 33 characters before, inside the limit now, and still
  // readable as the approver of GY-80.
  const found = approverSessionName({ key: 'GY-80' }, decision);
  assert.equal(found, 'graphyard-approver-gy-80-4cb5151', 'the 33-character name this defect was found on now fits the limit');
  assert.ok(launchable(found), `${found} is a name the runtime accepts`);
  assert.ok(found.includes('gy-80'), `${found} says which item it judges`);
  assert.ok(found.includes(decision.slice(0, 4)), `${found} says which decision it judges`);

  // Every key the control plane can produce, with a full decision id: `GY-<number>` at the widths
  // it grows through, and the 40 characters the loop's own watch bounds a key to.
  const keys = ['GY-1', 'GY-80', 'GY-101', 'GY-9999', 'GY-123456789', `GY-${'9'.repeat(37)}`];
  for (const key of keys) {
    const name = approverSessionName({ key }, decision);
    assert.ok(launchable(name), `${key}: ${name} is ${name.length} characters, and the limit is ${sessionNameLimit}`);
    assert.notEqual(name, approverSessionName({ key }, other), `${key}: a second decision on one item is a second session`);
    assert.equal(name, approverSessionName({ key }, decision), `${key}: the same decision is always the same session`);
  }

  // Distinctness holds where the limit forces the name to be shortened, both across decisions that
  // share a prefix and across items whose keys do.
  const longest = `GY-${'9'.repeat(37)}`;
  const crowded = new Set([
    approverSessionName({ key: longest }, decision),
    approverSessionName({ key: longest }, `${decision.slice(0, 30)}ffffff`),
    approverSessionName({ key: `${longest}0` }, decision),
  ]);
  assert.equal(crowded.size, 3, 'a shortened name still names one decision on one item');

  // The work key survives the limit: a key long enough to crowd out the decision id shortens the
  // role word rather than itself, so the session list always says which item is being judged.
  for (const key of keys) assert.ok(approverSessionName({ key }, decision).includes(key.toLowerCase().slice(0, 9)), `${key}: ${approverSessionName({ key }, decision)} still shows its item`);
  assert.equal(approverSessionName({ key: 'GY-123456' }, decision), 'gy-approver-gy-123456-4cb51514');
  // Two decisions on one item are told apart by at least six characters of the decision id, never
  // the four that would collide once in 65,536: the role word gives way first.
  for (const key of keys) {
    const name = approverSessionName({ key }, decision), fragment = name.slice(name.lastIndexOf('-') + 1);
    if (key.length <= 11) assert.ok(fragment.length >= 6 && decision.startsWith(fragment), `${key}: ${name} carries ${fragment.length} characters of the decision id`);
  }
  assert.equal(approverSessionName({ key: 'GY-101' }, decision), 'graphyard-approver-gy-101-4cb515');
  assert.equal(approverSessionName({ key: 'GY-10000' }, decision), 'gy-approver-gy-10000-4cb51514');
  // The boundary docs/master-agent.md names: GY-999 is the last key that keeps the full role word.
  assert.equal(approverSessionName({ key: 'GY-999' }, decision), 'graphyard-approver-gy-999-4cb515');
  assert.equal(approverSessionName({ key: 'GY-1000' }, decision), 'gy-approver-gy-1000-4cb51514');
  assert.notEqual(approverSessionName({ key: 'GY-12345' }, decision), approverSessionName({ key: 'GY-12345' }, uuid('4cb5a000')), 'decisions sharing four leading characters are two sessions');
  assert.equal(sessionNameRefusal(approverSessionName({ key: 'GY-101' }, decision)), null);
  // Nothing Graphyard composes can leave the bounds, whatever it is composed from.
  assert.ok(launchable(sessionName('graphyard-approver', 'GY-101', decision)));
});

test('unit:generated-session-names-valid — every session name Graphyard generates is checked against the runtime\'s naming rules where it is constructed, so a name that cannot launch is refused before a pane is allocated', async () => {
  // The rule itself, as the runtime states it.
  assert.equal(sessionNameRefusal('graphyard-approver-gy-101-4cb5'), null);
  assert.match(sessionNameRefusal('graphyard-approver-gy-80-4cb51514')!, /33 characters, past the 32-character limit/);
  assert.match(sessionNameRefusal('Approver-GY-101')!, /starts with "A" rather than a lowercase letter/);
  assert.match(sessionNameRefusal('gy.approver.101')!, /contains "\."/);
  assert.match(sessionNameRefusal('')!, /empty/);

  // Approver and escalation-handler names, over every trigger and a key that leaves no room.
  for (const key of ['GY-1', 'GY-101', 'GY-123456789012345678901234567890']) {
    for (const trigger of escalationTriggers) {
      const handler = distinctSessionName(['graphyard-escalation', 'graphyard-esc', 'gy-esc'], key, trigger);
      assert.ok(launchable(handler), `${key}/${trigger}: ${handler}`);
    }
    assert.ok(launchable(approverSessionName({ key }, uuid('4cb51514'))));
  }

  // The master's own session name, as `master init` generates it for repositories of any name.
  for (const repository of ['graphyard', 'a-repository-with-a-very-long-name-indeed', 'x']) {
    const name = sessionName('graphyard-master', repository);
    assert.ok(launchable(name), `${repository}: ${name}`);
  }
  const root = await repository('graphyard-session-names-', 'owner/a-repository-with-a-very-long-name-indeed');
  const credentials = await mkdtemp(join(tmpdir(), 'graphyard-session-names-credentials-'));
  try {
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/a-repository-with-a-very-long-name-indeed', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    const config = await loadMasterConfig(root);
    assert.ok(launchable(config.masterAgentName), `master init generated ${config.masterAgentName}`);

    // A configured profile is refused where it is read, not at the launch that allocates its pane.
    const worker = { name: 'worker-a', principal: 'graphyard-worker-a', mode: 'launch' as const, kind: 'claude' as const, credentialFile: join(credentials, 'worker.token') };
    assert.throws(() => workerProfileSchema.parse({ ...worker, agentName: 'graphyard-worker-with-a-name-far-past-the-limit' }), /Herdr cannot launch a session named .*47 characters, past the 32-character limit/);
    assert.throws(() => reviewerProfileSchema.parse({ name: 'review-a', agentName: 'Review-A', kind: 'claude' }), /rather than a lowercase letter/);
    assert.throws(() => producerProfileSchema.parse({ name: 'produce-a', principal: 'proof-runner', agentName: 'produce a', kind: 'claude', credentialFile: '/outside/producer.token' }), /it contains/);
    assert.throws(() => masterConfigSchema.parse({ ...config, masterAgentName: 'graphyard-master-of-a-repository-named-at-length' }), /past the 32-character limit/);
    assert.ok(workerProfileSchema.parse({ ...worker, agentName: 'eng-claude-1' }), 'a launchable name is taken as it always was');

    // The worker profile name `master init` proposes, derived from the repository (GY-103). A
    // proposal cannot carry a name the profile it becomes would refuse, so `master worker add`
    // never fails on a name Graphyard itself produced, however long the repository is named.
    assert.throws(() => proposedWorkerProfileSchema.parse({ name: 'claude-primary', principal: 'worker-1', agentName: 'kubernetes-sigs-cluster-api-provider-aws-claude-1', mode: 'launch', kind: 'claude', credentialFile: '/outside/claude.token', agentArgs: [], environment: {} }),
      /Herdr cannot launch a session named .*49 characters, past the 32-character limit/);
    for (const repository of ['owner/orders-api', 'kubernetes-sigs/cluster-api-provider-aws', 'kubernetes-sigs/cluster-api-provider-gcp', 'x/y']) {
      const proposed = buildProposal({ files: ['package.json'], contents: { 'package.json': '{"name":"app"}' } },
        { repository, runtimes: ['claude', 'codex'], credentialDirectory: credentials }).profiles.workers;
      assert.equal(proposed.length, 2);
      for (const profile of proposed) {
        assert.ok(launchable(profile.agentName), `${repository}: ${profile.agentName} is ${profile.agentName.length} characters`);
        assert.ok(profile.agentName.endsWith(`-${profile.kind}-1`) || profile.agentName.endsWith(`-${profile.kind}-2`), `${repository}: ${profile.agentName} still says which runtime and which of them it is`);
        // The name is accepted where `master worker add` reads it, with the credential that profile names.
        await writeFile(profile.credentialFile, `${profile.kind}-token-`.padEnd(40, 'x'), { mode: 0o600 });
        const added = await saveWorkerProfile(root, profile, async () => ({ actor: { id: profile.principal, role: 'worker' } }));
        assert.equal(added.added, profile.name);
      }
      assert.equal(new Set(proposed.map(profile => profile.agentName)).size, 2, `${repository}: two proposed workers are two sessions`);
      await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), workers: [] });
    }
    // Repositories whose names begin alike are still two names once the limit shortens them.
    const named = (repository: string) => buildProposal({ files: ['package.json'], contents: { 'package.json': '{}' } }, { repository, runtimes: ['claude'], credentialDirectory: credentials }).profiles.workers[0].agentName;
    assert.notEqual(named('kubernetes-sigs/cluster-api-provider-aws'), named('kubernetes-sigs/cluster-api-provider-gcp'));
    assert.equal(named('owner/orders-api'), 'owner-orders-api-claude-1', 'a repository that fits is named after itself, unshortened');

    // The last check before the runtime: a name no runtime would take never reaches one, and the
    // refusal names the limit, the name attempted and how to retry.
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => { calls.push(args); return JSON.stringify({ result: {} }); };
    await assert.rejects(startAgentSession('Approver-GY-101', 'claude', 'pane-1', [], 'Judge it', run, { directory: root, retry: 'graphyard master approver GY-101 4cb51514' }),
      (error: unknown) => error instanceof SessionNameRefusedError && /1-32 characters/.test(error.message) && /Approver-GY-101/.test(error.message) && /graphyard master approver GY-101 4cb51514/.test(error.message));
    assert.deepEqual(calls, [], 'the runtime was never asked to start a session it would refuse to name');

    // The master session is named the same way, before its tab is created.
    await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...config, masterAgentName: 'graphyard-master-project' });
    const listed: HerdrAgent[] = [{ name: 'graphyard-master-project', pane_id: 'pane-9', agent: 'claude', agent_status: 'working' }];
    await assert.rejects(startMaster(root, 'claude', [], listed, run), /already visible in Herdr/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(credentials, { recursive: true, force: true });
  }
});

/** A candidate every gate passes, on a loop whose automatic merging is off: one routine merge decision. */
function mergeable(): Work {
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 101, branch: 'graphyard/gy-101-1', author: 'worker' };
  return {
    id: 'work-101', key: 'GY-101', title: 'Approver names fit the runtime', description: '', type: 'bug', priority: 0,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Bounded', proofs: ['unit:approver-name-bounded-and-unique'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 1,
    createdAt: iso(-4 * hour), updatedAt: iso(), stageEnteredAt: iso(-hour), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 101 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] },
      { name: 'test', passed: true, reasons: [] }, { name: 'acceptance', passed: true, reasons: [] }, { name: 'merge', passed: true, reasons: [] }],
    violations: [],
  } as unknown as Work;
}

test('integration:approver-launch-refusal-visible — a launch a runtime refuses for the name it was given is reported as that, and master status shows the decision as awaiting an approver that could not start', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-approver-refusal-'));
  try {
    const credentialFile = join(directory, 'coordinator.token');
    await writeFile(credentialFile, coordinatorToken, { mode: 0o600 });
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
      autoMerge: false, mergeMethod: 'merge', workers: [],
      operatorAgent: { id: 'graphyard-master-project-operator', credentialFile }, approver: { id: 'graphyard-approver-project', credentialFile },
      run: { intervalSeconds: 20 } as Partial<MasterRun> }) as MasterConfig;

    const item = mergeable();
    const decision = uuid('4cb51514');

    // The launcher against a runtime that refuses the name it is given: `master approver` builds
    // the name, Herdr answers with its naming rule, and the launcher reports that refusal rather
    // than a generic failed start — and leaves no tab behind for a session that never started.
    const root = await repository('graphyard-approver-refusal-root-');
    const credentials = await mkdtemp(join(tmpdir(), 'graphyard-approver-refusal-credentials-'));
    let refusal!: SessionNameRefusedError;
    try {
      await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials },
        (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
      const approverToken = join(credentials, 'approver.token');
      await writeFile(approverToken, 'approver-token-'.padEnd(40, 'x'), { mode: 0o600 });
      await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), approver: { id: 'graphyard-approver-project', credentialFile: approverToken } });
      const herdr: string[][] = [];
      const refusing = (_command: string, args: string[]) => {
        herdr.push(args);
        if (args[0] === 'tab' && args[1] === 'create') return JSON.stringify({ result: { root_pane: { pane_id: 'pane-4', tab_id: 'tab-4' } } });
        // The runtime is named once it is seen started (GY-121); a name Herdr refuses is refused there.
        if (args[0] === 'agent' && args[1] === 'rename') throw Object.assign(new Error('Command failed: herdr agent rename'), { stdout: JSON.stringify({ error: { code: 'invalid_argument', message: 'agent name must start with a lowercase letter and contain only lowercase letters, digits, \'-\' or \'_\' (1-32 characters)' } }) });
        return startedAtOnce(args) ?? JSON.stringify({ result: {} });
      };
      await assert.rejects(launchApprover(root, item, decision, 'claude', [], refusing), (error: unknown) => {
        assert.ok(error instanceof SessionNameRefusedError, 'a refused name is reported as a refused name');
        refusal = error;
        return true;
      });
      assert.ok(herdr.some(call => call[0] === 'pane' && call[1] === 'close'), 'the tab opened for a session that could not be named is closed');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(credentials, { recursive: true, force: true });
    }
    assert.match(refusal.message, /1-32 characters/, 'the refusal names the limit');
    assert.match(refusal.message, new RegExp(approverSessionName(item, decision)), 'the refusal names the name attempted');
    assert.match(refusal.message, /graphyard master approver GY-101 4cb51514/, 'the refusal names the command to retry');

    const merged: string[] = [];
    const effects: DaemonEffects = {
      agents: () => [],
      credentials: async () => ({}),
      snapshot: async () => ({ work: [item], now: iso() }),
      closeSession: () => {},
      dispatch: async () => {},
      requestProof: () => {},
      merge: async work => { merged.push(work.key); return { result: 'merged', merged: true }; },
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {},
      requestSmoke: () => {},
      persist: async () => {},
      decide: async () => ({ id: decision }),
      decisions: async () => ({ decisions: [{ id: decision, action: 'merge', state: 'requested', input: { sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision }, approvedBy: null }] }),
      approver: async () => { throw refusal; },
    };

    const state = emptyDaemonState(config);
    await runCycle(config, state, effects, () => clock);
    assert.deepEqual(merged, [], 'nothing merges on a decision no approver judged');

    const watch = Object.values(state.approvals)[0];
    assert.ok(watch, 'the requested decision is watched even though its approver never started');
    assert.equal(watch.decision, decision);

    // What `master status` reads: the loop's cursor, through the same summary the report uses.
    const summary = daemonSummary(state, clock, config.run.intervalSeconds * 1000, config.hostId);
    const attention = approverLaunchAttention(summary);
    assert.equal(attention.length, 1, 'the decision is on the attention list, once');
    assert.match(attention[0].text, /GY-101 is awaiting an approver for merge decision 4cb51514-4cb5-4f21-9b0e-0f2a6c8d4e15 that could not start/);
    assert.match(attention[0].text, /1-32 characters/, 'status carries the runtime\'s limit, not a generic failure');
    assert.match(attention[0].text, new RegExp(approverSessionName(item, decision)), 'status names the session that could not start');
    assert.equal(attention[0].role, 'master');
    assert.equal(attention[0].approvedBy, 'approver');
    assert.match(attention[0].next, /graphyard master approver GY-101 4cb51514/, 'status names the command that launches it again');
    assert.equal(attention[0].human, false, 'an approver that could not start is an agent\'s to launch again');

    // A launch that succeeds leaves nothing on the list: the decision is with its approver.
    const launched = emptyDaemonState(config);
    await runCycle(config, launched, { ...effects, approver: async work => ({ agentName: approverSessionName(work, decision), pane: 'pane-1' }) }, () => clock);
    assert.deepEqual(approverLaunchAttention(daemonSummary(launched, clock, config.run.intervalSeconds * 1000, config.hostId)), []);
    assert.equal(Object.values(launched.approvals)[0].agentName, approverSessionName(item, decision));
    assert.ok(assertSessionName(Object.values(launched.approvals)[0].agentName!), 'the session the loop launched is one the runtime can name');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
