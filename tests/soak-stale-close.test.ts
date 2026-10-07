import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { decisionRefreshMs } from '../src/daemon/decision-reads.js';
import { maxApproverLaunches } from '../src/daemon/decisions.js';
import { staleAttentionAttempts, staleWaitKey } from '../src/model/stale-close.js';
import { terminalDecisions } from '../src/cli/decision-report.js';
import type { MechanicalFixRequest } from '../src/mechanical-findings.js';

/**
 * GY-1439. Stale closes over a simulated working day: the loop requests a revision-raced close again
 * itself (staleCloseStep), holds every advancing step on an item a close stands on (closingItems),
 * and names a series of stale settles once. Each of those runs every cycle for every open item, so
 * here the real loop runs a cycle a minute for eight hours over one item per state a close can be
 * in — requested and never answered, stale and converging until it applies, stale on every attempt
 * until the series reaches its bound, applied at once — beside a capped review whose withdrawal a
 * standing close holds and a control item with no close. After every cycle and at the end: the
 * re-requests and approver launches of each close series are bounded, a cycle in which no decision
 * moved reads no history (the review-cap read included), and no item is held without a surfaced
 * attention, while every system invariant the loop checks holds.
 */
const minute = 60_000, hour = 60 * minute, start = Date.parse('2026-10-07T10:00:00Z'), base = 'b'.repeat(40);
const iso = (at: number) => new Date(at).toISOString();
const headOf = (key: string) => key.replace(/\D/g, '').padStart(8, 'c').padEnd(40, '0');

/** What the independent approver does with a close: never answers, races it on every attempt, races it once, or applies it. */
type Fate = 'unanswered' | 'stale-every-time' | 'stale-once' | 'applied';
const fates: Record<string, Fate> = { 'GY-1': 'unanswered', 'GY-2': 'stale-every-time', 'GY-3': 'stale-once', 'GY-4': 'applied', 'GY-5': 'unanswered' };
const capped = 'GY-5', control = 'GY-6';

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: iso(start - hour) } });
}
/** An item in review on an approved head, with a planned bot round (GY-971) — or, for the capped one, past its review cap on a change request naming no BLOCKING: finding. */
function item(key: string, now: number): Work {
  const sha = headOf(key), candidate = { sha, baseSha: base, pr: Number(key.slice(3)) + 900, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const review = key === capped
    ? { reviewer: 'graphyard-reviewer[bot]', sha, state: 'CHANGES_REQUESTED', id: 7000 + Number(key.slice(3)), submittedAt: iso(start - 5 * minute), body: 'Nit: rename a local.' }
    : { reviewer: 'graphyard-reviewer[bot]', sha, state: 'APPROVED', id: 7000 + Number(key.slice(3)), submittedAt: iso(start - 5 * minute) };
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true },
    plannedFiles: [`src/${key.toLowerCase()}.ts`], stage: 'review', revision: 100, policyRevision: 1, createdAt: iso(start - 2 * hour), updatedAt: iso(now), stageEnteredAt: iso(start - hour),
    ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    reworkRounds: key === capped ? 3 : 0, escalation: null, escalations: [],
    observation: { candidate, checks: [{ appId: 15368, name: 'test', result: 'success' }], reviews: [review], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [],
      at: iso(now), prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true },
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: key !== capped, reasons: [] }, { name: 'test', passed: true, reasons: [] }],
  } as unknown as Work;
}

type Row = { id: string; work: string; action: string; state: string; input: Record<string, any>; reason: string; requestedBy: string; requestedAt: string; staleAt?: string; outcome: string | null; approvedBy: string | null };

test('unit:soak-invariants-hold — over a simulated working day each close series is re-requested and put to approvers within its bounds, a cycle in which no decision moved reads no history, and no held item stalls without a surfaced attention', { timeout: 300_000 }, async () => {
  let now = start, sequence = 0, seq = 0;
  const work = ['GY-1', 'GY-2', 'GY-3', 'GY-4', capped, control].map(key => item(key, now));
  const find = (key: string) => work.find(entry => entry.key === key)!;
  const ledger: Row[] = [], launches = new Map<string, number>(), judging: { decision: string; at: number }[] = [];
  const handLaunches: { agentName: string; account: null; runtime: null; session: null; launchedAt: string; work: string; decision: string }[] = [];
  const reads = { total: 0 }, reworks: string[] = [], withdrawn: string[] = [], wakes: string[] = [];
  let moved: string[] = [];
  // The approver sessions the runtime lists: one judging stays until its judgement, one that never answers ends after five minutes.
  const sessions = new Map<string, number>();
  const listed = () => [...sessions].filter(([, until]) => until > now).map(([name]) => ({ name, pane_id: `pane-${name}`, agent_status: 'working' }));
  const launch = (name: string, key: string, decision: string) => {
    const answers = fates[key] !== 'unanswered';
    sessions.set(name, now + (answers ? 4 : 5) * minute);
    if (answers) judging.push({ decision, at: now + 3 * minute });
  };
  const touch = (target: Work) => { seq += 1; moved.push(target.id); };
  // The bot round GY-971 planned on every approved head: the advancing step a standing close must hold.
  const mechanical = work.filter(entry => entry.key !== capped).map(entry => ({ key: entry.key, pr: entry.candidate!.pr, head: entry.candidate!.sha, reviewId: 7000 + Number(entry.key.slice(3)), epoch: 1,
    at: iso(start - 4 * minute), mechanical: [{ path: entry.plannedFiles[0], line: 3, category: 'formatting' }], substantive: [], paths: [entry.plannedFiles[0]] })) as unknown as MechanicalFixRequest[];
  const record = (target: Work, action: string, reason: string, input: Record<string, unknown>, requestedBy: string) => {
    const id = `decision-${++sequence}`;
    ledger.push({ id, work: target.key, action, state: 'requested', input: action === 'close' ? { expectedRevision: target.revision, ...input } : input, reason, requestedBy, requestedAt: iso(now), outcome: null, approvedBy: null });
    if (action === 'rework') { reworks.push(target.key); target.revision += 1; }
    touch(target);
    return { id };
  };
  /** The approver judges a few minutes after it is launched; the item moves between the request and the judgement as its fate says. */
  const judge = (id: string) => {
    const decision = ledger.find(entry => entry.id === id)!, target = find(decision.work), fate = fates[target.key];
    if (decision.state !== 'requested' || target.stage === 'done') return;
    // Any other decision (the bot round an item is no longer held from) the approver applies as asked.
    if (decision.action !== 'close') { Object.assign(decision, { state: 'applied', approvedBy: 'graphyard-approver' }); touch(target); return; }
    if (!fate || fate === 'unanswered') return;
    const attempt = ledger.filter(entry => entry.work === target.key && entry.action === 'close').indexOf(decision);
    if (fate === 'stale-every-time' || (fate === 'stale-once' && attempt === 0)) target.revision += 7;
    if (decision.input.expectedRevision !== target.revision) Object.assign(decision, { state: 'stale', staleAt: iso(now), outcome: `Task revision changed (now ${target.revision}); reload and request again; the decision was not applied` });
    else {
      Object.assign(decision, { state: 'applied', approvedBy: 'graphyard-approver' });
      Object.assign(target, { stage: 'done', closure: { kind: decision.input.kind, ref: decision.input.ref ?? null, reason: decision.reason, by: 'graphyard-approver', at: iso(now), from: target.stage }, revision: target.revision + 1 });
    }
    touch(target);
  };
  const effects = {
    agents: listed, herdr: () => ({ agents: listed(), available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: work.map(entry => Object.assign(structuredClone(entry), { observation: { ...entry.observation!, at: iso(now) } })), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), persist: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (target: Work, action: string, reason: string, input: Record<string, unknown> = {}) => record(find(target.key), action, reason, input, 'graphyard-master-agent'),
    approver: async (target: Work, decision: string) => {
      launches.set(decision, (launches.get(decision) ?? 0) + 1);
      const name = `gy-approver-${target.key.toLowerCase()}-${decision}-${launches.get(decision)}`;
      launch(name, target.key, decision);
      return { agentName: name, pane: `pane-${name}` };
    },
    withdraw: async (target: Work, decision: string) => { const entry = ledger.find(row => row.id === decision); if (entry && entry.state === 'requested') { entry.state = 'withdrawn'; touch(find(target.key)); } },
    decisions: async (target: Work) => { reads.total += 1; return { decisions: ledger.filter(entry => entry.work === target.key).map(entry => structuredClone(entry)) }; },
    decisionChanges: async (after: string | null) => { const changed = [...new Set(moved)]; moved = []; return { seq: String(seq), work: changed, complete: after !== null }; },
    mechanicalFixes: async () => ({ requests: mechanical.filter(request => find(request.key).stage !== 'done') }),
    approverLaunches: async () => handLaunches,
    withdrawReview: async (target: Work) => { withdrawn.push(target.key); },
    wakeObservation: async (target: Work) => { wakes.push(target.key); },
    observe: async (target: Work) => { wakes.push(target.key); return structuredClone(find(target.key)); },
  } as unknown as DaemonEffects;

  // The master asks every close by hand, as `graphyard master decide` and `graphyard master approver` do, before the day starts.
  for (const key of Object.keys(fates)) {
    const made = record(find(key), 'close', `${key} duplicates ${control}, the priority-1 owner of the same fix`, { kind: 'duplicate', ref: control }, 'graphyard-master-agent:hand');
    handLaunches.push({ agentName: `hand-approver-${made.id}`, account: null, runtime: null, session: null, launchedAt: iso(now), work: key, decision: made.id });
    launches.set(made.id, 1);
    launch(`hand-approver-${made.id}`, key, made.id);
  }

  const state = emptyDaemonState(config());
  const escalations: { work: string; detail: string }[] = [], failures: string[] = [], violations: string[] = [];
  let quiet = 0, lastRefresh = start;
  for (let cycle = 0; now < start + 8 * hour; cycle++, now += minute) {
    for (const due of judging.filter(entry => entry.at <= now)) { judging.splice(judging.indexOf(due), 1); judge(due.decision); }
    const before = reads.total, movedBefore = moved.length;
    const result = await runCycle(config(), state, effects, () => now);
    for (const action of result.actions) {
      if (action.kind === 'escalation') escalations.push({ work: action.work ?? '', detail: action.detail ?? '' });
      if (action.state === 'failed' && action.kind !== 'escalation' && action.kind !== 'deployment') failures.push(`${action.kind} ${action.work}: ${action.detail}`);
    }
    for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
    // A cycle that starts with nothing moved in the ledger, and is not the kept histories' periodic refresh, reads no history at all.
    const refresh = now - lastRefresh >= decisionRefreshMs;
    if (refresh) lastRefresh = now;
    if (cycle > 2 && movedBefore === 0 && !refresh) { quiet += 1; assert.equal(reads.total - before, 0, `cycle ${cycle} (+${(now - start) / minute} min): no decision moved, yet ${reads.total - before} history read(s)`); }
  }

  assert.deepEqual(failures, [], 'no step failed');
  assert.deepEqual(violations, [], 'every system invariant holds');
  assert.ok(quiet > 300, `most of the day's cycles were quiet: ${quiet}`);
  // Over the whole day each history is read about once per periodic refresh, plus once each time its ledger moved.
  const refreshes = Math.ceil(8 * hour / decisionRefreshMs) + 1;
  assert.ok(reads.total <= work.length * refreshes + ledger.length * 3 + 20, `history reads stay bounded: ${reads.total} for ${ledger.length} decisions over the day`);

  const closes = (key: string) => ledger.filter(entry => entry.work === key && entry.action === 'close');
  for (const [key, fate] of Object.entries(fates)) {
    const series = closes(key);
    // (a) Re-requests and approver launches are bounded per close series.
    assert.equal(series.filter(entry => entry.requestedBy.endsWith(':hand')).length, 1, `${key}: one operator request, never re-requested by hand`);
    assert.ok(series.length <= staleAttentionAttempts, `${key}: at most ${staleAttentionAttempts} requests in the series: ${series.length}`);
    for (const entry of series) assert.ok((launches.get(entry.id) ?? 0) <= maxApproverLaunches, `${key}: ${entry.id} put to at most ${maxApproverLaunches} approver sessions: ${launches.get(entry.id)}`);
    if (fate === 'applied') assert.deepEqual(series.map(entry => entry.state), ['applied']);
    if (fate === 'stale-once') assert.deepEqual(series.map(entry => entry.state), ['stale', 'applied'], `${key}: applied by the loop's own second request`);
    if (fate === 'stale-every-time') assert.deepEqual(series.map(entry => entry.state), Array(staleAttentionAttempts).fill('stale'), `${key}: asked no more once the series reached its bound`);
    if (fate === 'unanswered') assert.deepEqual(series.map(entry => entry.state), ['requested'], `${key}: an unanswered close is never asked again`);
    if (fate === 'applied' || fate === 'stale-once') {
      assert.equal(find(key).stage, 'done', `${key} was closed`);
      assert.equal(state.actions[staleWaitKey(find(key), 'close')], undefined, `${key}: its named wait retired with the close`);
    }
  }
  // While its close stood, no item had a bot round authorized, an observation woken or its review withdrawn.
  for (const key of ['GY-1', 'GY-3', 'GY-4', capped]) assert.ok(!reworks.includes(key), `${key}: no rework while its close stood: ${reworks}`);
  assert.deepEqual(withdrawn, [], 'the capped review under a standing close was not withdrawn');
  assert.ok(!wakes.some(key => key !== control && key !== 'GY-2'), `no observation woken under a standing close: ${wakes}`);
  // The control and the series past its bound are no longer held: each takes its bot round, once.
  assert.deepEqual(reworks.filter(key => key === control), [control], 'the item with no close takes its bot round');
  assert.deepEqual(reworks.filter(key => key === 'GY-2'), ['GY-2'], 'once the stale series reaches its bound the item is no longer held, and its round is taken once');

  // (c) No held item stalls without a surfaced attention: each unanswered close is escalated once its approvers are spent,
  // the series at its bound is one master-status line, and every item still held at the end of the day is named by one of those.
  for (const key of ['GY-1', capped]) {
    const decision = closes(key)[0]!.id;
    assert.ok(escalations.some(entry => entry.work === key && entry.detail.includes(decision)), `${key}: the unanswered close ${decision} was escalated: ${JSON.stringify(escalations.filter(entry => entry.work === key))}`);
    // The held bot round is a named wait too (the capped review's withdrawal is held silently: its escalation names it).
    if (key !== capped) assert.match(state.actions[`wait:closing:${find(key).id}`]?.detail ?? '', new RegExp(`close decision ${decision} stands unapplied, so the loop takes no rework decision on it`), `${key}: its hold is a named wait`);
  }
  const { attentionItems } = await terminalDecisions(async path => ({ decisions: ledger.filter(entry => path === `work/${find(entry.work).id}/decisions`) }),
    work, { approvals: Object.values(state.approvals), runtime: { available: true, agents: [] }, now });
  const lines = attentionItems.filter(entry => entry.subject === 'GY-2');
  assert.equal(lines.length, 1, `the series at its bound is one attention line: ${JSON.stringify(attentionItems)}`);
  assert.match(lines[0]!.text, /^Decision GY-2\/close \(close\) is stale on 3 or more requests in a row/);
  assert.match(state.actions[staleWaitKey(find('GY-2'), 'close')]!.detail, /settled stale 3 time\(s\) in a row .+; the loop does not request it again: 3 close requests in a row settled stale/);
  const held = work.filter(entry => entry.stage !== 'done' && state.actions[`wait:closing:${entry.id}`] && closes(entry.key).at(-1)?.state === 'requested').map(entry => entry.key);
  assert.deepEqual(held.filter(key => !escalations.some(entry => entry.work === key)), [], 'every item still held at the end of the day was escalated');
});
