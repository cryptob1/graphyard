import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Work } from '../src/model.js';
import * as deploymentStep from '../src/daemon/deployment.js';
import { type MasterConfig, approverSessionName, masterConfigSchema } from '../src/master.js';
import { type DaemonEffects, daemonEffects, emptyDaemonState, runCycle } from '../src/master-daemon.js';
import { decisionReadDeadlineMs, decisionRefreshMs } from '../src/daemon/decision-reads.js';
import * as faultsStep from '../src/daemon/faults.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { hour, minute } from './helpers/soak-world.js';
import { MANUAL, launcher, repository, soakConfig, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * Step budgets on a slow control plane: the decisions, faults and deployment steps cut and
 * resumed, and the decisions step bounded at production load. One concern of the release-candidate
 * soak (GY-404), split per concern (GY-1363) so concurrent changes stop colliding in one file: the
 * world is tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day
 * itself tests/helpers/soak-simulation.ts, and every suite asserts the system invariants after
 * every cycle.
 */
soakControlPlanes('soak-budgets', 410);

test('unit:soak-invariants-hold — a slow control plane carries the decisions step past its budget for an hour and a half: every cycle stays within the interval, every item put off is reached within a few cycles, none has its standing decision withdrawn while put off, nothing is left put off once the plane is fast, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-1286: for the window every decision request and observation wake takes 12 s to answer, so
  // the step's 30 s budget (two fifths of the 60 s interval, never under the actionable cadence)
  // holds two requests a cycle and the rest are put off; ten items release thirty seconds apart
  // and nine of them are sent back once, so several need a decision at once. Item 3's `manual:` proof
  // gates nothing since GY-1235, so it asks for no attestation.
  const slow = { from: 5 * minute, to: 150 * minute, ms: 15_000 }, rework = new Set([1, 2, 4, 5, 6, 7]);
  const { items, final, violations, failures, lost, decideCalls, budgetDay } = await simulateDay({
    hours: 5, slowDecisions: slow,
    plan: { items: 7, leftovers: 0, slowRecompute: 0, releaseEveryMs: 1_000, workMs: 50 * minute, rework, deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 3, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 7, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 7 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all seven items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds while the step is bounded and once the plane is fast');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  const cycles = budgetDay.cycles, deferring = cycles.filter(entry => entry.deferred.length);
  assert.ok(budgetDay.slowCalls >= 6 && deferring.length >= 2, `the window ran and the step put items off across cycles (${budgetDay.slowCalls} slow calls, ${deferring.length} cycles deferring)`);
  // The step's budget plus the request in flight at the bound and each pass's one guaranteed
  // request: never the whole interval, however many items wait.
  assert.deepEqual(cycles.filter(entry => entry.spentMs > soakConfig.run.intervalSeconds * 1000).map(entry => `cycle ${entry.cycle} +${Math.round(entry.elapsed / minute)} min: ${entry.spentMs}ms, ${entry.slow} slow calls`), [], 'every cycle stays within the interval');
  // Nothing waits for good: an item stays put off a handful of consecutive cycles at most.
  const runs = new Map<string, number>(), longest = new Map<string, number>();
  for (const entry of cycles) for (const key of new Set([...runs.keys(), ...entry.deferred])) {
    const run = entry.deferred.includes(key) ? (runs.get(key) ?? 0) + 1 : 0;
    if (run) runs.set(key, run); else runs.delete(key);
    longest.set(key, Math.max(longest.get(key) ?? 0, run));
  }
  assert.deepEqual([...longest].filter(([, run]) => run > 4), [], `no item is put off more than four cycles running: ${JSON.stringify([...longest])}`);
  assert.ok(Math.max(...cycles.map(entry => entry.deferred.length)) <= items.length, 'what is put off is bounded by the open items');
  assert.deepEqual(cycles.filter(entry => entry.elapsed >= slow.to + 2 * minute && entry.deferred.length).map(entry => `+${Math.round(entry.elapsed / minute)} min: ${entry.deferred.join(', ')}`), [], 'once the plane is fast, nothing is put off');
  // A decision the step still needs is never withdrawn while its item waits for the next cycle.
  const withdrawnDeferred = budgetDay.withdrawn.filter(entry => cycles.find(cycle => cycle.cycle === entry.cycle)?.deferred.includes(entry.key));
  assert.deepEqual(withdrawnDeferred, [], 'no standing decision is withdrawn for an item put off');
  // The item whose manual proof no producer runs asks for no attestation and is delivered without it (GY-1235).
  const attested = items[2].key;
  assert.ok(!decideCalls.some(call => call.key === attested && call.action === 'attest'), `${attested} asked for no attestation: ${JSON.stringify(decideCalls.filter(call => call.key === attested).map(call => call.action))}`);
  assert.ok(!final.find(item => item.key === attested)!.evidence.some(entry => entry.proof === MANUAL), `${attested} was delivered with its manual proof unproduced`);
});

test('unit:soak-invariants-hold — a control plane that answers every snapshot read 200 but only after 75 s for an hour and a half: every cycle in the window crawls past the interval on the plane, yet each records that wait as planeWaitMs and the slow server call, its own work stays under the cycle-p90 bound, cycle-p90 holds and is observed, no loop-cost fault opens, every item is delivered, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-1562: cycle 13964's shape, held for a simulated day. Before it, timedCall left a 2xx answer's
  // in-flight time in workMs, so each of these cycles read as 75 s of the loop's own work: cycle-p90
  // violated and loop-cost filed for a plane that was only slow.
  const slow = { from: 60 * minute, to: 150 * minute, ms: 75_000 };
  const { final, violations, failures, lost, observed, slowPlaneDay, state } = await simulateDay({
    hours: 4, slowAnswers: slow,
    plan: { items: 4, leftovers: 0, slowRecompute: 0, releaseEveryMs: 1_000, workMs: 50 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all four items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds while the plane answers slowly and once it is fast');
  assert.ok(observed.has('cycle-p90'), 'cycle-p90 is judged on measured cycles, not vacuously');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  const intervalMs = soakConfig.run.intervalSeconds * 1000, bound = 30_000;
  const crawling = slowPlaneDay.cycles.filter(entry => entry.planeWaitMs >= slow.ms);
  assert.ok(slowPlaneDay.slowReads >= 30 && crawling.length >= 30, `the window ran across many cycles (${slowPlaneDay.slowReads} slow reads, ${crawling.length} crawling cycles)`);
  assert.deepEqual(crawling.filter(entry => entry.durationMs <= intervalMs).map(entry => `cycle ${entry.cycle}: ${entry.durationMs}ms`), [], 'each crawling cycle took longer than the interval in all');
  assert.deepEqual(crawling.filter(entry => entry.slowCalls < 1).map(entry => `cycle ${entry.cycle}`), [], 'each slow answer is a recorded slow server call');
  assert.deepEqual(crawling.filter(entry => entry.workMs >= bound).map(entry => `cycle ${entry.cycle} +${Math.round(entry.elapsed / minute)} min: ${entry.workMs}ms of ${entry.durationMs}ms, ${entry.planeWaitMs}ms in flight`), [], 'the loop\'s own work stays under the cycle-p90 bound');
  assert.deepEqual(slowPlaneDay.cycles.filter(entry => entry.elapsed >= slow.to + 2 * minute && entry.planeWaitMs >= slow.ms).map(entry => `cycle ${entry.cycle}`), [], 'once the plane is fast, no cycle waits on it');
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'loop-cost').map(entry => entry.text), [], 'no loop-cost instance opens for a slow-answering plane');
});

test('unit:soak-invariants-hold — a control plane too slow to observe within the faults step\'s budget for an hour and a quarter: the step is cut while the attention read is in flight, never more than one such read is in flight however many cycles run, every cycle stays within the interval, the read in flight is taken once it lands, no loop-cost fault opens, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-1345: cycle 12621's window, longer. The attention master status adds answers fifteen minutes
  // after it is asked, so a cut read stays in flight across a dozen one-minute cycles; before the reads
  // were single-flight each cut cycle started another full-plane read and spent the whole budget on it.
  const slow = { from: 60 * minute, to: 135 * minute, attentionMs: 15 * minute };
  const { final, violations, failures, lost, observationDay, state } = await simulateDay({
    hours: 4, slowObservation: slow,
    plan: { items: 4, leftovers: 0, slowRecompute: 0, releaseEveryMs: 1_000, workMs: 50 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all four items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds while the step is cut and once the plane is fast');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  const cycles = observationDay.cycles, cut = cycles.filter(entry => entry.cut);
  assert.ok(cut.length >= 30, `the window cut the step across many cycles (${cut.length} cut of ${cycles.length})`);
  assert.equal(observationDay.maxInFlight, 1, `never more than one attention read in flight (${observationDay.started} started)`);
  assert.ok(observationDay.started <= Math.ceil((slow.to - slow.from) / slow.attentionMs) + 2, `about one read per landing, not one a cycle: ${observationDay.started} started over ${cut.length} cut cycles`);
  assert.ok(observationDay.landed >= observationDay.started - 1 && observationDay.landed >= 2, `the reads in flight land and are taken (${observationDay.landed} of ${observationDay.started})`);
  assert.deepEqual(cycles.filter(entry => entry.spentMs > soakConfig.run.intervalSeconds * 1000).map(entry => `cycle ${entry.cycle} +${Math.round(entry.elapsed / minute)} min: ${entry.spentMs}ms`), [], 'every cycle stays within the interval');
  assert.deepEqual(cycles.filter(entry => entry.pending > 2).map(entry => `cycle ${entry.cycle}: ${entry.pending}`), [], 'at most one read per source is pending after any cycle');
  assert.deepEqual(cycles.filter(entry => entry.elapsed >= slow.to + 2 * minute && entry.cut).map(entry => `+${Math.round(entry.elapsed / minute)} min`), [], 'once the plane is fast, no observation is cut');
  assert.equal(faultsStep.observationReadsPending(state), 0, 'nothing is left in flight at the end of the day');
  assert.match(state.actions['faults:deferred']?.detail ?? '', /^The faults step observed every source within its budget/);
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'loop-cost').map(entry => entry.text), [], 'no loop-cost instance opens for slow plane reads');
});

test('unit:soak-invariants-hold — a release observation too slow to answer within the deployment step\'s budget for an hour and a quarter: the step is cut while the observation is in flight, never more than one such read is in flight however many cycles run, every cycle stays within the interval, the read in flight is taken once it lands, every delivery still gets its deployment record and smoke request, no loop-cost fault opens, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-1354: cycle 12624's window, longer. The release observation answers fifteen minutes after it
  // is asked, so a cut read stays in flight across a dozen one-minute cycles while the day's items are
  // delivered; each asks for a smoke proof, so its deployment record and smoke request wait on the read.
  const slow = { from: 60 * minute, to: 135 * minute, observationMs: 15 * minute };
  const { final, violations, failures, lost, deploymentDay, state } = await simulateDay({
    hours: 4, slowDeployment: slow,
    plan: { items: 4, leftovers: 0, slowRecompute: 0, releaseEveryMs: 1_000, workMs: 50 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all four items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds while the step is cut and once the release answers');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  const cycles = deploymentDay.cycles, cut = cycles.filter(entry => entry.cut);
  assert.ok(cut.length >= 30, `the window cut the step across many cycles (${cut.length} cut of ${cycles.length})`);
  assert.equal(deploymentDay.maxInFlight, 1, `never more than one release observation in flight (${deploymentDay.started} started)`);
  assert.ok(deploymentDay.started <= Math.ceil((slow.to - slow.from) / slow.observationMs) + 2, `about one read per landing, not one a cycle: ${deploymentDay.started} started over ${cut.length} cut cycles`);
  assert.ok(deploymentDay.landed >= deploymentDay.started - 1 && deploymentDay.landed >= 2, `the reads in flight land and are taken (${deploymentDay.landed} of ${deploymentDay.started})`);
  assert.deepEqual(cycles.filter(entry => entry.spentMs > soakConfig.run.intervalSeconds * 1000).map(entry => `cycle ${entry.cycle} +${Math.round(entry.elapsed / minute)} min: ${entry.spentMs}ms`), [], 'every cycle stays within the interval');
  assert.deepEqual(cycles.filter(entry => entry.pending > 1).map(entry => `cycle ${entry.cycle}: ${entry.pending}`), [], 'at most the one observation is pending after any cycle');
  assert.deepEqual(cycles.filter(entry => entry.elapsed >= slow.to + 2 * minute && entry.cut).map(entry => `+${Math.round(entry.elapsed / minute)} min`), [], 'once the release answers, no observation is cut');
  assert.equal(deploymentStep.deploymentReadsPending(state), 0, 'nothing is left in flight at the end of the day');
  assert.match(state.actions['deployment:deferred']?.detail ?? '', /^The deployment step verified within its budget/);
  // The second confidence layer resumes once the window passes: every delivery is recorded as served and its smoke proof requested, once.
  const keys = final.map(item => item.key).sort();
  assert.deepEqual([...deploymentDay.records].sort(), keys, 'each delivery is recorded as deployed exactly once');
  assert.deepEqual([...deploymentDay.smokes].sort(), keys, 'each deployed delivery has its smoke proof requested exactly once');
  assert.ok(final.every(item => item.delivery?.deployment), 'every delivery carries its deployment observation');
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'loop-cost').map(entry => entry.text), [], 'no loop-cost instance opens for a slow release observation');
});

test('unit:decisions-step-bounded — at the 2026-10-03 load (90 open items, 360 recorded decisions) the decisions step stays within 10 s a cycle and reads no history whose decision ledger did not move', { timeout: 120_000 }, async () => {
  // GY-1142. On 2026-10-03 the decisions step took 178 s of a 246 s cycle: every cycle it read each
  // item's decision history from the control plane, serially, once for every place it looked. Here
  // each history read costs real time, so a step that read them all one at a time would show it.
  const at = Date.parse('2031-06-02T08:00:00Z'), latencyMs = 40, open = 90, needing = 30;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234,
    hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const iso = (offset: number) => new Date(at + offset).toISOString();
  const uuid = (n: number, kind: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(kind).padStart(12, '0')}`;
  // A third of the items carry a triage closure the triage agent proposed, which the loop puts to an
  // approver; the rest need no decision. Every item has four decisions on record. (Until GY-1393 the
  // load was a superseded lease-loss, which reconciliation now settles without the loop.)
  const items = Array.from({ length: open }, (_, index) => {
    const n = index + 1, triage = { judgement: { outcome: 'close', reason: 'noise' }, state: 'proposed', by: 'graphyard-master-project', at: iso(-10 * minute) };
    return { id: uuid(n, 0), key: `GY-${n}`, title: `Item ${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [],
      policy: { checks: ['test'], review: true }, plannedFiles: [`src/item-${n}.ts`], stage: 'build', revision: 51, policyRevision: 3,
      createdAt: iso(-hour), updatedAt: iso(0), stageEnteredAt: iso(-5 * minute), ready: true, epoch: 2,
      lease: { owner: 'graphyard-opencode-1', epoch: 2, expiresAt: iso(hour) }, workspaces: [], candidate: null, submission: null,
      reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
      containmentQuarantine: { owner: 'graphyard-opencode-1', epoch: 2, at: iso(-5 * minute), settlementHash: 'a'.repeat(64) },
      escalation: null, escalations: [], triage: n <= needing ? triage : null } as unknown as Work;
  });
  const histories = new Map(items.map((item, index) => [item.id, [1, 2, 3, 4].map(kind => ({ id: uuid(index + 1, kind), action: 'release', state: kind % 2 ? 'applied' : 'refused', input: {}, approvedBy: null }))]));
  const calls = { decisions: 0, changes: 0 }, closed: string[] = [], agents: { name: string; pane_id: string; agent_status: string }[] = [];
  let seq = 1000, moved: string[] = [];
  const effects = {
    agents: () => agents, herdr: () => ({ agents, available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: items, now: iso(cycleNo * minute), jobs: [] }),
    closeSession: (pane: string) => { closed.push(pane); }, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    decide: async (work: Work, action: string) => {
      const id = uuid(Number(work.key.slice(3)), 9);
      histories.get(work.id)!.push({ id, action, state: 'requested', input: { expectedRevision: 51 }, approvedBy: null });
      seq += 1; moved.push(work.id);
      return { id };
    },
    decisions: async (work: Work) => { calls.decisions += 1; await new Promise(resolve => setTimeout(resolve, latencyMs)); return { decisions: structuredClone(histories.get(work.id)!) }; },
    decisionChanges: async (after: string | null) => { calls.changes += 1; const work = [...new Set(moved)]; moved = []; return { seq: String(seq), work, complete: after !== null }; },
    approver: async (work: Work, decision: string) => { const name = approverSessionName(work, decision); agents.push({ name, pane_id: `pane-${work.key}`, agent_status: 'working' }); return { agentName: name, pane: `pane-${work.key}` }; },
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  let cycleNo = 0;
  const cycle = async () => {
    cycleNo += 1; calls.decisions = 0; calls.changes = 0;
    const result = await runCycle(config, state, effects, Date.now);
    return { ms: result.metrics.steps!.decisions.ms, reads: calls.decisions, changes: calls.changes, actions: result.actions };
  };

  // Cycle one requests each resolve and launches its approver: one history read per request.
  const first = await cycle();
  assert.equal(agents.length, needing, `every proposed closure went to an approver: ${JSON.stringify(first.actions.slice(0, 4).map(action => action.detail))}`);
  assert.ok(first.reads <= needing, `one read per item that needed a decision, none for the rest: ${first.reads}`);
  assert.ok(first.ms < 10_000, `cycle one's decisions step took ${first.ms} ms`);
  // Cycle two: the ledger moved for each request, so each is read once more, eight at a time.
  const second = await cycle();
  assert.equal(second.reads, needing, `each item whose decision ledger moved is read once, however many places look at it: ${second.reads}`);
  assert.ok(second.ms < needing * latencyMs, `the reads run side by side, not one after another: ${second.ms} ms`);
  // Steady state: nothing moved, so no history is read at all, whatever the number of decisions.
  for (let round = 0; round < 3; round += 1) {
    const steady = await cycle();
    assert.equal(steady.reads, 0, `no per-decision call for a decision whose inputs have not changed (round ${round + 1})`);
    assert.equal(steady.changes, 1, 'one ledger read a cycle');
    assert.ok(steady.ms < 10_000, `steady decisions step took ${steady.ms} ms`);
  }
  assert.equal(Object.values(state.approvals).filter(watch => !watch.settledAt).length, needing, 'every request is still supervised');

  // One approver refuses: the ledger names that item alone, it is read, and the refusal acted on in the same cycle.
  const refused = items[4], decision = histories.get(refused.id)!.at(-1)!;
  Object.assign(decision, { state: 'refused', refusal: { approver: 'graphyard-approver-project', reason: 'not noise' } });
  moved.push(refused.id);
  const judged = await cycle();
  assert.equal(judged.reads, 1, 'only the item whose ledger moved is read');
  assert.ok(judged.actions.some(action => action.work === refused.key && /was refused by graphyard-approver-project/.test(action.detail)), 'the refusal is acted on the cycle it is recorded');
  assert.deepEqual(closed, [`pane-${refused.key}`], 'and its approver closed');

  // Without the ledger read the loop keeps nothing across cycles, and reads each history at most once a cycle.
  const blind = { ...effects, decisionChanges: undefined } as DaemonEffects;
  calls.decisions = 0;
  await runCycle(config, state, blind, Date.now);
  assert.ok(calls.decisions > 0 && calls.decisions <= needing, `every watched history is read again, once each: ${calls.decisions}`);

  // The loop's own effect asks the control plane once, as the coordinator, for the decision
  // kinds after the seq it last saw; the first read only finds where the ledger stands.
  const root = await temporaryDirectory('decision-changes'), secrets = await temporaryDirectory('decision-changes-secrets');
  try {
    const coordinator = join(secrets, 'coordinator.token'), operator = join(secrets, 'operator.token');
    await writeFile(coordinator, 'coordinator-token-'.padEnd(48, 'x'), { mode: 0o600 });
    await writeFile(operator, 'operator-token-'.padEnd(48, 'x'), { mode: 0o600 });
    const asked: URL[] = [];
    const fetcher = (async (url: string) => {
      const query = new URL(url); asked.push(query);
      const events = query.searchParams.get('cursor') ? [{ seq: '1201', work_id: items[1].id }, { seq: '1207', work_id: items[2].id }, { seq: '1209', work_id: items[1].id }] : [{ seq: '1200', work_id: items[0].id }];
      return new Response(JSON.stringify({ events, page: { hasMore: false } }), { status: 200 });
    }) as typeof fetch;
    const live = daemonEffects(root, { ...config, credentialFile: coordinator, operatorAgent: { id: 'graphyard-master-operator', credentialFile: operator } } as MasterConfig,
      { snapshot: async () => ({ work: items, now: iso(0) }), mutate: async () => ({}), fetcher });
    assert.deepEqual(await live.decisionChanges!(null), { seq: '1200', work: [items[0].id], complete: false }, 'the first read keeps nothing: it only finds where the ledger stands');
    assert.deepEqual(await live.decisionChanges!('1200'), { seq: '1209', work: [items[1].id, items[2].id], complete: true });
    assert.deepEqual(asked.map(url => [url.pathname, url.searchParams.get('order'), url.searchParams.get('cursor'), url.searchParams.get('payload')]), [['/api/events', 'desc', null, 'none'], ['/api/events', 'asc', '1200', 'none']]);
    assert.deepEqual(asked[1].searchParams.get('kind')!.split(','), ['requested', 'concurred', 'refused', 'declined', 'approved', 'applied', 'failed', 'stale', 'withdrawn', 'superseded'].map(kind => `decision.${kind}`));
    assert.equal(daemonEffects(root, { ...config, credentialFile: coordinator } as MasterConfig, { snapshot: async () => ({ work: items, now: iso(0) }), mutate: async () => ({}), fetcher }).decisionChanges,
      undefined, 'without the operator-agent identity there are no decision reads to keep');
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(secrets, { recursive: true, force: true })]); }
});

test('unit:decisions-step-bounded — a history read slower than the step\'s deadline neither holds the step nor starves the items after it, a history read that fails requests nothing, and every kept history is read afresh once each refresh interval', { timeout: 120_000 }, async () => {
  // GY-1241. The decisionReads deadline, the late reads it still starts, an unreadable history in
  // a request, and the periodic full refresh, each through runCycle on the loop's own clocks.
  const at = Date.parse('2031-06-02T08:00:00Z'), open = 6;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234,
    hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const iso = (offset: number) => new Date(at + offset).toISOString();
  const uuid = (n: number, kind: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(kind).padStart(12, '0')}`;
  // Every item carries a triage closure the triage agent proposed, which the loop puts to an approver.
  const items = Array.from({ length: open }, (_, index) => {
    const n = index + 1, triage = { judgement: { outcome: 'close', reason: 'noise' }, state: 'proposed', by: 'graphyard-master-project', at: iso(-10 * minute) };
    return { id: uuid(n, 0), key: `GY-${n}`, title: `Item ${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [],
      policy: { checks: ['test'], review: true }, plannedFiles: [`src/item-${n}.ts`], stage: 'build', revision: 51, policyRevision: 3,
      createdAt: iso(-hour), updatedAt: iso(0), stageEnteredAt: iso(-5 * minute), ready: true, epoch: 2,
      lease: { owner: 'graphyard-opencode-1', epoch: 2, expiresAt: iso(4 * hour) }, workspaces: [], candidate: null, submission: null,
      reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
      containmentQuarantine: { owner: 'graphyard-opencode-1', epoch: 2, at: iso(-5 * minute), settlementHash: 'a'.repeat(64) },
      escalation: null, escalations: [], triage } as unknown as Work;
  });
  const [slowItem, failingItem] = items;
  const histories = new Map(items.map((item, index) => [item.id, [1, 2].map(kind => ({ id: uuid(index + 1, kind), action: 'release', state: 'applied', input: {}, approvedBy: null }))]));
  const reads = new Map<string, number>(), decided: string[] = [], agents: { name: string; pane_id: string; agent_status: string }[] = [];
  const slow = new Set([slowItem.id]), failing = new Set([failingItem.id]), slowMs = decisionReadDeadlineMs + 500;
  let seq = 1000, moved: string[] = [], elapsed = 0;
  const effects = {
    agents: () => agents, herdr: () => ({ agents, available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: items, now: iso(elapsed), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    decide: async (work: Work, action: string) => {
      decided.push(work.key);
      const id = uuid(Number(work.key.slice(3)), 9);
      histories.get(work.id)!.push({ id, action, state: 'requested', input: { expectedRevision: 51 }, approvedBy: null });
      seq += 1; moved.push(work.id);
      return { id };
    },
    decisions: async (work: Work) => {
      reads.set(work.key, (reads.get(work.key) ?? 0) + 1);
      if (failing.has(work.id)) throw new Error('Graphyard request timed out');
      await new Promise(resolve => setTimeout(resolve, slow.has(work.id) ? slowMs : 5));
      return { decisions: structuredClone(histories.get(work.id)!) };
    },
    decisionChanges: async (after: string | null) => { const work = [...new Set(moved)]; moved = []; return { seq: String(seq), work, complete: after !== null }; },
    approver: async (work: Work, decision: string) => { const name = approverSessionName(work, decision); agents.push({ name, pane_id: `pane-${work.key}`, agent_status: 'working' }); return { agentName: name, pane: `pane-${work.key}` }; },
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  const cycle = async () => {
    reads.clear(); elapsed += minute;
    const result = await runCycle(config, state, effects, Date.now);
    return { ms: result.metrics.steps!.decisions.ms, reads: new Map(reads), actions: result.actions };
  };
  const failed = (actions: { kind: string; work: string | null; state: string }[], key: string) => actions.some(action => action.kind === 'decision' && action.work === key && action.state === 'failed');

  // (a) The first item's read outlasts the deadline: the step ends at the deadline, not after the
  // read, and nothing is requested on a history it could not read. Every item after it is reached
  // past the deadline, so its read is started and refused at once, never awaited.
  const first = await cycle();
  assert.ok(first.ms >= decisionReadDeadlineMs - 1000 && first.ms < slowMs, `the decisions step ended at its ${decisionReadDeadlineMs} ms deadline, before the ${slowMs} ms read answered: ${first.ms} ms`);
  assert.deepEqual(decided, [], 'no decision is requested on a history the step could not read');
  for (const item of items) assert.ok(failed(first.actions, item.key), `${item.key}'s request is recorded failed, to be retried: ${JSON.stringify(first.actions.filter(action => action.work === item.key).map(action => action.detail))}`);
  assert.deepEqual([...first.reads.values()], items.map(() => 1), 'each history read was started once, the late ones included');
  // The slow read answers after the step: it is kept, like every late read that answered.
  await new Promise(resolve => setTimeout(resolve, slowMs - first.ms + 200));
  slow.clear();

  // (c) The retries request each readable item once, on the history the late reads left behind;
  // the item whose read keeps failing is never requested, and its request stays failed.
  const retried: Awaited<ReturnType<typeof cycle>>[] = [];
  for (let round = 0; round < 8 && decided.length < open - 1; round += 1) retried.push(await cycle());
  assert.deepEqual([...decided].sort(), items.slice(1).map(item => item.key).filter(key => key !== failingItem.key).concat(slowItem.key).sort(), 'each readable item is requested exactly once; the unreadable one never');
  const requestedIn = retried.find(entry => entry.actions.some(action => action.work === slowItem.key && action.kind === 'decision' && action.state === 'done'))!;
  assert.ok(requestedIn, 'the slow item is requested once its read answered');
  assert.equal(requestedIn.reads.get(slowItem.key) ?? 0, 0, 'on the late answer kept from the first cycle, not a second read');
  assert.ok(retried.some(entry => failed(entry.actions, failingItem.key)), 'the unreadable item\'s request is retried and recorded failed again');
  failing.clear();
  for (let round = 0; round < 8 && decided.length < open; round += 1) retried.push(await cycle());
  for (const entry of retried) assert.ok(entry.ms < 2000, `with every read answering at once the step is quick: ${entry.ms} ms`);
  assert.equal(decided.filter(key => key === failingItem.key).length, 1, 'once its history reads, the item is requested exactly once');
  assert.equal(new Set(decided).size, open, 'no duplicate request for any item');

  // (b) Steady state reads nothing. Once the control-plane clock passes the refresh interval, every
  // watched history is dropped and read exactly once, and the cycles after read nothing again.
  await cycle();
  const steady = await cycle();
  assert.equal(steady.reads.size, 0, `nothing moved, so nothing is read: ${JSON.stringify([...steady.reads])}`);
  elapsed += decisionRefreshMs;
  const refreshed = await cycle();
  assert.deepEqual(Object.fromEntries(refreshed.reads), Object.fromEntries(items.map(item => [item.key, 1])), 'each watched history is read once more, in the cycle the interval passed');
  for (let round = 0; round < 3; round += 1) assert.equal((await cycle()).reads.size, 0, `and none in the cycles after it (round ${round + 1})`);
  assert.equal(new Set(decided).size, decided.length, 'the refresh requested nothing again');
});

test('unit:soak-invariants-hold — the loop\'s setup step over a day on a Railway deployment that lacks the revert approver: it sets the variables and redeploys once, then never again while the deployment stays healthy; when they vanish and every redeploy fails for four hours, the failing run is one bounded failed action and its retries back off; once redeploys succeed it settles with one redeploy, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-1416: step 7e starts `master setup --apply` beside the cycle at most hourly, and a run that
  // throws fails only its own isolated action. A redeploy that keeps failing must not become a
  // redeploy every few minutes, nor a growing set of actions.
  const fails = { from: 2 * hour, to: 6 * hour };
  const { final, violations, failures, lost, state, provisionDay } = await simulateDay({
    hours: 12, selfProvision: { redeployFails: fails },
    plan: { items: 2, leftovers: 0, slowRecompute: 0, releaseEveryMs: 1_000, workMs: 50 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 2, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 2 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'the day\'s items are delivered beside the setup step');
  assert.deepEqual(violations, [], 'every system invariant holds while setup applies, fails and recovers');
  assert.deepEqual(failures, [], 'no cycle failed: a failed setup run fails only its own action');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  const window = (from: number, to: number) => provisionDay.redeploys.filter(entry => entry.at >= from && entry.at < to);
  // Healthy: the first run sets both variables and redeploys once; the hourly runs after it touch nothing.
  assert.deepEqual(window(0, fails.from).map(entry => entry.ok), [true], `one redeploy before the failing window: ${JSON.stringify(provisionDay.redeploys)}`);
  assert.deepEqual(provisionDay.sets.filter(entry => entry.at < fails.from).map(entry => entry.name).sort(), ['GRAPHYARD_REVERT_APPROVER_APP_ID', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY']);
  assert.ok(provisionDay.runs.filter(at => at < fails.from).length <= 3, `at most hourly: ${provisionDay.runs.map(at => Math.round(at / minute))}`);
  // Failing: the vanished variables are set again once, and the failing redeploys back off (10, 20, 40, 80 min…), never one a cycle.
  const failing = window(fails.from, fails.to);
  assert.ok(failing.length >= 2 && failing.length <= 6 && failing.every(entry => !entry.ok), `bounded failing redeploys in four hours: ${failing.map(entry => Math.round(entry.at / minute))}`);
  assert.deepEqual(provisionDay.sets.filter(entry => entry.at >= fails.from).map(entry => entry.name).sort(), ['GRAPHYARD_REVERT_APPROVER_APP_ID', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY'], 'set once; the retries only redeploy');
  // The back-off is measured between run starts: a run's redeploy is recorded when it reaches it,
  // which on a slow host can fall a cycle after the run started.
  const retries = provisionDay.runs.filter(at => at >= fails.from && at < fails.to);
  const gaps = retries.slice(1).map((at, index) => at - retries[index]);
  assert.ok(gaps.length >= 2 && gaps.every((gap, index) => index === 0 || gap > gaps[index - 1]), `the retries back off: ${gaps.map(gap => Math.round(gap / minute))} min; runs ${provisionDay.runs.map(at => Math.round(at / minute))}`);
  // Recovered: one redeploy settles it, and the deployment stays healthy with none after it.
  const after = window(fails.to, 12 * hour);
  assert.deepEqual(after.map(entry => entry.ok), [true], `one redeploy once redeploys succeed: ${JSON.stringify(after)}`);
  // The failing runs are one isolated config action, never a growing set.
  assert.ok(provisionDay.actions.every(entry => entry.keys.length <= 1), 'at most one setup action at any cycle');
  assert.deepEqual(Object.keys(state.actions).filter(key => key.includes('self-provision')), ['isolated:config:setup self-provision']);
  assert.match(state.actions['isolated:config:setup self-provision']!.detail, /setup self-provision failed: railway redeploy exited 1/);
});
