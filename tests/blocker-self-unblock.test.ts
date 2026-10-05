import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { approverSessionName, decisionInput, masterConfigSchema, workerPrompt, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { blockerClasses, blockerView, classifyBlocker, environmentalBlockerClasses, maxAutomaticClears, needsSomeone, unrepresentableScope, type BlockerClass } from '../src/model/blocker-class.js';
import { plannedFilesMax } from '../src/model/scope.js';
import { blockedAttemptMarker } from '../src/model/capacity.js';
import { humanRequestBlocker } from '../src/model/human-request.js';
import { buildBoard, masterBoard } from '../src/model/board.js';
import { workAttentionOwner } from '../src/master/attention.js';
import { confinedCommand, loopBlockerProbe, probeBlocker } from '../src/daemon/blocker-probes.js';
import { emptyRegistry, type AgentRegistry } from '../src/model/registry.js';
import { keepBlockedWork } from '../src/cli/lease.js';
import { assignmentSurrender } from '../src/supervisor.js';
import { credentialBlockedKey, credentialBlockedMarker } from '../src/worker-credential.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1008. On 2026-09-30 the board showed 19 blocked items and the master cleared every one by
 * hand, because nothing re-checked a blocker once it was recorded, while every blocked worker kept
 * its lease and sat idle holding a slot. A recorded blocker now ends its attempt in the same
 * transaction, the loop reads each blocker into a named class, probes the environmental ones every
 * cycle inside the worker's confinement and clears them once the probe passes, puts a planned-file
 * scope blocker to the independent approver as a widening, launches a needs-decision blocker's
 * approver, and only a genuine or human-only blocker counts as needing someone. Everything but the
 * classification and the board runs against a real Postgres and the real HTTP routes; each test is
 * named for the proof it produces.
 */
const repository = 'owner/blocker-unblock';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `blocker-unblock-${principal.id}-${'x'.repeat(32)}` }));
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'] };
const approver = { id: 'independent-approver', token: `independent-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(credential, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const criteria = [{ id: 'AC-1', text: 'The queue carries its entries across a base refresh', proofs: ['unit:queue'] }];

async function ready(title: string) {
  let work = await ok(master.token, 'POST', 'work', { title, plannedFiles: ['src/queue-carry.ts'], criteria, reason: 'Operator goal: blocked work unblocks itself' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for an attempt' }) as Work;
  return work;
}
async function claimed(title: string) {
  const work = await ready(title);
  return engine.execute(implementer, 'claim', work.id, {}, randomUUID());
}
const block = (work: Work, reason: string, extra: Record<string, unknown> = {}) => ok(token(implementer), 'POST', `work/${work.id}/blocked`, { epoch: work.epoch, reason, ...extra }) as Promise<Work>;

const profile = { name: 'alpha', principal: implementer.id, agentName: 'worker-alpha', mode: 'launch', kind: 'claude', credentialFile: join(tmpdir(), 'blocker-unblock-worker.token'), agentArgs: [], environment: {} };
const loopConfig = () => masterConfigSchema.parse({ version: 1, url, credentialFile: join(tmpdir(), 'blocker-unblock-coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-blocker-unblock', workers: [profile] }) as MasterConfig;

/** The loop as `master run` wires it, with Herdr, the launcher and the probe's child runs under the test's control. */
function harness(probeRun: (command: string, args: string[]) => string = () => '') {
  const sessions: HerdrAgent[] = [], dispatched: string[] = [], launched: string[] = [], decided: { key: string; action: string; input: any }[] = [], probes: { command: string; args: string[] }[] = [];
  const effects: DaemonEffects = {
    agents: () => sessions,
    herdr: () => ({ agents: sessions, available: true }),
    credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => { const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: snapshot.now }; },
    closeSession: () => {},
    dispatch: async work => { dispatched.push(work.key); },
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    decide: async (work, action, reason, input = {}) => { decided.push({ key: work.key, action, input }); return ok(master.token, 'POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason }); },
    approver: async (work, decision) => { launched.push(decision); const agentName = approverSessionName(work, decision); sessions.push({ name: agentName, pane_id: `pane-${launched.length}`, agent_status: 'working' } as HerdrAgent); return { agentName, pane: `pane-${launched.length}` }; },
    decisions: work => ok(master.token, 'GET', `work/${encodeURIComponent(work.id)}/decisions`),
    withdraw: (work, decision, reason) => ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason }),
    // The worker a codex profile would get: its probe runs inside the codex sandbox the launch describes.
    probeBlocker: (work, classification) => probeBlocker(work, classification, { run: async (command, args) => { probes.push({ command, args }); return probeRun(command, args); },
      launch: { kind: 'codex', args: ['--sandbox', 'workspace-write'] }, cwd: '/srv/worktrees/probe', clock: Date.now(), planeHealth: async () => null }),
    recordBlockerProbe: (work, body) => ok(token(coordinator), 'POST', `work/${work.id}/blocker-probe`, body) as Promise<Work>,
  };
  return { effects, sessions, dispatched, launched, decided, probes, cycle: (state: DaemonState) => runCycle(loopConfig(), state, effects) };
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_BLOCKER_UNBLOCK_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1008);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('blocker-unblock-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('blocker_unblock_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/blocker_unblock_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver]) await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: `Onboarding provisions ${agent.id}` });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

// The blocker text of the 2026-09-30 incidents, one per class, and what does not match any.
const incidents: [string, BlockerClass][] = [
  ['git push failed: fatal: could not read Username for https://github.com: terminal prompts disabled', 'github-credential'],
  ['complete command failed with Internal error; the server answered 500 during complete', 'control-plane-error'],
  ["git fetch failed: error: unable to append to '.git/logs/refs/remotes/origin/graphyard/gy-941-1': Read-only file system", 'sandbox-path'],
  ["This session is attached to GY-912's worktree, not this item's own: the worktree belongs to another item", 'worktree-mismatch'],
  ['npm test fails in tests/github-http.test.ts, outside plannedFiles; it fails on main as well', 'outside-scope-test-failure'],
  ['SCOPE NEEDED: src/model/queue.ts (the carry reads the queue entry) for commit 8106499e9f', 'planned-file-scope'],
  ['Waiting on decision 5b1e7c3a-9d2f-4e61-8a0b-2c4d6e8f0a1b, already requested; its approver was never launched', 'needs-decision'],
  [`${humanRequestBlocker} (spending money or opening third-party accounts): a Railway team seat`, 'human-only'],
  ['The two criteria contradict each other about the retry order', 'genuine'],
];

test('unit:blocker-classified — the 2026-09-30 blocker texts fall into their named classes, unrecognised text is genuine, and only genuine and human-only need someone', () => {
  for (const [text, expected] of incidents) assert.equal(classifyBlocker(text).class, expected, text);
  assert.deepEqual([...new Set(incidents.map(([, expected]) => expected))].sort(), [...blockerClasses].sort(), 'every class is covered');
  // What each routine class carries for the loop to act on.
  assert.equal(classifyBlocker(incidents[2][0]).path, '.git/logs/refs/remotes/origin/graphyard/gy-941-1');
  const scope = classifyBlocker(incidents[5][0]);
  assert.deepEqual(scope.paths, ['src/model/queue.ts']);
  assert.equal(scope.commit, '8106499e9f');
  assert.equal(classifyBlocker(incidents[6][0]).decision, '5b1e7c3a-9d2f-4e61-8a0b-2c4d6e8f0a1b');
  // A scope ask with no file or no commit derives no widening: the master reads it.
  assert.equal(classifyBlocker('SCOPE NEEDED: a helper outside plannedFiles').class, 'genuine');
  assert.equal(classifyBlocker('SCOPE NEEDED: src/model/queue.ts').class, 'genuine');
  // A URL the blocker cites is a reference: its host and path never become a planned path.
  const linked = classifyBlocker('SCOPE NEEDED: src/model/queue.ts (see https://github.com/org/repo/issues/12) for commit 8106499e9f');
  assert.deepEqual([linked.class, linked.paths, linked.commit], ['planned-file-scope', ['src/model/queue.ts'], '8106499e9f']);
  // Files no fold can represent under the plannedFiles cap need the master, not a widening.
  const full = { plannedFiles: Array.from({ length: plannedFilesMax }, (_, index) => `tests/bulk/file-${index}.test.ts`), criteria: [] };
  const far = classifyBlocker('SCOPE NEEDED: newtop/next.ts for commit 8106499e9f');
  assert.equal(unrepresentableScope(full, far), true);
  assert.equal(unrepresentableScope({ plannedFiles: ['src/a.ts'], criteria: [] }, far), false);
  assert.equal(blockerView({ blocker: 'SCOPE NEEDED: newtop/next.ts for commit 8106499e9f', humanRequest: null, blockerProbe: null, ...full } as never)?.needsSomeone, true);
  // An open human request is human-only whatever its text says.
  assert.equal(classifyBlocker('anything at all', { humanRequest: true }).class, 'human-only');
  assert.equal(classifyBlocker('').class, 'genuine');
  assert.equal(classifyBlocker('Environment, not the item: the codex sandbox cannot write /srv/wt/.git/FETCH_HEAD, so required command \'sync GY-1\' failed: EROFS').path, '/srv/wt/.git/FETCH_HEAD');
  for (const name of blockerClasses) assert.equal(needsSomeone(name), name === 'genuine' || name === 'human-only', name);
  assert.deepEqual([...environmentalBlockerClasses].sort(), ['control-plane-error', 'github-credential', 'outside-scope-test-failure', 'sandbox-path', 'worktree-mismatch']);
});

test('unit:blocked-attempt-frees-slot — recording a blocker ends the attempt in the same transaction, keeps its partial work and releases the lease, so the slot is free on the next dispatch', async () => {
  const loop = harness(), state = emptyDaemonState(loopConfig());
  let held = await claimed('Blocked attempt holds nothing');
  const waiting = await ready('Waiting for the slot');
  // The attempt's worktree, with committed work and a change it had not committed yet.
  const worktree = await temporaryDirectory('blocker-unblock-worktree');
  const branch = `graphyard/${held.key.toLowerCase()}-${held.epoch}`;
  git(worktree, 'init', '-q', '-b', branch); await writeFile(join(worktree, 'queue.ts'), 'export const carry = 1;\n');
  git(worktree, 'add', '-A'); git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first half');
  held = await ok(token(implementer), 'POST', `work/${held.id}/workspace`, { epoch: held.epoch, host: 'loop-host', path: worktree, branch });

  // While the attempt's session runs under its lease the one profile is busy: nothing else is dispatched.
  loop.sessions.push({ name: profile.agentName, pane_id: 'pane-worker', agent_status: 'idle', agent: 'claude' } as HerdrAgent);
  await loop.cycle(state);
  assert.deepEqual(loop.dispatched, [], 'the only worker slot is held');

  await writeFile(join(worktree, 'queue.ts'), 'export const carry = 2; // unfinished\n');
  const partialWork = keepBlockedWork(held, held.epoch, worktree);
  assert.equal(partialWork?.state, 'committed', 'the CLI keeps what was not committed as a WIP commit on the attempt branch');
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  assert.match(git(worktree, 'log', '-1', '--format=%s'), /^WIP: .* attempt 1 blocked$/);
  // An open scope request of the attempt is closed with it, on the record (GY-1055).
  held = await ok(token(implementer), 'POST', `work/${held.id}/scope`, { epoch: held.epoch, paths: ['src/unrelated/far-away.ts'], reason: 'The carry may also need this file' }) as Work;
  assert.ok(held.scopeRequest, 'the scope request stands while the attempt holds its lease');
  const blocked = await block(held, 'The two criteria contradict each other about the retry order', { partialWork });
  assert.equal(blocked.scopeRequest, null, 'the ended attempt\'s scope request is closed');
  const closed = (await events(blocked)).filter(row => row.kind === 'scope.closed');
  assert.deepEqual(closed.map(row => [row.payload.details.by, row.payload.details.paths]), [['blocked', ['src/unrelated/far-away.ts']]], 'and the history says the blocker ended it');

  // The same transaction: blocker recorded, lease released, attempt ended as released, work kept.
  assert.equal(blocked.blocker, 'The two criteria contradict each other about the retry order');
  assert.equal(blocked.lease, null, 'the lease is released with the blocker');
  const ended = blocked.capacity!.exhaustions.at(-1)!;
  assert.equal(ended.cause, 'interrupted');
  assert.equal(ended.epoch, held.epoch);
  assert.ok(ended.reason.startsWith(`${blockedAttemptMarker}${held.epoch}: `), ended.reason);
  assert.equal(ended.partialWork.commit, git(worktree, 'rev-parse', 'HEAD'), 'the kept commit is on the record');
  assert.equal((blocked as any).pipeline?.attempts?.at(-1)?.end, 'released');
  const history = (await events(blocked)).filter(row => row.kind === 'blocked');
  assert.equal(history.length, 1, 'one history entry: the blocker and the end of the attempt are one write');
  // The next attempt's request names the kept commit.
  assert.match(workerPrompt(loopConfig(), blocked, profile as any, blocked.epoch + 1), new RegExp(`kept as commit ${ended.partialWork.commit}`));

  // The attempt's supervisor is refused its next renewal, so it stops the session, as after complete.
  assert.equal((await call(token(implementer), 'POST', `work/${held.id}/heartbeat`, { epoch: held.epoch })).status, 409);
  loop.sessions.splice(0, loop.sessions.length, ...loop.sessions.filter(agent => agent.name !== profile.agentName));
  // The next cycle hands the freed slot to the waiting item.
  await loop.cycle(state);
  assert.deepEqual(loop.dispatched, [waiting.key], 'the slot the blocked attempt held is free on the next dispatch');
  // The worker's clear (`blocked GY-N EPOCH -`) needs a live lease: the ended attempt clears nothing.
  assert.equal((await call(token(implementer), 'POST', `work/${held.id}/blocked`, { epoch: held.epoch, reason: null })).status, 409);
  assert.equal(await readFile(join(worktree, 'queue.ts'), 'utf8'), 'export const carry = 2; // unfinished\n');

  // A watch supervisor whose session is gone surrenders against this real engine in one release
  // carrying the cause: the attempt ends, the cause is on the ledger, and no blocker stands.
  const orphaned = await claimed('Supervisor surrender leaves no blocker');
  const surrender = assignmentSurrender(orphaned.epoch, [process.execPath, 'bin/graphyard.mjs', 'watch', orphaned.key, String(orphaned.epoch), '--', 'claude'], { GRAPHYARD_URL: url, GRAPHYARD_TOKEN: token(implementer) })!;
  await surrender('Herdr no longer reports this agent session');
  const surrendered = await reload(orphaned.id);
  assert.equal(surrendered.lease, null, 'the lease is released');
  assert.equal(surrendered.blocker, null, 'no standing blocker for a condition that is already over');
  assert.equal(blockerView(surrendered), null, 'nothing needs anyone');
  const release = (await events(surrendered)).filter(row => row.kind === 'release');
  assert.equal(release.length, 1);
  assert.equal(release[0].payload.details.cause, `Watch supervisor ended attempt ${orphaned.epoch}: Herdr no longer reports this agent session`, 'the cause is kept on the release event');
  assert.equal((await engine.execute(implementer, 'claim', orphaned.id, {}, randomUUID())).epoch, orphaned.epoch + 1, 'the item is claimable at once');
});

test('unit:environment-blocker-auto-cleared — each cycle the loop probes an environmental blocker inside the worker confinement, clears it with an audit record once the probe passes, and never while it fails', async () => {
  let passing = false;
  const loop = harness((command, args) => {
    if (!passing) throw Object.assign(new Error('probe failed'), { stderr: 'fatal: could not read Username for https://github.com: terminal prompts disabled' });
    return '';
  });
  const state = emptyDaemonState(loopConfig());
  const credential = await block(await claimed('Credential blocker'), incidents[0][0]);
  const genuine = await block(await claimed('Genuine blocker'), incidents[8][0]);

  await loop.cycle(state);
  let work = await reload(credential.id);
  assert.equal(work.blocker, incidents[0][0], 'a failing probe clears nothing');
  assert.equal(work.blockerProbe?.class, 'github-credential');
  assert.equal(work.blockerProbe?.result, 'fail');
  assert.match(work.blockerProbe!.detail, /could not read Username/);
  assert.ok(work.blockerProbe!.nextAt && Date.parse(work.blockerProbe!.nextAt) > Date.parse(work.blockerProbe!.at), 'the next probe time is on the record');
  // The credential probe ran inside the codex sandbox the worker's launch describes, not on the loop's own shell.
  const first = loop.probes.at(-1)!;
  assert.equal(first.command, 'codex');
  assert.equal(first.args[0], 'sandbox');
  assert.match(first.args.join(' '), /gh auth status/);
  assert.match(first.args.join(' '), /git ls-remote --exit-code origin HEAD/);
  assert.equal((await reload(genuine.id)).blockerProbe ?? null, null, 'a genuine blocker is not probed');
  // GY-999: a GitHub credential failure's ending counts on the retry ladder, and the loop records the ended session once.
  assert.ok(work.capacity!.exhaustions.at(-1)!.reason.startsWith(`${credentialBlockedMarker} on epoch ${credential.epoch}: `), work.capacity!.exhaustions.at(-1)!.reason);
  assert.equal(state.actions[credentialBlockedKey(work, credential.epoch)]?.state, 'done');

  // Still failing on the next cycle: probed again, still blocked.
  const before = loop.probes.length;
  await loop.cycle(state);
  assert.equal(loop.probes.length, before + 1, 'the probe runs every cycle');
  assert.equal((await reload(credential.id)).blocker, incidents[0][0]);

  // The cause is fixed: the next cycle's probe passes and the blocker is cleared, with the probe named.
  passing = true;
  await loop.cycle(state);
  work = await reload(credential.id);
  assert.equal(work.blocker, null, 'cleared once the probe passes');
  assert.equal(work.blockerProbe?.result, 'pass');
  assert.equal(work.blockerProbe?.clears, 1);
  const cleared = (await events(work)).filter(row => row.kind === 'blocker.cleared');
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].actor, coordinator.id);
  assert.match(JSON.stringify(cleared[0].payload), /gh auth status and git ls-remote origin inside the codex sandbox passed/);
  assert.equal((await reload(genuine.id)).blocker, incidents[8][0], 'the genuine blocker stands');
  assert.equal((await engine.execute(implementer, 'claim', work.id, {}, randomUUID())).epoch, credential.epoch + 1, 'the item is claimable again');

  // The control plane re-classifies before it clears: a genuine blocker, or a pass past the run's bound, is refused.
  const refused = await call(token(coordinator), 'POST', `work/${genuine.id}/blocker-probe`, { blocker: genuine.blocker, class: 'genuine', probe: 'none', result: 'pass', detail: 'x', nextAt: null });
  assert.equal(refused.status, 409);
  const mislabelled = await call(token(coordinator), 'POST', `work/${genuine.id}/blocker-probe`, { blocker: genuine.blocker, class: 'github-credential', probe: 'gh', result: 'pass', detail: 'x', nextAt: null });
  assert.equal(mislabelled.status, 409);
  assert.equal((await call(token(implementer), 'POST', `work/${genuine.id}/blocker-probe`, { blocker: genuine.blocker, class: 'genuine', probe: 'none', result: 'fail', detail: 'x', nextAt: null })).status, 403);
  assert.equal(blockerView({ blocker: 'x: Read-only file system', humanRequest: null, blockerProbe: { blocker: 'x', class: 'sandbox-path', probe: 'p', result: 'pass', detail: 'd', at: new Date().toISOString(), nextAt: null, clears: maxAutomaticClears } })!.needsSomeone, true, 'a cause cleared three times in a row goes to the master');

  // The write probe is confined the same way, on the path the blocker names, resolved in the worktree.
  const sandbox = await probeBlocker(work, classifyBlocker(incidents[2][0]), { run: () => '', launch: { kind: 'codex', args: ['--sandbox', 'workspace-write'] }, cwd: '/srv/wt', clock: Date.now() });
  assert.equal(sandbox?.passed, true);
  assert.match(sandbox!.probe, /write \/srv\/wt\/\.git\/logs\/refs\/remotes\/origin\/graphyard\/gy-941-1 inside the codex sandbox/);
  assert.deepEqual(confinedCommand({ kind: 'claude', args: [] }, '/srv/wt', ['/bin/sh', '-c', 'true']), { command: '/bin/sh', args: ['-c', 'true'] }, 'an unconfined launch with no sandbox runs the probe as its shell would');
  assert.deepEqual(confinedCommand({ kind: 'claude', args: [], confinement: ['bwrap', '--ro-bind', '/coord', '/coord', '--'] }, '/srv/wt', ['/bin/sh', '-c', 'true']),
    { command: 'bwrap', args: ['--ro-bind', '/coord', '/coord', '--', '/bin/sh', '-c', 'true'] }, 'a launch carrying the coordinator mount runs the probe inside it, as the worker runs');

  // A managed worktree is a linked one: `.git` is a file and the ref logs live in the shared Git
  // directory. The blocker's `.git/logs/...` path is probed where Git writes it, so while the
  // shared directory stays read-only the probe keeps failing, and it passes once it is writable.
  const repo = await temporaryDirectory('blocker-unblock-repo');
  git(repo, 'init', '-q', '-b', 'main'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git(repo, 'update-ref', 'refs/remotes/origin/graphyard/gy-940-1', 'HEAD');
  const linked = join(await temporaryDirectory('blocker-unblock-linked'), 'GY-941-1');
  git(repo, 'worktree', 'add', '-q', '-b', 'graphyard/gy-941-1', linked);
  const shared = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'logs/refs/remotes/origin/graphyard');
  const host = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => execFileSync(command, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const linkedProbe = () => probeBlocker(work, classifyBlocker(incidents[2][0]), { run: host, launch: { kind: 'claude', args: [] }, cwd: linked, clock: Date.now() });
  await chmod(shared, 0o555);
  try {
    const readOnly = await linkedProbe();
    assert.equal(readOnly?.probe, `write ${shared}/gy-941-1 inside the worker shell`, 'the shared directory\'s log is probed, not the worktree\'s `.git` pointer file');
    if (process.getuid?.() !== 0) assert.equal(readOnly?.passed, false, 'a read-only shared Git directory keeps the probe failing');
  } finally { await chmod(shared, 0o755); }
  assert.equal((await linkedProbe())?.passed, true, 'it passes once the shared directory is writable');

  // The loop builds the launch as dispatch does: the account the attempt ran on, with the
  // worktree, its own Git admin directory and the shared one granted to the sandbox.
  const scratch = await temporaryDirectory('blocker-unblock-loop');
  const linkedWork = { ...work, lease: null, lastAssignment: { epoch: work.epoch, owner: implementer.id, claimedAt: new Date().toISOString() }, workspaces: [{ epoch: work.epoch, host: 'loop-host', path: linked, branch: 'graphyard/gy-941-1' }] } as unknown as Work;
  const accountConfig = (kind: string) => masterConfigSchema.parse({ ...loopConfig(), credentialFile: join(scratch, `${kind}-coordinator.token`), environments: [{ name: 'codex-a', kind: 'codex', home: '/homes/codex-a' }],
    workers: [{ ...profile, kind, accounts: kind === 'codex' ? ['codex-a'] : undefined }] }) as MasterConfig;
  const ran: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const record = (async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => { ran.push({ command, args, env: options.env ?? {} }); return ''; }) as any;
  const local = { document: async () => emptyRegistry(), select: async () => { throw new Error('a probe never selects a session'); }, end: async () => {} } as any;
  const credentialProbe = await loopBlockerProbe(accountConfig('codex'), repo, record, async () => null, { registry: local })(linkedWork, classifyBlocker(incidents[0][0]));
  assert.equal(credentialProbe?.passed, true);
  const sandboxed = ran.at(-1)!;
  assert.equal(sandboxed.command, 'codex', 'the profile\'s codex account runs the probe in the codex sandbox');
  assert.equal(sandboxed.env.CODEX_HOME, '/homes/codex-a', 'under the account\'s own home');
  const filesystem = sandboxed.args.find(arg => arg.includes('.filesystem='))!;
  for (const path of [git(linked, 'rev-parse', '--absolute-git-dir'), git(linked, 'rev-parse', '--path-format=absolute', '--git-common-dir')]) assert.ok(filesystem.includes(`${JSON.stringify(path)}="write"`), `the probe sandbox grants ${path}, as the worker's launch does`);
  assert.ok(sandboxed.args.includes('permissions.graphyard-launch-probe.network.enabled=true'), 'with the launch\'s network access, so the remote is reachable');
  assert.match(sandboxed.args.join(' '), /git push --dry-run/, 'a read-only token fails the push dry run');

  // A registry-selected worker is probed on the account its session ran on, not the profile's.
  const registry: AgentRegistry = { ...emptyRegistry(), revision: 4,
    runtimes: [{ name: 'claude-rt', launch: { kind: 'claude', args: [], environment: {}, homeVariable: null, modelFlag: null, login: null, loginFile: null } }],
    models: [{ name: 'model-a', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } }],
    accounts: [{ name: 'reg-claude', runtime: 'claude-rt', model: 'model-a', credential: { host: 'loop-host', home: '/homes/reg-claude' }, enabled: true, maxSessions: null, quota: {} as any }],
    roles: [{ name: 'worker', accounts: ['reg-claude'], concurrency: 2 }],
    sessions: [{ id: 'session-7', role: 'worker', account: 'reg-claude', runtime: 'claude-rt', model: 'model-a', host: 'loop-host', work: linkedWork.key, principal: implementer.id, selectedAt: new Date().toISOString(), selectedBy: coordinator.id, reason: 'first eligible', skipped: [], endedAt: null, endReason: null }] };
  await loopBlockerProbe(accountConfig('codex'), repo, record, async () => null, { registry: { ...local, document: async () => registry } })(linkedWork, classifyBlocker(incidents[0][0]));
  assert.equal(ran.at(-1)!.command, '/bin/sh', 'the session\'s claude runtime has no sandbox to wrap the probe in');
  assert.equal(ran.at(-1)!.env.CLAUDE_CONFIG_DIR, '/homes/reg-claude');
  assert.equal(ran.at(-1)!.env.CODEX_HOME, process.env.CODEX_HOME, 'the profile\'s own account is not used');

  // Run from a coordinator checkout, a claude worker starts inside the GY-888 read-only mount
  // (startAgentSession → sessionConfinement), so its probe does too: never a bare host shell. Where
  // the mount cannot be built the probe fails naming why, as the worker launch would be refused.
  ran.length = 0;
  const confined = await loopBlockerProbe(accountConfig('codex'), repo, record, async () => null, { registry: { ...local, document: async () => registry } }, repo)(linkedWork, classifyBlocker(incidents[2][0]));
  if (confined?.passed) {
    const wrapped = ran.at(-1)!;
    assert.match(wrapped.command, /bwrap$/, 'the probe runs inside the worker\'s bubblewrap mount');
    assert.ok(wrapped.args.join(' ').includes(`--ro-bind ${repo} ${repo}`), 'with the coordinator checkout read-only');
    assert.match(confined.probe, /inside the claude worker's read-only coordinator mount/);
  } else {
    assert.equal(ran.some(entry => entry.command === '/bin/sh'), false, 'never run bare when the mount cannot be built');
    assert.match(confined!.detail, /unwritable at the OS level/);
  }
  // Really run, the confined write probe fails on the read-only coordinator checkout and passes in the worktree.
  if (confined?.passed) {
    const { command, args } = ran.at(-1)!;
    const launch = { kind: 'claude', args: [], confinement: [command, ...args.slice(0, args.indexOf('--') + 1)] };
    const write = (path: string) => probeBlocker(work, { ...classifyBlocker(incidents[2][0]), path } as any, { run: host, launch, cwd: linked, clock: Date.now() });
    if (process.getuid?.() !== 0) assert.equal((await write(join(repo, 'probe-target')))?.passed, false, 'the coordinator checkout is read-only inside the mount');
    assert.equal((await write(join(linked, 'probe-target')))?.passed, true, 'the worktree stays writable inside the mount');
  }
});

test('unit:scope-blocker-becomes-decision — a planned-file-scope blocker becomes an additive widening decision for the independent approver, and a needs-decision blocker gets its approver launched, without a master', async () => {
  const loop = harness(), state = emptyDaemonState(loopConfig());
  const scoped = await block(await claimed('Scope blocker'), incidents[5][0]);

  await loop.cycle(state);
  const asked = loop.decided.filter(entry => entry.key === scoped.key);
  assert.equal(asked.length, 1, 'one decision, requested by the loop');
  assert.equal(asked[0].action, 'requirements');
  assert.deepEqual(asked[0].input.plannedFiles, ['src/queue-carry.ts', 'src/model/queue.ts'], 'an additive widening by exactly the named file');
  const [requested] = (await ok(master.token, 'GET', `work/${scoped.id}/decisions`)).decisions.filter((decision: any) => decision.action === 'requirements');
  assert.equal(requested.requestedBy, master.id, "requested as the master's operator-agent identity");
  assert.match(requested.reason, /8106499e9f/, 'the request names the commit the files are needed for');
  assert.ok(loop.launched.includes(requested.id), 'its approver was launched');
  assert.equal((await reload(scoped.id)).blockerProbe?.result, 'fail', 'the blocker waits on the widening');

  await ok(approver.token, 'POST', `work/${scoped.id}/approve`, { decision: requested.id, reason: 'The carry reads the queue entry; AC-1 needs it' });
  await loop.cycle(state);
  const widened = await reload(scoped.id);
  assert.deepEqual(widened.plannedFiles, ['src/queue-carry.ts', 'src/model/queue.ts']);
  assert.equal(widened.blocker, null, 'cleared once plannedFiles cover the named file');
  assert.equal(loop.decided.filter(entry => entry.key === scoped.key).length, 1, 'nothing more is requested');

  // A needs-decision blocker: a decision stands requested on the item and no session judges it.
  let waiting = await claimed('Decision blocker');
  const standing = await ok(master.token, 'POST', `work/${waiting.id}/decide`, { action: 'requirements', input: decisionInput('requirements', waiting, { plannedFiles: ['src/queue-carry.ts', 'docs/queue.md'] }), reason: 'The carry is documented beside the queue' });
  waiting = await block(waiting, `Waiting on decision ${standing.id}, already requested; its approver was never launched`);
  assert.equal(classifyBlocker(waiting.blocker).class, 'needs-decision');
  await loop.cycle(state);
  assert.ok(loop.launched.includes(standing.id), 'the approver of the standing decision was launched');
  assert.equal(state.approvals[`hand:${standing.id}`]?.decision, standing.id, 'the launched approver is watched from launch, so supervision closes it once judged');
  const launches = loop.launched.length;
  await loop.cycle(state);
  assert.equal(loop.launched.length, launches, 'launched once, not every cycle');
  assert.equal((await reload(waiting.id)).blocker, waiting.blocker, 'the blocker stands while the decision is requested');
  await ok(approver.token, 'POST', `work/${waiting.id}/approve`, { decision: standing.id, reason: 'The documentation belongs with the carry' });
  await loop.cycle(state);
  assert.equal((await reload(waiting.id)).blocker, null, 'cleared once no decision stands requested');
});

test('unit:blocked-board-shows-class — the board and master status show each blocked item\'s class, last probe and next probe, count only genuine and human-only as needing someone, and docs/master-agent.md names the classes', async () => {
  const loop = harness(() => { throw Object.assign(new Error('probe failed'), { stderr: 'fatal: could not read Username for https://github.com' }); });
  const state = emptyDaemonState(loopConfig());
  const routine = await block(await claimed('Board: credential'), `${incidents[0][0]} (board)`);
  const genuine = await block(await claimed('Board: genuine'), `${incidents[8][0]} (board)`);
  const parked = await claimed('Board: human-only');
  await ok(token(implementer), 'POST', `work/${parked.id}/park`, { epoch: parked.epoch, kind: 'money-or-accounts', needed: 'a Railway team seat', reason: 'The deploy needs a paid seat' });
  await loop.cycle(state);

  const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot');
  const now = Date.parse(snapshot.now);
  const board = buildBoard(snapshot.work, now);
  const row = (key: string) => Object.values(board.groups).flat().find(entry => entry.key === key)!;
  const probed = row(routine.key);
  assert.equal(probed.group, 'blocked');
  assert.equal(probed.blocker?.class, 'github-credential');
  assert.equal(probed.blocker?.needsSomeone, false);
  assert.equal(probed.blocker?.lastProbe?.result, 'fail');
  assert.match(probed.blocker!.lastProbe!.detail, /could not read Username/);
  assert.ok(probed.blocker?.nextProbeAt && Date.parse(probed.blocker.nextProbeAt) > Date.parse(probed.blocker.lastProbe!.at), 'the next probe time is shown');
  assert.equal(probed.actor, 'executor', 'the loop acts next, not the master');
  assert.equal(probed.command, null, 'no master unblock is offered for a routine class');
  const stuck = row(genuine.key);
  assert.equal(stuck.blocker?.class, 'genuine');
  assert.equal(stuck.blocker?.needsSomeone, true);
  assert.equal(stuck.blocker?.nextProbeAt, null);
  assert.equal(stuck.actor, 'master');
  assert.match(stuck.command!, /master unblock/);
  const human = row(parked.key);
  assert.equal(human.group, 'needs-you');
  assert.equal(human.blocker?.class, 'human-only');
  // Only the genuine and the human-only blockers among these count as needing someone.
  const ours = [probed, stuck, human];
  const needing = Object.values(board.groups).flat().filter(entry => entry.blocker?.needsSomeone).map(entry => entry.key);
  assert.deepEqual(ours.filter(entry => needing.includes(entry.key)).map(entry => entry.key), [genuine.key, parked.key]);
  assert.equal(board.blockers!.needingSomeone, needing.length);
  assert.ok(board.blockers!.total > board.blockers!.needingSomeone);

  // master status reads the same board section, and owes nothing for the routine blocker.
  const section = await masterBoard(async () => board, { work: snapshot.work, now: snapshot.now }, {});
  assert.ok(!('error' in section));
  if ('error' in section) return;
  assert.deepEqual(section.blockers, board.blockers);
  assert.ok(!section.owed.some(entry => entry.key === routine.key), 'a routine blocker is not owed by the master');
  assert.ok(section.owed.some(entry => entry.key === genuine.key && entry.blocker?.class === 'genuine'));
  assert.equal(section.others.find(entry => entry.key === routine.key)?.blocker?.lastProbe?.result, 'fail');
  const routineWork = snapshot.work.find((item: Work) => item.id === routine.id);
  assert.equal(workAttentionOwner(routineWork, 'gate').role, 'control plane');
  assert.equal(workAttentionOwner(snapshot.work.find((item: Work) => item.id === genuine.id), 'gate').role, 'master');

  // The operating guide names every class and what clears it.
  const guide = await readFile(join(process.cwd(), 'docs/master-agent.md'), 'utf8');
  for (const name of blockerClasses) assert.ok(guide.includes(`\`${name}\``), `docs/master-agent.md names ${name}`);
});
