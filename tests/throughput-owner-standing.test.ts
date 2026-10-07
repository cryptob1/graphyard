import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionRow } from '../src/model/actions.js';
import type { Work } from '../src/model.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { openThroughputOwner, populationRule, throughputClaimVisibility, throughputOwnerItem, throughputStall, throughputStallBound, verifyThroughput, type ThroughputReport } from '../src/throughput.js';
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
  } finally { await rm(directory, { recursive: true, force: true }); }
});
