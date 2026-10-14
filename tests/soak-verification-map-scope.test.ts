import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import type { Work } from '../src/model.js';
import type { ScopeRequestState } from '../src/model/scope.js';

/**
 * GY-1783 (review of 4a6bb1bb): the loop's scope step now grants a verification map as a companion
 * when the map's Paths line covers a planned file or a test the same request grants. That is a
 * per-item decision taken in the real loop, so the real loop runs here for three simulated days over
 * several items, asks, heads and attempts: items planning a file under verification/master.md's
 * Paths ask for the map (alone, or beside the test importing the planned file), at the start and a
 * day in; items planning only src/daemon/run.ts ask for the same pair, and the approver judges them
 * minutes after its launch; after its widening one item ends its attempt and a second attempt on a
 * new head asks for a map whose Paths cover nothing planned. After every cycle every system
 * invariant holds. At the end: every grounded ask was widened exactly once, by the loop, with no
 * decision requested and no approver launched for it; every ungrounded ask was routed exactly once,
 * never widened by the loop, and judged by the approver; nothing was withdrawn; and once every ask
 * was answered the loop asked, widened and launched nothing more.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour, start = Date.parse('2026-10-14T05:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const judgeAfter = 6 * minute;
const masterMap = 'Paths: src/master/**, src/master.ts, src/reviewer.ts\n\n## Tests\n\n- `tests/master.test.ts`.\n';
const storeMap = 'Paths: src/store/**, src/store.ts, src/engine.ts\n\n## Tests\n\n- `tests/store.test.ts`.\n';
/** The base branch the loop reads: the maps, the planned modules and the test importing the master one. */
const base: Record<string, string> = {
  'verification/master.md': masterMap,
  'verification/store.md': storeMap,
  'src/master/release-lag.ts': 'export function releaseLag() { return 0; }',
  'src/master/dispatch.ts': 'export function dispatch() {}',
  'src/daemon/run.ts': 'export async function run() {}',
  'tests/loop-self-upgrade.test.ts': "import { releaseLag } from '../src/master/release-lag.js';\ntest('lag', () => releaseLag());",
};
const pair = ['tests/loop-self-upgrade.test.ts', 'verification/master.md'];

type Decision = { id: string; action: string; state: string; input: any; outcome: string | null; approvedBy: string | null; refusal: string | null; requestedAt: string; requestedBy: string };
/** One ask an attempt makes: refused by the rule at `at`, standing until the loop widens it or the approver judges it. */
type Ask = { epoch: number; at: number; paths: string[]; grounded: boolean; refuse: boolean; answered: number | null };
type Item = { key: string; plannedFiles: string[]; asks: Ask[]; epoch: number; head: string; policyRevision: number; scopeDecision: any };

test('unit:soak-verification-map-scope — over three simulated days every verification-map ask the rules ground is widened once by the loop and never routed, every one they refuse is routed once and never widened, across items, heads and attempts, with every invariant holding', { timeout: 300_000 }, async () => {
  let now = start;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], producers: [], run: { intervalSeconds: 600 } }) as MasterConfig;

  const ask = (epoch: number, at: number, paths: string[], grounded: boolean, refuse = false): Ask => ({ epoch, at, paths, grounded, refuse, answered: null });
  // The world. GY-1700..1703 plan a file under the master map's Paths: the map alone, the pair, the
  // pair a day in, and (GY-1703) the pair at the start then, from a second attempt on a new head a
  // day later, the store map nothing planned is under. GY-1710/1711 plan only src/daemon/run.ts and
  // ask for the pair: the approver approves one and refuses the other.
  const items: Item[] = [
    { key: 'GY-1700', plannedFiles: ['src/master/release-lag.ts'], asks: [ask(1, start + 2 * minute, ['verification/master.md'], true)], epoch: 1, head: 'a1', policyRevision: 2, scopeDecision: null },
    { key: 'GY-1701', plannedFiles: ['src/master/dispatch.ts'], asks: [ask(1, start + 4 * minute, ['verification/master.md'], true)], epoch: 1, head: 'b1', policyRevision: 2, scopeDecision: null },
    { key: 'GY-1702', plannedFiles: ['src/master/release-lag.ts'], asks: [ask(1, start + day + 3 * minute, pair, true)], epoch: 1, head: 'c1', policyRevision: 2, scopeDecision: null },
    { key: 'GY-1703', plannedFiles: ['src/master/release-lag.ts'], asks: [ask(1, start + 6 * minute, pair, true), ask(2, start + day + 9 * minute, ['verification/store.md'], false, true)], epoch: 1, head: 'd1', policyRevision: 2, scopeDecision: null },
    { key: 'GY-1710', plannedFiles: ['src/daemon/run.ts'], asks: [ask(1, start + 8 * minute, pair, false)], epoch: 1, head: 'e1', policyRevision: 2, scopeDecision: null },
    { key: 'GY-1711', plannedFiles: ['src/daemon/run.ts'], asks: [ask(1, start + day + 5 * minute, pair, false, true)], epoch: 1, head: 'f1', policyRevision: 2, scopeDecision: null },
  ];
  const decisions = new Map<string, Decision[]>(items.map(item => [item.key, []]));
  const open = (item: Item) => item.asks.find(entry => entry.at <= now && entry.answered === null) ?? null;
  const request = (item: Item, entry: Ask): ScopeRequestState => ({ epoch: entry.epoch, at: iso(entry.at), paths: entry.paths, reason: 'the map names the area\'s test files', requestedBy: 'worker',
    decision: { state: 'refused', reason: `No rule implies ${entry.paths.join(', ')}`, at: iso(entry.at + 1000), decidedBy: 'graphyard', treeRead: true } } as ScopeRequestState);
  // GY-1703's second attempt claims the item on a new head a day in, two minutes before it asks.
  const attempt = (item: Item) => item.key === 'GY-1703' && now >= start + day + 7 * minute ? { epoch: 2, head: 'd2' } : { epoch: 1, head: item.head };

  const launches: { key: string; decision: string; at: number }[] = [], requested: { key: string; at: number; paths: string[] }[] = [], withdrawals: string[] = [], widened: { key: string; at: number; paths: string[]; reason: string }[] = [];
  const view = (item: Item): Work => {
    const { epoch, head } = attempt(item);
    const standing = open(item);
    return {
      id: `work-${item.key}`, key: item.key, title: 'Master area change', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: [...item.plannedFiles],
      criteria: [{ id: 'AC-1', text: 'The loop upgrades itself when the served release lags the base', proofs: ['unit:release-lag-upgrade'] }], policy: { checks: ['test'], review: true },
      stage: 'build', ready: true, epoch, revision: 10 + decisions.get(item.key)!.length + widened.filter(entry => entry.key === item.key).length, policyRevision: item.policyRevision,
      createdAt: iso(start - hour), updatedAt: iso(now), stageEnteredAt: iso(start - hour), lease: { owner: `worker-${epoch}`, epoch, expiresAt: iso(now + hour) },
      workspaces: [{ path: `/work/${item.key}-${epoch}`, head, epoch }], submission: null, candidate: null, scenarioRequirements: [], violations: [], evidence: [], observation: null, blocker: null,
      scopeRequest: standing ? request(item, standing) : null, scopeDecision: item.scopeDecision, gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
    } as unknown as Work;
  };
  const working = () => launches.filter(launch => decisions.get(launch.key)!.find(each => each.id === launch.decision)?.state === 'requested')
    .map(launch => ({ name: `gy-approver-${launch.decision.slice(0, 8)}`, agent_status: 'working' }));
  const of = (work: Work) => items.find(item => item.key === work.key)!;
  const answer = (item: Item, entry: Ask, state: 'approved' | 'refused', reason: string, decidedBy: string) => {
    entry.answered = now;
    item.scopeDecision = { state, reason, at: iso(now), decidedBy, paths: entry.paths, requestedBy: 'worker', requestedAt: iso(entry.at), epoch: entry.epoch, waitedMs: now - entry.at };
  };
  // The approver judges a routed decision a few minutes after its launch, as an approver session does.
  const judge = () => {
    for (const launch of launches) {
      const item = items.find(each => each.key === launch.key)!, entry = decisions.get(item.key)!.find(each => each.id === launch.decision)!;
      if (entry.state !== 'requested' || now < launch.at + judgeAfter) continue;
      const standing = open(item);
      assert.ok(standing && !standing.grounded, `${item.key}: the approver judges only an ask the rules refused`);
      if (standing.refuse) { Object.assign(entry, { state: 'refused', refusal: 'Not implied by the criteria' }); answer(item, standing, 'refused', 'Not implied by the criteria', 'graphyard-approver'); continue; }
      Object.assign(entry, { state: 'applied', approvedBy: 'graphyard-approver', outcome: 'Requirements revised' });
      item.plannedFiles = entry.input.plannedFiles; item.policyRevision++;
      answer(item, standing, 'approved', 'Additive and required by AC-1', 'graphyard-approver');
    }
  };

  const effects = {
    agents: () => [], herdr: () => ({ agents: working(), available: true }), credentials: async () => ({}), snapshot: async () => { judge(); return { work: items.map(view), now: iso(now) }; },
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    basePaths: async (asked: readonly string[]) => new Set(asked.filter(path => path in base)), baseText: async (path: string) => base[path] ?? null, baseMentions: async () => Infinity,
    decisions: async (work: Work) => ({ decisions: decisions.get(work.key) ?? [] }),
    decide: async (work: Work, action: string, _reason: string, input?: Record<string, unknown>) => {
      assert.equal(action, 'requirements', `only the routed widening is asked for, not ${action}`);
      const item = of(work), standing = open(item);
      assert.ok(standing && !standing.grounded, `${work.key}: the loop routes only an ask the rules refused, never one they ground`);
      assert.deepEqual((input as any).answers, { epoch: standing.epoch, at: iso(standing.at) }, 'the request answers the standing ask');
      const id = randomUUID();
      requested.push({ key: work.key, at: now, paths: standing.paths });
      decisions.get(work.key)!.push({ id, action, state: 'requested', input, outcome: null, approvedBy: null, refusal: null, requestedAt: iso(now), requestedBy: 'graphyard-master-project' });
      return { id, state: 'requested' };
    },
    withdraw: async (work: Work, decision: string, reason: string) => { withdrawals.push(`${work.key}: ${reason}`); const entry = decisions.get(work.key)!.find(each => each.id === decision); if (entry?.state === 'requested') entry.state = 'withdrawn'; },
    approver: async (work: Work, decision: string) => { launches.push({ key: work.key, decision, at: now }); return { agentName: `gy-approver-${decision.slice(0, 8)}`, pane: null }; },
    // The control plane's widening: the ask is answered as approved and the plan carries the paths, as `requirements` records it.
    widenScope: async (work: Work, asked: ScopeRequestState, added: string[], reason: string) => {
      const item = of(work), standing = open(item);
      assert.ok(standing && standing.grounded, `${work.key}: the loop widens only an ask the rules ground`);
      assert.deepEqual([asked.epoch, asked.at], [standing.epoch, iso(standing.at)], 'the widening answers the standing ask');
      widened.push({ key: work.key, at: now, paths: added, reason });
      item.plannedFiles = [...item.plannedFiles, ...added]; item.policyRevision++;
      answer(item, standing, 'approved', reason, 'graphyard');
      return view(item);
    },
    persist: async () => {},
  } as unknown as DaemonEffects;

  const state: DaemonState = emptyDaemonState(config);
  const violations: string[] = [];
  let answeredAt: number | null = null;
  for (let cycle = 0; now < start + 3 * day; cycle++, now += 2 * minute) {
    await runCycle(config, state, effects, () => now);
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`cycle ${cycle}: ${check.line}`);
    if (answeredAt === null && items.every(item => item.asks.every(entry => entry.answered !== null))) answeredAt = now;
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(withdrawals, [], 'nothing was withdrawn: a widened ask is answered, a routed one judged');
  const asked = items.flatMap(item => item.asks.map(entry => ({ key: item.key, at: entry.at, paths: entry.paths, grounded: entry.grounded }))).sort((a, b) => a.at - b.at);
  const grounded = asked.filter(entry => entry.grounded).map(({ key, paths }) => ({ key, paths })), routed = asked.filter(entry => !entry.grounded).map(({ key, paths }) => ({ key, paths }));
  // Each grounded ask: widened exactly once, by every path it named, on the companion grounds; never a decision, never a launch.
  assert.deepEqual(widened.map(entry => ({ key: entry.key, paths: entry.paths })), grounded, 'every ask the rules ground was widened once, whole, in the order asked');
  for (const entry of widened) {
    assert.match(entry.reason, /a companion the change inevitably carries/);
    assert.match(entry.reason, /verification\/master\.md is the verification map whose Paths: src\/master\/\*\*/);
    assert.ok(entry.at - items.find(item => item.key === entry.key)!.asks.find(ask => JSON.stringify(ask.paths) === JSON.stringify(entry.paths))!.at <= 4 * minute, `${entry.key}: widened within two cycles of the ask`);
  }
  assert.deepEqual(requested.map(entry => ({ key: entry.key, paths: entry.paths })), routed, 'every ask the rules refuse was routed once, and none the rules ground');
  assert.deepEqual(launches.map(entry => entry.key), routed.map(entry => entry.key), 'one approver launch per routed ask, never one per cycle');
  for (const item of items) assert.equal(decisions.get(item.key)!.length, item.asks.filter(entry => !entry.grounded).length, `${item.key}: one decision per routed ask`);
  // The outcome of each: GY-1710 widened by the approver, GY-1711 and GY-1703's second ask refused and left unplanned.
  assert.deepEqual(items.find(item => item.key === 'GY-1710')!.plannedFiles, ['src/daemon/run.ts', ...pair], 'GY-1710: widened by the approver\'s decision, not the loop');
  assert.deepEqual(items.find(item => item.key === 'GY-1711')!.plannedFiles, ['src/daemon/run.ts'], 'GY-1711: the refused ask stays unplanned');
  assert.deepEqual(items.find(item => item.key === 'GY-1703')!.plannedFiles, ['src/master/release-lag.ts', ...pair], 'GY-1703: the first attempt\'s pair planned by the loop, the second attempt\'s store map refused');
  for (const item of items.filter(item => ['GY-1700', 'GY-1701'].includes(item.key))) assert.deepEqual(item.plannedFiles, [item.plannedFiles[0], 'verification/master.md'], `${item.key}: the map alone`);
  assert.deepEqual(items.find(item => item.key === 'GY-1702')!.plannedFiles, ['src/master/release-lag.ts', ...pair], 'GY-1702: the pair asked a day in');
  // Settled: once every ask was answered the loop widened, asked and launched nothing more, for the rest of the three days.
  assert.ok(answeredAt !== null && answeredAt < start + day + hour, `every ask was answered within the hour of its asking, the last at ${answeredAt && iso(answeredAt)}`);
  assert.ok([...widened, ...requested, ...launches].every(entry => entry.at <= answeredAt!), 'nothing was widened, asked or launched once every ask was answered');
  const actions = Object.values(state.actions).filter(action => action.kind === 'scope');
  assert.ok(actions.every(action => action.state !== 'failed'), JSON.stringify(actions.filter(action => action.state === 'failed').map(action => action.detail)));
  assert.equal(actions.filter(action => /^Widened /.test(action.detail)).length, grounded.length, 'one Widened action per grounded ask');
});
