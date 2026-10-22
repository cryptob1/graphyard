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
 * `graphyard up`'s master-loop step reads what the install's loop unit runs against
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
const MASTER_UNIT_PATH = `/units/${MASTER_UNIT}`;
const TOKEN = 'm'.repeat(40);
const quote = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A reading as the host reports it: the loop unit on the pilot checkout, its commit on the cursor. */
const reading = (over: Partial<LoopCodeReading> = {}): LoopCodeReading => ({
  loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: OLD_CHECKOUT },
  loopCommit: OLD_COMMIT,
  cli: { root: CLI_ROOT, commit: COMMIT },
  repository: 'acme/shop',
  loopStale: `${MASTER_UNIT_PATH} starts the CLI in ${OLD_CHECKOUT} at ${OLD_COMMIT.slice(0, 12)}, not this checkout (${CLI_ROOT}) at ${COMMIT.slice(0, 12)}`,
  error: null,
  ...over,
});

const cleanReading = () => reading({
  loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: CLI_ROOT },
  loopCommit: COMMIT,
  loopStale: null,
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
}

const world = (readings: (LoopCodeReading | null)[], over: Partial<UpWorld> = {}): UpWorld =>
  ({ calls: [], initAnswers: [], loopRunning: true, readings, ...over });

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
  };
}

const request = (): UpRequest => ({ repository: 'acme/shop', provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', browserProfile: null, merger: 'control-plane' });

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
  // unit restart that rewrite performed is not asked
  // for twice, and the step is green only once the loop reports this CLI's commit.
  const replacedRoot = await resumedRoot('graphyard-up-loop-replaced');
  const replaced = world([reading(), reading({ loopCommit: COMMIT, loopStale: null })]);
  const replacedEvents: UpEvent[] = [];
  const replacedRun = await runUp(request(), dependencies(replacedRoot, replacedEvents, replaced));
  assert.equal(replacedRun.exitCode, 0, replacedRun.next);
  assert.deepEqual(named(replaced, ['master', 'init', '--token-stdin', '--replace-supervisor']), [{ args: ['master', 'init', '--token-stdin', '--replace-supervisor'], stdin: TOKEN }], 'the unit is rewritten through master init --replace-supervisor, with the recorded master credential');
  assert.deepEqual(named(replaced, ['master', 'restart']), [], 'the rewrite already restarted the unit, so the step restarts it no second time');
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
    cli: { root: CLI_ROOT, commit: COMMIT }, primary: REPOSITORY_ROOT, repository: 'acme/shop',
    loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: OLD_CHECKOUT },
    cursor: JSON.stringify({ release: { commit: OLD_COMMIT, dirty: false } }), canonical: path => path,
  });
  assert.equal(judged.loopReplace, 'unit', 'a unit on another checkout is rewritten');
  const judgedRoot = await resumedRoot('graphyard-up-loop-judged');
  const judgedWorld = world([reading({ loopStale: judged.loopStale, loopReplace: judged.loopReplace }), cleanReading()]);
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
    [reading({ loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: CLI_ROOT }, loopReplace: 'restart', loopStale: `${MASTER_UNIT_PATH} runs ${OLD_COMMIT.slice(0, 12)}, not this checkout's ${COMMIT.slice(0, 12)}` }),
      cleanReading()]);
  const staleRun = await runUp(request(), dependencies(staleCommitRoot, [], staleCommit));
  assert.equal(staleRun.exitCode, 0, staleRun.next);
  assert.equal(named(staleCommit, ['master', 'init', '--token-stdin', '--replace-supervisor']).length, 0, 'a unit already on this checkout is not rewritten');
  assert.equal(named(staleCommit, ['master', 'restart']).length, 1, 'the loop on another commit is restarted onto this one');

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
    const read = async () => readLoopCode(root, { cliPath, run, units, unitDirectory, home, master: { repository: 'acme/shop', credentialFile: join(home, 'master.token') }, cursor: JSON.stringify({ release: { commit: await loaded(), dirty: false } }) });
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

test('unit:up-rewrites-self-managed-loop-on-the-managed-checkout — when Graphyard manages itself, a loop whose ExecStart starts the managed checkout\'s launcher is rewritten onto this CLI, never only restarted, and goes green on this CLI\'s commit', async () => {
  const { runUp } = await up();
  const { readLoopCode } = await repositorySetup();
  const { loopUnitText } = await import('../src/supervisor.js');
  const units: InstallUnits = perInstallUnits('acme/shop');
  const base = await temporaryDirectory('graphyard-up-loop-self-managed');
  // The managed checkout B (this repository, at the older commit) and this CLI's checkout A at COMMIT.
  const root = await resumedRoot('graphyard-up-loop-self-managed-root'), unitDirectory = join(base, 'units'), home = join(base, 'home'), installDir = join(base, 'install');
  const cliPath = join(base, 'cli', 'bin', 'graphyard.mjs'), managedPath = join(root, 'bin', 'graphyard.mjs');
  for (const directory of [unitDirectory, home, installDir]) await mkdir(directory, { recursive: true });
  const unitFile = join(unitDirectory, units.master);
  await writeFile(unitFile, loopUnitText({ root, cliPath: managedPath, repository: 'acme/shop', intervalSeconds: 30, installDir, heldLauncher: null }));
  assert.match(await readFile(unitFile, 'utf8'), new RegExp(`ExecStart=\\S+ ${quote(managedPath)} master run`), 'the loop starts the managed checkout\'s launcher');
  // Each checkout's HEAD; the loop reports the commit of the launcher its unit starts.
  const run = (_command: string, args: string[]) => args[2] === 'rev-parse' ? `${args[1] === root ? OLD_COMMIT : COMMIT}\n` : '';
  const loaded = async () => (await readFile(unitFile, 'utf8')).includes(`${cliPath} master run`) ? COMMIT : OLD_COMMIT;
  const read = async () => readLoopCode(root, { cliPath, run, units, unitDirectory, home, master: { repository: 'acme/shop', credentialFile: join(home, 'master.token') }, cursor: JSON.stringify({ release: { commit: await loaded(), dirty: false } }) });
  const before = await read();
  assert.equal(before.loop?.launcher, root, 'the reading records the launcher\'s checkout');
  assert.equal(before.loopReplace, 'unit', 'a launcher in the managed checkout is not this CLI: the unit is rewritten');
  assert.match(before.loopStale ?? '', new RegExp(`starts the CLI in ${quote(root)} at ${OLD_COMMIT.slice(0, 12)}, not this checkout \\(${quote(join(base, 'cli'))}\\)`), 'and names both checkouts');
  // A unit naming no launcher whose WorkingDirectory is the repository checkout still reads as this install's own.
  const { judgeLoopCode } = await repositorySetup();
  const fallback = judgeLoopCode({ cli: { root: CLI_ROOT, commit: COMMIT }, primary: REPOSITORY_ROOT, repository: 'acme/shop', loop: { unit: MASTER_UNIT, path: MASTER_UNIT_PATH, checkout: REPOSITORY_ROOT, launcher: null }, cursor: JSON.stringify({ release: { commit: COMMIT, dirty: false } }), canonical: path => path });
  assert.equal(fallback.loopStale, null, 'the WorkingDirectory fallback accepts the repository checkout');
  const w = world([]), events: UpEvent[] = [];
  const deps = dependencies(root, events, w);
  const outcome = await runUp(request(), { ...deps,
    loopCode: read,
    cli: async (args, options = {}) => {
      if (args[0] === 'master' && args[1] === 'init') { w.calls.push({ args }); await writeFile(unitFile, loopUnitText({ root, cliPath, repository: 'acme/shop', intervalSeconds: 30, installDir, heldLauncher: null })); return { code: 0, stdout: '{"supervisor":{"state":"updated"}}' }; }
      return deps.cli(args, options);
    } });
  assert.equal(outcome.exitCode, 0, outcome.next);
  assert.equal(named(w, ['master', 'init', '--token-stdin', '--replace-supervisor']).length, 1, 'the unit is rewritten, not only restarted');
  const unit = await readFile(unitFile, 'utf8');
  assert.match(unit, new RegExp(`ExecStart=\\S+ ${quote(cliPath)} master run`), 'the rewritten unit starts this CLI');
  assert.doesNotMatch(unit, new RegExp(quote(managedPath)), 'and no longer the managed checkout\'s launcher');
  const after = await read();
  assert.equal(after.loopCommit, COMMIT, 'the final reading reports this CLI\'s commit');
  assert.equal(after.loopStale, null, 'and judges the loop as this code');
});

test('unit:up-reopens-a-recorded-master-loop-step — a rerun whose up.json already records master-loop re-opens it when the units read as other code or their reading failed, and leaves it recorded when they read as this checkout', async () => {
  const { runUp } = await up();

  // The install this item exists for: an earlier run recorded master-loop done while its loop kept
  // serving the pilot checkout. The rerun re-opens the recorded step, replaces the unit, and is
  // green once the restarted loop reports this CLI's commit — never a skip past the same false green.
  const recordedStaleRoot = await recordedRoot('graphyard-up-loop-recorded-stale');
  const recordedStale = world([reading(), reading(), reading({ loopCommit: COMMIT, loopStale: null })]);
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
  const failedReading = () => reading({ loop: null, loopCommit: null, loopStale: null, error: 'units.json is corrupt' });
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

test('unit:doctor-flags-loop-on-other-code — the reading judges the units against this CLI\'s exact commit, never a pin, a held snapshot, a missing or dirty report; doctor reports a loop on other code as one line naming both paths and the rerun', async () => {
  const { readLoopCode, readSetupStatus } = await repositorySetup();
  const { readinessChecklist } = await readinessModule();
  const units: InstallUnits = perInstallUnits('acme/shop');
  const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  // A simulated host: the managed checkout, its master configuration, a unit directory whose loop
  // unit still names the pilot checkout, and the pilot commit on the cursor.
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
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'one');
    await writeFile(join(root, '.graphyard', 'master.json'), JSON.stringify({ repository: 'acme/shop', credentialFile: join(home, 'master.token') }));
    const run = (_command: string, args: string[]) => args[2] === 'rev-parse' ? `${COMMIT}\n` : '';
    await writeFile(join(unitDirectory, units.master), `[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/node ${join(pilot, 'bin', 'graphyard.mjs')} master run\n`);
    await writeFile(join(home, 'master.daemon.json'), JSON.stringify({ release: { commit: OLD_COMMIT } }));

    const foreign = await readLoopCode(root, { cliPath: join(cliCheckout, 'bin', 'graphyard.mjs'), run, units, unitDirectory, home });
    assert.equal(foreign.loop?.checkout, pilot, 'the loop unit reads as running the pilot checkout');
    assert.equal(foreign.loopCommit, OLD_COMMIT, 'the cursor records the commit the running loop loaded');
    assert.match(foreign.loopStale ?? '', new RegExp(`${quote(MASTER_UNIT)} starts the CLI in ${quote(pilot)} at ${OLD_COMMIT.slice(0, 12)}, not this checkout \\(${quote(cliCheckout)}\\) at ${COMMIT.slice(0, 12)}`), 'the loop on another checkout is named with both paths and both commits');

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

    // The doctor line: one FAIL naming both paths and the rerun, ready once the loop runs this checkout.
    const facts = (code: LoopCodeReading | null) => readinessChecklist('through-merge', {
      repository: 'acme/shop',
      server: { url: SERVER, reachable: true, role: 'coordinator' },
      setup: { proposal: null, appliedAt: 'an earlier run', githubApp: null, drift: [], unreadable: [], loopCode: code },
      proposal: null,
    });
    const loopCode = facts(foreign).items.find(item => item.id === 'loop-code')!;
    assert.equal(loopCode.status, 'missing');
    assert.match(loopCode.detail, new RegExp(`${quote(MASTER_UNIT)} starts the CLI in ${quote(pilot)}`), 'the line names the unit still on the old code');
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
    
  } finally {
    if (configHome === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = configHome;
  }
});

test('unit:doctor-loop-code-setup-line — setupFromZero carries the loop-code line: one FAIL naming both paths and the rerun, a PASS once the units run this checkout, a FAIL for an unreadable record, and no line while no unit of this install stands', async () => {
  const { setupFromZeroChecks, setupLine } = await import('../src/setup-from-zero.js');
  const root = await temporaryDirectory('graphyard-doctor-setup-line');
  const checks = (code: LoopCodeReading | null) => setupFromZeroChecks({ root, status: null, environments: join(root, 'none'), loopCode: code });

  // A loop on other code: one FAIL line naming both paths, this checkout, and the
  // rerun whose master-loop step replaces it, printed in doctor's `PASS id` / `FAIL id` form.
  const failing = (await checks(reading())).find(check => check.id === 'loop-code');
  assert.equal(failing?.status, 'fail');
  assert.match(failing.detail, new RegExp(`${quote(MASTER_UNIT_PATH)} starts the CLI in ${quote(OLD_CHECKOUT)}`), 'the line names the loop unit and its old checkout');
  assert.match(failing.detail, /rerun graphyard up --repo acme\/shop --agent from this checkout/, 'the rerun that fixes it is named');
  assert.equal(failing.step, 'rerun graphyard up --agent from this checkout (docs/setup-from-zero.md step 10, start the master)');
  assert.match(setupLine(failing), /^FAIL loop-code: .* \(fix: .+\)$/);

  assert.equal((await checks(cleanReading())).find(check => check.id === 'loop-code')?.status, 'pass', 'units on this checkout pass');
  const unreadable = (await checks(reading({ error: 'units.json is corrupt', loopStale: null }))).find(check => check.id === 'loop-code');
  assert.equal(unreadable?.status, 'fail', 'an install whose units record cannot be read fails too');
  assert.match(unreadable?.detail ?? '', /units\.json is corrupt/);
  const absent = (await checks(reading({ loop: null, loopStale: null }))).find(check => check.id === 'loop-code');
  assert.equal(absent, undefined, 'no unit of this install stands, so no line is judged');
  const untaken = (await checks(null)).find(check => check.id === 'loop-code');
  assert.equal(untaken?.status, 'fail', 'a reading that could not be taken is never a pass');
  assert.match(untaken?.detail ?? '', /could not be read/);
});

test('unit:up-rejected-reading-never-green — a loop-code reading that was rejected or came back empty re-opens a recorded master-loop step and fails an unfinished one, naming why, and nothing is rewritten or restarted on it', async () => {
  const { runUp } = await up();
  // The host session failed before any unit was read (preparing the install, reaching the host).
  const rejecting = (w: UpWorld) => async (): Promise<LoopCodeReading | null> => { w.calls.push({ args: ['loop-code'] }); throw new Error('ssh: connect to host acme-host port 22: Connection refused'); };
  for (const [label, rootOf] of [['recorded', recordedRoot], ['unfinished', resumedRoot]] as const) {
    const root = await rootOf(`graphyard-up-loop-rejected-${label}`);
    const w = world([cleanReading()]);
    const events: UpEvent[] = [];
    const run = await runUp(request(), { ...dependencies(root, events, w), loopCode: rejecting(w) });
    assert.equal(run.exitCode, 1, `${label}: ${run.next}`);
    assert.match(run.next, /^master-loop: what the install's loop unit runs could not be read: ssh: connect to host acme-host port 22: Connection refused/, label);
    assert.deepEqual(w.calls.filter(call => call.args[0] === 'master'), [], `${label}: a rejected reading rewrites and restarts nothing`);
    const state = JSON.parse(await readFile(join(root, '.graphyard', 'up.json'), 'utf8'));
    assert.ok(!state.completed.includes('master-loop'), `${label}: the step is not recorded done on a rejected reading`);
  }
  // An empty answer judged nothing either.
  const emptyRoot = await recordedRoot('graphyard-up-loop-empty-recorded');
  const empty = world([null]);
  const emptyRun = await runUp(request(), dependencies(emptyRoot, [], empty));
  assert.equal(emptyRun.exitCode, 1, emptyRun.next);
  assert.match(emptyRun.next, /could not be read: no reading came back/);
  // With no reader at all, the recorded step stands as an earlier run left it.
  const noReaderRoot = await recordedRoot('graphyard-up-loop-no-reader');
  const noReader = world([cleanReading()]);
  const noReaderRun = await runUp(request(), { ...dependencies(noReaderRoot, [], noReader), loopCode: undefined });
  assert.equal(noReaderRun.exitCode, 0, noReaderRun.next);
  assert.deepEqual(noReader.calls, [], 'without a reader the recorded step is skipped as before');
});

test('unit:up-validates-the-checkout-it-installs — the clean-checkout preflight judges this CLI\'s checkout, the one the loop is rewritten onto, never the obsolete checkout master.json still records', async () => {
  const { upDependencies } = await up();
  const base = await temporaryDirectory('graphyard-up-cli-checkout');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const checkout = async (name: string) => {
    const root = join(base, name);
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(join(root, 'bin', 'graphyard.mjs'), '// cli\n');
    git(root, 'init', '-q');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'cli');
    return root;
  };
  const a = await checkout('graphyard-a'), b = await checkout('graphyard-b');
  const dirty = (root: string) => writeFile(join(root, 'bin', 'graphyard.mjs'), '// uncommitted\n');
  const repository = join(base, 'repository');
  await mkdir(join(repository, '.graphyard'), { recursive: true });
  // master.json still records the obsolete checkout A; this run is CLI B.
  await writeFile(join(repository, '.graphyard', 'master.json'), JSON.stringify({ url: SERVER, cliPath: join(a, 'bin', 'graphyard.mjs') }));
  const read = () => upDependencies(repository, join(b, 'bin', 'graphyard.mjs'), request(), () => {}, () => null, () => null).cliCheckout!();

  // Clean B, dirty obsolete A: the migration is not refused for A's work.
  await dirty(a);
  assert.deepEqual(await read(), { root: b, dirty: [] }, 'dirty work in the obsolete recorded checkout stops nothing');
  // Dirty B, clean A: B is what is installed, so its work stops the run.
  git(a, 'checkout', '--', '.');
  await dirty(b);
  assert.deepEqual(await read(), { root: b, dirty: ['bin/graphyard.mjs'] }, 'dirty work in this CLI\'s own checkout is found');
});
