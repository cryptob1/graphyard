import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import type { RuntimeSession, SessionHandle, SessionHandleInput } from '../src/model/sessions.js';
import { registeredLaunch } from '../src/model/session-state.js';
import { approverSessionId, approverSessionName, closeHerdrPane, masterConfigSchema, registeredReview, runAutonomyCommand, type MasterConfig } from '../src/master.js';
import { dispatchEffects, emptyDispatchCursor, runDispatchTick } from '../src/auto-dispatch.js';
import { controlPlaneHandlers } from '../src/executor.js';
import { relaunchSession } from '../src/master-daemon.js';
import { expandTypedCommand, requestOf } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-172 AC-2: every path that starts a session registers the same session record before its
 * runtime starts, so the session report observes it and closes it by AC-1's rules. The proof
 * launches an approver through `master approver` against a simulated Herdr and the real engine, and
 * follows its record from before the runtime starts to its closure once its decision is judged and
 * its pane is gone; the executor's, the loop's and `master review`'s launches are held to the same
 * order.
 */

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'executor-a', role: 'coordinator' };
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_EVERY_LAUNCH_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 193);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('every-launch'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [1234], 120, 'owner/project');
  engine.principals = [operator, coordinator];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (id: string) => (await store.list()).find(entry => entry.id === id)!;
const mutate = async (path: string, body: unknown) => { const [, id, command] = path.split('/'); return engine.execute(coordinator, command as any, decodeURIComponent(id), body, randomUUID()); };

/** A checkout the real approver launcher accepts: master.json and the three credentials, each 0600, outside it. */
async function host() {
  const root = await temporaryDirectory('launch-root'), secrets = await temporaryDirectory('launch-secrets');
  execFileSync('git', ['init', '-q', root]);
  const credential = async (name: string) => { const file = join(secrets, `${name}.token`); await writeFile(file, `${name}-token-`.padEnd(48, 'x'), { mode: 0o600 }); return file; };
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: await credential('coordinator'), cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', herdrWorkspace: 'wA',
    operatorAgent: { id: 'graphyard-master-operator', credentialFile: await credential('operator') }, approver: { id: 'graphyard-approver', credentialFile: await credential('approver') },
    reviewer: { appId: 4242, installationId: 99, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: '2026-09-01T00:00:00.000Z' },
    reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude', approvals: 'auto' }], run: { reviewerProfile: 'claude-reviewer', awaitReviewersMinutes: 0 } });
  await mkdir(join(root, '.graphyard'));
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify(master), { mode: 0o600 });
  return { root, master, cleanup: () => Promise.all([rm(root, { recursive: true, force: true }), rm(secrets, { recursive: true, force: true })]) };
}

/** The part of Herdr a launch and a pane close speak to; `onStart` runs as the runtime is started in its pane. */
function herdr(onStart: (pane: string) => Promise<void>) {
  const sessions = new Map<string, { name: string; pane: string; status: string }>();
  const panes = new Set<string>(), occupants = new Map<string, { kind: string; request: string }>();
  let created = 0;
  const ok = (result: unknown = {}) => JSON.stringify({ result });
  const run = async (command: string, args: string[]) => {
    assert.equal(command, 'herdr');
    const [noun, verb] = args;
    if (noun === 'tab' && verb === 'create') { const pane = `wA:p${++created}`; panes.add(pane); return ok({ root_pane: { pane_id: pane, tab_id: `wA:t${created}` } }); }
    if (noun === 'pane' && verb === 'run') {
      await onStart(args[2]);
      const launch = expandTypedCommand(args[3]);
      occupants.set(args[2], { kind: launch.kind, request: requestOf(launch.kind, launch.args) ?? '' }); return '';
    }
    if (noun === 'pane' && verb === 'read') return '';
    if (noun === 'agent' && verb === 'get') {
      const occupant = occupants.get(args[2]);
      return occupant ? ok({ agent: { agent: occupant.kind, agent_status: occupant.request ? 'working' : 'idle', pane_id: args[2] } }) : JSON.stringify({ error: { code: 'agent_not_found', message: 'not found' } });
    }
    if (noun === 'agent' && verb === 'rename') { sessions.set(args[3], { name: args[3], pane: args[2], status: 'working' }); return ok(); }
    if (noun === 'agent' && verb === 'prompt') return ok();
    if (noun === 'agent' && verb === 'list') return ok({ agents: [...sessions.values()].map(session => ({ name: session.name, pane_id: session.pane, agent: 'claude', agent_status: session.status })) });
    if (noun === 'pane' && verb === 'close') { for (const session of [...sessions.values()].filter(entry => entry.pane === args[2])) sessions.delete(session.name); panes.delete(args[2]); occupants.delete(args[2]); return ok(); }
    if (noun === 'pane' && verb === 'list') return ok({ panes: [...panes].map(pane_id => ({ pane_id })) });
    throw new Error(`The simulated Herdr has no ${args.slice(0, 2).join(' ')}`);
  };
  return { run, sessions, listing: (): RuntimeSession[] => [...sessions.values()].map(session => ({ name: session.name, pane_id: session.pane, agent: 'claude', agent_status: session.status })) };
}

test('integration:every-launch-registered — an approver launched through master approver is recorded before its runtime starts, observed by the loop\'s session report, and closed once its decision is judged and its pane is gone', async () => {
  const { root, master, cleanup } = await host();
  try {
    let item = await engine.execute(operator, 'create', null, { title: 'Approve something', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Judged', proofs: ['unit:judged'] }] }, randomUUID());
    item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
    const decision = randomUUID(), id = approverSessionId(decision), name = approverSessionName(item, decision);
    const handleOf = async () => (await reload(item.id)).sessions?.find(handle => handle.id === id);

    // What the record said at the moment the runtime was started in its pane.
    let atStart: SessionHandle | undefined;
    const runtime = herdr(async () => { atStart = await handleOf(); });
    const launched = await runAutonomyCommand(root, master, 'approver', [item.key, decision, 'claude'], {
      coordinator: async path => { assert.equal(path, 'work-snapshot'); return { work: [await reload(item.id)], now: new Date().toISOString() }; },
      readSecret: async () => '', agents: () => [], daemonLock: async () => null, mutate, runtime: runtime.run }) as { agentName: string; pane: string };
    assert.equal(launched.agentName, name);

    // Registered before the runtime started: the record already existed, open, with its pane and name.
    assert.ok(atStart, 'the session record existed before the runtime was started');
    assert.deepEqual([atStart!.state, atStart!.pane, atStart!.agentName, atStart!.kind, atStart!.role, atStart!.principal, atStart!.runtime, atStart!.host],
      ['running', launched.pane, name, 'coordination', 'approver', 'graphyard-approver', 'claude', 'machine-a']);
    assert.equal(atStart!.attach, `herdr pane attach ${launched.pane} --workspace wA`);

    // The loop's report observes it like any other session, on each dispatch tick.
    const config = masterConfigSchema.parse({ ...master, hostId: 'machine-a' });
    const cursor = emptyDispatchCursor(config);
    let clock = Date.now();
    const tick = () => runDispatchTick(config, cursor, { ...dispatchEffects(root, () => config, { snapshot: async () => ({ work: [await reload(item.id)], now: new Date(clock).toISOString() }), mutate, run: runtime.run }),
      agents: () => runtime.listing() as any, credentials: async () => ({}), reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }), persist: async () => {} }, () => clock);
    await tick();
    assert.deepEqual([(await handleOf())!.observed, (await handleOf())!.state], ['working', 'running'], 'observed working while it judges');

    // It judges the decision and stops at its prompt: settled, but its pane is still there — idle, not over.
    runtime.sessions.get(name)!.status = 'done';
    clock += 30_000; await tick();
    assert.deepEqual([(await handleOf())!.observed, (await handleOf())!.state], ['idle', 'running'], 'a judged approver at its prompt is idle, still open');

    // Its pane is closed. Two consecutive reports without it and the record is closed, with the reason.
    await closeHerdrPane(launched.pane, runtime.run);
    clock += 30_000; const first = await tick();
    assert.deepEqual(first.closed, [], 'one report without it closes nothing');
    clock += 30_000; const second = await tick();
    assert.deepEqual(second.closed.map(closure => [closure.id, closure.cause]), [[id, 'vanished']]);
    const closed = (await handleOf())!;
    assert.deepEqual([closed.state, closed.observed], ['finished', 'lost']);
    assert.ok(closed.endedAt);
    assert.match(closed.outcome!, new RegExp(`has not reported pane ${launched.pane} for \\d+s \\(absent from 2 consecutive session reports`));
    assert.equal((await reload(item.id)).sessions!.filter(handle => handle.id === id).length, 1, 'one record for the session, from registration to closure');
  } finally { await cleanup(); }
});

test('integration:every-launch-registered — the executor, the loop\'s reviewer launches, its quota failover relaunch and master review register before the runtime starts, and a launch that fails ends its registration with the reason', async () => {
  const { root, master, cleanup } = await host();
  try {
    let item = await engine.execute(operator, 'create', null, { title: 'Launch paths', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Registered', proofs: ['unit:registered'] }] }, randomUUID());
    item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
    const sha = 'a'.repeat(40);
    const request = { id: randomUUID(), kind: 'review', provider: 'github', sha, baseSha: 'b'.repeat(40), policyRevision: 1, pr: 7, state: 'requested', requestedAt: new Date().toISOString(), reason: 'the head needs a review' };
    const withReview = (work: Work) => ({ ...work, stage: 'review', candidate: { sha, baseSha: 'b'.repeat(40), pr: 7, branch: 'graphyard/x-1', author: 'a' }, autoDispatch: { review: request, producers: [], history: [] } }) as unknown as Work;
    const order: string[] = [];
    const record = async (work: Work, handle: SessionHandleInput) => { order.push(`record:${handle.id}:${handle.state}${handle.pane ? `:${handle.pane}` : ''}`); return mutate(`work/${work.id}/session`, handle); };

    // The executor's reviewer launch.
    const handlers = controlPlaneHandlers(() => master, {
      snapshot: async () => ({ work: [withReview(await reload(item.id))], now: new Date().toISOString() }), mutate, agents: () => [],
      workerCredentials: async () => ({}), producerCredentials: async () => ({}), dispatchWorker: async () => { throw new Error('unused'); },
      launchReview: async () => { order.push('start:executor-review'); return { pane: 'wA:p70', agentName: 'review-claude' }; },
      launchProducer: async () => { throw new Error('unused'); }, merge: async () => ({}), observeDeployment: async () => ({}) as any, recordSession: record,
    });
    await handlers['request-review']!({ id: 'row', work: item.id, key: item.key, kind: 'request-review', inputs: { kind: 'request-review' } } as any, { host: 'machine-a', executor: 'executor-a' } as any);
    assert.deepEqual(order, [`record:${request.id}:running`, 'start:executor-review', `record:${request.id}:running:wA:p70`], 'registered, started, then its pane written');

    // The loop's own reviewer launch, on a dispatch tick — once the executor's session, which holds
    // the reviewer's one slot, has ended.
    await mutate(`work/${item.id}/session`, { id: request.id, kind: 'review', runtime: 'claude', host: 'machine-a', subject: `${item.key}: review`, state: 'finished', outcome: 'judged' });
    order.length = 0;
    const config = masterConfigSchema.parse({ ...master });
    const loopTick = await runDispatchTick(config, emptyDispatchCursor(config), { ...dispatchEffects(root, () => config, { snapshot: async () => ({ work: [withReview(await reload(item.id))], now: new Date().toISOString() }), mutate, run: () => '' }),
      agents: () => [], credentials: async () => ({}), reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }), persist: async () => {},
      launchReview: async () => { order.push('start:loop-review'); return { pane: 'wA:p71' }; }, recordSession: record });
    assert.ok(loopTick.launched.length, `the tick launched the reviewer; it waited on ${JSON.stringify([loopTick.waiting, loopTick.refused])}`);
    assert.deepEqual(order, [`record:${request.id}:running`, 'start:loop-review', `record:${request.id}:running:wA:p71`]);

    // `master review`, once the loop's reviewer has ended too.
    await mutate(`work/${item.id}/session`, { id: request.id, kind: 'review', runtime: 'claude', host: 'machine-a', subject: `${item.key}: review`, state: 'finished', outcome: 'judged' });
    order.length = 0;
    await registeredReview(master, [item.key], { work: [withReview(await reload(item.id))] }, (path, body) => { order.push(`record:${(body as SessionHandleInput).id}:${(body as SessionHandleInput).state}${(body as SessionHandleInput).pane ? `:${(body as SessionHandleInput).pane}` : ''}`); return mutate(path, body); },
      async () => { order.push('start:master-review'); return { pane: 'wA:p72', agentName: 'review-claude-2' }; });
    assert.deepEqual(order, [`record:${request.id}:running`, 'start:master-review', `record:${request.id}:running:wA:p72`]);
    const recorded = (await reload(item.id)).sessions!.find(handle => handle.id === request.id)!;
    assert.deepEqual([recorded.pane, recorded.agentName, recorded.kind, recorded.head], ['wA:p72', 'review-claude-2', 'review', sha]);

    // A second `master review` for the same request while that reviewer runs is refused by the
    // launcher; the control plane refuses its registration and its closure, since the running
    // handle is held by the launch that started it, so the running reviewer stays recorded open.
    order.length = 0;
    await assert.rejects(registeredReview(master, [item.key], { work: [withReview(await reload(item.id))] }, (path, body) => { order.push(`record:${(body as SessionHandleInput).id}:${(body as SessionHandleInput).state}`); return mutate(path, body); },
      async () => { throw new Error(`A reviewer session for ${item.key} is already pending`); }), /already pending/);
    const running = (await reload(item.id)).sessions!.find(handle => handle.id === request.id)!;
    assert.deepEqual([running.state, running.pane, running.outcome], ['running', 'wA:p72', null], 'the running reviewer stays recorded open');

    // Two launches racing from one stale snapshot (two `master review`s, or one and the loop's own
    // reviewer launch): both pass any check against that snapshot, the launcher runs one and
    // refuses the other, and whichever order their writes land in, the one that runs is recorded
    // open with its pane and the refused one closes nothing.
    for (const refusedFirst of [true, false]) {
      await mutate(`work/${item.id}/session`, { id: request.id, kind: 'review', runtime: 'claude', host: 'machine-a', subject: `${item.key}: review`, state: 'finished', outcome: 'the earlier reviewer ended' });
      const stale = { work: [withReview(await reload(item.id))] };
      let registeredBoth!: () => void; const both = new Promise<void>(done => { registeredBoth = done; });
      let registrations = 0; const record = (path: string, body: unknown) => { const result = mutate(path, body); if ((body as SessionHandleInput).state === 'running' && !(body as SessionHandleInput).pane && ++registrations === 2) registeredBoth(); return result; };
      let refusedDone!: () => void; const refusalWritten = new Promise<void>(done => { refusedDone = done; });
      const winner = registeredReview(master, [item.key], stale, record, async () => { await both; if (!refusedFirst) await refusalWritten; return { pane: 'wA:p80', agentName: 'review-claude-3' }; });
      const loser = registeredReview(master, [item.key], stale, (path, body) => { const result = record(path, body); if ((body as SessionHandleInput).state === 'finished') result.finally(() => refusedDone()).catch(() => {}); return result; },
        async () => { await both; if (refusedFirst) await winner; throw new Error(`A reviewer session for ${item.key} is already pending`); });
      await Promise.all([winner, assert.rejects(loser, /already pending/)]);
      const raced = (await reload(item.id)).sessions!.find(handle => handle.id === request.id)!;
      assert.deepEqual([raced.state, raced.pane, raced.agentName, raced.outcome], ['running', 'wA:p80', 'review-claude-3', null], `the reviewer that runs stays recorded open (refused ${refusedFirst ? 'after' : 'before'} the winner's coordinates)`);
    }

    // The loop's quota failover: the reviewer that ran out of quota is ended, its record closed with
    // that reason, and its request's next session is registered before its runtime starts on another
    // profile, then coordinated — one record for the request, open on the relaunched session.
    const failoverConfig = masterConfigSchema.parse({ ...master, reviewers: [...master.reviewers, { name: 'codex-reviewer', agentName: 'review-codex', kind: 'codex', approvals: 'auto' }] });
    order.length = 0;
    const exhausted = (await reload(item.id)).sessions!.find(handle => handle.id === request.id)!;
    assert.equal(exhausted.state, 'running');
    const relaunched = await relaunchSession(failoverConfig, { role: 'reviewer', record: 'ledger-1', profile: 'claude-reviewer', agentName: exhausted.agentName!, pane: exhausted.pane, work: item.key, requestId: request.id }, withReview(await reload(item.id)), [], {
      review: async profile => { order.push(`start:failover-review:${profile.name}`); return { pane: 'wA:p90', agentName: 'review-codex' }; },
      producer: async () => { throw new Error('unused'); },
      record: handle => { order.push(`record:${handle.id}:${handle.state}${handle.pane ? `:${handle.pane}` : ''}`); return mutate(`work/${item.id}/session`, handle); },
    });
    assert.equal(relaunched.profile, 'codex-reviewer', 'the profile that ran out goes last');
    assert.deepEqual(order, [`record:${request.id}:finished`, `record:${request.id}:running`, 'start:failover-review:codex-reviewer', `record:${request.id}:running:wA:p90`], 'the exhausted session is closed, then the relaunch registered, started and coordinated');
    const failedOver = (await reload(item.id)).sessions!.filter(handle => handle.id === request.id);
    assert.equal(failedOver.length, 1, 'one record for the request');
    assert.deepEqual([failedOver[0].state, failedOver[0].pane, failedOver[0].agentName, failedOver[0].runtime, failedOver[0].attach], ['running', 'wA:p90', 'review-codex', 'codex', 'herdr pane attach wA:p90 --workspace wA']);

    // A launch that fails ends its registration with why, rather than leaving an open record to be lost.
    await assert.rejects(registeredLaunch(handle => mutate(`work/${item.id}/session`, handle), { id: 'doomed', kind: 'coordination', runtime: 'claude', host: 'machine-a', subject: `${item.key}: doomed`, state: 'running' },
      async () => { throw new Error('the pane refused the runtime'); }), /refused the runtime/);
    const doomed = (await reload(item.id)).sessions!.find(handle => handle.id === 'doomed')!;
    assert.equal(doomed.state, 'finished');
    assert.match(doomed.outcome!, /^the launch failed before the session started: the pane refused the runtime/);
  } finally { await cleanup(); }
});
