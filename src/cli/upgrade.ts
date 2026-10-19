// `graphyard upgrade` (GY-1962): one command moves the CLI checkout, the server, the loop and
// executors, and the managed repository's generated files to one dated release, in order.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createBackup } from '../backup.js';
import { Store } from '../store.js';
import { checkoutRelease, compareDateVersions, datedVersionPattern, imageRepository, installationRoot, stableChannel, type Release } from '../release.js';
import { repositoryFromRemote } from '../onboarding.js';
import { installDirectory, readInstallRecord, readToken, type InstallRecord } from '../install/secrets.js';
import { e2ePrincipalId } from '../install/secrets.js';
import { installIdFor } from '../install/types.js';
import { redeployArguments } from '../install/index.js';
import { defineCommands } from './registry.js';
import type { ChildRun } from '../child-runner.js';
import type { DeployPorts } from '../daemon/upgrade.js';
import { pinKnownGood } from '../master/known-good.js';
import { localReleaseVariables } from '../daemon/release-ports.js';
import { deployedE2e, e2eSuite } from '../e2e/runner.js';

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
  /** The Railway workspace the redeploy names, for an account that belongs to several (--workspace). */
  workspace: string | null;
  /** The image the redeploy names instead of the target's published one: a compose install's own build (GY-1982). */
  image?: string;
}
export interface UpgradePlan {
  from: Release; to: UpgradeTarget; databaseSchema: number | null; steps: UpgradeStep[]; rollback: string; cliChanges: string[];
  /** When the target migrates the database: what a failure at or after the redeploy names instead of the rollback, which the migrated database would refuse. */
  rollforward: string | null;
}

const cli = (root: string, ...args: string[]) => ['node', JSON.stringify(join(root, 'bin/graphyard.mjs')), ...args].join(' ');

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
  const install = inputs.install && redeployArguments(inputs.install, image, inputs.workspace, inputs.cliRoot);
  const redeploy = install ? `${cli(cliRoot, 'install', ...install.slice(0, -1), '--plan')} && ${cli(cliRoot, 'install', ...install)}` : `no install record for this repository: redeploy ${image} by hand`;
  const url = inputs.url ? ['--url', inputs.url] : [];
  const steps: UpgradeStep[] = [
    { id: 'checkout', title: `Check out ${target.version} (${target.revision.slice(0, 12)}) detached in the CLI checkout`, command: `git -C ${JSON.stringify(cliRoot)} checkout --detach ${target.revision}` },
    { id: 'npm-ci', title: 'Install the dependencies the target\'s lockfile names', command: `npm ci --prefix ${JSON.stringify(cliRoot)}` },
    { id: 'backup', title: `Back up the database at generation ${databaseSchema ?? 'unknown'} (DATABASE_URL) before the server migrates it`, command: `graphyard db backup ${inputs.backupFile}` },
    { id: 'redeploy', title: `Redeploy the server at ${image} through the install adapter`, command: redeploy },
    { id: 'restart', title: 'Restart the master loop and this host\'s executors on the target code', command: `${cli(cliRoot, 'master', 'restart')} && ${cli(cliRoot, 'master', 'executors', 'restart', '--all')}` },
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

/** The dated release `--to` names (default stable), from the CLI checkout's fetched tags. */
export function resolveTarget(cliRoot: string, to: string): UpgradeTarget {
  if (to !== stableChannel && !datedVersionPattern.test(to)) throw new Error(`Use upgrade --to VERSION (a dated release such as 2026.10.17) or --to ${stableChannel}`);
  let revision: string;
  try { revision = git(cliRoot, 'rev-parse', '--verify', '--quiet', `refs/tags/${to}^{commit}`); }
  catch { throw new Error(`The CLI checkout has no ${to} tag; run git -C ${JSON.stringify(cliRoot)} fetch --tags origin (upgrade without --plan fetches them)`); }
  const version = to === stableChannel ? checkoutReleaseAt(cliRoot, revision) : to;
  let source = '';
  try { source = git(cliRoot, 'show', `${revision}:src/release.ts`); } catch {}
  return { version, revision, schema: schemaAt(source) };
}
const checkoutReleaseAt = (cliRoot: string, revision: string) => {
  const tags = git(cliRoot, 'tag', '--points-at', revision).split('\n').filter(tag => datedVersionPattern.test(tag));
  if (!tags.length) throw new Error(`The ${stableChannel} tag names ${revision.slice(0, 12)}, which carries no dated release`);
  return tags.sort(compareDateVersions).at(-1)!;
};

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
 * GY-1982: the ports the loop's continuous deploy runs a commit through on this install, the checkout
 * already moved onto it: the upgrade sequence's npm ci, backup (with DATABASE_URL) and redeploy as
 * child processes, the health step until it passes or three minutes pass, and every end-to-end case;
 * or the one line naming why an install on neither compose nor local has none. `keepAlive` feeds the
 * loop's watchdog while a step runs. The end-to-end cases run as the install's e2e identity
 * (GY-2167), the roster principal whose credential may do what the cases do — a case's first step
 * creates an item — never as the loop's own coordinator, which may create none.
 */
export async function deployPorts(input: { cliRoot: string; repoRoot: string; repository: string; url: string; run: ChildRun; keepAlive?: () => Promise<void> }): Promise<DeployPorts | string> {
  const { cliRoot, repoRoot, url } = input, directory = installDirectory(installIdFor(input.repository));
  const install = await readInstallRecord(directory).catch(() => null);
  if (install?.provider !== 'compose' && install?.provider !== 'local') return `continuous deploy needs a compose or local install; ${install ? `this one runs on ${install.provider}` : 'no install record names this repository'}, so releases reach it only through graphyard upgrade`;
  const run = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise.resolve(input.run(command, args, { cwd, timeoutMs: 1_800_000, ...(env ? { env } : {}) }));
  const beating = async <T>(work: () => Promise<T>) => {
    const timer = input.keepAlive ? setInterval(() => void input.keepAlive!().catch(() => {}), 30_000) : null;
    try { return await work(); } finally { if (timer) clearInterval(timer); }
  };
  const inputsFor = (commit: string): UpgradeInputs => {
    const current = checkoutRelease(cliRoot);
    return { cliRoot, repoRoot, current, target: { version: current.version, revision: commit, schema: null }, databaseSchema: null, install, url, workspace: null, cliChanges: [],
      image: install.deployment?.image ?? `graphyard-local:${install.installId}`, backupFile: join(directory, 'backups', `before-${commit.slice(0, 12)}-${Date.now()}.json`) };
  };
  return {
    deploy: commit => beating(async () => {
      const inputs = inputsFor(commit), effects = liveEffects(inputs, join(repoRoot, '.graphyard', 'upgrade.json'));
      // Every redeploy builds with the stamp of the commit it deploys (GY-2167), the rollback's
      // included: /healthz then names that commit instead of an unstamped `unreleased unknown`.
      const stamp = releaseOfCommit(cliRoot, commit), environment = { ...process.env, GRAPHYARD_VERSION: stamp.version, GRAPHYARD_BUILD_REVISION: stamp.revision };
      for (const step of upgradePlan(inputs).steps) {
        if (step.id === 'backup' && process.env.DATABASE_URL) await effects.run(step);
        else if (step.id === 'npm-ci' || step.id === 'redeploy') await run('sh', ['-c', step.command], step.id === 'npm-ci' ? cliRoot : repoRoot, environment);
      }
    }),
    health: () => beating(async () => {
      const version = checkoutRelease(cliRoot).version;
      for (let attempt = 1; ; attempt++) {
        try { return await healthVerdict(await fetch(`${url}/healthz?strict`, { signal: AbortSignal.timeout(10_000) }), version); }
        catch (error) { if (attempt >= 36) throw error; await new Promise(done => setTimeout(done, 5_000)); }
      }
    }),
    e2e: () => beating(async () => {
      // GY-2217: the loop reads its own environment for the UAT the cases' release-candidate outcomes need: an install whose merger is the control plane but whose environment names no UAT (GRAPHYARD_UAT_URL or a static site's GRAPHYARD_UAT_STATIC) can never serve them, so those cases run as pending instead of failing every deploy.
      const uat = !!(process.env[localReleaseVariables.uatUrl] || process.env[localReleaseVariables.uatStatic]);
      await deployedE2e(cliRoot, url, await readToken(directory, e2ePrincipalId(install.installId)), e2eSuite, { uat });
    }),
    schemas: async commit => ({ target: schemaAt(await run('git', ['show', `${commit}:src/release.ts`], cliRoot).catch(() => '')), database: await databaseSchemaOf(url) }),
    pin: commit => pinKnownGood({ installDir: directory, repository: repoRoot }, commit, input.run),
  };
}

export const renderPlan = (plan: UpgradePlan) => [`upgrade ${plan.from.version} -> ${plan.to.version} (schema ${plan.to.schema ?? 'unknown'}; database ${plan.databaseSchema ?? 'unknown'})`,
  ...(plan.cliChanges.length ? [`refused until the CLI checkout is clean: ${plan.cliChanges.join(', ')}`] : []), ...plan.steps.map((step, index) => `${index + 1}. ${step.id.padEnd(8)} ${step.title}\n   ${step.command}`), `rollback: ${plan.rollback}`, ...(plan.rollforward ? [`from the redeploy on: ${plan.rollforward}`] : [])].join('\n');

export const upgradeCommands = defineCommands([{
  name: 'upgrade',
  help: [
    '  upgrade [--to VERSION|stable] [--workspace NAME] [--plan]',
    '                                Move the CLI checkout (then npm ci), back up the database,',
    '                                redeploy the server, restart loop and executors, refresh the',
    '                                generated files, and check /healthz, to one dated release;',
    '                                --plan prints the steps only; a failure names its step and rollback',
  ],
  async run(context) {
    const flags = [context.id, ...context.args].filter((arg): arg is string => !!arg);
    const toIndex = flags.indexOf('--to');
    const to = toIndex >= 0 ? flags[toIndex + 1] ?? '' : stableChannel;
    const workspaceIndex = flags.indexOf('--workspace');
    const workspace = workspaceIndex >= 0 ? flags[workspaceIndex + 1] ?? '' : null;
    if (workspace === '') throw new Error('Use upgrade --workspace NAME-OR-ID (railway whoami --json lists them)');
    const cliRoot = installationRoot, repoRoot = context.repositoryRoot();
    if (!flags.includes('--plan')) git(cliRoot, 'fetch', '--tags', '--force', 'origin');
    const repository = repositoryFromRemote(git(repoRoot, 'remote', 'get-url', 'origin'));
    const directory = repository ? installDirectory(installIdFor(repository)) : null;
    const url = process.env.GRAPHYARD_URL || context.connection?.url ? context.base : null;
    const current = checkoutRelease(cliRoot);
    const target = resolveTarget(cliRoot, to);
    const inputs: UpgradeInputs = { cliRoot, repoRoot, current, target, cliChanges: cliChangesOf(cliRoot), workspace, databaseSchema: await databaseSchemaOf(url), url,
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
