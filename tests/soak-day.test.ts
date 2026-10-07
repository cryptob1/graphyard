import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTestFiles, releaseCandidateTests, repositoryRoot } from '../scripts/ci-tests.mjs';
import { paneSweepLimit } from '../src/daemon/cycle-reclaim.js';
import { memoryActionKey } from '../src/daemon/cycle-dispatch.js';
import { diagnosisSettled } from '../src/runner/payloads.js';
import { splitReport } from '../src/decomposition.js';
import { clearDecompositionRuns } from '../src/decomposition-step.js';
import { diagnosisLimitHoldMs } from '../src/daemon/diagnosis.js';
import { terminalDecisions } from '../src/cli/decision-report.js';
import { docsTrimActionKey } from '../src/daemon/faults.js';
import { systemInvariants } from '../src/model/invariants.js';
import { tmpReclaimLimitPerCycle } from '../src/tmp-reclaim.js';
import { lostRunReason, requestAttemptLimit } from '../src/producer.js';
import { loopWatchdogSeconds } from '../src/supervisor.js';
import { throughputRemeasureMs, throughputStatus } from '../src/throughput.js';
import { blockedMergeMs, brokenBaseTest, clock, hour, minute, protectionOnlyCheck, statusContext } from './helpers/soak-world.js';
import { laneApprover } from '../src/server/decisions.js';
import { doctorRunEvent } from '../src/server/routes/status.js';
import { MANUAL, api, basePlan, blockedMergeItem, coordinatorRoot, diagnosisLimit, principals, remedyItem, soakConfig, soakControlPlanes, store } from './helpers/soak-plane.js';
import { assertLaunchesConfined, memoryDay, simulateDay } from './helpers/soak-simulation.js';

/**
 * The main day and the whole-loop days: fifteen items delivered with every invariant holding, the
 * documentation budget, a loop regression the soak must fail on, and broad items split before
 * dispatch. One concern of the release-candidate soak (GY-404), split per concern (GY-1363) so
 * concurrent changes stop colliding in one file: the world is tests/helpers/soak-world.ts, the
 * control planes tests/helpers/soak-plane.ts, the day itself tests/helpers/soak-simulation.ts, and
 * every suite asserts the system invariants after every cycle.
 */
soakControlPlanes('soak-day', 404);

test('unit:soak-invariants-hold — the soak runs as one suite per concern (GY-1363): at least four tests/soak-*.test.ts files, each the release-candidate soak suite and within 1,500 lines, no test name in two of them, and no tests/soak.test.ts holding them all', () => {
  const suites = listTestFiles().filter(file => /^tests\/soak-[\w-]+\.test\.ts$/.test(file));
  assert.ok(suites.length >= 4, `the soak is split per concern: ${suites.join(', ')}`);
  assert.ok(!existsSync(join(repositoryRoot, 'tests/soak.test.ts')), 'no single file holds every soak scenario');
  const owners = new Map<string, string[]>();
  for (const file of suites) {
    assert.equal(releaseCandidateTests[file], 'soak', `${file} runs as the release-candidate soak suite`);
    const lines = readFileSync(join(repositoryRoot, file), 'utf8').split('\n');
    assert.ok(lines.length <= 1500, `${file} stays within 1,500 lines (${lines.length})`);
    for (const line of lines) {
      const name = line.match(/^test\('((?:[^'\\]|\\.)*)'/)?.[1];
      if (name) owners.set(name, [...owners.get(name) ?? [], file]);
    }
  }
  for (const [name, files] of owners) assert.equal(files.length, 1, `${name} is held by exactly one suite: ${files.join(', ')}`);
});

test('unit:soak-invariants-hold — a simulated day of the real loop: fifteen items delivered and every system invariant holding after every cycle', { timeout: 360_000 }, async () => {
  const began = performance.now();
  const hours = Number(process.env.SOAK_HOURS ?? 24);
  const day = await simulateDay({ hours, backlog: true, github806: true, remedies: true, plan: { blockedMerge: blockedMergeItem, ...memoryDay }, diagnosisLimit, staleDiagnosis: true, promotion: true });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { reconciled, outside, items, final, github, sessions, docsSyncRuns, docsSyncRoot, lost, launches, violations, observed, failures, production, cycles, reportedDispatches, dayStart, tmp, state, attestations, producerRuns, spentHead, actionKeys, upgrades, refusalSamples, guardReads, checkout, herdr, landingRefusals, foreignPane, previousWorktrees, closedLeased, mergeQueuePosts, approverPanes, herdrClosed, diagnosisModel, diagnosisRuns, decideCalls, baseBreak, baseFailure, decided, misreads, prompts, exitedLive, exitedClosed, exitedRowsSeen, lanesSeen, laneApplications, approverWorks, diagnosisRaces, diagnosisRequestRaces } = day;
  const undelivered = final.filter(item => item.stage !== 'done' || !item.delivery);
  assert.deepEqual(undelivered.map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all fifteen items are delivered');
  // GY-1060: every item merged under protection requiring `secrets` beside the policy's checks, so
  // the union gate, the batch verdicts and the window view read a protection-only check all day.
  // A final observation taken before CI reported on its head carries no runs and is not judged.
  assert.ok(final.every(item => item.observation?.requiredChecks?.some(check => check.name === protectionOnlyCheck && check.appId === null)
    && (!item.observation.checks.length || item.observation.checks.some(run => run.name === protectionOnlyCheck && run.result === 'success')))
    && final.filter(item => item.observation!.checks.length).length >= basePlan.items - 1, `every delivery passed the protection-only ${protectionOnlyCheck} check`);
  assert.ok(final.every(item => item.observation?.requiredChecks?.some(check => check.name === statusContext && check.appId === null)
    && (!item.observation.checks.length || item.observation.checks.some(run => run.name === statusContext && run.source === 'status' && run.result === 'success'))),
    `every delivery passed the status-sourced ${statusContext} context`);
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease: a dead worker lapses, it is not refused');
  assert.deepEqual([...observed].sort(), [...systemInvariants].sort(), 'every invariant was observed, not merely left unread');
  // GY-1302: the loop drove promotion all day over a moving main: at most one dispatch per
  // promoteEveryMinutes window, none while a candidate was in validation, and its fetches and run
  // reads bounded by their read windows, not by the cycle count.
  const { promotion } = day;
  if (process.env.SOAK_TRACE) console.error(`promotion: ${JSON.stringify({ ...promotion, dispatches: promotion.dispatches.map(at => Math.round((at - dayStart) / minute)) })}`);
  // Main moves through the merges of the day's first hours and production catches it at the second
  // deploy, so the loop promotes on that cadence and then has nothing to promote.
  assert.ok(promotion.dispatches.length >= 2 && promotion.dispatches.length <= Math.ceil(hours / 2), `the loop promoted every two hours while main moved: ${promotion.dispatches.length} over ${hours} h`);
  assert.deepEqual(promotion.violations, [], 'never twice in a window, never while a candidate is in validation, never when production runs main');
  assert.ok(promotion.ledgerReads <= Math.ceil(hours * hour / (5 * minute)) + 2 * basePlan.loopRestarts.length + 2, `fetches once per five-minute read window (${promotion.ledgerReads} over ${cycles} cycles)`);
  assert.ok(promotion.runReads <= Math.ceil(hours * hour / minute) + 2 * basePlan.loopRestarts.length + 2 && promotion.runReads < cycles, `run reads at most once a minute (${promotion.runReads} over ${cycles} cycles)`);
  // A refused dispatch counts as an attempt: one per interval, not one per cycle, and the failed
  // fetches of the unreachable half hour at most one per read window.
  assert.ok(promotion.failedDispatches.length >= 1 && promotion.failedDispatches.length <= 1 + basePlan.loopRestarts.length, `refused dispatches are not repeated every cycle: ${promotion.failedDispatches.length} in the first hour`);
  assert.ok(promotion.failedLedgerReads <= Math.ceil(30 * minute / (5 * minute)) + 1, `failed fetches stay bounded (${promotion.failedLedgerReads} in half an hour)`);
  // GY-806: webhooks drove observation all day — every woken job claimed ahead of the polled ones
  // and re-observed within the minute of its delivery, and no poll skipped outside a refresh.
  const { webhook } = day;
  assert.ok(webhook.deliveries >= basePlan.items && webhook.woken >= basePlan.items, `check_run webhooks woke the items: ${JSON.stringify(webhook)}`);
  assert.deepEqual(webhook.late, [], 'every webhook-woken job was claimed before any polled job of its pass');
  assert.deepEqual(webhook.unobserved, [], 'every webhook-woken item was re-observed within the minute of its delivery');
  assert.ok(webhook.refreshes > 0, 'webhook-driven observations recorded their refresh on the job');
  assert.equal(webhook.skipped, 0, 'no poll was skipped past the refresh that justified it');
  // GY-806: the immutable cache, run through the real adapter all day, stayed within its bound while every
  // path still read was fetched once; the day produced more distinct paths than the bound holds, so it aged out.
  const { immutable } = day;
  assert.ok(immutable.cycles > 0 && immutable.reads > 0, `the immutable path ran every cycle: ${JSON.stringify(immutable)}`);
  assert.ok(immutable.distinct > immutable.bound.rows, `the day asked more distinct paths (${immutable.distinct}) than the bound holds (${immutable.bound.rows})`);
  assert.ok(immutable.peakLive <= immutable.bound.rows, `the bound holds every path still read (${immutable.peakLive})`);
  assert.deepEqual(immutable.overBound, [], 'immutable rows and bytes stayed within their bound every cycle');
  assert.deepEqual(immutable.refetched, [], 'no path still read was asked of GitHub twice');
  if (process.env.SOAK_TRACE) console.error(`immutable: ${JSON.stringify(immutable)}`);
  // GY-1052: the shared per-cycle reads ran on the real adapter every cycle: one base-ref read per cycle
  // however many items observed it, protection at most every five minutes, and every read bound the current tip.
  const { shared, charges } = day;
  assert.ok(shared.cycles > 0 && shared.observations > shared.cycles, `the shared reads ran every cycle: ${JSON.stringify(shared)}`);
  assert.deepEqual(shared.overRead, [], 'no cycle read the base ref more than once');
  assert.ok(shared.refReads <= shared.cycles, `one ref read per cycle at most (${shared.refReads} over ${shared.cycles})`);
  assert.ok(shared.protectionReads <= 2 * (Math.ceil(hours * hour / (5 * minute)) + 1), `protection and branch rules every five minutes at most (${shared.protectionReads})`);
  assert.deepEqual(shared.failed, [], 'every observation through the real adapter completed');
  assert.deepEqual(shared.stale, [], 'every observation bound the base branch as it was');
  // GY-1052: the charge ledger stayed within two hours of rows across restarts, and the fleet count was the other replica's hour.
  assert.ok(charges.cycles > 0 && charges.b > 0 && charges.restarts > 0, `the charge ledger ran all day across restarts: ${JSON.stringify({ ...charges, instancesSeen: charges.instancesSeen.length })}`);
  assert.deepEqual(charges.overBound, [], 'github_charges stayed within its two-hour bound every cycle');
  assert.deepEqual(charges.miscounted, [], 'every sync counted the other replica\'s last hour exactly');
  assert.ok(charges.boundaryCycles > 0, `the boundary minute held charges older than an hour that the count included (${charges.boundaryCycles} cycles)`);
  assert.ok(lanesSeen.size > 0, 'the day\'s items were evaluated into risk lanes, each checked against its change and its status row every cycle');
  // GY-883: the low-lane item's rework round ran with no approver session. Its first application
  // was refused, recorded failed and requested again on the retry interval; the second applied it,
  // with the lane as its ground, and its watch settled once — no decision was left supervised.
  const lowItem = final.find(item => item.key === items[basePlan.lowLane - 1].key)!;
  assert.ok(lanesSeen.has('low') && lanesSeen.has('high'), `the day rode both the low and the high lane: ${[...lanesSeen].join(', ')}`);
  assert.equal(lowItem.lane, 'low', 'the item whose observation names its one module rides low');
  assert.equal(lowItem.pipeline?.reworkRounds, 1, 'its review verdict cost it one rework round');
  assert.deepEqual(approverWorks.filter(key => key === lowItem.key), [], 'no approver session was launched for the low-lane item');
  assert.deepEqual(laneApplications.map(entry => entry.refused), [true, false], 'the lane applied its rework twice: refused once, then applied');
  const laneReworks = ((await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(lowItem.id)}/decisions`)).decisions as { action: string; state: string; approvedBy?: string | null }[]).filter(entry => entry.action === 'rework');
  assert.deepEqual(laneReworks.map(entry => entry.state), ['failed', 'applied'], `one failed application, then one applied: ${JSON.stringify(laneReworks)}`);
  assert.equal(laneReworks[1].approvedBy, laneApprover, 'the applied rework names the risk lane as its approver');
  const laneRecords = Object.values(state.actions).filter(entry => entry.work === lowItem.key && entry.kind === 'decision' && /its risk lane needs no approver/.test(entry.detail));
  assert.deepEqual(laneRecords.map(entry => [entry.state, entry.attempts]), [['done', 2]], `the loop requested it twice under one action, the second time applied: ${JSON.stringify(laneRecords.map(entry => entry.detail))}`);
  assert.ok(laneApplications[1].at - laneApplications[0].at >= minute, 'the failed application was requested again on a later cycle, not inside the one that failed');
  const laneWatches = Object.values(state.approvals).filter(watch => watch.work === lowItem.key);
  assert.ok(laneWatches.every(watch => watch.settledAt && !watch.agentName && watch.launches === 0), `its decision watch settled with no session launched, and none is left supervised: ${JSON.stringify(laneWatches)}`);
  // The day held what it was meant to: a merge about every fifteen minutes, the rework rounds, the deaths,
  // the deploys, the split, both merge states, auto-merge, and the failover.
  assert.equal(github.merges.length, basePlan.items, 'fifteen items merged, each once');
  // The attested item's delivery carries its review rework round (GY-521 hosted it on the reworked
  // item), so the cadence reads the merges beside it, whose pace this assertion guards.
  const pace = github.merges.filter(entry => entry.key !== items[basePlan.attested - 1].key);
  const gaps = pace.slice(1).map((entry, index) => entry.at - pace[index].at).sort((a, b) => a - b);
  assert.ok(Math.abs(gaps[Math.floor(gaps.length / 2)] - 15 * minute) <= 5 * minute, `a merge about every fifteen minutes: ${github.merges.map(entry => `${entry.key} +${Math.round((entry.at - dayStart) / minute)} min`).join(', ')}`);
  assert.ok(github.merges.some(entry => entry.key === items[basePlan.clean - 1].key && entry.state === 'CLEAN' && entry.mode === 'immediate'), `a CLEAN pull request merged at once: ${JSON.stringify(github.merges)}`);
  assert.ok(github.merges.some(entry => entry.key === items[basePlan.unstable - 1].key && entry.state === 'UNSTABLE' && entry.mode === 'immediate'), 'an UNSTABLE pull request merged at once');
  assert.ok(github.merges.some(entry => entry.key === items[basePlan.slowRecompute - 1].key && entry.mode === 'auto-merge'), 'one GitHub reported BLOCKED when asked was set to auto-merge, and GitHub merged it once it recomputed');
  // GY-430: the auto-merge GitHub held BLOCKED past ten minutes was named by master status on every
  // cycle past the bound and on none after it merged; the six-minute recompute never was, and the
  // line is derived per read, one per item, so nothing about it accumulates over the day.
  const blockedKey = items[blockedMergeItem - 1].key, blockedLanding = github.merges.find(entry => entry.key === blockedKey);
  assert.equal(blockedLanding?.mode, 'auto-merge', `${blockedKey} was set to auto-merge while GitHub reported it BLOCKED: ${JSON.stringify(blockedLanding)}`);
  const blockedSightings = day.mergeStallSightings.filter(line => line.subject === blockedKey);
  assert.ok(blockedSightings.length >= Math.floor((blockedMergeMs - 10 * minute) / minute) - 1, `master status named ${blockedKey}'s BLOCKED auto-merge while it stood past ten minutes: ${blockedSightings.length} sighting(s)`);
  for (const line of blockedSightings) {
    assert.match(line.text, new RegExp(`^merge-stalled: ${blockedKey} pull request #\\d+ at [0-9a-f]{12} has been set to auto-merge for (\\d+) minutes .* while GitHub reports mergeStateStatus BLOCKED: .+`), line.text);
    assert.ok(Number(/for (\d+) minutes/.exec(line.text)![1]) >= 10 && line.at < blockedLanding!.at, `only past the bound and before the merge: ${line.text}`);
  }
  assert.equal(new Set(blockedSightings.map(line => line.at)).size, blockedSightings.length, 'one line per read, never repeated within one');
  assert.deepEqual(day.mergeStallSightings.filter(line => line.subject !== blockedKey).map(line => line.text), [], 'no other merge stood stalled; the six-minute recompute stayed under the bound');
  // GY-516's rerun-fails round counts too: with no merge queue to rebuild the flaky tip (GY-1235),
  // the rerun that fails again on the same sha returns the head to its worker once.
  assert.equal(final.reduce((total, item) => total + (item.pipeline?.reworkRounds ?? 0), 0), basePlan.rework.size + 1, 'three rework rounds from review and one for the rerun that failed again');
  assert.equal(final.find(item => item.key === items[basePlan.flaky.rerunFails - 1].key)?.pipeline?.reworkRounds, 1, 'the flaky head whose rerun failed again was reworked once');
  // GY-496 under GitHub delivery (GY-1235, GY-1331): proofs gate nothing and the loop requests no
  // producer for them, so a head whose producer runs are killed and then fail is still reviewed and
  // delivered as it stands, never held for its proofs or reworked over them. The killed runs still
  // spend no attempt and the runs stay bounded; the escalation and rework a spent request calls for
  // on an open head are unit-tested in tests/exhausted-proof-runtime.test.ts.
  const spentItem = final.find(item => item.key === items[basePlan.spentProducer - 1].key)!;
  assert.ok(spentHead && spentItem.stage === 'done' && spentItem.candidate?.sha === spentHead, `the head with no trusted evidence was delivered as it stood: ${spentHead} → ${spentItem.candidate?.sha}`);
  assert.equal(spentItem.pipeline?.reworkRounds ?? 0, 0, 'the head was never reworked over its proofs');
  assert.deepEqual(producerRuns.slice(0, basePlan.lostRuns).map(run => run.resolution?.startsWith(`${lostRunReason}: `) ? 'lost' : 'counted'), Array(Math.min(basePlan.lostRuns, producerRuns.length)).fill('lost'), 'the killed runs spent no attempt');
  assert.ok(producerRuns.length <= requestAttemptLimit, 'relaunches stay bounded per request');
  assert.deepEqual([...actionKeys].filter(key => key.startsWith(`decision:rework:${spentItem.id}:`)), [], 'no rework decision was requested for its proofs');
  assert.deepEqual([...actionKeys].filter(key => key.startsWith('escalation:proof-workflow:')), [], 'the trusted workflow was never spent');
  // GY-1118: the review-cap step runs on every open item every cycle of the day; no item passes its cap of three rounds, so it files, withdraws and escalates nothing.
  assert.deepEqual([...actionKeys].filter(key => /^(escalation:)?review-cap:/.test(key)), [], 'no review-cap action on a day whose items stay within the cap');
  assert.equal(sessions.filter(session => session.state === 'dead').length, basePlan.deaths.size, 'two workers died');
  // GY-756: the pull request merged by hand on GitHub was reconciled while its item recorded it
  // unlanded and delivered on the merge commit GitHub made; every peer a landing check named is
  // reconciled once, not re-observed on every cycle after. Under GitHub delivery no Graphyard tip
  // carries the hand merge into another candidate's head (GY-1235), so the item's own observation
  // reads the merge; a peer's landing check finding it is unit-tested in tests/landing-guard-ancestry.test.ts.
  const outOfQueue = items[basePlan.outOfQueue.item - 1].key;
  assert.ok(outside && github.merges.some(entry => entry.key === outOfQueue && entry.mode === 'outside' && entry.sha === outside.sha), `${outOfQueue} was merged by hand: ${JSON.stringify(github.merges)}`);
  assert.equal(final.find(item => item.key === outOfQueue)!.delivery?.mergeSha, outside!.sha, `${outOfQueue} was delivered on the merge made outside the queue`);
  assert.deepEqual(reconciled.filter((entry, index) => reconciled.indexOf(entry) !== index), [], `no landed peer was reconciled twice: ${reconciled.join(', ')}`);
  // Every dispatch the launcher settled was reported by a later cycle (GY-616): one dispatch-done
  // per session, none lost between the hand-off and the drain.
  assert.equal(reportedDispatches, sessions.length, 'each settled dispatch launch was reported to a cycle');
  assert.equal(production.deploys.length, basePlan.deploys.length, 'two production deploys');
  // GY-1385: after each verified deployment the loop itself recorded GY-87's throughput measurement
  // for the release the plane served, under one action per observed release. The plane's status
  // named each deploy only three minutes after the loop first asked: it waited on the backoff — a
  // handful of asks, one status read each, never one per cycle — and recorded once the release
  // served. GY-1438: a release left unverified is measured again as deliveries merge, each re-measure
  // at least throughputRemeasureMs after the one before, never once per cycle. Each measurement read
  // whole only the deliveries in its window, which grows with the day, never the ledger; master status
  // reads the newest back for the release serving.
  const { throughput } = day;
  const recorded = throughput.asks.filter(ask => ask.outcome === 'recorded');
  assert.deepEqual([...new Set(recorded.map(ask => ask.revision))], production.deploys.map(deploy => deploy.sha), `measurements of each deploy in turn, for the release the plane served: ${JSON.stringify(throughput.asks)}`);
  assert.deepEqual([...actionKeys].filter(key => key.startsWith('throughput:')).length, production.deploys.length + 1, 'one action per observed release: the day\'s first and each deploy');
  for (const deploy of production.deploys) {
    const asks = throughput.asks.filter(ask => ask.sha === deploy.sha), waits = asks.filter(ask => ask.outcome === 'waiting');
    assert.ok(waits.length >= 1 && waits.length <= 3, `the plane's lag was waited out on the backoff, not once per cycle: ${waits.length} waits for ${deploy.sha.slice(0, 12)} deployed at +${Math.round((deploy.at - dayStart) / minute)} min; asks: ${JSON.stringify(throughput.asks.map(ask => ({ ...ask, sha: ask.sha.slice(0, 8), revision: ask.revision?.slice(0, 8), elapsed: Math.round(ask.elapsed / minute) })))}`);
    assert.ok(waits.every(ask => ask.elapsed < throughput.firstAsk.get(deploy.sha)! - dayStart + throughput.statusLagMs), 'every wait fell inside the lag');
    const served = asks.slice(waits.length);
    assert.equal(served[0]?.outcome, 'recorded', `recorded once the release served: ${asks.map(ask => ask.outcome).join(', ')}`);
    assert.ok(served.every(ask => ask.outcome === 'recorded' || ask.outcome === 'current'), `after it served, only re-measures: ${asks.map(ask => ask.outcome).join(', ')}`);
    const measured = served.filter(ask => ask.outcome === 'recorded');
    for (let index = 1; index < measured.length; index++) assert.ok(measured[index].elapsed - measured[index - 1].elapsed >= throughputRemeasureMs,
      `re-measures of ${deploy.sha.slice(0, 12)} at least ${throughputRemeasureMs / minute} min apart: ${measured.map(ask => Math.round(ask.elapsed / minute)).join(', ')} min`);
  }
  assert.ok(throughput.statusReads <= throughput.asks.length, 'at most one status read per ask');
  assert.ok(recorded.every(ask => ask.read >= 1 && ask.read <= github.merges.filter(entry => entry.at <= dayStart + ask.elapsed).length), 'each measurement read whole at most the deliveries merged so far');
  assert.ok(recorded[1].read > recorded[0].read, `the second measurement read the grown window: ${recorded.map(ask => ask.read).join(' then ')}`);
  const visible = await throughputStatus(throughput.root, { release: { version: '0.9.1', revision: production.sha } }, final);
  assert.equal(visible.measurement?.deployedRevision, production.sha, 'master status reads the measurement of the release serving');
  assert.doesNotMatch(visible.reason, /no post-deploy measurement has ever been recorded|the release now serving is/, visible.reason);
  assert.ok(visible.verdict === 'verified' ? visible.shortfall === null : visible.shortfall !== null || /deliver/i.test(visible.reason), `verified, or the shortfall named: ${visible.verdict}: ${visible.reason}`);
  assert.ok(final.find(item => item.key === items[basePlan.split.item - 1].key)!.plannedFiles.includes(`src/soak/item-${basePlan.split.item}-a.ts`), 'the split file re-planned its item onto the successors');
  const reviewed = final.find(item => item.key === items[basePlan.exhaustedReviewer - 1].key)!;
  assert.ok(reviewed.reviewFailovers?.some(failover => failover.profile === 'claude-reviewer' && failover.exhaustion === 'usage-limit' && failover.nextProfile === 'cursor-reviewer'), `the exhausted reviewer bot failed over to the next profile: ${JSON.stringify(reviewed.reviewFailovers)}`);
  // The base failure (GY-528): the candidate its window caught was held without rework — the rework
  // decisions above are the reviewers' three and the spent producer's — one P0 item names it, and
  // once main was repaired its failed job was rerun once and it was refreshed onto the repaired
  // base once, then delivered. The window is sized to hold the one push that lands inside it (see
  // the plan comment); that several candidates share one item is the unit test's assertion.
  const [filed, ...more] = baseFailure.filed;
  assert.ok(filed && !more.length, `one P0 item for the failing test: ${baseFailure.filed.map(item => item.key).join(', ')}`);
  assert.equal(filed.priority, 0);
  const blocked = final.filter(item => item.baseRefresh?.trigger === 'base failure repaired').map(item => item.key).sort();
  assert.ok(blocked.length >= 1 && blocked.every(key => filed.description.includes(`${key} (`)), `the base failure blocked the window's candidate(s), which its item names: ${blocked.join(', ')}; ${filed.description}`);
  assert.deepEqual([...baseFailure.refreshes].sort(), blocked, 'each blocked candidate was refreshed onto the repaired base, once, by a Graphyard-authored merge');
  // Each blocked candidate's failed job was rerun by the loop's remedy step exactly once — the
  // engine's own first check-rerun (GY-516) may have run beside it, on superseded heads too.
  const loopReruns = github.baseReruns.filter(entry => entry.by === 'loop').map(entry => entry.jobId);
  assert.ok(new Set(loopReruns).size === blocked.length && loopReruns.length === blocked.length, `each blocked job rerun once by the loop's remedy: ${JSON.stringify(github.baseReruns)}`);
  assert.deepEqual(Object.keys(state.baseFailures), [], 'the base failure retired once its candidates were refreshed');
  // Distinct items: the low-lane rework (GY-883) is refused once at apply and requested again.
  assert.deepEqual([...new Set(decideCalls.filter(call => call.action === 'rework').map(call => call.key))].sort(),
    items.filter((_, index) => basePlan.rework.has(index + 1) || index + 1 === basePlan.flaky.rerunFails).map(item => item.key).sort(),
    'the only rework decisions are the reviewers\' three and the failed rerun\'s — no base-failure blocked candidate was sent back');
  // GY-500: disjoint items merged optimistically and infrastructure changes queued; the one that
  // broke main was reverted head-bound within one CI duration of its failing post-merge run, and
  // The docs-only conflict went to one docs-sync session, not a worker: its push was adopted as the
  // refresh's outcome with the approval kept, the session was closed, and the loop's records of it are bounded.
  const conflicted = items[basePlan.docsConflict.item - 1].key;
  assert.deepEqual(docsSyncRuns.map(run => [run.plan.key, run.plan.paths, run.outcome]), [[conflicted, [basePlan.docsConflict.page], 'pushed']], 'one docs-sync session resolved the conflict');
  assert.deepEqual(state.conflicts.map(entry => [entry.work, entry.route, entry.paths]), [[conflicted, 'docs-sync', [basePlan.docsConflict.page]]], 'the conflict is logged for the hotspot report as docs-synced');
  const adopted = Object.entries(state.actions).filter(([key]) => key.endsWith(':docs-sync')).map(([, action]) => action);
  assert.ok(adopted.length === 1 && /a docs-sync session brought .* with no rework round; kept [^;]*approval/.test(adopted[0].detail), `the synced head was adopted with the approval kept: ${JSON.stringify(adopted)}`);
  assert.equal(final.find(item => item.key === conflicted)!.pipeline?.reworkRounds ?? 0, 0, 'the docs conflict cost no rework round');
  assert.deepEqual(herdr.list().filter(agent => /docs-sync/.test(agent.name ?? '')), [], 'no docs-sync session is left open');
  assert.ok(docsSyncRuns.every(run => herdr.closed.includes(run.pane)), 'the loop closed the docs-sync session it launched');
  assert.ok(Object.values(state.docsSyncs).every(watch => watch.settledAt) && Object.keys(state.docsSyncs).length <= docsSyncRuns.length, `every docs-sync record settled, and none accumulate: ${JSON.stringify(state.docsSyncs)}`);
  // GY-1433: under a root with project settings each launch wrote a role file, and each settle removed it.
  const roleFiles = (() => { try { return readdirSync(join(docsSyncRoot, '.graphyard', 'harness')); } catch { return []; } })();
  assert.ok(docsSyncRuns.length > 0 && docsSyncRuns.every(run => run.roleFile?.startsWith(join(docsSyncRoot, '.graphyard', 'harness', 'docs-sync-'))), 'each docs-sync launch wrote its role file');
  assert.ok(roleFiles.every(file => !file.startsWith('docs-sync-')), `no docs-sync role file outlives its settled session: ${roleFiles.join(', ')}`);
  // GY-711: the doctor fired from the real cycle on its ten-minute interval across the day — the
  // cursor holds its recent runs (all reported), the ledger holds every summary the loop posted,
  // and the scripted finding reached the run record it belongs to.
  const postedDoctorRuns = Number((await store.pool.query(`SELECT count(*) AS n FROM events WHERE kind = $1 AND created_at >= $2`, [doctorRunEvent, new Date(dayStart).toISOString()])).rows[0].n);
  assert.ok(postedDoctorRuns >= Math.floor(Number(process.env.SOAK_HOURS ?? 24) * 2), `the doctor ran on its interval through the day: ${postedDoctorRuns} summaries on the ledger`);
  assert.ok(state.doctor.runs.length > 0 && state.doctor.runs.every(entry => entry.state === 'reported'), 'every doctor run the cursor retains reported');
  assert.ok(state.doctor.runs.some(entry => entry.findings.some(finding => finding.subject === items[0].key && finding.check === 'worker')), 'the doctor report applied: its finding is on the run record');
  // GY-711, AC-3: the two per-item remedies the loop applies without an agent fired in the real
  // cycle across the day, each exactly once, and nothing repeated after. The fenced item's reclaim
  // settle was failed by the control plane; whichever settles it next — the reclaim step's own retry
  // (GY-1155) or the doctor's settle remedy — lowers the fence once and the other never repeats it.
  // The covered scope-refusal blocker was cleared once, at the revision the loop read.
  const { remedies } = day, remedied = items[remedyItem - 1], remedyFinal = final.find(item => item.id === remedied.id)!;
  const remedyActions = (name: string) => Object.entries(state.actions).filter(([key]) => key.startsWith(`remedy:${name}:${remedied.id}:`)).map(([, action]) => action);
  assert.deepEqual(remedies.settles, [{ key: remedied.key, ok: false }, { key: remedied.key, ok: true }], 'the fence was settled twice in all: the reclaim step\'s refused call, then the remedy\'s one successful call');
  const settledBy = [...remedyActions('settle'), ...Object.entries(state.actions).filter(([key]) => key.startsWith(`settle:${remedied.id}:`)).map(([, action]) => action)];
  assert.deepEqual(settledBy.filter(action => action.state === 'done').length, 1, `one settle action lowered the fence: ${JSON.stringify(settledBy)}`);
  assert.equal(remedyFinal.containmentQuarantine ?? null, null, 'the submitted attempt\'s lapsed fence is settled');
  assert.deepEqual(remedies.unblocks, [{ key: remedied.key, revision: remedies.unblocks[0]?.revision }], 'the covered scope-refusal blocker was cleared exactly once');
  assert.deepEqual(remedyActions('unblock').map(action => `${action.state} x${action.attempts}`), ['done x1'], 'the unblock remedy applied once, on its first attempt');
  assert.ok(!remedyFinal.blocker, 'the cleared blocker never came back');
  // The loop published its merge settings exactly once for the whole day — on a change, not every
  // cycle (GY-516) — and the setting reached the installation ledger.
  assert.equal(mergeQueuePosts.length, 1, `one publication, not one per cycle: ${JSON.stringify(mergeQueuePosts)}`);
  assert.deepEqual(mergeQueuePosts[0].settings, { rerunFailedChecks: 1 });
  const published = await store.pool.query(`SELECT kind, payload FROM events WHERE kind LIKE 'merge-queue.%' AND created_at >= $1 ORDER BY seq`, [new Date(dayStart).toISOString()]);
  assert.deepEqual(published.rows.map(row => [row.kind, row.payload.previous]), [['merge-queue.rerun-failed-checks', null]], `the setting recorded once: ${JSON.stringify(published.rows)}`);
  // GY-516: each flaky head was rerun exactly once.
  const flaky = { passes: items[basePlan.flaky.rerunPasses - 1].key, fails: items[basePlan.flaky.rerunFails - 1].key };
  const baseKey = items[basePlan.baseBreak.item - 1].key;
  assert.deepEqual(github.reruns.map(entry => entry.key).sort(), [baseKey, ...Object.values(flaky)].sort(), `one rerun per flaky head and one for the candidate built against the broken base: ${JSON.stringify(github.reruns)}`);
  const passed = github.reruns.find(entry => entry.key === flaky.passes)!, failed = github.reruns.find(entry => entry.key === flaky.fails)!;
  // The head whose rerun passed is what landed, and the flake cost it no rework round.
  assert.ok(github.contains(github.merges.find(entry => entry.key === flaky.passes)!.sha, passed.sha), 'the head whose rerun passed is what landed');
  assert.equal(final.find(item => item.key === flaky.passes)!.pipeline?.reworkRounds ?? 0, 0, 'a flake whose rerun passed costs no rework round');
  assert.ok(!github.contains(github.merges.find(entry => entry.key === flaky.fails)!.sha, failed.sha), 'what landed for the item whose rerun failed is not the failed head');
  // GY-793: the candidate whose required check failed only because main was briefly broken while
  // its worker pushed was refreshed onto the tip that fixed the breakage — once, with the breakage
  // named on the record — and delivered with no rework round, no rework decision and no worker
  // round of any kind: the failure the base caused asked nobody for a new head.
  const baseBreakItem = final.find(item => item.key === baseKey)!;
  const ledger = async (kind: string) => (await store.pool.query(`SELECT kind, work_id, payload->'details' AS details, created_at FROM events WHERE kind LIKE $1 AND created_at >= $2 ORDER BY seq`, [kind, new Date(dayStart).toISOString()])).rows;
  const keyOf = (workId: string) => final.find(item => item.id === workId)?.key;
  const refreshed = baseBreakItem.baseRefresh!;
  assert.equal(refreshed.trigger, 'base breakage', `the refresh names why the control plane touched the branch: ${JSON.stringify(baseBreakItem.baseRefresh)}`);
  assert.equal(refreshed.baseBreak!.builtOn, baseBreak.broken, 'the record names the commit that broke the base');
  assert.equal(refreshed.baseBreak!.fixedBy, baseBreak.fixed, 'the record names the tip that fixed it');
  assert.deepEqual(refreshed.baseBreak!.checks, [{ check: 'test', tests: [brokenBaseTest] }], 'the record names the failing test the base caused');
  const refreshedLedger = (await ledger('base.refreshed')).filter(row => keyOf(row.work_id) === baseKey);
  assert.equal(refreshedLedger.length, 1, `exactly one base-breakage refresh for ${baseKey}: ${JSON.stringify(refreshedLedger)}`);
  assert.equal(refreshedLedger[0].details.trigger, 'base breakage', `the ledger records the trigger: ${JSON.stringify(refreshedLedger)}`);
  assert.ok(github.contains(baseBreakItem.delivery!.mergeSha, refreshed.head!), 'the item delivered on the head the refresh published');
  assert.ok(github.contains(github.merges.find(merge => merge.key === baseKey)!.sha, baseBreak.fixed!), `${baseKey} landed on the fixed tip`);
  assert.equal(baseBreakItem.pipeline?.reworkRounds ?? 0, 0, 'the base breakage cost no rework round');
  assert.ok(!decideCalls.some(call => call.key === baseKey && call.action === 'rework'), 'no rework decision was requested for the base-break item');
  // GY-839: the landing check ran in the loop all day, over bases that moved under open candidates.
  // The three-way comparison from the merge base is what a candidate bound behind the tip was
  // judged by, and the fault window's blind answers are the only source of false landing refusals
  // the day has. Each held only the build gate and cleared on the exact head it named, before any
  // worker could react: no ejection, no sync round, no rework.
  assert.ok(github.landingChecks > 0, 'the landing check ran during the simulated day');
  assert.ok(github.landingBases.size >= basePlan.items, `the landing check judged moving bases (${github.landingBases.size})`);
  assert.ok(github.ancestorCompares > 0, `candidates bound behind the tip were compared from their merge base (${github.ancestorCompares} ancestor compares)`);
  assert.ok(github.blindCompares > 0, `the fault window answered compares without a usable merge base (${github.blindCompares} blind compares)`);
  // Every head the window answered blind was bound behind the tip, and each was caught: its false refusal is recorded.
  assert.ok(github.blindHeads.size >= 1 && [...github.blindHeads].every(head => landingRefusals.some(entry => entry.sha === head)), `the fault window caught every candidate bound behind it (${JSON.stringify(landingRefusals)}; blind: ${[...github.blindHeads].join(', ')})`);
  assert.ok(landingRefusals.every(entry => entry.elapsed >= basePlan.blind.from - minute && entry.elapsed <= basePlan.blind.to + minute),
    `a false landing refusal stood only inside the fault window: ${JSON.stringify(landingRefusals)}`);
  for (const entry of landingRefusals) {
    const landed = github.merges.find(merge => merge.key === entry.key);
    assert.ok(landed && github.contains(landed.sha, entry.sha), `${entry.key} landed the exact head its false refusal named (${entry.sha.slice(0, 12)})`);
  }
  assert.ok(sessions.every(session => session.syncs === 0), 'no worker was woken to sync what was never wrong');
  // GY-612: the host's memory dipped below its floor mid-morning and recovered. No worker launched
  // while it stood, the crossing is recorded once each way, and one memory-pressure fault stands
  // for the whole dip even though the consumers' ranking moved between cycles.
  const memory = state.actions[memoryActionKey];
  assert.ok(memory, 'the memory crossing was recorded');
  assert.equal(memory.attempts, 2, 'one record on the way down, one on the way back up');
  assert.match(memory.detail, /^Launches resumed: /, 'the last crossing recorded is the resumption');
  const during = (at: number) => { const elapsed = at - dayStart; return elapsed >= memoryDay.memoryDip.from && elapsed < memoryDay.memoryDip.until; };
  assert.deepEqual(launches.filter(during).map(at => new Date(at).toISOString()), [], 'no worker launched while the host was below its floor');
  assert.ok(launches.some(at => at - dayStart >= memoryDay.memoryDip.until), 'launching resumed once memory recovered');
  assert.equal(state.faults.instances.filter(instance => instance.kind === 'memory-pressure').length, 1, 'one memory-pressure fault stands for the whole dip');
  // GY-887: the landability verdict rode every observation as the one `graphyard/landable` run per
  // head, written only when the verdict changed, at a bounded request cost, and every head GitHub
  // merged carried its success.
  const landableHeads = [...github.landable.entries()];
  const landableRequests = (kind: string) => github.landableRequests.filter(request => request.kind === kind).length;
  assert.ok(landableHeads.length >= basePlan.items, `every candidate head carried the landability verdict (${landableHeads.length} heads)`);
  assert.deepEqual(landableHeads.filter(([, runs]) => runs.length !== 1).map(([head]) => head), [], 'one standing graphyard/landable run per head, updated in place');
  assert.deepEqual(landableHeads.filter(([, runs]) => runs[0].writes > 5).map(([head, runs]) => `${head.slice(0, 12)} ${runs[0].writes}`), [], 'no head is rewritten in a loop: only a changed verdict is written');
  assert.equal(landableRequests('post'), landableHeads.length, 'each head\'s run was created once');
  assert.ok(github.landableRequests.length <= 2 * cycles, `publishing the verdict costs a bounded number of requests (${github.landableRequests.length} over ${cycles} cycles)`);
  for (const merge of github.merges) {
    const head = github.prs.get(merge.pr)!.head;
    assert.equal(github.landable.get(head)?.[0]?.body.conclusion, 'success', `${merge.key}'s merged head ${head.slice(0, 12)} carried a landable success`);
  }
  // The diagnostician (GY-439) rode the same day. The three held-job windows recur past the
  // threshold, so the loop files the class's one recurring item and diagnoses it within the cycle
  // that files it, and the day's own churn (the dead workers' leases, the delivery budget) recurs
  // into further classes beside it. Every filed item is diagnosed once, never relaunched per
  // cycle, and closed as a duplicate of the open item its diagnosis named, on the approved
  // two-party decision, with its approver session closed once the decision settled.
  const filedFaultItems = (await store.list()).filter(item => item.origin?.faultClass);
  assert.ok(filedFaultItems.length >= 1, `the day filed recurring-fault items: ${filedFaultItems.map(item => `${item.key} (${item.origin!.faultClass!.class})`).join(', ')}`);
  assert.deepEqual(Object.keys(state.diagnoses).sort(), filedFaultItems.map(item => item.key).sort(), 'one diagnosis per filed item, none relaunched per cycle');
  const byKey = new Map(filedFaultItems.map(item => [item.key, item]));
  for (const [subject, diagnosis] of Object.entries(state.diagnoses)) {
    const item = byKey.get(subject)!;
    assert.ok(diagnosisSettled(diagnosis), `${subject}'s diagnosis settled: ${diagnosis.state} ${diagnosis.detail}`);
    assert.equal(diagnosis.kind, 'recurring');
    assert.equal(diagnosis.faultClass, item.origin!.faultClass!.class);
    assert.equal(item.stage, 'done', `${subject} was closed on its diagnosis`);
    assert.deepEqual([item.closure?.kind, item.closure?.ref], ['duplicate', diagnosis.answeredBy], `${subject} was closed as the duplicate of the item its diagnosis answered it with`);
    if (diagnosis.state === 'answered') {
      assert.ok(diagnosis.diagnosis!.covering, `${subject}'s diagnosis named an open item as covering the cause`);
      assert.equal(diagnosis.answeredBy, diagnosis.diagnosis!.covering);
      assert.ok(diagnosis.decision && diagnosis.decision.action === 'close' && diagnosis.decision.approver, `${subject}'s closure rode an approved two-party decision with an independent approver`);
    }
  }
  // The injected class, end to end: three instances in the window, one item, one primary run,
  // every instance linked to it, and no fix item filed for a covering diagnosis.
  const heldJobs = state.faults.instances.filter(entry => entry.kind === 'held-jobs');
  assert.equal(heldJobs.length, basePlan.heldJob.at.length, `one instance per held-job window: ${JSON.stringify(heldJobs.map(entry => entry.at))}`);
  const configuration = filedFaultItems.filter(item => item.origin!.faultClass!.class === 'configuration');
  assert.equal(configuration.length, 1, 'the held-job class filed exactly one recurring item');
  const configurationKey = configuration[0].key, configurationDiagnosis = state.diagnoses[configurationKey];
  assert.ok(heldJobs.every(entry => entry.linkedTo === configurationKey), 'every held-job instance links to the recurring item, so none files again');
  assert.equal(configurationDiagnosis.state, 'answered', `the held-job diagnosis was answered: ${configurationDiagnosis.detail}`);
  assert.deepEqual(configurationDiagnosis.runs.map(entry => [entry.model, entry.result]), [[diagnosisModel, 'diagnosed']], 'one primary run diagnosed it, no fallback needed');
  assert.ok(!(await store.list()).some(item => /Filed by the master loop from the diagnostician's diagnosis/.test(item.description ?? '')), 'the covering diagnoses filed no fix item');
  // GY-1092: the diagnostician's provider was spent for the day's first hours, naming no reset. The
  // loop filed no loop fault for it, launched nothing while the hold stood, probed the provider with
  // one subject per hold window, and once the provider answered ran every waiting subject once more.
  const refusedRuns = diagnosisRuns.filter(run => run.refused), primaries = diagnosisRuns.filter(run => run.attempt === 'primary');
  assert.ok(refusedRuns.length >= 2, `the provider refused the day's first diagnoses: ${JSON.stringify(diagnosisRuns.slice(0, 6))}`);
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'action:diagnosis').map(entry => entry.text), [], 'a provider limit files no loop fault');
  for (const [index, run] of primaries.entries()) {
    if (!run.refused) continue;
    const next = primaries.slice(index + 1).find(later => later.at > run.at);
    if (next) assert.ok(next.at - run.at >= diagnosisLimitHoldMs, `no diagnosis launched ${Math.round((next.at - run.at) / minute)} min after a refusal, inside the hold: ${next.subject}`);
  }
  const window = diagnosisLimit.to - (refusedRuns[0].at - dayStart);
  assert.ok(primaries.filter(run => run.refused).length <= Math.ceil(window / diagnosisLimitHoldMs) + 1, `one probe per hold window while the provider is spent: ${primaries.filter(run => run.refused).length}`);
  for (const subject of new Set(primaries.map(run => run.subject))) {
    const own = primaries.filter(run => run.subject === subject);
    assert.ok(own.length <= own.filter(run => run.refused).length + 1, `${subject} was run again once per refusal, no more: ${own.length} launches`);
    assert.equal(own.at(-1)!.refused, false, `${subject} was run again once the provider answered`);
  }
  const answered = primaries.find(run => !run.refused)!;
  assert.deepEqual([...new Set(primaries.filter(run => run.at < answered.at).map(run => run.subject))], [refusedRuns[0].subject], 'only the probe ran until the provider answered: every other subject was held');
  assert.ok(Object.values(state.diagnoses).every(entry => entry.state !== 'waiting'), 'no diagnosis is left waiting at the day\'s end');
  // GY-1294: the first diagnosis decision went stale on a revision race — the loop's own note moved
  // the item before its approver read it. The loop asked again once, bound to the item as
  // it then stood; that request got exactly one approver, whose session was closed (above), it
  // applied, and nothing about the race is left owed at the day's end.
  assert.equal(diagnosisRaces.length, 1, `one diagnosis decision met the revision race: ${JSON.stringify(diagnosisRaces)}`);
  const [race] = diagnosisRaces;
  assert.match(race.outcome, /Task revision changed/, 'the approval found the item revision moved and was not applied');
  const raced = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent((await store.list()).find(item => item.key === race.key)!.id)}/decisions`)).decisions
    .filter((entry: { action: string }) => entry.action === race.action) as { id: string; state: string; input: { expectedRevision?: number } }[];
  assert.deepEqual(raced.map(entry => entry.state), ['stale', 'applied'], `${race.key}'s ${race.action} went stale once and its one re-request applied: ${JSON.stringify(raced)}`);
  assert.equal(raced[0].id, race.decision);
  assert.ok(raced[1].input.expectedRevision! > raced[0].input.expectedRevision!, 'the re-request binds the revision the item moved to');
  assert.equal(state.actions[`escalation:diagnosis-stale:${race.decision}`], undefined, 'the re-request stayed inside its bound: nothing was escalated');
  // GY-1318: the first diagnosis decide was refused at request time for the revision its item had
  // moved past; the loop reloaded it and asked again in the same step, so the refusal is no loop fault.
  assert.equal(diagnosisRequestRaces.length, 1, `one diagnosis decide met the request-time race: ${JSON.stringify(diagnosisRequestRaces)}`);
  assert.deepEqual(Object.values(state.actions).filter(action => action.kind === 'diagnosis' && action.state === 'failed' && /Task revision changed/.test(action.detail)).map(action => action.detail), [], 'the refused request failed no diagnosis action');
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'action:diagnosis' && /Task revision changed/.test(entry.text)).map(entry => entry.text), [], 'and opened no loop fault');
  assert.ok(Object.values(state.diagnoses).some(entry => entry.decision?.work === diagnosisRequestRaces[0].key && entry.decision.action === diagnosisRequestRaces[0].action), 'the diagnosis went on to request its decision at the current revision');
  const racedDiagnosis = Object.values(state.diagnoses).find(entry => entry.decision?.work === race.key && entry.decision.action === race.action)!;
  assert.ok(racedDiagnosis && racedDiagnosis.decision!.id === raced[1].id && racedDiagnosis.decision!.approver, 'the diagnosis follows the re-requested decision, judged by an independent approver');
  assert.equal(approverWorks.filter(key => key === race.key).length, 2, `${race.key} had one approver for the stale decision and one for its re-request: ${JSON.stringify(approverWorks)}`);
  const owed = await terminalDecisions(path => api(principals.operatorAgent, 'GET', path), await store.list(), { approvals: [], runtime: { available: false, agents: [] }, now: clock.now() });
  assert.deepEqual(owed.attentionItems.filter(entry => entry.subject === race.key || /went stale|is stale/.test(entry.text)).map(entry => entry.text), [], 'no stale decision is left owed at the day\'s end');
  assert.ok(approverPanes.length > 0, 'the day launched approver sessions for its decisions');
  assert.deepEqual(approverPanes.filter(pane => !herdrClosed.includes(pane)), [], `every approver session the day launched was closed once its decision settled: ${JSON.stringify(herdrClosed)}`);
  // GY-521 under GitHub delivery (GY-1235, GY-1331): proofs gate nothing, so the item whose manual
  // proof no producer may run is delivered on review and CI alone — no attestation is put to an
  // approver, and its merged head carried a landable success (asserted for every merge above).
  // The attestation decision itself is unit-tested in tests/unproduced-manual-attestation.test.ts.
  const attested = final.find(item => item.key === items[basePlan.attested - 1].key)!;
  assert.deepEqual(attestations, [], `no attestation was requested: ${JSON.stringify(attestations)}`);
  assert.ok(attested.stage === 'done' && !attested.evidence.some(entry => entry.proof === MANUAL), 'the attested item was delivered with its manual proof unproduced');
  assert.ok(cycles > 24 * 6, `the loop cycled through the day (${cycles} cycles)`);
  // The /tmp pass across the day (GY-421): never two in flight, never past its bound, and what it
  // takes is exactly what is stale and unheld.
  assert.equal(tmp.peak, 1, 'at most one /tmp pass is in flight, whatever the cycles do');
  assert.ok(tmp.passes.length > 1 && tmp.passes.every(pass => pass.removed.length <= tmpReclaimLimitPerCycle && pass.errors.length === 0), `every pass stays within its bound: ${tmp.passes.map(pass => pass.removed.length).filter(Boolean).join(', ')}`);
  assert.ok(tmp.backlog.every(directory => !existsSync(directory)), 'the backlog is cleared');
  assert.ok(tmp.passes.filter(pass => pass.removed.some(entry => tmp.backlog.includes(entry.path))).length >= 2, 'a backlog past the bound takes more than one pass');
  assert.ok(!existsSync(tmp.deadOwned) && !existsSync(`${tmp.deadOwned}.owner`), 'a dead run\'s directory goes at once, marker and all');
  assert.ok(existsSync(tmp.heldDirectory), 'a directory a live process holds open is kept all day');
  assert.ok(existsSync(tmp.liveOwned), 'a directory whose owner still runs is kept all day');
  if (hours > 7) assert.ok(!existsSync(tmp.cache), 'a tsx cache left unwritten for six hours goes');
  const aged = tmp.hourly.filter(entry => entry.at <= (hours - 7) * hour), young = tmp.hourly.filter(entry => entry.at >= (hours - 5) * hour);
  assert.deepEqual(aged.filter(entry => existsSync(entry.directory)).map(entry => entry.directory), [], 'each leftover goes once it is past six hours old');
  assert.deepEqual(young.filter(entry => !existsSync(entry.directory)).map(entry => entry.directory), [], 'no leftover goes before it is six hours old');
  const freed = tmp.passes.reduce((total, pass) => total + pass.bytes, 0), reported = tmp.reports.reduce((total, report) => total + report.tmp.bytes, 0);
  // The last pass may finish after the day's last cycle: its bytes are the next cycle's to record.
  const last = tmp.passes.at(-1)!.bytes;
  assert.ok(freed >= 1024 * (tmpReclaimLimitPerCycle + 20) && reported <= freed && reported >= freed - last, `the reclaim records carry the bytes the passes freed (${reported} of ${freed})`);
  assert.ok(tmp.reports.length <= 50, `the reclaim record stays bounded (${tmp.reports.length})`);
  assert.ok(Object.keys(state.actions).filter(key => key.startsWith('reclaim:resources:')).length <= tmp.passes.filter(pass => pass.removed.length).length, 'the loop records a reclaim only for a pass that freed something');
  // GY-437: the between-cycles self-upgrade ran after every cycle of the day. Each deploy aligned
  // the checkout once, and restarted the fleet and the loop once (every merge touches src/); the
  // dirty checkout across the second deploy was refused, untouched, without growing the cursor,
  // and aligned once it was clean again.
  const summary = `${upgrades.checkouts.map(entry => `+${Math.round((entry.at - dayStart) / minute)} min ${entry.from.slice(0, 7)}..${entry.to.slice(0, 7)}`).join(', ')}`;
  assert.equal(upgrades.outcomes.length + guardReads.refused, cycles, 'the checkout guard ran after every cycle, and the self-upgrade after every one it did not refuse');
  assert.equal(upgrades.checkouts.length, production.deploys.length, `one alignment per deploy: ${summary}`);
  assert.equal(upgrades.executors.length, production.deploys.length, 'one fleet restart per deploy');
  assert.equal(upgrades.self, production.deploys.length, 'one re-execution of the loop per deploy');
  assert.deepEqual(upgrades.executors, upgrades.checkouts.map(entry => entry.to), 'the fleet restarts against the tip the checkout moved to');
  assert.ok(upgrades.checkouts[1].at >= dayStart + basePlan.dirtyCheckout.to, `the second deploy aligned only once the checkout was clean: ${summary}`);
  const dirtySamples = refusalSamples.filter(sample => !sample.head), headSamples = refusalSamples.filter(sample => sample.head);
  assert.ok(dirtySamples.length >= 3, `the dirty checkout stood refused across the second deploy (${dirtySamples.length} cycles)`);
  assert.deepEqual(new Set(dirtySamples.map(sample => JSON.stringify(sample))).size, 1, `a standing refusal does not grow the cursor's actions: ${JSON.stringify(dirtySamples.slice(0, 3))}`);
  // GY-866: the per-cycle guard over the day. The HEAD moved by a session outside the loop stood
  // refused for the whole window — named with the commit the loop runs and the one it found —
  // without an alignment or a restart from it, and the loop's own alignments at each deploy never
  // read as drift. The guard reads Herdr only on a refused cycle, raises the one escalation row,
  // and grows its attempts only when what it names changes; clean and back at the commit it runs,
  // the attention is settled.
  assert.equal(guardReads.headMoves, 1, 'the day moved the HEAD once');
  assert.ok(headSamples.length >= 3, `the moved HEAD stood refused across its window (${headSamples.length} cycles)`);
  assert.equal(new Set(headSamples.map(sample => JSON.stringify(sample))).size, 1, `a standing HEAD refusal does not grow the cursor's actions: ${JSON.stringify(headSamples.slice(0, 3))}`);
  assert.ok([...guardReads.details].some(detail => detail.includes(`moved from `) && detail.includes(`to ${guardReads.foreignHead.slice(0, 12)}`)), 'the HEAD refusal names the commit the loop runs and the HEAD it found');
  assert.ok(!upgrades.checkouts.some(entry => entry.from === guardReads.foreignHead || entry.to === guardReads.foreignHead), 'nothing aligned from or to the moved HEAD');
  assert.equal(guardReads.refused, refusalSamples.length, 'every refused cycle is sampled');
  // A standing refusal reuses what it named: the plane and the Herdr inventory are read on each
  // change and at most every ten minutes while it stands, never once per refused cycle.
  assert.ok(guardReads.agents >= guardReads.transitions && guardReads.agents < guardReads.refused / 3, `the guard read the Herdr inventory on each change and seldom while a refusal stood (${guardReads.agents} read(s), ${guardReads.transitions} change(s), ${guardReads.refused} refused cycle(s))`);
  const guardEscalation = state.actions['escalation:dirty-checkout'];
  assert.ok(guardEscalation && guardEscalation.attempts >= 2 && guardEscalation.attempts <= guardReads.transitions, `the escalation's attempts grow only when what it names changes (${guardEscalation?.attempts} over ${guardReads.transitions} change(s), ${guardReads.refused} refused cycle(s))`);
  assert.equal(guardEscalation.state, 'done', 'the clean checkout back at the commit the loop runs settles the attention');
  assert.equal(Object.keys(state.actions).filter(key => key.startsWith('escalation:dirty-checkout')).length, 1, 'the guard keeps one escalation row');
  assert.equal(state.upgrade.refused, null, 'the refusal cleared with the alignment');
  assert.equal(state.upgrade.alignedRelease, production.deploys[1].sha, 'the loop stands aligned with the last deployed release');
  assert.equal(state.release?.commit, checkout.head, 'the re-executed loop reports the release the checkout holds');
  assert.ok(Object.keys(state.actions).filter(key => key.startsWith('upgrade:') && key !== 'upgrade:unit').length <= production.deploys.length + 1, `the cursor holds one upgrade action per deploy and one refusal: ${Object.keys(state.actions).filter(key => key.startsWith('upgrade:')).join(', ')}`);
  // GY-916: the first deploy's executor restart met a held claim. Each refused pass left the owed
  // restart pending on the cursor and its action waiting — never a failed action:config, so no
  // cycle failed — one attempt per pass, and the next pass after the claim settled completed it.
  assert.deepEqual(upgrades.held, Array(basePlan.heldClaimRestarts).fill(upgrades.checkouts[0].to), 'the restart was refused only on the first deploy, against its tip');
  assert.equal(upgrades.outcomes.filter(outcome => outcome === 'pending').length, basePlan.heldClaimRestarts, 'one pending pass per refusal');
  assert.deepEqual(upgrades.owed.map(sample => sample.to), upgrades.held, 'the owed restart stood on the cursor against the moved tip');
  assert.ok(upgrades.owed.every(sample => sample.state === 'waiting'), `the owed restart is waiting, not failed: ${JSON.stringify(upgrades.owed)}`);
  assert.deepEqual(upgrades.owed.map((sample, index) => sample.attempts - upgrades.owed[0].attempts), upgrades.owed.map((_, index) => index), 'one attempt per refused pass, never more');
  const firstRelease = production.deploys[0].sha;
  assert.equal(state.actions[`upgrade:${firstRelease}`]?.state, 'done', 'the owed restart converged: the first deploy\'s action ends done');
  assert.equal(state.actions[`upgrade:${firstRelease}`]?.attempts, upgrades.owed.at(-1)!.attempts + 1, 'and the pass that completed it is its last attempt');
  // (The dirty checkout's standing refusal, `upgrade:refused`, is its own record and is not one of these.)
  const restartFaults = Object.entries(state.actions).filter(([key, action]) => (/^upgrade:[0-9a-f]{40}$/.test(key) || key === 'upgrade:unit' || key.startsWith('escalation:watchdog:')) && action.state === 'failed');
  assert.deepEqual(restartFaults.map(([key]) => key), [], 'no restart, unit or watchdog fault stands at the end of the day');
  // GY-916: the drifted watchdog window was refused once at the first process start, not again at
  // the supervisor's own restarts or on any cycle, and cleared by the first alignment's re-applied unit.
  assert.equal(upgrades.unit.rewrites, 1, 'the unit was rewritten once, at the first alignment');
  assert.equal(state.actions['upgrade:unit']?.state, 'done');
  assert.equal(upgrades.starts, 1 + basePlan.loopRestarts.length + production.deploys.length, 'every process start judged the window');
  const drifted = upgrades.watchdog.filter(sample => sample.windowSec === basePlan.driftedWatchdogSec), aligned = upgrades.watchdog.filter(sample => sample.windowSec !== basePlan.driftedWatchdogSec);
  assert.ok(drifted.length > basePlan.loopRestarts.length && aligned.length > 0, 'the day ran under both units');
  assert.ok(drifted.every(sample => sample.failed === 1 && sample.attempts === 1), `under the drifted unit the refusal stood once, across restarts and cycles: ${JSON.stringify(drifted.slice(0, 3))}`);
  assert.ok(aligned.every(sample => sample.failed === 0 && sample.windowSec === loopWatchdogSeconds(soakConfig.run.intervalSeconds)), 'under the re-applied unit the refusal is cleared, every cycle after');
  // GY-842 across the day: every pane the day's launches opened went somewhere — closed once, by
  // the step that ended its session or by the bounded sweep — the operator's own pane was never
  // touched, the previous day's backlog drained over successive bounded passes, and the drain
  // itself is what stands on the cursor.
  assert.equal(new Set(herdr.closed).size, herdr.closed.length, `no pane was closed twice: ${herdr.closed.join(', ')}`);
  assert.ok(!herdr.closed.includes(foreignPane), 'the pane Graphyard never launched is never closed');
  const reclaimed = herdr.closed.filter(pane => pane.includes(':left'));
  assert.equal(reclaimed.length, basePlan.leftovers, 'every leftover pane of the previous day is reclaimed');
  const passes = [...new Set(reclaimed.map(pane => herdr.closedAt.get(pane)))];
  assert.ok(passes.length >= 2, `the backlog drained over successive passes, not in one burst (${passes.length})`);
  // The bound paces every pass: however the backlog interleaves with the day's other panes, no
  // pass carries more than the bound of the leftovers, and the backlog takes several passes.
  const perPass = [...new Set(reclaimed.map(pane => herdr.closedAt.get(pane)))].map(at => reclaimed.filter(pane => herdr.closedAt.get(pane) === at).length);
  assert.ok(perPass.every(count => count <= paneSweepLimit), `a pass closes at most the bound of ${paneSweepLimit} (${perPass.join(', ')})`);
  const sweepStatus = state.actions['sweep:panes:status'];
  assert.match(sweepStatus?.detail ?? '', /0 standing agentless; the backlog has drained/, `the drain is what stands on the record (${sweepStatus?.detail?.slice(0, 200)})`);
  assert.doesNotMatch(sweepStatus?.detail ?? '', /the oldest is pane/, 'no oldest pane outlives the drained day');
  assert.ok(!state.actions['sweep:panes:attention'], 'the day never stood past the agentless attention bound');
  // GY-980 across the day: the previous day's worktree shells — unrecorded, or whose handle stayed
  // 'running' — and its ended sessions' idle agents were each closed once, within the hour, while
  // no step closed a pane whose worker's attempt held a live lease.
  assert.equal(previousWorktrees.length, 3 * basePlan.worktreeLeftovers);
  assert.deepEqual(previousWorktrees.filter(pane => !herdr.closed.includes(pane)), [], 'every worktree shell and idle ended agent of the previous day is closed');
  assert.deepEqual(previousWorktrees.filter(pane => herdr.closedAt.get(pane)! - dayStart > hour), [], 'and within the hour');
  const sweptAs = (pattern: RegExp) => previousWorktrees.filter(pane => pattern.test(state.actions[`sweep:pane:${pane}`]?.state === 'done' ? state.actions[`sweep:pane:${pane}`].detail : ''));
  assert.deepEqual(sweptAs(/no Graphyard session recorded it/), previousWorktrees.filter(pane => /:tree\d+$/.test(pane)), 'the sweep closed every unrecorded worktree shell');
  assert.deepEqual(sweptAs(/still recorded running/), previousWorktrees.filter(pane => /:stuck\d+$/.test(pane)), 'the sweep closed every shell whose handle stayed running');
  assert.ok(sweptAs(/still holds its claude agent/).length > 0, 'the sweep closed the ended sessions\' idle agents');
  assert.deepEqual(closedLeased, [], 'no pane was closed while its worker\'s attempt held a live lease');
  // The sweep's sightings are reaped with their panes: no `sweep:pane:*` row stays waiting for a
  // pane that no longer stands, so the cursor does not grow by one row per ended session.
  const standingPanes = new Set(herdr.paneList().map(pane => pane.pane_id));
  assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('sweep:pane:') && state.actions[key].state === 'waiting' && !standingPanes.has(key.slice('sweep:pane:'.length))), [],
    'no sweep sighting stays waiting for a pane that is gone');
  // GY-544: every scope decision made between two cycles earned exactly one re-prompt for its attempt, and nothing else re-prompted it.
  assert.equal(decided.length, basePlan.scoped.size, 'scope requests were asked and decided between cycles');
  for (const attempt of decided) {
    const [key, epoch] = attempt.split(':');
    const told = prompts.filter(prompt => prompt.key === key && prompt.epoch === Number(epoch) && /its scope request was applied/.test(prompt.text));
    assert.equal(told.length, 1, `${attempt}: one re-prompt for its scope decision: ${JSON.stringify(prompts)}`);
  }
  assert.equal(prompts.length, decided.length, `no prompt beyond one per scope decision: ${JSON.stringify(prompts.map(prompt => prompt.text.slice(0, 200)))}`);
  // Herdr's misreads closed no live session; the pane whose runtime exited was closed as exited; no sighting outlived its handle.
  assert.equal(misreads.length, basePlan.misread.size, 'two live panes were misread for a cycle');
  assert.deepEqual(exitedLive, [], 'no implementation handle was closed as exited while its agent was live');
  for (const n of basePlan.exits) assert.ok(exitedClosed.some(entry => entry.startsWith(`${items[n - 1].key} `)), `${items[n - 1].key}: the handle of the worker whose runtime exited was closed as exited: ${exitedClosed.join(', ')}`);
  assert.ok(exitedRowsSeen > 0, 'the loop recorded exited-session sightings during the day');
  assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('exited:implementation:')), [], 'no exited-session sighting outlives the day');
  assert.deepEqual(final.flatMap(item => (item.sessions ?? []).filter(handle => handle.kind === 'implementation' && handle.state === 'running').map(handle => `${item.key} ${handle.id}`)), [], 'every implementation handle is closed once its item is delivered');
  const seconds = (performance.now() - began) / 1000;
  assert.ok(seconds < 120, `the day runs well inside the six minutes its case timeout allows it (${seconds.toFixed(1)} s)`);
});

test('unit:soak-invariants-hold — the documentation budget under the real loop: a base inside the 3% warning files the trim item once across the day, the items growing the pages are delivered under the project\'s own budget check, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-574, over the real observer and the real word counting: the base sits at 11,985 of a
  // 12,000-word budget (inside the 3% warning), four items grow the pages, and the day is judged on
  // what the loop and the gates do about it.
  const { items, final, violations, failures, lost, docsFilings, docsActions, closedTrim, state } =
    await simulateDay({ hours: 4, docs: { budget: { total: 12_000, perPage: 1_200 } },
      plan: { items: 4, releaseEveryMs: 10 * minute, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } } });
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  // Headroom: the saturated base filed the trim item once, the day closed it with the docs still
  // saturated, and the filing episode — not the open item — is what kept it to one.
  assert.ok(closedTrim, 'the trim item was filed and then closed with the documentation still saturated');
  assert.equal(docsFilings.length, 1, `exactly one filing across the day: ${JSON.stringify(docsFilings)}`);
  assert.ok(docsActions.length <= 4, `a bounded number of loop actions for ${docsTrimActionKey} (${docsActions.length}): ${JSON.stringify(docsActions)}`);
  assert.equal(docsActions.filter(action => action.state === 'done').length, 1, 'the one filing is the one done action');
  assert.match(state.actions[docsTrimActionKey]?.detail ?? '', /^Filed /, 'the filing stands as the open episode on the loop cursor');
  // Every item that grew the pages required the project's docs-budget check and was delivered on it.
  for (const item of items) {
    const delivered = final.find(entry => entry.key === item.key)!;
    assert.equal(delivered.stage, 'done', `${item.key} is delivered`);
    assert.ok(delivered.observation?.checks.some(run => run.name === 'unit:docs-word-budget' && run.result === 'success'), `${item.key} passed the docs-budget check`);
  }
});

test('unit:soak-invariants-hold — a loop change that breaks an invariant fails the soak: approver and docs-sync sessions the loop no longer closes are named within the hour', { timeout: 600_000 }, async () => {
  // The regression GY-403 was: approvers finished, nobody closed them. Here the loop's close reports
  // success and closes nothing, which no per-item gate of any change would notice; the same for the
  // docs-sync session of the day's docs-only conflict (GY-566).
  // The day runs beside the shard's other files, so its wall clock is the machine's, not the loop's:
  // with six day-simulations in the file this is the slowest day per simulated hour (lingering
  // approver sessions pile up all day), and CI measured it past the old 120s budget while the
  // simulated hour held, so its budget is sized like the other days' — about twice its measured
  // run (GY-630).
  // Five hours: the default plan's rerun-fails item takes its real rework round since GY-1235 (see the stranded day).
  const day = await simulateDay({ hours: 5, regression: ['approvers-left-open', 'docs-syncs-left-open'] });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { violations, faulted, state, docsSyncRuns } = day;
  assert.ok(violations.some(line => /lingering-sessions: VIOLATED — .*approver session graphyard-approver-gy-\d+-/.test(line)), `the soak names the lingering approver: ${violations.slice(0, 3).join('\n')}`);
  assert.equal(docsSyncRuns.length, 1, 'the day holds its docs-only conflict');
  assert.ok(faulted.has(`lingering-sessions:${docsSyncRuns[0].plan.key}`), `the soak names the item whose docs-sync session lingers: ${[...faulted].join(', ')}`);
  assert.ok(violations.every(line => /lingering-sessions/.test(line)), `nothing else is violated: ${violations.filter(line => !/lingering-sessions/.test(line)).slice(0, 3).join('\n')}`);
  // The violation is a fault of its class on the loop's record, which files one item when it recurs.
  assert.equal(state.faults.instances.filter(instance => instance.kind === 'invariant:lingering-sessions' && instance.faultClass === 'session-liveness').length, 1);
});

test('unit:soak-invariants-hold — broad items are split before dispatch with bounded decomposition concurrency, child items merge, parents are delivered, and every system invariant holds', { timeout: 360_000 }, async () => {
  clearDecompositionRuns();
  const broadItems = [1, 2, 3];
  const concurrency = 2;
  const day = await simulateDay({
    hours: 3,
    decomposition: { broadItems, concurrency },
    plan: {
      items: 4,
      releaseEveryMs: 0,
      workMs: 10 * minute,
      leftovers: 2,
      rework: new Set(),
      deaths: new Set(),
      flaky: { rerunPasses: 0, rerunFails: 0 },
      scoped: new Set(),
      misread: new Set(),
      exits: new Set(),
      spentProducer: 0,
      lostRuns: 0,
      outOfQueue: { item: 4, afterMs: 99 * hour },
      blind: { from: 99 * hour, to: 100 * hour },
      split: { at: 99 * hour, item: 4 },
      slowRecompute: 0,
      blockedMerge: 0,
    },
  });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { items, final, violations, failures, lost, sessions, decompositionDay } = day;
  assert.deepEqual(violations, [], 'every system invariant holds across the decomposition runs and deliveries');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.equal(decompositionDay.peakConcurrent, concurrency, 'decomposition concurrency was capped at the configured limit');
  assert.ok(decompositionDay.starts.length >= broadItems.length, 'every broad item started decomposition');
  assert.equal(decompositionDay.createdChildren.length, broadItems.length * 2, 'each broad item was split into two children');
  const expectedParents = broadItems.map(n => items[n - 1].key).sort();
  assert.deepEqual(decompositionDay.deliveredParents.sort(), expectedParents, 'every broad parent item was delivered when its children merged');

  const undelivered = final.filter(item => item.stage !== 'done' || !item.delivery);
  assert.deepEqual(undelivered.map(item => `${item.key} ${item.stage}`), [], 'every item, the split parents and whole item, was delivered');

  const allDelivered = (await store.list()).filter(item => item.stage === 'done');
  const childItems = allDelivered.filter(item => item.parent);
  assert.equal(childItems.length, broadItems.length * 2, 'all child items were delivered');
  assert.ok(sessions.length >= broadItems.length * 2 + 1, 'sessions were opened for child items and the whole item');

  const report = splitReport(await store.list());
  assert.equal(report.length, broadItems.length, 'master status split report lists all split parents');
  assert.ok(report.every(entry => entry.delivered && entry.children.length === 2 && entry.children.every(c => c.delivered)), 'split report shows parent and children delivered');
});
