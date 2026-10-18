import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { loadMasterConfig, profileConcurrency } from '../src/master.js';
import { checkInvariants, emptyInvariantRecord } from '../src/model/invariants.js';
import { launchReview, readReviewLedger } from '../src/reviewer.js';
import { type DispatchEffects, emptyDispatchCursor, runDispatchTick, selectReviewerProfile } from '../src/auto-dispatch.js';
import { fleet, requested } from './helpers/review-fleet.js';
import { daemonEffects } from '../src/master-daemon.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { loopPresenceHeader, loopSupervisionHeader } from '../src/model/executor-presence.js';
import { setupChecklist } from '../src/model/setup-checklist.js';
import { masterConfigSchema, withRoleDefaults } from '../src/master/profiles.js';
import { clock, hour, minute, staleSha } from './helpers/soak-world.js';
import { api, principals, soakConfig, soakControlPlanes, token, url } from './helpers/soak-plane.js';
import { simulateDay, supervisedAbsentEffects } from './helpers/soak-simulation.js';

/**
 * GY-1501. A supervised install under the real loop for simulated hours: master.json records
 * `supervised`, so the loop runs with no reviewer App, operator-agent or approver identity. The day's
 * candidates are pull requests (retained from before the control plane became the only merge writer,
 * GY-1978), which the operator's own GitHub login reviews; a control-plane head gets the reviewer
 * profile instead, over hours of real dispatch ticks in the second test. One concern of the release-candidate soak (GY-404), in its own
 * file (GY-1363): the world is tests/helpers/soak-world.ts, the control planes
 * tests/helpers/soak-plane.ts, the day tests/helpers/soak-simulation.ts, and the system invariants
 * are asserted after every cycle.
 */
soakControlPlanes('soak-supervised', 413);

const operator = 'soak-operator';
const supervisedConfig = () => withRoleDefaults(masterConfigSchema.parse({ ...soakConfig, supervision: 'supervised', operatorLogin: operator }));

test('unit:supervised-review-gate-human — under the real loop a supervised install merges only heads the operator approved exactly, through GitHub auto-merge: an unapproved head and a stale-approved head never merge, no reviewer, approver or escalation session launches, and the waiting cycles accumulate no actions or sessions', { timeout: 300_000 }, async () => {
  // The day leaves absent exactly what the loop's real effects leave absent for this config.
  const real = daemonEffects('/nonexistent/gy-1501-soak', supervisedConfig(), { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate: async () => ({}) }) as unknown as Record<string, unknown>;
  for (const key of supervisedAbsentEffects) assert.equal(real[key], undefined, `daemonEffects leaves ${key} absent on a supervised install`);
  const autonomous = daemonEffects('/nonexistent/gy-1501-soak', withRoleDefaults(soakConfig), { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate: async () => ({}) });
  assert.ok(autonomous.decide && autonomous.approver, 'the same config in autonomous mode keeps its decision and approver effects');

  const withheld = 3, stale = { item: 2, untilMs: 2 * hour };
  const day = await simulateDay({ hours: 5, supervised: { operator, withheld: [withheld], stale },
    plan: { items: 4, leftovers: 0, slowRecompute: 0, unstable: 0, attested: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0,
      outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } } });
  const { items, final, github, violations, failures, lost, dayStart, supervisedDay } = day;
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  const key = (n: number) => items[n - 1].key, item = (n: number) => final.find(entry => entry.key === key(n))!;

  // Review stays required: every item keeps policy review true under the GitHub provider.
  for (const entry of final.filter(entry => items.some(own => own.key === entry.key))) assert.equal(entry.policy.review, true, `${entry.key} keeps review required`);
  // What the operator approved exactly is delivered, and only through GitHub auto-merge.
  assert.deepEqual([1, 2, 4].map(n => `${key(n)} ${item(n).stage} ${!!item(n).delivery}`), [1, 2, 4].map(n => `${key(n)} done true`), 'every approved item is delivered');
  assert.ok(github.merges.length >= 3);
  for (const merge of github.merges) {
    const pr = github.prs.get(merge.pr)!, head = pr.head;
    // The control plane asks GitHub to merge the head (head-bound: at once when mergeable, else auto-merge); nobody merges outside it.
    assert.ok(merge.mode !== 'outside' && pr.mergeRequestedAt !== null && pr.mergeRequestedAt <= merge.at, `${merge.key} merged through GitHub on the control plane's request: ${merge.mode}`);
    const approval = pr.reviews.find(review => review.reviewer === operator && review.state === 'APPROVED' && review.sha === head);
    assert.ok(approval && Date.parse(approval.submittedAt) <= merge.at, `${merge.key} merged only after the operator approved its exact head ${head.slice(0, 12)}: ${JSON.stringify(pr.reviews)}`);
  }
  // The never-approved item waits in review with nothing merged.
  assert.equal(item(withheld).stage, 'review', `${key(withheld)} waits for the operator's approval`);
  assert.ok(!item(withheld).delivery && !github.merges.some(merge => merge.key === key(withheld)), `${key(withheld)} never merges`);
  assert.deepEqual(item(withheld).gates.find(gate => gate.name === 'review')!.reasons, ['Independent approval of the current commit is required']);
  // The stale-approved head stands for two hours with an approval of an earlier head and does not merge until the exact approval.
  const stalePr = [...github.prs.values()].find(pr => pr.key === key(stale.item))!;
  assert.ok(stalePr.reviews.some(review => review.sha === staleSha(stalePr.pushed.keys().next().value!)), 'the operator approved an earlier head first');
  const staleMerge = github.merges.find(merge => merge.key === key(stale.item))!;
  assert.ok(staleMerge.at >= dayStart + stale.untilMs, `${key(stale.item)} merged only once the exact head was approved (+${Math.round((staleMerge.at - dayStart) / minute)} min)`);

  // The loop launches no reviewer, approver or escalation session.
  assert.deepEqual([...supervisedDay!.agentNames].filter(name => /review|approver|escalation/i.test(name)), [], `no such session: ${[...supervisedDay!.agentNames].join(', ')}`);
  // The waiting cycles, after the last delivery, keep the cursor and the panes level: no retries or sessions accumulate.
  const lastMerge = Math.max(...github.merges.map(merge => merge.at)) - dayStart;
  const waiting = supervisedDay!.cycles.filter(cycle => cycle.elapsed > lastMerge + 15 * minute);
  assert.ok(waiting.length >= 30, `the withheld item waited through many cycles: ${waiting.length}`);
  const rows = waiting[0].withheld;
  assert.ok(rows.some(row => row.startsWith('review:')), `the loop holds the withheld item's review row: ${rows.join('; ')}`);
  for (const cycle of waiting) assert.deepEqual(cycle.withheld, rows, `+${Math.round(cycle.elapsed / minute)} min: the withheld item's rows and their attempts stay level`);
  assert.ok(rows.every(row => / 1$/.test(row)), `no row for the withheld item is retried: ${rows.join('; ')}`);
  assert.ok(Math.max(...waiting.map(cycle => cycle.agents)) <= waiting[0].agents, `no sessions accumulate while the item waits: ${waiting.map(cycle => cycle.agents).join(',')}`);

  // The dashboard's Setup checklist reads the live loop's supervision from /api/status (the loop names it on its coordination read).
  const read = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(principals.coordinator)}`, [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '60', [loopSupervisionHeader]: 'supervised' } });
  assert.equal(read.status, 200);
  const status = await api(principals.operator, 'GET', 'status');
  assert.equal(status.setup.supervision, 'supervised', 'the status carries the live loop\'s supervision');
  const ids = setupChecklist(status).map(entry => entry.id);
  assert.deepEqual(ids, ['github-app', 'reviewer-app', 'account:worker', 'account:reviewer', 'master-loop'], 'the Setup checklist is an autonomous install\'s: no App, and a reviewing account for the control-plane reviewer');
});

test('unit:soak-invariants-hold — a supervised install\'s control-plane heads over hours of real dispatch ticks: each head of each item gets one registered control-plane reviewer session with no GitHub token, its verdict settles it, its pane is closed within one cycle, the waiting cycles accumulate no launches, sessions or cursor rows, and every invariant holds', { timeout: 180_000 }, async () => {
  // GY-1978: a supervised install's heads have no pull request, so its reviewer profile answers them
  // in control-plane mode (selectReviewerProfile). Twelve items enter over the day, more than the
  // profile has room for at once; each goes through two heads (changes requested, then approved).
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  const tickMs = 30_000, reviewMs = 2 * minute, reworkMs = minute, total = 12;
  try {
    const file = join(host.root, '.graphyard/master.json'), stored = JSON.parse(await readFile(file, 'utf8'));
    // Supervised up records no reviewer App (src/up.ts): the profile alone answers.
    delete stored.reviewer; Object.assign(stored, { supervision: 'supervised', operatorLogin: operator });
    await writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    const config = await loadMasterConfig(host.root);
    assert.equal(config.supervision, 'supervised');
    assert.equal(selectReviewerProfile(config).profile, null, 'with no reviewer App, a pull request would get no reviewer');
    const limit = profileConcurrency(selectReviewerProfile(config, 'control-plane').profile!);
    const items = new Map<number, { work: Work | null; head: number; enterAt: number; deliveredAt: number | null }>();
    for (let n = 1; n <= total; n++) items.set(n, { work: null, head: 1, enterAt: clock.now() + (n <= 5 ? 0 : (n - 5) * 7 * minute), deliveredAt: null });
    const live = () => [...items.values()].filter(entry => entry.work && entry.deliveredAt === null).map(entry => entry.work!);
    const enter = (n: number, head: number) => { const work = requested(n, head); work.observation = { ...work.observation!, source: 'control-plane' }; return work; };
    // The control plane registers each launch; its reviewer posts the verdict through the API two minutes later.
    const registered: { key: string; head: string; launch: string; at: number; reviewer: string }[] = [];
    const registerLaunch = async (work: Work, launch: { reviewer: string; head: string }) => {
      const id = `launch-${registered.length + 1}`;
      registered.push({ key: work.key, head: launch.head, launch: id, at: clock.now(), reviewer: launch.reviewer });
      return { launch: id };
    };
    let mints = 0;
    const base = host.effects(live, () => config);
    const effects = { ...base, launchReview: (work, request, profile, herdr, observedAt) => launchReview(host.root, work, profile.name, herdr, observedAt, { run: host.run, mint: async () => { mints++; return host.mint(); }, requestId: request.id, registerLaunch }) } as DispatchEffects;
    const cursor = emptyDispatchCursor(config), record = emptyInvariantRecord(), heldSince = new Map<string, number>(), refused: string[] = [];
    const quiet: { agents: number; launches: number; ledger: string; cursor: string }[] = [];
    let peak = 0, cycle = 0;
    for (; cycle < 600; cycle++) {
      for (const [n, entry] of items) if (!entry.work && entry.deliveredAt === null && entry.enterAt <= clock.now()) entry.work = enter(n, entry.head);
      // Each registered launch's verdict lands on its item once the reviewer has judged it.
      for (const entry of items.values()) {
        const work = entry.work, launch = work && registered.filter(row => row.key === work.key && row.head === work.candidate!.sha).at(-1);
        if (!work || !launch || clock.now() - launch.at < reviewMs) continue;
        work.reviewLaunch = { id: launch.launch, head: launch.head, verdict: { sha: launch.head, state: entry.head === 1 ? 'CHANGES_REQUESTED' : 'APPROVED', reviewer: launch.reviewer, reviewId: 20_000 + registered.indexOf(launch), submittedAt: new Date(launch.at + reviewMs).toISOString() } } as Work['reviewLaunch'];
      }
      const tick = await runDispatchTick(config, cursor, effects, Date.now);
      refused.push(...tick.refused.map(entry => `${entry.work}: ${entry.reason}`));
      const ledger = (await readReviewLedger(host.root)).reviews;
      const sessions = host.agents.filter(agent => agent.name?.startsWith('claude-reviewer')).length;
      assert.ok(sessions <= limit, `cycle ${cycle}: ${sessions} reviewer sessions over the limit of ${limit}`);
      peak = Math.max(peak, sessions);
      // Every settled reviewer is out of its pane by the next cycle.
      for (const entry of ledger.filter(entry => entry.state !== 'pending' && entry.pane)) {
        if (!host.agents.some(agent => agent.pane_id === entry.pane && agent.name === entry.agentName)) { heldSince.delete(entry.pane!); continue; }
        if (!heldSince.has(entry.pane!)) heldSince.set(entry.pane!, cycle);
        assert.ok(cycle - heldSince.get(entry.pane!)! <= 1, `cycle ${cycle}: settled reviewer ${entry.agentName} on ${entry.key} still holds pane ${entry.pane}`);
      }
      // A verdict moves its item on: changes requested is reworked into the next head, an approval delivers it.
      for (const entry of items.values()) {
        if (entry.deliveredAt !== null || !entry.work || !ledger.some(review => review.requestId === entry.work!.autoDispatch!.review!.id && review.state === 'completed')) continue;
        if (entry.head === 1) Object.assign(entry, { work: null, head: 2, enterAt: clock.now() + reworkMs });
        else entry.deliveredAt = clock.now();
      }
      const delivered = [...items].filter(([, entry]) => entry.deliveredAt !== null).map(([n, entry]) => ({ ...enter(n, 2), stage: 'done', delivery: { mergedAt: new Date(entry.deliveredAt!).toISOString() },
        sessions: ledger.filter(review => review.key === `GY-${500 + n}`).map(review => ({ id: review.id, kind: 'review', state: 'running', agentName: review.agentName, pane: review.pane })) }) as unknown as Work);
      const lingering = checkInvariants(record, { work: delivered, now: clock.now(), agents: host.agents }).find(check => check.invariant === 'lingering-sessions')!;
      assert.ok(lingering.holds, `cycle ${cycle}: ${lingering.reading}`);
      if ([...items.values()].every(entry => entry.deliveredAt !== null)) {
        quiet.push({ agents: host.agents.length, launches: registered.length, ledger: JSON.stringify(ledger), cursor: JSON.stringify({ failures: cursor.failures, capacity: cursor.capacity }) });
        if (quiet.length > 20) break;
      }
      clock.advance(tickMs);
    }
    assert.ok(cycle < 600, 'the day settles');
    assert.deepEqual(refused, [], 'no launch was refused');
    assert.ok(peak >= 2, `reviews ran in parallel (peak ${peak})`);
    const ledger = (await readReviewLedger(host.root)).reviews;
    // One control-plane session per head of every item, each registered once, as the profile's own identity, and no GitHub token minted.
    assert.equal(ledger.filter(entry => entry.state === 'completed').length, 2 * total, 'every head of every item was reviewed once');
    assert.ok(ledger.every(entry => entry.mode === 'control-plane'), 'every session is a control-plane review');
    assert.equal(registered.length, 2 * total, 'one registered launch per head');
    assert.equal(new Set(registered.map(row => `${row.key} ${row.head}`)).size, 2 * total, 'no head was launched twice');
    const identities = new Set(config.reviewers.map(profile => profile.agentName));
    assert.ok(registered.every(row => identities.has(row.reviewer)), `each launch registers its profile as the reviewer: ${[...new Set(registered.map(row => row.reviewer))].join(', ')}`);
    assert.equal(mints, 0, 'no reviewer GitHub token was minted');
    // The waiting cycles after the last delivery: no sessions and no new launches; once the delivered
    // item's request is closed on the next cycle, no ledger or cursor churn.
    assert.ok(quiet.every(entry => entry.agents === 0), `every reviewer session was cleaned up: ${quiet.map(entry => entry.agents).join(',')}`);
    assert.equal(new Set(quiet.map(entry => entry.launches)).size, 1, 'no launch while nothing waits');
    assert.equal(new Set(quiet.slice(1).map(entry => entry.ledger)).size, 1, 'the ledger is not rewritten');
    assert.equal(new Set(quiet.map(entry => entry.cursor)).size, 1, 'no cursor row accumulates');
  } finally { await host.cleanup(); }
});
