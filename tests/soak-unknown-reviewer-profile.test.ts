import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { loadMasterConfig } from '../src/master.js';
import { workerLaunchStatus } from '../src/master/dispatch.js';
import { checkInvariants, emptyInvariantRecord } from '../src/model/invariants.js';
import { type ReviewRecord, readReviewLedger, readReviewerProfileRefusal, reviewerProfileRefusalLimit, reviewerProfileRetryMs, saveReviewerProfile } from '../src/reviewer.js';
import { emptyDispatchCursor, runDispatchTick } from '../src/auto-dispatch.js';
import { fleet, requested, starts } from './helpers/review-fleet.js';
import { clock, minute } from './helpers/soak-world.js';

/**
 * GY-1850 under the real loop: the dispatcher's review launches, tick after tick over simulated
 * hours, for several items and heads, while master.json lacks the reviewer profile the loop asks
 * for (setup never wrote it). The launch boundary refuses each launch, spaces its real attempts of
 * the unknown profile five minutes apart once three in a row were refused, and master status raises
 * one configuration attention; once the profile is written, the next launch clears the record and
 * every item's reviews run. The system invariants hold after every cycle.
 */
test('unit:soak-invariants-hold — review launches refused for an unknown reviewer profile over hours of dispatch ticks, items and heads: real attempts stay bounded to one per five minutes past the third, master status holds one configuration attention, and once the profile is written every review launches and the attention clears', { timeout: 180_000 }, async () => {
  clock.install(Date.now());
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  const tickMs = 30_000, reviewMs = 2 * minute, brokenMs = 45 * minute;
  try {
    // The loop's view names claude-reviewer as its one reviewer profile; master.json on disk, which every launch reads, does not hold it.
    const loaded = await loadMasterConfig(host.root);
    const config = { ...loaded, reviewers: loaded.reviewers.filter(profile => profile.name === 'claude-reviewer') };
    const file = join(host.root, '.graphyard/master.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.reviewers = stored.reviewers.filter((profile: { name: string }) => profile.name !== 'claude-reviewer');
    await writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    const disk = () => loadMasterConfig(host.root);

    const cursor = emptyDispatchCursor(config);
    const total = 6, dayStart = clock.now();
    // Items enter over the broken window and after it; each goes through two heads (changes requested, then approved).
    const items = new Map<number, { work: Work | null; head: number; enterAt: number; deliveredAt: number | null }>();
    for (let n = 1; n <= total; n++) items.set(n, { work: null, head: 1, enterAt: dayStart + (n - 1) * 10 * minute, deliveredAt: null });
    const live = () => [...items.values()].filter(entry => entry.work && entry.deliveredAt === null).map(entry => entry.work!);
    const reviewIds = new Map<string, number>();
    const observe = (record: ReviewRecord) => Date.now() - Date.parse(record.requestedAt) < reviewMs ? null
      : { state: /e2/.test(record.sha) ? 'APPROVED' : 'CHANGES_REQUESTED', reviewer: 'graphyard-reviewer[bot]', reviewId: reviewIds.get(record.id) ?? reviewIds.set(record.id, 20_000 + reviewIds.size).get(record.id)!, submittedAt: new Date().toISOString() };
    const effects = host.effects(live, () => config, observe);

    // Every real attempt of the unknown profile, as the refusal record dates it.
    const attempts: number[] = [];
    let lastAt: string | null = null, fixedAt: number | null = null, attentionFrom: number | null = null, refusedTicks = 0, cycle = 0;
    const record = emptyInvariantRecord();
    for (; cycle < 1000; cycle++) {
      for (const [n, entry] of items) if (!entry.work && entry.deliveredAt === null && entry.enterAt <= clock.now()) entry.work = requested(n, entry.head);
      // The setup step that writes the profile runs once the broken window ends: the profiles change.
      if (fixedAt === null && clock.now() - dayStart >= brokenMs) { await saveReviewerProfile(host.root, { name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }); fixedAt = clock.now(); }
      const tick = await runDispatchTick(config, cursor, effects, Date.now);
      if (tick.refused.some(entry => /Unknown reviewer profile claude-reviewer/.test(entry.reason))) refusedTicks++;
      const refusal = await readReviewerProfileRefusal(config);
      if (refusal && refusal.at !== lastAt) { attempts.push(Date.parse(refusal.at)); lastAt = refusal.at; }

      const attention = (await workerLaunchStatus(host.root, await disk())).items.filter(item => /unknown reviewer profile/.test(item.subject));
      if (fixedAt === null) {
        // No reviewer session starts while the profile is missing.
        assert.deepEqual(starts(host.calls), [], `cycle ${cycle}: no review session starts without its profile`);
        // At most one configuration attention, and it stands from the third refusal until the profiles change.
        assert.ok(attention.length <= 1, `cycle ${cycle}: one attention at most: ${JSON.stringify(attention)}`);
        if (refusal && refusal.refusals >= reviewerProfileRefusalLimit) {
          assert.equal(attention.length, 1, `cycle ${cycle}: the attention stands once ${reviewerProfileRefusalLimit} launches in a row were refused`);
          assert.match(attention[0].text, /claude-reviewer[\s\S]*graphyard master environments --apply/);
          attentionFrom ??= cycle;
        }
      } else if (starts(host.calls).length) {
        // Once a launch has got past the profile lookup, the record and the attention are gone.
        assert.equal(refusal, null, `cycle ${cycle}: the refusal record is cleared once reviews launch`);
        assert.deepEqual(attention, [], `cycle ${cycle}: master status raises no attention once the profile is written`);
      }

      const ledger = (await readReviewLedger(host.root)).reviews;
      for (const entry of items.values()) {
        if (entry.deliveredAt !== null || !entry.work || !ledger.some(review => review.requestId === entry.work!.autoDispatch!.review!.id && review.state === 'completed')) continue;
        if (entry.head === 1) Object.assign(entry, { work: null, head: 2, enterAt: clock.now() + minute });
        else entry.deliveredAt = clock.now();
      }
      const violated = checkInvariants(record, { work: live(), now: clock.now(), agents: host.agents }).filter(check => !check.holds);
      assert.deepEqual(violated.map(check => check.line), [], `cycle ${cycle}: every system invariant holds`);
      if ([...items.values()].every(entry => entry.deliveredAt !== null)) break;
      clock.advance(tickMs);
    }
    assert.ok(cycle < 1000, 'the day settles');
    assert.ok(refusedTicks >= reviewerProfileRefusalLimit, `the loop really knocked on the missing profile (${refusedTicks} refused ticks)`);
    assert.ok(attentionFrom !== null, 'the configuration attention was raised while the profile was missing');

    // Real attempts: the first three as the dispatcher retries, then never two inside five minutes.
    assert.ok(attempts.length >= reviewerProfileRefusalLimit + 1, `the boundary kept attempting at its spacing (${attempts.length} attempts)`);
    for (let index = reviewerProfileRefusalLimit; index < attempts.length; index++)
      assert.ok(attempts[index] - attempts[index - 1] >= reviewerProfileRetryMs, `attempt ${index + 1} came ${(attempts[index] - attempts[index - 1]) / minute} min after the last`);
    const window = (fixedAt! - dayStart) / reviewerProfileRetryMs;
    assert.ok(attempts.length <= reviewerProfileRefusalLimit + Math.ceil(window) + 1, `${attempts.length} real attempts over ${brokenMs / minute} broken minutes stay bounded`);

    // Recovery: every head of every item was reviewed once the profile was written.
    const ledger = (await readReviewLedger(host.root)).reviews;
    assert.equal(ledger.filter(entry => entry.state === 'completed').length, 2 * total, 'every head of every item was reviewed');
    assert.ok(ledger.every(entry => Date.parse(entry.requestedAt) >= fixedAt!), 'no review session started before the profile was written');
    assert.equal(await readReviewerProfileRefusal(config), null);
  } finally { await host.cleanup(); clock.uninstall(); }
});
