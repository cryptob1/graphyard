import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { computeAccount } from '../src/model/next-action.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3503: an item parked on a human request waits on that request — never a dispatch, never "a
// launch is requested" — whether or not it carries a blocker, and neither it nor the items depending
// on it hold a pipeline slot: an independent backlog item is released into the freed slot and launched.
// master status lists the request once, with its age and the answer, and answering makes it dispatchable.

const now = Date.now();
const hour = 60 * 60_000;
const at = (ms: number) => new Date(ms).toISOString();

function item(key: string, extra: Partial<Work> = {}): Work {
  return { id: `id-${key}`, key, title: key, stage: 'ready', ready: true, epoch: 0, revision: 1, policyRevision: 1, priority: 1, type: 'bug', blocker: null,
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:fixture'] }], dependencies: [], evidence: [], gates: [], workspaces: [], sessions: [], violations: [],
    createdAt: at(now - 3 * hour), updatedAt: at(now - 3 * hour), ...extra } as unknown as Work;
}

const request = { id: 'req-1', kind: 'goals-and-priorities', reason: 'The owner decides which goal comes first', needed: 'Which goal ships first? A choice between the two.',
  ask: 'Which goal ships first?', requestedBy: 'worker-a', epoch: 1, at: at(now - 2 * hour), recommendation: 'Ship the smaller goal first' };

function fixture() {
  // A: released, parked on a human request with no blocker; the build gate and a stale dispatch row still say "launch it".
  const a = item('GY-A', { stage: 'build', humanRequest: { ...request }, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
    actionQueue: { actions: [{ kind: 'dispatch', reason: 'GY-A is ready and unassigned', history: [] }] } } as unknown as Partial<Work>);
  // B: released earlier, depending on A. C: independent, in the backlog.
  const b = item('GY-B', { dependencies: [a.id] });
  const c = item('GY-C', { ready: false, stage: 'backlog', priority: 2 } as Partial<Work>);
  return [a, b, c];
}

const profile = (name: string, principal: string) => ({ name, principal, agentName: `agent-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/outside/${name}.token`, agentArgs: [], approvals: 'auto', environment: {} } as unknown as WorkerProfile);

async function status(config: MasterConfig, state: DaemonState, work: Work[]) {
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('parked-human-not-dispatch-status');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'c'.repeat(40)}\n`;
  return masterStatusReport(root, config, (async (path: string) => path === 'work-snapshot' ? { work, now: at(now) } : { messages: [] }) as any, run);
}

for (const proof of ['integration:parked-human-not-dispatch', 'e2e:parked-human-not-dispatch'])
test(`${proof} — a parked item waits on its request, holds no slot, is listed once in master status, and is dispatchable once answered`, async () => {
  const work = fixture();
  const [a] = work;
  // AC-1: the human wait, with the ask and its age; no dispatch.
  const account = computeAccount(a, work, new Date(now));
  assert.equal(account.action, null, 'no action is named for a parked item');
  assert.equal(account.wait?.kind, 'human');
  assert.match(account.wait!.detail, /Which goal ships first\? \(asked 2h/);
  // With a blocker recorded beside it, the same wait.
  assert.equal(computeAccount({ ...a, blocker: 'Waiting on a human-only decision (Goals and priorities): Which goal ships first?' }, work, new Date(now)).wait?.kind, 'human');

  // AC-2: concurrency 2; A and B are held off the pipeline, so C is released and launched.
  const directory = await temporaryDirectory('parked-human-not-dispatch');
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/parked', credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/graphyard', hostId: 'parked-host', baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master', workers: [profile('one', 'worker-a'), profile('two', 'worker-b')] });
  const state = emptyDaemonState(config);
  let agents: HerdrAgent[] = [];
  const released: string[] = [], launched: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: at(now) }),
    agents: () => agents,
    herdr: () => ({ agents, available: true }),
    credentials: async () => Object.fromEntries(config.workers.map(entry => [entry.name, { available: true, reason: null }])),
    closeSession: () => {}, persist: async () => {},
    release: async item => { released.push(item.key); return { ...item, ready: true, stage: 'ready' }; },
    dispatch: async (item, chosen) => {
      launched.push(item.key);
      agents = [...agents, { name: chosen.agentName, pane_id: `pane-${chosen.name}`, agent: 'claude', agent_status: 'working' } as HerdrAgent];
      return { pane: `pane-${chosen.name}`, epoch: 1 };
    },
    servingCommit: () => null,
  };
  await runCycle(config, state, effects, () => now);
  assert.deepEqual(released, ['GY-C'], 'the independent backlog item is released into the freed slot');
  assert.deepEqual(launched, ['GY-C'], 'only the independent item is launched');

  // AC-3/AC-4: master status shows A waiting on its request, listed once with its age and the answer.
  const report = await status(config, state, work);
  const line = report.items.find(entry => entry.key === 'GY-A')!;
  assert.doesNotMatch(JSON.stringify(line), /a launch is requested/);
  assert.match(line.waiting ?? '', /waits on a human: Which goal ships first\?/);
  const asks = report.attention.filter(entry => entry.text.includes('Which goal ships first?'));
  assert.equal(asks.length, 1, 'the request is listed once');
  assert.match(asks[0].text, /^GY-A waits on you \(overdue\) for 2h/);
  assert.equal(asks[0].next, 'graphyard answer GY-A req-1 ANSWER');
  assert.ok(!report.attention.some(entry => entry.subject === 'GY-B' || entry.subject === 'GY-C'));

  // Answering makes A dispatchable at once.
  assert.throws(() => assertDispatchable(a, work, at(now)), /human-only decision/);
  a.humanRequest = { ...a.humanRequest!, answer: { by: 'owner', at: at(now), outcome: 'provided', text: 'the smaller goal', waitedMs: 2 * hour } } as Work['humanRequest'];
  assert.doesNotThrow(() => assertDispatchable(a, work, at(now)));
  assert.equal(computeAccount(a, work, new Date(now)).action?.kind, 'dispatch');
});
