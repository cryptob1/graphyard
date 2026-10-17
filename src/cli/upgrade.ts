// `graphyard upgrade` (GY-1962): one command moves the CLI checkout, the server, the loop and
// executors, and the managed repository's generated files to one dated release, in order.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createBackup } from '../backup.js';
import { Store } from '../store.js';
import { checkoutRelease, compareDateVersions, datedVersionPattern, imageRepository, installationRoot, stableChannel, type Release } from '../release.js';
import { repositoryFromRemote } from '../onboarding.js';
import { installDirectory, readInstallRecord, type InstallRecord } from '../install/secrets.js';
import { installIdFor } from '../install/types.js';
import { redeployArguments } from '../install/index.js';
import { defineCommands } from './registry.js';

export type UpgradeStepId = 'checkout' | 'npm-ci' | 'backup' | 'redeploy' | 'restart' | 'refresh' | 'health';
export interface UpgradeStep { id: UpgradeStepId; title: string; command: string }
export interface UpgradeTarget { version: string; revision: string; schema: number | null }
export interface UpgradeInputs {
  cliRoot: string; repoRoot: string; current: Release; target: UpgradeTarget;
  /** The generation the database is migrated to, or null when it could not be read. */
  databaseSchema: number | null;
  install: InstallRecord | null; url: string | null; backupFile: string;
}
export interface UpgradePlan { from: Release; to: UpgradeTarget; databaseSchema: number | null; steps: UpgradeStep[]; rollback: string }

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
  const image = `${imageRepository}:${target.version}`;
  const redeploy = inputs.install ? cli(cliRoot, 'install', ...redeployArguments(inputs.install, image)) : `no install record for this repository: redeploy ${image} by hand`;
  const steps: UpgradeStep[] = [
    { id: 'checkout', title: `Check out ${target.version} (${target.revision.slice(0, 12)}) detached in the CLI checkout`, command: `git -C ${JSON.stringify(cliRoot)} checkout --detach ${target.revision}` },
    { id: 'npm-ci', title: 'Install the dependencies the target\'s lockfile names', command: `npm ci --prefix ${JSON.stringify(cliRoot)}` },
    { id: 'backup', title: `Back up the database at generation ${databaseSchema ?? 'unknown'} (DATABASE_URL) before the server migrates it`, command: `graphyard db backup ${inputs.backupFile}` },
    { id: 'redeploy', title: `Redeploy the server at ${image} through the install adapter`, command: redeploy },
    { id: 'restart', title: 'Restart the master loop and this host\'s executors on the target code', command: `${cli(cliRoot, 'master', 'restart')} && ${cli(cliRoot, 'master', 'executors', 'restart', '--all')}` },
    { id: 'refresh', title: 'Refresh the generated workflows and the AGENTS.md managed block', command: cli(cliRoot, 'init', '--scan', '--apply', ...(inputs.url ? ['--url', inputs.url] : [])) },
    { id: 'health', title: `Check that /healthz reports ${target.version}`, command: `GET ${inputs.url ?? 'GRAPHYARD_URL'}/healthz` },
  ];
  return { from: inputs.current, to: target, databaseSchema, steps, rollback: rollbackCommand(inputs.current, cliRoot) };
}

export interface UpgradeEffects {
  /** Record the release being left, before any step changes anything. */
  record(entry: { previous: Release; target: UpgradeTarget; rollback: string }): Promise<void>;
  run(step: UpgradeStep): Promise<void>;
}
export type UpgradeResult = { ok: true; steps: UpgradeStepId[] } | { ok: false; steps: UpgradeStepId[]; failed: UpgradeStepId; error: string; rollback: string };

/** Run the plan's steps in order, stopping at the first that fails with its name and the rollback command. */
export async function runUpgrade(plan: UpgradePlan, effects: UpgradeEffects): Promise<UpgradeResult> {
  if (plan.databaseSchema === null) throw new Error('Refusing to upgrade: the database\'s schema generation could not be read (set DATABASE_URL or GRAPHYARD_URL), so a downgrade across a generation cannot be ruled out');
  await effects.record({ previous: plan.from, target: plan.to, rollback: plan.rollback });
  const done: UpgradeStepId[] = [];
  for (const step of plan.steps) {
    try { await effects.run(step); } catch (error: any) {
      return { ok: false, steps: done, failed: step.id, error: String(error?.message ?? error), rollback: plan.rollback };
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

/** The real effect of each step; the backup runs on the code already loaded, the release that matches the database. */
function liveEffects(inputs: UpgradeInputs, recordFile: string): UpgradeEffects {
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
        const body = await (await fetch(`${inputs.url}/healthz`, { signal: AbortSignal.timeout(10_000) })).json() as { version?: unknown };
        if (body.version !== inputs.target.version) throw new Error(`/healthz reports ${String(body.version)}, not ${inputs.target.version}`);
      } else if (step.id === 'redeploy' && !inputs.install) throw new Error(step.command);
      else shell(step.command, step.id === 'checkout' || step.id === 'npm-ci' ? inputs.cliRoot : inputs.repoRoot);
    },
  };
}

export const renderPlan = (plan: UpgradePlan) => [`upgrade ${plan.from.version} -> ${plan.to.version} (schema ${plan.to.schema ?? 'unknown'}; database ${plan.databaseSchema ?? 'unknown'})`,
  ...plan.steps.map((step, index) => `${index + 1}. ${step.id.padEnd(8)} ${step.title}\n   ${step.command}`), `rollback: ${plan.rollback}`].join('\n');

export const upgradeCommands = defineCommands([{
  name: 'upgrade',
  help: [
    '  upgrade [--to VERSION|stable] [--plan]',
    '                                Move the CLI checkout (then npm ci), back up the database,',
    '                                redeploy the server, restart loop and executors, refresh the',
    '                                generated files, and check /healthz, to one dated release;',
    '                                --plan prints the steps only; a failure names its step and rollback',
  ],
  async run(context) {
    const flags = [context.id, ...context.args].filter((arg): arg is string => !!arg);
    const toIndex = flags.indexOf('--to');
    const to = toIndex >= 0 ? flags[toIndex + 1] ?? '' : stableChannel;
    const cliRoot = installationRoot, repoRoot = context.repositoryRoot();
    if (!flags.includes('--plan')) git(cliRoot, 'fetch', '--tags', '--force', 'origin');
    const repository = repositoryFromRemote(git(repoRoot, 'remote', 'get-url', 'origin'));
    const directory = repository ? installDirectory(installIdFor(repository)) : null;
    const url = process.env.GRAPHYARD_URL || context.connection?.url ? context.base : null;
    const current = checkoutRelease(cliRoot);
    const target = resolveTarget(cliRoot, to);
    const inputs: UpgradeInputs = { cliRoot, repoRoot, current, target, databaseSchema: await databaseSchemaOf(url), url,
      install: directory ? await readInstallRecord(directory) : null,
      backupFile: join(directory ?? join(repoRoot, '.graphyard'), 'backups', `before-${target.version}-${Date.now()}.json`) };
    const plan = upgradePlan(inputs);
    console.log(renderPlan(plan));
    if (flags.includes('--plan')) return;
    const result = await runUpgrade(plan, liveEffects(inputs, join(repoRoot, '.graphyard', 'upgrade.json')));
    if (result.ok) { console.log(`upgraded to ${target.version}`); return; }
    process.exitCode = 1;
    console.error(`upgrade stopped at ${result.failed}: ${result.error}\nrollback: ${result.rollback}`);
  },
}]);
