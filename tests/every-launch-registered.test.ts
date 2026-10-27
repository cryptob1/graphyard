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
import type { SessionHandleInput } from '../src/model/sessions.js';
import { registeredLaunch } from '../src/model/session-state.js';
import { masterConfigSchema, registeredReview, type MasterConfig } from '../src/master.js';
import { dispatchEffects, emptyDispatchCursor, runDispatchTick } from '../src/auto-dispatch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2026-09-01 boundAt is reviewer-binding fixture data nothing ages; the ticks run on a clock seeded from Date.now() and new Date() stamps snapshots and requests on that clock.

/**
 * GY-172 AC-2: every path that starts a session registers the same session record before its
 * runtime starts, so the session report observes it and closes it by AC-1's rules. The
 * executor's, the loop's and `master review`'s launches are held to that order.
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
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = [operator, coordinator];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (id: string) => (await store.list()).find(entry => entry.id === id)!;
const mutate = async (path: string, body: unknown) => { const [, id, command] = path.split('/'); return engine.execute(coordinator, command as any, decodeURIComponent(id), body, randomUUID()); };

/** A checkout the real launchers accept: master.json and its credentials, each 0600, outside it. */
async function host() {
  const root = await temporaryDirectory('launch-root'), secrets = await temporaryDirectory('launch-secrets');
  execFileSync('git', ['init', '-q', root]);
  const credential = async (name: string) => { const file = join(secrets, `${name}.token`); await writeFile(file, `${name}-token-`.padEnd(48, 'x'), { mode: 0o600 }); return file; };
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: await credential('coordinator'), cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', herdrWorkspace: 'wA',
    operatorAgent: { id: 'graphyard-master-operator', credentialFile: await credential('operator') },
    reviewer: { appId: 4242, installationId: 99, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: '2026-09-01T00:00:00.000Z' },
    reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude', approvals: 'auto' }], run: { reviewerProfile: 'claude-reviewer', awaitReviewersMinutes: 0 } });
  await mkdir(join(root, '.graphyard'));
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify(master), { mode: 0o600 });
  return { root, master, cleanup: () => Promise.all([rm(root, { recursive: true, force: true }), rm(secrets, { recursive: true, force: true })]) };
}

test('integration:every-launch-registered — the loop\'s reviewer launches and master review register before the runtime starts, and a launch that fails ends its registration with the reason', async () => {
  const { root, master, cleanup } = await host();
  try {
    let item = await engine.execute(operator, 'create', null, { type: 'chore',  title: 'Launch paths', criteria: [{ id: 'AC-1', text: 'Registered', proofs: ['unit:registered'] }] }, randomUUID());
    item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
    const sha = 'a'.repeat(40);
    const request = { id: randomUUID(), kind: 'review', provider: 'github', sha, baseSha: 'b'.repeat(40), policyRevision: 1, pr: 7, state: 'requested', requestedAt: new Date().toISOString(), reason: 'the head needs a review' };
    const withReview = (work: Work) => ({ ...work, stage: 'review', candidate: { sha, baseSha: 'b'.repeat(40), pr: 7, branch: 'graphyard/x-1', author: 'a' }, autoDispatch: { review: request, producers: [], history: [] } }) as unknown as Work;
    const order: string[] = [];
    const record = async (work: Work, handle: SessionHandleInput) => { order.push(`record:${handle.id}:${handle.state}${handle.pane ? `:${handle.pane}` : ''}`); return mutate(`work/${work.id}/session`, handle); };

    // The loop's own reviewer launch, on a dispatch tick.
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

    // A launch that fails ends its registration with why, rather than leaving an open record to be lost.
    await assert.rejects(registeredLaunch(handle => mutate(`work/${item.id}/session`, handle), { id: 'doomed', kind: 'coordination', runtime: 'claude', host: 'machine-a', subject: `${item.key}: doomed`, state: 'running' },
      async () => { throw new Error('the pane refused the runtime'); }), /refused the runtime/);
    const doomed = (await reload(item.id)).sessions!.find(handle => handle.id === 'doomed')!;
    assert.equal(doomed.state, 'finished');
    assert.match(doomed.outcome!, /^the launch failed before the session started: the pane refused the runtime/);
  } finally { await cleanup(); }
});
