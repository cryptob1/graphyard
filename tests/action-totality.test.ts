import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { evaluate, type Gate, type Observation, type Principal, type Work } from '../src/model.js';
import { actionIdleMs } from '../src/model/actions.js';
import { reconcileAutoDispatch, reviewNeed } from '../src/model/dispatch.js';
import { actionAccount, actionJudgment, gateRefusalCatalogue, nextAction, refusalAction, refusalRuleFor, refusalRuleIndex } from '../src/model/next-action.js';
import { accountOutcome, actionlessItems, stallBoundMs, stalledItems, type AccountOutcome } from '../src/model/action-account.js';
import { stalledItemAttention } from '../src/cli/master-status.js';
import { actionableSubjects } from '../src/master-daemon.js';
import { actionlessCards, stalledCards } from '../web/pages/actionless.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import OverviewPage from '../web/pages/overview.js';
import { boardFromStatus } from '../src/model/board.js';

/**
 * GY-106: an item may not hold a failing gate with no action computed and nobody told.
 *
 * Three proofs, one per criterion:
 *
 * - `integration:no-failing-gate-without-action` drives an item into the GY-103 state — a review
 *   gate refusing while no review request stands — under every review provider, and asserts the
 *   control plane names an action or an explicit wait for each of them, never silence.
 * - `integration:action-mapping-total-over-states` runs the real gate evaluator over a battery of
 *   states, collects every refusal it words, and proves totality over outcomes rather than over
 *   rules: every refusal is a declared shape, every shape maps inside its declared kinds, every
 *   rule is reachable, and no state yields an item with a failing gate and no answer.
 * - `unit:actionless-item-visible` asserts an item with no action and nothing moving it is named
 *   by master status, by the coordination loop's inventory and by the dashboard, with how long it
 *   has held its gate and what is missing — counted apart from items waiting on another item.
 */

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const PROOF = 'integration:totality';
const CI_APP = 15368;
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  // An offset no other test file takes: two files sharing a port fail whichever starts its
  // Postgres second, in its `before` hook, with no reason given.
  const port = Number(process.env.GRAPHYARD_ACTION_TOTALITY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 106);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-action-totality-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [CI_APP], 120, 'owner/project');
  engine.principals = [operator, worker];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

let sequence = 0;
async function submitted() {
  let item = await engine.execute(operator, 'create', null, { title: `Totality ${++sequence}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/totality/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}` }, randomUUID());
  return engine.execute(worker, 'submit', item.id, { epoch: item.epoch, pr: 100 + sequence }, randomUUID());
}

/** The provider's view of a candidate: approved, both checks green, mergeable, protected, in scope. */
function observation(item: Work, overrides: Partial<Observation> = {}): Observation {
  return {
    clockOffset: { min: 0, max: 0 },
    candidate: { sha: head, baseSha: base, pr: item.submission!.pr, branch: item.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: CI_APP }, { name: 'typecheck', result: 'success', appId: CI_APP }],
    reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: new Date().toISOString(),
    prState: 'open', draft: false, baseTip: base, baseTree: sha40('7e'), baseTipContained: true, ...overrides,
  };
}
/** An item with an observed candidate, as the control plane holds it. */
async function candidate(overrides: Partial<Observation> = {}) {
  const item = await submitted();
  return engine.observe(item.id, item.revision, observation(item, overrides));
}

// ---- AC-1: no open item holds a failing gate with nothing named -------------------------------

test('integration:no-failing-gate-without-action — an item whose review gate refuses while no review request stands is named an action or an explicit wait, under every provider, and never left silent', async () => {
  const now = new Date();
  // The GY-103 state, four ways. In each one the review gate refuses and `reviewNeed` answers
  // that no launched reviewer can be asked for this head, so `reconcileAutoDispatch` opens no
  // request. Before this, three of the four produced the refusal "a review is required" and an
  // action nothing could ever settle; the fourth produced no action at all.
  const item = await candidate({ reviews: [] });
  const profiles = [{ name: 'reviewer-a', runtime: 'claude', reviewerApp: 'app-a', timeoutSeconds: 1800 }];
  const graded = (probe: Work, all: Work[] = []): Work => {
    const result = evaluate(probe, [...all, probe], now, [CI_APP]);
    return { ...probe, stage: result.stage, gates: result.gates, violations: result.violations, queue: result.queue, queueSequence: result.queueSequence, queueEjection: result.queueEjection, queueHistory: result.queueHistory };
  };
  // The head's mechanical proofs have passed: review follows them (GY-115), so the provider states
  // below are the ones a proven head reaches.
  const provenHead = [{ id: randomUUID(), proof: PROOF, sha: head, baseSha: base, policyRevision: item.policyRevision, producer: 'ci-runner', trusted: true, result: 'pass' as const, executed: 3, skipped: 0, at: now.toISOString() }];
  const states: { name: string; work: Work; kind: string }[] = [
    { name: 'a reviewer requested changes on exactly this head', kind: 'request-rework',
      work: graded({ ...item, observation: { ...item.observation!, reviews: [{ reviewer: 'reviewer', sha: head, state: 'CHANGES_REQUESTED' }] } } as Work) },
    // GY-191: behind alone is reviewed as it stands; only a head that conflicts with the base is withheld.
    { name: 'the head does not contain the base tip and conflicts with it, so it needs a sync', kind: 'resync',
      work: graded({ ...item, observation: { ...item.observation!, baseTipContained: false, mergeable: false, conflicting: true } } as Work) },
    { name: 'the control plane dispatches this provider through its own observation job', kind: 'resync',
      work: graded({ ...item, evidence: provenHead, policy: { ...item.policy, reviewProvider: 'codex' } } as Work) },
    { name: 'every configured reviewer profile is exhausted', kind: 'escalate',
      work: graded({ ...item, evidence: provenHead, policy: { ...item.policy, reviewProvider: 'agent', reviewerProfiles: profiles },
        reviewFailovers: [{ profile: 'reviewer-a', reviewerApp: 'app-a', runtime: 'claude', exhaustion: 'usage-limit', reason: 'the account is out of quota', at: now.toISOString(), sha: head, baseSha: base, policyRevision: item.policyRevision, requestCommentId: 7, nextProfile: null }] } as Work) },
  ];
  for (const state of states) {
    const review = state.work.gates.find(gate => gate.name === 'review')!;
    assert.equal(review.passed, false, `${state.name}: the review gate refuses`);
    // The dispatcher opens no request for this head, which is what makes the state silent.
    const dispatching = { ...state.work, autoDispatch: undefined } as Work;
    reconcileAutoDispatch(dispatching, [dispatching], now);
    assert.equal(dispatching.autoDispatch!.review, null, `${state.name}: no review request stands`);
    assert.equal(reviewNeed(state.work).needed, false, `${state.name}: no launched reviewer can answer this head`);

    const account = actionAccount(state.work, [state.work], now);
    assert.equal(account.defect, null, `${state.name}: the control plane accounts for the state`);
    assert.equal(accountOutcome(account), 'action', `${state.name}: an action is named`);
    assert.equal(account.action!.kind, state.kind, state.name);
    assert.equal(account.gate, 'review');
    assert.ok(account.action!.reason.length > 0 && account.action!.refusal, `${state.name}: the action names the gate and the refusal it answers`);
  }

  // The general invariant, over every item the store holds plus the four states above: an open
  // item either names an action, or names what it waits on, or records a human need. Nothing is
  // an unexplained absence, and nothing is answered by a fabricated action either.
  const all = [...await store.list(), ...states.map(state => state.work)];
  for (const probe of all) {
    const account = actionAccount(probe, all, now);
    assert.equal(account.defect, null, `${probe.key}: ${account.defect}`);
    assert.ok(['action', 'waiting-on', 'human', 'settled'].includes(accountOutcome(account)), probe.key);
    const failing = probe.gates.find(gate => !gate.passed);
    if (failing && probe.ready && probe.stage !== 'done')
      assert.notEqual(accountOutcome(account), 'settled', `${probe.key} refuses at ${failing.name} and cannot be settled`);
    assert.deepEqual(nextAction(probe, all, now), account.action, `${probe.key}: one computation, read two ways`);
  }

  // And the state that has no answer is reported as a defect rather than as silence: a gate that
  // refuses without saying why produces nothing anybody can compute from, and says exactly that.
  const mute = { ...item, gates: item.gates.map(gate => gate.name === 'review' ? { name: 'review', passed: false, reasons: [] as string[] } : gate) } as Work;
  const muteAccount = actionAccount(mute, [mute], now);
  assert.equal(muteAccount.action, null, 'no action is invented for a state no rule answers');
  assert.equal(muteAccount.wait, null);
  assert.equal(accountOutcome(muteAccount), 'unaccounted');
  assert.match(muteAccount.defect!, /the review gate refuses with no reason recorded/);
  assert.equal(muteAccount.gate, 'review');
});

// ---- AC-2: totality over outcomes, not over rules ---------------------------------------------

/** Every refusal the evaluator worded for one probe, gate by gate. */
const refusalsOf = (work: Work) => work.gates.flatMap(gate => gate.reasons.map(refusal => ({ gate: gate.name, refusal })));

test('integration:action-mapping-total-over-states — every refusal the engine can word is a declared shape that maps to an action an executor can complete, an explicit dependency, or a recorded human need', async () => {
  const now = new Date();
  const item = await candidate();
  const other = await candidate();
  const grade = (probe: Work, all: Work[]): Work => {
    const result = evaluate(probe, all, now, [CI_APP]);
    return { ...probe, stage: result.stage, gates: result.gates, violations: result.violations, queue: result.queue, queueSequence: result.queueSequence, queueEjection: result.queueEjection, queueHistory: result.queueHistory };
  };
  const unproven = { ...item, evidence: [] } as Work;
  const proven = {
    ...item, evidence: [{ id: randomUUID(), proof: PROOF, sha: head, baseSha: base, policyRevision: item.policyRevision, producer: 'ci-runner', trusted: true, result: 'pass' as const, executed: 3, skipped: 0, at: now.toISOString() }],
  } as Work;
  const profiles = [{ name: 'reviewer-a', runtime: 'claude', reviewerApp: 'app-a', timeoutSeconds: 1800 }];
  const scopeFile = { path: 'src/other.ts', status: 'modified' as const, sha: sha40('11'), baseSha: sha40('22'), additions: 0, deletions: 4, binary: false };
  const landingFile = { path: 'src/a.ts', status: 'removed' as const, sha: null, baseSha: sha40('33'), additions: 0, deletions: 0, binary: false };
  // A bootstrap deferral another item made on a contract this one's planned files touch.
  const deferrer = { ...other, id: randomUUID(), key: 'GY-BOOT', criteria: [{ id: 'AC-9', text: 'Deferred', proofs: ['unit:contract'], bootstrap: { reason: 'bootstrap', contractPaths: ['src/'], declaredBy: 'operator', declaredAt: now.toISOString(), policyRevision: 1 } }] } as Work;
  // Two proven candidates hold queue entries, so the one behind is sequenced behind the one ahead.
  const queueEntry = (work: Work, sequence: number) => ({ ...work, queue: { sequence, enqueuedAt: now.toISOString(), policyRevision: work.policyRevision, speculation: null }, queueSequence: sequence } as Work);
  const ahead = queueEntry({ ...proven, id: randomUUID(), key: 'GY-AHEAD' } as Work, 1);
  const behind = queueEntry({ ...proven, id: randomUUID(), key: 'GY-BEHIND' } as Work, 2);

  const waiting = { ...proven, id: randomUUID(), key: 'GY-WAITING', queueEjection: { at: now.toISOString(), sequence: 3,
    reason: `Speculative merge of ${head.slice(0, 12)} into graphyard/gy-waiting-1 conflicts and cannot be resolved by Graphyard`, sha: head, policyRevision: proven.policyRevision, predecessors: ['GY-AHEAD'] } } as Work;

  // The battery. Each entry is a real work document put through the real evaluator, so every
  // refusal below is the engine's own wording rather than a string this test invented.
  const world: Work[] = [ahead, behind, deferrer];
  const probes: { name: string; work: Work; all?: Work[] }[] = [
    { name: 'backlog', work: { ...unproven, ready: false } as Work },
    { name: 'unfinished dependency', work: { ...unproven, dependencies: [other.id] } as Work, all: [other, unproven] },
    { name: 'recorded blocker', work: { ...unproven, blocker: 'The staging database is unreachable' } as Work },
    { name: 'nothing submitted', work: { ...unproven, submission: null, candidate: null, observation: null, workspaces: [] } as Work },
    { name: 'submitted but unobserved', work: { ...unproven, candidate: null, observation: null } as Work },
    { name: 'base refresh conflicted', work: { ...unproven, baseRefresh: { from: { sha: head, baseSha: base }, base, baseTree: sha40('7e'), policyRevision: unproven.policyRevision, at: now.toISOString(), head: null,
      conflict: `Candidate ${head.slice(0, 12)} cannot be brought onto base branch tip ${base.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved: merge conflict. Run graphyard sync ${unproven.key}, resolve it and push; the approval and proofs bound to ${head.slice(0, 12)} do not survive the resolution.` } } as Work },
    { name: 'diff never compared', work: { ...unproven, observation: { ...unproven.observation!, scopeFiles: undefined } } as Work },
    { name: 'out of scope against the bound base', work: { ...unproven, plannedFiles: ['docs/'], observation: { ...unproven.observation!, scopeFiles: [scopeFile] } } as Work },
    { name: 'would revert work on the commit it lands on', work: { ...unproven, plannedFiles: ['docs/'], observation: { ...unproven.observation!, scopeFiles: [], landing: { base: sha40('cc'), files: [landingFile] } } } as Work },
    // A unit or integration proof that failed on the head returns it to its worker before review (GY-115).
    { name: 'mechanical proof failed', work: { ...unproven, evidence: [{ ...proven.evidence[0], id: randomUUID(), result: 'fail' as const }] } as Work },
    { name: 'no approval', work: { ...unproven, observation: { ...unproven.observation!, reviews: [] } } as Work },
    { name: 'requirement-review baseline', work: { ...unproven, formalReviewResetRequired: true, observation: { ...unproven.observation!, reviews: [] } } as Work },
    { name: 'changes requested', work: { ...unproven, observation: { ...unproven.observation!, reviews: [{ reviewer: 'reviewer', sha: head, state: 'CHANGES_REQUESTED' }] } } as Work },
    { name: 'codex provider', work: { ...unproven, policy: { ...unproven.policy, reviewProvider: 'codex' }, observation: { ...unproven.observation!, reviews: [] } } as Work },
    { name: 'codex reason of its own', work: { ...unproven, policy: { ...unproven.policy, reviewProvider: 'codex' },
      observation: { ...unproven.observation!, reviews: [], agentReview: { provider: 'codex', sha: head, approved: false, reason: 'Pull request is draft; mark it ready to request code review' } } } as Work },
    { name: 'agent provider', work: { ...unproven, policy: { ...unproven.policy, reviewProvider: 'agent', reviewerProfiles: profiles }, observation: { ...unproven.observation!, reviews: [] } } as Work },
    { name: 'reviewer roster spent', work: { ...unproven, policy: { ...unproven.policy, reviewProvider: 'agent', reviewerProfiles: profiles }, observation: { ...unproven.observation!, reviews: [] },
      reviewFailovers: [{ profile: 'reviewer-a', reviewerApp: 'app-a', runtime: 'claude', exhaustion: 'timeout', reason: 'the reviewer session timed out', at: now.toISOString(), sha: head, baseSha: base, policyRevision: unproven.policyRevision, requestCommentId: 7, nextProfile: null }] } as Work },
    { name: 'a required check failed', work: { ...unproven, observation: { ...unproven.observation!, checks: [{ name: 'test', result: 'failure', appId: CI_APP }, { name: 'typecheck', result: 'success', appId: CI_APP }] } } as Work },
    { name: 'a required check has not answered', work: { ...unproven, observation: { ...unproven.observation!, checks: [] } } as Work },
    { name: 'no trusted evidence', work: unproven },
    { name: 'an inherited bootstrap obligation', work: unproven, all: [deferrer, unproven] },
    { name: 'evidence from an implementer', work: { ...unproven, evidence: [{ id: randomUUID(), proof: PROOF, sha: head, baseSha: base, policyRevision: unproven.policyRevision, producer: worker.id, trusted: true, result: 'pass', executed: 3, skipped: 0, at: now.toISOString() }] } as Work },
    { name: 'a stale observation', work: { ...unproven, observation: { ...unproven.observation!, at: new Date(now.getTime() - 600_000).toISOString() } } as Work },
    { name: 'branch protection unverified', work: { ...unproven, observation: { ...unproven.observation!, protected: false } } as Work },
    { name: 'not mergeable', work: { ...unproven, observation: { ...unproven.observation!, mergeable: false } } as Work },
    { name: 'unresolved review threads', work: { ...unproven, observation: { ...unproven.observation!, conversations: { required: true, unresolved: [{ id: 'PRRT_1', author: 'chatgpt-codex-connector', path: 'docs/a.md', line: 1, outdated: false }] } } } as Work },
    { name: 'a standing escalation', work: { ...unproven, escalations: [{ trigger: 'security-concern', reason: 'the candidate ships a credential', at: now.toISOString(), actor: 'reviewer' }] } as Work },
    { name: 'a slice lead hold', work: { ...unproven, leadHold: { action: 'send-back', rulingId: 'R-1', leadId: 'lead-a', slice: 'product', ruleId: 'R-1', reason: 'the slice is frozen for the release', at: now.toISOString() } } as Work },
    { name: 'ejected from the queue', work: { ...unproven, queueEjection: { at: now.toISOString(), sequence: 1, reason: 'Pull request was closed without merging', sha: head, policyRevision: unproven.policyRevision } } as Work },
    // GY-321: a speculative merge that conflicted behind a queued predecessor waits for it, not for a sync.
    { name: 'ejected behind a queued predecessor', work: waiting, all: [ahead, behind, waiting] },
    { name: 'first in the merge queue', work: ahead, all: world },
    { name: 'second in the merge queue', work: behind, all: world },
    // CI on the entry's own published speculative tip is the merge step validating it (GY-292).
    { name: 'validating its speculative tip', work: { ...proven, queue: { sequence: 1, enqueuedAt: now.toISOString(), policyRevision: proven.policyRevision,
      speculation: { ref: `graphyard/queue/${proven.key}`, tip: head, base, baseTree: sha40('7e'), predecessors: [], policyRevision: proven.policyRevision, publishedAt: now.toISOString() } }, queueSequence: 1,
      observation: { ...proven.observation!, checks: [{ name: 'test', result: 'in_progress', appId: CI_APP }, { name: 'typecheck', result: 'success', appId: CI_APP }] } } as Work },
    // The one placement branch the evaluator keeps for a queued entry its own graph does not
    // hold: eligible, enqueued, and nowhere in the order it was placed against.
    { name: 'eligible and unplaced', work: proven, all: [] },
  ];

  const produced = new Map<string, { gate: string; refusal: string; probes: string[] }>();
  const outcomes = new Map<AccountOutcome, number>();
  for (const probe of probes) {
    const all = probe.all ?? [probe.work];
    const work = grade(probe.work, all);
    const graph = all.map(entry => entry.id === work.id ? work : entry);
    for (const { gate, refusal } of refusalsOf(work)) {
      const seen = produced.get(`${gate}\u0000${refusal}`) ?? { gate, refusal, probes: [] };
      seen.probes.push(probe.name);
      produced.set(`${gate}\u0000${refusal}`, seen);
      // Every refusal, not only the first of the first refusing gate: the mapping is a function
      // of (gate, refusal, record) and every one of them has to land somewhere nameable.
      const kind = refusalAction(work, gate, refusal);
      const shape = gateRefusalCatalogue.find(entry => entry.gate === gate && entry.match.test(refusal));
      assert.ok(shape, `${probe.name}: no declared refusal shape claims ${gate}: ${refusal}`);
      assert.ok(shape!.kinds.includes(kind), `${probe.name}: ${gate}: ${refusal} mapped to ${kind}, which ${shape!.id} does not declare (${shape!.kinds.join(', ')})`);
      assert.equal(refusalAction(work, gate, refusal), kind, 'the mapping is a function of its inputs');
    }
    // And the account for the whole item: an action an executor can complete, an action that is a
    // judgment somebody owes, an explicit dependency, or a recorded human need. Never nothing.
    const account = actionAccount(work, graph, now);
    const outcome = accountOutcome(account);
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    assert.equal(account.defect, null, `${probe.name}: ${account.defect}`);
    assert.notEqual(outcome, 'unaccounted', probe.name);
    assert.notEqual(outcome, 'settled', `${probe.name}: a refusing item is never settled`);
    if (outcome === 'waiting-on') assert.ok(account.wait!.on, `${probe.name}: a wait names what it waits on`);
    if (outcome === 'action') assert.ok(['none', 'in-session', 'in-step'].includes(actionJudgment[account.action!.kind]), probe.name);
  }

  // Every declared shape the engine can word was worded here: the battery is the enumeration, and
  // a shape nothing reaches is a claim this test cannot make. Free-text shapes are exempt, since
  // their wording comes from a person or a provider and no probe can pin it.
  const declared = gateRefusalCatalogue.filter(shape => !shape.free);
  const reached = new Set([...produced.values()].map(entry => gateRefusalCatalogue.find(shape => shape.gate === entry.gate && shape.match.test(entry.refusal))!.id));
  assert.deepEqual(declared.filter(shape => !reached.has(shape.id)).map(shape => shape.id), [], 'every declared refusal shape was produced by the battery');
  assert.deepEqual([...new Set(declared.map(shape => shape.gate))].sort(), ['acceptance', 'build', 'merge', 'ready', 'review', 'test'], 'every gate declares refusals');
  assert.ok(produced.size >= declared.length, `the battery worded ${produced.size} distinct refusals for ${declared.length} declared shapes`);

  // Totality over rules as well: every rule in the mapping is reachable from a declared shape, so
  // a rule written for a refusal nobody can raise is visible rather than dead weight.
  const rules = new Set(gateRefusalCatalogue.map(shape => refusalRuleFor(shape.gate, shape.example)?.index));
  assert.deepEqual(refusalRuleIndex.filter(rule => !rules.has(rule.index)).map(rule => `${rule.gate ?? 'any'} ${rule.source}`), [], 'every rule in the mapping is reachable');
  // And every declared example is claimed by its own shape first, so the catalogue is a function.
  for (const shape of gateRefusalCatalogue) {
    assert.ok(shape.match.test(shape.example), `${shape.id}: its example does not match its own pattern`);
    const claimed = gateRefusalCatalogue.find(entry => entry.gate === shape.gate && entry.match.test(shape.example))!;
    if (!shape.free) assert.equal(claimed.id, shape.id, `${shape.id}: its example is claimed by ${claimed.id} instead`);
  }
  assert.ok((outcomes.get('action') ?? 0) > 0 && (outcomes.get('waiting-on') ?? 0) > 0 && (outcomes.get('human') ?? 0) > 0,
    `the battery reached every kind of answer: ${[...outcomes].map(([outcome, count]) => `${outcome}=${count}`).join(' ')}`);
});

// ---- AC-3: an item with no action and no progress is visible ----------------------------------

const gatesFailingAt = (first: string, reasons: string[]): Gate[] => {
  const order = ['ready', 'build', 'review', 'test', 'acceptance', 'merge'];
  return order.map(name => ({ name, passed: order.indexOf(name) < order.indexOf(first), reasons: name === first ? reasons : order.indexOf(name) < order.indexOf(first) ? [] : ['later'] }));
};

test('unit:actionless-item-visible — an item with no action and nothing moving it is named by master status, by the loop and on the dashboard, with how long it has held its gate and what is missing; items waiting on another item are counted apart', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const held = new Date(now.getTime() - 3 * 3_600_000).toISOString();
  const shell = (key: string, overrides: Partial<Work>): Work => ({
    id: `id-${key}`, key, title: `Item ${key}`, type: 'feature', priority: 1, epoch: 1, revision: 1, policyRevision: 1,
    stage: 'review', ready: true, createdAt: held, updatedAt: held, stageEnteredAt: held,
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }], plannedFiles: ['src/'], dependencies: [], evidence: [],
    workspaces: [], violations: [], gates: [], blocker: null, lease: null, submission: null, candidate: null, observation: null,
    policy: { checks: ['test'], review: true }, ...overrides,
  } as unknown as Work);

  // Four items with no computed action, and only one of them is a problem.
  const mute = shell('GY-MUTE', { submission: { epoch: 1, pr: 42 } as Work['submission'], gates: gatesFailingAt('review', []) });
  const blocked = shell('GY-DEP', { stage: 'build', gates: gatesFailingAt('ready', ['Dependency GY-9 is unfinished']) });
  const building = shell('GY-BUILD', { stage: 'build', gates: gatesFailingAt('build', ['Worker has not submitted implementation for this attempt']),
    lease: { owner: 'agent-a', epoch: 1, expiresAt: new Date(now.getTime() + 60_000).toISOString() } as Work['lease'] });
  const backlog = shell('GY-BACKLOG', { ready: false, stage: 'backlog', gates: gatesFailingAt('ready', ['Not released from backlog']) });
  const world = [mute, blocked, building, backlog];
  const computed = world.map(item => ({ ...item, nextAction: nextAction(item, world, now) }));

  // The control plane's own account, item by item.
  assert.equal(accountOutcome(actionAccount(mute, world, now)), 'unaccounted');
  assert.equal(accountOutcome(actionAccount(blocked, world, now)), 'waiting-on');
  assert.equal(actionAccount(blocked, world, now).wait!.on, 'GY-9');
  assert.equal(accountOutcome(actionAccount(building, world, now)), 'waiting-on');
  assert.equal(actionAccount(building, world, now).wait!.on, 'agent-a');
  assert.equal(accountOutcome(actionAccount(backlog, world, now)), 'human');

  // Every open item with no action, and the ones nothing is moving counted apart from them.
  const actionless = actionlessItems(world, now);
  assert.deepEqual(actionless.map(entry => entry.key).sort(), ['GY-BUILD', 'GY-DEP', 'GY-MUTE'], 'backlog is not open work');
  assert.deepEqual(actionless.filter(entry => entry.outcome === 'waiting-on').map(entry => entry.key).sort(), ['GY-BUILD', 'GY-DEP']);
  assert.deepEqual(stalledItems(world, now).map(entry => entry.key), ['GY-MUTE'], 'only the item nothing is moving is stalled');
  const stall = stalledItems(world, now)[0];
  assert.equal(stall.gate, 'review');
  assert.equal(stall.heldMs, 3 * 3_600_000, 'how long it has held its failing gate');
  assert.match(stall.detail, /the review gate refuses with no reason recorded/, 'and what is missing');
  // The bound is the one a queued row nobody claims is judged against, and it is a bound: the
  // same item a minute into its gate is not yet somebody's problem.
  assert.equal(stallBoundMs, actionIdleMs);
  assert.deepEqual(stalledItems(world, new Date(Date.parse(held) + stallBoundMs - 1000)).map(entry => entry.key), []);
  assert.deepEqual(stalledItems(world, new Date(Date.parse(held) + stallBoundMs + 1000)).map(entry => entry.key), ['GY-MUTE']);

  // Master status names it, with the gate, the elapsed time, what is missing, and who answers.
  const attention = stalledItemAttention({ work: world, now: now.toISOString() });
  assert.equal(attention.length, 1);
  assert.equal(attention[0].subject, 'GY-MUTE');
  assert.match(attention[0].text, /has held its review gate for 3h0m with no action named and nothing moving it/);
  assert.match(attention[0].text, /defect in the control plane rather than in the item/);
  assert.match(JSON.stringify(attention[0]), /graphyard master create/);
  assert.deepEqual(stalledItemAttention({ work: [blocked, building], now: now.toISOString() }), [], 'an item something is moving raises nothing');

  // The coordination loop counts it as a subject, so its wait accumulates against the silence
  // bound instead of being absent from every measure the loop keeps.
  const subjects = actionableSubjects({ autoMerge: true, run: { proofWorkflow: false } } as any, world, now.getTime());
  const escalation = subjects.find(subject => subject.work === 'GY-MUTE' && subject.kind === 'escalation');
  assert.ok(escalation, 'the loop has a subject for it');
  assert.match(escalation!.detail, /holds its review gate with no action, no dependency and no recorded human need/);
  assert.equal(subjects.some(subject => subject.work === 'GY-DEP' && subject.kind === 'escalation'), false);

  // The dashboard names it too, and reads the same items as stalled as the control plane does.
  assert.deepEqual(stalledCards(computed, now.getTime()).map(card => card.item.key), stalledItems(world, now, 0).map(entry => entry.key),
    'the page and the control plane agree on what is stalled');
  assert.deepEqual(actionlessCards(computed, now.getTime()).map(card => card.item.key).sort(), actionless.map(entry => entry.key).sort());
  assert.deepEqual(actionlessCards(computed, now.getTime()).filter(card => card.movedBy).map(card => card.item.key).sort(), ['GY-BUILD', 'GY-DEP']);
  // An item the control plane has not evaluated at all is not a stalled item: absent is not null.
  assert.deepEqual(stalledCards(world, now.getTime()), [], 'an unevaluated snapshot reports nothing');

  const dashboard = {
    token: 'test', work: computed, status: null, error: '', connected: true, lastUpdated: null, view: 'work', setView: () => {},
    filter: null, setFilter: () => {}, selected: null, setSelected: () => {}, creating: false, setCreating: () => {},
    busy: false, setBusy: () => {}, observedAt: now.getTime(), jobs: [], query: '', setQuery: () => {}, operatorAgents: [],
    events: [], operatorAgentsError: null, features: {}, editingRequirements: false, setEditingRequirements: () => {},
    codexAvailable: false, queue: [], sessionEpoch: { current: 0 }, api: async () => ({}), refresh: async () => {},
    action: async () => {}, setError: () => {}, signOut: () => {},
    // The board GET /api/board serves over the same work (GY-200): the Work page renders its groups.
    board: boardFromStatus(computed, now.getTime(), null),
  } as unknown as Dashboard;
  const markup = renderToStaticMarkup(createElement(OverviewPage, dashboard));
  assert.match(markup, /Nothing is happening/);
  assert.match(markup, /GY-MUTE/);
  assert.match(markup, /reports a problem without saying what it is/, 'the page says what is missing');
  assert.match(markup, /stuck at .{0,20}In review.{0,20} for 3h/, 'and how long it has held its gate');
  const section = markup.slice(markup.indexOf('Nothing is happening'), markup.indexOf('</section>', markup.indexOf('Nothing is happening')));
  for (const key of ['GY-DEP', 'GY-BUILD', 'GY-BACKLOG']) assert.equal(section.includes(key), false, `${key} is counted apart from the items nothing is moving`);
});
