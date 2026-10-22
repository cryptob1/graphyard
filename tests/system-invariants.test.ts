import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { daemonSummary, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { candidateKey } from '../src/daemon/reconcile.js';
import { checkInvariants, emptyInvariantRecord, invariantDefaults, systemInvariants, type InvariantInput, type SystemInvariant } from '../src/model/invariants.js';
import { repeatingPaths, repetitionReviewSection, reviewPrompt } from '../src/reviewer.js';
import { readFile } from 'node:fs/promises';

// GY-404: every fault found on 2026-09-25 passed its own item's gates; they appeared only from
// interaction over time. The loop now checks the running system's invariants every cycle, reports
// each violation as one fault of its class, and prints one line per invariant in master status.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000, hour = 60 * minute;
const sha = (seed: string) => seed.repeat(40).slice(0, 40);

function config(overrides: Partial<MasterConfig> = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], ...overrides });
}
function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: iso(-hour), updatedAt: iso(0), stageEnteredAt: iso(-hour), ready: true, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}
const delivered = (key: string, mergedAgoMs: number, sessions: Work['sessions'] = []) => item(key, { stage: 'done', delivery: { mergedAt: iso(-mergedAgoMs), mergeSha: sha('d'), authorizationRevision: 1 }, sessions } as Partial<Work>);
const session = (agentName: string): NonNullable<Work['sessions']>[number] => ({ id: agentName, kind: 'review', principal: 'reviewer', epoch: null, runtime: 'claude', host: 'machine-a', workspace: null, tab: null, pane: `pane-${agentName}`,
  agentName, role: 'review', head: null, attach: null, transcript: null, subject: 'review', startedAt: iso(-2 * hour), updatedAt: iso(-2 * hour), endedAt: null, state: 'running', outcome: null });
/** A candidate in the merge stage, every gate passed and GitHub reporting it mergeable. */
const mergeable = (key: string, head = sha('a')) => item(key, { stage: 'merge', submission: { epoch: 1, pr: 42 } as Work['submission'],
  candidate: { sha: head, baseSha: sha('b'), pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, gates: [{ name: 'merge', passed: true, reasons: [] }],
  observation: { candidate: { sha: head, baseSha: sha('b'), pr: 42, branch: 'b', author: 'worker' }, mergeable: true, merged: false, checks: [], reviews: [], files: [], scopeFiles: [], at: iso(0) } as unknown as Work['observation'] } as Partial<Work>);
/** A candidate whose base the control plane refreshed `n` times, each republishing the head. */
const refreshed = (key: string, n: number) => item(key, { stage: 'review', submission: { epoch: 1, pr: 43 } as Work['submission'],
  candidate: { sha: sha(`${n}`), baseSha: sha('b'), pr: 43, branch: 'b', author: 'worker' },
  baseRefresh: n ? { from: { sha: sha(`${n - 1}`), baseSha: sha('b') }, base: sha('c'), baseTree: sha('e'), policyRevision: 1, at: iso(n * minute), head: sha(`${n}`), conflict: null } : null } as Partial<Work>);
const metrics = (seconds: number, n = 10) => Array.from({ length: n }, (_, index) => ({ at: iso(-index * 3 * minute), durationMs: seconds * 1000 }));

/** The checks of one invariant over a sequence of cycles; the last cycle's check. */
function judge(inputs: InvariantInput[]) {
  const record = emptyInvariantRecord();
  let checks = checkInvariants(record, inputs[0]);
  for (const input of inputs.slice(1)) checks = checkInvariants(record, input);
  return checks;
}
const verdict = (checks: ReturnType<typeof judge>, invariant: SystemInvariant) => checks.find(check => check.invariant === invariant)!;

test('unit:system-invariants-checked — each invariant driven over its threshold reports exactly one fault of its class; at its threshold it holds', () => {
  assert.deepEqual([...systemInvariants], ['lingering-sessions', 'refresh-churn', 'merge-stall', 'cycle-p90']);
  // Each fixture drives one invariant over its threshold (`over`) and holds it at the threshold (`at`).
  const fixtures: Record<SystemInvariant, { over: InvariantInput[]; at: InvariantInput[] }> = {
    'lingering-sessions': {
      over: [{ work: [delivered('GY-5', 31 * minute, [session('reviewer-5')]), delivered('GY-6', 45 * minute, [session('reviewer-6')])], now: clock,
        agents: [{ name: 'reviewer-5' }, { name: 'reviewer-6' }] }],
      at: [{ work: [delivered('GY-5', 29 * minute, [session('reviewer-5')]), delivered('GY-6', 45 * minute, [session('reviewer-6')])], now: clock,
        agents: [{ name: 'reviewer-5' }] }] },
    'refresh-churn': {
      over: [0, 1, 2, 3, 4].map(n => ({ work: [refreshed('GY-8', n)], now: clock + n * minute })),
      at: [0, 1, 2, 3].map(n => ({ work: [refreshed('GY-8', n)], now: clock + n * minute })) },
    'merge-stall': {
      over: [{ work: [mergeable('GY-10'), mergeable('GY-11', sha('f'))], now: clock }, { work: [mergeable('GY-10'), mergeable('GY-11', sha('f'))], now: clock + 11 * minute }],
      at: [{ work: [mergeable('GY-10')], now: clock }, { work: [mergeable('GY-10')], now: clock + 10 * minute }] },
    'cycle-p90': { over: [{ work: [], now: clock, metrics: metrics(31) }], at: [{ work: [], now: clock, metrics: [...metrics(29), { at: iso(-2 * hour), durationMs: 300_000 }] }] },
  };
  for (const invariant of systemInvariants) {
    const over = judge(fixtures[invariant].over), check = verdict(over, invariant);
    assert.equal(check.holds, false, `${invariant} over its threshold is violated: ${check.line}`);
    assert.match(check.line, new RegExp(`^${invariant}: VIOLATED`));
    const at = verdict(judge(fixtures[invariant].at), invariant);
    assert.equal(at.holds, true, `${invariant} at its threshold holds: ${at.line}`);
  }
  // Every invariant over its threshold at once: each is violated.
  const all = judge([{ work: [], now: clock - 20 * minute, build: 'build-1', metrics: [] }, ...fixtures['refresh-churn'].over.map(input => ({ ...input, now: clock - 20 * minute + (input.now - clock), build: 'build-1' })),
    { work: [refreshed('GY-8', 4), mergeable('GY-10')], now: clock - 12 * minute, build: 'build-2' },
    { work: [delivered('GY-5', 31 * minute, [session('reviewer-5')]), refreshed('GY-8', 4), mergeable('GY-10')],
      now: clock, metrics: metrics(31), agents: [{ name: 'reviewer-5' }], build: 'build-2' }]);
  assert.deepEqual(all.filter(check => !check.holds).map(check => check.invariant).sort(), [...systemInvariants].sort(), all.filter(check => check.holds).map(check => check.line).join('\n'));
  // A source that could not be read is not observed, never violated.
  const blind = checkInvariants(emptyInvariantRecord(), { work: [delivered('GY-5', 2 * hour, [session('reviewer-5')])], now: clock, agents: null });
  assert.equal(verdict(blind, 'lingering-sessions').observed, false);
  // A gate still failing is a recorded refusal: the stall bound does not apply.
  const refusal = emptyInvariantRecord(), stalled = mergeable('GY-10');
  checkInvariants(refusal, { work: [stalled], now: clock });
  assert.equal(verdict(checkInvariants(refusal, { work: [{ ...stalled, gates: [{ name: 'merge', passed: false, reasons: ['GitHub reports the pull request behind'] }] } as Work], now: clock + 40 * minute }), 'merge-stall').holds, true);
  // A head change of the candidate's own starts the refresh count over.
  const churn = emptyInvariantRecord();
  for (const n of [0, 1, 2, 3]) checkInvariants(churn, { work: [refreshed('GY-8', n)], now: clock + n * minute });
  const pushed = { ...refreshed('GY-8', 3), candidate: { ...refreshed('GY-8', 3).candidate!, sha: sha('9') } } as Work;
  checkInvariants(churn, { work: [pushed], now: clock + 5 * minute });
  assert.equal(churn.refreshes['work-GY-8'].count, 0, 'the worker pushed a head of its own');
  // Thresholds come from master config: raised, the same fixtures hold.
  const lenient = judge(fixtures['refresh-churn'].over.map(input => ({ ...input, thresholds: { refreshesWithoutHeadChange: 4 } })));
  assert.equal(verdict(lenient, 'refresh-churn').holds, true);
  assert.equal(config({ invariants: { refreshesWithoutHeadChange: 4 } as MasterConfig['invariants'] }).invariants?.refreshesWithoutHeadChange, 4);
  assert.equal(config().invariants, undefined, 'unset, every invariant keeps its default threshold');
  assert.deepEqual(invariantDefaults, { sessionAfterSettleMinutes: 30, refreshesWithoutHeadChange: 3, mergeableWithoutRefusalMinutes: 10, cycleP90Seconds: 30, cycleWindowMinutes: 60 });
});

function effects(overrides: Partial<DaemonEffects>): DaemonEffects {
  return { agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: iso(0) }), closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, persist: async () => {}, ...overrides };
}

test('unit:system-invariants-checked — the loop checks every invariant each cycle, master status prints a line per invariant', async () => {
  let cycle = 0;
  const world = () => {
    const now = clock + cycle * 3 * minute;
    return { now, work: [delivered('GY-5', 31 * minute + cycle * 3 * minute, [session('reviewer-5')]), refreshed('GY-8', cycle),
      // A merge refused by the gate is a recorded refusal; this one is mergeable and nothing refuses it, but GitHub never merges it.
      mergeable('GY-10')] };
  };
  const state = emptyDaemonState(config());
  state.metrics = metrics(31).map((metric, index) => ({ cycle: index, at: metric.at, durationMs: metric.durationMs, open: 0, actions: 0, stages: {}, lead: { count: 0, p50Ms: 0, p90Ms: 0 },
    production: { count: 0, p50Ms: 0, p90Ms: 0 }, postDeploy: { count: 0, p50Ms: 0, p90Ms: 0 }, postDeployFailures: 0 }));
  const loop = (index: number) => effects({
    snapshot: async () => { const { now, work } = world(); return { work, now: new Date(now).toISOString() }; },
    agents: () => [{ name: 'reviewer-5', pane_id: 'pane-reviewer-5' }],
    herdr: () => ({ agents: [{ name: 'reviewer-5', pane_id: 'pane-reviewer-5' }], available: true }),
    observeDeployment: async () => ({ source: 'unavailable', sha: index < 2 ? 'build-1' : 'build-2', at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
  });
  for (; cycle < 6; cycle++) await runCycle(config(), state, loop(cycle), () => clock + cycle * 3 * minute);
  // master status: one line per invariant, with its threshold and reading.
  const summary = daemonSummary(state, clock + 6 * 3 * minute, 30_000, 'machine-a');
  assert.equal(summary.invariants.lines.length, systemInvariants.length);
  for (const invariant of systemInvariants) assert.ok(summary.invariants.lines.some(line => line.startsWith(`${invariant}: VIOLATED`) && /threshold:/.test(line)), `${invariant}: ${summary.invariants.lines.join('\n')}`);
  assert.equal(summary.invariants.violated, systemInvariants.length);
});

test('unit:reviewer-repeat-question — the review of a change to the loop, master or merge writer asks what repetition does and never requires soak coverage; docs/master-agent.md lists the invariants within the budget', async () => {
  const binding = { key: 'GY-404', pr: 7, sha: sha('a'), baseSha: sha('b'), policyRevision: 1 };
  const prompt = (files: string[] | null) => reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, [{ id: 'AC-1', text: 'Behaves' }], undefined, files);
  for (const file of ['src/daemon/cycle.ts', 'src/master/status.ts', 'src/merge-writer/trial.ts']) {
    const text = prompt(['docs/master-agent.md', file]);
    assert.ok(text.includes(`This change touches ${file}`), `${file} is named: ${text}`);
    assert.match(text, /what it does when repeated across many cycles, heads and items/);
    assert.match(text, /never require new soak-suite coverage/);
    assert.doesNotMatch(text, /must be covered by the soak suites|is a BLOCKING finding/, 'the review asks about repetition but never demands soak coverage');
  }
  for (const files of [['src/model/work.ts', 'docs/coordination.md'], ['src/github-cache.ts', 'src/masterful.ts', 'src/daemonic/x.ts']]) assert.doesNotMatch(prompt(files), /repeated across many cycles/, `${files.join(', ')} runs on no loop cycle`);
  // A head nobody has observed yet: the question is asked, conditioned on the paths it names.
  assert.match(prompt(null), /If this change touches src\/daemon\/, src\/master\/, src\/merge-writer\/, which run on every loop cycle, ask what it does when repeated/);
  assert.deepEqual([...repeatingPaths], ['src/daemon/', 'src/master/', 'src/merge-writer/']);
  assert.equal(repetitionReviewSection(['README.md']), '');

  const guide = await readFile(new URL('../docs/master-agent.md', import.meta.url), 'utf8');
  const start = guide.indexOf('### System invariants');
  assert.ok(start >= 0, 'docs/master-agent.md has the section');
  const section = guide.slice(start, guide.indexOf('\n## ', start)).replace(/\s+/g, ' ');
  for (const phrase of [...systemInvariants.map(invariant => `\`${invariant}\``), '`lingering-sessions` (30 min)', '`refresh-churn` (3 per own head)', '`merge-stall` (10 min)', '`cycle-p90` (30 s)',
    'daemon.invariants.lines', '`invariants` in `.graphyard/master.json`', 'tests/soak-*.test.ts'])
    assert.ok(section.includes(phrase), `docs/master-agent.md lists: ${phrase}`);
});
