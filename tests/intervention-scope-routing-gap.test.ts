import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPatterns, foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { exemption, interventionExemptions, type ExemptionMoment } from '../src/intervention-exemptions.js';
import { routedScopeJudgement } from '../src/model/scope-provenance.js';
import { scopeBlockedBudgetMs, scopeRefusalBlocker } from '../src/model/scope.js';
import type { Work } from '../src/model.js';

// GY-1755 names this file for its proof manual:intervention-pattern-scope-widening-build.
//
// On 2026-10-13 the 7-day pattern read four build-stage scope widenings: GY-1746, GY-1747, GY-1752 and
// GY-1751, detected at 00:07:19.555Z. Each linked ask sat the whole span it was counted for inside the
// control plane's own scope cycle, on a live attempt, inside the bound the loop promises
// (scopeBlockedBudgetMs) — and each was counted anyway, because the base exempted only a routed and
// held ask (approver-holds-scope-request, GY-1682) and counted every other refused ask from its own
// instant. The record's rows, read from the ledger:
//
//   - GY-1746 asked 00:06:42.710 (scope#2534057, epoch 3), the widening rule refused it 00:06:51.598
//     (autoscope#2534070) and the loop routed it at 00:15:08.632, where the approver approved it.
//     Detected 28 s into the refusal-to-route gap; counted 36845 ms.
//   - GY-1747 asked 00:05:57.605 (scope#2534029, epoch 6), refused 00:06:42.561 (autoscope#2534055);
//     the loop answered it itself at 00:08:13.185 by its own rule-grounded successor re-plan
//     (requirements#2534099). Detected 37 s into the gap; counted 81950 ms.
//   - GY-1752 asked 00:00:34.913 (scope#2533851, epoch 1), refused 00:04:19.236 (autoscope#2533989);
//     the loop routed it at 00:09:31.144 and the approver declined it at 00:11:05.125, both after the
//     detection. Detected 3 m into the gap; counted 404642 ms.
//   - GY-1751 asked 23:59:27.529 (scope#2533807, epoch 1), refused 23:59:37.082 (autoscope#2533831),
//     and the loop routed it at 00:02:17.961 (decision.requested#2533908, answers naming the ask's
//     epoch and instant) — and the independent approver DECLINED it at 00:04:16.246
//     (decision.declined#2533986, "Refused as filed; re-request narrower"), five minutes before the
//     detection. This is the instance the refusal-to-route gap does not describe: at the detection the
//     ask had been routed and answered. `answerScopeRequest` had rewritten its decision as the
//     approver's refusal, so the routed-ask exemption stopped matching and the base counted the whole
//     span from the ask's own instant — 472026 ms — although a multi-path additive ask a decline
//     leaves the live attempt a narrower ask to make within the bound, which the fault pass does not
//     stand (standingScopeRequest, GY-1757). Counted, the intervention said a person waited; nobody
//     had.
//
// The fold now judges a refused ask as the fault pass does (scope-refusal-within-bound): a live
// attempt's refused ask inside the loop's bound is the loop's cycle or the attempt's narrower re-ask
// to make, whichever decision the record holds on it — unrouted, routed and held
// (approver-holds-scope-request), or answered without applying — and it is counted exactly when
// `standingScopeRequest` stands it: past the bound, after the attempt's end, or a one-path or
// non-additive ask nothing will judge again.

const detectedAt = '2026-10-13T00:07:19.555Z';
const operator = 'graphyard-master-graphyard-operator', approver = 'graphyard-approver-graphyard';
const policy = { threshold: 3, windowDays: 7 };
const criteria = [{ id: 'AC-1', text: 'The change is made', proofs: [] }];
const refusalReason = (paths: string[]) => `${paths.join(', ')} are outside what this item's own criteria and the repository's documentation rule imply; an operator decides scope the item does not already carry`;
const declineReason = 'Refused as filed; re-request narrower. src/daemon/acceptance.ts and src/daemon/state.ts are justified by AC-1 (triage names the acceptance failed-note plane-wide gap and the escalation double count). But the request itself says faults.ts is not touched, so it should not be added. docs/ is a root-level directory scope that admits any file, and no reason is given why a named doc cannot do. Re-request only acceptance.ts, state.ts, and the one specific doc file that states fault counting (e.g. docs/operations-reference.md) without the broad-scope flag, plus the test files already planned.';
const firstAsk = ['src/daemon/acceptance.ts', 'src/daemon/faults.ts', 'docs/'];

/** Each work's id is the record's own, so a faithful fold reproduces the linked instance's exact id `scope-widening:<work id>:<scope seq>`. Lease expiries stand for the live attempts the record shows (each worker re-asked seconds before, and each attempt held its lease past the detection). */
const instances = [
  {
    key: 'GY-1746', id: '944f3a8d-c3f1-433f-b01d-2535a5d64f59', epoch: 3, worker: 'graphyard-opencode-2',
    planned: ['src/worker-sandbox.ts', 'src/master/profiles.ts', 'src/install/runtimes.ts', 'src/auto-dispatch.ts', 'tests/pi-worker-dispatch.test.ts', 'docs/master-agent-reference.md', 'tests/helpers/timing-baseline.json', 'tests/no-wall-clock-time-bombs.test.ts', 'tests/docs-budget.test.ts', 'src/fleet.ts', 'src/master/dispatch.ts', 'docs/delegation.md', 'docs/master-agent-sessions.md', 'src/model/registry.ts', 'src/model/registry-sessions.ts', 'src/model/registry-proposal.ts', 'src/install/host.ts', 'tests/soak-dispatch.test.ts', 'tests/install-host.test.ts', 'tests/host-install.test.ts', 'tests/helpers/soak-plane.ts', 'tests/helpers/soak-simulation.ts', 'tests/runtime-screens.test.ts'],
    asked: ['tests/registry-discovery.test.ts'], askedAt: '2026-10-13T00:06:42.710Z', scopeSeq: 2534057, autoscopeSeq: 2534070, refusedAt: '2026-10-13T00:06:51.598Z',
    route: null, declined: null, earlier: [{ seq: 2534021, at: '2026-10-13T00:05:39.388Z', paths: ['tests/registry-discovery.test.ts'] }, { seq: 2534048, at: '2026-10-13T00:06:38.739Z', paths: ['tests/registry-discovery.test.ts'] }],
    lease: '2026-10-13T00:20:00.000Z', requestedAt: '2026-10-13T00:06:42.710Z', waitedMs: 36845,
  },
  {
    key: 'GY-1747', id: '32349c5d-06e2-493d-9780-74829d99baee', epoch: 6, worker: 'graphyard-codex-1',
    planned: ['src/master-verification.ts', 'src/executor.ts', 'tests/post-deploy-follow-up-release.test.ts', 'docs/delivery.md', 'tests/helpers/timing-baseline.json', 'tests/no-wall-clock-time-bombs.test.ts', 'tests/docs-budget.test.ts', 'scripts/graphyard-executor.mjs', 'docs/deployment.md', 'src/cli/master/operations.ts'],
    asked: ['tests/post-deploy-criteria.test.ts', 'tests/post-deploy-follow-ups.test.ts'], askedAt: '2026-10-13T00:05:57.605Z', scopeSeq: 2534029, autoscopeSeq: 2534055, refusedAt: '2026-10-13T00:06:42.625Z',
    route: null, declined: null, earlier: [],
    lease: '2026-10-13T00:09:00.000Z', requestedAt: '2026-10-13T00:05:57.605Z', waitedMs: 81950,
  },
  {
    key: 'GY-1752', id: 'fb3b6fa7-a42f-4281-abb7-fa31bb759eac', epoch: 1, worker: 'graphyard-opencode-1',
    planned: ['tests/fault-class-loop.test.ts', 'tests/helpers/timing-baseline.json', 'tests/no-wall-clock-time-bombs.test.ts'],
    asked: ['src/auto-dispatch.ts', 'docs/'], askedAt: '2026-10-13T00:00:34.913Z', scopeSeq: 2533851, autoscopeSeq: 2533989, refusedAt: '2026-10-13T00:04:19.236Z',
    route: null, declined: null, earlier: [],
    lease: '2026-10-13T00:10:00.000Z', requestedAt: '2026-10-13T00:00:34.913Z', waitedMs: 404642,
  },
  {
    key: 'GY-1751', id: 'e4283353-db1f-418d-83e8-4e9abdedee00', epoch: 1, worker: 'graphyard-claude-2',
    planned: ['tests/fault-class-decision.test.ts', 'tests/helpers/timing-baseline.json', 'tests/no-wall-clock-time-bombs.test.ts'],
    asked: ['src/daemon/acceptance.ts', 'src/daemon/state.ts'], askedAt: '2026-10-12T23:59:27.529Z', scopeSeq: 2533807, autoscopeSeq: 2533831, refusedAt: '2026-10-12T23:59:37.082Z',
    route: { seq: 2533908, id: 'b2d6f5b7-36b0-48c1-8e98-f01b595377fa', at: '2026-10-13T00:02:17.961Z' }, declined: { seq: 2533986, at: '2026-10-13T00:04:16.246Z' },
    earlier: [{ seq: 2533741, at: '2026-10-12T23:56:21.661Z', paths: firstAsk }, { seq: 2533760, at: '2026-10-12T23:57:19.157Z', autoscope: true, paths: firstAsk }],
    lease: '2026-10-13T00:12:00.000Z', requestedAt: '2026-10-12T23:59:27.529Z', waitedMs: 472026,
  },
] as const;

/** The widening rule's refusal, as each autoscope row holds it (GY-1751's names the merged ask's four paths). */
const ruleRefusal = (askedAt: string, epoch: number, worker: string, refusedAt: string, paths: readonly string[]) => ({
  at: refusedAt, epoch, paths: [...paths], state: 'refused' as const, reason: refusalReason([...paths]), waitedMs: 1000, decidedBy: 'graphyard', treeRead: true, requestedAt: askedAt, requestedBy: worker,
});

/** The item as the snapshot held it at the detection instant, and the rows the detection-time read of the ledger held: every row written after the detection is absent, as it was absent then. */
function record(entry: typeof instances[number]) {
  const asked = [...entry.asked], refusedPaths = entry.key === 'GY-1751' ? [...firstAsk, ...entry.asked.slice(1)] : asked;
  const refusal = ruleRefusal(entry.askedAt, entry.epoch, entry.worker, entry.refusedAt, refusedPaths);
  const decision = entry.key === 'GY-1751'
    ? { state: 'refused' as const, decidedBy: approver, at: entry.declined!.at, reason: declineReason, waitedMs: 288717, paths: asked, requestedAt: entry.askedAt, requestedBy: entry.worker, epoch: entry.epoch }
    : refusal;
  const blocker = entry.key === 'GY-1751'
    ? `${scopeRefusalBlocker} by the independent approver ${approver} (decision ${entry.route!.id}): ${declineReason}`.slice(0, 2000)
    : `Scope request refused: ${refusalReason(asked)}`;
  const work = {
    id: entry.id, key: entry.key, title: entry.key, stage: 'build', epoch: entry.epoch, plannedFiles: [...entry.planned], criteria, escalations: [], violations: [],
    lease: { owner: entry.worker, epoch: entry.epoch, expiresAt: entry.lease },
    scopeRequest: { epoch: entry.epoch, paths: asked, reason: 'needed', requestedBy: entry.worker, at: entry.askedAt, decision },
    blocker,
  } as unknown as Work;
  const asItWasRefused = entry.key === 'GY-1751'
    ? { ...work, scopeRequest: { ...(work as unknown as { scopeRequest: object }).scopeRequest, decision: refusal }, blocker: `Scope request refused: ${refusalReason(refusedPaths)}` } as unknown as Work
    : work;
  const rows: InterventionLedgerRow[] = [
    ...entry.earlier.map(row => 'autoscope' in row && row.autoscope ? {
      seq: row.seq, workId: entry.id, actor: 'graphyard-master', kind: 'autoscope', at: row.at, stageBefore: 'build',
      details: { epoch: entry.epoch, before: { blocker: null, plannedFiles: [...entry.planned] }, decision: ruleRefusal(row.at, entry.epoch, entry.worker, row.at, row.paths) },
      work: { key: entry.key, title: entry.key, stage: 'build', epoch: entry.epoch, plannedFiles: [...entry.planned], blocker: `Scope request refused: ${refusalReason([...row.paths])}` },
    } : {
      seq: row.seq, workId: entry.id, actor: entry.worker, kind: 'scope', at: row.at, stageBefore: 'build',
      details: { epoch: entry.epoch, paths: [...row.paths], reason: 'needed' },
      work: { key: entry.key, title: entry.key, stage: 'build', epoch: entry.epoch, plannedFiles: [...entry.planned], blocker: null },
    }),
    { seq: entry.scopeSeq, workId: entry.id, actor: entry.worker, kind: 'scope', at: entry.askedAt, stageBefore: 'build', details: { epoch: entry.epoch, paths: asked, reason: 'needed' }, work: { key: entry.key, title: entry.key, stage: 'build', epoch: entry.epoch, plannedFiles: [...entry.planned], blocker: null } },
    { seq: entry.autoscopeSeq, workId: entry.id, actor: 'graphyard-master', kind: 'autoscope', at: entry.refusedAt, stageBefore: 'build', details: { epoch: entry.epoch, before: { blocker: null, plannedFiles: [...entry.planned] }, decision: refusal }, work: { key: entry.key, title: entry.key, stage: 'build', epoch: entry.epoch, plannedFiles: [...entry.planned], blocker: `Scope request refused: ${refusalReason(asked)}` } },
  ];
  if (entry.route) rows.push({
    seq: entry.route.seq, workId: entry.id, actor: operator, kind: 'decision.requested', at: entry.route.at, stageBefore: 'build', details: null, work: null,
    payload: {
      id: entry.route.id, action: 'requirements',
      input: { plannedFiles: [...entry.planned, ...firstAsk, ...entry.asked.slice(1)], answers: { epoch: entry.epoch, at: entry.askedAt } },
      reason: `Widen ${entry.key}'s plannedFiles with ${firstAsk.join(', ')}, ${entry.asked.slice(1).join(', ')}: ${routedScopeJudgement}`,
      requester: { role: 'operator-agent' },
    },
  });
  if (entry.declined) rows.push({
    seq: entry.declined.seq, workId: entry.id, actor: approver, kind: 'decision.declined', at: entry.declined.at, stageBefore: 'build', details: null, work: null,
    payload: { id: entry.route!.id, action: 'requirements', reason: declineReason, requestedBy: operator, approver: { id: approver, role: 'operator-agent' } },
  });
  // The ask as the fold's scope and autoscope rules build it from those rows: the linked instance is this ask counted from its own instant.
  const foldedAsk = {
    seq: entry.scopeSeq, at: entry.askedAt, stage: 'build' as const, kind: 'scope-request' as const, blocked: `files outside plannedFiles: ${asked.join(', ')}`,
    paths: asked, trigger: 'refused-by-loop', epoch: entry.epoch, askedAt: entry.askedAt, routed: null, sources: [{ seq: entry.scopeSeq, kind: 'scope' }, { seq: entry.autoscopeSeq, kind: 'autoscope' }],
  };
  return { raw: entry, work, asItWasRefused, rows, foldedAsk, requestedAt: entry.requestedAt, waitedMs: entry.waitedMs, key: entry.key };
}

const linked = instances.map(record);
const moment = (entry: ReturnType<typeof record>, now: string): ExemptionMoment => ({ at: 'open-ask', ask: entry.foldedAsk, item: entry.work, now });
const widenings = (rows: InterventionLedgerRow[], work: Work, now: string) => foldInterventions(rows, [work], now).interventions.filter(entry => entry.kind === 'scope-widening' && entry.stage === 'build');
/** The base judged these moments by these rules minus this head's one addition: what it exempted is what the others exempt, so `null` here is the base counting the ask from its own instant. */
const baseExempts = (moment: ExemptionMoment) => interventionExemptions.filter(rule => rule.name !== 'scope-refusal-within-bound').find(rule => rule.exempts(moment))?.name ?? null;
const liveLease = (entry: ReturnType<typeof record>) => ({ ...entry.work, lease: { owner: entry.raw.worker, epoch: entry.raw.epoch, expiresAt: '2026-10-13T02:00:00.000Z' } }) as Work;

test('manual:intervention-pattern-scope-widening-build — each linked instance is reproduced from its actual ledger rows: the rows fold into exactly the recorded instance, and the base\'s rules exempt nothing on the moment the fold judges', () => {
  for (const entry of linked) {
    // With the attempt's lease gone both base and candidate count the ask: the rows alone produce the linked instance — same id, same instant, same wait, same sources, same trigger.
    const [emitted] = widenings(entry.rows, { ...entry.work, lease: null } as Work, detectedAt);
    assert.deepEqual({ id: emitted.id, requestedAt: emitted.requestedAt, waitedMs: emitted.waitedMs, sources: emitted.sources, trigger: emitted.trigger, blocked: emitted.blocked }, {
      id: `scope-widening:${entry.raw.id}:${entry.raw.scopeSeq}`, requestedAt: entry.requestedAt, waitedMs: entry.waitedMs,
      sources: [{ seq: entry.raw.scopeSeq, kind: 'scope' }, { seq: entry.raw.autoscopeSeq, kind: 'autoscope' }],
      trigger: 'refused-by-loop', blocked: `files outside plannedFiles: ${entry.raw.asked.join(', ')}`,
    }, `${entry.key}: the rows are the linked instance`);
    // The base judged the very moment the candidate's fold judges at the detection instant and exempted nothing: counted from the ask's own instant, exactly as the pattern links it.
    assert.equal(baseExempts(moment(entry, detectedAt)), null, `${entry.key}: the base counted it`);
  }
});

test('manual:intervention-pattern-scope-widening-build — GY-1751 was counted past its route, not inside any gap: held by the approver at 00:03, declined at 00:04:16, read by the pattern at 00:07:19 with its live attempt still owing a narrower re-ask inside the bound', () => {
  const entry = linked[3];
  // Between the route and the decline the record showed the loop's decision standing on the ask: the base held it for the approver and counted nothing — approver-holds-scope-request.
  const before = foldInterventions(entry.rows.filter(row => row.seq < entry.raw.declined!.seq), [entry.asItWasRefused], '2026-10-13T00:03:00.000Z').interventions.filter(item => item.kind === 'scope-widening');
  assert.deepEqual(before, [], 'the approver held the ask: no instance, base and candidate alike');
  assert.equal(exemption({ at: 'open-ask', ask: { ...entry.foldedAsk, routed: { seq: entry.raw.route!.seq, at: entry.raw.route!.at, decision: entry.raw.route!.id } }, item: entry.asItWasRefused, now: '2026-10-13T00:03:00.000Z' }), 'approver-holds-scope-request');
  // The decline settled the routed decision and `answerScopeRequest` rewrote the ask's decision as the approver's refusal: the base's routed-ask exemption stopped matching, and the base counted the whole span from the ask's own instant — the exact instance the pattern links.
  assert.equal(baseExempts(moment(entry, detectedAt)), null, 'after the decline the base counted it');
  // The candidate judges the ask as the fault pass does: a multi-path additive ask the approver declined leaves the live attempt a narrower ask to make within the bound, so no instance stands.
  assert.deepEqual(widenings(entry.rows, entry.work, detectedAt), [], 'the candidate counts nothing');
  assert.equal(exemption(moment(entry, detectedAt)), 'scope-refusal-within-bound');
  // The class removed is the in-bound counting, not the standing wait: the same declined ask outlasting the bound the loop promises is somebody's again, and a one-path ask the approver declined has nothing narrower to re-ask (GY-1757) and counts at once.
  const past = new Date(Date.parse(entry.raw.askedAt) + scopeBlockedBudgetMs + 60_000).toISOString();
  assert.equal(widenings(entry.rows, liveLease(entry), past).length, 1, 'past the bound it counts again');
  const onePath = ['src/daemon/acceptance.ts'];
  const scopeRequest = (entry.work as unknown as { scopeRequest: { decision: object } }).scopeRequest;
  const one = { ...entry.work, scopeRequest: { ...scopeRequest, paths: onePath, decision: { ...scopeRequest.decision, paths: onePath } } } as unknown as Work;
  assert.equal(widenings(entry.rows, one, detectedAt).length, 1, 'a one-path declined ask counts');
});

test('manual:intervention-pattern-scope-widening-build — the other three linked instances were counted inside the refusal-to-route gap; the candidate leaves each uncounted at the same instant, and the four no longer cross the threshold', () => {
  for (const entry of linked.slice(0, 3)) {
    assert.deepEqual(widenings(entry.rows, entry.work, detectedAt), [], `${entry.key}: no instance at the detection instant`);
    assert.equal(exemption(moment(entry, detectedAt)), 'scope-refusal-within-bound', entry.key);
    assert.equal(baseExempts(moment(entry, detectedAt)), null, `${entry.key}: the base counted it`);
    // Past the bound the loop promises, the same ask is counted from its own instant: the class the item removes is the in-bound counting, not the standing wait.
    const past = new Date(Date.parse(entry.raw.askedAt) + scopeBlockedBudgetMs + 60_000).toISOString();
    assert.equal(widenings(entry.rows, liveLease(entry), past).length, 1, `${entry.key} past the bound`);
  }
  const works = linked.map(entry => entry.work), allRows = linked.flatMap(entry => entry.rows);
  const fixed = foldInterventions(allRows, works, detectedAt).interventions.filter(item => item.kind === 'scope-widening' && item.stage === 'build');
  assert.deepEqual(fixed, [], 'no build-stage scope widening stands at the detection instant');
  const pattern = detectPatterns(fixed, works, policy, detectedAt).find(entry => entry.kind === 'scope-widening' && entry.stage === 'build');
  assert.ok(!pattern || pattern.count < policy.threshold, 'the pattern is below the threshold');
  // The same rows, judged standing (each lease gone), are four instances past the threshold: the rows carry the pattern; the in-bound judgement is what dropped it.
  const gone = works.map(work => ({ ...work, lease: null }) as Work);
  const counted = foldInterventions(allRows, gone, detectedAt).interventions.filter(item => item.kind === 'scope-widening' && item.stage === 'build');
  assert.equal(counted.length, instances.length, 'the rows alone still hold all four');
  assert.ok(detectPatterns(counted, gone, policy, detectedAt).find(entry => entry.kind === 'scope-widening' && entry.stage === 'build')!.count >= policy.threshold, 'judged standing, they cross it as they did');
});

test('manual:intervention-pattern-scope-widening-build — a loop that cannot route a refused ask stands it at once, as the fault pass does: the fold counts it inside the bound when routes is false', () => {
  for (const entry of linked.slice(0, 3)) {
    assert.equal(exemption({ ...moment(entry, detectedAt), routes: false } as ExemptionMoment), null, `${entry.key}: no route, so no in-bound exemption`);
    assert.equal(foldInterventions(entry.rows, [entry.work], detectedAt, { routes: false }).interventions.filter(item => item.kind === 'scope-widening').length, 1, `${entry.key}: counted without a route`);
    assert.deepEqual(foldInterventions(entry.rows, [entry.work], detectedAt, { routes: true }).interventions.filter(item => item.kind === 'scope-widening'), [], `${entry.key}: uncounted with a route`);
  }
});

test('manual:intervention-pattern-scope-widening-build — readLoopRoutes needs a distinct operator and approver pair, not one agent or any two', async () => {
  const { readLoopRoutes } = await import('../src/interventions/report.js');
  const { masterOperatorCapabilities, approverAgentCapabilities } = await import('../src/master/harness.js');
  const pool = (routes: boolean | null) => ({ query: async (text: string, params: string[]) => {
    assert.match(text, /a\.id <> r\.id/, 'the requester and approver are different agents');
    assert.match(text, /revokedAt/);
    assert.deepEqual(JSON.parse(params[0]!), [...masterOperatorCapabilities]);
    assert.deepEqual(JSON.parse(params[1]!), [...approverAgentCapabilities]);
    assert.match(text, /NOT \(r\.document->'capabilities' \? 'decision:approve'\)/, 'the requester does not itself approve');
    assert.match(text, /NOT \(a\.document->'capabilities' \? 'decision:rework'\)/, 'the approver does not itself request');
    return { rows: routes === null ? [] : [{ routes }] };
  } }) as never;
  assert.equal(await readLoopRoutes(pool(true)), true);
  assert.equal(await readLoopRoutes(pool(false)), false);
  assert.equal(await readLoopRoutes(pool(null)), false, 'no row');
});
