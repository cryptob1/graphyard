import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { closeGrounds, convergibleClose, pendingClose, staleAttentionAttempts, staleRun, staleWaitKey } from '../src/model/stale-close.js';
import { terminalDecisions } from '../src/cli/decision-report.js';
import type { MechanicalFixRequest } from '../src/mechanical-findings.js';

// GY-1439: GY-1437's close as a duplicate of GY-1438 was requested at 08:57:03 on 7 October 2026
// against revision 114 and settled stale at 08:58:05 (the item was at 140); the master asked again
// at 09:07:55 against 258 and it settled stale at 09:08:49 (292). In between the loop itself moved
// the item: an independent review approved candidate c4609c37 and, at 09:07:41, the loop authorized
// a mechanical bot-round rework of the very candidate it was closing. The loop now requests a stale
// close again itself, its grounds re-validated against the fresh revision, holds the item's
// advancing steps while a close stands, and names the series once. Each test is named for its proof.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2026-10-07T09:07:41Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const head = 'c4609c37'.padEnd(40, '0'), base = 'b'.repeat(40), reviewId = 5440070483;
const staleOutcome = (now: number) => `Task revision changed (now ${now}); reload and request again; the decision was not applied`;

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/daemon/cycle-decisions.ts'], stage: 'build', revision: 1, policyRevision: 1,
    createdAt: iso(clock - 60 * minute), updatedAt: iso(clock), stageEnteredAt: iso(clock - 60 * minute), ready: true, epoch: 1, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}
/** GY-1437 as it stood at 09:07:41: candidate c4609c37 approved by review 5440070483, freshly observed. */
function reviewed(revision: number, observedAt = clock): Work {
  const candidate = { sha: head, baseSha: base, pr: 911, branch: 'graphyard/gy-1437-1', author: 'implementer' };
  return item('GY-1437', { stage: 'review', revision, candidate, submission: { epoch: 1, pr: 911 },
    observation: { candidate, checks: [], reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: reviewId, submittedAt: iso(clock - 30_000) }],
      merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], at: iso(observedAt), prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true } } as unknown as Partial<Work>);
}
/** The bot round GY-971 planned on that approval: one import-grouping nit. */
const botRound: MechanicalFixRequest = { key: 'GY-1437', pr: 911, head, reviewId, epoch: 1, at: iso(clock - 20_000),
  mechanical: [{ path: 'src/daemon/cycle-decisions.ts', line: 27, category: 'formatting' }], substantive: [], paths: ['src/daemon/cycle-decisions.ts'] } as unknown as MechanicalFixRequest;

type Row = { id: string; work: string; action: string; state: string; input: Record<string, any>; reason: string; requestedBy: string; requestedAt: string; staleAt?: string; outcome: string | null; approvedBy: string | null };

/**
 * A control plane in miniature: the work graph and a decision ledger that judges a close the way
 * server/decisions.ts does — the close binds the item revision it was requested against
 * (decisionInput), and an approval against a moved revision settles it stale.
 */
function world(work: Work[], mechanical: MechanicalFixRequest[] = []) {
  const state = emptyDaemonState(config());
  const ledger: Row[] = [], approvers: { work: string; decision: string }[] = [], wakes: string[] = [];
  const launches: { agentName: string; account: null; runtime: null; session: null; launchedAt: string; work: string; decision: string }[] = [];
  let now = clock, sequence = 0;
  const find = (key: string) => work.find(entry => entry.key === key)!;
  const record = (target: Work, action: string, reason: string, input: Record<string, unknown>, requestedBy: string) => {
    const id = `decision-${++sequence}`;
    ledger.push({ id, work: target.key, action, state: 'requested', input: action === 'close' ? { expectedRevision: target.revision, ...input } : input, reason, requestedBy, requestedAt: iso(now), outcome: null, approvedBy: null });
    return { id };
  };
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: work.map(entry => structuredClone(entry)), now: iso(now) }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    persist: async () => {},
    decide: async (target: Work, action: string, reason: string, input: Record<string, unknown> = {}) => record(target, action, reason, input, 'graphyard-master-agent'),
    approver: async (target: Work, decision: string) => { approvers.push({ work: target.key, decision }); return { agentName: `approver-${decision}`, pane: null }; },
    decisions: async (target: Work) => ({ decisions: ledger.filter(entry => entry.work === target.key).map(entry => ({ ...entry })) }),
    mechanicalFixes: async () => ({ requests: mechanical }),
    approverLaunches: async () => launches,
    observe: async (target: Work) => { wakes.push(target.key); find(target.key).revision += 1; return structuredClone(find(target.key)); },
  } as unknown as DaemonEffects;
  return {
    state, work, ledger, approvers, wakes, find,
    at: (offset: number) => { now = clock + offset; },
    cycle: () => runCycle(config(), state, effects, () => now),
    /** The master's own request, by hand, as `graphyard master decide` makes it, put to an approver with `graphyard master approver`. */
    requestByHand: (key: string, action: string, reason: string, input: Record<string, unknown>) => {
      const made = record(find(key), action, reason, input, 'graphyard-master-agent:hand');
      launches.push({ agentName: `hand-approver-${made.id}`, account: null, runtime: null, session: null, launchedAt: iso(now), work: key, decision: made.id });
      return made;
    },
    /** The control plane moves the item: a review settled, a bot round authorized, an observation refreshed. */
    bump: (key: string, by: number) => { find(key).revision += by; },
    /** The approver approves; the server applies it, or settles it stale on a revision race. */
    approve(id: string) {
      const decision = ledger.find(entry => entry.id === id)!, target = find(decision.work);
      if (decision.input.expectedRevision !== undefined && decision.input.expectedRevision !== target.revision) Object.assign(decision, { state: 'stale', staleAt: iso(now), outcome: staleOutcome(target.revision) });
      else if (decision.action === 'close') { Object.assign(decision, { state: 'applied', approvedBy: 'graphyard-approver' }); Object.assign(target, { stage: 'done', closure: { kind: decision.input.kind, ref: decision.input.ref, reason: decision.reason, by: 'graphyard-approver', at: iso(now), from: target.stage }, revision: target.revision + 1 }); }
      else Object.assign(decision, { state: 'applied', approvedBy: 'graphyard-approver' });
    },
  };
}
const closes = (w: ReturnType<typeof world>) => w.ledger.filter(entry => entry.action === 'close' && entry.work === 'GY-1437');
const reworks = (w: ReturnType<typeof world>) => w.ledger.filter(entry => entry.action === 'rework' && entry.work === 'GY-1437');
const duplicate = { kind: 'duplicate', ref: 'GY-1438' };
const reason = 'GY-1437 duplicates GY-1438, the priority-1 owner of the same fix, so it is closed as its duplicate';

test('unit:decision-stale-apply-revalidates-and-converges — a revision-raced close is re-validated against the fresh item and asked again without its pinned revision, until it applies', () => {
  const owner = item('GY-1438'), closing = reviewed(140);
  const stale = (id: string, expected: number, now: number) => ({ id, action: 'close', state: 'stale', input: { ...duplicate, expectedRevision: expected }, outcome: staleOutcome(now) });
  // The first race: requested against 114, the item at 140 when its approver read it.
  const first = convergibleClose(closing, [stale('b660bfc1', 114, 140)], [closing, owner]);
  assert.ok(first && 'input' in first, `the stale close converges: ${JSON.stringify(first)}`);
  assert.deepEqual(first.input, duplicate, 'the closure it carried is asked again, without the revision it pinned');
  assert.deepEqual(first.race, { expected: 114, current: 140 });
  // The grounds are judged at the fresh revision: a named item that was itself closed, or an item already done, answers nothing.
  const closedOwner = { ...owner, stage: 'done', closure: { kind: 'obsolete', ref: null, reason: 'gone', by: 'x', at: iso(clock), from: 'build' } } as unknown as Work;
  const refused = convergibleClose(closing, [stale('b660bfc1', 114, 140)], [closing, closedOwner]);
  assert.ok(refused && 'refused' in refused && /GY-1438, which the closure names, was itself closed/.test(refused.refused), JSON.stringify(refused));
  assert.match(closeGrounds({ ...closing, stage: 'done' }, duplicate, [owner]) ?? '', /no longer open/);
  assert.match(closeGrounds(closing, duplicate, [closing]) ?? '', /not an item the graph holds/);
  assert.match(closeGrounds(closing, { kind: 'duplicate', ref: 'GY-1437' }, [closing]) ?? '', /of itself/);
  assert.equal(closeGrounds(closing, { kind: 'superseded', ref: 'abc1234' }, []), null, 'a superseding commit is taken as it stands');
  // A triage closure binds its judgement, not the revision: it is not this rule's.
  assert.equal(convergibleClose(closing, [{ id: 't', action: 'close', state: 'stale', input: { ...duplicate, reason: 'x', triageAt: iso(clock) }, outcome: 'no proposed triage closure' }], [closing, owner]), null);
  // The second request, against the fresh revision, stands: the item is being closed, and nothing is asked twice.
  const again = [stale('b660bfc1', 114, 140), { id: '3ffcbacb', action: 'close', state: 'requested', input: { ...duplicate, expectedRevision: 140 }, outcome: null }];
  assert.equal(convergibleClose(closing, again, [closing, owner]), null);
  assert.equal(pendingClose(again)?.id, '3ffcbacb');
  // It applies: the series is over.
  const applied = [again[0]!, { ...again[1]!, state: 'applied' }];
  assert.equal(pendingClose(applied), null);
  assert.deepEqual(staleRun(applied, 'close'), []);
  // A series that reached the bound is the master's.
  const spent = Array.from({ length: staleAttentionAttempts }, (_, index) => stale(`s${index}`, 100 + index, 200 + index));
  const over = convergibleClose(closing, spent, [closing, owner]);
  assert.ok(over && 'refused' in over && /3 close requests in a row settled stale/.test(over.refused), JSON.stringify(over));
});

test('integration:close-applied-despite-two-revision-bumps — a close raced by a review settlement and a mechanical rework is applied by its second attempt, which the loop requests itself', async () => {
  const w = world([reviewed(114), item('GY-1438')]);
  const first = w.requestByHand('GY-1437', 'close', reason, duplicate);
  await w.cycle();
  // Between the request and its approval the item moves twice: the review of c4609c37 settles, and a bot round is authorized.
  w.bump('GY-1437', 26);
  w.bump('GY-1437', 118);
  w.approve(first.id);
  assert.equal(closes(w)[0]!.state, 'stale', 'the first attempt settles stale on the revision race');

  w.at(minute); await w.cycle();
  const [, second] = closes(w);
  assert.ok(second, `the loop requests the close again itself: ${JSON.stringify(w.ledger)}`);
  assert.equal(second.requestedBy, 'graphyard-master-agent', 'requested by the loop, not by the operator');
  assert.equal(second.input.expectedRevision, w.find('GY-1437').revision, 'bound to the revision the loop read afresh');
  assert.equal(second.input.kind, 'duplicate'); assert.equal(second.input.ref, 'GY-1438');
  assert.match(second.reason, /Requested again by the master loop against revision 258: close decision decision-1 settled stale \(expected revision 114, item at 258\) and its grounds still hold/);
  assert.ok(w.approvers.some(entry => entry.work === 'GY-1437' && entry.decision === second.id), `its independent approver is launched: ${JSON.stringify(w.approvers)}`);
  assert.equal(reworks(w).length, 0);

  // Nothing the loop does moves the item while the close stands, so the second attempt applies.
  w.at(2 * minute); await w.cycle();
  w.approve(second.id);
  assert.equal(second.state, 'applied');
  assert.equal(w.find('GY-1437').stage, 'done');
  assert.equal(closes(w).length, 2, 'applied by the second attempt, with no further request');
  assert.equal(closes(w).filter(entry => entry.requestedBy.endsWith(':hand')).length, 1, 'no operator re-request');
  w.at(3 * minute); await w.cycle();
  assert.equal(w.state.actions[staleWaitKey(w.find('GY-1437'), 'close')], undefined, 'the named wait retires once the close applies');
});

test('integration:advancing-steps-defer-to-pending-close — the 09:07:41 mechanical rework of GY-1437 is not authorized while its duplicate-close of GY-1438 is pending', async () => {
  // Without a close, the loop authorizes the bot round on the approved head, as it did at 09:07:41.
  const control = world([reviewed(258), item('GY-1438')], [botRound]);
  await control.cycle();
  assert.equal(reworks(control).length, 1, `the control: the mechanical round is requested: ${JSON.stringify(control.ledger)}`);
  assert.match(reworks(control)[0]!.input.binding, new RegExp(`^${head}:mechanical:${reviewId}$`));

  // With the duplicate-close of GY-1438 requested and unapplied, the same cycle takes nothing on GY-1437.
  const w = world([reviewed(258), item('GY-1438')], [botRound]);
  const close = w.requestByHand('GY-1437', 'close', reason, duplicate);
  const before = w.find('GY-1437').revision;
  await w.cycle();
  assert.deepEqual(reworks(w), [], 'no mechanical bot-round authorization');
  assert.deepEqual(w.wakes, [], 'no observation refresh');
  assert.equal(w.find('GY-1437').revision, before, 'no revision bump under the close');
  assert.match(w.state.actions['wait:closing:work-GY-1437']?.detail ?? '', new RegExp(`close decision ${close.id} stands unapplied, so the loop takes no rework decision on it`));
  // A stale close whose grounds still hold is being closed too: the loop asks it again, and still authorizes nothing.
  w.bump('GY-1437', 34); w.approve(close.id);
  w.at(minute); await w.cycle();
  assert.deepEqual(reworks(w), []);
  assert.equal(closes(w).length, 2);
  // Once the close is refused the item is no longer being closed, and the round is asked for.
  closes(w)[1]!.state = 'refused';
  w.at(2 * minute); w.find('GY-1437').observation!.at = iso(clock + 2 * minute); await w.cycle();
  assert.equal(reworks(w).length, 1, 'the deferral lifts with the close');
});

test('unit:decision-stale-named-wait-single-attention — repeated stale settles record one named wait and raise one attention line only after three attempts', async () => {
  const w = world([reviewed(114), item('GY-1438')]);
  const key = staleWaitKey(w.find('GY-1437'), 'close');
  let latest = w.requestByHand('GY-1437', 'close', reason, duplicate).id;
  await w.cycle();
  const waits: string[] = [];
  for (let attempt = 1; attempt <= staleAttentionAttempts; attempt++) {
    w.bump('GY-1437', 10); w.approve(latest);
    w.at(attempt * minute); await w.cycle();
    waits.push(w.state.actions[key]!.detail);
    latest = closes(w).at(-1)!.id;
  }
  assert.equal(Object.keys(w.state.actions).filter(entry => entry.startsWith('wait:decision-stale:')).length, 1, 'one named wait for the series');
  assert.match(waits[0]!, /^GY-1437's close decision settled stale 1 time\(s\) in a row \(latest decision-1: expected revision 114, item at 124\); the loop requested it again as close decision decision-2 against revision 124 \(request 2 of 3\)$/);
  assert.match(waits[1]!, /settled stale 2 time\(s\) in a row \(latest decision-2: expected revision 124, item at 134\); the loop requested it again/);
  assert.match(waits[2]!, /settled stale 3 time\(s\) in a row \(latest decision-3: expected revision 134, item at 144\); the loop does not request it again: 3 close requests in a row settled stale/);
  assert.equal(closes(w).length, staleAttentionAttempts, 'asked no more once the series reached the bound');

  // master status: no line while the loop carries the series, one stable line once it reaches three, whatever comes after.
  const report = async (count: number) => {
    const rows = closes(w).slice(0, count);
    const work = [{ ...w.find('GY-1437'), stage: 'review' }, w.find('GY-1438')];
    const { attentionItems } = await terminalDecisions(async path => ({ decisions: path.includes('GY-1437') ? rows : [] }), work, { approvals: [], runtime: { available: false, agents: [] }, now: clock });
    return attentionItems.filter(entry => entry.subject === 'GY-1437');
  };
  assert.deepEqual(await report(1), [], 'one stale settle: the loop asks again, its wait names it');
  assert.deepEqual(await report(2), [], 'two: still the loop\'s');
  const raised = await report(3);
  assert.equal(raised.length, 1);
  assert.equal(raised[0]!.text, 'Decision GY-1437/close (close) is stale on 3 or more requests in a row: the item moved between each request and its approval, so the loop no longer requests it again');
  assert.equal(classifyAttention(raised)[0]!.kind, 'decision-stale');
  // A fourth stale settle (the master asked by hand) is the same line, so the same fault instance.
  w.requestByHand('GY-1437', 'close', reason, duplicate); w.bump('GY-1437', 1); w.approve(closes(w).at(-1)!.id);
  assert.deepEqual((await report(4)).map(entry => entry.text), raised.map(entry => entry.text));

  // The wait retires when the decision applies.
  const last = w.requestByHand('GY-1437', 'close', reason, duplicate); w.approve(last.id);
  w.at(10 * minute); await w.cycle();
  assert.equal(w.state.actions[key], undefined);
});
