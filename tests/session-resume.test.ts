import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchWork, loadMasterConfig, setupMaster, type WorkerProfile } from '../src/master.js';
import { dispatchedFile } from '../src/master/dispatch-reservation.js';
import { itemLine } from '../src/cli/master-status.js';
import { supervise } from '../src/supervisor.js';
import type { FleetClient } from '../src/fleet.js';
import { expandTypedCommand, requestOf } from './helpers/launch-shell.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2971: an item's next attempt resumes the previous attempt's runtime session when it runs on the
 * same runtime and account and that attempt recorded its session id; the brief stays the new
 * attempt's complete brief. Anything else launches fresh as the first attempt did, logging why.
 */
const finding = 'BLOCKING: parking.ts compacts the vehicle array, so stored indexes go stale; use stable ids';

/** A Herdr world: every pane gets its own id, and a `--resume` launch exits at once when `resumeExits` is set. */
function world(resumeExits = false) {
  const typed = new Map<string, string>(), commands: string[] = [], tabs: string[][] = [];
  let now = Date.now(), panes = 0;
  const json = (result: unknown) => JSON.stringify({ result });
  return { commands, tabs, bounds: (log: string[]) => ({ clock: () => now, wait: (ms: number) => { now += ms; }, log: (line: string) => log.push(line) }), run: (_command: string, args: string[]): string => {
    if (args[0] === 'tab' && args[1] === 'create') { panes++; tabs.push(args); return json({ root_pane: { pane_id: `w1V:p${panes}`, tab_id: `w1V:t${panes}` } }); }
    if (args[0] === 'pane' && args[1] === 'run') { typed.set(args[2], args[3]); commands.push(args[3]); return ''; }
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    const pane = args[1] === 'process-info' ? args[3] : args[2], command = typed.get(pane);
    if (!command) return json({});
    const exits = resumeExits && expandTypedCommand(command).args.includes('--resume');
    if (args[0] === 'pane' && args[1] === 'process-info') return json({ process_info: { shell_pid: 10, foreground_process_group_id: exits ? 10 : 11, foreground_processes: [] } });
    if (args[0] === 'pane' && args[1] === 'read') return exits ? `$ ${command}\nNo conversation found with session ID\n$\n` : 'claude ready\n';
    if (args[0] === 'agent' && args[1] === 'get') return exits ? json({}) : json({ agent: { agent: 'claude', agent_status: 'idle', pane_id: pane } });
    if (args[0] === 'agent' && args[1] === 'rename') return json({ agent: { agent: 'claude', name: args[3] } });
    return json({});
  } };
}

/** Imported per case, so a tree without the module fails each case rather than the file's load. */
const readAttemptLaunch = async (root: string, key: string) => (await import('../src/master/session-resume.js')).readAttemptLaunch(root, key);

async function fixture() {
  const holder = await temporaryDirectory('session-resume'), root = join(holder, 'repository'), credentials = join(holder, 'credentials');
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials, herdrWorkspace: 'w1V' }, coordinatorStatus);
  const master = await loadMasterConfig(root), hostId = master.hostId ?? 'unknown-host';
  const credentialFile = join(holder, 'worker.token');
  await writeFile(credentialFile, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(dirname(master.credentialFile), { recursive: true });
  const profile: WorkerProfile = { name: 'claude-worker', principal: 'graphyard-worker-1', agentName: 'eng-claude', mode: 'launch', kind: 'claude', credentialFile, agentArgs: [], approvals: 'auto', environment: {} };
  let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', { runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: hostId, home: null } }, { name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: hostId, home: null } }],
    roles: [{ name: 'worker', accounts: ['claude-a', 'claude-b'], concurrency: 4 }], reason: 'fixture' }, { actor: 'operator', at: new Date().toISOString() }).registry;
  // An account marked limited is one the registry passes over, as it does a spent quota.
  const limited = new Set<string>();
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      const choice = chooseSession(registry, { ...request, exclude: [...request.exclude ?? [], ...limited] }, Date.now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const session: FleetSession = { id: `session-${registry.sessions.length + 1}`, role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: new Date().toISOString(), selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry = { ...registry, sessions: [...registry.sessions, session] };
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    // Every session ends with its attempt, so each dispatch chooses the role's first free account.
    end: async () => {},
  };
  const endSessions = () => { registry = { ...registry, sessions: [] }; };
  /** Dispatch `work` as attempt `epoch` in its own worktree; `release` records any claim given back. */
  const dispatch = async (work: any, epoch: number, herdr = world()) => {
    endSessions();
    const at = new Date().toISOString(), log: string[] = [], released: number[] = [], path = join(root, `GY-1-${epoch}`);
    await mkdir(path, { recursive: true });
    let claims = 0;
    const prepare = async () => { claims++; return { epoch, path, base: 'c'.repeat(40) }; };
    const dispatched = await dispatchWork(root, { ...work, epoch: epoch - 1 }, profile, [], herdr.run, [work], prepare, async (_root, _key, claimed) => { released.push(claimed); }, 5_000, at,
      { start: herdr.bounds(log), probe: { registry: client, quota: false, cacheMs: 0, now: () => Date.parse(at) } as never });
    const launches = herdr.commands.map(command => expandTypedCommand(command));
    return { dispatched, launches, tabs: herdr.tabs, log, released, claims, path, record: await readAttemptLaunch(root, work.key) };
  };
  return { root, limited, dispatch };
}

const item = (extra: Record<string, unknown> = {}) => ({ id: 'work-GY-1', key: 'GY-1', title: 'Parking', description: 'Changes src/parking.ts.', type: 'feature', priority: 1, dependencies: [], lane: 'low', pipeline: { reworkRounds: 0, attempts: [] },
  criteria: [{ id: 'AC-1', text: 'Parking keeps stable ids', proofs: ['unit:parking'] }], policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
  reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...extra }) as any;
/** The launch with its session-id value masked, so two fresh launches compare word for word. */
const masked = (words: string[]) => words.map((word, index) => words[index - 1] === '--session-id' ? 'ID' : word);
const sessionIdOf = (args: string[]) => args[args.indexOf('--session-id') + 1];

test('unit:next-attempt-resumes-previous-session — attempt 2 resumes attempt 1\'s Claude session with its own complete brief, worktree and epoch; a limited account, a Codex attempt 1 or no recorded id launches fresh as attempt 1 did and logs why', async () => {
  const { root, limited, dispatch } = await fixture();
  const first = await dispatch(item(), 1);
  assert.equal(first.launches.length, 1);
  const id = sessionIdOf(first.launches[0].args);
  assert.match(id, /^[0-9a-f-]{36}$/, 'a Claude launch names its session id, so the next attempt can resume it');
  assert.equal(first.record?.session, id, 'the item\'s launch record keeps the runtime session id');
  assert.equal(first.record?.account, 'claude-a');
  assert.equal(first.record?.runtime, 'claude');

  const second = await dispatch(item(), 2);
  assert.equal(second.launches.length, 1);
  const [launch] = second.launches;
  assert.equal(launch.kind, 'claude');
  assert.equal(launch.args[launch.args.indexOf('--resume') + 1], id, 'the launch carries Claude Code\'s resume form with attempt 1\'s id');
  assert.ok(!launch.args.includes('--session-id'));
  const brief = requestOf('claude', launch.args)!;
  assert.match(brief, /complete GY-1 2 --head/, 'the first request is attempt 2\'s full brief');
  assert.deepEqual(launch.words.slice(launch.words.indexOf('watch') + 1, launch.words.indexOf('watch') + 3), ['GY-1', '2'], 'supervised under attempt 2\'s epoch');
  assert.equal(launch.stem, join(second.path, '.graphyard/launch/eng-claude'), 'in attempt 2\'s worktree');
  assert.equal(second.dispatched.resumedFrom, 1);
  assert.ok(second.log.some(line => line.includes('GY-1 attempt 2 resumes attempt 1\'s claude session')), second.log.join('\n'));
  assert.equal(second.record?.resumedFrom, 1);
  assert.equal(second.record?.session, id);

  // Today's launch: what attempt 1 typed, with its session id, its brief, its worktree and its epoch aside.
  const shape = (attempt: Awaited<ReturnType<typeof dispatch>>, epoch: number) => {
    const words = masked(attempt.launches[0].words), request = requestOf('claude', attempt.launches[0].args), watch = words.indexOf('watch');
    return words.map((word, index) => word === request ? 'REQUEST' : index === watch + 2 ? 'EPOCH' : word.replaceAll(attempt.path, 'WORKTREE').replaceAll(`gy-1-${epoch}`, 'gy-1-N'));
  };
  const today = shape(first, 1);
  const assertFresh = (attempt: Awaited<ReturnType<typeof dispatch>>, epoch: number, why: RegExp) => {
    assert.equal(attempt.launches.length, 1);
    assert.ok(!attempt.launches[0].args.includes('--resume'), 'no resume form');
    assert.deepEqual(shape(attempt, epoch), today, 'the fresh launch is attempt 1\'s launch');
    assert.equal(attempt.dispatched.resumedFrom, null);
    assert.ok(attempt.log.some(line => line.startsWith(`graphyard: GY-1 attempt ${epoch} launches a fresh session: `) && why.test(line)), attempt.log.join('\n'));
  };

  // The account attempt 2 ran on is limited: the selection takes claude-b, and the launch is fresh.
  limited.add('claude-a');
  const spent = await dispatch(item(), 3);
  assert.equal(spent.record?.account, 'claude-b');
  assertFresh(spent, 3, /account claude-a is not free; this launch is on claude-b/);

  // Attempt 1 ran on Codex, this launch is Claude.
  await writeFile(dispatchedFile(root, 'GY-1'), JSON.stringify({ epoch: 4, at: new Date().toISOString(), runtime: 'codex', account: 'claude-b', session: 'codex-rollout', path: '/elsewhere' }));
  assertFresh(await dispatch(item(), 5), 5, /attempt 4 ran on codex, this launch on claude/);

  // Attempt 1 recorded no session id.
  await writeFile(dispatchedFile(root, 'GY-1'), JSON.stringify({ epoch: 6, at: new Date().toISOString(), runtime: 'claude', account: 'claude-b', session: null }));
  assertFresh(await dispatch(item(), 7), 7, /attempt 6 recorded no runtime session id/);
});

test('unit:rework-resumes-with-findings-and-falls-back — a CHANGES_REQUESTED rework resumes with the findings verbatim and status reads "attempt 2 (resumed from 1)"; a resume that exits at start launches the same attempt fresh, its lease kept', async () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  const rework = item({ stage: 'build', reworkRequested: true, submission: { epoch: 1, pr: 7 }, candidate: { sha: 'e'.repeat(40), baseSha: 'c'.repeat(40), pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' },
    lastRework: { reason: `review-claude-a requested changes on eeeeeeeeeeee: ${finding}`, binding: 'b', at }, pipeline: { attempts: [], submittedAt: new Date(Date.now() - 120_000).toISOString(), reworkRounds: 1, interventions: { blocked: 0, requirements: 0 }, resubmittedAt: null } });
  {
    const { root, dispatch } = await fixture();
    const first = await dispatch(item(), 1);
    const id = sessionIdOf(first.launches[0].args);
    const second = await dispatch(rework, 2);
    const [launch] = second.launches;
    assert.equal(launch.args[launch.args.indexOf('--resume') + 1], id, 'the rework resumes attempt 1\'s session');
    const brief = requestOf('claude', launch.args)!;
    assert.ok(brief.includes(finding), 'the resumed session\'s brief carries the reviewer\'s findings verbatim');
    assert.match(brief, /This attempt is a rework round/);
    const line = itemLine({ ...rework, epoch: 2 }, Date.now(), await readAttemptLaunch(root, 'GY-1'));
    assert.equal(line.attempt, 'attempt 2 (resumed from 1)');
    assert.equal(itemLine({ ...rework, epoch: 2 }, Date.now(), null).attempt, 'attempt 2');
  }
  {
    const { dispatch } = await fixture();
    const first = await dispatch(item(), 1);
    const id = sessionIdOf(first.launches[0].args);
    const second = await dispatch(rework, 2, world(true));
    assert.equal(second.launches.length, 2, 'the resume, then one fresh launch');
    assert.equal(second.launches[0].args[second.launches[0].args.indexOf('--resume') + 1], id);
    const fresh = second.launches[1];
    assert.ok(!fresh.args.includes('--resume'));
    assert.notEqual(sessionIdOf(fresh.args), id, 'the fresh launch starts its own session');
    assert.ok(requestOf('claude', fresh.args)!.includes(finding), 'the fresh launch carries the same brief');
    assert.deepEqual(fresh.words.slice(fresh.words.indexOf('watch') + 1, fresh.words.indexOf('watch') + 3), ['GY-1', '2'], 'the same attempt');
    assert.equal(second.claims, 1, 'nothing was claimed again');
    assert.deepEqual(second.released, [], 'the lease was never given back');
    assert.equal(second.dispatched.epoch, 2);
    assert.equal(second.dispatched.resumedFrom, null);
    assert.ok(second.log.some(line => /GY-1 attempt 2 launches a fresh session: the resume of attempt 1's session failed at start \(exited\)/.test(line)), second.log.join('\n'));
    assert.equal(second.record?.resumedFrom, null);
    const tab = (pane: number) => second.tabs[pane - 1];
    assert.ok(tab(1).includes('GRAPHYARD_RESUME_LAUNCH=1') && !tab(2).includes('GRAPHYARD_RESUME_LAUNCH=1'), 'only the resume launch\'s supervisor is told to keep the lease on an early exit');
  }
  {
    // The resume launch's `watch` supervisor: a runtime exiting in its first minute surrenders nothing, so the
    // launcher's relaunch holds the same lease; any other launch's early exit still releases it.
    const { resumeExitWindowMs } = await import('../src/master/session-resume.js');
    const exitAtOnce = async (earlyExitKeepsLeaseMs?: number) => {
      const surrendered: string[] = [];
      await supervise(process.execPath, ['-e', 'process.exit(1)'], 2, async () => ({ updatedAt: new Date().toISOString(), lease: { epoch: 2, expiresAt: new Date(Date.now() + 120_000).toISOString() } }) as never,
        { detached: false, intervalMs: 20, graceMs: 25, session: { visible: () => null, surrender: async cause => { surrendered.push(cause); } }, ...(earlyExitKeepsLeaseMs ? { earlyExitKeepsLeaseMs } : {}) });
      return surrendered;
    };
    assert.deepEqual(await exitAtOnce(resumeExitWindowMs), [], 'a resume that exits at once keeps the lease');
    assert.equal((await exitAtOnce()).length, 1, 'a fresh launch that exits releases it, as before');
  }
});
