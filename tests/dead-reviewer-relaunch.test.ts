import { launchLegacyReview as launchReview } from './helpers/pending-review.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadMasterConfig, type MasterConfig } from '../src/master.js';
import { readReviewLedger } from '../src/reviewer.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { type DispatchEffects } from '../src/dispatch/effects.js';
import { fleet, requested, starts } from './helpers/review-fleet.js';
import { registryFixture } from './helpers/registry-fixture.js';

// GY-3234: in a pilot four reviewer sessions for one item died; the last stayed recorded running
// although its pane was gone and the registry held no live reviewer session, and the loop waited
// out the launch token (an hour) before relaunching. A pane gone from Herdr with its registry
// session ended is a dead session: the next cycle settles it and launches the next attempt.

test('e2e:dead-reviewer-relaunch — a review whose pane exited and whose registry session is gone is failed with its cause, its credential freed, and the next attempt launched on the next cycle', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude', concurrency: 1 }, 'claude-reviewer');
  try {
    const file = join(host.root, '.graphyard/master.json'), stored = JSON.parse(await readFile(file, 'utf8'));
    stored.reviewers = stored.reviewers.filter((profile: { name: string }) => profile.name === 'claude-reviewer');
    await writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    const config = await loadMasterConfig(host.root);
    const registry = registryFixture(config.hostId!, ['claude'], ['reviewer'], 1);
    const item = requested(1);
    const effects = (): DispatchEffects => ({ ...host.effects(() => [item], () => config as MasterConfig),
      launchReview: (work, request, profile, herdr, observedAt) => launchReview(host.root, work, profile.name, herdr, observedAt, { run: host.run, registerLaunch: host.registerLaunch, requestId: request.id, probe: registry.probe }),
      registry: () => registry.client.document(), endRegistrySession: (session, reason) => registry.client.end(session.id, reason) });
    const cursor = emptyDispatchCursor(config);
    const first = await runDispatchTick(config, cursor, effects(), Date.now);
    assert.deepEqual(first.launched.map(entry => entry.work), ['GY-501']);
    const name = host.agents[0].name!, pane = host.agents[0].pane_id!;
    const launched = (await readReviewLedger(host.root)).reviews[0];
    assert.equal(launched.state, 'pending');
    assert.ok(launched.session, 'the launch records its registry session');

    // The pane exits and the registry session is gone; the token is still good for an hour.
    host.agents.splice(0, host.agents.length);
    await registry.client.end(launched.session!, 'fixture: the session ended');
    assert.ok(Date.parse(launched.tokenExpiresAt) > Date.now() + 30 * 60_000);

    const tick = await runDispatchTick(config, cursor, effects(), Date.now);
    const ledger = (await readReviewLedger(host.root)).reviews.filter(record => record.key === 'GY-501');
    assert.deepEqual(ledger.map(record => record.state), ['failed', 'pending'], 'the dead attempt is failed and the next attempt is pending');
    assert.match(ledger[0].resolution ?? '', new RegExp(`^lost: the reviewer pane ${pane} \\(${name}\\) exited and its registry session ${launched.session} is ended`), 'the failure names its cause');
    await assert.rejects(access(ledger[0].sessionDirectory), 'its reviewer credential is withdrawn');
    assert.deepEqual(tick.launched.map(entry => [entry.work, entry.profile]), [['GY-501', 'claude-reviewer']], 'the next attempt launches on the same cycle');
    assert.equal(ledger[1].attempt, 2);
    assert.deepEqual(starts(host.calls), [name, `${name}-2`]);
    assert.deepEqual(registry.sessions().map(session => session.endedAt ? 'ended' : 'live'), ['ended', 'live'], 'the replacement holds the one reviewer slot');
  } finally { await host.cleanup(); }
});
