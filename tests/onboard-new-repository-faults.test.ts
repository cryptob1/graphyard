import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal, Work } from '../src/model.js';
import { batchGateStep, fetchRefusalKey, fetchRetryBackoffMs } from '../src/daemon/cycle-batch-gate.js';
import { gateRecordPath, readGateRecord } from '../src/batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { emptyDaemonState, writeDaemonState, type DaemonState } from '../src/daemon/state.js';
import { masterLaunchBackoffAfter, masterLaunchKey, masterLaunchRetryMs, runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { awaitRuntimeStart, SessionStartError, startAgentSession } from '../src/master.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { setupChecklist } from '../src/model/setup-checklist.js';
import { encodeLoopCheckoutTrust, loopFetchRefusalHeader } from '../src/model/loop-presence.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3336: three faults that left the lumina-investor install failing every cycle. (1) A remote
// that refuses the fetch of the base branch — a SAML organization that has not authorised the
// merge writer's key — is one standing line on the Setup page and in master status quoting the
// remote's refusal and the fix, and the loop retries the fetch with a growing backoff instead of
// every cycle. (2) A repository with no e2e/cases directory has an empty case list, not a batch
// gate that fails its diagnostics every cycle. (3) The launcher accepts its runtime's folder-trust
// prompt for the install's own checkout — the folder the operator connected — names the missing
// executable when execvp fails, and a launch failing the same way three times is retried with
// backoff behind one attention line instead of a new pane each cycle.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const repository = 'inspecthoa/lumina-investor';

/** The remote's refusal, as git's fetch prints it on stderr for an unauthorised SAML key. */
const samlRefusal = () => Object.assign(
  new Error("Command failed: git fetch --no-tags origin main\nfatal: Could not read from remote repository."),
  { stderr: "ERROR: The 'InspectHOA' organization has enabled or enforced SAML SSO. Your SSH key is not authorized for this organization. Visit https://github.com/settings/ssh to authorize.\nfatal: Could not read from remote repository.\nPlease make sure you have the correct access rights\nand the repository exists.\n" });

/** A bare origin holding one main commit — a repository Graphyard has never gated, with no e2e/cases — and its coordinator checkout. */
async function freshRepository(label: string, files: Record<string, string> = { 'graphyard.json': '{}\n', 'package.json': '{"name":"lumina-investor"}\n' }) {
  const base = await temporaryDirectory(label);
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  for (const [name, text] of Object.entries(files)) { await mkdir(join(pusher, name, '..'), { recursive: true }); await writeFile(join(pusher, name), text); }
  git(pusher, 'add', '.');
  git(pusher, 'commit', '-q', '-m', 'base');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  git(base, 'clone', '-q', origin, coordinator);
  return { base, coordinator, tip: git(pusher, 'rev-parse', 'HEAD'), cleanup: async () => { await rm(base, { recursive: true, force: true }); } };
}

/** The merge writer's reads over the coordinator checkout, with a passing trial and a fetch that can be refused. */
function reads(coordinator: string, gate: { root: string; repository: string }, fetch: () => Promise<string>) {
  const trials: { commit: string; proofs: string[] }[] = [];
  const value: MergeWriterReads = {
    baseBranch: 'main', now: Date.now,
    fetch,
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: async (commit, _files, item) => {
      trials.push({ commit, proofs: item.criteria.flatMap(criterion => criterion.proofs) });
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {} } as unknown as MergeTrialRun;
    },
    push: async () => 'pushed',
    holds: async () => true,
    record: async () => undefined,
    gate,
  };
  return { value, trials };
}

/** A cycle for batchGateStep on a virtual clock. */
function gateCycle(state: DaemonState, value: MergeWriterReads, clock: () => number, log: (line: string) => void = () => {}) {
  return { state, effects: { mergeWriter: value } as any, snapshot: { work: [], now: new Date(clock()).toISOString() }, performed: [], now: clock, log };
}

test('e2e:onboard-new-repository-faults — a fresh install on a repository with no e2e/cases directory completes its batch-gate diagnostics with an empty case list', async () => {
  const { coordinator, tip, cleanup } = await freshRepository('onboard-no-cases');
  try {
    const state = emptyDaemonState({ url: 'https://graphyard.example', repository } as any);
    let clock = Date.now();
    const loop = reads(coordinator, { root: coordinator, repository }, async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); });
    const first = await batchGateStep(gateCycle(state, loop.value, () => clock));
    assert.ok(first, 'the gate step ran');
    await first.diagnostics;
    const record = readGateRecord(gateRecordPath(coordinator))!;
    assert.equal(record.verified, tip, 'the fetched main tip is the first verified commit at rollout');
    assert.ok(record.diagnosticsAt, 'the diagnostics completed rather than failing on the missing e2e/cases');
    assert.deepEqual(loop.trials.map(entry => entry.proofs), [[]], 'the diagnostics ran the full suite with no e2e case to bind');
    assert.deepEqual(Object.keys(record.diagnosticFailures ?? {}), [], 'nothing failed and nothing was filed');
    // A second pass after the interval completes the same way: the empty catalog is stable, not a one-off.
    clock += 25 * 60 * 60_000;
    const again = await batchGateStep(gateCycle(state, loop.value, () => clock));
    await again!.diagnostics;
    assert.ok(readGateRecord(gateRecordPath(coordinator))!.diagnosticsAt);
  } finally { await cleanup(); }
});

test('e2e:onboard-new-repository-faults — a remote refusing the fetch is one standing line quoting the refusal, and the loop retries with backoff, not every cycle', async () => {
  const { coordinator, tip, cleanup } = await freshRepository('onboard-refused-fetch');
  try {
    const state = emptyDaemonState({ url: 'https://graphyard.example', repository } as any);
    const journal: string[] = [];
    let clock = Date.now(), refused = true, fetches = 0;
    const loop = reads(coordinator, { root: coordinator, repository }, async () => {
      fetches++;
      if (refused) throw samlRefusal();
      git(coordinator, 'fetch', '-q', 'origin', 'main');
      return git(coordinator, 'rev-parse', 'origin/main');
    });
    const step = () => batchGateStep(gateCycle(state, loop.value, () => clock, line => journal.push(line))).catch((error: unknown) => error);

    // The first refused fetch records the standing line; the fetch failure still surfaces to the step's own reader.
    const first = await step() as Error;
    assert.ok(first instanceof Error, 'the refusal propagates to the step that called the fetch');
    assert.equal(fetches, 1);
    const standing = state.actions[fetchRefusalKey]!;
    assert.equal(standing.kind, 'attention');
    assert.equal(standing.state, 'failed');
    assert.equal(standing.attempts, 1);
    assert.ok(standing.detail.includes('The \'InspectHOA\' organization has enabled or enforced SAML SSO'), standing.detail);
    assert.ok(standing.detail.includes('refuses the fetch of main for inspecthoa/lumina-investor'), standing.detail);
    assert.ok(standing.detail.includes('--push-auth gh'), standing.detail);
    assert.ok(!/[\r\n]/.test(standing.detail), 'the line rides a presence header, so it carries no newline');

    // Cycles inside the backoff window fetch nothing: the loop retries with backoff, not every cycle.
    clock += 20_000; await step(); clock += 20_000; await step();
    assert.equal(fetches, 1, 'no refetch inside the first backoff window');
    // Once the window passes the fetch is retried, fails again, and the backoff doubles.
    clock += fetchRetryBackoffMs(1) + 1;
    await step();
    assert.equal(fetches, 2);
    assert.equal(state.actions[fetchRefusalKey]!.attempts, 2);
    clock += 20_000; await step();
    assert.equal(fetches, 2, 'the doubled window holds the next cycles too');

    // The owner authorises the key: the next fetch succeeds, the standing line goes, and the gate
    // proceeds (the rollout fetch and the gate's own fetch both reach the remote).
    refused = false;
    clock += fetchRetryBackoffMs(2) + 1;
    const recovered = await step();
    assert.ok(!recovered || !(recovered instanceof Error), String(recovered));
    assert.equal(fetches, 4);
    assert.equal(state.actions[fetchRefusalKey], undefined, 'a successful fetch clears the standing line');
    await (recovered as { diagnostics: Promise<void> }).diagnostics;
    assert.equal(readGateRecord(gateRecordPath(coordinator))!.verified, tip);
  } finally { await cleanup(); }
});

// The standing line reaches the owner where they look: master status, and the Setup page through the
// loop's coordination header. One engine serves both.
let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinatorPrincipal: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, coordinatorPrincipal].map(entry => ({ ...entry, token: `${entry.id}-${'x'.repeat(32)}` }));

test('e2e:onboard-new-repository-faults — master status shows one attention line quoting the refusal while the backoff stands', async () => {
  store = await withDatabase('onboard-new-repository-faults');
  await store.init();
  engine = new Engine(store, 7200, repository);
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  try {
    const root = await temporaryDirectory('onboard-refused-status'), credentialsDir = await temporaryDirectory('onboard-refused-credentials');
    execFileSync('git', ['init', '-q', root]);
    const credentialFile = join(credentialsDir, 'coordinator.token');
    await writeFile(credentialFile, `coordinator-token-`.padEnd(40, 'x'), { mode: 0o600 });
    const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234, hostId: 'rexera-remote', masterAgentName: 'graphyard-master-lumina', workers: [] }) as MasterConfig;
    const state = emptyDaemonState(config);
    const entry = state.actions[fetchRefusalKey] = {
      kind: 'attention', work: null, principal: null, state: 'failed',
      detail: `The remote refuses the fetch of main for ${repository}: "ERROR: The 'InspectHOA' organization has enabled or enforced SAML SSO. Your SSH key is not authorized for this organization. Visit https://github.com/settings/ssh to authorize.". The owner must authorise the merge writer's access — for a SAML organization, authorise the SSH key for it on GitHub (Settings → SSH and GPG keys → Configure SSO → Authorize), or reinstall with --push-auth gh so the merge writer fetches over https with the gh login — and the loop retries with backoff until then.`,
      attempts: 2, epoch: null, cycle: 4, at: new Date().toISOString(),
    };
    await writeDaemonState(config, state);

    const report = await masterStatusReport(root, config, async () => ({ work: [], now: new Date().toISOString() }), async () => { throw new Error('no git in the fixture'); });
    const attention = report.attention.filter(line => line.subject === 'the repository');
    assert.equal(attention.length, 1, JSON.stringify(report.attention));
    assert.match(attention[0]!.text, /InspectHOA.*SAML SSO.*authorized for this organization/s);
    assert.match(attention[0]!.text, /--push-auth gh/);

    // The loop names the same line on its coordination read, and the Setup page shows it as one item.
    const read = await fetch(`${url}/api/work-snapshot`, { headers: {
      Authorization: `Bearer ${credentials[1]!.token}`,
      'x-graphyard-loop-interval': '20',
      [loopFetchRefusalHeader]: encodeLoopCheckoutTrust(entry.detail),
    } });
    assert.equal(read.status, 200);
    const status = await (await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${credentials[0]!.token}` } })).json() as any;
    assert.equal(status.setup.fetchRefusal, entry.detail);
    const items = setupChecklist(status).filter(item => item.id === 'fetch-refusal');
    assert.equal(items.length, 1);
    assert.equal(items[0]!.line, entry.detail);
    assert.equal(items[0]!.human, true, 'only the owner can authorise the key');

    // A loop that names none (the fetch recovered, or an older loop) shows no item.
    const clear = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${credentials[1]!.token}`, 'x-graphyard-loop-interval': '20', [loopFetchRefusalHeader]: 'off', 'Idempotency-Key': randomUUID() } });
    assert.equal(clear.status, 200);
    const after = await (await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${credentials[0]!.token}` } })).json() as any;
    assert.equal(after.setup.fetchRefusal, null);
    assert.ok(!setupChecklist(after).some(item => item.id === 'fetch-refusal'));
    await rm(root, { recursive: true, force: true });
    await rm(credentialsDir, { recursive: true, force: true });
  } finally { http.close(); await store.close(); }
});

/** A Herdr pane on a virtual clock: `screen` until the keys it accepts are sent, then the runtime at work. */
class StubPane {
  keys: string[][] = [];
  now = Date.now();
  constructor(private kind: string, private screen: string, private accepts: string[] | null, private foreground: () => number | null = () => 5200, private shellPid = 4100) {}
  wait = (ms: number) => { this.now += ms; };
  bounds() { return { clock: () => this.now, wait: this.wait }; }
  run = (_command: string, args: string[]): string => {
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'send-keys') { this.keys.push(args.slice(3)); return ''; }
    if (args[0] === 'pane' && args[1] === 'read') return this.accepts && this.keys.some(sent => sent.join(' ') === this.accepts!.join(' ')) ? `Claude Code\n∙ Working… (esc to interrupt)\n` : this.screen;
    if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: this.kind, agent_status: this.accepts && this.keys.some(sent => sent.join(' ') === this.accepts!.join(' ')) ? 'working' : 'idle', pane_id: args[2] } });
    if (args[0] === 'agent' && args[1] === 'rename') return json({ agent: { agent: this.kind, name: args[3] } });
    if (args[0] === 'pane' && args[1] === 'process-info') { const foreground = this.foreground(); return foreground === null ? json({}) : json({ process_info: { pane_id: args[3], shell_pid: this.shellPid, foreground_process_group_id: foreground, foreground_processes: [] } }); }
    return json({});
  };
}

/** Claude Code's folder-trust dialog, as the lumina install's master session met it. */
const trustDialog = [
  ' Do you trust the files in this folder?',
  '',
  ' /home/vish/code/da/lumina-investor',
  '',
  ' Claude Code may read, write, or execute files contained in this directory. This can pose security risks, so only use files from trusted sources.',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
].join('\n');

test('e2e:onboard-new-repository-faults — the launcher accepts the folder-trust prompt for the install\'s own checkout and the master session starts', async () => {
  const checkout = await temporaryDirectory('onboard-install-checkout');
  const worktree = await temporaryDirectory('onboard-other-folder');
  try {
    // The launch the loop's own master session gets: its directory is the coordinator checkout (master-session.ts).
    const pane = new StubPane('claude', trustDialog, ['1']);
    const command = 'GY=/c/.graphyard/launch/graphyard-master-lumina; claude --permission-mode bypassPermissions "$(cat "$GY.request")"';
    const started = await awaitRuntimeStart('w1V:pC1', 'claude', command, pane.run, { ...pane.bounds(), trustFolder: true });
    assert.equal(started.state, 'ready');
    assert.deepEqual(pane.keys, [['1']], 'the trust prompt was answered with its own option number');
    assert.equal(started.consent.length, 1);
    assert.equal(started.consent[0]!.rule, 'folder-trust-own-checkout');
    assert.equal(started.consent[0]!.kind, 'folder');

    // Through the launcher itself, with the master launch's own shape: the session starts and is named.
    const launched = new StubPane('claude', trustDialog, ['1']);
    const session = await startAgentSession('graphyard-master-lumina', 'claude', 'w1V:pC1', ['--permission-mode', 'bypassPermissions'], 'Run the loop', launched.run,
      { directory: checkout, coordinatorRoot: checkout, confinement: false, ...launched.bounds() });
    assert.equal(session.started.state, 'started');
    assert.deepEqual(launched.keys, [['1']]);
    assert.equal(session.consent[0]!.rule, 'folder-trust-own-checkout');

    // Any other folder — a worker's worktree, a review checkout — is still refused, never answered.
    const refused = new StubPane('claude', trustDialog, ['1']);
    await assert.rejects(startAgentSession('graphyard-worker-1', 'claude', 'w1V:pC9', ['--permission-mode', 'bypassPermissions'], 'Implement GY-1', refused.run,
      { directory: worktree, coordinatorRoot: checkout, confinement: false, ...refused.bounds() }),
      (error: unknown) => error instanceof SessionStartError && error.startCase === 'awaiting consent' && /stopped at a workspace-trust prompt/.test(error.message));
    assert.deepEqual(refused.keys, [], 'a prompt outside the install\'s own checkout is never answered');

    // The dialog the fault named, at the older spelling, is accepted for the install checkout too.
    const older = new StubPane('claude', trustDialog.replace('1. Yes, I trust this folder', '1. Yes, proceed'), ['1']);
    await assert.doesNotReject(awaitRuntimeStart('w1V:pC1', 'claude', command, older.run, { ...older.bounds(), trustFolder: true }));
  } finally { await rm(checkout, { recursive: true, force: true }); await rm(worktree, { recursive: true, force: true }); }
});

test('e2e:onboard-new-repository-faults — an execvp failure names the missing executable, so the fault says what to install', async () => {
  const command = 'GY=/c/.graphyard/launch/graphyard-master-lumina; bwrap ... claude --permission-mode bypassPermissions "$(cat "$GY.request")"';
  const screen = [`vish@rexera-remote lumina-investor ❯ ${command}`, 'bwrap: execvp claude: No such file or directory', 'vish@rexera-remote lumina-investor ❯'].join('\n');
  const pane = new StubPane('claude', screen, null, () => 4100);
  await assert.rejects(awaitRuntimeStart('w1V:pC1', 'claude', command, pane.run, { ...pane.bounds(), timeoutMs: 5_000 }),
    (error: unknown) => error instanceof SessionStartError && error.startCase === 'exited' && /its command names claude, which is not installed on this host/.test(error.message));
  assert.deepEqual(pane.keys, [], 'a missing executable is never answered');
});

test('e2e:onboard-new-repository-faults — a launch that fails the same way three times is retried with backoff and shown as one attention line', async () => {
  const root = await temporaryDirectory('onboard-launch-backoff'), credentialsDir = await temporaryDirectory('onboard-launch-credentials');
  try {
    execFileSync('git', ['init', '-q', root]);
    const credentialFile = join(credentialsDir, 'coordinator.token');
    await writeFile(credentialFile, `coordinator-token-`.padEnd(40, 'x'), { mode: 0o600 });
    const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234, hostId: 'rexera-remote', masterAgentName: 'graphyard-master-lumina', workers: [] }) as MasterConfig;
    const state: DaemonState = emptyDaemonState(config);
    const failure = 'the claude runtime exited back to the shell in pane w1V:p9 before it was ready: its command names claude, which is not installed on this host';
    let launches = 0;
    const effects: DaemonEffects = {
      snapshot: async () => ({ work: [] as Work[], now: new Date(clock).toISOString() }),
      agents: () => [],
      herdr: () => ({ agents: [], available: true }),
      credentials: async () => ({}),
      dispatch: async () => { throw new Error('no work to dispatch'); },
      closeSession: () => {},
      persist: async () => {},
      masterSession: { launch: async () => { launches++; throw new Error(failure); } },
    };
    let clock = Date.now();
    const cycle = () => runCycle(config, state, effects, () => clock);

    // Three same-way failures: the third names the backoff and the retry time.
    await cycle(); clock += 20_000;
    await cycle(); clock += 20_000;
    await cycle(); clock += 20_000;
    assert.equal(launches, 3);
    const standing = state.actions[masterLaunchKey]!;
    assert.equal(standing.state, 'failed');
    assert.equal(standing.attempts, masterLaunchBackoffAfter);
    assert.match(standing.detail, /failed the same way 3 times, so the loop backs off and retries it at .*: the claude runtime exited back to the shell/);
    const retryAt = Date.parse(standing.at) + masterLaunchRetryMs(3);
    assert.ok(Number.isFinite(retryAt));

    // Cycles inside the window open no pane; the one at its end retries, and the window doubles.
    await cycle(); clock += 20_000;
    await cycle(); clock += 20_000;
    assert.equal(launches, 3, 'no pane per cycle while the backoff stands');
    clock = retryAt;
    await cycle(); clock += 20_000;
    assert.equal(launches, 4, 'the launch is retried once the window passes');
    assert.equal(state.actions[masterLaunchKey]!.attempts, 4);
    await cycle(); clock += 20_000;
    await cycle();
    assert.equal(launches, 4, 'the doubled window holds the next cycles');
    assert.match(state.actions[masterLaunchKey]!.detail, /failed the same way 4 times/);

    // A different failure starts the count over.
    const before = state.actions[masterLaunchKey]!.attempts;
    clock = Date.parse(state.actions[masterLaunchKey]!.at) + masterLaunchRetryMs(before) + 1;
    effects.masterSession = { launch: async () => { launches++; throw new Error('Herdr\'s session inventory could not be read'); } };
    await cycle(); clock += 20_000;
    assert.equal(state.actions[masterLaunchKey]!.attempts, 1, 'a new error starts the count over');

    // One attention line in master status names the failure while the backoff stands.
    clock = Date.parse(state.actions[masterLaunchKey]!.at) + masterLaunchRetryMs(masterLaunchBackoffAfter) + 1;
    effects.masterSession = { launch: async () => { launches++; throw new Error(failure); } };
    await cycle(); clock += 20_000;
    await cycle(); clock += 20_000;
    await cycle(); clock += 20_000;
    await cycle(); clock += 20_000;
    await writeDaemonState(config, state);
    const report = await masterStatusReport(root, config, async () => ({ work: [], now: new Date(clock).toISOString() }), async () => { throw new Error('no git in the fixture'); });
    const attention = report.attention.filter(line => line.subject === 'the master session');
    assert.equal(attention.length, 1, JSON.stringify(report.attention));
    assert.match(attention[0]!.text, /failed the same way 3 times.*claude, which is not installed on this host/s);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialsDir, { recursive: true, force: true }); }
});
