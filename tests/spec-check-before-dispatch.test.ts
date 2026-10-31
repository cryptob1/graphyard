import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDispatchable, masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { needsSpecCheck, specCheckRefusal, type SpecVerdict } from '../src/model/spec-check.js';
import { specCheckReportSection } from '../src/master/dispatch.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2992: the spec check before dispatch. A released feature item is not dispatched until its spec
// check reports: a ready verdict dispatches it; a gaps verdict holds it at ready with the report
// until master requirements changes it, which runs one re-check; a second gaps verdict dispatches
// with the report attached for the worker; a bug dispatches with no check. The loop tests drive
// runCycle with a stubbed spec checker — a launch that records itself and posts its report the way
// the control plane records a launched session's post, on `work.specCheck`.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const at = new Date(clock).toISOString();
const PARAPHRASE = 'The export flow moves behind the settings screen; AC-1 is proven by the e2e case that signs up and exports.';
const GAP = 'AC-1 does not say which of the two export buttons the flow starts from.';

/** A released, unblocked feature item at ready, with a live lease for nobody. */
function feature(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `id-${key}`, key, title: key, description: 'The export flow moves behind the settings screen.', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'A signed-up user can export their data from the settings screen', proofs: ['e2e:export-flow'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}

/** The checker's report, recorded as the control plane records it: bound to the revision its launch was handed, marked recheck when a gaps verdict already stands. */
function post(item: Work, verdict: SpecVerdict) {
  const recheck = !!item.specCheck && item.specCheck.verdict === 'gaps';
  item.specCheck = { policyRevision: item.specCheckLaunch!.policyRevision, verdict, paraphrase: PARAPHRASE, gaps: verdict === 'gaps' ? [GAP] : [], reviewer: 'spec-checker', at, ...(recheck ? { recheck: true } : {}) };
  item.specCheckLaunch = null;
}

/** Each item's loop state, kept across its drives as the running loop keeps it. */
const states = new Map<string, DaemonState>();
let launches = 0;

/** Two loop rounds: the stubbed spec checker registers its launch and posts its verdict the way the control plane records them; a verdict that lands in round one is acted on in round two. */
async function drive(item: Work, verdict: SpecVerdict | null, others: Work[] = [], cycles = 2) {
  const directory = await temporaryDirectory('spec-check-dispatch');
  try {
    const token = join(directory, 'coordinator.token');
    await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const credential = join(directory, 'worker.token');
    await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const profile: WorkerProfile = { name: 'worker', principal: 'worker-principal', agentName: 'agent-worker', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
    const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile] });
    const work = [item, ...others];
    const launched: string[] = [], checks: string[] = [], closed: string[] = [];
    const effects: DaemonEffects = {
      agents: () => [], credentials: async items => Object.fromEntries(items.map(entry => [entry.name, { available: true, reason: null }])),
      snapshot: async () => ({ work, now: at }),
      closeSession: pane => { closed.push(pane); },
      dispatch: async launched_item => { launched.push(launched_item.key); },
      // The stubbed spec checker: one session per owed check — its launch is registered on the
      // item (as the control plane records it), and its report, when it has one, lands at once.
      launchSpecCheck: async checked => {
        checks.push(checked.key); launches += 1;
        checked.specCheckLaunch = { id: `launch-${launches}`, reviewer: 'spec-checker', requester: 'master', tokenHash: 'f'.repeat(64), at, expiresAt: new Date(clock + 3_600_000).toISOString(), policyRevision: checked.policyRevision };
        if (verdict) post(checked, verdict);
        return { pane: `pane-${launches}` };
      },
      persist: async () => {},
    };
    const state = states.get(item.key) ?? emptyDaemonState(master);
    states.set(item.key, state);
    for (let round = 0; round < cycles; round += 1) await runCycle(master, state, effects, () => clock);
    return { launched, checks, closed, refusal: specCheckRefusal(item) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('unit:spec-check-before-dispatch — who owes one, and a released feature is not dispatched until its check reports', async () => {
  const item = feature('GY-10');
  assert.equal(needsSpecCheck(item), true);
  assert.match(specCheckRefusal(item)!, /^Spec check before dispatch has not reported/);
  assert.throws(() => assertDispatchable(item, [item], at), /Spec check before dispatch has not reported/, 'the dispatch hold is assertDispatchable\'s, so no path launches a worker');
  const { launched, checks, refusal } = await drive(item, null);
  assert.deepEqual(checks, ['GY-10'], 'the loop launches the spec checker for a released feature that owes one');
  assert.deepEqual(launched, [], 'and dispatches no worker before the check reports');
  assert.match(refusal!, /^Spec check before dispatch has not reported/);
  assert.equal(item.stage, 'ready', 'the item is held at ready');
});

test('unit:spec-check-before-dispatch — a ready verdict dispatches, and a reported item launches no second check', async () => {
  const item = feature('GY-11');
  const { checks, launched, refusal } = await drive(item, 'ready');
  assert.deepEqual(checks, ['GY-11'], 'the checker is launched once');
  assert.deepEqual(launched, ['GY-11'], 'a ready verdict dispatches the item (the round after the report lands)');
  assert.equal(refusal, null);
});

test('unit:spec-check-before-dispatch — a gaps verdict holds the item at ready with its report until master requirements changes it', async () => {
  const item = feature('GY-12');
  const held = await drive(item, 'gaps');
  assert.deepEqual(held.launched, [], 'a gaps verdict dispatches no worker');
  assert.deepEqual(held.checks, ['GY-12']);
  assert.equal(item.stage, 'ready', 'held at ready');
  assert.match(item.specCheck!.verdict === 'gaps' ? held.refusal! : '', new RegExp(`Spec check named gaps: ${GAP}`), 'the hold names the gaps');
  assert.ok(item.specCheck, 'the report stands on the item');
  assert.equal(item.specCheck!.recheck, undefined, 'a first gaps verdict is no re-check');
  // Master requirements revises the item: the revision bumps the policy revision, the standing
  // check no longer binds it, and the hold becomes the re-check wait.
  item.policyRevision += 1;
  item.criteria = [{ id: 'AC-1', text: 'A signed-up user can export their data from the settings screen, from either export button', proofs: ['e2e:export-flow'] }];
  const waiting = await drive(item, null);
  assert.match(waiting.refusal!, /Spec check of the revised requirements has not reported/);
  assert.deepEqual(waiting.launched, [], 'still held: the re-check has not reported');
});

test('unit:spec-check-before-dispatch — the requirements revision runs exactly one re-check, and its gaps verdict dispatches with the report attached', async () => {
  const item = feature('GY-13');
  await drive(item, 'gaps');
  assert.equal(item.specCheck!.recheck, undefined);
  item.policyRevision += 1;
  const { checks, launched, refusal } = await drive(item, 'gaps');
  assert.deepEqual(checks, ['GY-13'], 'one re-check runs');
  assert.deepEqual(launched, ['GY-13'], 'a second gaps verdict dispatches, the round after its report lands');
  assert.equal(refusal, null);
  assert.equal(item.specCheck!.recheck, true, 'the re-check is marked as such, judged from the standing gaps verdict');
  const section = specCheckReportSection(item);
  assert.match(section, /spec check/);
  assert.match(section, new RegExp(PARAPHRASE.slice(0, 40)), 'the worker reads the paraphrase');
  assert.match(section, new RegExp(GAP.slice(0, 30)), 'and the gaps it named');
});

test('unit:spec-check-before-dispatch — a bug item dispatches with no check at all', async () => {
  const item = feature('GY-14', { type: 'bug', description: 'The export button 500s on an empty dataset.' });
  assert.equal(needsSpecCheck(item), false, 'a bug owes no spec check');
  const { launched, checks, refusal } = await drive(item, null);
  assert.deepEqual(checks, [], 'the loop launches no spec checker for a bug');
  assert.deepEqual(launched, ['GY-14'], 'and dispatches it');
  assert.equal(refusal, null);
});

test('unit:spec-check-before-dispatch — a launch that expires unreported is relaunched', async () => {
  const item = feature('GY-15');
  await drive(item, null);
  item.specCheckLaunch = { ...item.specCheckLaunch!, expiresAt: new Date(clock - 1).toISOString() };
  const expired = item.specCheckLaunch!.id.replace('launch', 'pane');
  const { checks, launched, closed } = await drive(item, null);
  assert.deepEqual(checks, ['GY-15'], 'the expired launch is replaced by one fresh session');
  assert.deepEqual(launched, []);
  assert.deepEqual(closed, [expired], 'the expired session closes before its replacement launches; the replacement stands open');
});

test('unit:spec-check-before-dispatch — a report on requirements revised while the check ran is stale, and the loop runs the check again', async () => {
  const item = feature('GY-16');
  await drive(item, null);
  const first = item.specCheckLaunch!.id.replace('launch', 'pane');
  item.policyRevision += 1;
  post(item, 'ready');
  assert.equal(item.specCheck!.policyRevision, 1, 'the report judged the revision its launch was handed');
  assert.match(specCheckRefusal(item)!, /Spec check of the revised requirements has not reported/);
  const { checks, launched, closed } = await drive(item, 'ready');
  assert.deepEqual(checks, ['GY-16'], 'the revised requirements get their own check');
  assert.deepEqual(launched, ['GY-16'], 'whose ready verdict dispatches');
  assert.deepEqual(closed, [first, `pane-${launches}`], 'each checker pane closes once, after its report lands');
});

test('unit:spec-check-before-dispatch — a "No user-facing change" feature owes its check like any feature', async () => {
  const item = feature('GY-17', { description: 'No user-facing change: add an internal capability.' });
  assert.equal(needsSpecCheck(item), true);
  const { checks, launched, refusal } = await drive(item, null);
  assert.deepEqual(checks, ['GY-17'], 'the loop launches its checker');
  assert.deepEqual(launched, [], 'and dispatches no worker before it reports');
  assert.match(refusal!, /^Spec check before dispatch has not reported/);
});

test('unit:spec-check-before-dispatch — one spec check launches at a time, so the reviewer profile\'s concurrency bounds the checkers', async () => {
  const { checks } = await drive(feature('GY-18'), null, [feature('GY-19')], 1);
  assert.deepEqual(checks, ['GY-18'], 'a cycle launches one checker; the next launches after it settles, reading Herdr afresh');
});

test('unit:spec-check-before-dispatch — the EGM prompts are read from the Graphyard install, not the managed project', async () => {
  const { readVendorPrompts } = await import('../src/spec-check.js');
  const prompts = await readVendorPrompts();
  assert.ok(prompts.comprehension.length > 100 && prompts.readiness.length > 100);
});

test('unit:spec-check-before-dispatch — a spec checker holds its reviewer session in the agent registry while its launch stands', async () => {
  const { sessionEnded } = await import('../src/model/registry-sessions.js');
  const item = feature('GY-20');
  const session = { id: 's-1', role: 'reviewer', account: 'reviewer-a', work: 'GY-20', selectedAt: new Date(clock - 30 * 60_000).toISOString() } as Parameters<typeof sessionEnded>[0];
  item.specCheckLaunch = { id: 'launch-x', reviewer: 'spec-checker', requester: 'master', tokenHash: 'f'.repeat(64), at, expiresAt: new Date(clock + 30 * 60_000).toISOString(), policyRevision: 1 };
  assert.equal(sessionEnded(session, item, clock), null, 'past the launch grace, the standing launch keeps the session live');
  item.specCheckLaunch = null;
  assert.match(sessionEnded(session, item, clock)!, /no standing review request or spec-check launch/, 'once the report lands, the session ends');
});

test('unit:spec-check-before-dispatch — a launch a loop restart cut off before it registered launches again', async () => {
  const item = feature('GY-21');
  const key = `spec-check:${item.id}:${item.policyRevision}:`;
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const state = emptyDaemonState(master);
  state.actions[key] = { kind: 'review', work: item.key, principal: null, state: 'started', detail: `Launching ${item.key}'s spec check`, attempts: 1, epoch: null, cycle: 0, at: new Date(clock - 60_000).toISOString() };
  states.set(item.key, state);
  const { checks } = await drive(item, null);
  assert.deepEqual(checks, ['GY-21'], 'the restarted loop launches the check the cut-off launch never registered');
});
