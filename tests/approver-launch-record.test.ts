import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverSessionName, atomicPrivateWrite, loadMasterConfig, runAutonomyCommand, setupMaster, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import { handWatchPrefix } from '../src/daemon/decisions.js';
import { terminalDecisions } from '../src/cli/decision-report.js';
import { launchStartMs } from '../src/master/launch.js';
// A namespace import, so the base exercise (where approverLaunchesFile does not exist) loads the file and fails the cases.
import * as autonomy from '../src/master/autonomy.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import type { Work } from '../src/model.js';
import type { FleetClient, FleetSelection } from '../src/fleet.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1339, 2026-10-06 ~01:16Z: the doctor ran its sanctioned `master approver GY-1335 DECISION`
// from the coordinator checkout bound read-only; the approver runtime started, then the launch
// record .graphyard/approvers/launches.json failed with EROFS and the launch was closed. The record
// now lives under the managed data root keyed by the checkout, fails over to the checkout when the
// data root refuses writes, and a record no location accepts never closes a started runtime.
// One case per proof: integration:doctor-approver-launch, unit:approver-launch-record-writable.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const decision = 'c3835bc8-93fc-47fd-ac09-31c0f8d0e9c2';
const runsAsRoot = process.getuid?.() === 0;

function item(): Work {
  const now = new Date().toISOString();
  return {
    id: 'work-1335', key: 'GY-1335', title: 'Rescope', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Rescoped', proofs: ['unit:rescope'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'build', revision: 4, policyRevision: 1, createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}

async function boundCheckout(label: string) {
  const root = await temporaryDirectory(label), credentials = await temporaryDirectory(`${label}-credentials`);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const approverToken = join(credentials, 'approver.token');
  await writeFile(approverToken, 'approver-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), approver: { id: 'graphyard-approver-project', credentialFile: approverToken } });
  const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };
  return { root, config, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

/** Runs `body` with GRAPHYARD_DATA_HOME naming `dataHome`, as the doctor's session inherits it from the loop. */
async function withDataHome<T>(dataHome: string, body: () => Promise<T>): Promise<T> {
  const was = process.env.GRAPHYARD_DATA_HOME;
  process.env.GRAPHYARD_DATA_HOME = dataHome;
  try { return await body(); }
  finally { if (was === undefined) delete process.env.GRAPHYARD_DATA_HOME; else process.env.GRAPHYARD_DATA_HOME = was; }
}

/** `master approver GY-1335 DECISION claude` as the doctor runs it, against a stubbed Herdr that records every pane it is told to close. */
async function doctorApprover(root: string, config: MasterConfig, closed: string[]) {
  const herdr = (_command: string, args: string[]) => {
    if (args[0] === 'tab' && args[1] === 'create') return JSON.stringify({ result: { root_pane: { pane_id: 'pane-A', tab_id: 'tab-A' } } });
    if (args[0] === 'pane' && args[1] === 'close') closed.push(args[2]!);
    if (args[0] === 'tab' && args[1] === 'close') closed.push(args[2]!);
    return startedAtOnce(args) ?? JSON.stringify({ result: {} });
  };
  return await runAutonomyCommand(root, config, 'approver', ['GY-1335', decision, 'claude'], {
    coordinator: async () => ({ work: [item()], now: new Date().toISOString() }),
    readSecret: async () => '', agents: () => [], daemonLock: async () => null, runtime: herdr,
    mutate: async () => ({}),
  }) as { agentName: string; pane: string | null; unrecorded?: string };
}

/** Makes the checkout unwritable as the doctor's confinement binds it: its root and .graphyard refuse new files. */
async function readOnlyCheckout(root: string) {
  await mkdir(join(root, '.graphyard', 'approvers'), { recursive: true });
  for (const directory of [join(root, '.graphyard', 'approvers'), join(root, '.graphyard'), root]) await chmod(directory, 0o555);
  return async () => { for (const directory of [root, join(root, '.graphyard'), join(root, '.graphyard', 'approvers')]) await chmod(directory, 0o755); };
}

test('integration:doctor-approver-launch — master approver run from a read-only checkout launches the approver, records it under the data root and returns success', { skip: runsAsRoot ? 'root writes through read-only modes' : false }, async () => {
  const { root, config, cleanup } = await boundCheckout('doctor-approver');
  const dataHome = await temporaryDirectory('doctor-approver-data');
  const restore = await readOnlyCheckout(root);
  try {
    await withDataHome(dataHome, async () => {
      // Before the fix this wrote .graphyard/approvers/launches.json, failed with EACCES/EROFS, and
      // closed the started approver's pane.
      const closed: string[] = [];
      const launched = await doctorApprover(root, config, closed);
      const name = approverSessionName(item(), decision);
      assert.equal(launched.agentName, name);
      assert.equal(launched.pane, 'pane-A', 'the approver is launched');
      assert.equal(launched.unrecorded, undefined, 'its launch is recorded');
      assert.deepEqual(closed, [], 'the started approver is never closed for its bookkeeping');
      assert.equal(existsSync(join(root, '.graphyard', 'approvers', 'launches.json')), false, 'nothing is written into the read-only checkout');
      const file = autonomy.approverLaunchesFile(root, { GRAPHYARD_DATA_HOME: dataHome });
      assert.ok(file.startsWith(dataHome), 'the record lives under the managed data root');
      const record = await autonomy.readApproverLaunch(root, name);
      assert.equal(record?.work, 'GY-1335', 'the loop reads the record the doctor wrote, naming the item it judges');
      assert.equal(record?.decision, decision);
    });

    // With the record's place under the data root refusing writes too, the launch still succeeds
    // and says it is unrecorded: the started runtime judges its decision.
    const records = join(dataHome, 'approver-launches');
    await chmod(records, 0o555);
    try {
      await withDataHome(dataHome, async () => {
        const closed: string[] = [];
        const launched = await doctorApprover(root, config, closed);
        assert.equal(launched.pane, 'pane-A', 'the approver is launched');
        assert.deepEqual(closed, [], 'no location accepting the record never closes the started runtime');
        assert.match(launched.unrecorded ?? '', /approver launch record could not be written to .*approver-launches.* or .*\.graphyard\/approvers\/launches\.json/);
      });
    } finally { await chmod(records, 0o755); }
  } finally { await restore(); await cleanup(); }
});

test('unit:approver-launch-record-writable — the launch record is written under the data root, fails over to the checkout, and is returned unrecorded rather than thrown when both refuse', async () => {
  const root = await temporaryDirectory('launch-record'), dataHome = await temporaryDirectory('launch-record-data');
  const environment = { GRAPHYARD_DATA_HOME: dataHome };
  const launch = (agentName: string) => ({ agentName, account: 'env-a', runtime: 'claude', session: null, launchedAt: new Date().toISOString(), work: 'GY-1335', decision });
  const checkoutFile = join(root, '.graphyard', 'approvers', 'launches.json');
  const refusing = (codes: Record<string, string>) => async (file: string, value: unknown) => {
    const code = Object.entries(codes).find(([fragment]) => file.includes(fragment))?.[1];
    if (code) throw Object.assign(new Error(`${code}: read-only file system, open '${file}.tmp'`), { code });
    await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, JSON.stringify(value));
  };

  // A writable data root takes the record; the checkout is untouched.
  const written = await autonomy.saveApproverLaunch(root, launch('gy-approver-a'), Date.now(), { environment });
  assert.deepEqual(written, { file: autonomy.approverLaunchesFile(root, environment) });
  assert.equal(existsSync(checkoutFile), false);
  assert.equal(JSON.parse(await readFile(written.file!, 'utf8'))[0].agentName, 'gy-approver-a');

  // A data root that refuses writes fails over to the checkout, keeping the records already made.
  const failedOver = await autonomy.saveApproverLaunch(root, launch('gy-approver-b'), Date.now(), { environment, write: refusing({ 'approver-launches': 'EROFS' }) });
  assert.deepEqual(failedOver, { file: checkoutFile });
  assert.deepEqual(JSON.parse(await readFile(checkoutFile, 'utf8')).map((entry: { agentName: string }) => entry.agentName), ['gy-approver-a', 'gy-approver-b']);
  assert.deepEqual((await autonomy.readApproverLaunches(root, environment)).map(entry => entry.agentName), ['gy-approver-b', 'gy-approver-a'], 'both locations are read; the data root\'s record of a name wins');

  // Both refusing: the launch is returned unrecorded with each location and why, never thrown.
  for (const code of ['EROFS', 'EACCES', 'EPERM']) {
    const unrecorded = await autonomy.saveApproverLaunch(root, launch('gy-approver-c'), Date.now(), { environment, write: refusing({ 'approver-launches': code, '.graphyard': code }) });
    assert.equal(unrecorded.file, null);
    assert.match(unrecorded.unrecorded ?? '', new RegExp(`approver-launches.*\\(${code}: .* or .*launches\\.json \\(${code}: `));
  }

  // Any other failure is not a read-only location, and still fails the save.
  await assert.rejects(autonomy.saveApproverLaunch(root, launch('gy-approver-d'), Date.now(), { environment, write: refusing({ 'approver-launches': 'ENOSPC' }) }), /ENOSPC/);

  // Checkout records past a day are aged out on read, since that file is rewritten only on failover.
  await writeFile(checkoutFile, JSON.stringify([{ ...launch('gy-approver-old'), launchedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }]));
  assert.equal((await autonomy.readApproverLaunches(root, environment)).some(entry => entry.agentName === 'gy-approver-old'), false);
});

// GY-1598, 2026-10-09 19:34Z: the loop launched gy-approver-gy-1594-68c808bd, whose pane sat at an
// empty Claude prompt with its request never run. master status called it a stall and named
// `master approver GY-1594 DECISION`, which refused because the tab was still visible in Herdr; the
// decision waited 11 minutes for the master to close the tab by hand. A same-named approver `done`,
// or `idle` with a still screen, past its start bound by its launch record is now closed, with why,
// and the launch goes on — from the loop and from the command master status names alike. Working,
// blocked, idle with a moving screen, within the bound or of unknown age, it is kept and the
// launch refuses, and status names that command only when it succeeds. One proof:
// unit:approver-idle-stall-relaunch.

/** A Herdr stub holding `panes`: a close removes the pane from every later list, the launch creates pane-new, and `screens` answers each screen read in turn. */
function stubHerdr(panes: Set<string>, closed: string[], screens: (string | null)[] = []) {
  return (_command: string, args: string[]): string => {
    if (args[0] === 'tab' && args[1] === 'create') { panes.add('pane-new'); return JSON.stringify({ result: { root_pane: { pane_id: 'pane-new', tab_id: 'tab-new' } } }); }
    if (args[0] === 'pane' && args[1] === 'close') { closed.push(args[2]!); panes.delete(args[2]!); return JSON.stringify({ result: {} }); }
    if (args[0] === 'pane' && args[1] === 'list') return JSON.stringify({ result: { panes: [...panes].map(pane_id => ({ pane_id })) } });
    if (args[0] === 'agent' && args[1] === 'read') { const screen = screens.length ? screens.shift()! : '❯ '; if (screen === null) throw new Error('pane_not_found'); return screen; }
    return startedAtOnce(args) ?? JSON.stringify({ result: {} });
  };
}

test('unit:approver-idle-stall-relaunch — an approver idle past its start bound with its request never run is closed and relaunched by the loop and by master approver, and a working one still refuses', async () => {
  const { root, config, cleanup } = await boundCheckout('idle-approver');
  const dataHome = await temporaryDirectory('idle-approver-data');
  try {
    await withDataHome(dataHome, async () => {
      const work = item(), name = approverSessionName(work, decision);
      const bound = launchStartMs(config);
      const recordLaunch = (ageMs: number, pane = 'pane-old') => autonomy.saveApproverLaunch(root, { agentName: name, account: null, runtime: 'claude', session: null, launchedAt: new Date(Date.now() - ageMs).toISOString(), work: work.key, decision, pane });
      const statusFor = (status: string): HerdrAgent => ({ name, pane_id: 'pane-old', agent: 'claude', agent_status: status });

      // AC-1: the loop. Its watch of the decision holds no live session (its last launch did not
      // stand), while the earlier session's tab sits done in Herdr past its start bound.
      await recordLaunch(bound + 60_000);
      const panes = new Set(['pane-old']), closed: string[] = [];
      const herdr = stubHerdr(panes, closed);
      const listed = (): HerdrAgent[] => [...panes].map(pane => pane === 'pane-old' ? statusFor('done') : { name, pane_id: pane, agent: 'claude', agent_status: 'working' });
      const state = emptyDaemonState(config);
      state.approvals[`${handWatchPrefix}${decision}`] = approvalWatchSchema.parse({ work: work.key, action: 'requirements', decision, requestedAt: new Date(Date.now() - 600_000).toISOString(), launches: 1 });
      const loop: DaemonEffects = {
        agents: listed, credentials: async () => ({}), snapshot: async () => ({ work: [work], now: new Date().toISOString() }),
        closeSession: pane => { closed.push(pane); panes.delete(pane); }, dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, persist: async () => {},
        observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
        decisions: async () => ({ decisions: [{ id: decision, action: 'requirements', state: 'requested', input: {}, approvedBy: null, requestedAt: new Date(Date.now() - 600_000).toISOString() }] }),
        approverLaunches: () => autonomy.readApproverLaunches(root),
        // The loop's approver effect: the real launcher against what Herdr lists now.
        approver: async (subject, id) => { const launched = await autonomy.launchApprover(root, subject, id, 'claude', { agents: listed(), available: true }, herdr, {}, async () => ({})); return { agentName: launched.agentName, pane: launched.pane, runtime: launched.runtime, session: launched.session, ...(launched.replaced ? { replaced: launched.replaced } : {}) }; },
      };
      const result = await runCycle(config, state, loop, () => Date.now());
      assert.deepEqual(closed, ['pane-old'], 'the idle session that never ran its request is closed within one cycle');
      assert.ok(panes.has('pane-new'), `and a fresh approver is launched for the same decision: ${JSON.stringify(result.actions.map(action => action.detail))}`);
      const launch = result.actions.find(action => action.kind === 'decision' && action.state === 'done' && action.detail.includes('launched independent approver session'));
      assert.ok(launch, `the relaunch is recorded: ${JSON.stringify(result.actions.map(action => action.detail))}`);
      assert.match(launch.detail, new RegExp(`closed approver session ${name} \\(pane pane-old\\): done in Herdr \\d+s after its launch, past the ${bound / 1000}s start bound without running its request; launched independent approver session ${name}`), 'with why the old session was closed');
      assert.equal(state.approvals[`${handWatchPrefix}${decision}`]?.agentName, name);

      // AC-2: master status names the stall and the command that answers it, and that command
      // succeeds in the state it describes: it closes the done session of the same name first.
      const report = async (ageMs: number | null) => {
        const records = await autonomy.readApproverLaunches(root);
        return terminalDecisions(async () => ({ decisions: [{ id: decision, action: 'requirements', state: 'requested', requestedAt: new Date(Date.now() - 660_000).toISOString() }] }),
          [{ id: work.id, key: work.key, stage: 'build' }], { approvals: [], runtime: { available: true, agents: [statusFor('done')] }, now: Date.now(),
            starts: { records: ageMs === null ? [] : records, boundMs: bound } });
      };
      const command = (agents: HerdrAgent[]) => runAutonomyCommand(root, config, 'approver', [work.key, decision, 'claude'], {
        coordinator: async () => ({ work: [work], now: new Date().toISOString() }), readSecret: async () => '', agents: () => agents, daemonLock: async () => null, runtime: herdr, mutate: async () => ({}),
      }) as Promise<{ agentName: string; pane: string | null; replaced?: string }>;
      const reset = () => { panes.clear(); panes.add('pane-old'); closed.length = 0; };
      reset(); await recordLaunch(bound + 60_000);
      const stall = (await report(bound + 60_000)).attentionItems.find(entry => entry.text.includes(decision));
      assert.match(stall?.text ?? '', new RegExp(`approver session ${name} sits done in Herdr past its start bound and recorded no outcome — a stall`));
      assert.match(JSON.stringify(stall), new RegExp(`"graphyard master approver ${work.key} ${decision} \\[AGENT_KIND\\] closes ${name} and puts it to a fresh approver"`));
      const relaunched = await command([statusFor('done')]);
      assert.deepEqual(closed, ['pane-old'], 'master approver closes the done, never-started session');
      assert.equal(relaunched.pane, 'pane-new');
      assert.match(relaunched.replaced ?? '', /closed approver session .* without running its request/);

      // A session launched seconds ago for a decision requested eleven minutes ago is within its
      // start bound: status raises no stall for it, and the command refuses it alike.
      reset(); await recordLaunch(5_000);
      assert.equal((await report(5_000)).attentionItems.some(entry => entry.text.includes(decision)), false, 'a done session within its start bound is no stall yet');
      await assert.rejects(command([statusFor('done')]), /let it finish or close it first \(it is within its \d+s start bound until /);
      // With no launch record its age is unknown: the command refuses, and status names the pane to close first, not the command alone.
      const unknown = (await report(null)).attentionItems.find(entry => entry.text.includes(decision));
      assert.match(unknown?.text ?? '', /sits done in Herdr, but it has no launch record bound to its pane, so its age is unknown/);
      assert.match(JSON.stringify(unknown), /herdr pane close pane-old \(master approver refuses it while it has no launch record bound to its pane, so its age is unknown\), then graphyard master approver/);
      assert.deepEqual(closed, [], 'nothing was closed under a session within its bound');

      // An idle session is judged by status on the same verdict and screen reading as the command: idle at a still screen past
      // its bound is a stall whose named command closes it and launches; idle with a moving or unread screen is at work or
      // unknown, so status raises nothing and the command refuses it alike.
      const reportIdle = async (screens: (string | null)[]) => terminalDecisions(async () => ({ decisions: [{ id: decision, action: 'requirements', state: 'requested', requestedAt: new Date(Date.now() - 660_000).toISOString() }] }),
        [{ id: work.id, key: work.key, stage: 'build' }], { approvals: [], runtime: { available: true, agents: [statusFor('idle')] }, now: Date.now(),
          starts: { records: await autonomy.readApproverLaunches(root), boundMs: bound, pauseMs: 0, read: async () => { const screen = screens.shift(); return screen === undefined ? null : screen; } } });
      reset(); await recordLaunch(bound + 60_000);
      const idleStall = (await reportIdle(['╭─\n│ > \n╰─', '╭─\n│ > \n╰─'])).attentionItems.find(entry => entry.text.includes(decision));
      assert.match(idleStall?.text ?? '', new RegExp(`approver session ${name} sits idle at a still screen in Herdr past its start bound and recorded no outcome — a stall`));
      assert.match(JSON.stringify(idleStall), new RegExp(`"graphyard master approver ${work.key} ${decision} \\[AGENT_KIND\\] closes ${name} and puts it to a fresh approver"`));
      const idleRelaunch = await autonomy.launchApprover(root, work, decision, 'claude', { agents: [statusFor('idle')], available: true }, stubHerdr(panes, closed, ['╭─\n│ > \n╰─', '╭─\n│ > \n╰─']), {}, async () => ({}), { screenPauseMs: 0 });
      assert.deepEqual(closed, ['pane-old'], 'the command status names closes the idle session it described');
      assert.equal(idleRelaunch.pane, 'pane-new');
      // The launcher records the pane it launched into, so the next judgement of that session is bound to it.
      assert.equal((await autonomy.readApproverLaunches(root)).findLast(entry => entry.agentName === name)?.pane, 'pane-new');
      for (const screens of [['⏺ Bash(npm test)\n  ⎿ running 1s', '⏺ Bash(npm test)\n  ⎿ running 2s'], [null, null]]) {
        reset(); await recordLaunch(bound + 60_000);
        assert.equal((await reportIdle([...screens])).attentionItems.some(entry => entry.text.includes(decision)), false, `an idle session whose screen is ${screens[0] === null ? 'unread' : 'moving'} is no stall`);
      }

      // It still refuses while that session is working, blocked at a tool call, idle with a moving
      // screen (a long command), idle with a screen Herdr cannot read, within its bound, or of unknown age.
      const refusals: [string, number | null, (string | null)[], RegExp][] = [
        ['working', bound + 60_000, [], /\(it is working\)/],
        ['blocked', bound + 60_000, [], /\(it is blocked at a tool call or question, so it ran its request\)/],
        ['idle', bound + 60_000, ['⏺ Bash(npm test)\n  ⎿ running 1s', '⏺ Bash(npm test)\n  ⎿ running 2s'], /\(it is idle with a screen that is still changing, as while a long command runs\)/],
        ['idle', bound + 60_000, [null, null], /\(it is idle with a screen that Herdr could not read\)/],
        ['idle', 5_000, [], /\(it is within its \d+s start bound until /],
      ];
      for (const [status, ageMs, screens, why] of refusals) {
        reset(); if (ageMs !== null) await recordLaunch(ageMs);
        const run = stubHerdr(panes, closed, [...screens]);
        await assert.rejects(autonomy.launchApprover(root, work, decision, 'claude', { agents: [statusFor(status)], available: true }, run, {}, async () => ({}), { screenPauseMs: 0 }), why);
        assert.deepEqual(closed, [], `a ${status} session is never closed under it`);
      }
      // A silent invocation (a tool waiting on the network, output buffered) leaves an idle screen still after the request ran: a
      // screen that names the decision, or one fuller than a runtime's start, is at work. Status raises nothing and the command refuses.
      const silent = `❯ You are the independent Graphyard approver. Judge decision ${decision} on ${work.key}\n⏺ Bash(graphyard master decisions ${work.key})\n  ⎿ Running…`;
      const scrolled = Array.from({ length: 60 }, (_, line) => `⏺ read line ${line} of the pull request`).join('\n');
      for (const screen of [silent, scrolled]) {
        reset(); await recordLaunch(bound + 60_000);
        assert.equal((await reportIdle([screen, screen])).attentionItems.some(entry => entry.text.includes(decision)), false, 'an idle session whose still screen shows its request ran is no stall');
        await assert.rejects(autonomy.launchApprover(root, work, decision, 'claude', { agents: [statusFor('idle')], available: true }, stubHerdr(panes, closed, [screen, screen]), {}, async () => ({}), { screenPauseMs: 0 }),
          /\(it is idle with a screen that shows its request ran, as while a silent command waits\)/);
        assert.deepEqual(closed, [], 'a silently working session is never closed under it');
      }
      // A launch whose record could not be written leaves the previous same-named record, of another pane and well past the bound:
      // it dates nothing about the pane Herdr lists now, so the command refuses and status names the pane, never the close.
      reset(); await recordLaunch(bound + 60_000, 'pane-earlier');
      const stale = (await reportIdle(['╭─\n│ > \n╰─', '╭─\n│ > \n╰─'])).attentionItems.find(entry => entry.text.includes(decision));
      assert.match(JSON.stringify(stale), /herdr pane close pane-old \(master approver refuses it while it has no launch record bound to its pane, so its age is unknown\)/);
      await assert.rejects(autonomy.launchApprover(root, work, decision, 'claude', { agents: [statusFor('idle')], available: true }, stubHerdr(panes, closed, ['╭─\n│ > \n╰─', '╭─\n│ > \n╰─']), {}, async () => ({}), { screenPauseMs: 0 }),
        /\(it has no launch record bound to its pane, so its age is unknown\)/);
      assert.deepEqual(closed, [], 'a session dated only by an earlier pane\'s record is never closed');

      // An idle session whose screen holds still across the pause and shows no trace of its request never ran it: closed and replaced.
      reset(); await recordLaunch(bound + 60_000);
      const still = await autonomy.launchApprover(root, work, decision, 'claude', { agents: [statusFor('idle')], available: true }, stubHerdr(panes, closed, ['╭─\n│ > \n╰─', '╭─\n│ > \n╰─']), {}, async () => ({}), { screenPauseMs: 0 });
      assert.deepEqual(closed, ['pane-old']);
      assert.match(still.replaced ?? '', /idle in Herdr \d+s after its launch, past the \d+s start bound without running its request, its screen still/);
    });
  } finally { await cleanup(); await rm(dataHome, { recursive: true, force: true }); }
});

// GY-1604, follow-up of GY-1598. Observed 2026-10-09T20:58:29Z: decision 275a5b76's approver was named by master status "not
// running and recorded no outcome — a stall" 34 s after its launch while its pane worked, and the attention named a relaunch.
// The GY-1598 review also found (PRRT_kwDOUZby-s6q76sx) that the loop's adoption dated a fresh pane by an earlier same-named launch
// record when the fresh launch's record could not be written, and (PRRT_kwDOUZby-s6q8c9h) that replacing a stalled approver at the
// role's concurrency limit was refused for the slot the closed session still held. One proof: unit:approver-stall-followup.
test('unit:approver-stall-followup — stall checks date a session only by its own launch record, a closed stalled approver frees its registry slot before the replacement, and status never calls a starting or working approver not running', async () => {
  const { root, config, cleanup } = await boundCheckout('approver-followup');
  const dataHome = await temporaryDirectory('approver-followup-data'), claudeHome = await temporaryDirectory('approver-followup-claude');
  try {
    await withDataHome(dataHome, async () => {
      const work = item(), name = approverSessionName(work, decision), bound = launchStartMs(config);
      const requested = new Date(Date.now() - 600_000).toISOString();

      // AC-1: the loop adopts a same-named session in pane-new whose launch could not write its record; the latest record of the
      // name is an earlier launch's, in pane-old, past the bound. It dates nothing: the session is judged from when the loop saw it.
      await autonomy.saveApproverLaunch(root, { agentName: name, account: null, runtime: 'claude', session: 'registry-earlier', launchedAt: new Date(Date.now() - bound - 60_000).toISOString(), work: work.key, decision, pane: 'pane-old' });
      const panes = new Set(['pane-new']), closed: string[] = [], launched: string[] = [], done = new Set(['pane-new']);
      const listed = (): HerdrAgent[] => [...panes].map(pane_id => ({ name, pane_id, agent: 'claude', agent_status: done.has(pane_id) ? 'done' : 'working' }));
      const state = emptyDaemonState(config);
      const loop = (at: number): DaemonEffects => ({
        agents: listed, credentials: async () => ({}), snapshot: async () => ({ work: [work], now: new Date(at).toISOString() }),
        closeSession: pane => { closed.push(pane); panes.delete(pane); }, dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, persist: async () => {},
        observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(at).toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
        decisions: async () => ({ decisions: [{ id: decision, action: 'requirements', state: 'requested', input: {}, approvedBy: null, requestedAt: requested }] }),
        approverLaunches: () => autonomy.readApproverLaunches(root),
        approver: async () => { panes.add('pane-relaunched'); launched.push('pane-relaunched'); return { agentName: name, pane: 'pane-relaunched', runtime: 'claude', session: null }; },
        endRegistrySession: async (id, reason) => { if (endRefusals > 0) { endRefusals -= 1; throw new Error('registry unavailable'); } ended.push(`${id}: ${reason}`); },
      });
      const ended: string[] = [];
      let endRefusals = 0;
      const seenAt = Date.now();
      const first = await runCycle(config, state, loop(seenAt), () => seenAt);
      const watch = state.approvals[`${handWatchPrefix}${decision}`];
      assert.ok(watch, `the loop watches the session: ${JSON.stringify(first.actions.map(action => action.detail))}`);
      assert.equal(watch.launchedAt, null, 'the earlier pane\'s record does not date the session');
      assert.equal(watch.session, null, 'nor does it name the session\'s registry slot');
      assert.equal(watch.requestedAt, new Date(seenAt).toISOString(), 'it is dated from when the loop first saw it');
      assert.deepEqual(closed, [], 'a done session whose own launch the loop saw within the start bound is not closed');
      assert.match(first.actions.find(action => action.detail.startsWith(`Watching approver session ${name}`))?.detail ?? '', /no launch record names its pane pane-new, so it is dated from /);
      await runCycle(config, state, loop(seenAt + bound / 2), () => seenAt + bound / 2);
      assert.deepEqual(closed, [], 'still within the bound from the launch the loop observed');
      await runCycle(config, state, loop(seenAt + bound + 60_000), () => seenAt + bound + 60_000);
      assert.deepEqual(closed, ['pane-new'], 'past the bound from the loop\'s own observation it is a stall, closed');
      assert.deepEqual(launched, ['pane-relaunched'], 'and replaced');
      // The watch already exists when `master approver` replaces its pane and the replacement's record cannot be written: the watch is
      // rebound to the new pane and dated from when the loop first saw it, never judged by the replaced launch's age.
      const relaunchedAt = seenAt + bound + 60_000, replacedAt = relaunchedAt + bound + 60_000;
      // The relaunched pane's registry session and account are the replaced launch's, never the replacement's: the rebind ends that
      // session and the watch names none, so a later close or quota check is not charged to the earlier account.
      Object.assign(watch, { session: 'registry-relaunched', account: 'claude-earlier', runtime: 'claude' });
      panes.clear(); panes.add('pane-replaced'); done.add('pane-replaced');
      // A registry that cannot be told keeps the replaced launch's session on the watch, unbound, rather than lose the only id that
      // ends its slot (the replacement shares its name, so reconciliation cannot tell them apart); the next cycle ends it, then rebinds.
      endRefusals = 1;
      const refused = await runCycle(config, state, loop(replacedAt - 120_000), () => replacedAt - 120_000);
      assert.deepEqual([watch.pane, watch.session, watch.account], ['pane-relaunched', 'registry-relaunched', 'claude-earlier'], `a session the registry could not end is kept, and nothing rebound: ${JSON.stringify(refused.actions.map(action => action.detail))}`);
      assert.ok(refused.actions.some(action => action.state === 'failed' && action.detail.startsWith('Could not end approver registry session registry-relaunched')), 'the failed end is recorded');
      assert.deepEqual([closed, ended], [['pane-new'], []], 'and the replacement is neither closed nor judged by the replaced launch\'s age');
      const rebound = await runCycle(config, state, loop(replacedAt), () => replacedAt);
      assert.deepEqual(closed, ['pane-new'], `the already-watched replacement is not closed by the earlier launch's age: ${JSON.stringify(rebound.actions.map(action => action.detail))}`);
      assert.equal(watch.pane, 'pane-replaced', 'the watch is rebound to the replacement\'s pane');
      assert.equal(watch.launchedAt, new Date(replacedAt).toISOString(), 'and dated from when the loop first saw it');
      assert.match(rebound.actions.find(action => action.detail.includes('which replaced the one the watch held'))?.detail ?? '', /no launch record names that pane, so it is dated from /);
      assert.deepEqual(ended, ['registry-relaunched: approver session ' + name + ' in pane pane-relaunched was replaced by pane pane-replaced'], 'the replaced launch\'s registry session is ended');
      assert.deepEqual([watch.session, watch.account, watch.runtime], [null, null, null], 'and the watch carries none of the replaced launch\'s registry session, account or runtime');
      await runCycle(config, state, loop(replacedAt + bound / 2), () => replacedAt + bound / 2);
      assert.deepEqual(closed, ['pane-new'], 'still within the bound from the replacement the loop observed');
      await runCycle(config, state, loop(replacedAt + bound + 60_000), () => replacedAt + bound + 60_000);
      assert.deepEqual(closed, ['pane-new', 'pane-replaced'], 'past it the replacement is a stall, closed');

      // AC-2: the approver role allows one live session, held by the stalled session's launch. `master approver` closes the stalled
      // pane and ends that registry session before choosing the replacement, so the replacement is not refused for its slot.
      await writeFile(join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } }));
      let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', {
        runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'opus', id: 'claude-opus-5' }],
        accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: config.hostId, home: claudeHome } }],
        roles: [{ name: 'approver', accounts: ['claude-a'], concurrency: 1, policy: { args: [], tools: [], model: null } }], reason: 'fixture',
      }, { actor: 'operator', at: new Date().toISOString() }).registry;
      const stalled: FleetSession = { id: 'registry-stalled', role: 'approver', account: 'claude-a', runtime: 'claude', model: 'opus', host: config.hostId!, work: work.key, principal: null, group: null,
        selectedAt: new Date(Date.now() - bound - 60_000).toISOString(), selectedBy: 'coordinator', reason: 'fixture', skipped: [], endedAt: null, endReason: null };
      registry = { ...registry, sessions: [stalled] };
      const order: string[] = [];
      let endRefused = true;
      // A strict registry: no supersession, so only an explicit end frees the slot.
      const client: FleetClient = {
        document: async () => structuredClone(registry),
        select: async request => {
          order.push('select');
          const choice = chooseSession(registry, request, Date.now());
          if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision } satisfies FleetSelection;
          const session: FleetSession = { ...stalled, id: 'registry-replacement', selectedAt: new Date().toISOString(), reason: choice.reason };
          registry.sessions.push(session);
          return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
        },
        end: async (id, reason) => { order.push(`end ${id}`); if (endRefused) throw new Error('registry unavailable'); const session = registry.sessions.find(entry => entry.id === id); if (session && !session.endedAt) Object.assign(session, { endedAt: new Date().toISOString(), endReason: reason }); },
      };
      panes.clear(); panes.add('pane-stalled'); closed.length = 0;
      await autonomy.saveApproverLaunch(root, { agentName: name, account: 'claude-a', runtime: 'claude', session: 'registry-stalled', launchedAt: stalled.selectedAt, work: work.key, decision, pane: 'pane-stalled' });
      const herdr = stubHerdr(panes, closed);
      const stalledAgent: HerdrAgent = { name, pane_id: 'pane-stalled', agent: 'claude', agent_status: 'done' };
      // An end the registry refuses leaves the slot held: the launch is refused naming the session, and no replacement is chosen.
      await assert.rejects(autonomy.launchApprover(root, work, decision, undefined, { agents: [stalledAgent], available: true }, herdr, { registry: client, quota: false, cacheMs: 0 }, async () => ({}), { screenPauseMs: 0 }),
        (error: Error & { registrySession?: string }) => error.registrySession === 'registry-stalled' && /registry session registry-stalled could not be ended, so it still holds its slot, its pane is left open and no replacement was chosen: registry unavailable/.test(error.message));
      assert.deepEqual(closed, [], 'the stalled pane is left open, so the retry finds it and its launch record again');
      assert.deepEqual(order, ['end registry-stalled'], 'and no replacement is selected against the slot it still holds');
      endRefused = false; order.length = 0;
      const replaced = await autonomy.launchApprover(root, work, decision, undefined, { agents: [stalledAgent], available: true }, herdr, { registry: client, quota: false, cacheMs: 0 }, async () => ({}), { screenPauseMs: 0 });
      assert.deepEqual(closed, ['pane-stalled'], 'the stalled pane is closed');
      assert.equal(replaced.pane, 'pane-new', 'and the replacement launched');
      assert.equal(replaced.session, 'registry-replacement', 'on the slot the stalled session held');
      assert.deepEqual(order.slice(0, 2), ['end registry-stalled', 'select'], 'its registry session is ended before the replacement is chosen');
      assert.match(registry.sessions.find(entry => entry.id === 'registry-stalled')?.endReason ?? '', /closing stalled approver session .* past the \d+s start bound without running its request, to launch its replacement/);

      // AC-3: master status. A session the loop launched 34 s ago, not yet listed by Herdr (the loop's inventory predates its launch),
      // and one listed at work in the pane its launch named under no name, are in motion, never "not running".
      const report = (approvals: { work: string; decision: string; agentName: string; pane: string; launchedAt: string; launches: number }[], agents: HerdrAgent[], records: autonomy.ApproverLaunch[] = []) =>
        terminalDecisions(async () => ({ decisions: [{ id: decision, action: 'requirements', state: 'requested', requestedAt: requested }] }),
          [{ id: work.id, key: work.key, stage: 'build' }], { approvals, runtime: { available: true, agents }, now: Date.now(), starts: { records, boundMs: bound } });
      const watched = (ageMs: number) => [{ work: work.key, decision, agentName: name, pane: 'pane-34', launchedAt: new Date(Date.now() - ageMs).toISOString(), launches: 1 }];
      const starting = await report(watched(34_000), []);
      assert.deepEqual(starting.unanswered, [], 'a session within its start bound is no unanswered decision');
      const motion = starting.attentionItems.find(entry => entry.text.includes(decision));
      assert.match(motion?.text ?? '', new RegExp(`approver session ${name} was launched 34s ago and is within its ${bound / 1000}s start bound until .* — in motion, not a stall`));
      assert.doesNotMatch(JSON.stringify(motion), /not running|fresh approver/, 'it names no stall and no relaunch');
      assert.ok(motion?.inMotionUntil && Date.parse(motion.inMotionUntil) > Date.now(), 'it is in motion until its start bound passes');
      const working = await report(watched(bound + 60_000), [{ pane_id: 'pane-34', agent: 'claude', agent_status: 'working' }]);
      assert.deepEqual(working.unanswered, []);
      assert.match(working.attentionItems.find(entry => entry.text.includes(decision))?.text ?? '', /is working in Herdr in pane pane-34, the pane its launch named — in motion, not a stall/);
      // A hand launch known only by its record is judged alike, and one gone past its bound is still the stall it was.
      const recorded = await report([], [], [{ agentName: name, account: null, runtime: 'claude', session: null, launchedAt: new Date(Date.now() - 10_000).toISOString(), work: work.key, decision, pane: 'pane-hand' }]);
      assert.deepEqual(recorded.unanswered, []);
      const gone = await report(watched(bound + 60_000), []);
      assert.equal(gone.unanswered.length, 1);
      assert.match(gone.attentionItems.find(entry => entry.text.includes(decision))?.text ?? '', new RegExp(`approver session ${name} is not running and recorded no outcome — a stall`));
      // A replacement the loop rebound with no launch record naming its pane, listed done 34 s after the loop first saw it: the watch
      // of that pane dates it, never the earlier launch's record for another pane, so it is no stall and names no close and relaunch.
      const earlier: autonomy.ApproverLaunch = { agentName: name, account: null, runtime: 'claude', session: null, launchedAt: new Date(Date.now() - bound - 60_000).toISOString(), work: work.key, decision, pane: 'pane-earlier' };
      const reboundReport = await report(watched(34_000), [{ name, pane_id: 'pane-34', agent: 'claude', agent_status: 'done' }], [earlier]);
      assert.deepEqual(reboundReport.unanswered, [], 'a rebound replacement within its start bound from the loop\'s observation is no unanswered decision');
      assert.doesNotMatch(JSON.stringify(reboundReport.attentionItems.filter(entry => entry.text.includes(decision))), /a stall|fresh approver|herdr pane close/, 'and its attention names no stall to relaunch');
      const overdue = await report(watched(bound + 60_000), [{ name, pane_id: 'pane-34', agent: 'claude', agent_status: 'done' }], [earlier]);
      assert.equal(overdue.unanswered[0]?.visible?.closes, true, 'past that bound it is the stall master approver closes');
    });
  } finally { await cleanup(); await rm(dataHome, { recursive: true, force: true }); await rm(claudeHome, { recursive: true, force: true }); }
});
