// `graphyard upgrade` (GY-1962): one command moves the CLI checkout, the server, the loop and
// executors, and the managed repository's generated files to one dated release, in order.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createBackup } from '../backup.js';
import { Store } from '../store.js';
import { checkoutRelease, compareDateVersions, datedVersionPattern, graphyardBaseBranch, imageRepository, installationRoot, type Release } from '../release.js';
import { repositoryFromRemote } from '../onboarding.js';
import { installDirectory, readInstallRecord, type InstallRecord } from '../install/secrets.js';
import { installIdFor } from '../install/types.js';
import { redeployArguments } from '../install/index.js';
import { defineCommands } from './registry.js';
import type { ChildRun } from '../child-runner.js';
import { deployRecordPath, watchMain, type DeployWatchPorts } from '../deploy-watch.js';
import { caseDirectory, loadCases } from '../e2e/case.js';
import { runCases } from '../e2e/runner.js';
import { parseServeDeclaration, readServeRecord, serveBaselineCheckoutPath, serveCheckoutPath, serveRecordPath, watchServe, type ServeCheck, type ServeDeclaration, type ServeRecord, type ServePorts } from '../serve-app.js';
import { defaultChildRun } from '../child-runner.js';
import { loadMasterConfig } from '../master.js';
import { knownGoodState, pinKnownGood } from '../master/known-good.js';

export type UpgradeStepId = 'checkout' | 'npm-ci' | 'backup' | 'redeploy' | 'restart' | 'refresh' | 'health';
export interface UpgradeStep { id: UpgradeStepId; title: string; command: string }
export interface UpgradeTarget { version: string; revision: string; schema: number | null }
export interface UpgradeInputs {
  cliRoot: string; repoRoot: string; current: Release; target: UpgradeTarget;
  /** The generation the database is migrated to, or null when it could not be read. */
  databaseSchema: number | null;
  install: InstallRecord | null; url: string | null; backupFile: string;
  /** Tracked files modified in the CLI checkout: checkout keeps them, so the target would run mixed source. */
  cliChanges: string[];
  /** The image the redeploy names instead of the target's published one: a compose install's own build (GY-1982). */
  image?: string;
}
export interface UpgradePlan {
  from: Release; to: UpgradeTarget; databaseSchema: number | null; steps: UpgradeStep[]; rollback: string; cliChanges: string[];
  /** When the target migrates the database: what a failure at or after the redeploy names instead of the rollback, which the migrated database would refuse. */
  rollforward: string | null;
}

const cli = (root: string, ...args: string[]) => ['node', JSON.stringify(join(root, 'bin/graphyard.mjs')), ...args].join(' ');
const npmCiCommand = (root: string) => `npm ci --prefix ${JSON.stringify(root)}`;
/** The command that returns to `previous`: the same upgrade towards its release, or its commit when it had none. */
export const rollbackCommand = (previous: Release, cliRoot: string) => previous.released
  ? `graphyard upgrade --to ${previous.version}`
  : `git -C ${JSON.stringify(cliRoot)} checkout --detach ${previous.revision} && npm ci --prefix ${JSON.stringify(cliRoot)}, then redeploy the image the server ran before`;

/**
 * The ordered steps from the current release to the target, acting on nothing. A target whose
 * schema generation is older than the database's is refused: its code would refuse that database.
 * npm ci follows the checkout move, so the code every later step runs has its own dependencies.
 */
export function upgradePlan(inputs: UpgradeInputs): UpgradePlan {
  const { cliRoot, target, databaseSchema } = inputs;
  if (target.schema !== null && databaseSchema !== null && target.schema < databaseSchema)
    throw new Error(`Refusing ${target.version}: its schema generation ${target.schema} is older than the database's (${databaseSchema}); that release would refuse this database. Upgrade to a release at generation ${databaseSchema} or newer`);
  const image = inputs.image ?? `${imageRepository}:${target.version}`;
  // The install preview runs first, so the redeploy prints what it changes before it applies it.
  // GY-2168: the redeploy builds the image from this checkout — the one the checkout step moved to
  // the target (or deployTip moved to the deployed commit) — never from whatever root the running
  // CLI's own code was loaded from, which a held pin may hold at another commit.
  const install = inputs.install && redeployArguments(inputs.install, image, inputs.cliRoot);
  const redeploy = install ? `${cli(cliRoot, 'install', ...install.slice(0, -1), '--plan')} && ${cli(cliRoot, 'install', ...install)}` : `no install record for this repository: redeploy ${image} by hand`;
  const url = inputs.url ? ['--url', inputs.url] : [];
  const steps: UpgradeStep[] = [
    { id: 'checkout', title: `Check out ${target.version} (${target.revision.slice(0, 12)}) detached in the CLI checkout`, command: `git -C ${JSON.stringify(cliRoot)} checkout --detach ${target.revision}` },
    { id: 'npm-ci', title: 'Install the dependencies the target\'s lockfile names', command: npmCiCommand(cliRoot) },
    { id: 'backup', title: `Back up the database at generation ${databaseSchema ?? 'unknown'} (DATABASE_URL) before the server migrates it`, command: `graphyard db backup ${inputs.backupFile}` },
    { id: 'redeploy', title: `Redeploy the server at ${image} through the install adapter`, command: redeploy },
    { id: 'restart', title: 'Restart the master loop on the target code', command: cli(cliRoot, 'master', 'restart') },
    { id: 'refresh', title: 'Refresh the generated workflows and the AGENTS.md managed block', command: `${cli(cliRoot, 'init', '--scan', ...url)} && ${cli(cliRoot, 'init', '--scan', '--apply', ...url)}` },
    { id: 'health', title: `Check that /healthz answers healthy at ${target.version}`, command: `GET ${inputs.url ?? 'GRAPHYARD_URL'}/healthz` },
  ];
  const migrates = target.schema !== null && databaseSchema !== null && target.schema > databaseSchema;
  return { from: inputs.current, to: target, databaseSchema, steps, rollback: rollbackCommand(inputs.current, cliRoot), cliChanges: inputs.cliChanges,
    rollforward: migrates ? `the server migrates the database from generation ${databaseSchema} to ${target.schema} when it redeploys, and ${inputs.current.version} refuses it after that: fix the failing step and rerun graphyard upgrade --to ${target.version}, or restore ${inputs.backupFile} with graphyard db restore into an empty database migrated by ${inputs.current.version} before rolling back` : null };
}

export interface UpgradeEffects {
  /** Record the release being left, before any step changes anything. */
  record(entry: { previous: Release; target: UpgradeTarget; rollback: string }): Promise<void>;
  run(step: UpgradeStep): Promise<void>;
}
export type UpgradeResult = { ok: true; steps: UpgradeStepId[] } | { ok: false; steps: UpgradeStepId[]; failed: UpgradeStepId; error: string; rollback: string };
const migratedFrom: UpgradeStepId[] = ['redeploy', 'restart', 'refresh', 'health'];

/** Run the plan's steps in order, stopping at the first that fails with its name and the rollback command. */
export async function runUpgrade(plan: UpgradePlan, effects: UpgradeEffects): Promise<UpgradeResult> {
  if (plan.databaseSchema === null) throw new Error('Refusing to upgrade: the database\'s schema generation could not be read (set DATABASE_URL or GRAPHYARD_URL), so a downgrade across a generation cannot be ruled out');
  if (plan.cliChanges.length) throw new Error(`Refusing to upgrade: the CLI checkout has modified tracked files (${plan.cliChanges.join(', ')}), which checkout would carry into the target release; commit or discard them first. Nothing was changed`);
  await effects.record({ previous: plan.from, target: plan.to, rollback: plan.rollback });
  const done: UpgradeStepId[] = [];
  for (const step of plan.steps) {
    try { await effects.run(step); } catch (error: any) {
      return { ok: false, steps: done, failed: step.id, error: String(error?.message ?? error), rollback: plan.rollforward && migratedFrom.includes(step.id) ? plan.rollforward : plan.rollback };
    }
    done.push(step.id);
  }
  return { ok: true, steps: done };
}

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(run.stderr || run.stdout).trim()}`);
  return run.stdout.trim();
};

/** Tracked files with uncommitted changes in the CLI checkout. */
export const cliChangesOf = (cliRoot: string) => git(cliRoot, 'diff', '--name-only', 'HEAD').split('\n').filter(Boolean);

/** The schema generation a revision's code expects, read from its release.ts; null when it names none. */
export function schemaAt(source: string): number | null {
  const lineage = /schemaGenerations:[^=]*=\s*\[([\s\S]*?)\];/.exec(source);
  if (lineage) return (lineage[1].match(/null|'sha256:[0-9a-f]+'/g) ?? []).length - 1;
  const fixed = /export const schemaVersion\s*=\s*(\d+)/.exec(source);
  return fixed ? Number(fixed[1]) : null;
}

/** The dated release `--to` names, or without one Graphyard's fetched origin/main tip, from the CLI checkout's refs. */
export function resolveTarget(cliRoot: string, to?: string): UpgradeTarget {
  if (to !== undefined && !datedVersionPattern.test(to)) throw new Error('Use upgrade --to VERSION (a dated release such as 2026.10.17), or no --to for Graphyard\'s main');
  const ref = to === undefined ? `refs/remotes/origin/${graphyardBaseBranch}` : `refs/tags/${to}`;
  let revision: string;
  try { revision = git(cliRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`); }
  catch { throw new Error(`The CLI checkout has no ${ref}; run git -C ${JSON.stringify(cliRoot)} fetch --tags origin ${graphyardBaseBranch} (upgrade without --plan fetches it)`); }
  const version = to ?? releaseOfCommit(cliRoot, revision).version;
  let source = '';
  try { source = git(cliRoot, 'show', `${revision}:src/release.ts`); } catch {}
  return { version, revision, schema: schemaAt(source) };
}

async function databaseSchemaOf(url: string | null): Promise<number | null> {
  if (process.env.DATABASE_URL) { const store = new Store(process.env.DATABASE_URL); try { return await store.schema(); } finally { await store.close(); } }
  if (!url) return null;
  try { const body = await (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5_000) })).json() as { schema?: unknown }; return typeof body.schema === 'number' ? body.schema : null; }
  catch { return null; }
}

/**
 * The stamp the deployed commit's image builds with (GY-2167): the dated tag on it, else
 * `unreleased <short>` — named explicitly for the build, so the tree's untracked files or a git
 * read that fails under a loaded machine cannot leave the image unstamped.
 */
const releaseOfCommit = (cliRoot: string, commit: string): { version: string; revision: string } => {
  let tags = '';
  try { tags = git(cliRoot, 'tag', '--points-at', commit); } catch {}
  const version = tags.split('\n').filter(tag => datedVersionPattern.test(tag)).sort(compareDateVersions).at(-1);
  return { version: version ?? `unreleased ${commit.slice(0, 12)}`, revision: commit };
};

/** The real effect of each step; the backup runs on the code already loaded, the release that matches the database. */
export function liveEffects(inputs: UpgradeInputs, recordFile: string, fetchHealth: (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'json'>> = url => fetch(url, { signal: AbortSignal.timeout(10_000) })): UpgradeEffects {
  const shell = (command: string, cwd: string) => {
    const run = spawnSync(command, { cwd, shell: true, stdio: 'inherit' });
    if (run.status !== 0) throw new Error(`\`${command}\` exited ${run.status ?? run.signal}`);
  };
  return {
    async record(entry) { await mkdir(resolve(recordFile, '..'), { recursive: true }); await writeFile(recordFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry }, null, 2)}\n`); },
    async run(step) {
      if (step.id === 'backup') {
        if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the Graphyard database so the upgrade can back it up before the server migrates it');
        const store = new Store(process.env.DATABASE_URL);
        try { const backup = await createBackup(store.pool); await mkdir(resolve(inputs.backupFile, '..'), { recursive: true }); await writeFile(inputs.backupFile, JSON.stringify(backup), { flag: 'wx', mode: 0o600 }); }
        finally { await store.close(); }
      } else if (step.id === 'health') {
        if (!inputs.url) throw new Error('Set GRAPHYARD_URL so the upgrade can read /healthz');
        await healthVerdict(await fetchHealth(`${inputs.url}/healthz?strict`), inputs.target.version);
      } else if (step.id === 'redeploy' && !inputs.install) throw new Error(step.command);
      else shell(step.command, step.id === 'checkout' || step.id === 'npm-ci' ? inputs.cliRoot : inputs.repoRoot);
    },
  };
}

/** The health step passes only on a successful answer whose verdict is healthy at the target version. */
export async function healthVerdict(response: Pick<Response, 'ok' | 'status' | 'json'>, version: string) {
  if (!response.ok) throw new Error(`/healthz answered HTTP ${response.status}`);
  const body = await response.json() as { ok?: unknown; healthy?: unknown; version?: unknown; causes?: unknown };
  if (body.ok !== true || body.healthy !== true) throw new Error(`/healthz reports the server unhealthy${Array.isArray(body.causes) && body.causes.length ? `: ${body.causes.join('; ')}` : ''}`);
  if (body.version !== version) throw new Error(`/healthz reports ${String(body.version)}, not ${version}`);
}

/**
 * The git half of the deploy unit's ports: fetch Graphyard's own main (GY-2982) — never the managed
 * repository's base branch, which Graphyard's origin may not have — read HEAD, check a commit out detached.
 */
export function gitWatchPorts(cliRoot: string, run: ChildRun): Pick<DeployWatchPorts, 'fetch' | 'head' | 'checkout'> {
  const git = async (...args: string[]) => String(await run('git', ['-C', cliRoot, ...args])).trim();
  return {
    fetch: async () => { await git('fetch', '--quiet', 'origin', graphyardBaseBranch); return git('rev-parse', `refs/remotes/origin/${graphyardBaseBranch}`); },
    head: () => git('rev-parse', 'HEAD'),
    checkout: async commit => { await git('checkout', '--detach', '--quiet', commit); },
  };
}

/**
 * The deploy's health step (GY-2942): /healthz?strict until it answers healthy at the release the
 * deployed commit's image was stamped with — never the checkout's HEAD, which another install's
 * deploy or a person may have moved — or the attempts run out.
 */
export const deployHealth = (cliRoot: string, url: string, attempts = 36, pauseMs = 5_000) => async (commit: string) => {
  const { version } = releaseOfCommit(cliRoot, commit);
  for (let attempt = 1; ; attempt++) {
    try { return await healthVerdict(await fetch(`${url}/healthz?strict`, { signal: AbortSignal.timeout(10_000) }), version); }
    catch (error) { if (attempt >= attempts) throw error; await new Promise(done => setTimeout(done, pauseMs)); }
  }
};

/** The install's own deploy checkout (GY-2942): a detached worktree of the launcher's checkout, with its own HEAD, added the first time the watch runs. */
export async function ensureDeployCheckout(checkout: string, source: string, run: ChildRun) {
  if (existsSync(join(checkout, '.git'))) return;
  await mkdir(resolve(checkout, '..'), { recursive: true });
  await run('git', ['-C', source, 'worktree', 'add', '--detach', '--quiet', checkout, 'HEAD']);
}

/** How long an install or build step of the declared serve may run. */
const serveInstallTimeoutMs = 1_800_000;

/** The kernel start time of the process named `pid`, or null when none runs under it (or /proc is absent, off Linux). */
const startedAt = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 1).trim().split(' ')[19] ?? null;
  } catch { return null; }
};

/** Whether a tracked serve process still runs: a pid recorded before a reboot may name another process now, and a kill must never reach one of those. Linux answers by the kernel start time recorded beside the pid — a reused pid never matches; without /proc the pid is trusted. */
const tracksLiveProcess = (tracked: { pid?: number | null; started?: string | null }) => {
  if (!tracked.pid) return false;
  if (!existsSync('/proc')) return true;
  return startedAt(tracked.pid) === (tracked.started ?? null);
};

/** Stops the tracked process group, waiting for it to be gone, as the serve and the baseline serve are stopped before a replacement starts. */
async function stopTrackedServe(tracked: { pid?: number | null; started?: string | null }) {
  if (!tracked.pid || !tracksLiveProcess(tracked)) return;
  // The serve runs detached as its own process group, so the signal reaches the wrapper and
  // the children it left holding the port, not the wrapper alone.
  try { process.kill(-tracked.pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let wait = 0; wait < 20; wait++) {
    try { process.kill(-tracked.pid, 0); } catch { return; }
    await new Promise(accept => setTimeout(accept, 100));
  }
  try { process.kill(-tracked.pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** The ports the deploy unit's serve pass (GY-2976) runs against the managed repository's main: git in the install's own checkout (whose remote-tracking ref master status reads too), npm ci and the declared build in its serve checkout, and the declared serve command spawned detached. */
export function managedServePorts(input: { root: string; baseBranch: string; run: ChildRun }): ServePorts {
  const checkout = serveCheckoutPath(input.root);
  const baselineCheckout = serveBaselineCheckoutPath(input.root);
  const ref = `refs/remotes/origin/${input.baseBranch}`;
  const gitIn = (at: string) => async (...args: string[]) => String(await input.run('git', ['-C', at, ...args], { timeoutMs: 120_000 })).trim();
  const git = gitIn(checkout), baselineGit = gitIn(baselineCheckout);
  const rootGit = async (...args: string[]) => String(await input.run('git', ['-C', input.root, ...args], { timeoutMs: 120_000 })).trim();
  const ensureCheckout = async () => {
    if (existsSync(join(checkout, '.git'))) return;
    await mkdir(resolve(checkout, '..'), { recursive: true });
    await rootGit('worktree', 'add', '--detach', '--quiet', checkout, 'HEAD');
  };
  const npmIn = async (at: string) => {
    // npm ci needs a lockfile; a repository without one installs. A repository with no package.json builds without npm.
    if (!existsSync(join(at, 'package.json'))) return;
    const locked = existsSync(join(at, 'package-lock.json'));
    await input.run('npm', [locked ? 'ci' : 'install', '--no-audit', '--no-fund'], { cwd: at, timeoutMs: serveInstallTimeoutMs });
  };
  const buildIn = (at: string) => async (declaration: ServeDeclaration) => {
    const [command, ...args] = declaration.build;
    await input.run(command!, args, { cwd: at, timeoutMs: serveInstallTimeoutMs });
  };
  return {
    // The fetch lands in the managed root — the serve checkout is its worktree and shares its refs —
    // so declaration() reads the root's remote-tracking ref before any serve checkout exists: a
    // repository that declares no serve.json never gets one created (or fetched into).
    fetch: async () => {
      await rootGit('fetch', '--quiet', 'origin', input.baseBranch);
      return rootGit('rev-parse', ref);
    },
    declaration: async () => {
      const shown = await rootGit('show', `${ref}:.graphyard/serve.json`).catch(() => null);
      return shown === null ? null : parseServeDeclaration(shown);
    },
    checkout: async commit => { await ensureCheckout(); await git('checkout', '--detach', '--quiet', commit); },
    install: () => npmIn(checkout),
    build: buildIn(checkout),
    restart: async serve => {
      await stopTrackedServe(readServeRecord(serveRecordPath(input.root)) ?? {});
      const [command, ...args] = serve;
      const child = spawn(command!, args, { cwd: checkout, detached: true, stdio: 'ignore' });
      // A serve command that cannot start (ENOENT) must not crash the watch; the pass records it as a serve that never answered.
      child.on('error', () => {});
      child.unref();
      const pid = child.pid ?? null;
      return { pid, started: pid ? startedAt(pid) : null };
    },
    // GY-2985: what was live keeps serving on the port beside the declared one, in its own
    // baseline checkout, so a compare case judges a new build against what users had. The declared
    // serve command serves there with the declared port rewritten to the baseline's — the port the
    // declaration names is the one a serve command is given, by convention in its arguments.
    baseline: async (commit, declaration) => {
      if (existsSync(join(baselineCheckout, '.git'))) await baselineGit('checkout', '--detach', '--quiet', commit);
      else {
        await mkdir(resolve(baselineCheckout, '..'), { recursive: true });
        await rootGit('worktree', 'add', '--detach', '--quiet', baselineCheckout, commit);
      }
      await npmIn(baselineCheckout);
      await buildIn(baselineCheckout)(declaration);
      await stopTrackedServe(readServeRecord(serveRecordPath(input.root))?.baseline ?? {});
      const [command, ...args] = declaration.serve;
      const child = spawn(command!, args.map(argument => argument === String(declaration.port) ? String(declaration.port + 1) : argument), { cwd: baselineCheckout, detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      const pid = child.pid ?? null;
      return { pid, started: pid ? startedAt(pid) : null };
    },
    // The served commit is live-verified (GY-2983): the required cases the served commit itself
    // declares under e2e/cases/ run against the URL it serves, in its own serve checkout, and the
    // pass records the verdict for that exact commit. No cases, nothing to fail. A malformed case
    // file refuses the whole read and the pass records nothing, so a broken case directory reads
    // as not yet run rather than as a verdict no case earned. The cases' bearer token is
    // GRAPHYARD_TOKEN; a case that needs the install's own credentials declares secrets, which the
    // runner resolves from the install's e2e-secrets env as in every other run.
    check: async (url, baselineUrl) => {
      const cases = existsSync(join(checkout, caseDirectory)) ? await loadCases(checkout) : [];
      const required = cases.filter(entry => entry.definition.required);
      if (!required.length) return { verified: true, case: null, step: null, reason: null };
      const report = await runCases(required, { url, token: process.env.GRAPHYARD_TOKEN ?? '', root: checkout, baselineUrl: baselineUrl ?? undefined });
      const failing = report.cases.find(outcome => outcome.verdict === 'failed' || outcome.verdict === 'flaky');
      return failing
        ? { verified: false, case: failing.id, step: failing.failingStep ? `step ${failing.failingStep.index + 1} ${failing.failingStep.name}` : null, reason: failing.failingStep?.reason ?? null }
        : { verified: true, case: null, step: null, reason: null };
    },
  };
}

/**
 * The deploy's build checkout (GY-2978): a detached worktree of the watched checkout holding the commit a pass builds and
 * restarts, so the watched checkout — the workers' CLI checkout when the unit watches it — does not move until health passes.
 */
export async function ensureBuildCheckout(build: string, source: string, commit: string, run: ChildRun) {
  if (existsSync(join(build, '.git'))) { await run('git', ['-C', build, 'checkout', '--detach', '--quiet', commit]); return; }
  await mkdir(resolve(build, '..'), { recursive: true });
  await run('git', ['-C', source, 'worktree', 'prune']);
  await run('git', ['-C', source, 'worktree', 'add', '--detach', '--quiet', build, commit]);
}

/**
 * The repository the deploy watch serves (GY-2955): its checkout's origin's owner/name, null when it
 * names none. The deploy record keeps it, so a control-plane upgrade installed for one repository
 * cannot pass for another repository's deployment.
 */
export const servedRepository = (cliRoot: string): string | null => {
  try { return repositoryFromRemote(git(cliRoot, 'remote', 'get-url', 'origin')); } catch { return null; }
};

/**
 * Removes every per-commit image `graphyard-local:<sha12>` (or the older `previous-<sha12>`) but the kept
 * commits', one `docker image rm` each; docker refuses one a container uses, and each failure is one
 * logged line, never the deploy's.
 */
export async function pruneImages(run: ChildRun, keep: string[], log: (line: string) => void = line => console.error(line)) {
  const kept = new Set(keep.map(sha => sha.slice(0, 12)));
  const failed = (what: string) => (error: unknown) => log(`[graphyard-deploy] ${what}: ${error instanceof Error ? error.message : String(error)}`);
  const tags = await Promise.resolve(run('docker', ['image', 'ls', 'graphyard-local', '--format', '{{.Tag}}'])).then(String, failed('could not list the per-commit images'));
  for (const tag of (tags ?? '').split('\n').map(line => line.trim())) {
    const sha = /^(?:previous-)?([0-9a-f]{12})$/.exec(tag)?.[1];
    if (sha && !kept.has(sha)) await Promise.resolve(run('docker', ['image', 'rm', `graphyard-local:${tag}`])).catch(failed(`could not remove graphyard-local:${tag}`));
  }
}

/**
 * The ports `upgrade --watch` (graphyard-deploy.service) runs each base tip through on a compose or
 * local install: git in the CLI checkout, npm ci and the install adapter's redeploy (with a database
 * backup when DATABASE_URL is set) in the install's own build worktree, /healthz until it passes or
 * three minutes pass, then the watched checkout moved and npm-ci'd onto the tip (GY-2978: a worker
 * CLI's checkout, when the unit watches it, moves only once the server serves the same commit), the
 * coordinator pin advanced when one exists, and older per-commit images pruned; or the line naming
 * why an install on another provider has none.
 */
export async function watchPorts(input: { cliRoot: string; repoRoot: string; repository: string; url: string; run: ChildRun; herdrInstance?: boolean }): Promise<DeployWatchPorts | string> {
  const { cliRoot, repoRoot, url } = input, directory = installDirectory(installIdFor(input.repository));
  const recorded = await readInstallRecord(directory).catch(() => null);
  // GY-2941: an installation whose own Herdr instance master.json names redeploys with --herdr-instance, though its record predates the field.
  const install = recorded && input.herdrInstance ? { ...recorded, herdrInstance: true } : recorded;
  if (install?.provider !== 'compose' && install?.provider !== 'local') return `the deploy unit needs a compose or local install; ${install ? `this one runs on ${install.provider}` : 'no install record names this repository'}, so releases reach it only through graphyard upgrade`;
  const run = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise.resolve(input.run(command, args, { cwd, timeoutMs: 1_800_000, ...(env ? { env } : {}) })).then(String);
  // GY-2978: the pass builds and redeploys from this worktree at the deployed commit — for a local
  // install the redeploying CLI and the server it starts are this worktree's code — never from the
  // watched checkout, whose HEAD stays on the last commit the server served until health passes.
  const build = join(directory, 'deploy', 'build');
  const inputsFor = (commit: string): UpgradeInputs => {
    const current = checkoutRelease(cliRoot);
    return { cliRoot: build, repoRoot, current, target: { version: releaseOfCommit(cliRoot, commit).version, revision: commit, schema: null }, databaseSchema: null, install, url, cliChanges: [],
      image: install.provider === 'compose' ? `graphyard-local:${commit.slice(0, 12)}` : install.deployment?.image ?? `graphyard-local:${install.installId}`, backupFile: join(directory, 'backups', `before-${commit.slice(0, 12)}-${Date.now()}.json`) };
  };
  const step = (commit: string, id: UpgradeStepId) => upgradePlan(inputsFor(commit)).steps.find(entry => entry.id === id)!;
  const tree = gitWatchPorts(cliRoot, input.run);
  return {
    ...tree,
    build: async commit => {
      await ensureBuildCheckout(build, cliRoot, commit, input.run);
      await run('sh', ['-c', step(commit, 'npm-ci').command], build);
    },
    restart: async commit => {
      const inputs = inputsFor(commit);
      if (process.env.DATABASE_URL) await liveEffects(inputs, join(repoRoot, '.graphyard', 'upgrade.json')).run(step(commit, 'backup'));
      // Every redeploy builds with the stamp of the commit it deploys (GY-2167), so /healthz names that commit.
      const stamp = releaseOfCommit(cliRoot, commit);
      await run('sh', ['-c', step(commit, 'redeploy').command], repoRoot, { ...process.env, GRAPHYARD_VERSION: stamp.version, GRAPHYARD_BUILD_REVISION: stamp.revision });
    },
    checkout: async commit => { await tree.checkout(commit); await run('sh', ['-c', npmCiCommand(cliRoot)], cliRoot); },
    health: deployHealth(cliRoot, url),
    prune: keep => pruneImages(input.run, keep),
    pin: async commit => { if (knownGoodState(directory)) await pinKnownGood({ installDir: directory, repository: repoRoot }, commit, input.run); },
    schema: async commit => { try { return schemaAt(git(cliRoot, 'show', `${commit}:src/release.ts`)); } catch { return null; } },
    database: () => databaseSchemaOf(url),
  };
}

export const renderPlan = (plan: UpgradePlan) => [`upgrade ${plan.from.version} -> ${plan.to.version} (schema ${plan.to.schema ?? 'unknown'}; database ${plan.databaseSchema ?? 'unknown'})`,
  ...(plan.cliChanges.length ? [`refused until the CLI checkout is clean: ${plan.cliChanges.join(', ')}`] : []), ...plan.steps.map((step, index) => `${index + 1}. ${step.id.padEnd(8)} ${step.title}\n   ${step.command}`), `rollback: ${plan.rollback}`, ...(plan.rollforward ? [`from the redeploy on: ${plan.rollforward}`] : [])].join('\n');

export const upgradeCommands = defineCommands([{
  name: 'upgrade',
  help: [
    '  upgrade [--to VERSION] [--plan]',
    '                                Move the CLI checkout (then npm ci), back up the database,',
    '                                redeploy the server, restart loop and executors, refresh the',
    '                                generated files, and check /healthz, to Graphyard\'s main tip',
    '                                (or the dated release VERSION);',
    '                                --plan prints the steps only; a failure names its step and rollback',
    '  upgrade --watch [--once] [--checkout DIR]',
    '                                The deploy unit (graphyard-deploy.service): fetch origin and, for',
    '                                each new base tip, build, restart, check /healthz, and roll back',
    '                                to the previous tip on failure; DIR is the install\'s own checkout',
  ],
  async run(context) {
    const flags = [context.id, ...context.args].filter((arg): arg is string => !!arg);
    if (flags.includes('--watch')) {
      const repoRoot = context.repositoryRoot(), master = await loadMasterConfig(repoRoot);
      // GY-2942: the unit names the install's own checkout; one without it deploys from the launcher's.
      const checkoutIndex = flags.indexOf('--checkout'), cliRoot = checkoutIndex >= 0 ? resolve(flags[checkoutIndex + 1] ?? '') : installationRoot;
      if (cliRoot !== installationRoot) await ensureDeployCheckout(cliRoot, installationRoot, defaultChildRun);
      const ports = await watchPorts({ cliRoot, repoRoot, repository: master.repository, url: master.url, run: defaultChildRun, herdrInstance: !!master.herdrInstance });
      if (typeof ports === 'string') throw new Error(ports);
      const stopping = new AbortController();
      for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => stopping.abort());
      // The managed repository's own serving (GY-2976): a main that declares .graphyard/serve.json is
      // checked out into the install's own serve checkout, built and served by the same unit's pass;
      // a repository that declares nothing gives the serve pass nothing to do.
      const intervalMs = master.run.intervalSeconds * 1000, once = flags.includes('--once');
      return Promise.all([
        watchMain(deployRecordPath(repoRoot), ports, { intervalMs, once, signal: stopping.signal, repository: servedRepository(cliRoot) }),
        watchServe(serveRecordPath(repoRoot), managedServePorts({ root: repoRoot, baseBranch: master.baseBranch, run: defaultChildRun }), { intervalMs, once, signal: stopping.signal }),
      ]).then(() => undefined);
    }
    const toIndex = flags.indexOf('--to');
    const to = toIndex >= 0 ? flags[toIndex + 1] ?? '' : undefined;
    const cliRoot = installationRoot, repoRoot = context.repositoryRoot();
    if (!flags.includes('--plan')) git(cliRoot, 'fetch', '--tags', '--force', 'origin', graphyardBaseBranch);
    const repository = repositoryFromRemote(git(repoRoot, 'remote', 'get-url', 'origin'));
    const directory = repository ? installDirectory(installIdFor(repository)) : null;
    const url = process.env.GRAPHYARD_URL || context.connection?.url ? context.base : null;
    const current = checkoutRelease(cliRoot);
    const target = resolveTarget(cliRoot, to);
    const inputs: UpgradeInputs = { cliRoot, repoRoot, current, target, cliChanges: cliChangesOf(cliRoot), databaseSchema: await databaseSchemaOf(url), url,
      install: directory ? await readInstallRecord(directory) : null,
      backupFile: join(directory ?? join(repoRoot, '.graphyard'), 'backups', `before-${target.version}-${Date.now()}.json`) };
    const plan = upgradePlan(inputs);
    console.log(renderPlan(plan));
    if (flags.includes('--plan')) return;
    // Every precondition a later step needs is checked before the record and the checkout move.
    if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the Graphyard database so the upgrade can back it up before the server migrates it; nothing was changed');
    if (!url) throw new Error('Set GRAPHYARD_URL so the upgrade can read /healthz after the redeploy; nothing was changed');
    const result = await runUpgrade(plan, liveEffects(inputs, join(repoRoot, '.graphyard', 'upgrade.json')));
    if (result.ok) { console.log(`upgraded to ${target.version}`); return; }
    process.exitCode = 1;
    console.error(`upgrade stopped at ${result.failed}: ${result.error}\nrollback: ${result.rollback}`);
  },
}]);
