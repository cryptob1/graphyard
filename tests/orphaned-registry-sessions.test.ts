import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Work } from '../src/model.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, type FleetSession } from '../src/model/registry.js';
import { exactApproval } from '../src/model/review.js';
import type { FleetClient } from '../src/fleet.js';
import { loadMasterConfig, workerProfileSchema, type MasterConfig } from '../src/master.js';
import { launchReview, readReviewLedger, reconcileReviews, updateReviewLedger } from '../src/reviewer.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { endRegistrySessionById, orphanedRegistrySessions, registryDocument } from '../src/master/registry-slot.js';
import { daemonEffects, emptyDaemonState, runCycle } from '../src/master-daemon.js';
import { fleet as launchFleet, requested } from './helpers/review-fleet.js';

// Keep managed checkouts in the fixture too when verify runs this file directly, without the
// suite runner's temporary GRAPHYARD_DATA_HOME.
async function fleet(...args: Parameters<typeof launchFleet>) {
  const host = await launchFleet(...args);
  const file = join(host.root, '.graphyard/master.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.run.worktreeRoot = await temporaryDirectory('post-merge-managed-checkouts', '/var/tmp');
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  return host;
}

// GY-2945: a loop restart leaves the agent-registry sessions of its reviewer and producer launches
// without an owner — the successor loop never marks them ended, because nothing it tracks names
// them, and on 2026-10-24 four finished codex reviews pinned the reviewer role at its concurrency
// limit for an hour while every new review request was refused. The dispatch tick now reconciles
// every registry session the control plane lists live for this host, not only the ones this loop
// launched: the ledger record that launched under the session names its pane, a pane Herdr no
// longer lists is a miss, and the second consecutive miss ends the session — so the request the
// slot held back launches in the same or the next cycle.

/** A logged-in Claude login home, as the account the fixture registry places the reviewer role on. */
async function claudeLogin(name: string) {
  const home = join(await temporaryDirectory('reviewer-login'), name);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `${name}-token`, refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } }), { mode: 0o600 });
  return home;
}

/** The control plane's registry in memory, through the same pure functions the server runs. */
function memoryRegistry(host: string, home: string, concurrency = 4) {
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'),
    models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'reviewer-account', runtime: 'claude', model: 'opus', credential: { host, home } }],
    roles: [{ name: 'reviewer', accounts: ['reviewer-account'], policy: { args: ['--setting-sources', 'user'] }, concurrency }],
    reason: 'fixture reviewer fleet',
  }, { actor: 'operator', at: new Date().toISOString() }).registry;
  const at = () => new Date().toISOString();
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      const choice = chooseSession(registry, request, Date.now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const session: FleetSession = { id: randomUUID(), role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: at(), selectedBy: 'coordinator', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry.sessions.push(session);
      registry.revision++;
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async (id: string, reason: string) => {
      const session = registry.sessions.find(entry => entry.id === id);
      if (session && !session.endedAt) { session.endedAt = at(); session.endReason = reason; }
    },
  };
  return { registry, client, live: () => registry.sessions.filter(session => !session.endedAt) };
}

/** One dispatch tick over the fixture, with the registry and its ends wired to the memory registry. */
function tickEffects(host: Awaited<ReturnType<typeof fleet>>, config: MasterConfig, registry: ReturnType<typeof memoryRegistry>, items: () => Work[], minutes: number, from: number): DispatchEffects {
  const effects: DispatchEffects = {
    snapshot: async () => ({ work: items(), now: new Date(from + minutes * 60_000).toISOString() }),
    agents: () => [...host.agents],
    credentials: async () => ({}),
    reconcileReviews: (work, herdr) => reconcileReviews(host.root, config, { run: host.run, work, agents: herdr }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: (work, request, profile, herdr, observedAt) => launchReview(host.root, work, profile.name, herdr, observedAt, { run: host.run, registerLaunch: host.registerLaunch, requestId: request.id, probe: { registry: registry.client, quota: false, cacheMs: 0 } }),
    launchProducer: async () => { throw new Error('no producer is launched here'); },
    registry: async () => registry.client.document(),
    endRegistrySession: (session, reason) => endRegistrySessionById(config, session.id, reason, registry.client),
    persist: async () => {},
  };
  return effects;
}

test('unit:reconcile-closes-orphaned-registry-sessions — a registry session a restarted loop no longer tracks is ended on the second consecutive miss, with the missing pane named', async () => {
  const host = await fleet({ name: 'review-a', agentName: 'review-a', kind: 'claude', concurrency: 4 }, 'review-a');
  try {
    const config = await loadMasterConfig(host.root);
    const registry = memoryRegistry(config.hostId, await claudeLogin('reviewer-account'));
    const probe = { registry: registry.client, quota: false, cacheMs: 0 };

    // A reviewer session the old loop launched; its approval was dismissed and the ledger record
    // settled — but the restart left the registry session standing, as nothing the successor loop
    // tracks names it (the incident's state).
    const item = requested(1);
    const requestId = item.autoDispatch!.review!.id;
    const launched = await launchReview(host.root, item, 'review-a', host.agents, new Date().toISOString(), { run: host.run, registerLaunch: host.registerLaunch, requestId, probe });
    const sessionId = (await readReviewLedger(host.root)).reviews.find(record => record.requestId === requestId)!.session!;
    const pane = launched.pane!;
    assert.deepEqual(registry.live().map(session => session.id), [sessionId], 'the registry counts the fresh review live');
    const verdict = { state: 'DISMISSED', reviewer: 'graphyard-reviewer[bot]', reviewId: 7, submittedAt: new Date().toISOString() };
    await reconcileReviews(host.root, config, { run: host.run, work: [item], agents: [...host.agents], observe: async () => verdict });
    assert.equal((await readReviewLedger(host.root)).reviews.find(record => record.requestId === requestId)!.state, 'failed', 'the dismissed approval leaves the ledger failed');
    assert.deepEqual(registry.live().map(session => session.id), [sessionId], 'the registry still counts the finished review');
    assert.equal(host.agents.some(agent => agent.pane_id === pane), false, 'the pane went with the session');

    // The dispatch tick: the ledgers name the session's pane and Herdr no longer lists it. The
    // first tick only records the miss; the second consecutive miss ends the session.
    const cursor = emptyDispatchCursor(config), from = Date.now();
    const first = await runDispatchTick(config, cursor, tickEffects(host, config, registry, () => [item], 6, from));
    assert.deepEqual(first.registryClosed, [], 'one miss closes nothing');
    assert.deepEqual(registry.live().map(session => session.id), [sessionId], 'the orphan still holds its slot after the first miss');
    assert.ok(cursor.registryMisses[sessionId], 'the first miss is remembered on the cursor');

    const second = await runDispatchTick(config, cursor, tickEffects(host, config, registry, () => [item], 7, from));
    assert.deepEqual(registry.live(), [], 'the second consecutive miss ends the session');
    const ended = registry.registry.sessions.find(session => session.id === sessionId)!;
    assert.match(ended.endReason!, new RegExp(`pane ${pane}`), 'the endReason names the missing pane');
    assert.deepEqual(second.registryClosed, [{ work: 'GY-501', id: sessionId, role: 'reviewer', pane }], 'the tick says what it released');
    assert.deepEqual(second.closeFailures, []);
  } finally { await host.cleanup(); }
});

test('unit:reviewer-slot-freed-after-orphan-close — the request the orphan held back waits at the limit, then launches on the tick the slot frees', async () => {
  const host = await fleet({ name: 'review-a', agentName: 'review-a', kind: 'claude', concurrency: 1 }, 'review-a');
  try {
    const config = await loadMasterConfig(host.root);
    const registry = memoryRegistry(config.hostId, await claudeLogin('reviewer-account'), 1);
    const probe = { registry: registry.client, quota: false, cacheMs: 0 };
    // The reviewer role runs one session at a time, and its one slot is held by a session the
    // predecessor loop launched for GY-501, whose approval was dismissed and whose ledger record
    // settled — the pane went with it, and the request it answered stands only on the item.
    const done = requested(1), waiting = requested(2);
    const launched = await launchReview(host.root, done, 'review-a', host.agents, new Date().toISOString(), { run: host.run, registerLaunch: host.registerLaunch, requestId: done.autoDispatch!.review!.id, probe });
    const sessionId = (await readReviewLedger(host.root)).reviews.find(record => record.requestId === done.autoDispatch!.review!.id)!.session!;
    assert.deepEqual(registry.live().map(session => session.id), [sessionId]);
    const verdict = { state: 'DISMISSED', reviewer: 'graphyard-reviewer[bot]', reviewId: 7, submittedAt: new Date().toISOString() };
    await reconcileReviews(host.root, config, { run: host.run, work: [done], agents: [...host.agents], observe: async () => verdict });
    assert.equal((await readReviewLedger(host.root)).reviews.find(record => record.requestId === done.autoDispatch!.review!.id)!.state, 'failed');
    assert.equal(host.agents.some(agent => agent.pane_id === launched.pane), false, "the finished review's pane is gone");
    assert.deepEqual(registry.live().map(session => session.id), [sessionId], 'the registry still counts it');

    // GY-502's pending request is due its launch, but the registry refuses it: the finished
    // review's session is at the role's concurrency limit, and the tick waits for a slot.
    const cursor = emptyDispatchCursor(config), from = Date.now();
    const refused = await runDispatchTick(config, cursor, tickEffects(host, config, registry, () => [done, waiting], 6, from));
    assert.deepEqual(refused.launched, [], 'nothing launches while the orphan holds the slot');
    assert.match(refused.waiting.find(entry => entry.work === 'GY-502')!.reason, /waits for a reviewer slot.*role reviewer is at its concurrency limit \(1 of 1 live/);
    assert.deepEqual(refused.refused, [], 'the wait counts no failure against the request');
    assert.deepEqual(registry.live().map(session => session.id), [sessionId], 'one miss leaves the orphan in place');

    // The second consecutive miss ends the orphan, and the same tick's launch takes the slot.
    const freed = await runDispatchTick(config, cursor, tickEffects(host, config, registry, () => [done, waiting], 7, from));
    assert.deepEqual(freed.launched.map(entry => entry.work), ['GY-502'], 'the pending review request launches in the next cycle');
    assert.deepEqual(registry.live().length, 1, 'the relaunch holds the role\'s one slot');
    assert.notEqual(registry.live()[0].id, sessionId, 'it runs under a registry session of its own');
    const ended = registry.registry.sessions.find(session => session.id === sessionId)!;
    assert.match(ended.endReason!, /the Herdr inventory no longer reports pane /);
    assert.equal((await readReviewLedger(host.root)).reviews.filter(record => record.state === 'pending').length, 1, 'the relaunch holds its request');
  } finally { await host.cleanup(); }
});

test('unit:reconcile-closes-orphaned-registry-sessions — an unreadable or absent registry is a gap the next tick retries, never a judgment', async () => {
  const root = await temporaryDirectory('registry-document');
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = { url: 'https://graphyard.example', credentialFile };
  const document = { version: 1, revision: 3 };
  const ok = (async () => new Response(JSON.stringify(document))) as unknown as typeof fetch;
  assert.deepEqual(await registryDocument(config, ok), document, 'the document the control plane serves is read');
  const refusing = (async () => new Response('{"error":"answered 502"}', { status: 502 })) as unknown as typeof fetch;
  assert.equal(await registryDocument(config, refusing), null, 'a control plane that refuses leaves a gap');
  assert.equal(await registryDocument({ credentialFile } as typeof config, ok), null, 'a configuration with no control plane reads nothing');
  // And a gap judges nothing: no listing, no orphans, whatever the ledgers name.
  assert.deepEqual(orphanedRegistrySessions(emptyRegistry(), 'h', null, [{ session: 's', pane: 'p' }], Date.now()), []);
});

for (const orphaned of [false, true]) test(`integration:post-merge-review-slot-release — ${orphaned ? 'an existing completed ledger orphan' : 'normal verdict reconciliation'} frees the only slot with the delivered item absent`, async () => {
  const host = await fleet({ name: 'review-a', agentName: 'review-a', kind: 'claude', concurrency: 1 }, 'review-a');
  try {
    const config = await loadMasterConfig(host.root);
    const registry = memoryRegistry(config.hostId, await claudeLogin('post-merge-reviewer'), 1);
    const done = requested(1), waiting = requested(2), merge = 'c'.repeat(40), parent = 'b'.repeat(40);
    done.stage = 'done';
    done.delivery = { mergeSha: merge, mergedAt: new Date().toISOString(), authorizationRevision: 1 };
    done.postMergeReview = 'owed';
    const requestId = `post-merge:${done.key}:${merge}`;
    const launched = await launchReview(host.root, done, 'review-a', host.agents, new Date().toISOString(), {
      run: host.run, requestId, postMerge: { mergeSha: merge, baseTip: parent },
      probe: { registry: registry.client, quota: false, cacheMs: 0 },
      registerLaunch: async (_work, input) => {
        done.reviewLaunch = { ...input, id: 'post-merge-launch', requester: 'master', at: new Date().toISOString(), verdict: null };
        return { launch: 'post-merge-launch' };
      },
    });
    const record = (await readReviewLedger(host.root)).reviews.find(entry => entry.requestId === requestId)!;
    const sessionId = record.session!;
    done.reviewLaunch!.verdict = { sha: merge, baseSha: parent, state: 'COMMENTED', reviewer: done.reviewLaunch!.reviewer, reviewId: 2992534,
      submittedAt: new Date().toISOString(), body: 'AC-1 met', source: 'control-plane' };
    done.postMergeReview = 'reviewed';
    const requirements = structuredClone(waiting.autoDispatch);
    const verdict = structuredClone(done.reviewLaunch!.verdict);
    const from = Date.now(), cursor = emptyDispatchCursor(config);
    if (orphaned) {
      await reconcileReviews(host.root, config, { run: host.run, work: [done], agents: [...host.agents] });
    } else {
      // The normal loop sees the verdict and closes the pane; its inventory was read before close.
      const first = await runDispatchTick(config, cursor, tickEffects(host, config, registry, () => [done], 6, from));
      assert.deepEqual(first.closeFailures, []);
    }
    const completed = (await readReviewLedger(host.root)).reviews.find(entry => entry.id === record.id)!;
    assert.equal(completed.state, 'completed');
    assert.ok(completed.closedAt);
    assert.ok(completed.requestClosedAt);
    assert.ok(completed.headReleasedAt);
    assert.equal(host.agents.some(agent => agent.pane_id === launched.pane), false);
    assert.deepEqual(registry.live().map(session => session.id), [sessionId], 'reproduce the completed-ledger/live-slot incident');

    // Launch grace and unreadable inventory remain gaps, and a live pane remains counted.
    const names = [{ ...completed }];
    const document = await registry.client.document();
    assert.deepEqual(orphanedRegistrySessions(document, config.hostId, [], names, Date.parse(document.sessions[0].selectedAt)), []);
    assert.deepEqual(orphanedRegistrySessions(document, config.hostId, null, names, from + 6 * 60_000), []);
    assert.deepEqual(orphanedRegistrySessions(document, config.hostId, [{ pane_id: completed.pane! }], names, from + 6 * 60_000), []);

    // No handle or delivered item is available to the close step, and a restarted loop has no misses.
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), tickEffects(host, config, registry, () => [waiting], 7, from));
    assert.deepEqual(tick.registryClosed, [{ work: done.key, id: sessionId, role: 'reviewer', pane: launched.pane }]);
    assert.deepEqual(tick.launched.map(entry => entry.work), [waiting.key], 'the independent review launches on the next eligible cycle');
    assert.match(registry.registry.sessions.find(session => session.id === sessionId)!.endReason!, /review is completed.*pane /);
    assert.equal(registry.live().length, 1);
    assert.notEqual(registry.live()[0].id, sessionId);
    assert.deepEqual(waiting.autoDispatch, requirements, 'slot repair does not change the current review request or requirements');
    assert.deepEqual(done.reviewLaunch!.verdict, verdict);
    const after = (await readReviewLedger(host.root)).reviews.find(entry => entry.id === record.id)!;
    assert.deepEqual([after.state, after.verdict, after.sha, after.baseSha, after.policyRevision, after.requestId],
      [completed.state, completed.verdict, merge, parent, completed.policyRevision, requestId]);
  } finally { await host.cleanup(); }
});

// Exercise production wiring over HTTP and on-disk ledgers, rather than tickEffects. The
// external world is a scratch registry service and Herdr; no live installation is changed.
for (const postMerge of [false, true]) test(`integration:post-merge-review-slot-release — real daemon effects release a completed ${postMerge ? 'post-merge' : 'ordinary COMMENTED'} reviewer and select the next request`, async () => {
  const host = await fleet({ name: 'review-a', agentName: 'review-a', kind: 'claude', concurrency: 1 }, 'review-a');
  const config = await loadMasterConfig(host.root);
  const registry = memoryRegistry(config.hostId, await claudeLogin('daemon-reviewer'), 1);
  const calls: string[] = [];
  const http = createServer(async (request, response) => {
    try {
      calls.push(`${request.method} ${request.url}`);
      assert.equal(request.headers.authorization, `Bearer ${await readFile(config.credentialFile, 'utf8').then(token => token.trim())}`);
      let body = ''; for await (const chunk of request) body += chunk;
      const input = body ? JSON.parse(body) : {};
      let result: unknown;
      if (request.url === '/api/agent-registry/document') result = await registry.client.document();
      else if (request.url === '/api/agent-registry/select') result = await registry.client.select(input);
      else if (/^\/api\/agent-registry\/sessions\/[^/]+\/end$/.test(request.url!)) {
        await registry.client.end(request.url!.split('/')[4], input.reason); result = {};
      } else if (request.url?.endsWith('/review-launch')) result = { launch: 'next-independent-launch' };
      else throw new Error(`Unexpected scratch API request: ${request.url}`);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    config.herdrWorkspace = 'w4G';
    config.url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const file = join(host.root, '.graphyard/master.json');
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const done = requested(1), waiting = requested(2);
    done.key = postMerge ? 'GY-3007' : 'GY-3004';
    done.observation!.source = waiting.observation!.source = 'control-plane';
    const incident = postMerge
      ? { session: 'ef7f783c-72bb-470d-88f0-f682f26e06ee', pane: 'w4G:p3B', start: '2026-11-01T21:36:42.225Z', close: '2026-11-01T21:37:15.320Z', manual: '2026-11-01T21:41:37Z' }
      : { session: 'dcf298f7-eb46-482f-aaaf-4472459d7dbe', pane: 'w4G:p3D', start: '2026-11-01T21:41:44.279Z', close: '2026-11-01T21:42:24.330Z', manual: '2026-11-01T21:47:02Z' };
    if (postMerge) {
      done.stage = 'done'; done.delivery = { mergeSha: 'c'.repeat(40), mergedAt: incident.close, authorizationRevision: 1 }; done.postMergeReview = 'owed';
    }
    const requestId = postMerge ? `post-merge:${done.key}:${done.delivery!.mergeSha}` : done.autoDispatch!.review!.id;
    await launchReview(host.root, done, 'review-a', host.agents, new Date().toISOString(), {
      run: host.run, requestId, ...(postMerge ? { postMerge: { mergeSha: done.delivery!.mergeSha, baseTip: 'b'.repeat(40) } } : {}),
      probe: { registry: registry.client, quota: false, cacheMs: 0 },
      registerLaunch: async (_work, input) => {
        done.reviewLaunch = { ...input, id: 'incident-launch', requester: 'master', at: incident.start, verdict: null };
        return { launch: 'incident-launch' };
      },
    });
    done.reviewLaunch!.verdict = { sha: done.reviewLaunch!.head, baseSha: done.reviewLaunch!.baseTip, state: 'COMMENTED',
      reviewer: done.reviewLaunch!.reviewer, reviewId: 2992534, submittedAt: incident.close, body: 'AC-1 met', source: 'control-plane' };
    if (postMerge) done.postMergeReview = 'reviewed';
    await reconcileReviews(host.root, config, { run: host.run, work: [done], agents: [...host.agents], now: () => new Date(incident.close) });
    await updateReviewLedger(host.root, ledger => {
      const record = ledger.reviews.find(entry => entry.requestId === requestId)!;
      record.session = incident.session; record.pane = incident.pane; record.requestedAt = incident.start;
    });
    Object.assign(registry.registry.sessions[0], { id: incident.session, selectedAt: incident.start });
    // No account home means unknown quota, which is eligible without contacting any provider.
    registry.registry.accounts[0].credential.home = null;
    const settled = (await readReviewLedger(host.root)).reviews[0];
    done.observation!.reviews = [{ id: 2992534, sha: settled.sha, state: 'COMMENTED', reviewer: done.reviewLaunch!.reviewer }];
    assert.equal(settled.state, 'completed'); assert.equal(settled.closedAt, incident.close);
    assert.equal(settled.verdict!.state, 'COMMENTED'); assert.equal(host.agents.length, 0);
    // The completed request is no longer queued; COMMENTED still leaves its review gate closed.
    done.autoDispatch!.review = null;
    const preserved = structuredClone({ done, waiting });
    let clock = Date.parse(incident.start) + 4 * 60_000;
    const snapshot = async () => ({ work: postMerge ? [waiting] : [done, waiting], now: new Date(clock).toISOString() });
    let readable = true;
    const run: typeof host.run = (command, args) => {
      if (args[0] === 'agent' && args[1] === 'list') {
        if (!readable) throw new Error('inventory unreadable');
        return JSON.stringify({ result: { agents: [...host.agents] } });
      }
      return host.run(command, args);
    };
    const real = daemonEffects(host.root, config, { snapshot, run, mutate: async () => ({}) });
    const state = emptyDaemonState(config);
    state.cycle = postMerge ? 2175 : 2183;
    const cycle = async () => {
      let tick: Awaited<ReturnType<typeof runDispatchTick>> | undefined;
      const failures: string[] = [];
      await runCycle(config, state, { ...real, masterSession: undefined, mergeWriter: null,
        dispatchTick: async snapshot => { tick = await real.dispatchTick!(snapshot) as typeof tick; },
      }, () => clock, undefined, line => failures.push(line));
      assert.deepEqual(failures, []);
      assert.ok(tick, 'the real daemon cycle ran dispatch');
      return tick;
    };
    const grace = await cycle();
    assert.deepEqual(grace.registryClosed, []); assert.equal(registry.live()[0].id, incident.session);
    clock = Math.max(Date.parse(incident.manual) + 11_000, Date.parse(incident.start) + 5 * 60_000 + 1_000);
    readable = false;
    assert.equal((await cycle()).registryClosed, undefined, 'unreadable inventory is a gap');
    assert.equal(registry.live()[0].id, incident.session);
    readable = true;
    host.agents.push({ name: settled.agentName, pane_id: incident.pane, agent_status: 'working' });
    // A completed pane that could not yet close remains counted.
    host.refuseClose.set(incident.pane, Infinity);
    assert.deepEqual((await cycle()).registryClosed, []);
    assert.equal(registry.live()[0].id, incident.session);
    host.agents.length = 0;
    assert.equal(state.cycle, postMerge ? 2178 : 2186);
    assert.equal(registry.live()[0].id, incident.session, 'the incident slot is still live with its pane absent before reconciliation');
    const released = await cycle();
    assert.deepEqual(released.closeFailures, []);
    assert.deepEqual(released.registryClosed, [{ work: done.key, id: incident.session, role: 'reviewer', pane: incident.pane }]);
    assert.deepEqual(released.launched.map(entry => entry.work), [waiting.key], JSON.stringify(released));
    assert.match(registry.registry.sessions[0].endReason!, /review is completed.*pane w4G:/);
    assert.equal(registry.live().length, 1); assert.notEqual(registry.live()[0].id, incident.session);
    const again = await cycle();
    assert.deepEqual(again.registryClosed, []); assert.deepEqual(again.launched, []);
    assert.ok(calls.includes('GET /api/agent-registry/document'));
    assert.equal(calls.filter(call => call === `POST /api/agent-registry/sessions/${incident.session}/end`).length, 1);
    assert.ok(calls.includes('POST /api/agent-registry/select'));
    const after = (await readReviewLedger(host.root)).reviews.find(record => record.id === settled.id)!;
    assert.deepEqual([after.verdict, after.sha, after.baseSha, after.policyRevision, after.requestId],
      [settled.verdict, settled.sha, settled.baseSha, settled.policyRevision, settled.requestId]);
    assert.deepEqual({ done, waiting }, preserved, 'COMMENT stays non-approving; no gates, requests or requirements change');
    assert.equal(done.gates.find(gate => gate.name === 'review')!.passed, false);
    assert.equal(exactApproval(done), null, 'COMMENTED cannot supply independent approval');
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); await host.cleanup(); }
});

test('unit:orphaned-registry-sessions — GY-3012 submitted epoch 4 frees its worker slot when the finished pane is gone', async () => {
  const host = await fleet({ name: 'review-a', agentName: 'review-a', kind: 'claude' }, 'review-a');
  try {
    const config = await loadMasterConfig(host.root), registry = memoryRegistry(config.hostId, await claudeLogin('submitted-worker'));
    const selectedAt = '2026-11-04T15:44:00.000Z', endedAt = '2026-11-04T15:46:59.000Z', clock = Date.parse('2026-11-04T15:47:00.000Z');
    const item = requested(12);
    item.key = 'GY-3012'; item.epoch = 4; item.submission!.epoch = 4; item.autoDispatch = undefined;
    item.sessions = [{ id: 'worker:4', kind: 'implementation', principal: 'worker', epoch: 4, runtime: 'codex', host: config.hostId,
      workspace: null, tab: null, pane: 'w4G:finished', agentName: 'worker', role: null, head: item.candidate!.sha,
      attach: null, transcript: null, subject: item.title, startedAt: selectedAt, updatedAt: endedAt, endedAt, state: 'finished', outcome: 'submitted' }];
    const reservation: FleetSession = { id: 'cadad93d-0335-4c72-b4b6-959eebb04aaf', role: 'worker', account: 'reviewer-account', runtime: 'claude', model: 'opus',
      host: config.hostId, work: item.key, principal: 'worker', group: null, selectedAt, selectedBy: 'master', reason: 'worker launch', skipped: [], endedAt: null, endReason: null };
    registry.registry.roles.push({ ...registry.registry.roles[0], name: 'worker', concurrency: 1 });
    registry.registry.sessions.push(reservation);
    const kept = structuredClone(item);
    const orphans = (items = [item], agents: { pane_id?: string }[] | null = []) => orphanedRegistrySessions(registry.registry, config.hostId, agents, [], clock, items);
    assert.deepEqual(orphans([item], null), [], 'unreadable inventory is a gap');
    assert.deepEqual(orphans([item], [{ pane_id: 'w4G:finished' }]), [], 'a visible pane keeps the reservation');
    const active = structuredClone(item); active.sessions![0].state = 'running';
    assert.deepEqual(orphans([active]), [], 'a genuinely active implementation keeps its slot');
    const leased = structuredClone(item); leased.lease = { owner: 'worker', epoch: 4, expiresAt: new Date(clock + 60_000).toISOString() };
    assert.deepEqual(orphans([leased]), [], 'a live lease is preserved');
    const otherEpoch = structuredClone(item); otherEpoch.sessions![0].epoch = 3;
    assert.deepEqual(orphans([otherEpoch]), [], 'another attempt cannot end this reservation');
    assert.equal(orphans()[0].id, reservation.id, 'finished submitted work releases even within launch grace');
    const effects = tickEffects(host, config, registry, () => [item], 0, clock);
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), effects, () => clock);
    assert.deepEqual(tick.registryClosed, [{ work: item.key, id: reservation.id, role: 'worker', pane: 'w4G:finished' }]);
    assert.match(reservation.endReason!, /submitted implementation is finished/);
    // The next automatic worker dispatch takes the slot; no manual release or claim is needed.
    const queued = requested(51);
    Object.assign(queued, { key: 'GY-3051', type: 'chore', stage: 'ready', epoch: 17, submission: null, candidate: null, observation: null, autoDispatch: undefined });
    config.workers = [workerProfileSchema.parse({ name: 'worker', principal: 'worker', agentName: 'worker', kind: 'claude', mode: 'launch', credentialFile: config.credentialFile })];
    const dispatched: string[] = [];
    await runCycle(config, emptyDaemonState(config), {
      snapshot: async () => ({ work: [item, queued], now: new Date(clock).toISOString() }), agents: () => [],
      credentials: async () => ({ worker: { available: true, reason: null } }), closeSession: async () => {}, persist: async () => {},
      dispatch: async work => {
        const next = await registry.client.select({ role: 'worker', host: config.hostId, group: null, work: work.key, principal: 'worker', observations: [] });
        assert.equal(next.selected, true);
        dispatched.push(work.key);
        return { epoch: 18, pane: 'w4G:next-worker', runtime: 'claude' };
      },
    }, () => clock);
    assert.deepEqual(dispatched, ['GY-3051']);
    assert.deepEqual(item, kept, 'slot reconciliation preserves the submitted candidate and requirements');
  } finally { await host.cleanup(); }
});
