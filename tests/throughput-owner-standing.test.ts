import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionRow } from '../src/model/actions.js';
import type { Work } from '../src/model.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { openThroughputOwner, populationRule, recordThroughputMeasurement, throughputClaimVisibility, throughputOwnerItem, throughputStall, throughputStallBound, verifyThroughput, type ThroughputReport } from '../src/throughput.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1465: the throughput needs-decision applies the population rule settled by requirements
// revision 48a9e55a (superseded control-plane actions are loop machinery of record), and while one
// stands with no open owner the loop files the owner within its cycle, so it is never masterless.
const minute = 60_000;
const base = Date.parse('2026-10-07T12:00:00.000Z');
const at = (minutes: number) => new Date(base + minutes * minute).toISOString();
const now = base + 120 * minute;
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const revision = sha('e');
const deployed = { revision, version: '1', origin: 'https://example.invalid', observedAt: at(0), containsClaim: true, reason: null };
const controlPlaneKinds = ['escalate', 'request-rework', 'resync', 'request-review', 'dispatch', 'approve-scope', 'reclaim', 'merge'];
/** The words a binary predating the settled rule recorded for a superseded row (the 15:30 measurement's family). */
const preRuleExclusion = (kind: string) => `its ${kind} action was superseded before any executor ran it (now needs another action), so something outside the queue moved the item on`;
const preRule = 'A delivery is counted when it is a merged pull request of this repository with a recorded submission, at most one rework round, at least one action an executor claimed and completed, and no trace of a coordinator on it: no action superseded before an executor ran it, no coordination session recorded, no blocked report and no requirements revision while it was under way. Every delivery the window holds is listed either way, with its own figures and, when it is excluded, the reason.';

function row(kind: string, history: ActionRow['history']): ActionRow {
  return { id: `${kind}-${history[0]!.at}`, kind, work: 'w', key: 'GY-1', inputs: { kind }, gate: 'build', refusal: null, reason: '', binding: `${kind}:0`,
    requestedBy: 'graphyard', requestedAt: history[0]!.at, state: 'done', claim: null, attempts: 1, resolvedAt: history.at(-1)!.at, result: 'done', resolution: 'settled', history } as unknown as ActionRow;
}
const executed = (kind: string, from: number) => row(kind, [
  { at: at(from), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
  { at: at(from + 1), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'attempt 1 claimed by executor-a on host-a' },
  { at: at(from + 2), event: 'completed', requester: 'graphyard', executor: 'executor-a', result: 'done', reason: '' },
]);
const superseded = (kind: string, from: number) => row(kind, [
  { at: at(from), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
  { at: at(from + 1), event: 'cancelled', requester: 'graphyard', executor: null, result: null, reason: 'now needs another action' },
]);
function delivery(key: string, shape: { history?: ActionRow[]; blocked?: number } = {}): Work {
  return {
    id: key.toLowerCase(), key, title: `Delivery ${key}`, stage: 'done', gates: [], violations: [], policy: { checks: [], review: true }, implementers: ['worker-1'], workspaces: [], sessions: [],
    submission: { pr: Number(key.split('-')[1]) }, candidate: null, updatedAt: at(40),
    delivery: { mergeSha: sha('a'), mergedAt: at(30) },
    pipeline: { attempts: [{ epoch: 1, owner: 'worker-1', claimedAt: at(0), endedAt: at(10), end: 'submitted' }], submittedAt: at(10), reworkRounds: 0,
      interventions: { blocked: shape.blocked ?? 0, requirements: 0 }, backfill: null },
    actionQueue: { actions: [], history: shape.history ?? [executed('request-review', 11)] },
  } as unknown as Work;
}
/** A window past the stall bound whose every delivery carries only the superseded control-plane family. */
const supersededWindow = () => Array.from({ length: throughputStallBound }, (_, index) =>
  delivery(`GY-${400 + index}`, { history: [executed('request-review', 11), ...controlPlaneKinds.map((kind, offset) => superseded(kind, 12 + offset))] }));
/** A window every delivery of which a blocked report handed to a master: a stall under the settled rule. */
const blockedWindow = () => Array.from({ length: throughputStallBound }, (_, index) => delivery(`GY-${500 + index}`, { blocked: 1 }));
/** The owner's settled criterion, imported dynamically so the proof runs (and fails as a case) on a tree without it. */
const ownerCriterion = async () => ((await import('../src/throughput.js')) as { throughputOwnerCriterion?: string }).throughputOwnerCriterion;
const settledFamily = /superseded control-plane actions \(dispatch, escalate, rework, resync, review, merge, approve-scope, reclaim\) are the loop machinery of record and do not exclude a delivery/;
const measure = (work: Work[]) => verifyThroughput(work, now, { deployed, since: at(-60) });
/** The report a binary predating the rule wrote over the superseded window: every delivery excluded, for that family alone. */
function preRuleReport(rule: string): ThroughputReport {
  const report = measure(supersededWindow());
  const excluded = report.deliveries.map(record => ({ ...record, admitted: false, exclusions: controlPlaneKinds.map(preRuleExclusion) }));
  return { ...report, verdict: 'unverified', deliveries: excluded, excluded, population: { ...report.population, rule, admitted: 0, excluded: excluded.length } };
}

test('unit:throughput-rule-settled-superseded-actions — a delivery set excluded solely on control-plane actions superseded before an executor ran them is judged under the settled rule: 0 exclusions, every delivery admitted, no needs-decision, even over a report whose binary still named that family', () => {
  const report = measure(supersededWindow());
  assert.equal(report.population.rule, populationRule);
  assert.equal(report.population.delivered, throughputStallBound);
  assert.equal(report.population.excluded, 0, 'the superseded family excludes nothing');
  assert.equal(report.excluded.length, 0);
  for (const record of report.deliveries) {
    assert.equal(record.admitted, true);
    assert.deepEqual(record.exclusions, []);
    assert.equal(record.actions.filter(action => action.supersededUnexecuted).length, controlPlaneKinds.length, 'each kind really was superseded unexecuted');
  }
  assert.equal(report.population.admitted, throughputStallBound);
  assert.equal(throughputStall(report), null);

  // A report recorded by a binary that predates the rule — whatever rule string it carries — is
  // re-judged under the settled one: a delivery whose only exclusions are that family is no
  // coordinator's trace, so the window can accumulate and no needs-decision stands on it.
  for (const rule of [preRule, populationRule]) assert.equal(throughputStall(preRuleReport(rule)), null, `no stall under ${rule === populationRule ? 'the settled' : 'the pre-revision'} rule string`);
  // A delivery a master did drive stays excluded, and the settled re-judging never names the superseded family as a reason.
  const blocked = measure(blockedWindow());
  const mixed = { ...blocked, excluded: blocked.excluded.map(record => ({ ...record, exclusions: [...record.exclusions, preRuleExclusion('escalate')] })) };
  const stall = throughputStall(mixed)!;
  assert.ok(stall, 'a coordinator fingerprint beside the family still stalls');
  assert.deepEqual(stall.reasons, [{ reason: 'a blocked report handed it to a master or operator to clear', deliveries: throughputStallBound, coordinator: true }]);
  assert.doesNotMatch(stall.finding, /superseded before any executor ran it(?! and an approver)/, 'the family is not counted as an exclusion');
});

test('integration:throughput-attention-settled-rule — master status raises no needs-decision attention over a measurement whose only exclusions are the superseded control-plane family, and none over the pre-revision measurement that excluded them', () => {
  const file = '.graphyard/measurements/throughput/t.json', serving = { revision, version: '1' };
  // Under the settled rule the window verifies: the attention retires.
  const verified = throughputClaimVisibility({ report: measure(supersededWindow()), file }, serving, throughputStallBound, null, null);
  assert.equal(verified.verdict, 'verified');
  assert.equal(verified.stall, null);
  assert.equal(verified.attention, null, 'no attention at all');
  // A pre-revision measurement of the serving release (the 15:30 record: 0 admitted, excluded on the family alone) asks no decision either.
  for (const rule of [preRule, populationRule]) {
    const standing = throughputClaimVisibility({ report: preRuleReport(rule), file }, serving, throughputStallBound, null, null);
    assert.equal(standing.stall, null);
    assert.ok(standing.attention, 'still unverified until re-measured');
    assert.doesNotMatch(standing.attention!.text, /needs decision/);
    assert.equal(standing.attention!.approvedBy ?? null, null, 'not the decide-then-approver path');
    assert.doesNotMatch(standing.attention!.next, /master decide/);
  }
  // Where a master really drove every delivery the needs-decision stands, but judged under the
  // settled rule: the family a pre-revision binary recorded beside the fingerprint is not quoted as an exclusion.
  const blocked = measure(blockedWindow());
  const mixed = { ...blocked, excluded: blocked.excluded.map(record => ({ ...record, exclusions: [...record.exclusions, ...controlPlaneKinds.map(preRuleExclusion)] })) };
  const decision = throughputClaimVisibility({ report: mixed, file }, serving, throughputStallBound, null, { key: 'GY-7310' });
  assert.match(decision.attention!.text, new RegExp(`needs decision on GY-7310: .*Exclusions: ${throughputStallBound} × a blocked report handed it to a master or operator to clear\\. Population rule`));
  assert.doesNotMatch(decision.attention!.text, /× its \S+ action was superseded/, 'no superseded control-plane action is counted as an exclusion');
});

test('unit:throughput-attention-names-owner — the needs-decision attention names the open owner item as the GY-N its decide-then-approver path acts on, says the loop files one within the cycle while none is open, and the owner it files carries the settled AC-1', async () => {
  const file = '.graphyard/measurements/throughput/t.json', serving = { revision, version: '1' }, report = measure(blockedWindow());
  const owned = throughputClaimVisibility({ report, file }, serving, throughputStallBound, null, { key: 'GY-7300' });
  assert.equal(owned.stall!.owner, 'GY-7300');
  assert.match(owned.attention!.text, /needs decision on GY-7300: session-free deliveries cannot accumulate/);
  assert.equal(owned.attention!.role, 'master'); assert.equal(owned.attention!.approvedBy, 'approver');
  assert.match(owned.attention!.next, /graphyard master decide GY-7300 requirements .* graphyard master approver GY-7300 DECISION; the loop closes GY-7300 once it is applied/);
  assert.doesNotMatch(owned.attention!.next, /GY-N\b/);
  const masterless = throughputClaimVisibility({ report, file }, serving, throughputStallBound, null, null);
  assert.match(masterless.attention!.text, /needs decision on the item that owns the verification \(the loop files it\)/);
  assert.match(masterless.attention!.next, /master decide GY-N requirements/);
  // Between measurements the line promises the owner within one cycle while a needs-decision stands.
  const progress = throughputClaimVisibility(null, serving, 3, null, null);
  assert.match(progress.attention!.text, /No open item owns the verification yet \(.*and within one cycle while a needs-decision stands\)/);
  // The owner the loop files for that path carries the settled AC-1 with its manual proof.
  const criterion = await ownerCriterion();
  assert.match(criterion ?? '', settledFamily);
  // Like the settled rule, an approver's coordination session never excludes; one recording no role does.
  assert.match(populationRule, /an approver session never exclude/);
  assert.match(criterion ?? '', /no coordination session other than an approver's recorded on it \(one recording no role excludes\)/);
  assert.deepEqual(throughputOwnerItem(revision, 0).criteria, [{ id: 'AC-1', text: criterion, proofs: ['manual:throughput-claim-verified'] }]);
});

test('integration:throughput-owner-filed-when-masterless — a needs-decision standing with no open owner (the previous one closed) gets a filed owner carrying the settled AC-1 within one cycle, under a key a reused release never collides on, and the decision is raised on it', async () => {
  const directory = await temporaryDirectory('throughput-owner-standing');
  try {
    const token = join(directory, 'coordinator.token');
    await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: join(directory, 'graphyard.mjs'), repository: 'owner/project', baseBranch: 'main',
      githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { deploymentReuseMinutes: 0 } });
    const state = emptyDaemonState(master);
    state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };

    const template = delivery('GY-87');
    const work: Work[] = [template];
    const report = measure(blockedWindow()), stall = throughputStall(report)!;
    assert.ok(stall);
    // The control plane's idempotency: a key reused with different input is refused (409), as live.
    const keys = new Map<string, { body: string; owner: Work }>(), filed: { key: string; input: { title: string; criteria: Work['criteria'] } }[] = [];
    let next = 7400, measured = 0, standingReads = 0;
    const effects: DaemonEffects = {
      agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
      snapshot: async () => ({ work, now: new Date().toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
      observeDeployment: async () => ({ source: 'endpoint', sha: revision, at: new Date().toISOString(), reason: null, deployed: [], pending: [], requests: 0 }) as any,
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
      // Only the first ask carries the stall: later cycles read it back from the recorded measurement.
      measureThroughput: async () => ({ outcome: 'recorded', revision, verdict: 'unverified', stall: measured++ ? null : stall, detail: `Recorded for ${revision.slice(0, 12)}: unverified: the claim` }),
      standingThroughputStall: async served => { standingReads++; return served === revision ? stall : null; },
      fileThroughputOwner: async (input, key) => {
        const body = JSON.stringify(input);
        const seen = keys.get(key);
        if (seen && seen.body !== body) throw new Error('Graphyard refused work (409): Idempotency key reused with different input');
        if (seen) return seen.owner; // a reused key with the same input answers the item it filed, closed or not
        filed.push({ key, input });
        const owner = { ...template, id: `owner-${next}`, key: `GY-${next++}`, title: input.title, criteria: input.criteria, stage: 'backlog', ready: false, epoch: 0, lease: null, blocker: null, submission: null, reworkRequested: false, dependencies: [], evidence: [], delivery: undefined, policyRevision: 1, revision: 1 } as unknown as Work;
        keys.set(key, { body, owner }); work.push(owner); return owner;
      },
      closeThroughputOwner: async () => null,
    };

    await runCycle(master, state, effects, () => Date.now());
    const first = openThroughputOwner(work)!;
    assert.ok(first, 'the first unverified measurement files an owner');
    assert.equal(state.actions[`escalation:throughput:${first.key}:1`]?.work, first.key, 'the needs-decision is raised on it');
    // The owner carries the settled AC-1 (GY-1449's text) with its manual proof, so it asks for verification under the settled rule.
    const criterion = await ownerCriterion();
    assert.match(criterion ?? '', settledFamily);
    assert.deepEqual(filed[0]!.input.criteria, [{ id: 'AC-1', text: criterion, proofs: ['manual:throughput-claim-verified'] }]);

    // Someone closes it obsolete (as GY-1449 was) while the needs-decision still stands on the serving release.
    Object.assign(first, { stage: 'done', closure: { kind: 'obsolete', reason: 'settled', ref: null, by: 'master', at: new Date().toISOString(), from: 'backlog' } });
    await runCycle(master, state, effects, () => Date.now());
    const second = openThroughputOwner(work)!;
    assert.ok(second && second.key !== first.key, 'the very next cycle files a new owner: the attention is not masterless past one cycle');
    assert.ok(standingReads >= 1, 'the standing needs-decision was read back from the recorded measurement');
    assert.equal(filed.length, 2);
    assert.notEqual(filed[1]!.key, filed[0]!.key, 'the refiling is keyed past its closed predecessor, so the plane neither refuses it nor answers the closed item');
    assert.equal(filed[1]!.key, filed[0]!.key.replace(`${revision}:`, `${revision}:${first.key}:`), 'same input, bound to the owner it succeeds');
    assert.ok(filed.every(entry => entry.key.startsWith(`throughput-owner:${revision}:`)));
    assert.equal(state.actions[`throughput:owner:${revision}`]!.state, 'done');
    assert.equal(state.actions[`throughput:owner:${revision}`]!.work, second.key);
    assert.equal(state.actions[`escalation:throughput:${second.key}:1`]?.work, second.key, 'the decision is asked on the new owner');
    // master status then names it as the GY-N for the decide-then-approver path.
    const visible = throughputClaimVisibility({ report, file: 't.json' }, { revision, version: '1' }, throughputStallBound, null, openThroughputOwner(work));
    assert.match(visible.attention!.text, new RegExp(`needs decision on ${second.key}:`));
    assert.match(visible.attention!.next, new RegExp(`master decide ${second.key} requirements`));

    // While it is open nothing more is filed; once nothing stands any longer, a closed owner is not replaced.
    await runCycle(master, state, effects, () => Date.now());
    assert.equal(filed.length, 2);
    Object.assign(second, { stage: 'done', closure: { kind: 'obsolete', reason: 'answered', ref: null, by: 'operator-agent', at: new Date().toISOString(), from: 'backlog' } });
    effects.standingThroughputStall = async () => null;
    for (let cycle = 0; cycle < 3; cycle++) await runCycle(master, state, effects, () => Date.now());
    assert.equal(filed.length, 2, 'with no needs-decision standing, a release whose owner closed gets no second');

    // The owner record for the release is pruned (the action retention) while a needs-decision stands
    // again: the plane answers the original key with the closed first owner, then the succession key
    // with the closed second. Neither is accepted as the owner; the loop files a third in that cycle.
    effects.standingThroughputStall = async served => served === revision ? stall : null;
    delete state.actions[`throughput:owner:${revision}`];
    await runCycle(master, state, effects, () => Date.now());
    const third = openThroughputOwner(work)!;
    assert.ok(third && ![first.key, second.key].includes(third.key), 'a pruned record never makes a closed owner the new one');
    assert.equal(filed.length, 3);
    assert.equal(filed[2]!.key, filed[0]!.key.replace(`${revision}:`, `${revision}:${second.key}:`), 'filed as the successor of the newest closed owner');
    assert.equal(state.actions[`throughput:owner:${revision}`]!.work, third.key);
    assert.equal(state.actions[`escalation:throughput:${third.key}:1`]?.work, third.key, 'the decision is asked on the open owner, never a closed one');
    assert.equal(Object.keys(state.actions).filter(key => key.startsWith('escalation:throughput:')).length, 3, 'one escalation per owner');

    // Pruned again with nothing standing: the closed chain is not taken as an owner. The unverified
    // release is filed the ordinary owner once (its once-per-release record is gone), open, and nothing is escalated.
    Object.assign(third, { stage: 'done', closure: { kind: 'obsolete', reason: 'answered', ref: null, by: 'operator-agent', at: new Date().toISOString(), from: 'backlog' } });
    effects.standingThroughputStall = async () => null;
    delete state.actions[`throughput:owner:${revision}`];
    for (let cycle = 0; cycle < 3; cycle++) await runCycle(master, state, effects, () => Date.now());
    assert.equal(filed.length, 4, 'one ordinary owner, filed once');
    const ordinary = openThroughputOwner(work)!;
    assert.equal(ordinary.key, `GY-${7400 + 3}`);
    assert.equal(state.actions[`throughput:owner:${revision}`]!.work, ordinary.key);
    assert.equal(Object.keys(state.actions).filter(key => key.startsWith('escalation:throughput:')).length, 3, 'nothing stands, so nothing is escalated');

    // The re-measure fails in the cycle the open owner closes, while the recorded measurement still
    // shows the needs-decision: the failed ask names no verdict, yet the owner is filed that cycle.
    Object.assign(ordinary, { stage: 'done', closure: { kind: 'obsolete', reason: 'answered', ref: null, by: 'operator-agent', at: new Date().toISOString(), from: 'backlog' } });
    effects.standingThroughputStall = async served => served === revision ? stall : null;
    effects.measureThroughput = async () => { throw new Error('the plane answered 502'); };
    delete state.actions[`throughput:${revision}`];
    await runCycle(master, state, effects, () => Date.now());
    assert.equal(state.actions[`throughput:${revision}`]!.state, 'failed', 'the re-measure failed');
    const despiteFailure = openThroughputOwner(work)!;
    assert.ok(despiteFailure && despiteFailure.key !== ordinary.key, 'a failed re-measure leaves no standing needs-decision masterless past its cycle');
    assert.equal(filed.length, 5);
    assert.equal(filed[4]!.key.startsWith(`throughput-owner:${revision}:${ordinary.key}:`), true, 'filed as the successor of the closed owner');
    assert.equal(state.actions[`escalation:throughput:${despiteFailure.key}:1`]?.work, despiteFailure.key, 'the decision is asked on it');

    // A failed ask with nothing standing files nothing.
    Object.assign(despiteFailure, { stage: 'done', closure: { kind: 'obsolete', reason: 'answered', ref: null, by: 'operator-agent', at: new Date().toISOString(), from: 'backlog' } });
    effects.standingThroughputStall = async () => null;
    for (let cycle = 0; cycle < 3; cycle++) await runCycle(master, state, effects, () => Date.now());
    assert.equal(filed.length, 5, 'without an unverified answer only a standing decision files an owner');
    assert.equal(openThroughputOwner(work), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:throughput-standing-stall-recorded — the production read of a standing needs-decision judges the newest recorded measurement of the serving release, and of no other', async () => {
  const directory = await temporaryDirectory('throughput-standing-recorded');
  try {
    // Imported dynamically so the proof file loads (and this case fails alone) on a tree without the read.
    const { standingThroughputStall } = await import('../src/daemon/throughput-effect.js') as { standingThroughputStall: (root: string) => (revision: string) => Promise<{ kind: string; revision: string | null } | null> };
    const read = standingThroughputStall(directory);
    assert.equal(await read(revision), null, 'no measurement recorded: nothing stands');
    await recordThroughputMeasurement(directory, measure(blockedWindow()));
    const standing = await read(revision);
    assert.equal(standing?.kind, 'needs-decision');
    assert.equal(standing?.revision, revision);
    assert.equal(await read(sha('f')), null, 'a measurement of another release asks nothing of this one');
    // A newer measurement whose only exclusions are the superseded family (pre-rule words) stands no decision.
    await recordThroughputMeasurement(directory, { ...preRuleReport(preRule), measuredAt: new Date(now + minute).toISOString() });
    assert.equal(await read(revision), null, 'the newest measurement is judged under the settled rule');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// GY-1587: an accumulating population whose budgets miss past the pursuit's escalation bound raises
// the answerable needs-decision on the open owner, and the owner reaches one of its closure paths.
const ownerTitle = () => throughputOwnerItem(revision, null).title;
const claimItem = { id: 'claim-87', key: 'GY-87', title: 'The throughput claim', stage: 'done', policy: { checks: [], review: true },
  delivery: { mergeSha: sha('c'), mergedAt: at(-120), deployment: { sha: revision, observedAt: at(-60) } } } as unknown as Work;
const refusal = 'rerun: refused: GitHub POST /repos/cryptob1/graphyard/actions/runs/1/rerun-failed-jobs failed (403): the installed App lacks a permission this request needs';
/** A request-rework superseded `waited` minutes after it was requested, never claimed; `cause` is the refusal its row records, if any. */
const staleRework = (waited: number, cause: string | null) => ({ ...row('request-rework', [
  { at: at(12), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
  { at: at(12 + waited), event: 'cancelled', requester: 'graphyard', executor: null, result: null, reason: 'now needs dispatch instead' },
]), id: `rework-${cause ? 'refused' : 'runnable'}`, refusal: cause, attempts: 0 }) as unknown as ActionRow;
/** Ten admitted deliveries, the last carrying `rework`: the claim's minimum, accumulated. */
const accumulated = (rework: ActionRow) => [claimItem, ...Array.from({ length: 9 }, (_, index) => delivery(`GY-${600 + index}`)),
  delivery('GY-468', { history: [executed('request-review', 11), rework] })];
const openOwner = (key: string, policyRevision = 1) => ({ ...delivery(key), id: key.toLowerCase(), title: ownerTitle(), stage: 'backlog', criteria: [], ready: false, epoch: 0, lease: null, blocker: null, submission: null, reworkRequested: false, dependencies: [], evidence: [], delivery: undefined, closure: undefined, policyRevision, revision: 1 } as unknown as Work);

async function convergenceLoop(directory: string, work: Work[], clock: { now: number }) {
  const { appendThroughputLedger, recordedEntry } = await import('../src/throughput-ledger.js');
  const { loopThroughputMeasurement, throughputMeasurementDirectory } = await import('../src/throughput.js');
  const { standingThroughputStall } = await import('../src/daemon/throughput-effect.js');
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: join(directory, 'graphyard.mjs'), repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { deploymentReuseMinutes: 0 } });
  const state = emptyDaemonState(master);
  state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  // The pursuit opened past the 48h bound on a claim-missed attempt, as GY-1471's did.
  const opened = verifyThroughput(accumulated(staleRework(10, null)), clock.now - 49 * 60 * minute, { deployed });
  await appendThroughputLedger(join(directory, throughputMeasurementDirectory), recordedEntry(opened, { source: 'loop', file: null, output: '' }));
  const filed: Work[] = [], closed: string[] = [];
  let next = 7600;
  const effects: DaemonEffects = {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work, now: new Date(clock.now).toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'endpoint', sha: revision, at: new Date(clock.now).toISOString(), reason: null, deployed: [], pending: [], requests: 0 }) as any,
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    measureThroughput: (items, observedSha) => loopThroughputMeasurement(directory, { work: items, observedSha, now: () => clock.now, origin: 'https://example.invalid',
      status: async () => ({ now: new Date(clock.now).toISOString(), release: { version: '1', revision } }), readItem: async id => work.find(item => item.id === id)!, contains: async () => true }),
    standingThroughputStall: standingThroughputStall(directory, () => clock.now),
    fileThroughputOwner: async input => {
      const owner = { ...openOwner(`GY-${next++}`), title: input.title, criteria: input.criteria } as Work;
      filed.push(owner); work.push(owner); return owner;
    },
    closeThroughputOwner: async (owner, reason) => {
      closed.push(owner.key);
      Object.assign(owner, { stage: 'done', closure: { kind: 'obsolete', reason, ref: null, by: 'operator-agent', at: new Date(clock.now).toISOString(), from: 'backlog' } });
      return owner;
    },
  };
  return { master, state, effects, filed, closed };
}

test('integration:throughput-escalation-answerable — an escalated claim-missed pursuit over at least ten admitted deliveries records the typed needs-decision on the open owner, so a requirements revision applied after it answers and closes the owner, and the answered decision is never raised again on this release', async () => {
  const { throughputEscalatedAt, throughputEscalationKey } = await import('../src/daemon/cycle-delivery.js');
  const { throughputOwnerAnswered, throughputOwnerClosure, throughputStatus } = await import('../src/throughput.js');
  const directory = await temporaryDirectory('throughput-escalation-answerable');
  try {
    const clock = { now: base + 3 * 24 * 60 * minute };
    const owner = openOwner('GY-1471');
    const work: Work[] = [...accumulated(staleRework(10, null)), owner];
    const { master, state, effects, filed, closed } = await convergenceLoop(directory, work, clock);

    await runCycle(master, state, effects, () => clock.now);
    const measured = (await import('../src/throughput.js')).readThroughputMeasurement;
    const report = (await measured(directory))!.report;
    assert.equal(report.population.admitted, 10, 'the population accumulated to the claim\'s minimum');
    assert.equal(report.verdict, 'unverified');
    assert.deepEqual(report.shortfall!.missed.map(entry => entry.metric), ['idle-actionable'], 'the runnable superseded row still counts in full');
    const key = throughputEscalationKey('GY-1471', 1);
    assert.equal(state.actions[key]?.state, 'done', 'the needs-decision is recorded on the open owner');
    assert.equal(state.actions[key]!.work, 'GY-1471');
    assert.match(state.actions[key]!.detail, /needs decision on GY-1471: .*budgets missed .* past the 48h escalation bound over an accumulating population — 10 admitted/);
    assert.equal(throughputEscalatedAt(state.actions, owner), 1);
    const status = await throughputStatus(directory, { release: { version: '1', revision } }, work, clock.now);
    assert.equal(status.stall?.cause, 'escalated-miss');
    assert.match(status.attention!.next, /graphyard master decide GY-1471 requirements .* graphyard master approver GY-1471 DECISION/);
    assert.equal(status.attention!.approvedBy, 'approver');
    assert.equal(throughputOwnerClosure(owner, { revision, verdict: 'unverified' }, 1), null, 'unanswered, it stays open');

    // The master's requirements revision, applied after the raise and independently approved, answers it.
    owner.policyRevision = 2;
    assert.equal(throughputOwnerAnswered(owner, throughputEscalatedAt(state.actions, owner)), true);
    assert.ok(throughputOwnerClosure(owner, { revision, verdict: 'unverified' }, 1));
    clock.now += minute;
    await runCycle(master, state, effects, () => clock.now);
    assert.deepEqual(closed, ['GY-1471'], 'the loop closes the owner on its answer');
    assert.equal(filed.length, 1, 'the release stays owned by a successor');
    const successor = openThroughputOwner(work)!;
    assert.equal(successor.key, filed[0]!.key);
    for (let cycle = 0; cycle < 3; cycle++) { clock.now += 61 * minute; await runCycle(master, state, effects, () => clock.now); }
    assert.equal(Object.keys(state.actions).filter(entry => entry.startsWith('escalation:throughput:')).length, 1, 'the answered decision is not raised again on this release');
    const after = await throughputStatus(directory, { release: { version: '1', revision } }, work, clock.now);
    assert.equal(after.owner.item, successor.key);
    assert.equal(after.stall, null);
    assert.doesNotMatch(after.attention!.text, /needs decision|escalated:/);
    assert.match(after.attention!.text, new RegExp(`its needs-decision on this release was answered at .*, so ${successor.key} carries the verification`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('integration:throughput-escalation-answerable — an answered population stall on the release never stands in for the escalated miss: once deliveries accumulate and the budgets miss past the escalation bound, the open successor is asked that distinct decision, both when the stall was answered in an earlier cycle and in the cycle that closes its owner', async () => {
  const { throughputEscalatedAt, throughputEscalationKey } = await import('../src/daemon/cycle-delivery.js');
  const { throughputAnsweredAt, throughputOwnerClosure, throughputStatus } = await import('../src/throughput.js');
  const stallText = 'needs decision on GY-1470: session-free deliveries cannot accumulate — 0 admitted of 20 deliveries in the window. Decide whether the population rule or the coordination that leaves these fingerprints changes; the budgets stay as GY-87 stated them';
  // The stall was answered in an earlier cycle: its owner is closed with a stall's answer on this release.
  {
    const directory = await temporaryDirectory('throughput-stall-then-miss');
    try {
      const clock = { now: base + 3 * 24 * 60 * minute };
      const answeredStall = { ...openOwner('GY-1470', 2), stage: 'done' } as Work;
      answeredStall.closure = { kind: 'obsolete', reason: throughputOwnerClosure(answeredStall, { revision, verdict: 'unverified' }, 1)!, ref: null, by: 'operator-agent', at: new Date(clock.now - 60 * minute).toISOString(), from: 'backlog' } as Work['closure'];
      assert.equal(throughputAnsweredAt([answeredStall], revision), null, 'an answered stall is not an answered escalated miss');
      const owner = openOwner('GY-1471');
      const work: Work[] = [...accumulated(staleRework(10, null)), answeredStall, owner];
      const { master, state, effects, filed } = await convergenceLoop(directory, work, clock);
      await runCycle(master, state, effects, () => clock.now);
      assert.equal(filed.length, 0);
      assert.equal(state.actions[throughputEscalationKey('GY-1471', 1)]?.state, 'done', 'the escalated miss is asked on the open successor');
      assert.match(state.actions[throughputEscalationKey('GY-1471', 1)]!.detail, /over an accumulating population — 10 admitted/);
      const status = await throughputStatus(directory, { release: { version: '1', revision } }, work, clock.now);
      assert.equal(status.stall?.cause, 'escalated-miss');
      assert.match(status.attention!.next, /graphyard master decide GY-1471 requirements/);
      // Its answer closes the owner naming the escalated miss, which then suppresses a second ask on this release.
      owner.policyRevision = 2;
      clock.now += minute;
      await runCycle(master, state, effects, () => clock.now);
      assert.match(owner.closure!.reason, /raised at its requirements revision 1 on an escalated budget miss\) was answered by its requirements revision 2/);
      assert.equal(throughputAnsweredAt(work, revision), Date.parse(owner.closure!.at));
      assert.equal(filed.length, 1);
      assert.equal(throughputEscalatedAt(state.actions, filed[0]!), null, 'the answered escalated miss is not asked again');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  // The stall is answered in this very cycle: the owner closes on the stall's answer and its successor is asked the escalated miss.
  {
    const directory = await temporaryDirectory('throughput-stall-then-miss-same-cycle');
    try {
      const clock = { now: base + 3 * 24 * 60 * minute };
      const owner = openOwner('GY-1471', 2);
      const work: Work[] = [...accumulated(staleRework(10, null)), owner];
      const { master, state, effects, filed, closed } = await convergenceLoop(directory, work, clock);
      state.actions[throughputEscalationKey('GY-1471', 1)] = { kind: 'escalation', work: 'GY-1471', principal: null, state: 'done', detail: stallText, attempts: 1, epoch: null, cycle: 0, at: new Date(clock.now - 2 * 60 * minute).toISOString() };
      await runCycle(master, state, effects, () => clock.now);
      assert.deepEqual(closed, ['GY-1471'], 'the stall\'s answer closes its owner');
      assert.match(owner.closure!.reason, /raised at its requirements revision 1\) was answered by its requirements revision 2/, 'named as a stall\'s answer');
      assert.equal(filed.length, 1, 'the release stays owned');
      const successor = filed[0]!;
      assert.equal(state.actions[throughputEscalationKey(successor.key, successor.policyRevision)]?.state, 'done', 'the distinct escalated miss is asked on the successor in the same cycle');
      assert.match(state.actions[throughputEscalationKey(successor.key, successor.policyRevision)]!.detail, new RegExp(`needs decision on ${successor.key}: .*over an accumulating population`));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('integration:throughput-owner-converges — after the fix the open owner reaches a closure path within one re-measure: a window whose only miss was GY-468\'s unrunnable superseded span verifies and the loop closes the owner, leaving no unowned unverified claim and no repeating escalation', async () => {
  const { recordThroughputMeasurement, throughputRemeasureMs, throughputStatus, readThroughputMeasurement } = await import('../src/throughput.js');
  const directory = await temporaryDirectory('throughput-owner-converges');
  try {
    const clock = { now: base + 3 * 24 * 60 * minute };
    const owner = openOwner('GY-1471');
    const work: Work[] = [...accumulated(staleRework(5585.6, refusal)), owner];
    const { master, state, effects, filed, closed } = await convergenceLoop(directory, work, clock);
    // The release's newest record before the fix: the same window, the unrunnable span counted.
    const takenAt = clock.now - throughputRemeasureMs;
    const before = verifyThroughput(accumulated(staleRework(5585.6, null)), takenAt, { deployed });
    assert.match(before.reason, /GY-468 left its request-rework actionable and unclaimed for 5585\.6 min/);
    await recordThroughputMeasurement(directory, before);

    await runCycle(master, state, effects, () => clock.now);
    const newest = (await readThroughputMeasurement(directory))!.report;
    assert.equal(newest.measuredAt, new Date(clock.now).toISOString(), 're-measured within one throughputRemeasureMs');
    assert.equal(newest.verdict, 'verified', newest.reason);
    assert.deepEqual(closed, ['GY-1471'], 'the loop closes the owner on the verified measurement');
    assert.match(work.find(item => item.key === 'GY-1471')!.closure!.reason, /throughput claim verified on the serving release/);
    assert.equal(filed.length, 0, 'a verified release needs no successor');
    assert.equal(Object.keys(state.actions).filter(entry => entry.startsWith('escalation:throughput:')).length, 0);
    const status = await throughputStatus(directory, { release: { version: '1', revision } }, work, clock.now);
    assert.equal(status.verdict, 'verified');
    assert.equal(status.attention, null, 'no unverified claim stands, owned or not, and no escalation repeats');
    assert.equal(status.pursuit, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
