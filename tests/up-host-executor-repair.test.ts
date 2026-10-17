import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { UpDependencies, UpEvent, UpRequest } from '../src/up.js';
import { perInstallUnits } from '../src/install/units.js';
import type { LoopCodeReading } from '../src/repository-setup.js';

/**
 * GY-1881: the host executor repair runs the real installer. The host repair (`up`'s alignHostExecutors)
 * rebinds a template whose launcher starts another Graphyard checkout by running the host's
 * `graphyard-executor.mjs --install`; the installer (repository-setup's installExecutorSupervision)
 * refused that unit as another install's (GY-1441's ownership assert), so the repair the earlier
 * fleet-preserved test certified by stubbing `--install` could never succeed. Here the simulated
 * host dispatches the repair's own `--install` argv to the REAL installExecutorSupervision — the
 * shipped template, the host's saved declaration and units record, only the systemd runner stubbed —
 * so the repair is certified exactly as it will run.
 *
 * Proof: unit:up-host-executor-repair-real-installer, unit:up-host-executor-repair-declared-slots.
 */
// Loaded inside each test, so a tree without them fails as a test case, not at load.
const up = () => import('../src/up.js');
const repositorySetup = () => import('../src/repository-setup.js');

const yieldTurn = () => new Promise<void>(accept => setImmediate(accept));
const SERVER = 'http://127.0.0.1:4310';
const REPOSITORY = 'acme/shop';
const COMMIT = 'a'.repeat(40);
const quote = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** This checkout — the CLI running the invocation, which the host checkout is placed at (checkoutAtRef). */
const THIS_CHECKOUT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '');
const THIS_CLI_SCRIPT = fileURLToPath(new URL('../scripts/graphyard-executor.mjs', import.meta.url));
const units = perInstallUnits(REPOSITORY);
const TEMPLATE = units.executorTemplate;

/** The executor unit a Graphyard checkout writes: it works in WORKINGDIRECTORY and starts LAUNCHER's script. */
const executorUnitText = (workingDirectory: string, launcher: string) =>
  `[Unit]\nDescription=Graphyard executor slot %i\n\n[Service]\nWorkingDirectory=${workingDirectory}\nExecStart=/usr/bin/node ${launcher}/scripts/graphyard-executor.mjs --slot %i\nEnvironment=GRAPHYARD_EXECUTOR_UNIT=%n\nRestart=always\nRestartSec=10\n`;
/** A unit that starts another program entirely — no Graphyard executor, in another checkout's tree. */
const foreignUnitText = (workingDirectory: string) =>
  `[Unit]\nDescription=another program\n\n[Service]\nWorkingDirectory=${workingDirectory}\nExecStart=/usr/bin/node ${workingDirectory}/serve.js --port 8080\nRestart=always\n`;

interface HostLayout { base: string; repo: string; home: string; unitDirectory: string; unitFile: string; staleCheckout: string; foreignTree: string; slots: string[] }

/**
 * A host layout: the managed repository's checkout (a git checkout whose .graphyard carries
 * master.json and a saved three-slot declaration) and a user unit directory whose executor
 * template UNIT is written as given — a stale Graphyard checkout's launcher, or a foreign program's.
 */
async function hostLayout(label: string, unit: (paths: { repo: string; staleCheckout: string; foreignTree: string }) => string, count = 3): Promise<HostLayout> {
  const base = await temporaryDirectory(label);
  const repo = join(base, 'repo'), home = join(base, 'home'), unitDirectory = join(base, 'units');
  for (const directory of [join(repo, '.graphyard'), unitDirectory, home]) await mkdir(directory, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'host@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'host']);
  await writeFile(join(repo, 'README.md'), 'managed\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'managed']);
  await writeFile(join(repo, '.graphyard', 'master.json'), JSON.stringify({
    version: 1, url: SERVER, credentialFile: join(home, 'coordinator.token'), cliPath: join(THIS_CHECKOUT, 'bin', 'graphyard.mjs'),
    repository: REPOSITORY, baseBranch: 'main', githubAppId: 0, hostId: 'test-host', masterAgentName: 'graphyard-master-acme-shop',
  }));
  await writeFile(join(repo, '.graphyard', 'executors.json'), JSON.stringify({ version: 1, count, kinds: null, intervalSeconds: 5 }));
  const staleCheckout = join(base, 'graphyard-pilot'), foreignTree = join(base, 'other-app');
  await mkdir(staleCheckout, { recursive: true });
  await mkdir(foreignTree, { recursive: true });
  const unitFile = join(unitDirectory, TEMPLATE);
  await writeFile(unitFile, unit({ repo, staleCheckout, foreignTree }));
  return { base, repo, home, unitDirectory, unitFile, staleCheckout, foreignTree, slots: [1, 2, 3].map(slot => TEMPLATE.replace('@.service', `@${slot}.service`)) };
}

/**
 * The host session `alignHostExecutors` reaches the layout through: `remote.exec` reads the unit and
 * declaration files, `systemctl --user` listings name every slot, and — the point of this test — the
 * repair's own installer invocation (`env … node <checkout>/scripts/graphyard-executor.mjs
 * --install [--count N]`) runs the REAL installExecutorSupervision over the host's paths, as the
 * script on the host would: the shipped template, the saved declaration, a stubbed user manager.
 */
function hostSession(layout: HostLayout, recorded: { installer: string[][]; systemCtl: string[][]; host?: string[][] }) {
  const layoutShaped = { home: layout.home, graphyard: THIS_CHECKOUT, cli: join(THIS_CHECKOUT, 'bin', 'graphyard.mjs'), checkout: layout.repo, userUnitDirectory: layout.unitDirectory, configDirectory: join(layout.home, '.config', 'graphyard') };
  return {
    layout: layoutShaped,
    environment: [`GRAPHYARD_CONFIG_HOME=${layoutShaped.configDirectory}`],
    checkoutAtRef: async () => {},
    remote: {
      description: 'graphyard@test-host',
      exec: async (_program: string, args: string[]) => {
        const file = args[0].endsWith('/.graphyard/executors.json') ? join(layout.repo, '.graphyard', 'executors.json') : layout.unitFile;
        try { return { code: 0, stdout: await readFile(file, 'utf8'), stderr: '' }; } catch (error: any) { return { code: 1, stdout: '', stderr: `${error.message}\n` }; }
      },
    },
    asUser: async (_cwd: string, program: string, args: string[]) => {
      if (program === 'env' && args.includes('--install')) {
        recorded.installer.push(args);
        const count = args.includes('--count') ? Number(args[args.indexOf('--count') + 1]) : undefined;
        const { installExecutorSupervision } = await repositorySetup();
        // The script's own exit shape: the install report on stdout, a thrown refusal's message on stderr with status 1.
        // The manager lists the same slots the host's listings name, so the installer sees the fleet the repair saw.
        const run = (managerArgs: string[]) => { recorded.systemCtl.push(managerArgs); return managerArgs[0] === 'is-active' ? 'active' : managerArgs[0] === 'list-unit-files' ? layout.slots.map(slot => `${slot} enabled enabled\n`).join('') : ''; };
        try {
          const installed = await installExecutorSupervision(layout.repo, { ...(count === undefined ? {} : { count }), run, unitDirectory: layout.unitDirectory });
          return { code: 0, stdout: JSON.stringify(installed), stderr: '' };
        } catch (error: any) { return { code: 1, stdout: '', stderr: `${error.message}\n` }; }
      }
      if (program === 'systemctl') recorded.host?.push(args);
      if (args[1] === 'list-units') return { code: 0, stdout: `${layout.slots[0]} loaded active running slot 1\n`, stderr: '' };
      if (args[1] === 'list-unit-files') return { code: 0, stdout: layout.slots.map(slot => `${slot} enabled enabled\n`).join(''), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

/** What the host reading reports: the loop on this checkout's commit, the executor template wherever EXECUTORCHECKOUT names. */
const reading = (layout: HostLayout, executorCheckout: string | null): LoopCodeReading => ({
  loop: { unit: units.master, path: join(layout.unitDirectory, units.master), checkout: THIS_CHECKOUT },
  loopCommit: COMMIT,
  executor: { unit: TEMPLATE, path: layout.unitFile, checkout: executorCheckout ?? THIS_CHECKOUT },
  cli: { root: THIS_CHECKOUT, commit: COMMIT },
  repository: REPOSITORY,
  host: 'graphyard@test-host',
  loopStale: null,
  executorStale: executorCheckout === null ? null : `${layout.unitFile} runs ${executorCheckout}, not this checkout (${THIS_CHECKOUT}) or the repository checkout (${layout.repo})`,
  error: null,
});

interface UpWorld { readings: (LoopCodeReading | null)[]; calls: string[][] }

/** A root whose up state records every control-plane step but master-loop done, so a run reaches that step alone. */
async function resumedRoot(label: string) {
  const root = await temporaryDirectory(label);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'up.json'), JSON.stringify({
    version: 1, repository: REPOSITORY, provider: 'compose', merger: 'control-plane', noHerdr: false, goal: null,
    completed: ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'merger-setting', 'master-autonomy', 'onboarding', 'accounts', 'harness'],
  }));
  return root;
}

function dependencies(root: string, events: UpEvent[], w: UpWorld, session: ReturnType<typeof hostSession>): UpDependencies {
  let clock = 0;
  return {
    root, pollMs: 1, machineWaitMs: 200,
    emit: event => events.push(event),
    now: () => clock,
    sleep: async ms => { clock += ms; await yieldTurn(); },
    serverUrl: async () => SERVER,
    masterToken: async () => 'm'.repeat(40),
    status: async () => ({
      githubRepository: REPOSITORY,
      mergeWriter: { merger: 'control-plane' },
      fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-b'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, eligible: true }, { name: 'claude-b', enabled: true, loggedIn: true, eligible: true }] },
      setup: { protection: 'checks', loop: true },
    }),
    publishOnboarding: async () => null,
    onboardingMerged: async () => true,
    signIn: async () => `${SERVER}/#sign-in=${'c'.repeat(43)}`,
    operatorToken: async () => 'o'.repeat(40),
    installDirectory: () => '/install/acme-shop',
    ensureDeployKey: async () => '/install/acme-shop/deploy',
    cli: async args => { w.calls.push(args); return { code: 0, stdout: '{}' }; },
    loopCode: async () => w.readings.length > 1 ? w.readings.shift()! : w.readings[0],
    // The transport is the injection seam: the simulated host has no recorded install arguments for
    // up to reach it with, so the dependency wires the host repair in directly and the repair's own
    // installer invocation runs the real installExecutorSupervision over the host's paths.
    alignExecutors: async (options = {}) => {
      const { alignHostExecutors } = await up();
      return alignHostExecutors(session as any, options.template ?? null);
    },
  };
}

const request = (): UpRequest => ({ repository: REPOSITORY, provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null, merger: 'control-plane' });

test('unit:up-host-executor-repair-real-installer — up repairs a host executor template that starts another Graphyard checkout by running the real installer, which rebinds it onto this CLI and keeps the declared fleet', async () => {
  // The layout the item is about: the host's executor template still starts graphyard-pilot's
  // executor script, an earlier Graphyard checkout, while it works in this repository's checkout.
  const layout = await hostLayout('graphyard-up-host-executor-repair', ({ repo, staleCheckout }) => executorUnitText(repo, staleCheckout));
  const recorded = { installer: [] as string[][], systemCtl: [] as string[][] };
  const session = hostSession(layout, recorded);
  const root = await resumedRoot('graphyard-up-host-executor-repair-root');
  const events: UpEvent[] = [];
  const w: UpWorld = { readings: [reading(layout, layout.staleCheckout), reading(layout, null)], calls: [] };
  const { runUp } = await up();
  const run = await runUp(request(), dependencies(root, events, w, session));

  assert.equal(run.exitCode, 0, run.next);
  // The real installer did the rewrite: one --install invocation, from this checkout's script, with
  // no --count (the host's saved declaration of three slots is kept, never shrunk by the repair).
  assert.equal(recorded.installer.length, 1, `the repair runs the installer exactly once: ${JSON.stringify(recorded.installer)}`);
  const installer = recorded.installer[0];
  assert.ok(installer.includes(THIS_CLI_SCRIPT), `the installer is this checkout's executor script: ${installer.join(' ')}`);
  assert.equal(installer.includes('--count'), false, 'a host with a saved declaration is never handed a count that could disable a slot');
  // The unit is rebound onto the CLI running this invocation and no longer names the stale checkout.
  const unit = await readFile(layout.unitFile, 'utf8');
  assert.match(unit, new RegExp(`^WorkingDirectory=${quote(layout.repo)}$`, 'm'), 'the unit still works in the repository checkout');
  assert.match(unit, new RegExp(`^ExecStart=\\S+ ${quote(THIS_CLI_SCRIPT)} --slot %i$`, 'm'), 'the rebound unit starts this checkout\'s executor script');
  assert.doesNotMatch(unit, new RegExp(quote(layout.staleCheckout)), 'the stale checkout is gone from the unit');
  // The real installer enabled the whole saved fleet and restarted the slots it rewrote.
  const enabled = recorded.systemCtl.find(args => args[0] === 'enable' && args[1] === '--now');
  assert.deepEqual(enabled?.slice(2), layout.slots, 'the declared three slots are enabled, not just one');
  const restarted = recorded.systemCtl.find(args => args[0] === 'restart');
  assert.deepEqual(restarted?.slice(1), layout.slots, 'every rewritten slot restarts onto this checkout');
  // And up reports the executors aligned, green only once a fresh reading judges them this code.
  const aligned = events.find(event => event.kind === 'note' && event.text.includes('the template now runs this checkout')) as { text: string } | undefined;
  assert.match(aligned?.text ?? '', new RegExp(quote(layout.staleCheckout)), 'the alignment note names what was replaced');
  for (const slot of layout.slots) assert.ok(aligned?.text.includes(slot), `the alignment note names ${slot}: ${aligned?.text}`);
  const replaced = events.find(event => event.kind === 'note' && event.text.startsWith('master-loop: replaced')) as { text: string } | undefined;
  assert.ok(replaced, 'the step reports the executor replacement, judged on a fresh reading');
  assert.ok(JSON.parse(await readFile(join(root, '.graphyard', 'up.json'), 'utf8')).completed.includes('master-loop'), 'the step is recorded done again');
  const declaration = JSON.parse(await readFile(join(layout.repo, '.graphyard', 'executors.json'), 'utf8'));
  assert.equal(declaration.count, 3, 'the host still declares its three slots');
});

test('unit:up-host-executor-foreign-refused — a unit whose launcher is not a Graphyard executor at all stays refused with ForeignUnitRefusal, and the alignment reports the refusal instead of rewriting', async () => {
  const { installExecutorSupervision } = await repositorySetup();
  // Directly through the real installer: the unit starts another program in another checkout's
  // tree — genuinely foreign — so the ownership assert refuses it and the unit stands untouched.
  const direct = await hostLayout('graphyard-up-host-executor-foreign-direct', () => 'placeholder');
  await writeFile(direct.unitFile, foreignUnitText(direct.foreignTree));
  const untouched = await readFile(direct.unitFile, 'utf8');
  const refusal = await installExecutorSupervision(direct.repo, { run: () => '', unitDirectory: direct.unitDirectory }).catch((error: any) => error);
  assert.equal(refusal?.name, 'ForeignUnitRefusal', `the installer refuses the foreign unit: ${refusal?.message}`);
  assert.match(refusal.message, new RegExp(quote(direct.foreignTree)), 'the refusal names the foreign checkout');
  assert.equal(await readFile(direct.unitFile, 'utf8'), untouched, 'a refused unit is never rewritten');

  // A unit working in the managed repository itself whose launcher is no Graphyard executor is no
  // executor slot of this install either: refused, never overwritten (review on #1279).
  const inRepository = foreignUnitText(direct.repo);
  await writeFile(direct.unitFile, inRepository);
  const inRepositoryRefusal = await installExecutorSupervision(direct.repo, { run: () => '', unitDirectory: direct.unitDirectory }).catch((error: any) => error);
  assert.equal(inRepositoryRefusal?.name, 'ForeignUnitRefusal', `a non-Graphyard launcher in the repository is refused: ${inRepositoryRefusal?.message}`);
  assert.match(inRepositoryRefusal.message, new RegExp(quote(`${direct.repo}/serve.js`)), 'the refusal names the program the unit starts');
  assert.equal(await readFile(direct.unitFile, 'utf8'), inRepository, 'the repository\'s own program unit is never rewritten');

  // A program working in the repository that merely takes an executor script path as an argument
  // starts no executor: only the script operand right after the interpreter counts (review on #1279).
  const argumentOnly = `[Unit]\nDescription=another program\n\n[Service]\nWorkingDirectory=${direct.repo}\nExecStart=/usr/bin/node ${direct.repo}/serve.js --worker ${direct.staleCheckout}/scripts/graphyard-executor.mjs\nRestart=always\n`;
  await writeFile(direct.unitFile, argumentOnly);
  const argumentRefusal = await installExecutorSupervision(direct.repo, { run: () => '', unitDirectory: direct.unitDirectory }).catch((error: any) => error);
  assert.equal(argumentRefusal?.name, 'ForeignUnitRefusal', `an executor path as a mere argument is refused: ${argumentRefusal?.message}`);
  assert.equal(await readFile(direct.unitFile, 'utf8'), argumentOnly, 'the program whose argument names an executor script is never rewritten');

  // A unit naming no WorkingDirectory whose launcher is another Graphyard checkout's executor is not
  // provably this install's, so it is refused rather than rebound (review thread on #1279).
  const unanchored = executorUnitText(direct.repo, direct.staleCheckout).replace(/^WorkingDirectory=.*\n/m, '');
  await writeFile(direct.unitFile, unanchored);
  const unanchoredRefusal = await installExecutorSupervision(direct.repo, { run: () => '', unitDirectory: direct.unitDirectory }).catch((error: any) => error);
  assert.equal(unanchoredRefusal?.name, 'ForeignUnitRefusal', `a unit with no WorkingDirectory is refused: ${unanchoredRefusal?.message}`);
  assert.match(unanchoredRefusal.message, new RegExp(quote(direct.staleCheckout)), 'the refusal names the checkout its launcher starts');
  assert.equal(await readFile(direct.unitFile, 'utf8'), unanchored, 'the unanchored unit is never rewritten');

  // The same layout through up: the repair runs the real installer, is refused, and the step fails
  // naming the refusal — never a silent rewrite of another program's unit.
  const layout = await hostLayout('graphyard-up-host-executor-foreign-up', ({ foreignTree }) => foreignUnitText(foreignTree));
  const recorded = { installer: [] as string[][], systemCtl: [] as string[][] };
  const session = hostSession(layout, recorded);
  const root = await resumedRoot('graphyard-up-host-executor-foreign-root');
  const events: UpEvent[] = [];
  const w: UpWorld = { readings: [reading(layout, layout.foreignTree)], calls: [] };
  const { runUp } = await up();
  const run = await runUp(request(), dependencies(root, events, w, session));
  assert.equal(run.exitCode, 1, run.next);
  assert.match(run.next, /could not be aligned/, 'the step fails on the alignment');
  assert.match(run.next, /runs another installation /, 'the refusal reaches the operator verbatim');
  assert.match(run.next, new RegExp(quote(layout.foreignTree)), 'naming the foreign checkout');
  assert.equal(recorded.installer.length, 1, 'the repair did run the real installer');
  assert.equal(await readFile(layout.unitFile, 'utf8'), foreignUnitText(layout.foreignTree), 'the genuinely foreign unit is untouched');
  assert.ok(!recorded.systemCtl.some(args => args[0] === 'restart'), 'no slot is restarted onto code the installer refused to write');
});

test('unit:up-host-executor-repair-declared-slots — after the real installer rebinds a stale launcher, only the slots the kept declaration names restart, never the slots it disabled', async () => {
  const { alignHostExecutors } = await up();
  for (const count of [0, 1]) {
    const layout = await hostLayout(`graphyard-up-host-executor-declared-${count}`, ({ repo, staleCheckout }) => executorUnitText(repo, staleCheckout), count);
    const recorded = { installer: [] as string[][], systemCtl: [] as string[][], host: [] as string[][] };
    const aligned = await alignHostExecutors(hostSession(layout, recorded) as any, TEMPLATE);
    const wanted = layout.slots.slice(0, count), excess = layout.slots.slice(count);
    assert.equal(aligned.reason, null, `declaration ${count}: ${aligned.reason}`);
    assert.equal(aligned.wrote, 'updated');
    const disabled = recorded.systemCtl.find(args => args[0] === 'disable' && args[1] === '--now');
    assert.deepEqual(disabled?.slice(2), excess, `declaration ${count}: the installer disables the slots above it`);
    assert.deepEqual(aligned.restarted, wanted, `declaration ${count}: only the declared slots are reported restarted`);
    const restarts = recorded.host.filter(args => args[1] === 'restart').flatMap(args => args.slice(2));
    for (const slot of excess) assert.ok(!restarts.includes(slot), `declaration ${count}: the disabled ${slot} is never restarted`);
    assert.deepEqual(restarts, wanted, `declaration ${count}: the host restarts exactly the declared slots`);
  }
});
