import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountStartFailureAttention, accountStartFailurePath, clearAccountStartFailures, readAccountStartFailures, readProfileLaunchRecords, workerLaunchRows } from '../src/master/dispatch.js';
import { atomicPrivateWrite, awaitRuntimeStart, dispatchWork, loadMasterConfig, observeStart, runtimeScreens, SessionStartError, setupMaster, type HerdrAgent, type WorkerProfile } from '../src/master.js';
import { expandTypedCommand } from './helpers/launch-shell.js';

// GY-417: a runtime's start is judged from the runtime's own screen, and a launch whose preferred
// account's runtime never starts is visible in the fallback it made. OpenCode 1.18's start screen
// never prints the capitalized word the old check waited for, so every OpenCode launch timed out
// and silently fell back to a Claude account. One case per proof:
// unit:opencode-start-recognized, unit:start-failure-fallback-visible.

const at = '2026-09-25T18:00:00.000Z';
const clock = Date.parse(at);
const pane = 'w1V:pGY';
/** The launch command as the pane echoes it while the shell is typing or running it. */
const command = 'GY=/home/vish/code/project/.graphyard/launch/eng-oc; opencode --prompt "$(cat "$GY.request")"';
const echoLine = `vish@host ~/code/project ❯ ${command}`;

/** A Herdr pane whose answer at each moment comes from a timeline, on a virtual clock. */
class ScreenPane {
  calls: string[][] = [];
  now = clock;
  typed: string | null = null;
  renamed: string | null = null;
  constructor(private timeline: (elapsedMs: number) => { agent?: Partial<HerdrAgent> | null; screen?: string }) {}
  wait = (ms: number) => { this.now += ms; };
  bounds() { return { clock: () => this.now, wait: this.wait }; }
  run = (_command: string, args: string[]): string => {
    this.calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    const shown = this.timeline(this.now - clock);
    if (args[0] === 'pane' && args[1] === 'read') return shown.screen ?? '';
    if (args[0] === 'agent' && args[1] === 'get') return shown.agent ? json({ agent: { pane_id: args[2], ...shown.agent } }) : JSON.stringify({ error: { code: 'agent_not_found', message: `agent target ${args[2]} not found` } });
    if (args[0] === 'agent' && args[1] === 'rename') { this.renamed = args[3]; return json({ agent: shown.agent }); }
    return json({});
  };
}

test('unit:opencode-start-recognized — the start check matches OpenCode 1.18\'s own start screen (its block-character logo, input prompt and tab agents / ctrl+ hint bar), never the echoed launch command, which also holds the lowercase word', async () => {
  // The recorded screen: captured from OpenCode 1.18.32 in a pseudo-terminal, exactly as
  // `herdr pane read` returns it. It holds no capitalized "OpenCode" anywhere.
  const screen = await readFile(fileURLToPath(new URL('fixtures/opencode-1.18-start-screen.txt', import.meta.url)), 'utf8');
  assert.equal(/\bOpenCode\b/.test(screen), false, 'the recorded 1.18 screen never prints the word the old check waited for');
  assert.equal(runtimeScreens.opencode.test(screen), true, 'the start check recognizes the recorded screen');
  assert.equal(runtimeScreens.opencode.test(echoLine), false, 'the echoed launch command is not a start screen');
  assert.equal(runtimeScreens.opencode.test('❯ '), false, 'a bare shell prompt is not a start screen');

  // The case every OpenCode launch died in: Herdr sees the runtime's process but has not classified
  // it, and the TUI is on screen — the session is adopted as started at once.
  const started = new ScreenPane(() => ({ agent: { agent: 'opencode', agent_status: 'unknown' }, screen }));
  const adopted = await observeStart(pane, 'opencode', command, started.run);
  assert.equal(adopted.state, 'ready');
  assert.equal(adopted.detail, 'the opencode runtime is on screen while Herdr reports it unknown');
  const waited = await awaitRuntimeStart(pane, 'opencode', command, started.run, started.bounds());
  assert.equal(waited.state, 'ready'); assert.equal(waited.waitedMs, 0);

  // The banner alone, before Herdr sees a process, is a runtime starting — the screen check is what
  // sees it, and the launcher keeps reading instead of refusing at the bound.
  const banner = new ScreenPane(() => ({ screen }));
  const starting = await observeStart(pane, 'opencode', command, banner.run);
  assert.equal(starting.state, 'starting');
  assert.equal(starting.detail, 'the opencode banner is on screen');

  // The echoed command alone — even with the runtime's process already under the pane — is never
  // taken for the runtime's screen.
  const echoing = new ScreenPane(() => ({ agent: { agent: 'opencode', agent_status: 'unknown' }, screen: `${echoLine}\n` }));
  const pending = await observeStart(pane, 'opencode', command, echoing.run);
  assert.equal(pending.state, 'starting');
  assert.equal(pending.detail.includes('its screen showing'), false, 'the echoed command does not count as the screen showing');
  // And with no process under the pane either, it is the old refusal, named as it always was.
  const bare = new ScreenPane(() => ({ screen: `${echoLine}\n` }));
  const absent = await observeStart(pane, 'opencode', command, bare.run);
  assert.equal(absent.state, 'absent');
  assert.equal(absent.detail, 'command still echoing');
  await assert.rejects(awaitRuntimeStart(pane, 'opencode', command, bare.run, bare.bounds()),
    (error: unknown) => error instanceof SessionStartError && error.startCase === 'never started' && error.message.includes('(command still echoing)'));
});

/** A worker pane that draws the echoed launch line while an opencode runtime is up, and starts any other runtime at once. */
class FallbackPane {
  calls: string[][] = [];
  now = clock;
  typed: string | null = null;
  renamed: string | null = null;
  kinds: string[] = [];
  /** Runtimes that start at once instead of never coming up. */
  constructor(private healthy: Set<string> = new Set()) {}
  wait = (ms: number) => { this.now += ms; };
  bounds() { return { clock: () => this.now, wait: this.wait }; }
  run = (_command: string, args: string[]): string => {
    this.calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'tab' && args[1] === 'create') return json({ root_pane: { pane_id: 'w1V:pF1', tab_id: 'w1V:tF1' } });
    if (args[0] === 'pane' && args[1] === 'run') { this.kinds.push(expandTypedCommand(args[3]).kind); this.typed = args[3]; return ''; }
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    const kind = this.kinds.at(-1);
    if (!kind) return json({});
    if (args[0] === 'pane' && args[1] === 'read') return this.healthy.has(kind) ? `${kind} ready\n` : `vish@host ~/code/project ❯ ${this.typed}\n`;
    if (args[0] === 'agent' && args[1] === 'get') return this.healthy.has(kind) ? json({ agent: { agent: kind, agent_status: 'idle', pane_id: args[2] } }) : JSON.stringify({ error: { code: 'agent_not_found', message: `agent target ${args[2]} not found` } });
    if (args[0] === 'agent' && args[1] === 'rename') { this.renamed = args[3]; return json({ agent: { agent: kind, name: args[3] } }); }
    return json({});
  };
}

const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const item = { id: 'work-499', key: 'GY-499', title: 'OpenCode sessions never count as started', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
  criteria: [{ id: 'AC-1', text: 'Start check', proofs: ['unit:opencode-start-recognized'] }], policy: { checks: ['test'], review: true },
  stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
  reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] } as any;

/** A master with one OpenCode account and one Claude account, both logged in, and one launch profile naming them in that order. */
async function installed() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-runtime-screens-')), credentials = await mkdtemp(join(tmpdir(), 'graphyard-runtime-screens-credentials-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  const homes = await mkdtemp(join(tmpdir(), 'graphyard-runtime-screens-homes-'));
  const opencodeHome = join(homes, 'opencode-a');
  await mkdir(join(opencodeHome, 'opencode'), { recursive: true });
  await writeFile(join(opencodeHome, 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: 'k' } }), { mode: 0o600 });
  const claudeHome = join(homes, 'claude-b');
  await mkdir(claudeHome, { recursive: true });
  await writeFile(join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'claude-b-token', refreshToken: 'r', expiresAt: Date.now() + 5 * 3_600_000, subscriptionType: 'max' } }), { mode: 0o600 });
  const credential = join(credentials, 'worker.token');
  await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = await loadMasterConfig(root);
  await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...config,
    environments: [{ name: 'opencode-a', kind: 'opencode', home: opencodeHome }, { name: 'claude-b', kind: 'claude', home: claudeHome }] });
  const master = await loadMasterConfig(root);
  const profile: WorkerProfile = { name: 'opencode-primary', principal: 'graphyard-worker-1', agentName: 'eng-fallback', mode: 'launch', kind: 'opencode', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {}, accounts: ['opencode-a', 'claude-b'] };
  return { root, master, profile, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); await rm(homes, { recursive: true, force: true }); } };
}

test('unit:start-failure-fallback-visible — a launch whose preferred account\'s runtime never starts falls back to the profile\'s next account and the dispatch record and master status name both; three consecutive failures raise one attention item naming the account and runtime', async () => {
  const { root, master, profile, cleanup } = await installed();
  try {
    await clearAccountStartFailures(master, 'opencode-a');
    let claims = 0;
    const prepare = async () => ({ epoch: ++claims, path: join(root, `assigned-${claims}`), base: 'c'.repeat(40) });
    const release = async () => {};
    const dispatch = async (healthy: Set<string>) => {
      const pane = new FallbackPane(healthy);
      return { dispatched: await dispatchWork(root, item, profile, [], pane.run, [item], prepare, release, 5_000, new Date().toISOString(), { start: pane.bounds() }), pane };
    };

    // The preferred account's runtime never comes up; the launch falls forward to the Claude account
    // and the dispatch record names both, in that order.
    const { dispatched, pane } = await dispatch(new Set(['claude']));
    assert.deepEqual(pane.kinds, ['opencode', 'claude'], 'the fallback launches the next account\'s runtime');
    assert.deepEqual(claims, 2, 'the fallback claims afresh, after the failed launch released its claim');
    assert.equal(dispatched.account!.environment, 'claude-b');
    assert.ok(dispatched.fallback!.note.startsWith('opencode-a failed to start: the opencode runtime never started within 5 s in pane w1V:pF1 (command still echoing)'), dispatched.fallback!.note);
    assert.ok(dispatched.fallback!.note.endsWith('; launched on claude-b'), dispatched.fallback!.note);
    assert.deepEqual(dispatched.fallback!.failed.map(failure => [failure.account, failure.kind]), [['opencode-a', 'opencode']]);

    // The record the launcher keeps beside its reservation says the same, and master status joins it
    // onto the profile's row: a slot running Claude under an opencode-named profile is on the record.
    const records = await readProfileLaunchRecords(root, [profile]);
    assert.equal(records[profile.name].runtime, 'claude');
    assert.equal(records[profile.name].account, 'claude-b');
    assert.deepEqual(records[profile.name].failedAccounts.map(failure => failure.account), ['opencode-a']);
    const rows = workerLaunchRows([profile], records);
    assert.equal(rows[profile.name].runtime, 'claude');
    assert.equal(rows[profile.name].account, 'claude-b');
    assert.ok(rows[profile.name].fallback!.startsWith('opencode-a failed to start: ') && rows[profile.name].fallback!.endsWith('; launched on claude-b'), rows[profile.name].fallback!);
    assert.deepEqual(workerLaunchRows([{ name: 'never-dispatched' }], records), {}, 'a profile with no dispatch raises nothing');

    // The account's consecutive failures are counted: one so far, no attention yet.
    assert.equal((await readAccountStartFailures(master))['opencode-a'].failures, 1);
    assert.deepEqual(accountStartFailureAttention(await readAccountStartFailures(master), launcher), []);

    // A second, then a third launch on the same broken account: at three in a row, exactly one
    // attention item names the account and its runtime — the launches fell back, so nothing else shows it.
    await (await dispatch(new Set(['claude']))).dispatched;
    assert.equal((await readAccountStartFailures(master))['opencode-a'].failures, 2);
    assert.deepEqual(accountStartFailureAttention(await readAccountStartFailures(master), launcher), []);
    await (await dispatch(new Set(['claude']))).dispatched;
    const failures = await readAccountStartFailures(master);
    assert.equal(failures['opencode-a'].failures, 3);
    const items = accountStartFailureAttention(failures, launcher);
    assert.equal(items.length, 1);
    assert.equal(items[0].subject, 'opencode-a never starts');
    assert.ok(items[0].text.includes('opencode-a (runtime opencode)'), items[0].text);
    assert.ok(items[0].text.includes('failed to start 3 launches in a row'), items[0].text);
    assert.ok(items[0].text.includes('command still echoing'), 'the item carries the last start refusal');
    assert.equal(items[0].role, 'master');
    assert.match(items[0].next, /master environments --apply/);

    // A launch on the account that starts clears its run of failures, and the attention with it.
    const healthy = await dispatch(new Set(['opencode']));
    assert.deepEqual(healthy.pane.kinds, ['opencode']);
    assert.equal(healthy.dispatched.fallback, null);
    const after = await readProfileLaunchRecords(root, [profile]);
    assert.deepEqual(after[profile.name].failedAccounts, [], 'a dispatch without a fallback records none');
    assert.deepEqual(await readAccountStartFailures(master), {});
    assert.deepEqual(accountStartFailureAttention(await readAccountStartFailures(master), launcher), []);

    // A profile whose every account failed to start says so instead of dying on the last one alone.
    const lone: WorkerProfile = { ...profile, name: 'opencode-only', accounts: ['opencode-a'] };
    const failing = new FallbackPane(new Set());
    await assert.rejects(dispatchWork(root, item, lone, [], failing.run, [item], prepare, release, 5_000, new Date().toISOString(), { start: failing.bounds() }),
      (error: unknown) => error instanceof Error && error.message.startsWith('opencode-a failed to start: ')
        && error.message.endsWith('; launched on no named account; no further account of profile opencode-only to fall back to'));
  } finally { await cleanup(); }
  assert.ok(accountStartFailurePath(master).endsWith('.start-failures.json'), 'the start-failure ledger is kept beside the coordinator\'s other private launch state');
});
