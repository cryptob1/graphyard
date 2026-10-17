import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { UpDependencies, UpEvent, UpRequest } from '../src/up.js';
import { perInstallUnits, type InstallUnits } from '../src/install/units.js';
import type { LoopCodeReading } from '../src/repository-setup.js';

/**
 * GY-1859: setup never accepts a running loop on other code. Each test is named for the proof it
 * produces: unit:up-replaces-loop-on-other-code and unit:doctor-flags-loop-on-other-code.
 *
 * `graphyard up`'s master-loop step reads what the install's loop and executor units run against
 * the CLI running the command, rewrites a unit on other code to this CLI and restarts it, and is
 * green only once the restarted loop reports this CLI's commit. `doctor`'s readiness checklist
 * flags the same mismatch as one line naming both paths and the rerun. The host is simulated:
 * every unit file, cursor and git reading is injected, so the judgement itself is what is judged.
 */
// Loaded inside each test, so a tree without them fails as a test case, not at load.
const up = () => import('../src/up.js');
const repositorySetup = () => import('../src/repository-setup.js');
const readinessModule = () => import('../src/readiness.js');

const yieldTurn = () => new Promise<void>(accept => setImmediate(accept));
const SERVER = 'http://127.0.0.1:4310';
/** This CLI's checkout and commit — the code the units are rewritten onto. */
const CLI_ROOT = '/install/graphyard', COMMIT = 'a'.repeat(40);
/** The earlier checkout and the commit its loop still runs: what the step replaces. */
const OLD_CHECKOUT = '/install/graphyard-pilot', OLD_COMMIT = 'b'.repeat(40);
const REPOSITORY_ROOT = '/repo/acme-shop';
const MASTER_UNIT = 'graphyard-master-acme-shop.service';
const EXECUTOR_TEMPLATE = 'graphyard-executor-acme-shop@.service';
const MASTER_UNIT_PATH = `/units/${MASTER_UNIT}`, EXECUTOR_PATH = `/units/${EXECUTOR_TEMPLATE}`;
const TOKEN = 'm'.repeat(40);
const quote = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A reading as the host reports it: both units on the pilot checkout, its commit on the cursor. */
const reading = (over: Partial<LoopCodeReading> = {}): LoopCodeReading => ({
  loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: OLD_CHECKOUT },
  loopCommit: OLD_COMMIT,
  executor: { unit: EXECUTOR_TEMPLATE, path: EXECUTOR_PATH, checkout: OLD_CHECKOUT },
  cli: { root: CLI_ROOT, commit: COMMIT },
  repository: 'acme/shop',
  loopStale: `${MASTER_UNIT_PATH} starts the CLI in ${OLD_CHECKOUT}, not this checkout (${CLI_ROOT})`,
  executorStale: `${EXECUTOR_PATH} runs ${OLD_CHECKOUT}, not this checkout (${CLI_ROOT}) or the repository checkout (${REPOSITORY_ROOT})`,
  error: null,
  ...over,
});

const cleanReading = () => reading({
  loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: CLI_ROOT },
  executor: { unit: EXECUTOR_TEMPLATE, path: EXECUTOR_PATH, checkout: CLI_ROOT },
  loopCommit: COMMIT,
  loopStale: null,
  executorStale: null,
});

/** A status whose checklist is green but for the coordinator, which runs when the step restarts it. */
const baseStatus = (loop: boolean) => ({
  githubRepository: 'acme/shop',
  mergeWriter: { merger: 'control-plane' },
  fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-b'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, eligible: true }, { name: 'claude-b', enabled: true, loggedIn: true, eligible: true }] },
  setup: { protection: 'checks', loop },
});

interface UpWorld {
  calls: { args: string[]; stdin?: string }[];
  /** The supervisor state each `master init` answer reports, in order. */
  initAnswers: string[];
  /** Whether a loop is live on the simulated host: the checklist's master-loop item. */
  loopRunning: boolean;
  /** Each loopCode reading, in call order: the first is what the step found, later ones the wait's polls. */
  readings: (LoopCodeReading | null)[];
  aligned: number;
}

const world = (readings: (LoopCodeReading | null)[], over: Partial<UpWorld> = {}): UpWorld =>
  ({ calls: [], initAnswers: [], loopRunning: true, aligned: 0, readings, ...over });

function dependencies(root: string, events: UpEvent[], w: UpWorld): UpDependencies {
  let clock = 0;
  return {
    root, pollMs: 1, machineWaitMs: 200,
    emit: event => events.push(event),
    now: () => clock,
    sleep: async ms => { clock += ms; await yieldTurn(); },
    serverUrl: async () => SERVER,
    masterToken: async () => TOKEN,
    status: async () => baseStatus(w.loopRunning),
    publishOnboarding: async () => null,
    onboardingMerged: async () => true,
    signIn: async () => `${SERVER}/#sign-in=${'c'.repeat(43)}`,
    operatorToken: async () => 'o'.repeat(40),
    installDirectory: () => '/install/acme-shop',
    ensureDeployKey: async () => '/install/acme-shop/deploy',
    cli: async (args, options = {}) => {
      w.calls.push({ args, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) });
      if (args[0] === 'master' && args[1] === 'restart') w.loopRunning = true;
      if (args[0] === 'master' && args[1] === 'init') return { code: 0, stdout: w.initAnswers.length ? w.initAnswers.shift()! : '{"supervisor":{"state":"updated"}}' };
      return { code: 0, stdout: '{}' };
    },
    loopCode: async (): Promise<LoopCodeReading | null> => w.readings.length > 1 ? w.readings.shift()! : w.readings[0],
    alignExecutors: async () => { w.aligned++; w.calls.push({ args: ['align-executors'] }); return { wrote: 'updated', reason: null, restarted: ['graphyard-executor-acme-shop@1.service'] }; },
  };
}

const request = (): UpRequest => ({ repository: 'acme/shop', provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null, merger: 'control-plane' });

/** A root whose up state records every step but the master loop done, so a run reaches that step alone. */
async function resumedRoot(label: string) {
  const root = await temporaryDirectory(label);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'up.json'), JSON.stringify({
    version: 1, repository: 'acme/shop', provider: 'compose', merger: 'control-plane', noHerdr: false, goal: null,
    completed: ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'merger-setting', 'master-autonomy', 'onboarding', 'accounts', 'harness'],
  }));
  return root;
}

/** A root whose up state records every step done — the install an earlier run finished, whose loop this item is about. */
async function recordedRoot(label: string) {
  const root = await temporaryDirectory(label);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'up.json'), JSON.stringify({
    version: 1, repository: 'acme/shop', provider: 'compose', merger: 'control-plane', noHerdr: false, goal: null,
    completed: ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'merger-setting', 'master-autonomy', 'onboarding', 'accounts', 'harness', 'master-loop', 'goal'],
  }));
  return root;
}

const named = (w: UpWorld, args: string[]) => w.calls.filter(call => call.args.join(' ') === args.join(' '));

test('unit:up-replaces-loop-on-other-code — the master-loop step rewrites a loop unit on other code to this CLI, restarts it onto this commit, reports the replacement, and leaves a loop already on this commit running', async () => {
  const { runUp } = await up();

  // A loop unit on the pilot checkout with its old commit on the cursor, while the checklist reads
  // green: the rewrite runs (master init --replace-supervisor, with the master credential), the
  // executor template is aligned beside it, the unit restart that rewrite performed is not asked
  // for twice, and the step is green only once the loop reports this CLI's commit.
  const replacedRoot = await resumedRoot('graphyard-up-loop-replaced');
  const replaced = world([reading(), reading({ loopCommit: COMMIT, loopStale: null, executorStale: null })]);
  const replacedEvents: UpEvent[] = [];
  const replacedRun = await runUp(request(), dependencies(replacedRoot, replacedEvents, replaced));
  assert.equal(replacedRun.exitCode, 0, replacedRun.next);
  assert.deepEqual(named(replaced, ['master', 'init', '--token-stdin', '--replace-supervisor']), [{ args: ['master', 'init', '--token-stdin', '--replace-supervisor'], stdin: TOKEN }], 'the unit is rewritten through master init --replace-supervisor, with the recorded master credential');
  assert.deepEqual(named(replaced, ['master', 'restart']), [], 'the rewrite already restarted the unit, so the step restarts it no second time');
  assert.equal(replaced.aligned, 1, 'the executor template on the same other code is aligned in the same step');
  const initAt = replaced.calls.findIndex(call => call.args[1] === 'init');
  const alignedAt = replaced.calls.findIndex(call => call.args[0] === 'align-executors');
  assert.ok(initAt >= 0 && alignedAt > initAt, 'the executors are aligned after the loop unit is rewritten');
  const replacedNote = replacedEvents.find(event => event.kind === 'note' && event.text.includes('master-loop: replaced')) as { text: string } | undefined;
  assert.match(replacedNote?.text ?? '', new RegExp(`starts the CLI in ${quote(OLD_CHECKOUT)}`), 'the step reports what it replaced');
  assert.match(replacedNote?.text ?? '', new RegExp(`the loop now runs ${quote(CLI_ROOT)} at ${COMMIT.slice(0, 12)}`), 'and the code the restarted loop now reports');
  const done = replacedEvents.find(event => event.kind === 'step' && event.step === 'master-loop' && event.state === 'done') as { detail?: string } | undefined;
  assert.match(done?.detail ?? '', /^replaced: /, 'the step\'s own outcome names the replacement');

  // A loop whose unit already names this CLI but whose cursor records another commit: the rewrite
  // changes nothing (the unit was already right), so the step restarts the loop itself, and waits
  // for the commit the restarted loop reports.
  const staleCommitRoot = await resumedRoot('graphyard-up-loop-commit');
  const staleCommit = world(
    [reading({ loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: CLI_ROOT }, executor: { unit: EXECUTOR_TEMPLATE, path: EXECUTOR_PATH, checkout: CLI_ROOT }, executorStale: null, loopStale: `${MASTER_UNIT_PATH} runs ${OLD_COMMIT.slice(0, 12)}, not this checkout's ${COMMIT.slice(0, 12)}` }),
      cleanReading()],
    { initAnswers: ['{"supervisor":{"state":"unchanged"}}'] });
  const staleRun = await runUp(request(), dependencies(staleCommitRoot, [], staleCommit));
  assert.equal(staleRun.exitCode, 0, staleRun.next);
  assert.equal(named(staleCommit, ['master', 'init', '--token-stdin', '--replace-supervisor']).length, 1, 'the check still runs, so a stale commit is never read as green');
  assert.equal(named(staleCommit, ['master', 'restart']).length, 1, 'a unit the rewrite left unchanged gets its restart from the step');
  assert.equal(staleCommit.aligned, 0, 'executor units on this checkout are left alone');

  // A loop already on this CLI's commit: nothing is rewritten and nothing is restarted.
  const currentRoot = await resumedRoot('graphyard-up-loop-current');
  const current = world([cleanReading()]);
  const currentRun = await runUp(request(), dependencies(currentRoot, [], current));
  assert.equal(currentRun.exitCode, 0, currentRun.next);
  assert.deepEqual(current.calls, [], 'a loop on this commit is neither rewritten nor restarted');

  // The checklist not yet green still starts the loop, as before this check existed.
  const freshLoopRoot = await resumedRoot('graphyard-up-loop-fresh');
  const fresh = world([cleanReading()], { loopRunning: false });
  const freshRun = await runUp(request(), dependencies(freshLoopRoot, [], fresh));
  assert.equal(freshRun.exitCode, 0, freshRun.next);
  assert.equal(named(fresh, ['master', 'restart']).length, 1, 'a stopped loop is started');
  assert.equal(named(fresh, ['master', 'init', '--token-stdin', '--replace-supervisor']).length, 0, 'units on this code are not rewritten');

  // No master credential is recorded: the rewrite is refused as a machine prerequisite naming the
  // command that fixes it, and nothing runs.
  const noTokenRoot = await resumedRoot('graphyard-up-loop-notoken');
  const noToken = world([reading()]);
  const noTokenRun = await runUp(request(), { ...dependencies(noTokenRoot, [], noToken), masterToken: async () => null });
  assert.equal(noTokenRun.exitCode, 2, noTokenRun.next);
  assert.match(noTokenRun.next, /master init --token-stdin --replace-supervisor/);
  assert.deepEqual(noToken.calls, [], 'nothing is rewritten without the credential to do it');

  // The loop never reports this CLI's commit: the step fails naming both, instead of going green.
  const neverRoot = await resumedRoot('graphyard-up-loop-never');
  const never = world([reading()]);
  const neverRun = await runUp(request(), dependencies(neverRoot, [], never));
  assert.equal(neverRun.exitCode, 1, neverRun.next);
  assert.match(neverRun.next, new RegExp(`still reports ${OLD_COMMIT.slice(0, 12)} instead of this checkout's ${COMMIT.slice(0, 12)}`));
});

test('unit:up-reopens-a-recorded-master-loop-step — a rerun whose up.json already records master-loop re-opens it when the units read as other code, and leaves it recorded when they read as this checkout or cannot be read', async () => {
  const { runUp } = await up();

  // The install this item exists for: an earlier run recorded master-loop done while its loop kept
  // serving the pilot checkout. The rerun re-opens the recorded step, replaces the unit, and is
  // green once the restarted loop reports this CLI's commit — never a skip past the same false green.
  const recordedStaleRoot = await recordedRoot('graphyard-up-loop-recorded-stale');
  const recordedStale = world([reading(), reading(), reading({ loopCommit: COMMIT, loopStale: null, executorStale: null })]);
  const recordedEvents: UpEvent[] = [];
  const recordedRun = await runUp(request(), dependencies(recordedStaleRoot, recordedEvents, recordedStale));
  assert.equal(recordedRun.exitCode, 0, recordedRun.next);
  assert.equal(named(recordedStale, ['master', 'init', '--token-stdin', '--replace-supervisor']).length, 1, 'the recorded step is re-opened, so the loop on other code is rewritten');
  const stepState = (event: UpEvent) => (event.kind === 'step' && event.step === 'master-loop' ? (event as { state?: string }).state : null);
  assert.ok(!recordedEvents.some(event => stepState(event) === 'skipped'), 'the step is never printed as done by an earlier run');
  assert.match((recordedEvents.find(event => stepState(event) === 'done') as { detail?: string } | undefined)?.detail ?? '', /^replaced: /, 'the re-opened step ends with the replacement it made');
  const recorded = JSON.parse(await readFile(join(recordedStaleRoot, '.graphyard', 'up.json'), 'utf8'));
  assert.ok(recorded.completed.includes('master-loop'), 'the re-opened step is recorded done again once it is green');

  // The same recorded run with the units on this checkout: the step stands recorded and nothing runs.
  const settledRoot = await recordedRoot('graphyard-up-loop-recorded-settled');
  const settled = world([cleanReading()]);
  const settledRun = await runUp(request(), dependencies(settledRoot, [], settled));
  assert.equal(settledRun.exitCode, 0, settledRun.next);
  assert.deepEqual(settled.calls, [], 'a recorded master-loop whose loop runs this checkout is left recorded and skipped');

  // A reading that cannot be taken judges nothing, so the recorded step stands.
  const unreadableRoot = await recordedRoot('graphyard-up-loop-recorded-unreadable');
  const unreadable = world([reading({ loop: null, executor: null, loopStale: null, executorStale: null, error: 'units.json is corrupt' })]);
  const unreadableRun = await runUp(request(), dependencies(unreadableRoot, [], unreadable));
  assert.equal(unreadableRun.exitCode, 0, unreadableRun.next);
  assert.deepEqual(unreadable.calls, [], 'a failed reading re-opens nothing');
});

test('unit:up-waits-for-the-loop-own-commit — the post-restart wait goes green only on a succeeded reading whose loop reported one of this install\'s commits; a failed or erroring reading, or a cursor with no commit, polls to a failure naming which', async () => {
  const { runUp } = await up();
  const deadline = (label: string, waitReading: LoopCodeReading | null) => resumedRoot(label).then(async root => {
    const w = world([reading(), waitReading]);
    const run = await runUp(request(), { ...dependencies(root, [], w), machineWaitMs: 20 });
    return { run, w };
  });

  // The restarted loop's reading cannot be taken at all: the wait keeps polling, then fails saying so.
  const nulled = await deadline('graphyard-up-loop-wait-null', null);
  assert.equal(nulled.run.exitCode, 1, nulled.run.next);
  assert.match(nulled.run.next, /could not be read again/);

  // The reading succeeds but the restarted loop's cursor records no commit yet: not proof, so the
  // wait polls to a failure naming the missing report, never a green on silence.
  const silent = await deadline('graphyard-up-loop-wait-silent', reading({ loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: CLI_ROOT }, loopCommit: null, loopStale: null }));
  assert.equal(silent.run.exitCode, 1, silent.run.next);
  assert.match(silent.run.next, /its cursor records no commit/);

  // The reading keeps failing: the failure names why, rather than reading the step as green.
  const failing = await deadline('graphyard-up-loop-wait-error', reading({ error: 'units.json is corrupt', loopStale: null }));
  assert.equal(failing.run.exitCode, 1, failing.run.next);
  assert.match(failing.run.next, /read failed again: units\.json is corrupt/);
});

test('unit:doctor-flags-loop-on-other-code — the reading judges the units against this CLI, tolerating the pin and the held snapshot; doctor reports a loop or executor on other code as one line naming both paths and the rerun; the executor alignment re-binds and restarts', async () => {
  const { readLoopCode, alignExecutorUnits, readSetupStatus } = await repositorySetup();
  const { readinessChecklist } = await readinessModule();
  const units: InstallUnits = perInstallUnits('acme/shop');
  const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  // A simulated host: the managed checkout, its master configuration, a unit directory whose loop
  // unit and executor template still name the pilot checkout, and the pilot commit on the cursor.
  const base = await temporaryDirectory('graphyard-doctor-loop-code');
  const configHome = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.GRAPHYARD_CONFIG_HOME = join(base, 'config');
  try {
    const root = join(base, 'repo'), unitDirectory = join(base, 'units'), home = join(base, 'home'), cliCheckout = join(base, 'cli'), pilot = join(base, 'pilot');
    for (const directory of [join(root, '.graphyard'), unitDirectory, home, join(cliCheckout, 'bin'), join(pilot, 'bin'), join(base, 'config', 'acme-shop', 'coordinator')]) await mkdir(directory, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'user.name', 'Test');
    await writeFile(join(root, 'file.txt'), 'x\n');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'graphyard-executor.mjs'), '// the repository\'s own executor entry\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'one');
    await writeFile(join(root, '.graphyard', 'master.json'), JSON.stringify({ repository: 'acme/shop', credentialFile: join(home, 'master.token') }));
    const run = (_command: string, args: string[]) => args[2] === 'rev-parse' ? `${COMMIT}\n` : '';
    await writeFile(join(unitDirectory, units.master), `[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/node ${join(pilot, 'bin', 'graphyard.mjs')} master run\n`);
    await writeFile(join(unitDirectory, units.executorTemplate), `[Unit]\nDescription=Graphyard executor\n\n[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/node ${join(pilot, 'scripts', 'graphyard-executor.mjs')} --slot %i\n`);
    await writeFile(join(home, 'master.daemon.json'), JSON.stringify({ release: { commit: OLD_COMMIT } }));

    const foreign = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home });
    assert.equal(foreign.loop?.checkout, pilot, 'the loop unit reads as running the pilot checkout');
    assert.equal(foreign.loopCommit, OLD_COMMIT, 'the cursor records the commit the running loop loaded');
    assert.match(foreign.loopStale ?? '', new RegExp(`${quote(MASTER_UNIT)} starts the CLI in ${quote(pilot)}, not this checkout`), 'the loop on another checkout is named with both paths');
    assert.match(foreign.executorStale ?? '', new RegExp(`${quote(EXECUTOR_TEMPLATE)} runs ${quote(pilot)}, not this checkout`), 'and the executor on it');

    // Another commit on this checkout's own unit is other code too; the pin and the held snapshot a
    // restart pinned are this install's own code, and never read as stale.
    await writeFile(join(unitDirectory, units.master), `[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/node ${join(cliCheckout, 'bin', 'graphyard.mjs')} master run\n`);
    const staleCommit = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home });
    assert.match(staleCommit.loopStale ?? '', new RegExp(`runs ${OLD_COMMIT.slice(0, 12)}, not this checkout's ${COMMIT.slice(0, 12)}`), 'an old commit on the cursor is other code');
    await writeFile(join(base, 'config', 'acme-shop', 'coordinator', 'state.json'), JSON.stringify({ sha: OLD_COMMIT, pinnedAt: 'an earlier promotion', previous: null }));
    const pointer = join(root, '.graphyard', 'held-cli.json');
    await writeFile(pointer, JSON.stringify({ commit: OLD_COMMIT, root: pilot }));
    for (const [cursorCommit, label] of [[COMMIT, 'this checkout'], [OLD_COMMIT, 'the pin']] as const) {
      const tolerated = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home, cursor: JSON.stringify({ release: { commit: cursorCommit } }) });
      assert.equal(tolerated.loopStale, null, `a loop reporting ${label}'s commit runs this install's code`);
    }
    await writeFile(pointer, JSON.stringify({ commit: 'f'.repeat(40), root: pilot }));
    const heldOnly = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home, cursor: JSON.stringify({ release: { commit: OLD_COMMIT } }) });
    assert.equal(heldOnly.loopStale, null, 'the held snapshot a restart pinned is this install\'s code too');

    // A slot's own registration is judged the same way: a running slot whose recorded release is
    // none of this install's commits is other code, a stopped slot runs nothing, and the pin's
    // commit is this install's for a slot too. The registrations are read beside the master
    // credential, exactly where the fleet records them (executor-fleet's executor registration).
    // The slot runs a commit that is neither this checkout's nor the pin's, so only its own
    // restart can bring it onto this install's code.
    const slotCommit = 'c'.repeat(40);
    const slot1Unit = units.executorTemplate.replace('@.service', '@1.service');
    const executorsDirectory = join(home, 'master.executors');
    await mkdir(executorsDirectory, { recursive: true });
    const fleetRecord = (over: Record<string, unknown>) => ({
      version: 1, name: 'slot-1', host: 'test-host', pid: 4242, principal: 'p', kinds: ['review'],
      intervalSeconds: 60, root: cliCheckout, release: { commit: slotCommit, dirty: false },
      supervisor: { unit: slot1Unit, restart: `systemctl --user restart ${slot1Unit}` },
      state: 'running', standDown: null, startedAt: 't0', updatedAt: 't1', stoppedAt: null,
      claims: 0, lastClaim: null, inFlight: null, claiming: null, ...over,
    });
    await writeFile(join(executorsDirectory, 'slot-1.json'), JSON.stringify(fleetRecord({})));
    const staleSlot = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home, cursor: JSON.stringify({ release: { commit: COMMIT } }) });
    assert.match(staleSlot.executorStale ?? '', new RegExp(`${quote(slot1Unit)} runs ${slotCommit.slice(0, 12)}, not this checkout's ${COMMIT.slice(0, 12)}`), 'a slot still running another commit is other code, though its unit binds this checkout');
    await writeFile(join(executorsDirectory, 'slot-1.json'), JSON.stringify(fleetRecord({ state: 'stopped', stoppedAt: 't2' })));
    const stoppedSlot = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home, cursor: JSON.stringify({ release: { commit: COMMIT } }) });
    assert.equal(stoppedSlot.executorStale, null, 'a stopped slot runs nothing and is never flagged');
    await writeFile(join(executorsDirectory, 'slot-1.json'), JSON.stringify(fleetRecord({ release: { commit: OLD_COMMIT, dirty: false } })));
    const pinnedSlot = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home, cursor: JSON.stringify({ release: { commit: COMMIT } }) });
    assert.equal(pinnedSlot.executorStale, null, 'a slot on the pin\'s commit runs this install\'s code');

    // The doctor line: one FAIL naming both paths and the rerun, ready once both run this checkout.
    const facts = (code: LoopCodeReading | null) => readinessChecklist('through-merge', {
      repository: 'acme/shop',
      server: { url: SERVER, reachable: true, role: 'coordinator' },
      setup: { proposal: null, appliedAt: 'an earlier run', githubApp: null, drift: [], unreadable: [], loopCode: code },
      proposal: null,
    });
    const loopCode = facts(foreign).items.find(item => item.id === 'loop-code')!;
    assert.equal(loopCode.status, 'missing');
    assert.match(loopCode.detail, new RegExp(`${quote(MASTER_UNIT)} starts the CLI in ${quote(pilot)}`), 'the line names the unit still on the old code');
    assert.match(loopCode.detail, new RegExp(`${quote(EXECUTOR_TEMPLATE)} runs ${quote(pilot)}`), 'and the executor on it, in the same line');
    assert.match(loopCode.recovery ?? '', /rerun graphyard up --repo acme\/shop --agent/, 'the rerun that fixes it is named');
    assert.equal(facts(cleanReading()).items.find(item => item.id === 'loop-code')!.status, 'ready');
    const unknown = facts(null).items.find(item => item.id === 'loop-code')!;
    assert.equal(unknown.status, 'unknown', 'an unreadable host is never ready');
    assert.match(unknown.recovery ?? '', /rerun graphyard up/);
    const unreadable = facts(reading({ error: 'units.json is corrupt' })).items.find(item => item.id === 'loop-code')!;
    assert.equal(unreadable.status, 'unknown', 'a reading that failed is unknown, never ready');
    assert.match(unreadable.detail, /units\.json is corrupt/);

    // `doctor`'s setup status carries the reading, so the checklist above is what doctor reports.
    const status = await readSetupStatus(root);
    assert.ok(status.loopCode && typeof status.loopCode.cli.root === 'string', 'doctor reads what the units run');
    assert.equal(status.loopCode!.loop, null, 'under the test runner the operator\'s real units are never read');

    // The executor alignment: a template on the pilot checkout is re-bound to this checkout and its
    // slots restarted; an aligned template is left alone; a missing template is reported, never created.
    const restarts: string[][] = [];
    const systemctl = (args: string[]) => {
      if (args[0] === 'list-units' || args[0] === 'list-unit-files') return `123 graphyard ${units.executorTemplate.replace('@.service', '@1.service')} running\n`;
      if (args[0] === 'restart') restarts.push(args);
      return '';
    };
    const aligned = await alignExecutorUnits(root, { run: systemctl, unitDirectory, node: '/usr/bin/node', heldScript: null });
    assert.equal(aligned.wrote, 'updated');
    assert.deepEqual(aligned.restarted, [units.executorTemplate.replace('@.service', '@1.service')], 'the restarted slots are named');
    const bound = await readFile(join(unitDirectory, units.executorTemplate), 'utf8');
    assert.match(bound, new RegExp(`ExecStart=/usr/bin/node ${quote(join(root, 'scripts', 'graphyard-executor.mjs'))} --slot %i`), 'the template is re-bound to this checkout\'s entry');
    assert.deepEqual(restarts, [['restart', units.executorTemplate.replace('@.service', '@1.service')]]);
    assert.equal((await alignExecutorUnits(root, { run: systemctl, unitDirectory, node: '/usr/bin/node', heldScript: null })).wrote, 'unchanged', 'an aligned template is not written or restarted twice');
    assert.equal(restarts.length, 1, 'and no second restart runs');
    // GY-1859: the forced alignment restarts the slots even when the template already binds this
    // checkout — a slot booted before the checkout moved keeps the commit it loaded until restarted.
    const forced = await alignExecutorUnits(root, { run: systemctl, unitDirectory, node: '/usr/bin/node', heldScript: null, restart: true });
    assert.equal(forced.wrote, 'unchanged', 'the forced alignment still writes nothing');
    assert.deepEqual(forced.restarted, [slot1Unit], 'but its slots are restarted');
    assert.equal(restarts.length, 2, 'exactly one more restart ran');
    const absent = await alignExecutorUnits(root, { run: systemctl, unitDirectory: join(base, 'none'), heldScript: null });
    assert.equal(absent.wrote, 'none');
    assert.match(absent.reason ?? '', /graphyard-executor\.mjs --install installs it/, 'installing executors stays the operator\'s command');
  } finally {
    if (configHome === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = configHome;
  }
});

test('unit:doctor-loop-code-setup-line — setupFromZero carries the loop-code line: one FAIL naming both paths and the rerun, a PASS once the units run this checkout, a FAIL for an unreadable record, and no line while no unit of this install stands', async () => {
  const { setupFromZeroChecks, setupLine } = await import('../src/setup-from-zero.js');
  const root = await temporaryDirectory('graphyard-doctor-setup-line');
  const checks = (code: LoopCodeReading | null) => setupFromZeroChecks({ root, status: null, environments: join(root, 'none'), loopCode: code });

  // A loop and an executor on other code: one FAIL line naming both paths, this checkout, and the
  // rerun whose master-loop step replaces them, printed in doctor's `PASS id` / `FAIL id` form.
  const failing = (await checks(reading())).find(check => check.id === 'loop-code');
  assert.equal(failing?.status, 'fail');
  assert.match(failing.detail, new RegExp(`${quote(MASTER_UNIT_PATH)} starts the CLI in ${quote(OLD_CHECKOUT)}`), 'the line names the loop unit and its old checkout');
  assert.match(failing.detail, new RegExp(`${quote(EXECUTOR_PATH)} runs ${quote(OLD_CHECKOUT)}`), 'and the executor on it, in the same line');
  assert.match(failing.detail, /rerun graphyard up --repo acme\/shop --agent from this checkout/, 'the rerun that fixes it is named');
  assert.equal(failing.step, 'rerun graphyard up --agent from this checkout (docs/setup-from-zero.md step 10, start the master)');
  assert.match(setupLine(failing), /^FAIL loop-code: .* \(fix: .+\)$/);

  assert.equal((await checks(cleanReading())).find(check => check.id === 'loop-code')?.status, 'pass', 'units on this checkout pass');
  const unreadable = (await checks(reading({ error: 'units.json is corrupt', loopStale: null, executorStale: null }))).find(check => check.id === 'loop-code');
  assert.equal(unreadable?.status, 'fail', 'an install whose units record cannot be read fails too');
  assert.match(unreadable?.detail ?? '', /units\.json is corrupt/);
  const absent = (await checks(reading({ loop: null, executor: null, loopStale: null, executorStale: null }))).find(check => check.id === 'loop-code');
  assert.equal(absent, undefined, 'no unit of this install stands, so no line is judged');
  const untaken = (await checks(null)).find(check => check.id === 'loop-code');
  assert.equal(untaken?.status, 'fail', 'a reading that could not be taken is never a pass');
  assert.match(untaken?.detail ?? '', /could not be read/);
});
