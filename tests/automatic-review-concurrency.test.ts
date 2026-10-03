import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { automaticReviewerConcurrency, liveMasterConfig, loadMasterConfig, loadStoredMasterConfig, profileConcurrency, saveMasterSettings, withReviewerDefaults } from '../src/master.js';
import { assertNameAvailable } from '../src/master-resources.js';
import { heldNameAttention, launchReview, readReviewLedger, reconcileReviews, settledCloseAttempts } from '../src/reviewer.js';
import { emptyDispatchCursor, runDispatchTick, selectReviewerProfile } from '../src/auto-dispatch.js';
import { fleet, requested, starts } from './helpers/review-fleet.js';

// GY-1072: on 2026-10-01 every automatic review went to the one profile run.reviewerProfile named,
// whose concurrency was unset (one session), and a finished reviewer left idle in its pane held
// that profile's only name, so 26 launches in an hour were refused at the agent-name bound. Each
// test is named for the proof it produces: unit:automatic-reviews-run-in-parallel and
// unit:settled-reviewer-releases-name.

test('unit:automatic-reviews-run-in-parallel — with run.reviewerProfile set and its concurrency unset, three concurrent review requests all launch at once and none is refused for the agent-name bound', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    assert.equal(config.run.reviewerProfile, 'claude-reviewer');
    assert.equal((await loadStoredMasterConfig(host.root)).reviewers[0].concurrency, undefined, 'the profile declares no concurrency of its own');
    assert.ok(automaticReviewerConcurrency > 1, 'the documented default runs several sessions');
    // The automatic profile reads the default; every other profile keeps one session.
    const { profile } = selectReviewerProfile(config);
    assert.equal(profileConcurrency(profile!), automaticReviewerConcurrency);
    assert.equal(profileConcurrency(withReviewerDefaults(config).reviewers.find(entry => entry.name === 'spare-reviewer')!), 1);
    assert.equal(JSON.parse(await readFile(join(host.root, '.graphyard/master.json'), 'utf8')).reviewers[0].concurrency, undefined, 'the default is read, never written into master.json');

    const items = [requested(1), requested(2), requested(3)];
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => items, () => config), Date.now);
    assert.deepEqual(tick.refused, [], 'no launch is refused');
    assert.deepEqual(tick.waiting.filter(entry => entry.kind === 'review'), [], 'no request waits on the namespace or the limit');
    assert.deepEqual(tick.launched.filter(entry => entry.kind === 'review').map(entry => [entry.work, entry.profile]), [['GY-501', 'claude-reviewer'], ['GY-502', 'claude-reviewer'], ['GY-503', 'claude-reviewer']]);
    const pending = (await readReviewLedger(host.root)).reviews.filter(record => record.state === 'pending');
    assert.equal(pending.length, 3);
    assert.deepEqual(pending.map(record => record.agentName), items.map(item => `claude-reviewer-${item.autoDispatch!.review!.id.slice(0, 8)}`), 'each session is named for its request');
    assert.deepEqual(host.agents.map(agent => agent.name), pending.map(record => record.agentName), 'all three run at once');
    // A fourth review still has a name to take: the namespace is not at its bound.
    assert.doesNotThrow(() => assertNameAvailable('reviewer', profile!, host.agents));

    // Three launches answering three requests at the same moment, outside the dispatcher's turns.
    const parallel = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
    try {
      const more = [requested(4), requested(5), requested(6)];
      const results = await Promise.allSettled(more.map(item => launchReview(parallel.root, item, 'claude-reviewer', [], new Date().toISOString(), { run: parallel.run, mint: parallel.mint, requestId: item.autoDispatch!.review!.id })));
      assert.deepEqual(results.map(result => result.status === 'rejected' ? String(result.reason) : 'launched'), ['launched', 'launched', 'launched']);
      assert.equal(new Set(starts(parallel.calls)).size, 3);
    } finally { await parallel.cleanup(); }

    // A profile that declares its own concurrency keeps it, and without run.reviewerProfile nothing changes.
    const stored = await loadStoredMasterConfig(host.root);
    assert.equal(profileConcurrency(withReviewerDefaults({ ...stored, reviewers: [{ ...stored.reviewers[0], concurrency: 2 }] }).reviewers[0]), 2);
    assert.equal(profileConcurrency(withReviewerDefaults({ ...stored, run: { ...stored.run, reviewerProfile: undefined } }).reviewers[0]), 1);
  } finally { await host.cleanup(); }
});

test('unit:automatic-reviews-run-in-parallel — docs describe the reviewer concurrency default', async () => {
  const text = await readFile(fileURLToPath(new URL('../docs/master-agent.md', import.meta.url)), 'utf8');
  assert.match(text, new RegExp(`run\\.reviewerProfile[^\\n]*${automaticReviewerConcurrency} sessions`), 'docs/master-agent.md states the automatic reviewer profile\'s default concurrency');
});

test('unit:settled-reviewer-releases-name — a reviewer whose request settled but whose pane was left idle is closed on the next pass and the next review launches on its name', async () => {
  // One session at a time, declared: the fixed name is the only one the profile has.
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude', concurrency: 1 }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    const first = requested(1), second = requested(2);
    const launched = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [first], () => config), Date.now);
    assert.deepEqual(launched.launched.map(entry => entry.work), ['GY-501']);
    assert.deepEqual(starts(host.calls), ['claude-reviewer']);
    const pane = host.agents[0].pane_id!;

    // The verdict is posted; Herdr fails to close the pane, so the settled reviewer stays idle in it.
    host.refuseClose.set(pane, Infinity);
    const verdict = { state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 501, submittedAt: new Date().toISOString() };
    await reconcileReviews(host.root, config, { run: host.run, work: [first], agents: [...host.agents], observe: record => record.key === 'GY-501' ? verdict : null });
    const settled = (await readReviewLedger(host.root)).reviews.find(record => record.key === 'GY-501')!;
    assert.equal(settled.state, 'completed', 'the request is settled');
    assert.match(settled.closeFailure ?? '', /could not close pane/);
    host.agents[0].agent_status = 'idle';
    assert.deepEqual(host.agents.map(agent => [agent.name, agent.pane_id, agent.agent_status]), [['claude-reviewer', pane, 'idle']]);
    // While it sits there it holds the only name: a launch on it is refused.
    await assert.rejects(launchReview(host.root, second, 'claude-reviewer', [...host.agents], new Date().toISOString(), { run: host.run, mint: host.mint, requestId: second.autoDispatch!.review!.id }), /claude-reviewer is already visible in Herdr/);

    // The next dispatcher pass closes the settled session's pane and launches the next review on the name, in that one tick.
    host.refuseClose.clear();
    const next = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [first, second], () => config), Date.now);
    assert.ok(host.calls.some(call => call[0] === 'pane' && call[1] === 'close' && call[2] === pane), 'the stale pane is closed');
    assert.deepEqual(next.refused, []);
    assert.deepEqual(next.launched.map(entry => entry.work), ['GY-502'], 'the next review launches');
    assert.equal(starts(host.calls).at(-1), 'claude-reviewer', 'on the name the settled reviewer held');
    const ledger = (await readReviewLedger(host.root)).reviews;
    assert.equal(ledger.find(record => record.key === 'GY-501')!.closeFailure, undefined, 'the close failure is cleared once the pane is gone');
    assert.equal(ledger.find(record => record.key === 'GY-502')!.state, 'pending');
    assert.deepEqual(host.agents.map(agent => agent.name), ['claude-reviewer']);
    assert.notEqual(host.agents[0].pane_id, pane);

    // A pending record holding the name is never closed by this pass: the live reviewer keeps its pane.
    const closes = host.calls.filter(call => call[0] === 'pane' && call[1] === 'close').length;
    await reconcileReviews(host.root, config, { run: host.run, work: [first, second], agents: [...host.agents, { name: 'claude-reviewer', pane_id: pane, agent_status: 'idle' }], observe: () => null });
    assert.equal(host.calls.filter(call => call[0] === 'pane' && call[1] === 'close').length, closes);
  } finally { await host.cleanup(); }
});

test('unit:automatic-reviews-run-in-parallel — launches answering different requests from one stale inventory stop at the automatic profile\'s limit', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  try {
    // Six launches at once, each handed the same empty inventory: the ledger's pending sessions, read under its lock, are what count.
    const items = [1, 2, 3, 4, 5, 6].map(n => requested(n));
    const results = await Promise.allSettled(items.map(item => launchReview(host.root, item, 'claude-reviewer', [], new Date().toISOString(), { run: host.run, mint: host.mint, requestId: item.autoDispatch!.review!.id })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, automaticReviewerConcurrency, 'exactly the default number launch');
    for (const result of results.filter(result => result.status === 'rejected')) assert.match(String((result as PromiseRejectedResult).reason), /profile claude-reviewer is at its concurrency limit \(4 running, limit 4/);
    assert.equal(host.agents.length, automaticReviewerConcurrency);
    assert.equal((await readReviewLedger(host.root)).reviews.filter(record => record.state === 'pending').length, automaticReviewerConcurrency);
  } finally { await host.cleanup(); }
});

test('unit:settled-reviewer-releases-name — a settled reviewer\'s pane Herdr keeps refusing to close is tried a bounded number of times, then reported naming the pane, and the ledger stops changing', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude', concurrency: 1 }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    const first = requested(1);
    await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [first], () => config), Date.now);
    const pane = host.agents[0].pane_id!;
    host.refuseClose.set(pane, Infinity);
    const verdict = { state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 501, submittedAt: new Date().toISOString() };
    await reconcileReviews(host.root, config, { run: host.run, work: [first], agents: [...host.agents], observe: record => record.key === 'GY-501' ? verdict : null });
    const ledgerFile = join(host.root, '.graphyard/reviews.json');
    const passes: { changed: number; ledger: string }[] = [];
    for (let pass = 0; pass < settledCloseAttempts + 4; pass++) {
      const result = await reconcileReviews(host.root, config, { run: host.run, work: [first], agents: [...host.agents], observe: () => null });
      passes.push({ changed: result.changed, ledger: await readFile(ledgerFile, 'utf8') });
    }
    // The settlement's own close, then the sweep's bounded retries, and nothing after.
    assert.deepEqual(host.closes.filter(entry => entry === pane).length, 1 + settledCloseAttempts);
    assert.deepEqual(passes.map(entry => entry.changed > 0), [...Array(settledCloseAttempts).fill(true), false, false, false, false], 'one ledger change per retry, then none');
    assert.equal(new Set(passes.slice(settledCloseAttempts - 1).map(entry => entry.ledger)).size, 1, 'the ledger is not rewritten once the retries are spent');
    const record = (await readReviewLedger(host.root)).reviews.find(entry => entry.key === 'GY-501')!;
    assert.equal(record.closeAttempts, settledCloseAttempts);
    const held = heldNameAttention([record]);
    assert.equal(held.length, 1, 'the held name is reported, not left as a silent bound');
    assert.match(held[0].text, new RegExp(`Settled reviewer session claude-reviewer on GY-501 .* still holds its agent name in pane ${pane}`));
    assert.match(held[0].next, new RegExp(`herdr pane close ${pane}`));

    // Once the pane is gone (closed by hand), the failure clears in one pass and nothing is reported.
    host.agents.splice(0, host.agents.length);
    const cleared = await reconcileReviews(host.root, config, { run: host.run, work: [first], agents: [], observe: () => null });
    assert.equal(cleared.changed, 1);
    assert.deepEqual(heldNameAttention((await readReviewLedger(host.root)).reviews), []);
  } finally { await host.cleanup(); }
});

// GY-1075: the reviewer defaults are applied once, at load, rather than by each reader.
test('unit:automatic-reviews-run-in-parallel — loadMasterConfig applies the automatic reviewer default once at load, the loop\'s reload carries it, and a writer never stores it in master.json', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  try {
    const file = join(host.root, '.graphyard/master.json');
    const loaded = await loadMasterConfig(host.root);
    // A reader that never calls withReviewerDefaults itself still counts the default.
    assert.equal(loaded.reviewers.find(entry => entry.name === 'claude-reviewer')!.concurrency, automaticReviewerConcurrency);
    assert.equal(loaded.reviewers.find(entry => entry.name === 'spare-reviewer')!.concurrency, undefined);
    assert.equal((await loadStoredMasterConfig(host.root)).reviewers[0].concurrency, undefined);
    const live = liveMasterConfig(host.root, loaded);
    const reload = await live.reload();
    assert.equal(reload.refused, null);
    assert.deepEqual(reload.changed, [], 'the defaulted config compares equal to itself across a reload');
    assert.equal(reload.config.reviewers[0].concurrency, automaticReviewerConcurrency);
    // A writer reads the stored form, so the default it did not set is not written back.
    await saveMasterSettings(host.root, { intervalSeconds: 45 });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).reviewers[0].concurrency, undefined, 'master.json still leaves the concurrency unset');
  } finally { await host.cleanup(); }
});

test('unit:settled-reviewer-releases-name — a credential directory a forced settlement could not remove stays on the record through the sweep, is retried, and clears once removed', { skip: process.getuid?.() === 0 ? 'root ignores directory permissions' : false }, async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude', concurrency: 1 }, 'claude-reviewer');
  let locked: string | null = null;
  try {
    const config = await loadMasterConfig(host.root);
    const first = requested(1);
    await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [first], () => config), Date.now);
    const pane = host.agents[0].pane_id!;
    const directory = (await readReviewLedger(host.root)).reviews[0].sessionDirectory;
    // Herdr refuses the settlement's close and the credential directory cannot be removed.
    host.refuseClose.set(pane, 1);
    locked = dirname(directory); await chmod(locked, 0o500);
    const verdict = { state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 501, submittedAt: new Date().toISOString() };
    await reconcileReviews(host.root, config, { run: host.run, work: [first], agents: [...host.agents], observe: record => record.key === 'GY-501' ? verdict : null });
    const record = () => readReviewLedger(host.root).then(ledger => ledger.reviews.find(entry => entry.key === 'GY-501')!);
    assert.match((await record()).closeFailure ?? '', new RegExp(`could not close pane ${pane}.*credential directory .* could not be removed`));
    // The sweep closes the pane; the credential failure is kept, not dropped with the pane failure.
    const swept = await reconcileReviews(host.root, config, { run: host.run, work: [first], agents: [...host.agents], observe: () => null });
    assert.deepEqual(swept.released, [{ pane, agentName: 'claude-reviewer' }]);
    assert.deepEqual(host.agents, []);
    assert.match((await record()).closeFailure ?? '', /^the reviewer credential directory .* could not be removed/);
    assert.deepEqual(heldNameAttention([await record()]), [], 'no pane holds the name, so no held name is reported');
    // Retried while it fails, without rewriting the ledger; cleared on the pass it succeeds.
    assert.equal((await reconcileReviews(host.root, config, { run: host.run, work: [first], agents: [], observe: () => null })).changed, 0);
    assert.match((await record()).closeFailure ?? '', /credential directory/);
    await chmod(locked, 0o700); locked = null;
    assert.equal((await reconcileReviews(host.root, config, { run: host.run, work: [first], agents: [], observe: () => null })).changed, 1);
    assert.equal((await record()).closeFailure, undefined);
    await assert.rejects(readFile(join(directory, 'hosts.yml')), /ENOENT/, 'the credential directory is gone');
  } finally { if (locked) await chmod(locked, 0o700); await host.cleanup(); }
});

test('unit:settled-reviewer-releases-name — a running session handle recorded for the settled reviewer\'s pane does not hold the name in the tick that closes it', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude', concurrency: 1 }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    const first = requested(1), second = requested(2);
    await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [first], () => config), Date.now);
    const pane = host.agents[0].pane_id!;
    host.refuseClose.set(pane, Infinity);
    const verdict = { state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 501, submittedAt: new Date().toISOString() };
    await reconcileReviews(host.root, config, { run: host.run, work: [first], agents: [...host.agents], observe: record => record.key === 'GY-501' ? verdict : null });
    // The reviewer sits at its prompt: the runtime still lists an agent in the pane, so the session
    // report reads the handle as idle, not ended, and nothing but the release frees its slot.
    Object.assign(host.agents[0], { agent: 'claude', agent_status: 'idle' });
    host.refuseClose.clear();
    // The production launcher registered the session: its handle is still running on that pane.
    const handle = { id: 'review-501', kind: 'review', runtime: 'claude', host: config.hostId, agentName: 'claude-reviewer', pane, head: first.candidate!.sha, subject: 'Review GY-501', state: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const recorded = { ...first, sessions: [handle] } as unknown as typeof first;
    const next = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [recorded, second], () => config), Date.now);
    assert.ok(host.closes.includes(pane), 'the stale pane is closed');
    assert.deepEqual(next.waiting.filter(entry => entry.work === 'GY-502'), [], 'the closed reviewer\'s handle holds no slot');
    assert.deepEqual(next.launched.map(entry => [entry.work, entry.profile]), [['GY-502', 'claude-reviewer']], 'the next review launches on the freed name in the same tick, not on the spare profile');
    assert.equal(starts(host.calls).at(-1), 'claude-reviewer');
  } finally { await host.cleanup(); }
});
