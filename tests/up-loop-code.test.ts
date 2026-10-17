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
  loopStale: `${MASTER_UNIT_PATH} starts the CLI in ${OLD_CHECKOUT} at ${OLD_COMMIT.slice(0, 12)}, not this checkout (${CLI_ROOT}) at ${COMMIT.slice(0, 12)}`,
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
  assert.match(replacedNote?.text ?? '', new RegExp(`starts the CLI in ${quote(OLD_CHECKOUT)} at ${OLD_COMMIT.slice(0, 12)}`), 'the step reports what it replaced: the old checkout and the commit its cursor reported');
  assert.match(replacedNote?.text ?? '', new RegExp(`the loop now runs ${quote(CLI_ROOT)} at ${COMMIT.slice(0, 12)}`), 'and the code the restarted loop now reports');
  const done = replacedEvents.find(event => event.kind === 'step' && event.step === 'master-loop' && event.state === 'done') as { detail?: string } | undefined;
  assert.match(done?.detail ?? '', /^replaced: /, 'the step\'s own outcome names the replacement');

  // The replacement as the judgement itself words it: a unit on another checkout whose cursor
  // reports that checkout's commit is reported with both paths and both commits, so the output says
  // which code was replaced, not only where it lived.
  const { judgeLoopCode } = await repositorySetup();
  const judged = judgeLoopCode({
    cli: { root: CLI_ROOT, commit: COMMIT }, primary: REPOSITORY_ROOT, primaryCommit: null, repository: 'acme/shop',
    loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: OLD_CHECKOUT }, executor: null,
    cursor: JSON.stringify({ release: { commit: OLD_COMMIT, dirty: false } }), fleet: [], canonical: path => path,
  });
  assert.equal(judged.loopReplace, 'unit', 'a unit on another checkout is rewritten');
  const judgedRoot = await resumedRoot('graphyard-up-loop-judged');
  const judgedWorld = world([reading({ loopStale: judged.loopStale, loopReplace: judged.loopReplace, executorStale: null }), cleanReading()]);
  const judgedEvents: UpEvent[] = [];
  const judgedRun = await runUp(request(), dependencies(judgedRoot, judgedEvents, judgedWorld));
  assert.equal(judgedRun.exitCode, 0, judgedRun.next);
  const judgedNote = judgedEvents.find(event => event.kind === 'note' && event.text.includes('master-loop: replaced')) as { text: string } | undefined;
  for (const part of [OLD_CHECKOUT, OLD_COMMIT.slice(0, 12), CLI_ROOT, COMMIT.slice(0, 12)]) assert.ok(judgedNote?.text.includes(part), `the replacement note names ${part}: ${judgedNote?.text}`);

  // A loop whose unit already names this CLI but whose cursor records another commit: the unit is
  // right, so it is not rewritten; the step restarts the loop itself and waits for the commit the
  // restarted loop reports.
  const staleCommitRoot = await resumedRoot('graphyard-up-loop-commit');
  const staleCommit = world(
    [reading({ loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: CLI_ROOT }, executor: { unit: EXECUTOR_TEMPLATE, path: EXECUTOR_PATH, checkout: CLI_ROOT }, executorStale: null, loopReplace: 'restart', loopStale: `${MASTER_UNIT_PATH} runs ${OLD_COMMIT.slice(0, 12)}, not this checkout's ${COMMIT.slice(0, 12)}` }),
      cleanReading()]);
  const staleRun = await runUp(request(), dependencies(staleCommitRoot, [], staleCommit));
  assert.equal(staleRun.exitCode, 0, staleRun.next);
  assert.equal(named(staleCommit, ['master', 'init', '--token-stdin', '--replace-supervisor']).length, 0, 'a unit already on this checkout is not rewritten');
  assert.equal(named(staleCommit, ['master', 'restart']).length, 1, 'the loop on another commit is restarted onto this one');
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

  // A pinned install whose promoted release trails this CLI, through the real renderer: the unit
  // starts the known-good coordinator (loopUnitText renders it while the pin stands) and the held
  // snapshot's pointer stands beside it. Without lifting them a rewrite renders the pin again, the
  // restarted loop reports its older commit and the step fails; the step lifts both first, the
  // rewrite renders this CLI's launcher, and green comes only from the loop reporting this commit.
  await pinnedReplacement();
});

/** GY-1859: AC-1 on a pinned install, through supervisor's loopUnitText and repository-setup's reading and liftLoopPins. */
async function pinnedReplacement() {
  const { runUp } = await up();
  const { readLoopCode, liftLoopPins } = await repositorySetup();
  const { loopUnitText } = await import('../src/supervisor.js');
  const { knownGoodCli, knownGoodState } = await import('../src/master/known-good.js');
  const { heldCliSnapshotAt, heldLauncherOf } = await import('../src/daemon/held-cli.js');
  const units: InstallUnits = perInstallUnits('acme/shop');
  const attempt = async (lift: boolean) => {
    const base = await temporaryDirectory(`graphyard-up-loop-pinned-${lift ? 'lifted' : 'kept'}`);
    const root = await resumedRoot(`graphyard-up-loop-pinned-root-${lift}`), installDir = join(base, 'install'), unitDirectory = join(base, 'units'), home = join(base, 'home');
    const cliPath = join(base, 'cli', 'bin', 'graphyard.mjs'), snapshot = heldCliSnapshotAt(root, OLD_COMMIT);
    for (const directory of [join(installDir, 'coordinator'), unitDirectory, home, join(snapshot, 'src')]) await mkdir(directory, { recursive: true });
    await writeFile(join(installDir, 'coordinator', 'state.json'), JSON.stringify({ sha: OLD_COMMIT, pinnedAt: 'an earlier promotion', previous: null }));
    await writeFile(join(snapshot, 'src', 'cli.ts'), '// the held snapshot\n');
    await writeFile(join(root, '.graphyard', 'held-cli.json'), JSON.stringify({ commit: OLD_COMMIT, root: snapshot }));
    // What `master init --replace-supervisor` writes: the real renderer, reading the pins as installLoopSupervisor does.
    const render = () => loopUnitText({ root, cliPath, repository: 'acme/shop', intervalSeconds: 30, installDir, heldLauncher: heldLauncherOf(root) });
    const unitFile = join(unitDirectory, units.master);
    await writeFile(unitFile, loopUnitText({ root, cliPath, repository: 'acme/shop', intervalSeconds: 30, installDir, heldLauncher: null }));
    assert.match(await readFile(unitFile, 'utf8'), new RegExp(`ExecStart=\\S+ ${quote(knownGoodCli(installDir))} master run`), 'the pinned unit starts the known-good coordinator');
    // The loop reports the commit of whichever launcher its unit starts: this CLI's, or the pin's.
    const loaded = async () => (await readFile(unitFile, 'utf8')).includes(`${cliPath} master run`) ? COMMIT : OLD_COMMIT;
    const run = (_command: string, args: string[]) => args[2] === 'rev-parse' ? `${COMMIT}\n` : '';
    const read = async () => readLoopCode(root, { cliPath, run, units, unitDirectory, home, master: { repository: 'acme/shop', credentialFile: join(home, 'master.token') }, executors: null, cursor: JSON.stringify({ release: { commit: await loaded(), dirty: false } }) });
    const before = await read();
    assert.equal(before.loopReplace, 'unit', 'a unit starting the pin is another checkout, rewritten');
    const w = world([]), events: UpEvent[] = [];
    const deps = dependencies(root, events, w);
    const outcome = await runUp(request(), { ...deps,
      loopCode: read,
      liftLoopPins: lift ? async () => liftLoopPins(root, { installDir }) : undefined,
      cli: async (args, options = {}) => {
        if (args[0] === 'master' && args[1] === 'init') { w.calls.push({ args }); await writeFile(unitFile, render()); return { code: 0, stdout: '{"supervisor":{"state":"updated"}}' }; }
        return deps.cli(args, options);
      } });
    return { outcome, events, unit: await readFile(unitFile, 'utf8'), installDir, root, cliPath };
  };
  const kept = await attempt(false);
  assert.equal(kept.outcome.exitCode, 1, 'with the pin left standing the rewrite renders the pin again');
  assert.match(kept.outcome.next, new RegExp(`still reports ${OLD_COMMIT.slice(0, 12)}`), 'and the exact-commit wait refuses the pinned commit');
  const lifted = await attempt(true);
  assert.equal(lifted.outcome.exitCode, 0, lifted.outcome.next);
  assert.match(lifted.unit, new RegExp(`ExecStart=\\S+ ${quote(lifted.cliPath)} master run`), 'the rewritten unit starts this CLI');
  assert.doesNotMatch(lifted.unit, /coordinator\/current|held-cli/, 'neither the pin nor the held snapshot is started');
  assert.equal(knownGoodState(lifted.installDir), null, 'the pin is lifted');
  assert.ok(JSON.parse(await readFile(join(lifted.installDir, 'coordinator', 'lifted.json'), 'utf8')).sha === OLD_COMMIT, 'and its record is kept beside it');
  assert.equal(heldLauncherOf(lifted.root), null, 'the held pointer is lifted');
  const note = lifted.events.find(event => event.kind === 'note' && event.text.startsWith('master-loop: lifted')) as { text: string } | undefined;
  assert.match(note?.text ?? '', new RegExp(`known-good pin at ${OLD_COMMIT.slice(0, 12)}.* and the held snapshot at ${OLD_COMMIT.slice(0, 12)}`), 'the step names what it lifted');
  assert.ok(lifted.events.some(event => event.kind === 'note' && event.text.includes(`at ${COMMIT.slice(0, 12)}`)), 'and the commit the loop now reports');
}

test('unit:up-reopens-a-recorded-master-loop-step — a rerun whose up.json already records master-loop re-opens it when the units read as other code or their reading failed, and leaves it recorded when they read as this checkout', async () => {
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

  // A reading that failed proves nothing either way: the recorded step is re-opened and fails naming
  // why, never left green on code nobody read, and nothing is rewritten or restarted on it.
  const failedReading = () => reading({ loop: null, executor: null, loopCommit: null, loopStale: null, executorStale: null, error: 'units.json is corrupt' });
  const unreadableRoot = await recordedRoot('graphyard-up-loop-recorded-unreadable');
  const unreadable = world([failedReading()]);
  const unreadableRun = await runUp(request(), dependencies(unreadableRoot, [], unreadable));
  assert.equal(unreadableRun.exitCode, 1, unreadableRun.next);
  assert.match(unreadableRun.next, /^master-loop: .*could not be read: units\.json is corrupt/);
  assert.deepEqual(unreadable.calls.filter(call => call.args[0] === 'master'), [], 'a failed reading rewrites and restarts nothing');
  const reopened = JSON.parse(await readFile(join(unreadableRoot, '.graphyard', 'up.json'), 'utf8'));
  assert.ok(!reopened.completed.includes('master-loop'), 'the step a failed reading re-opened is not recorded done');

  // An unfinished step whose first reading failed fails the same way instead of restarting past it.
  const freshRoot = await resumedRoot('graphyard-up-loop-fresh-unreadable');
  const fresh = world([failedReading()], { loopRunning: false });
  const freshRun = await runUp(request(), dependencies(freshRoot, [], fresh));
  assert.equal(freshRun.exitCode, 1, freshRun.next);
  assert.match(freshRun.next, /could not be read: units\.json is corrupt/);
  assert.deepEqual(fresh.calls.filter(call => call.args[0] === 'master'), [], 'nothing restarts on a reading that judged nothing');
});

test('unit:up-host-template-judged-by-its-launcher — a host executor template is rebound unless the launcher ExecStart starts is the host Graphyard checkout or the repository checkout', async () => {
  const { hostTemplateStartsOtherCode } = await up();
  const layout = { home: '/home/graphyard', graphyard: '/srv/graphyard/graphyard', checkout: '/srv/graphyard/repo' };
  const unit = (execStart: string) => `[Service]\nWorkingDirectory=${layout.checkout}\nExecStart=${execStart}\n`;
  assert.equal(hostTemplateStartsOtherCode(unit(`/usr/bin/node ${layout.graphyard}/scripts/graphyard-executor.mjs --slot %i`), layout), false, 'the host Graphyard checkout\'s launcher stands');
  assert.equal(hostTemplateStartsOtherCode(unit(`/usr/bin/node ${layout.checkout}/scripts/graphyard-executor.mjs --slot %i`), layout), false, 'the repository checkout\'s own launcher stands');
  assert.equal(hostTemplateStartsOtherCode(unit(`/usr/bin/node ${layout.checkout}/.graphyard/held-cli/${OLD_COMMIT}/scripts/graphyard-executor.mjs --slot %i`), layout), true, 'a held snapshot under the repository checkout is other code');
  assert.equal(hostTemplateStartsOtherCode(unit(`/usr/bin/node /srv/graphyard/graphyard-pilot/scripts/graphyard-executor.mjs --slot %i`), layout), true, 'an old launcher beside WorkingDirectory=checkout is other code');
  assert.equal(hostTemplateStartsOtherCode(unit('/usr/bin/true'), layout), true, 'an ExecStart naming no launcher is not known to start this code');
});

test('unit:up-host-executor-fleet-preserved — the host repair restarts every slot systemd lists loaded or enabled, and the installer keeps the saved declaration, so an enabled but unloaded slot is never disabled', async () => {
  const { alignHostExecutors } = await up();
  const layout = { home: '/home/graphyard', graphyard: '/srv/graphyard/graphyard', cli: '/srv/graphyard/graphyard/bin/graphyard.mjs', checkout: '/srv/graphyard/repo', userUnitDirectory: '/home/graphyard/.config/systemd/user', configDirectory: '/home/graphyard/.config/graphyard' };
  const template = 'graphyard-executor-acme-shop@.service';
  const host = (declared: boolean) => {
    const calls: string[][] = [];
    return { calls, session: {
      layout, environment: ['GRAPHYARD_CONFIG_HOME=/home/graphyard/.config/graphyard'],
      checkoutAtRef: async () => {},
      remote: { description: 'graphyard@host', exec: async (_program: string, args: string[]) => args[0].endsWith('/.graphyard/executors.json')
        ? (declared ? { code: 0, stdout: '{"version":1,"count":3}', stderr: '' } : { code: 1, stdout: '', stderr: 'No such file' })
        : { code: 0, stdout: `[Service]\nWorkingDirectory=${layout.checkout}\nExecStart=/usr/bin/node /srv/graphyard/graphyard-pilot/scripts/graphyard-executor.mjs --slot %i\n`, stderr: '' } },
      asUser: async (_cwd: string, program: string, args: string[]) => {
        calls.push([program, ...args]);
        if (args[1] === 'list-units') return { code: 0, stdout: 'graphyard-executor-acme-shop@1.service loaded active running slot 1\n', stderr: '' };
        if (args[1] === 'list-unit-files') return { code: 0, stdout: 'graphyard-executor-acme-shop@1.service enabled enabled\ngraphyard-executor-acme-shop@2.service enabled enabled\ngraphyard-executor-acme-shop@3.service enabled enabled\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    } as any };
  };
  const slots = ['graphyard-executor-acme-shop@1.service', 'graphyard-executor-acme-shop@2.service', 'graphyard-executor-acme-shop@3.service'];
  const saved = host(true);
  const aligned = await alignHostExecutors(saved.session, template);
  assert.deepEqual(aligned, { wrote: 'updated', reason: null, restarted: slots });
  const install = saved.calls.find(call => call.includes('--install'))!;
  assert.ok(install, 'the template starting another checkout is installed again');
  assert.equal(install.includes('--count'), false, 'a saved declaration is kept: the installer is never handed a count that could disable a slot');
  assert.deepEqual(saved.calls.at(-1), ['systemctl', '--user', 'restart', ...slots], 'the enabled but unloaded slots restart with the loaded one');
  const unsaved = host(false);
  await alignHostExecutors(unsaved.session, template);
  const declare = unsaved.calls.find(call => call.includes('--install'))!;
  assert.deepEqual(declare.slice(declare.indexOf('--count')), ['--count', '3'], 'a host with no saved declaration is declared from every slot its manager knows, loaded or enabled');
});

test('unit:up-waits-for-the-loop-own-commit — the post-restart wait goes green only on a succeeded reading whose loop reported this CLI\'s commit; a failed or erroring reading, or a cursor with no commit, polls to a failure naming which', async () => {
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

test('unit:up-waits-for-the-executors-own-commit — executor slots on other code are replaced the same way as the loop: the step goes green only once a later reading finds no executor on other code, fails when the alignment restarted nothing, and fails at the deadline naming the slot still on other code', async () => {
  const { runUp } = await up();
  /** The loop already on this commit, one running slot still on the pilot's commit by its own registration. */
  const slotStale = () => reading({
    loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: CLI_ROOT }, executor: { unit: EXECUTOR_TEMPLATE, path: EXECUTOR_PATH, checkout: CLI_ROOT },
    loopCommit: COMMIT, loopStale: null, executorStale: `graphyard-executor-acme-shop@1.service runs ${OLD_COMMIT.slice(0, 12)}, not this checkout's ${COMMIT.slice(0, 12)}`,
  });
  const aligning = (answer: { wrote: 'updated' | 'unchanged' | 'none'; reason: string | null; restarted: string[] }) => (w: UpWorld) =>
    async () => { w.aligned++; w.calls.push({ args: ['align-executors'] }); return answer; };

  // The restarted slot re-registers on this commit: green, and the note names the replacement.
  const replacedRoot = await resumedRoot('graphyard-up-executor-replaced');
  const replaced = world([slotStale(), cleanReading()]);
  const replacedEvents: UpEvent[] = [];
  const replacedRun = await runUp(request(), { ...dependencies(replacedRoot, replacedEvents, replaced), alignExecutors: aligning({ wrote: 'unchanged', reason: null, restarted: ['graphyard-executor-acme-shop@1.service'] })(replaced) });
  assert.equal(replacedRun.exitCode, 0, replacedRun.next);
  assert.equal(replaced.aligned, 1, 'the slots are restarted through the alignment');
  assert.deepEqual(named(replaced, ['master', 'init', '--token-stdin', '--replace-supervisor']), [], 'a loop on this commit is not rewritten');
  assert.ok(replacedEvents.some(event => event.kind === 'note' && event.text.includes('every executor slot now runs')), 'the step reports the slots now run this checkout');

  // Nothing is known to restart while a slot is reported on other code: a failure, never a replacement.
  const nothingRoot = await resumedRoot('graphyard-up-executor-nothing');
  const nothing = world([slotStale(), cleanReading()]);
  const nothingRun = await runUp(request(), { ...dependencies(nothingRoot, [], nothing), alignExecutors: aligning({ wrote: 'unchanged', reason: null, restarted: [] })(nothing) });
  assert.equal(nothingRun.exitCode, 1, nothingRun.next);
  assert.match(nothingRun.next, /no executor slot of this install is known to the user manager to restart/);
  const recorded = JSON.parse(await readFile(join(nothingRoot, '.graphyard', 'up.json'), 'utf8'));
  assert.ok(!recorded.completed.includes('master-loop'), 'the step is not recorded done');

  // The restarted slot keeps reporting the old commit: the wait fails at its deadline naming it.
  const neverRoot = await resumedRoot('graphyard-up-executor-never');
  const never = world([slotStale()]);
  const neverRun = await runUp(request(), { ...dependencies(neverRoot, [], never), machineWaitMs: 20, alignExecutors: aligning({ wrote: 'unchanged', reason: null, restarted: ['graphyard-executor-acme-shop@1.service'] })(never) });
  assert.equal(neverRun.exitCode, 1, neverRun.next);
  assert.match(neverRun.next, new RegExp(`the executors still run other code: graphyard-executor-acme-shop@1\\.service runs ${OLD_COMMIT.slice(0, 12)}`));

  // Loop and slot both on other code: the loop's commit alone is not green while the slot still is.
  const bothRoot = await resumedRoot('graphyard-up-executor-both');
  const both = world([reading(), reading({ loopCommit: COMMIT, loopStale: null })]);
  const bothRun = await runUp(request(), { ...dependencies(bothRoot, [], both), machineWaitMs: 20 });
  assert.equal(bothRun.exitCode, 1, bothRun.next);
  assert.match(bothRun.next, /the executors still run other code/);
});

test('unit:doctor-flags-loop-on-other-code — the reading judges the units against this CLI\'s exact commit, never a pin, a held snapshot, a missing or dirty report; doctor reports a loop or executor on other code as one line naming both paths and the rerun; the executor alignment re-binds and restarts', async () => {
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
    assert.match(foreign.loopStale ?? '', new RegExp(`${quote(MASTER_UNIT)} starts the CLI in ${quote(pilot)} at ${OLD_COMMIT.slice(0, 12)}, not this checkout \\(${quote(cliCheckout)}\\) at ${COMMIT.slice(0, 12)}`), 'the loop on another checkout is named with both paths and both commits');
    assert.match(foreign.executorStale ?? '', new RegExp(`${quote(EXECUTOR_TEMPLATE)} runs ${quote(pilot)}, not this checkout`), 'and the executor on it');

    // A unit that exists but cannot be read judges nothing: the reading carries the error, never an absent unit.
    const blockedDirectory = join(base, 'units-blocked');
    await mkdir(join(blockedDirectory, units.master), { recursive: true });
    const blocked = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory: blockedDirectory, home });
    assert.match(blocked.error ?? '', new RegExp(`${quote(MASTER_UNIT)} could not be read: EISDIR`), 'a unit read failure other than a missing file is the reading\'s error');

    // Another commit on this checkout's own unit is other code too, and so is the commit of the
    // known-good pin or the held snapshot a restart pinned: this command asks for this CLI's commit,
    // so a loop on either is restarted onto it rather than accepted. A cursor that records no
    // commit is no proof the loop runs this code, and neither is a release it loaded dirty.
    await writeFile(join(unitDirectory, units.master), `[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/node ${join(cliCheckout, 'bin', 'graphyard.mjs')} master run\n`);
    const staleCommit = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home });
    assert.match(staleCommit.loopStale ?? '', new RegExp(`runs ${OLD_COMMIT.slice(0, 12)}, not this checkout's ${COMMIT.slice(0, 12)}`), 'an old commit on the cursor is other code');
    assert.equal(staleCommit.loopReplace, 'restart', 'a unit on this checkout running another commit is restarted, not rewritten');
    assert.equal(foreign.loopReplace, 'unit', 'a unit on another checkout is rewritten');
    await writeFile(join(base, 'config', 'acme-shop', 'coordinator', 'state.json'), JSON.stringify({ sha: OLD_COMMIT, pinnedAt: 'an earlier promotion', previous: null }));
    await writeFile(join(root, '.graphyard', 'held-cli.json'), JSON.stringify({ commit: OLD_COMMIT, root: pilot }));
    const pinned = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home, cursor: JSON.stringify({ release: { commit: OLD_COMMIT, dirty: false } }) });
    assert.match(pinned.loopStale ?? '', new RegExp(`runs ${OLD_COMMIT.slice(0, 12)}, not this checkout's ${COMMIT.slice(0, 12)}`), 'a loop on the pin\'s or held snapshot\'s older commit is not this CLI\'s commit');
    const current = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home, cursor: JSON.stringify({ release: { commit: COMMIT, dirty: false } }) });
    assert.equal(current.loopStale, null, 'a loop reporting this CLI\'s commit, clean, runs this code');
    for (const [cursor, label] of [[null, 'no cursor'], ['{not json', 'a malformed cursor'], [JSON.stringify({ release: null }), 'a cursor with no release']] as const) {
      const silent = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home, cursor });
      assert.match(silent.loopStale ?? '', /cursor records no commit it loaded/, `${label} is no proof the loop runs this code`);
      assert.equal(silent.loopReplace, 'restart');
    }
    const dirty = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home, cursor: JSON.stringify({ release: { commit: COMMIT, dirty: true } }) });
    assert.match(dirty.loopStale ?? '', /with uncommitted changes it loaded/, 'a loop that loaded a dirty tree runs code no commit names');
    const headless = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run: () => { throw new Error('git is gone'); }, units, unitDirectory, home, cursor: JSON.stringify({ release: { commit: COMMIT, dirty: false } }) });
    assert.match(headless.error ?? '', /could not be read, so no unit is judged/, 'without this CLI\'s commit nothing is judged ready');

    // A slot's own registration is judged the same way: a running slot whose recorded release is
    // neither this CLI's commit nor the repository checkout's (a slot may start the repository's own
    // executor) is other code, a stopped slot runs nothing, and the pin's older commit is other code
    // for a slot too. The registrations are read beside the master credential, exactly where the
    // fleet records them (executor-fleet's executor registration).
    const slotCommit = 'c'.repeat(40), repositoryCommit = 'd'.repeat(40);
    const withRepository = (_command: string, args: string[]) => args[2] === 'rev-parse' ? `${args[1] === cliCheckout ? COMMIT : repositoryCommit}\n` : '';
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
    await writeFile(join(unitDirectory, units.executorTemplate), `[Unit]\nDescription=Graphyard executor\n\n[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/node ${join(cliCheckout, 'scripts', 'graphyard-executor.mjs')} --slot %i\n`);
    const slotReading = () => readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run: withRepository, units, unitDirectory, home, cursor: JSON.stringify({ release: { commit: COMMIT, dirty: false } }) });
    await writeFile(join(executorsDirectory, 'slot-1.json'), JSON.stringify(fleetRecord({})));
    const staleSlot = await slotReading();
    assert.match(staleSlot.executorStale ?? '', new RegExp(`${quote(slot1Unit)} runs ${slotCommit.slice(0, 12)}, not this checkout's ${COMMIT.slice(0, 12)}`), 'a slot still running another commit is other code, though its unit binds this checkout');
    await writeFile(join(executorsDirectory, 'slot-1.json'), JSON.stringify(fleetRecord({ state: 'stopped', stoppedAt: 't2' })));
    assert.equal((await slotReading()).executorStale, null, 'a stopped slot runs nothing and is never flagged');
    await writeFile(join(executorsDirectory, 'slot-1.json'), JSON.stringify(fleetRecord({ release: { commit: OLD_COMMIT, dirty: false } })));
    assert.match((await slotReading()).executorStale ?? '', new RegExp(`runs ${OLD_COMMIT.slice(0, 12)}`), 'a slot on the pin\'s older commit is other code');
    await writeFile(join(executorsDirectory, 'slot-1.json'), JSON.stringify(fleetRecord({ release: { commit: repositoryCommit, dirty: false } })));
    assert.equal((await slotReading()).executorStale, null, 'a slot started from the repository\'s own executor, on the repository checkout\'s commit, runs the right code');
    await writeFile(join(executorsDirectory, 'slot-1.json'), JSON.stringify(fleetRecord({ release: { commit: COMMIT, dirty: false } })));
    assert.equal((await slotReading()).executorStale, null, 'a slot on this CLI\'s commit runs this code');

    // Registrations that exist but cannot be read judge nothing: the reading's error, never an empty fleet.
    const unreadableHome = join(base, 'home-unreadable');
    await mkdir(unreadableHome, { recursive: true });
    await writeFile(join(unreadableHome, 'master.executors'), 'a file where the registrations directory belongs\n');
    const unreadableFleet = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home, master: { repository: 'acme/shop', credentialFile: join(unreadableHome, 'master.token') }, cursor: JSON.stringify({ release: { commit: COMMIT, dirty: false } }) });
    assert.match(unreadableFleet.error ?? '', /master\.executors could not be read: ENOTDIR/, 'a registration directory read failure other than a missing one is the reading\'s error');

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
    await hostDoctor();

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

/**
 * GY-1859: AC-2 for a self-contained host install: doctor reads the host's units through the install
 * arguments the last `up` run recorded, never this machine's. Stale units on the host with none here
 * are one FAIL line naming the host's paths; a host install no run recorded the route to is a FAIL
 * naming the rerun, never a silent pass from this machine's empty unit directory.
 */
async function hostDoctor() {
  const { readInstallLoopCode } = await up();
  const { readHostLoopCode, readSetupStatus } = await repositorySetup();
  const { setupFromZeroChecks, setupLine } = await import('../src/setup-from-zero.js');
  const units: InstallUnits = perInstallUnits('acme/shop');
  const layout = { home: '/home/graphyard', graphyard: '/home/graphyard/graphyard', checkout: '/home/graphyard/code/acme-shop', userUnitDirectory: '/home/graphyard/.config/systemd/user' };
  const credential = '/home/graphyard/.config/graphyard/acme-shop/coordinator.token';
  // The host's loop unit and executor template start the host checkout, whose loop still reports the commit it held before.
  const files: Record<string, string> = {
    [`${layout.checkout}/.graphyard/units.json`]: JSON.stringify(units),
    [`${layout.checkout}/.graphyard/master.json`]: JSON.stringify({ repository: 'acme/shop', credentialFile: credential }),
    [`${layout.userUnitDirectory}/${units.master}`]: `[Service]\nWorkingDirectory=${layout.checkout}\nExecStart=/usr/bin/node ${layout.graphyard}/bin/graphyard.mjs master run\n`,
    [`${layout.userUnitDirectory}/${units.executorTemplate}`]: `[Service]\nWorkingDirectory=${layout.checkout}\nExecStart=/usr/bin/node ${layout.graphyard}/scripts/graphyard-executor.mjs --slot %i\n`,
    [credential.replace(/\.token$/, '.daemon.json')]: JSON.stringify({ release: { commit: OLD_COMMIT, dirty: false } }),
  };
  const hostRun = async (program: string, args: string[]) => {
    if (program === 'cat') return args[0] in files ? { code: 0, stdout: files[args[0]], stderr: '' } : { code: 1, stdout: '', stderr: `cat: ${args[0]}: No such file or directory` };
    if (program === 'ls') return { code: 2, stdout: '', stderr: `ls: cannot access '${args[1]}': No such file or directory` };
    if (program === 'git') return { code: 0, stdout: `${'e'.repeat(40)}\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const hostInstall = ['install', '--provider', 'host', '--repo', 'acme/shop', '--plan', '--ssh-host', 'host.example'];
  const root = await temporaryDirectory('graphyard-doctor-host-loop');
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'up.json'), JSON.stringify({ version: 1, repository: 'acme/shop', provider: 'host', merger: 'control-plane', noHerdr: false, goal: null, completed: [], hostInstall }));
  const reached: string[][] = [];
  let localReads = 0;
  const code = await readInstallLoopCode(root, {
    host: async args => { reached.push(args); return readHostLoopCode(hostRun, layout, COMMIT, 'host.example'); },
    local: async () => { localReads++; throw new Error('this machine\'s units are read for a host install'); },
  });
  assert.deepEqual(reached, [hostInstall], 'the host is reached through the install arguments up recorded');
  assert.equal(localReads, 0, 'this machine\'s units are never read in the host\'s place');
  assert.equal(code.host, 'host.example');
  const line = (await setupFromZeroChecks({ root, status: null, environments: join(root, 'none'), loopCode: code })).find(check => check.id === 'loop-code');
  assert.equal(line?.status, 'fail', 'stale units on the host, none here: doctor fails');
  assert.match(line!.detail, new RegExp(`${quote(`${layout.userUnitDirectory}/${units.master}`)} runs ${OLD_COMMIT.slice(0, 12)}, not this checkout's ${COMMIT.slice(0, 12)}`), 'naming the host\'s unit and the commit it runs');
  assert.match(line!.detail, new RegExp(`from this checkout \\(${quote(layout.graphyard)}\\)`), 'and the host checkout it must run');
  assert.match(setupLine(line!), /^FAIL loop-code: .*rerun graphyard up --repo acme\/shop --agent/);

  // A host install whose up.json records no route to the host (an earlier up run): doctor's own
  // reading, unstubbed, is an error naming the rerun, and the setup line fails on it.
  const unrouted = await temporaryDirectory('graphyard-doctor-host-unrouted');
  await mkdir(join(unrouted, '.graphyard'), { recursive: true });
  await writeFile(join(unrouted, '.graphyard', 'up.json'), JSON.stringify({ version: 1, repository: 'acme/shop', provider: 'host', merger: 'control-plane', noHerdr: false, goal: null, completed: [] }));
  const status = await readSetupStatus(unrouted);
  assert.match(status.loopCode?.error ?? '', /loop runs on its host, and no graphyard up run here recorded how to reach it.*graphyard up --repo acme\/shop --provider host --agent/, 'doctor\'s status reads the host route, never this machine\'s units');
  const unroutedLine = (await setupFromZeroChecks({ root: unrouted, status: null, environments: join(unrouted, 'none') })).find(check => check.id === 'loop-code');
  assert.equal(unroutedLine?.status, 'fail', 'and its setup line fails rather than passing on this machine\'s empty unit directory');
}

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

test('unit:up-replaces-host-loop-on-other-code — a host install\'s loop and slots are read, replaced and verified on the host through its transport, the completed-install rerun included', async () => {
  const { runUp } = await up();
  const { readHostLoopCode } = await repositorySetup();
  const units: InstallUnits = perInstallUnits('acme/shop');
  const layout = { home: '/home/graphyard', graphyard: '/home/graphyard/graphyard', checkout: '/home/graphyard/code/acme-shop', userUnitDirectory: '/home/graphyard/.config/systemd/user' };
  const credential = '/home/graphyard/.config/graphyard/acme-shop/coordinator.token';
  const slot1 = units.executorTemplate.replace('@.service', '@1.service');
  /** The host's files, as `cat` and `ls` on it answer them. */
  const hostFiles = (cursorCommit: string | null, slotCommit: string): Record<string, string> => ({
    [`${layout.checkout}/.graphyard/units.json`]: JSON.stringify(units),
    [`${layout.checkout}/.graphyard/master.json`]: JSON.stringify({ repository: 'acme/shop', credentialFile: credential }),
    [`${layout.userUnitDirectory}/${units.master}`]: `[Service]\nWorkingDirectory=${layout.checkout}\nExecStart=/usr/bin/node ${layout.graphyard}/bin/graphyard.mjs master run\n`,
    [`${layout.userUnitDirectory}/${units.executorTemplate}`]: `[Service]\nWorkingDirectory=${layout.checkout}\nExecStart=/usr/bin/node ${layout.graphyard}/scripts/graphyard-executor.mjs --slot %i\n`,
    ...(cursorCommit ? { [credential.replace(/\.token$/, '.daemon.json')]: JSON.stringify({ release: { commit: cursorCommit, dirty: false } }) } : {}),
    [`${credential.replace(/\.token$/, '.executors')}/slot-1.json`]: JSON.stringify({ state: 'running', root: layout.graphyard, release: { commit: slotCommit, dirty: false }, supervisor: { unit: slot1 } }),
  });
  const hostRun = (files: Record<string, string>) => async (program: string, args: string[]) => {
    if (program === 'cat') return args[0] in files ? { code: 0, stdout: files[args[0]], stderr: '' } : { code: 1, stdout: '', stderr: `cat: ${args[0]}: No such file or directory` };
    if (program === 'ls') { const names = Object.keys(files).filter(path => path.startsWith(`${args[1]}/`)).map(path => path.slice(args[1].length + 1)); return names.length ? { code: 0, stdout: names.join('\n'), stderr: '' } : { code: 2, stdout: '', stderr: `ls: cannot access '${args[1]}': No such file or directory` }; }
    if (program === 'git') return { code: 0, stdout: `${'e'.repeat(40)}\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };

  // The host's loop and slot still report the commit the host checkout held before: other code,
  // judged against the host checkout at this CLI's commit, never against this machine's units.
  const stale = await readHostLoopCode(hostRun(hostFiles(OLD_COMMIT, OLD_COMMIT)), layout, COMMIT, 'host.example');
  assert.equal(stale.host, 'host.example');
  assert.equal(stale.cli.root, layout.graphyard, 'the host\'s own Graphyard checkout is the code they must run');
  assert.match(stale.loopStale ?? '', new RegExp(`runs ${OLD_COMMIT.slice(0, 12)}, not this checkout's ${COMMIT.slice(0, 12)}`));
  assert.equal(stale.loopReplace, 'restart');
  assert.match(stale.executorStale ?? '', new RegExp(`${quote(slot1)} runs ${OLD_COMMIT.slice(0, 12)}`));
  const silent = await readHostLoopCode(hostRun(hostFiles(null, COMMIT)), layout, COMMIT, 'host.example');
  assert.match(silent.loopStale ?? '', /cursor records no commit/, 'a host loop with no recorded commit is not proof either');
  const settled = await readHostLoopCode(hostRun(hostFiles(COMMIT, COMMIT)), layout, COMMIT, 'host.example');
  assert.deepEqual([settled.loopStale, settled.executorStale, settled.error], [null, null, null], 'the host on this commit reads clean');
  const refused = await readHostLoopCode(async (program, args) => program === 'cat' && args[0].endsWith(units.master) ? { code: 1, stdout: '', stderr: 'cat: Permission denied' } : hostRun(hostFiles(COMMIT, COMMIT))(program, args), layout, COMMIT, 'host.example');
  assert.match(refused.error ?? '', /could not be read: cat: Permission denied/, 'a refused host read is the reading\'s error, never an absent unit');

  // runUp on a host install whose earlier run recorded every step: the rerun reads the host through
  // the install's arguments, re-opens master-loop, replaces the loop and slots there (never running
  // this machine's master init or restart), and goes green only once the host reports this commit.
  const root = await temporaryDirectory('graphyard-up-host-loop');
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'up.json'), JSON.stringify({
    version: 1, repository: 'acme/shop', provider: 'host', merger: 'control-plane', noHerdr: false, goal: null,
    completed: ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'merger-setting', 'master-autonomy', 'onboarding', 'accounts', 'harness', 'master-loop', 'goal'],
  }));
  const hostReadings = [stale, stale, stale, settled];
  const seen: (string[] | null | undefined)[] = [], replaced: { unit: string; rewrite: boolean }[] = [], aligned: (string | null | undefined)[] = [];
  const w = world([]);
  const events: UpEvent[] = [];
  const run = await runUp({ ...request(), provider: 'host' }, {
    ...dependencies(root, events, w),
    loopCode: async hostInstall => { seen.push(hostInstall); return hostReadings.length > 1 ? hostReadings.shift()! : hostReadings[0]; },
    alignExecutors: async (options = {}, hostInstall) => { aligned.push(options.template); assert.ok(hostInstall?.includes('host')); return { wrote: 'unchanged', reason: null, restarted: [slot1] }; },
    replaceHostLoop: async (hostInstall, options) => { assert.ok(hostInstall.includes('--provider') && hostInstall.includes('host')); replaced.push(options); },
  });
  assert.equal(run.exitCode, 0, run.next);
  assert.ok(seen.length >= 3 && seen.every(args => Array.isArray(args) && args.includes('--provider') && args.includes('host')), 'every reading is taken on the host, through the install\'s arguments');
  assert.deepEqual(replaced, [{ unit: units.master, rewrite: false }], 'the host loop is restarted onto this commit where it runs');
  assert.deepEqual(aligned, [units.executorTemplate], 'and its slots are restarted there');
  assert.deepEqual(named(w, ['master', 'restart']), [], 'nothing is restarted on this machine for a host install');
  assert.deepEqual(named(w, ['master', 'init', '--token-stdin', '--replace-supervisor']), [], 'and nothing is rewritten here');
  assert.ok(events.some(event => event.kind === 'note' && event.text.includes(`the loop now runs ${layout.graphyard} at ${COMMIT.slice(0, 12)}`)), 'the step reports the host loop now on this commit');
  const recorded = JSON.parse(await readFile(join(root, '.graphyard', 'up.json'), 'utf8')).hostInstall;
  assert.deepEqual(recorded, seen[0], 'the route to the host is recorded, so doctor reads the host\'s units too');
});
