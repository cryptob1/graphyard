import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { loadMasterConfig } from '../src/master.js';
import { readReviewLedger, reconcileReviews, reviewIdleGraceMs, vanishedSettledSession } from '../src/reviewer.js';
import { emptyDispatchCursor, runDispatchTick } from '../src/auto-dispatch.js';
import { fleet, requested, starts } from './helpers/review-fleet.js';

// GY-1716: in the snake-v2 pilot GY-9 stayed in review for hours. Its reviewer session left Herdr
// without a verdict; the review ledger settled its record as failed, but the item's own session
// handle stayed `running` — a handle a dispatch request names is ended only by that request's answer
// (GY-1532), and the vanished session was the one meant to answer it — so the dispatcher counted the
// handle's agent name against the profile's only slot and the replacement review waited forever.

/** The item as the control plane serves it once the first launch registered its review session. */
function withReviewHandle(item: Work, host: string, pane: string, startedAt: string): Work {
  const review = item.autoDispatch!.review!;
  return { ...item, sessions: [{ id: review.id, kind: 'review', principal: 'graphyard-reviewer[bot]', epoch: null, runtime: 'claude', host, workspace: 'wC', tab: null, pane,
    agentName: 'claude-reviewer', role: 'review', head: review.sha, attach: null, transcript: null, subject: `${item.key} review`,
    startedAt, updatedAt: startedAt, endedAt: null, state: 'running', outcome: null, observed: 'working', observedAt: startedAt, missedReports: 0 }] } as Work;
}

async function launchedOnce() {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude', concurrency: 1 }, 'claude-reviewer');
  // The fleet's spare profile is removed: the automatic profile's one session is the role's only slot.
  const file = join(host.root, '.graphyard/master.json'), stored = JSON.parse(await readFile(file, 'utf8'));
  stored.reviewers = stored.reviewers.filter((profile: { name: string }) => profile.name === 'claude-reviewer');
  await writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  const config = await loadMasterConfig(host.root);
  const base = requested(1);
  const first = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [base], () => config), Date.now);
  assert.deepEqual(first.launched.map(entry => entry.work), ['GY-501']);
  const pane = host.agents[0].pane_id!;
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  return { host, config, item: withReviewHandle(base, config.hostId!, pane, startedAt), pane };
}

test('unit:vanished-reviewer-slot-freed — a reviewer whose session vanished and whose record settled no longer holds the profile\'s slot, and the loop launches a replacement review', async () => {
  const { host, config, item, pane } = await launchedOnce();
  try {
    // The session leaves Herdr without posting a verdict.
    host.agents.splice(0, host.agents.length);
    // The review ledger marks it idle, then fails it once its idle grace has passed.
    await reconcileReviews(host.root, config, { run: host.run, work: [item], agents: [], observe: () => null, now: () => new Date() });
    await reconcileReviews(host.root, config, { run: host.run, work: [item], agents: [], observe: () => null, now: () => new Date(Date.now() + reviewIdleGraceMs + 1_000) });
    const settled = (await readReviewLedger(host.root)).reviews.find(record => record.key === 'GY-501')!;
    assert.equal(settled.state, 'failed', 'the vanished session is settled on the ledger');

    // The item still records the handle as running: its request is unanswered, so no fact ends it.
    assert.equal(item.sessions![0].state, 'running');
    // Past the attempt's retry wait, so only a slot could still hold the replacement back.
    const later = () => Date.now() + reviewIdleGraceMs + 15 * 60_000;
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [item], () => config), later);
    assert.deepEqual(tick.waiting.filter(entry => entry.kind === 'review'), [], 'the request does not wait on the vanished session\'s slot');
    assert.deepEqual(tick.launched.map(entry => [entry.work, entry.profile]), [['GY-501', 'claude-reviewer']], 'a replacement review launches');
    assert.deepEqual(starts(host.calls), ['claude-reviewer', 'claude-reviewer'], 'on the name the vanished session held');
    assert.notEqual(host.agents[0].pane_id, pane);
    const ledger = (await readReviewLedger(host.root)).reviews.filter(record => record.key === 'GY-501');
    assert.deepEqual(ledger.map(record => record.state), ['failed', 'pending'], 'the replacement is the request\'s next attempt');
  } finally { await host.cleanup(); }
});

test('unit:live-reviewer-slot-kept — a reviewer session Herdr still lists keeps the profile\'s slot, and no second review launches beside it', async () => {
  const { host, config, item } = await launchedOnce();
  try {
    // Another request for a second item waits for the one slot the live session holds.
    const other = requested(2);
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [item, other], () => config), Date.now);
    assert.deepEqual(tick.launched, [], 'nothing launches beside the live reviewer');
    assert.deepEqual(starts(host.calls), ['claude-reviewer'], 'the live session keeps its name');
    assert.deepEqual(tick.waiting.filter(entry => entry.kind === 'review').map(entry => entry.work), ['GY-502']);
    assert.equal((await readReviewLedger(host.root)).reviews.find(record => record.key === 'GY-501')!.state, 'pending');

    // The slot is freed only for a vanished session whose record settled: a listed session keeps it
    // even once its record settled, as do a pending record, an unreadable runtime and another host's session.
    const handle = item.sessions![0], hostId = config.hostId!;
    const settled = [{ requestId: handle.id, agentName: 'claude-reviewer', state: 'failed' as const }];
    assert.equal(vanishedSettledSession(handle, settled, [...host.agents], hostId), false, 'a session Herdr lists holds its slot');
    assert.equal(vanishedSettledSession(handle, [...settled, { requestId: handle.id, agentName: 'claude-reviewer', state: 'pending' as const }], [], hostId), false, 'a pending record holds it');
    assert.equal(vanishedSettledSession(handle, settled, null, hostId), false, 'an unreadable runtime is no evidence it is gone');
    assert.equal(vanishedSettledSession({ ...handle, host: 'another-host' }, settled, [], hostId), false, 'another host answers for its own session');
    assert.equal(vanishedSettledSession(handle, [{ ...settled[0], requestId: 'another-request' }], [], hostId), false, 'a settled record of another request says nothing of this one');
    assert.equal(vanishedSettledSession(handle, settled, [], hostId), true, 'only the vanished, settled session frees it');

    // A pending record whose session the runtime has not listed yet (a launch still starting) holds its slot too.
    host.agents.splice(0, host.agents.length);
    const unlisted = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [item, other], () => config), Date.now);
    assert.deepEqual(unlisted.launched, [], 'a pending record still holds the slot before its idle grace');
    assert.deepEqual(starts(host.calls), ['claude-reviewer']);
  } finally { await host.cleanup(); }
});
