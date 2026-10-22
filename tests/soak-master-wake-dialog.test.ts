import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, pruneDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { detectConsentPrompt } from '../src/consent-prompt.js';
import { masterWakeHeldKey } from '../src/daemon/cycle-master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1872 across the real loop's cycles, over simulated days: the master wake reads its pane first,
 * answers a settings-suggestion dialog with esc, re-reads, and only then wakes; a dialog it cannot
 * answer holds the wake under one standing record. Those branches now run every eligible cycle, so
 * this soak holds them against the system invariants after every cycle, beside enough unrelated
 * traffic that pruning runs throughout:
 *
 * - a day on which the runtime redraws the production autocompact suggestion (its footer wrapped
 *   onto "esc not" / "now") every two hours: each appearance is answered with one esc before the
 *   wake that follows it, and no wake text ever lands on the dialog;
 * - six hours of a suggestion that stays after its esc: at most one esc per cycle, never a wake,
 *   one standing hold restated only when its detail changes, retired by the wake once it clears;
 * - a day of a credential dialog: never a key, never a wake, the same one standing hold, retired by
 *   the wake once a human clears it.
 *
 * The master is replaced only by its twelve-hour budget, never over a dialog, and the action
 * table stays bounded however long a hold stands.
 */
const minute = 60_000, hour = 60 * minute;
/** The fixed clock every cycle is derived from; nothing in this file reads the wall clock. */
const start = Date.parse('2030-04-01T00:00:00.000Z');
const cycleMs = 5 * minute;

/** The production autocompact screen GY-1863 read off the master pane, its footer wrapped at that width. */
const compactDialog = [
  '✻ Brewed for 1m 25s · done 7:33 PM',
  ' We recommend compacting earlier',
  '   Want to autocompact at 400k tokens instead? Your model',
  '   doesn\'t change. Switch back any time with',
  '   /autocompact.',
  '     Autocompact at ‹ 400k › tokens',
  '     Keep auto (1m tokens)',
  '   ↑/↓ choose · ←/→ change size · enter confirm · esc not',
  '   now',
].join('\n');
const credentialDialog = ['Sign in to use Claude Code', '', 'Paste your API key, or sign in with your Claude account', '',
  '❯ Sign in with Claude account', '  API key (paste below)', '', '↑/↓ choose · enter confirm · esc to dismiss'].join('\n');
const cleanScreen = '❯ the session is awake and reading its instruction\n';

const wakeItem = (key: string, at: number): Work => ({
  id: `work-${key}`, key, title: `A claimable ${key}`, description: '', type: 'bug', priority: 0, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Delivered', proofs: ['manual:x'] }], policy: { checks: ['test'], review: true }, 
  stage: 'ready', revision: 1, policyRevision: 1, createdAt: new Date(start - 2 * hour).toISOString(), updatedAt: new Date(at).toISOString(),
  stageEnteredAt: new Date(start - hour).toISOString(), ready: true, epoch: 0,
  lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
} as unknown as Work);

test('soak:master-wake-dialog — over simulated days, answerable dialogs are put away one esc at a time before each wake, persistent and unanswerable dialogs hold the wake under one bounded record, and every invariant holds', { timeout: 300_000 }, async () => {
  const directory = await temporaryDirectory('soak-master-wake-dialog');
  try {
    const file = join(directory, 'coordinator.token');
    await writeFile(file, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: file, cliPath: 'graphyard',
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'soak-host', masterAgentName: 'graphyard-master-project',
      autoMerge: true, mergeMethod: 'merge', workers: [], run: { proofWorkflow: 'acceptance.yml', masterSessionMinutes: 720, masterHeartbeatMinutes: 5 } });
    const masterName = config.masterAgentName!;
    let now = start;
    // The pane's screen, and how it answers a key: 'clears' as the suggestion does, 'stays' as a stuck one, 'ignores' as nothing should be sent.
    let screen = cleanScreen, onKey: 'clears' | 'stays' = 'clears';
    const agents: HerdrAgent[] = [{ name: masterName, pane_id: 'w1V:pQ70', agent: 'claude', agent_status: 'idle' }];
    const keysAt: number[] = [], wakesAt: number[] = [], wakesOnDialog: number[] = [], launched: string[] = [], endReasons: string[] = [];
    const effects: DaemonEffects = {
      agents: () => [],
      herdr: () => ({ agents, available: true }),
      credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: [wakeItem('GY-9', now)], now: new Date(now).toISOString() }),
      dispatch: async () => {},
      observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, persist: async () => {},
      closeSession: pane => { const keep = agents.filter(agent => agent.pane_id !== pane); agents.splice(0, agents.length, ...keep); },
      endRegistrySession: async (_session, reason) => { endReasons.push(reason); },
      sessionOutput: () => screen,
      answerSession: (_agent, keys) => {
        assert.deepEqual(keys, ['esc'], 'the only key the loop ever sends a master dialog is the not-now esc');
        assert.equal(detectConsentPrompt(screen)?.kind, 'settings', `a key reaches only a settings suggestion, never: ${screen.slice(0, 60)}`);
        keysAt.push(now);
        if (onKey === 'clears') screen = cleanScreen;
      },
      promptSession: async () => { wakesAt.push(now); if (detectConsentPrompt(screen)) wakesOnDialog.push(now); },
      // The session budget still replaces the master every twelve hours; the replacement shares the pane's screen.
      masterSession: { launch: async () => {
        const pane = `w1V:pQ${71 + launched.length}`;
        launched.push(pane);
        agents.push({ name: masterName, pane_id: pane, agent: 'claude', agent_status: 'idle' });
        return { agentName: masterName, pane, runtime: 'claude', account: 'claude-master', session: `master-registry-${launched.length}` };
      } },
    };
    const state = emptyDaemonState(config);
    Object.assign(state.master, { agentName: masterName, pane: 'w1V:pQ70', runtime: 'claude', account: 'claude-master', session: 'master-registry-0',
      startedAt: new Date(start - 10 * minute).toISOString(), adopted: true, rotations: 0, misses: 0 });
    /** The standing hold row, read afresh each time (a call, so an earlier assertion never narrows it). */
    const heldRow = () => state.actions[masterWakeHeldKey];
    const violations: string[] = [], heldDetails = new Set<string>();
    let traffic = 0, maxActions = 0, maxHeldAttempts = 0, maxKeysInCycle = 0;
    const cycle = async (label: string) => {
      for (let row = 0; row < 60; row++, traffic++) state.actions[`traffic:${traffic}`] = { kind: 'refresh', work: `work-T-${traffic}`, principal: null, state: 'done',
        detail: `refreshed T-${traffic}`, attempts: 1, epoch: null, cycle: state.cycle, at: new Date(now).toISOString() };
      const keysBefore = keysAt.length;
      await runCycle(config, state, effects, () => now);
      pruneDaemonState(state);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`${label}: ${check.invariant} — ${check.reading}`);
      maxKeysInCycle = Math.max(maxKeysInCycle, keysAt.length - keysBefore);
      maxActions = Math.max(maxActions, Object.keys(state.actions).length);
      const held = state.actions[masterWakeHeldKey];
      if (held?.state === 'waiting') { heldDetails.add(held.detail); maxHeldAttempts = Math.max(maxHeldAttempts, held.attempts); }
      assert.equal(Object.keys(state.actions).filter(key => key.startsWith('wake:master:held')).length <= 1, true, `${label}: one standing hold row at most`);
      now += cycleMs;
    };

    // Day 1: the suggestion is redrawn every two hours and answered with one esc each time.
    let appearances = 0;
    for (let index = 0; index < (24 * hour) / cycleMs; index++) {
      if (index % ((2 * hour) / cycleMs) === 0) { screen = compactDialog; appearances += 1; }
      await cycle(`day 1 cycle ${index}`);
    }
    assert.equal(violations.join('\n'), '', 'every system invariant holds after every cycle of the redrawn suggestion');
    assert.equal(keysAt.length, appearances, 'each appearance is answered by exactly one esc');
    assert.deepEqual(wakesOnDialog, [], 'no wake text ever lands on the dialog');
    assert.ok(wakesAt.length >= appearances, 'the wakes went on after each esc');
    assert.equal(heldRow(), undefined, 'an answered dialog holds nothing');

    // Six hours of a suggestion that stays after its esc: never woken into, at most one esc a cycle.
    const stuckCycles = (6 * hour) / cycleMs, keysBeforeStuck = keysAt.length, wakesBeforeStuck = wakesAt.length;
    screen = compactDialog; onKey = 'stays';
    for (let index = 0; index < stuckCycles; index++) await cycle(`stuck cycle ${index}`);
    assert.equal(violations.join('\n'), '', 'every system invariant holds while the suggestion stays');
    assert.equal(wakesAt.length, wakesBeforeStuck, 'no wake is delivered while the dialog stays');
    assert.ok(keysAt.length - keysBeforeStuck >= 1 && keysAt.length - keysBeforeStuck <= stuckCycles, `the stuck suggestion is tried with esc, at most once a cycle (${keysAt.length - keysBeforeStuck} in ${stuckCycles} cycles)`);
    assert.equal(heldRow()?.state, 'waiting', 'the wake stands held');
    assert.match(heldRow()!.detail, /still shows a dialog/);
    screen = cleanScreen; onKey = 'clears';
    await cycle('stuck cleared');
    assert.equal(wakesAt.length, wakesBeforeStuck + 1, 'the wake goes once the dialog clears');
    assert.equal(heldRow()?.state, 'done', 'and retires the hold');

    // A day of a credential dialog: no key, no wake, the same single hold; cleared, the wake resumes.
    const keysBeforeCredential = keysAt.length, wakesBeforeCredential = wakesAt.length;
    screen = credentialDialog;
    for (let index = 0; index < (24 * hour) / cycleMs; index++) await cycle(`credential cycle ${index}`);
    assert.equal(violations.join('\n'), '', 'every system invariant holds while the credential dialog stands');
    assert.equal(keysAt.length, keysBeforeCredential, 'no key reaches a credential dialog in a day');
    assert.equal(wakesAt.length, wakesBeforeCredential, 'no wake is typed into it');
    assert.equal(heldRow()?.state, 'waiting', 'the standing hold survives a day of pruning');
    assert.match(heldRow()!.detail, /credential dialog/);
    screen = cleanScreen;
    await cycle('credential cleared');
    assert.equal(wakesAt.length, wakesBeforeCredential + 1, 'the wake goes once a human clears the dialog');
    assert.equal(heldRow()?.state, 'done');
    for (let index = 0; index < 12; index++) await cycle(`after cycle ${index}`);
    assert.equal(violations.join('\n'), '', 'every system invariant holds after the recovery');

    // Bounded across the days: no session churn, one esc a cycle at most, a hold restated only on change.
    const simulatedHours = (now - start) / hour;
    assert.ok(launched.length <= Math.ceil(simulatedHours / 12), `master sessions are replaced only by their budget, never over a dialog (${launched.length} in ${simulatedHours} hours)`);
    assert.deepEqual(endReasons.filter(reason => !/\(budget\)/.test(reason)), [], 'every master session ended on its budget, none as deaf or failed');
    assert.ok(maxKeysInCycle <= 1, `at most one esc per cycle (${maxKeysInCycle})`);
    assert.equal(maxHeldAttempts, 1, 'a standing hold is never restated into a growing count');
    assert.ok(heldDetails.size <= 2, `the hold's record names each held dialog once: ${[...heldDetails].join(' | ')}`);
    assert.ok(maxActions < 2_000, `the action table stays bounded under pruning (${maxActions} at most)`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
