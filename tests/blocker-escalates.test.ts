import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyDaemonState, daemonStateSchema, daemonStatePath } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { buildBoard } from '../src/model/board.js';
import { openHumanOnly } from '../src/model/human-request.js';
import MasterPage from '../web/pages/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3280: a worker blocker raises attention at once and the master acts on it within one cycle.
// The cycle the blocker lands, master status carries it as an attention line naming the item, the
// blocker and how long it has waited, and the master session is prompted naming both. The 2026-11-13
// hwd-backend incident: a worker recorded a precise blocker at 08:42Z, the item went back to ready,
// master status attention stayed [] and the repo's master did nothing for six hours while a worker
// sat free. GY-3394 (owner direction 2026-11-15): however long a blocker stands it is the Master's —
// Needs you carries only the owner's three decisions, and the Master page shows the blocker until
// an unblock clears it.

const minute = 60_000;
const start = Date.parse('2026-11-13T12:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const blocker = 'the staging database is unreachable: psql: error: connection refused (fix: grant the worker sandbox 127.0.0.1:5432)';

/** An open item a worker blocked: the blocker and its stamp are on the record, the attempt ended, nothing is leased. */
function blockedItem(fields: Partial<Work> = {}): Work {
  return {
    id: 'w-3280', key: 'GY-1', title: 'Fix the export', description: '', type: 'bug', priority: 1, stage: 'ready', ready: true,
    epoch: 1, revision: 3, policyRevision: 1, dependencies: [], createdAt: iso(start - 3 * 60 * minute), updatedAt: iso(start - minute),
    stageEnteredAt: iso(start - minute), lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, violations: [], sessions: [],
    criteria: [{ id: 'AC-1', text: 'The export works', proofs: ['unit:export'] }], policy: { checks: ['test'], review: true },
    gates: [{ name: 'ready', passed: false, reasons: [blocker] }], blocker, blockedAt: iso(start - minute),
    pipeline: { attempts: [{ epoch: 1, owner: 'worker-1', claimedAt: iso(start - 2 * minute), endedAt: iso(start - minute), end: 'released' }],
      submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 1, requirements: 0 } },
    ...fields,
  } as unknown as Work;
}

async function fixture(visible = true) {
  const directory = await temporaryDirectory('blocker-escalates');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/project',
    credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  const prompts: string[] = [];
  let work = [blockedItem()], now = start;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: iso(now) }), agents: () => visible ? [{ name: 'master', pane_id: 'pM', agent_status: 'working' }] : [],
    credentials: async () => ({}), closeSession: () => {}, dispatch: async () => { assert.fail('no new implementation attempt: a blocked item is not claimable'); },
    persist: async () => {},
    masterSession: {
      wake: async (target, text) => { assert.equal(target, 'pM'); prompts.push(text); },
      launch: async text => { prompts.push(text); return { agentName: 'master', pane: 'pM', runtime: 'codex', account: 'account', session: 'registered-master' }; },
    },
  };
  let state = emptyDaemonState(config);
  return { directory, config, prompts, effects, get state() { return state; },
    work: (next: Work[]) => { work = next; },
    restart: () => { state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state))); },
    advance: (minutes: number) => { now += minutes * minute; },
    cycle: () => runCycle(config, state, effects, () => now),
    /** `graphyard master status` over this fixture's work and daemon state. */
    status: async () => {
      await writeFile(daemonStatePath(config), JSON.stringify(state));
      const root = await temporaryDirectory('blocker-escalates-status');
      execFileSync('git', ['init', '-q', root]);
      return masterStatusReport(root, config, async () => ({ work, now: iso(now) }), async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [{ name: 'master', pane_id: 'pM', agent_status: 'working' }] }) : 'Coordinating work.') : `${'b'.repeat(40)}\n`);
    },
    /** The Needs you rows, the board the dashboard serves and the Master page, over this fixture's work. */
    dashboard: () => {
      const rows = openHumanOnly(work.map(item => ({ work: item })), now);
      return { rows, board: buildBoard(work, now, rows), master: renderToStaticMarkup(createElement(MasterPage, { work, observedAt: now, token: '', api: async () => ({}), setSelected: () => {} })) };
    },
  };
}

test('integration:blocker-escalates — one cycle after the blocker: an attention line naming the item, blocker and wait, and a master prompt naming both; neither repeats while it stands unchanged', async () => {
  const f = await fixture();
  await f.cycle();
  assert.equal(f.prompts.length, 1, 'the master session is prompted the cycle the blocker lands');
  assert.ok(f.prompts[0].includes('GY-1') && f.prompts[0].includes(blocker), `the prompt names the item and blocker: ${f.prompts[0]}`);
  const status = await f.status();
  const line = status.attention.find((entry: { subject?: string }) => entry.subject === 'GY-1');
  assert.ok(line, `master status carries the blocker as attention: ${JSON.stringify(status.attention)}`);
  assert.match(line.text, /GY-1's blocker has waited 1m/);
  assert.ok(line.text.includes(blocker), 'the attention line names the blocker');
  assert.match(line.next, /graphyard master unblock GY-1 REASON/);
  assert.doesNotMatch(line.next, /Needs you/, 'the attention line no longer promises a Needs you escalation');
  // Unchanged, the blocker prompts nobody again and the attention line stands as it was.
  f.restart();
  await f.cycle();
  assert.equal(f.prompts.length, 1, 'an unchanged blocker is one prompt, not one per cycle');
  const still = await f.status();
  assert.equal(still.attention.filter((entry: { subject?: string }) => entry.subject === 'GY-1').length, 1);
});

test('integration:blocker-escalates — however long the blocker waits it never reaches Needs you: it stays Blocked and the Master page carries it', async () => {
  const f = await fixture();
  await f.cycle();
  // The blocker is one minute old at the start of the fixture: 29 more minutes make 30 — the bound
  // GY-3280 once escalated at, and past it (35 minutes) nothing changes for the owner.
  f.advance(29);
  let dashboard = f.dashboard();
  assert.deepEqual(dashboard.rows, [], 'a 30-minute-old blocker raises nothing on Needs you');
  assert.equal(dashboard.board.groups.blocked.find(entry => entry.key === 'GY-1') !== undefined, true, 'it is still Blocked');
  f.advance(5);
  dashboard = f.dashboard();
  assert.deepEqual(dashboard.rows, [], 'a 35-minute-old blocker still raises nothing on Needs you');
  assert.equal(dashboard.board.groups['needs-you'].some(entry => entry.key === 'GY-1'), false, 'never grouped under Needs you');
  assert.equal(dashboard.board.groups.blocked.find(entry => entry.key === 'GY-1') !== undefined, true, 'it stays Blocked');
  assert.ok(dashboard.master.includes('GY-1') && dashboard.master.includes('Fix the export'), 'the Master page lists it');
  assert.ok(dashboard.master.includes('blocked 35m ago'), `the Master page says how long it has stood: ${dashboard.master}`);
});

test('integration:blocker-escalates — a blocker with no recorded instant (a record older than blockedAt) never reads as freshly raised', async () => {
  const f = await fixture();
  f.work([{ ...blockedItem(), blockedAt: null, pipeline: undefined }]);
  f.advance(24 * 60);
  const dashboard = f.dashboard();
  assert.deepEqual(dashboard.rows, [], 'nothing is read as freshly raised without a recorded instant');
  assert.ok(dashboard.master.includes('GY-1'), 'the Master page still carries the blocker itself');
});

test('integration:blocker-escalates — unblocking clears the attention line, the Master page row and the blocker, and the item waits for a worker again', async () => {
  const f = await fixture();
  await f.cycle();
  f.advance(35);
  assert.ok(f.dashboard().master.includes('GY-1'), 'the Master page row stands before the unblock');
  // `graphyard master unblock GY-1 REASON` clears the blocker and its stamp in one write.
  f.work([{ ...blockedItem(), blocker: null, blockedAt: null, gates: [{ name: 'ready', passed: false, reasons: [] }] }]);
  f.restart();
  await f.cycle();
  const status = await f.status();
  assert.equal(status.attention.find((entry: { subject?: string }) => entry.subject === 'GY-1'), undefined, 'the attention line is gone');
  const dashboard = f.dashboard();
  assert.deepEqual(dashboard.rows, [], 'Needs you stays clear of it');
  assert.equal(dashboard.master.includes('GY-1'), false, 'the Master page row is gone');
  assert.equal(dashboard.board.groups['up-next'].some(entry => entry.key === 'GY-1'), true, 'the item waits for a worker again');
  assert.equal(f.prompts.length, 1, 'no new prompt for a cleared blocker');
});
