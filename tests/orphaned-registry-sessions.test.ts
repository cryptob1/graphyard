import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Work } from '../src/model.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, supersededByRequest, type FleetSession } from '../src/model/registry.js';
import type { FleetClient } from '../src/fleet.js';
import { loadMasterConfig, type MasterConfig } from '../src/master.js';
import { launchReview, readReviewLedger, reconcileReviews } from '../src/reviewer.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { endRegistrySessionById, orphanedRegistrySessions, registryDocument } from '../src/master/registry-slot.js';
import { fleet, requested } from './helpers/review-fleet.js';

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
    roles: [{ name: 'reviewer', accounts: ['reviewer-account'], concurrency }],
    reason: 'fixture reviewer fleet',
  }, { actor: 'operator', at: new Date().toISOString() }).registry;
  const at = () => new Date().toISOString();
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      for (const superseded of supersededByRequest(registry, request)) Object.assign(superseded, { endedAt: at(), endReason: 'superseded' });
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
    launchReview: (work, request, profile, herdr, observedAt) => launchReview(host.root, work, profile.name, herdr, observedAt, { run: host.run, mint: host.mint, requestId: request.id, probe: { registry: registry.client, quota: false, cacheMs: 0 } }),
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

    // A reviewer session the old loop launched; its verdict was posted and the ledger record
    // settled — but the restart left the registry session standing, as nothing the successor loop
    // tracks names it (the incident's state).
    const item = requested(1);
    const requestId = item.autoDispatch!.review!.id;
    const launched = await launchReview(host.root, item, 'review-a', host.agents, new Date().toISOString(), { run: host.run, mint: host.mint, requestId, probe });
    const sessionId = (await readReviewLedger(host.root)).reviews.find(record => record.requestId === requestId)!.session!;
    const pane = launched.pane!;
    assert.deepEqual(registry.live().map(session => session.id), [sessionId], 'the registry counts the fresh review live');
    const verdict = { state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 7, submittedAt: new Date().toISOString() };
    await reconcileReviews(host.root, config, { run: host.run, work: [item], agents: [...host.agents], observe: async () => verdict });
    assert.equal((await readReviewLedger(host.root)).reviews.find(record => record.requestId === requestId)!.state, 'completed', 'the ledger record settled on its verdict');
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
    // predecessor loop launched for GY-501, whose verdict was posted and whose ledger record
    // settled — the pane went with it, and the request it answered stands only on the item.
    const done = requested(1), waiting = requested(2);
    const launched = await launchReview(host.root, done, 'review-a', host.agents, new Date().toISOString(), { run: host.run, mint: host.mint, requestId: done.autoDispatch!.review!.id, probe });
    const sessionId = (await readReviewLedger(host.root)).reviews.find(record => record.requestId === done.autoDispatch!.review!.id)!.session!;
    assert.deepEqual(registry.live().map(session => session.id), [sessionId]);
    const verdict = { state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 7, submittedAt: new Date().toISOString() };
    await reconcileReviews(host.root, config, { run: host.run, work: [done], agents: [...host.agents], observe: async () => verdict });
    assert.equal((await readReviewLedger(host.root)).reviews.find(record => record.requestId === done.autoDispatch!.review!.id)!.state, 'completed');
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
