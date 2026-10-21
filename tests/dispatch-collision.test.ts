import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { dispatchReserved, dispatchWork, setupMaster, watchSupervisorRunning, type HerdrAgent, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-273: concurrent dispatchers launch implementation work from their own snapshots of
// Herdr's agents. Two of them picking one profile used to mean two claims, two runtimes started,
// and the loser — refused its name by Herdr — closing the pane of the worker it had just started.
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');

function work(key: string, overrides: Partial<Work> = {}): Work {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
const launchProfile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });

/**
 * One Herdr the dispatchers share: panes are created with distinct ids, a rename takes the name
 * only while no live agent holds it (Herdr's own agent_name_taken), and `agent list` answers the
 * names taken so far. `failRename` makes every rename fail after the command line is in the pane.
 */
function fakeHerdr(options: { failRename?: boolean } = {}) {
  const calls: string[][] = [], agents: HerdrAgent[] = [], closed: string[] = [], typed: string[] = [];
  let panes = 0;
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'tab' && args[1] === 'create') { const pane = `pane-${++panes}`; return json({ type: 'tab_created', root_pane: { pane_id: pane, tab_id: `tab-${panes}` }, tab: { tab_id: `tab-${panes}` } }); }
    if (args[0] === 'agent' && args[1] === 'list') return json({ agents: agents.map(agent => ({ ...agent })) });
    if (args[0] === 'agent' && args[1] === 'rename') {
      if (options.failRename || agents.some(agent => agent.name === args[3])) throw Object.assign(new Error(`herdr: {"code":"agent_name_taken","message":"agent name ${args[3]} is taken"}`), { herdrCode: 'agent_name_taken' });
      agents.push({ name: args[3], pane_id: args[2], agent: 'codex', agent_status: 'working' });
    }
    if (args[0] === 'pane' && args[1] === 'run') typed.push(args[2]);
    if (args[0] === 'pane' && args[1] === 'close') { closed.push(args[2]); return json({}); }
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    return startedAtOnce(args) ?? json({});
  };
  return { run, calls, agents, closed, typed };
}

/** The control plane's claim, as the fake sees it: one epoch per item, a second claim of a held item refused. */
function fakeClaims(root: string) {
  const claims = new Map<string, string>(), released: string[] = [];
  const prepare = async (_root: string, key: string, profile: string) => {
    await sleep(25);
    if (claims.has(key)) throw new Error(`Dispatch blocked by active owner ${claims.get(key)}`);
    claims.set(key, profile);
    return { epoch: 1, path: join(root, `assigned-${key}`), base: 'c'.repeat(40) };
  };
  const release = async (_root: string, key: string, epoch: number) => { released.push(`${key}@${epoch}`); claims.delete(key); };
  return { claims, released, prepare, release };
}

async function installation() {
  const root = await temporaryDirectory('dispatch-collision'); const credentials = await temporaryDirectory('dispatch-collision-credentials');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const credential = join(credentials, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
  const coordinator = join(credentials, 'coordinator.token'); await writeFile(coordinator, coordinatorToken, { mode: 0o600 });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  return { root, credential, coordinator, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

test('unit:profile-reserved-before-claim — two concurrent dispatchWork calls for one profile make exactly one claim and one launch, and the other is refused cleanly before any claim', async () => {
  const fixture = await installation();
  try {
    const profile = launchProfile('one', fixture.credential);
    const herdr = fakeHerdr(), claims = fakeClaims(fixture.root);
    const first = work('GY-1'), second = work('GY-2');
    // Both dispatchers chose the profile from the same snapshot, in which its name is free.
    const observedAt = new Date().toISOString(), snapshot: HerdrAgent[] = [];
    const results = await Promise.allSettled([first, second].map(item => dispatchWork(fixture.root, item, profile, snapshot, herdr.run, [first, second], claims.prepare, claims.release, 1, observedAt)));
    const launched = results.filter(result => result.status === 'fulfilled'), refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(launched.length, 1, 'exactly one dispatch launches');
    assert.equal(refused.length, 1, 'the other is refused');
    assert.ok(dispatchReserved(refused[0].reason), `the refusal is the reservation's own, not a failed launch: ${refused[0].reason?.message}`);
    assert.equal(refused[0].reason.resource, 'profile');
    assert.match(refused[0].reason.message, /Worker profile one is reserved by another dispatch|already visible in Herdr/);
    assert.equal(claims.claims.size, 1, 'exactly one item was claimed');
    assert.deepEqual(claims.released, [], 'nothing was claimed and then released');
    assert.equal(herdr.calls.filter(args => args[0] === 'tab' && args[1] === 'create').length, 1, 'exactly one pane was created');
    assert.equal(herdr.typed.length, 1, 'exactly one runtime was started');
    assert.deepEqual(herdr.closed, [], 'no pane was closed');
    assert.deepEqual(herdr.agents.map(agent => agent.name), ['agent-one']);

    // A dispatcher that reads its snapshot before that launch and dispatches after it is released
    // re-reads Herdr under the reservation and is refused the name, still before any claim.
    const late = await dispatchWork(fixture.root, work('GY-3'), profile, [], herdr.run, [work('GY-3')], claims.prepare, claims.release, 1, observedAt).then(() => null, error => error);
    assert.ok(dispatchReserved(late), `a stale snapshot is refused cleanly: ${late?.message}`);
    assert.match(late.message, /agent-one is already visible in Herdr/);
    assert.ok(herdr.calls.some(args => args[0] === 'agent' && args[1] === 'list'), 'Herdr was read again under the reservation');
    assert.equal(claims.claims.size, 1, 'the stale dispatcher claimed nothing');
  } finally { await fixture.cleanup(); }
});

test('unit:launch-failure-never-closes-live-pane — a rename refused after `pane run` leaves the pane of a running supervisor open and releases the claim through it', async () => {
  const fixture = await installation();
  try {
    const profile = launchProfile('one', fixture.credential);
    const herdr = fakeHerdr({ failRename: true }), claims = fakeClaims(fixture.root);
    // The watch supervisor the command line started is running in its pane.
    const supervised = new Set<string>();
    const supervisor = ({ pane }: { key: string; epoch: number; pane: string | undefined }) => !!pane && supervised.has(pane);
    const run = (command: string, args: string[]) => { if (args[0] === 'pane' && args[1] === 'run') supervised.add(args[2]); return herdr.run(command, args); };
    const error = await dispatchWork(fixture.root, work('GY-1'), profile, [], run, [work('GY-1')], claims.prepare, claims.release, 1, new Date().toISOString(), { supervisor }).then(() => null, failure => failure);
    assert.ok(error, 'the launch fails');
    assert.match(error.message, /agent_name_taken/);
    assert.match(error.message, /pane pane-1 was left to its running supervisor, which stops the worker on the released epoch 1/);
    const runIndex = herdr.calls.findIndex(args => args[0] === 'pane' && args[1] === 'run'), renameIndex = herdr.calls.findIndex(args => args[0] === 'agent' && args[1] === 'rename');
    assert.ok(runIndex >= 0 && renameIndex > runIndex, 'the rename failed after the command line was in the pane');
    const closedLive = herdr.calls.filter(args => args[0] === 'pane' && args[1] === 'close' && supervised.has(args[2]));
    assert.deepEqual(closedLive, [], 'no pane close targets a pane with a running supervisor');
    assert.equal(herdr.calls.filter(args => args[0] === 'tab' && args[1] === 'close').length, 0, 'nor is its tab closed');
    assert.deepEqual(claims.released, ['GY-1@1'], 'the claim is released, so the supervisor stops its own worker on the lost lease');
    assert.equal(herdr.typed.length, 1, 'a supervised pane is not relaunched over');

    // A runtime that never came up under a pane with no supervisor is still cleaned up as before.
    const empty = fakeHerdr({ failRename: true }), emptyClaims = fakeClaims(fixture.root);
    await assert.rejects(dispatchWork(fixture.root, work('GY-2'), launchProfile('two', fixture.credential), [], empty.run, [work('GY-2')], emptyClaims.prepare, emptyClaims.release, 1, new Date().toISOString(), { supervisor: () => false }), /agent_name_taken/);
    assert.deepEqual(empty.closed, ['pane-1'], 'a pane with no running supervisor is closed');
    assert.deepEqual(emptyClaims.released, ['GY-2@1']);

    // The host's own check reads the supervisor's exact command line from the process table.
    const table: Record<number, string> = { 10: ['node', '/cli.mjs', 'watch', 'GY-7', '3', '--', 'codex'].join('\0'), 11: ['vim', 'watch', 'GY-7'].join('\0') };
    const read = (pid: number) => { if (!(pid in table)) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return table[pid]; };
    assert.equal(watchSupervisorRunning({ key: 'GY-7', epoch: 3 }, read, () => ['10', '11', 'self']), true);
    assert.equal(watchSupervisorRunning({ key: 'GY-7', epoch: 4 }, read, () => ['10', '11']), false, 'another epoch is not this supervisor');
    assert.equal(watchSupervisorRunning({ key: 'GY-8', epoch: 3 }, read, () => ['11', '12']), false, 'a loose `watch` argument is not a supervisor');
    assert.equal(watchSupervisorRunning({ key: 'GY-7', epoch: 3 }, read, () => { throw new Error('no /proc'); }), true, 'an unreadable process table leaves the pane alone');
  } finally { await fixture.cleanup(); }
});

