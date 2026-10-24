import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, supersededByRequest, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import type { FleetClient } from '../src/fleet.js';
import { loadMasterConfig, type MasterConfig } from '../src/master.js';
import { launchReview, readReviewLedger, reconcileReviews } from '../src/reviewer.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { registrySlotOf, endRegistrySlot } from '../src/master/registry-slot.js';
import { fleet, requested } from './helpers/review-fleet.js';

// GY-2944: the agent registry counts a reviewer or producer session live from its launch, but
// nothing ended it when the review was recorded or the item moved on — on 2026-10-24 an install
// carried four live codex reviewer sessions for items reviewed and merged an hour before, while
// Herdr listed no codex pane at all. The loop's close step now releases the registry session of
// every review or proof session whose request is answered, whose item left review, or whose pane
// Herdr no longer reports.

/** A logged-in Claude login home, as the account the fixture registry places the reviewer role on. */
async function claudeLogin(name: string) {
  const home = join(await temporaryDirectory('reviewer-login'), name);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `${name}-token`, refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } }), { mode: 0o600 });
  return home;
}

/** The control plane's registry in memory, through the same pure functions the server runs. */
function memoryRegistry(host: string, home: string) {
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'),
    models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'reviewer-account', runtime: 'claude', model: 'opus', credential: { host, home } }],
    roles: [{ name: 'reviewer', accounts: ['reviewer-account'], concurrency: 4 }],
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

/** The session handle the dispatcher records for a launched review or proof session (auto-dispatch.ts). */
const handle = (requestId: string, kind: 'review' | 'proof', host: string, launched: { pane?: string | null; agentName?: string | null }, head: string) => ({
  id: requestId, kind, runtime: 'claude', host, role: kind, head,
  ...(launched.agentName ? { agentName: launched.agentName } : {}),
  ...(launched.pane ? { pane: launched.pane, attach: `herdr pane attach ${launched.pane}` } : {}),
  subject: 'fixture review session', state: 'running' as const, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), endedAt: null, outcome: null,
});

/** One cycle over one item, releasing through the fixture's own ledgers into the memory registry. */
async function closeCycle(root: string, config: MasterConfig, registry: ReturnType<typeof memoryRegistry>, item: Work, agents: unknown[]) {
  const released: { session: string | null; reason: string }[] = [];
  const effects = {
    snapshot: async () => ({ work: [item], now: new Date().toISOString() }),
    agents: () => [...agents] as never[],
    herdr: async () => ({ agents: [...agents] as never[], available: true }),
    credentials: async () => ({}),
    closeSession: () => {},
    recordSession: async () => {},
    dispatch: async () => { throw new Error('nothing is dispatched in this cycle'); },
    mergeWriter: null,
    persist: async () => {},
    releaseRegistrySession: async (session: Parameters<typeof endRegistrySlot>[2], reason: string) => {
      const ended = await endRegistrySlot(root, config, session, reason, registry.client);
      released.push({ session: ended, reason });
      return ended;
    },
  } as unknown as DaemonEffects;
  await runCycle(config, emptyDaemonState(config), effects);
  return released;
}

test('unit:reviewer-session-released-after-review — the close step releases a reviewer session the registry still counts once its verdict is recorded, and one whose pane Herdr no longer reports, with the missing pane named', async () => {
  const host = await fleet({ name: 'review-a', agentName: 'review-a', kind: 'claude', concurrency: 4 }, 'review-a');
  try {
    const config = await loadMasterConfig(host.root);
    const registry = memoryRegistry(config.hostId, await claudeLogin('reviewer-account'));
    const probe = { registry: registry.client, quota: false, cacheMs: 0 };

    // A reviewer session launched through the fixture fleet: the registry chose its account and
    // recorded the session, and the ledger record carries the registry session it ran under.
    const item = requested(1);
    const requestId = item.autoDispatch!.review!.id;
    const launched = await launchReview(host.root, item, 'review-a', host.agents, new Date().toISOString(), { run: host.run, mint: host.mint, requestId, probe });
    const sessionId = (await readReviewLedger(host.root)).reviews.find(record => record.requestId === requestId)!.session!;
    assert.deepEqual(registry.live().map(session => [session.id, session.work]), [[sessionId, 'GY-501']], 'the registry counts the fresh review live');

    // Its verdict is recorded on the review-recording path, and the item moves past review: the
    // control plane resolves the request the session answered.
    const verdict = { state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 7, submittedAt: new Date().toISOString() };
    await reconcileReviews(host.root, config, { run: host.run, work: [item], agents: [...host.agents], observe: async () => verdict });
    assert.equal((await readReviewLedger(host.root)).reviews.find(record => record.requestId === requestId)!.state, 'completed');
    item.observation!.reviews = [{ sha: item.candidate!.sha, state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', id: 7, source: 'control-plane', submittedAt: verdict.submittedAt }];
    reconcileAutoDispatch(item, [item], new Date());
    assert.equal(item.autoDispatch!.review, null, 'the request no longer stands');

    // The next close step releases the registry session, so the finished review stops consuming
    // the reviewer role's concurrency.
    (item as { sessions?: unknown[] }).sessions = [handle(requestId, 'review', config.hostId, launched, item.candidate!.sha)];
    const [released] = await closeCycle(host.root, config, registry, item, host.agents);
    assert.equal(released.session, sessionId);
    assert.match(released.reason, /review request was satisfied/);
    assert.deepEqual(registry.live(), [], 'the registry counts no session for the finished review');
    assert.equal(registry.registry.sessions.find(session => session.id === sessionId)!.endReason, released.reason);

    // A second reviewer session whose request still stands, but whose pane Herdr no longer lists
    // (a codex session exits on its own): the close step releases it too, naming the missing pane.
    const vanished = requested(2);
    const vanishedRequestId = vanished.autoDispatch!.review!.id;
    const gone = await launchReview(host.root, vanished, 'review-a', host.agents, new Date().toISOString(), { run: host.run, mint: host.mint, requestId: vanishedRequestId, probe });
    const goneSessionId = (await readReviewLedger(host.root)).reviews.find(record => record.requestId === vanishedRequestId)!.session!;
    assert.deepEqual(registry.live().map(session => session.id), [goneSessionId], 'the standing request holds its session');
    host.agents.splice(host.agents.findIndex(agent => agent.pane_id === gone.pane), 1);
    (vanished as { sessions?: unknown[] }).sessions = [handle(vanishedRequestId, 'review', config.hostId, gone, vanished.candidate!.sha)];
    const [goneRelease] = await closeCycle(host.root, config, registry, vanished, host.agents);
    assert.equal(goneRelease.session, goneSessionId);
    assert.match(goneRelease.reason, new RegExp(`pane ${gone.pane}`), 'the release names the missing pane');
    assert.deepEqual(registry.live(), [], 'the registry counts no session for the vanished reviewer either');
  } finally { await host.cleanup(); }
});

test('unit:reviewer-session-released-after-review — the same release serves a producer session: a proof session whose request is answered gives its registry slot back', async () => {
  const host = await fleet({ name: 'review-a', agentName: 'review-a', kind: 'claude', concurrency: 4 }, null);
  try {
    const config = await loadMasterConfig(host.root);
    const registry = memoryRegistry(config.hostId, await claudeLogin('reviewer-account'));
    // A producer session on the ledger, its registry session recorded, answering a proof request
    // the item has moved past: the request was cancelled, so the slot is given back.
    const item = requested(3);
    item.autoDispatch!.producers = [{
      id: 'proof-request-1', kind: 'producer', sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: 1, group: 'unit', proofs: ['unit:review'],
      state: 'cancelled', requestedAt: new Date().toISOString(), reason: 'the control plane withdrew the request',
    }] as never;
    const registrySession = randomUUID();
    const record = {
      id: randomUUID(), requestId: 'proof-request-1', attempt: 1, session: registrySession, key: item.key, pr: item.candidate!.pr,
      sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: 1, group: 'unit', proofs: ['unit:review'],
      profile: 'review-a', principal: 'proof-producer', agentName: 'proof-a', pane: 'pane-proof', requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), state: 'pending', outcome: {},
    };
    const { saveProducerLedger } = await import('../src/producer.js');
    await saveProducerLedger(host.root, { version: 1, producers: [record as never] });
    assert.deepEqual(await registrySlotOf(host.root, { key: item.key, id: 'proof-request-1', kind: 'proof', head: item.candidate!.sha, pane: 'pane-proof', agentName: 'proof-a' }), registrySession);

    (item as { sessions?: unknown[] }).sessions = [handle('proof-request-1', 'proof', config.hostId, { pane: 'pane-proof', agentName: 'proof-a' }, item.candidate!.sha)];
    const [released] = await closeCycle(host.root, config, registry, item, host.agents);
    assert.equal(released.session, registrySession);
    assert.match(released.reason, /producer request was cancelled/);
    assert.deepEqual(registry.live(), [], 'the registry counts no session for the finished proof');
  } finally { await host.cleanup(); }
});
