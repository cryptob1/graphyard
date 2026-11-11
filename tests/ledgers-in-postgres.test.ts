import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { fleet, requested } from './helpers/review-fleet.js';
import { registryFixture } from './helpers/registry-fixture.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { loadMasterConfig, saveProducerProfile } from '../src/master.js';
import { launchReview } from './helpers/pending-review.js';
import { readReviewLedger, reconcileReviews, reviewRecordSchema, saveReviewLedger } from '../src/reviewer.js';
import { launchProducer, readProducerLedger, reconcileProducers, producerRecordSchema, saveProducerLedger } from '../src/producer.js';
import { dispatchCursorPath, emptyDispatchCursor, readDispatchCursor, writeDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DispatchEffects } from '../src/dispatch/effects.js';
import type { DaemonEffects } from '../src/daemon/effects.js';

test('ledgers-in-postgres: first cycle migrates legacy files, resumes attempts and dispatch, and launches past 200 records', async t => {
  const store = await withDatabase('ledgers_in_postgres'); await store.init();
  const token = 'fixture-coordinator-token'.padEnd(40, 'x');
  const http = server(new Engine(store, 120, 'owner/project'), [{ id: 'fixture-loop', role: 'coordinator', token }, { id: 'worker', role: 'worker', token: 'worker-token'.padEnd(40, 'x') }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); });
  const host = await fleet({ name: 'claude-reviewer', agentName: 'reviewer', kind: 'claude', concurrency: 20 }, 'claude-reviewer');
  try {
    const configFile = join(host.root, '.graphyard/master.json');
    const stored = JSON.parse(await readFile(configFile, 'utf8'));
    stored.url = url;
    await writeFile(configFile, JSON.stringify(stored), { mode: 0o600 });
    await writeFile(stored.credentialFile, token, { mode: 0o600 });
    const producerToken = join(await temporaryDirectory('ledger-producer-credential'), 'producer.token');
    await writeFile(producerToken, 'producer-token'.padEnd(40, 'x'), { mode: 0o600 });
    await saveProducerProfile(host.root, { name: 'producer', principal: 'proof-runner', agentName: 'producer', kind: 'claude', agentArgs: ['--setting-sources', 'user'], credentialFile: producerToken, concurrency: 20 },
      async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*'] } }));
    const config = await loadMasterConfig(host.root);
    const now = Date.now(), past = new Date(now - 20 * 60_000).toISOString(), future = new Date(now + 3_600_000).toISOString();
    const items = Array.from({ length: 201 }, (_, i) => requested(i + 1));
    for (const item of items) item.autoDispatch!.producers = [{ ...item.autoDispatch!.review!, id: `producer-${item.key}`, kind: 'producer', group: 'unit', proofs: ['unit:review'] }];
    const reviews = items.map((item, i) => reviewRecordSchema.parse({ id: randomUUID(), key: item.key, pr: item.candidate!.pr, sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: 1,
      profile: i === 200 ? 'claude-reviewer' : 'legacy-reviewer', agentName: `legacy-review-${i}`, pane: null, sessionDirectory: join(host.root, 'legacy-session'), requestedAt: i === 200 ? past : new Date(now).toISOString(), tokenExpiresAt: future,
      requestId: item.autoDispatch!.review!.id, attempt: 1, state: i === 200 ? 'failed' : 'pending', ...(i === 200 ? { closedAt: past } : {}) }));
    const producers = items.map((item, i) => producerRecordSchema.parse({ id: randomUUID(), key: item.key, pr: item.candidate!.pr, sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: 1,
      requestId: item.autoDispatch!.producers[0].id, attempt: 1, group: 'unit', proofs: ['unit:review'], profile: i === 200 ? 'producer' : 'legacy-producer', principal: 'proof-runner', agentName: `legacy-producer-${i}`, pane: null,
      requestedAt: i === 200 ? past : new Date(now).toISOString(), expiresAt: future, state: i === 200 ? 'failed' : 'pending', ...(i === 200 ? { closedAt: past } : {}) }));
    const reviewFile = join(host.root, '.graphyard/reviews.json'), producerFile = join(host.root, '.graphyard/producers.json');
    await writeFile(reviewFile, JSON.stringify({ version: 1, reviews }), { mode: 0o600 });
    await writeFile(producerFile, JSON.stringify({ version: 1, producers }), { mode: 0o600 });
    const cursor = emptyDispatchCursor(config);
    cursor.ticks = 17;
    cursor.failures['retained-failure'] = { kind: 'review', work: items[0].key, sha: items[0].candidate!.sha, attempts: 2, reason: 'long explanation '.repeat(200), at: past, nextAt: future };
    await writeFile(dispatchCursorPath(config), JSON.stringify(cursor), { mode: 0o600 });
    host.agents.push(...reviews.slice(0, 200).map(record => ({ name: record.agentName, agent_status: 'working' })), ...producers.slice(0, 200).map(record => ({ name: record.agentName, agent_status: 'working' })));
    const registry = registryFixture(config.hostId, ['claude'], ['reviewer', 'producer'], 20);
    const launched: string[] = [];
    const effects: DispatchEffects = {
      snapshot: async () => ({ work: items, now: new Date().toISOString() }), agents: () => host.agents,
      credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      reconcileReviews: (work, agents) => reconcileReviews(host.root, config, { work, agents, run: host.run, observe: () => null }),
      reconcileProducers: (work, agents) => reconcileProducers(host.root, config, work, agents, { run: host.run }),
      launchReview: async (work, request, profile, agents, at) => {
        const result = await launchReview(host.root, work, profile.name, agents, at, { run: host.run, registerLaunch: host.registerLaunch, requestId: request.id, probe: registry.probe });
        launched.push('review'); return result;
      },
      launchProducer: async (work, request, profile, agents, at) => {
        const result = await launchProducer(host.root, work, request, profile, agents, at, { run: host.run, probe: registry.probe });
        assert.equal(result.attempt, 2); launched.push('producer'); return result;
      },
      persist: value => writeDispatchCursor(config, value),
    };
    let tick: Awaited<ReturnType<typeof runDispatchTick>> | undefined;
    const daemon: DaemonEffects = {
      agents: () => [], snapshot: effects.snapshot, credentials: async () => ({}),
      closeSession: async () => {}, dispatch: async () => {}, persist: async () => {},
      dispatchTick: async () => { tick = await runDispatchTick(config, await readDispatchCursor(host.root, config), effects); return tick; },
    };
    await runCycle(config, emptyDaemonState(config), daemon);
    assert.deepEqual(launched.sort(), ['producer', 'review'], JSON.stringify(tick) ?? 'dispatch did not finish');
    for (const file of [reviewFile, producerFile, dispatchCursorPath(config)]) assert.equal(existsSync(file), false, `${file} was migrated and removed`);
    const migratedReviews = await readReviewLedger(host.root), migratedProducers = await readProducerLedger(host.root);
    assert.equal(migratedReviews.reviews.length, 202); assert.equal(migratedProducers.producers.length, 202);
    assert.equal(migratedReviews.reviews.at(-1)!.attempt, 2);
    assert.equal((await readDispatchCursor(host.root, config)).ticks, 18);
    assert.equal(Number((await store.pool.query('SELECT count(*) FROM loop_state')).rows[0].count), 405);

    await runCycle(config, emptyDaemonState(config), daemon);
    assert.deepEqual(launched.sort(), ['producer', 'review'], 'a restarted loop does not duplicate pending launches');
    assert.equal((await readDispatchCursor(host.root, config)).ticks, 19);

    // A stale reconcile snapshot updates its own record without erasing a concurrent launch.
    const stale = await readReviewLedger(host.root);
    const newer = { ...reviews[0], id: randomUUID(), agentName: 'concurrent-review' };
    await saveReviewLedger(host.root, { version: 1, reviews: [newer] });
    stale.reviews[0].activeSince = new Date().toISOString(); await saveReviewLedger(host.root, stale);
    assert.ok((await readReviewLedger(host.root)).reviews.some(record => record.id === newer.id));

    // Crash after commit, before unlink: replaying the old file cannot roll back a newer row.
    await writeFile(reviewFile, JSON.stringify({ version: 1, reviews }), { mode: 0o600 });
    assert.equal((await readReviewLedger(host.root)).reviews[0].activeSince, stale.reviews[0].activeSince);
    assert.equal(existsSync(reviewFile), false);
    const restarted = await readDispatchCursor(host.root, config);
    restarted.lastFailure = { at: past, reason: 'x'.repeat(50_000) };
    await writeDispatchCursor(config, restarted);
    assert.equal((await readDispatchCursor(host.root, config)).lastFailure!.reason.length, 50_000);

    // Independent writes stay transactional even when 200 callers enter at once.
    await Promise.all(Array.from({ length: 200 }, (_, i) => saveProducerLedger(host.root, { version: 1, producers: [{ ...producers[0], id: randomUUID(), agentName: `concurrent-${i}` }] })));
    assert.equal((await readProducerLedger(host.root)).producers.length, 402);
    const scope = (await store.pool.query('SELECT scope FROM loop_state LIMIT 1')).rows[0].scope;
    const refused = await fetch(`${url}/api/loop-state/${scope}/reviews`, { method: 'POST', headers: { Authorization: `Bearer ${'worker-token'.padEnd(40, 'x')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [newer] }) });
    assert.equal(refused.status, 403);
    assert.ok(Number((await store.pool.query("SELECT count(*) FROM events WHERE kind LIKE 'loop-state.%' AND actor='fixture-loop'")).rows[0].count) > 200);
    await saveProducerLedger(host.root, migratedProducers);
  } finally {
    await host.cleanup();
  }
});
