import { access, lstat, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { availableRuntimes, describeMergeGate, discover } from '../onboarding.js';
import { deliveryModes, type DeliveryMode } from '../model/delivery-policy.js';
import { startGithubSetup, updateAppPermissions } from '../github-setup.js';
import { applyProposal, loadAppliedSetup, loadProposal, readDocumentationConfig, readSetupStatus, repositoryScanDifference, saveProposal, scanProposal, setupDrift, setupRepository } from '../repository-setup.js';
import { protectionPlan, protectionRun, readProtection, type ProtectionRun } from '../protection.js';
import { applyInstall, buildPlan, prepareInstall, providers, type InstallInputs } from '../install/index.js';
import { runManifestFlow } from '../install/manifest.js';
import { delegationLimitAssignments } from '../install/limits.js';
import { ciProducerProvisioningSteps, readRoster, registerCiProducer } from '../install/ci-proofs.js';
import { completionProfiles, readinessChecklist, summarizeDefinitions, type CompletionProfile } from '../readiness.js';
import { defineCommands } from './registry.js';
import { readSecretFromStdin } from './context.js';
import { documentationDrift } from '../model/documentation.js';
import { agentEnvironmentRoot, checkAgentEnvironment, discoverAgentEnvironments } from '../master/environments.js';
import type { AgentEnvironment } from '../master/profiles.js';
import { sharedGitPaths, workerPaths } from '../worker-sandbox.js';

/**
 * The prerequisites docs/setup-from-zero.md depends on that `graphyard doctor` can check from this
 * machine (GY-1352). Each is a named pass/fail line naming the checklist step that fixes it, so an
 * agent setting Graphyard up from nothing reads the next step off doctor's output instead of guessing.
 */
export const setupSteps = {
  install: 'docs/setup-from-zero.md step 3 (install the control plane)',
  app: 'docs/setup-from-zero.md step 4 (register the GitHub App)',
  reviewer: 'docs/setup-from-zero.md step 5 (reviewer and revert-approver Apps)',
  protection: 'docs/setup-from-zero.md step 7 (branch protection)',
  environments: 'docs/setup-from-zero.md step 8 (agent environments)',
  sandbox: 'docs/setup-from-zero.md step 9 (worker sandbox)',
} as const;

export interface SetupCheck { id: string; status: 'pass' | 'fail'; detail: string; step: string }

export interface SetupFromZeroInput {
  /** The managed repository's checkout doctor runs in. */
  root: string;
  env?: NodeJS.ProcessEnv;
  /** The server's GET /api/status answer, or null with the failure when it did not answer. */
  status: any | null;
  failure?: string;
  /** Where the agent environments live (`~/.coding_agents` unless GRAPHYARD_AGENT_ENVIRONMENTS). */
  environments: string;
  /** `gh` for the branch-protection read; tests pass a fixture. */
  github?: ProtectionRun;
  /** Probes that the worker confinement can write PATHS; null when it can, else the reason. */
  sandbox?: (paths: string[]) => string | null;
}

const writable = async (path: string) => { try { await access(path, constants.W_OK); return true; } catch { return false; } };
const readJson = async (file: string) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
/** A config file the launcher must rewrite (folder trust) is writable, or absent from a writable home. */
const rewritable = async (file: string) => { try { await stat(file); return writable(file); } catch { return writable(dirname(file)); } };

/** Bubblewrap's own probe, as the worker confinement runs it, with PATHS bound writable. */
export function bubblewrapProbe(paths: string[]): string | null {
  const binds = paths.flatMap(path => ['--bind', path, path]);
  try {
    execFileSync('bwrap', ['--ro-bind', '/', '/', ...binds, '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--share-net', '--die-with-parent', '--', 'sh', '-c', paths.map(path => `test -w '${path.replace(/'/g, `'\\''`)}'`).join(' && ')], { stdio: 'ignore', timeout: 20_000 });
    return null;
  } catch (error: any) { return error.code === 'ENOENT' ? 'bubblewrap (bwrap) is not installed' : `bwrap could not write them: ${error.message.split('\n')[0]}`; }
}

async function credentialsCheck(root: string, env: NodeJS.ProcessEnv): Promise<SetupCheck> {
  const named = env.GRAPHYARD_TOKEN_FILE ? resolve(env.GRAPHYARD_TOKEN_FILE) : null;
  const file = named ?? resolve(root, '.graphyard/connection.json');
  const check = (status: SetupCheck['status'], detail: string): SetupCheck => ({ id: 'credentials-file', status, detail, step: setupSteps.install });
  let info;
  try { info = await lstat(file); } catch {
    return check('fail', named ? `GRAPHYARD_TOKEN_FILE ${file} does not exist` : env.GRAPHYARD_TOKEN ? 'the credential is only in GRAPHYARD_TOKEN; no credentials file holds it' : `${file} does not exist and GRAPHYARD_TOKEN_FILE is unset`);
  }
  if (!info.isFile()) return check('fail', `${file} is not a regular file`);
  if (info.mode & 0o077) return check('fail', `${file} has mode 0${(info.mode & 0o777).toString(8)}; it must be 0600`);
  if (!named && !(await readJson(file))?.token) return check('fail', `${file} holds no credential; store one with init --url SERVER --token-stdin`);
  return check('pass', `${file} is present with mode 0600`);
}

async function environmentChecks(directory: string): Promise<SetupCheck[]> {
  let found: AgentEnvironment[];
  try { found = await discoverAgentEnvironments(directory); } catch (error: any) { return [{ id: 'agent-environments', status: 'fail', detail: `${directory} is unreadable: ${error.message}`, step: setupSteps.environments }]; }
  if (!found.length) return [{ id: 'agent-environments', status: 'fail', detail: `no agent environment (claude-a, codex-a, ...) under ${directory}`, step: setupSteps.environments }];
  return Promise.all(found.map(async environment => {
    const gaps: string[] = [];
    const health = await checkAgentEnvironment(environment, { quota: false, cacheMs: 0 });
    if (!health.loggedIn) gaps.push('not logged in');
    if (environment.kind === 'claude') {
      if ((await readJson(resolve(environment.home, 'settings.json')))?.skipDangerousModePermissionPrompt !== true) gaps.push('the bypass-permissions consent is not recorded (settings.json skipDangerousModePermissionPrompt)');
      if ((await readJson(resolve(environment.home, '.claude.json')))?.hasCompletedOnboarding !== true) gaps.push('first-run onboarding is not complete (.claude.json hasCompletedOnboarding)');
      if (!(await rewritable(resolve(environment.home, '.claude.json')))) gaps.push('.claude.json is not writable, so folder trust cannot be recorded at launch');
    }
    if (environment.kind === 'codex' && !(await rewritable(resolve(environment.home, 'config.toml')))) gaps.push('config.toml is not writable, so folder trust cannot be recorded at launch');
    return { id: `agent-environment:${environment.name}`, status: gaps.length ? 'fail' : 'pass', step: setupSteps.environments,
      detail: gaps.length ? `${environment.kind} at ${environment.home}: ${gaps.join('; ')}` : `${environment.kind} at ${environment.home} is logged in and past its first-run prompts` } satisfies SetupCheck;
  }));
}

async function sandboxCheck(root: string, probe: (paths: string[]) => string | null): Promise<SetupCheck> {
  const check = (status: SetupCheck['status'], detail: string): SetupCheck => ({ id: 'worker-sandbox', status, detail, step: setupSteps.sandbox });
  const paths = workerPaths(root);
  if (!paths.commonDir) return check('fail', `${root} is not a Git checkout`);
  const shared = sharedGitPaths(paths.commonDir);
  const existing = (await Promise.all(shared.map(async path => (await stat(path).then(entry => entry.isDirectory(), () => false)) ? path : null))).filter((path): path is string => !!path);
  const unwritable = (await Promise.all(existing.map(async path => (await writable(path)) ? null : path))).filter(Boolean);
  if (unwritable.length) return check('fail', `this user cannot write ${unwritable.join(', ')}`);
  const refused = probe(existing);
  return refused ? check('fail', `the worker confinement cannot write the shared Git paths: ${refused}`) : check('pass', `the worker confinement writes ${existing.length} shared Git paths under ${paths.commonDir}`);
}

/**
 * The reviewer App is bound either on the server (GRAPHYARD_REVIEWER_APPS, for agent review
 * policies) or to the master (`master reviewer setup`/`bind`, recorded in .graphyard/master.json
 * with its 0600 credential outside the repository); either is a separate identity that can review.
 */
async function reviewerCheck(root: string, status: any): Promise<SetupCheck> {
  const check = (pass: boolean, detail: string): SetupCheck => ({ id: 'reviewer-app', status: pass ? 'pass' : 'fail', detail, step: setupSteps.reviewer });
  const served = Array.isArray(status?.reviewerApps) ? status.reviewerApps : [];
  if (served.length) return check(true, `GRAPHYARD_REVIEWER_APPS names ${served.map((app: any) => `${app.id} (App ${app.appId})`).join(', ')}`);
  const bound = (await readJson(resolve(root, '.graphyard/master.json')))?.reviewer;
  if (!bound?.credentialFile) return check(false, 'no reviewer App: GRAPHYARD_REVIEWER_APPS is empty and .graphyard/master.json binds no reviewer');
  const info = await lstat(bound.credentialFile).catch(() => null);
  if (!info?.isFile()) return check(false, `the bound reviewer App ${bound.slug ?? bound.appId}'s credential ${bound.credentialFile} is missing`);
  if (info.mode & 0o077) return check(false, `the bound reviewer App's credential ${bound.credentialFile} has mode 0${(info.mode & 0o777).toString(8)}; it must be 0600`);
  return check(true, `reviewer App ${bound.slug ?? ''} (App ${bound.appId}) is bound to the master`);
}

function protectionCheck(status: any, github: ProtectionRun): SetupCheck {
  const check = (pass: boolean, detail: string): SetupCheck => ({ id: 'branch-protection', status: pass ? 'pass' : 'fail', detail, step: setupSteps.protection });
  const repository = status?.githubRepository?.fullName ?? status?.githubRepository, baseBranch = status?.baseBranch ?? 'main', githubAppId = status?.githubAppId;
  if (!repository || !githubAppId) return check(false, 'depends on the GitHub App: the server reports no bound App');
  let current;
  try { current = readProtection({ repository, baseBranch }, github); } catch (error: any) { return check(false, `${repository} ${baseBranch} protection is unreadable (none, or gh is not a repository admin): ${String(error.message).split('\n')[0]}`); }
  const plan = protectionPlan(current, { repository, baseBranch, githubAppId }, [], undefined, []);
  const gaps = [...plan.blockers, ...(plan.landableCheck ? [] : ['graphyard/landable is not a required check'])];
  return check(!gaps.length, gaps.length ? gaps.join('; ') : `${baseBranch} requires Graphyard / merge and graphyard/landable from App ${githubAppId}`);
}

/** One printable line per check: `PASS id: detail`, or `FAIL id: detail (fix: step)`. */
export const setupLine = (check: SetupCheck) => check.status === 'pass' ? `PASS ${check.id}: ${check.detail}` : `FAIL ${check.id}: ${check.detail} (fix: ${check.step})`;

/** Every setup-from-zero line for this machine and installation, in checklist order. */
export async function setupFromZeroChecks(input: SetupFromZeroInput): Promise<SetupCheck[]> {
  const env = input.env ?? process.env, status = input.status;
  const lines: SetupCheck[] = [];
  lines.push({ id: 'control-plane', status: status ? 'pass' : 'fail', step: setupSteps.install, detail: status ? `answered as role ${status.actor?.role ?? 'unknown'}` : `not reachable: ${input.failure ?? 'no answer'}` });
  lines.push(await credentialsCheck(input.root, env));
  const missing = status?.appPermissions?.missing ?? [];
  const appBound = !!status?.github, verified = !!status?.appPermissions?.verifiedAt;
  lines.push({ id: 'github-app', status: appBound && verified && !missing.length ? 'pass' : 'fail', step: setupSteps.app,
    detail: !status ? 'depends on the control plane' : !appBound ? 'the server reports no bound GitHub App' : !verified ? 'the App-permission preflight has not run' : missing.length ? `missing permissions: ${missing.map((entry: any) => `${entry.permission} ${entry.required}`).join(', ')}` : `App ${status.githubAppId} is bound with every permission the plan needs` });
  lines.push(await reviewerCheck(input.root, status));
  lines.push(status ? protectionCheck(status, input.github ?? protectionRun) : { id: 'branch-protection', status: 'fail', detail: 'depends on the control plane', step: setupSteps.protection });
  lines.push(...await environmentChecks(input.environments));
  lines.push(await sandboxCheck(input.root, input.sandbox ?? bubblewrapProbe));
  return lines;
}

const interactiveGithubSetup = (root: string) => async (repository: string, deployment: string) => {
  const setup = await startGithubSetup(root, repository, deployment);
  console.log(`Open ${setup.url} in your browser. On SSH, forward port 4311 to this machine first. Credentials stay in .graphyard/github-app.json; do not share that file. Setup finishes automatically once the App is installed; press Ctrl+C to finish later and rerun init --scan --apply.`);
  for (;;) {
    await new Promise(accept => setTimeout(accept, 1000));
    try {
      const app = JSON.parse(await readFile(resolve(root, '.graphyard/github-app.json'), 'utf8'));
      if (Number.isSafeInteger(app.appId) && app.appId > 0 && typeof app.slug === 'string' && app.slug && Number.isSafeInteger(app.installationId) && app.installationId > 0) {
        await new Promise<void>(accept => setup.http.close(() => accept()));
        return { appId: app.appId, slug: app.slug };
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
};

/**
 * The capacity variables that accompany the principals `init --apply` registers: derived from
 * the roster in .graphyard/principals.json, and — when the operator credential reaches the
 * server — compared with what the deployment runs with, so a re-run after the roster grew
 * reports the deployed value that no longer covers it beside the value to set.
 */
export async function capacityForPrincipals(principalsFile: string, status: () => Promise<any>) {
  const registry = JSON.parse(await readFile(principalsFile, 'utf8'));
  let deployed: Record<string, string | null> | null = null, error: string | null = null;
  try {
    const live = await status();
    deployed = live?.delegationLimits?.deployed ?? null;
    if (!deployed) error = 'the server reports no delegationLimits; deploy main first, then rerun init --scan --apply to compare';
  } catch (failure: any) { error = `the server could not be read (${failure.message})`; }
  const limits = delegationLimitAssignments(registry.principals, deployed);
  return { variables: limits.variables, lines: limits.lines, drift: limits.drift,
    next: `Set ${limits.lines.join(' ')} beside GRAPHYARD_PRINCIPALS on the Graphyard deployment${limits.drift.length ? ` (drift: ${limits.drift.map(entry => entry.reason).join(' ')})` : error ? `; no drift can be reported because ${error}` : ''}` };
}

/** Repository onboarding: install a control plane, propose and apply the delivery workflow, register Apps, inspect readiness. */
export const installCommands = defineCommands([
  {
    name: 'install',
    help: [
      '  install --provider railway|hetzner|docker-host|compose --repo OWNER/NAME',
      '          [--plan|--apply] [--domain HOST] [--workers N] [--reviewer NAME]',
      '          [--producer-proof PROOF] [--ssh-host HOST] [--ssh-user USER]',
      '          [--ssh-key NAME] [--port N] [--workspace NAME-OR-ID] [--image REF]',
      '          [--create-environments]',
      '                                Install or reconcile a complete control plane.',
      '  install --target host|hetzner --repo OWNER/NAME [--plan|--apply]',
      '          [--ssh-host HOST | --local] [--migrate] [--max-monthly N | --confirm-price X]',
      '          [--github-app FILE]',
      '                                Self-contained host: server, Postgres, loop, executors,',
      '                                Herdr and agent runtimes on one machine (hetzner creates it',
      '                                and needs its monthly price confirmed). --migrate moves an',
      '                                installation there from GRAPHYARD_MIGRATE_DATABASE_URL.',
      '                                An App already saved for the repository (--github-app,',
      '                                or .graphyard/github-app.json) is reused: no browser step.',
      '                                --plan prints every action with secrets redacted and',
      '                                changes nothing; --apply executes the same plan. UAT and',
      '                                production resources that cost money are created only with',
      '                                --create-environments.',
      '                                See docs/install.md for the agent-executable runbook.',
    ],
    // The installer creates the connection file; it must never read a stale one.
    readsConnection: () => false,
    async run(context) {
      const { values } = parseArgs({ args: context.rest, options: {
        provider: { type: 'string' }, repo: { type: 'string' }, plan: { type: 'boolean' }, apply: { type: 'boolean' },
        domain: { type: 'string' }, workers: { type: 'string' }, reviewer: { type: 'string' }, image: { type: 'string' },
        'producer-proof': { type: 'string', multiple: true }, 'base-branch': { type: 'string' }, 'review-policy': { type: 'string' },
        'required-check': { type: 'string', multiple: true }, 'review-count': { type: 'string' },
        'ssh-host': { type: 'string' }, 'ssh-user': { type: 'string' }, 'ssh-key': { type: 'string' }, 'server-name': { type: 'string' }, workspace: { type: 'string' },
        'server-type': { type: 'string' }, location: { type: 'string' }, port: { type: 'string' }, logs: { type: 'boolean' },
        target: { type: 'string' }, local: { type: 'boolean' }, migrate: { type: 'boolean' }, 'max-monthly': { type: 'string' }, 'confirm-price': { type: 'string' },
        'github-app': { type: 'string' },
        'create-environments': { type: 'boolean' },
      }, allowPositionals: false });
      if (!values.repo) throw new Error('Use --repo OWNER/NAME');
      // --target names a self-contained install (GY-717): an existing machine, or a Hetzner server it creates.
      if (values.target && values.provider) throw new Error('Use either --target host|hetzner (a self-contained host) or --provider (a server-only install)');
      if (values.target && !['host', 'hetzner'].includes(values.target)) throw new Error('Use --target host (an existing Linux machine) or --target hetzner (a server the installer creates)');
      const provider = values.target ?? values.provider;
      if (!provider || !providers.includes(provider as any)) throw new Error(`Use --provider ${providers.join('|')}, or --target host|hetzner`);
      const money = (flag: string, value: string) => { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${flag} takes an amount such as 19.52`); return parsed; };
      if (values.plan && values.apply) throw new Error('Choose either --plan or --apply');
      const reviewPolicy = values['review-policy'];
      if (reviewPolicy && !['github', 'agent'].includes(reviewPolicy)) throw new Error('Use --review-policy github or agent');
      // A count that silently became NaN would install a control plane with no worker principal
      // or an unusable port, so a non-numeric value stops the command instead.
      const count = (flag: string, value: string) => { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${flag} takes a whole number`); return parsed; };
      const inputs: InstallInputs = { repository: values.repo, provider: provider as InstallInputs['provider'],
        ...(values.target || provider === 'host' ? { selfContained: true } : {}),
        ...(values.local ? { local: true } : {}), ...(values.migrate ? { migrate: true } : {}),
        ...(values['max-monthly'] ? { maxMonthly: money('max-monthly', values['max-monthly']) } : {}),
        ...(values['confirm-price'] ? { confirmPrice: money('confirm-price', values['confirm-price']) } : {}),
        ...(values['github-app'] ? { githubAppFile: values['github-app'] } : {}),
        ...(values['base-branch'] ? { baseBranch: values['base-branch'] } : {}),
        ...(values.domain ? { domain: values.domain } : {}), ...(values.workers ? { workers: count('workers', values.workers) } : {}),
        ...(values.port ? { port: count('port', values.port) } : {}),
        ...(values.reviewer ? { reviewer: values.reviewer } : {}), ...(values.image ? { image: values.image } : {}),
        ...(values['producer-proof']?.length ? { producerProofs: values['producer-proof'] } : {}),
        ...(reviewPolicy ? { reviewPolicy: reviewPolicy as 'github' | 'agent' } : {}),
        ...(values['required-check']?.length ? { requiredChecks: values['required-check'] } : {}),
        ...(values['review-count'] ? { reviewCount: count('review-count', values['review-count']) } : {}),
        ...(values['ssh-host'] ? { sshHost: values['ssh-host'] } : {}), ...(values['ssh-user'] ? { sshUser: values['ssh-user'] } : {}),
        ...(values['ssh-key'] ? { sshKey: values['ssh-key'] } : {}),
        ...(values['server-name'] ? { serverName: values['server-name'] } : {}), ...(values.workspace ? { workspace: values.workspace } : {}),
        ...(values['server-type'] ? { serverType: values['server-type'] } : {}), ...(values.location ? { location: values.location } : {}),
        ...(values['create-environments'] ? { createEnvironments: true } : {}) };
      const session = await prepareInstall(process.cwd(), inputs, {
        cliPath: await context.activeCliPath(), hostId: context.individualHostId(), log: line => console.error(line),
        githubApp: request => runManifestFlow(request.root, request.repository, request.origin, { reviewer: request.reviewer, announce: line => console.error(line), dependencies: { file: request.file } }),
      }, values.apply ? 'apply' : 'plan');
      if (values.logs) return console.log(await session.adapter.logs(session.context));
      const plan = await buildPlan(session);
      if (!values.apply) return context.print(plan);
      return context.print(await applyInstall(session, plan));
    },
  },
  {
    name: 'init',
    help: [
      '  init [--scan] [--apply] [--url URL] [--herdr] [--token-stdin]',
      '       [--delivery release-candidate|per-pr] [--candidate-cron CRON|off]',
      '                                Scan and propose the delivery workflow (--scan), or apply the reviewed proposal (--apply);',
      '                                the scan shows the merge-gate split (pre-merge vs per-candidate checks) before anything is applied',
    ],
    async run(context) {
      const { base, connection, print } = context;
      const root = context.repositoryRoot();
      const { values } = parseArgs({ args: context.rest, options: { url: { type: 'string' }, herdr: { type: 'boolean' }, 'token-stdin': { type: 'boolean' }, 'host-id': { type: 'string' }, 'cli-path': { type: 'string' }, scan: { type: 'boolean' }, apply: { type: 'boolean' },
        delivery: { type: 'string' }, 'candidate-cron': { type: 'string' } }, allowPositionals: false });
      if (values.delivery !== undefined && !(deliveryModes as readonly string[]).includes(values.delivery)) throw new Error(`Use --delivery ${deliveryModes.join(' or ')}`);
      if ((values.delivery !== undefined || values['candidate-cron'] !== undefined) && !values.scan) throw new Error('--delivery and --candidate-cron choose the proposal; pass them with init --scan');
      const cron = values['candidate-cron'];
      const choices = { ...(values.delivery ? { mode: values.delivery as DeliveryMode } : {}), ...(cron !== undefined ? { candidateSchedule: cron === 'off' ? null : cron } : {}) };
      if (values.scan || values.apply) {
        if (values.herdr || values['token-stdin']) throw new Error('--scan/--apply propose and apply the delivery workflow; run them as the operator before any worker credential setup');
        const stored = values.apply ? await loadProposal(root) : null;
        // Applying rescans with the choices the operator reviewed, so a confirmed opt-out or cadence
        // is compared with the checkout rather than read back as a difference.
        const reviewed = stored?.proposal.delivery ? { mode: stored.proposal.delivery.mode, candidateSchedule: stored.proposal.delivery.candidateSchedule } : undefined;
        const fresh = await scanProposal(root, { url: values.url ?? null, runtimes: availableRuntimes(), delivery: values.apply ? { ...reviewed, ...choices } : choices });
        if (values.apply) {
          if (!stored) throw new Error('No stored setup proposal to apply. Run init --scan, review .graphyard/setup-proposal.json, then rerun with --apply');
          const differences = repositoryScanDifference(fresh, stored.proposal);
          if (differences.length) throw new Error(`${differences.join('; ')}. Rerun init --scan, review the refreshed proposal, then apply it again. The stored proposal was left unchanged.`);
          const url = values.url ?? stored.proposal.server;
          if (!url) throw new Error('Applying requires the Graphyard server URL; pass --url');
          // Apply rewrites the registry from the reviewed proposal; the CI producer's token is read
          // first so a re-run keeps the repository secret valid, then the entry is merged back in.
          const roster = await readRoster(resolve(root, '.graphyard/principals.json'));
          const result = await applyProposal(root, stored.proposal, { url, githubSetup: interactiveGithubSetup(root), github: protectionRun });
          const ciProofs = await registerCiProducer(result.principalsFile, roster);
          return print({ proposal: stored.file, ...result, ciProofs: { ...ciProofs, next: ciProducerProvisioningSteps(stored.proposal.repository, url) },
            capacity: await capacityForPrincipals(result.principalsFile, () => context.api('status')) });
        }
        await saveProposal(root, fresh);
        const applied = await loadAppliedSetup(root);
        return print({ proposalFile: '.graphyard/setup-proposal.json', proposal: fresh,
          mergeGate: fresh.delivery ? describeMergeGate(fresh.delivery) : [],
          applied: applied ? { at: applied.appliedAt, githubApp: applied.artifacts.githubApp } : null,
          drift: setupDrift(applied, fresh),
          appliedNothingElse: true,
          next: 'Review .graphyard/setup-proposal.json and the mergeGate split above (move a check by editing delivery.mergeGate in graphyard.json and rescanning, or opt out with --delivery per-pr), then rerun init --scan --apply --url SERVER_URL to apply the reviewed proposal' });
      }
      let workerToken = await context.individualToken();
      if (values['token-stdin']) {
        workerToken = await readSecretFromStdin(10000);
        if (!workerToken) throw new Error("--token-stdin requires a nonempty worker credential; setup has not changed local configuration");
      }
      if (workerToken !== undefined && !workerToken.trim()) throw new Error('Worker credential must be nonempty; setup has not changed local configuration');
      const selectedUrl = values.url ?? base;
      // Never silently send a saved credential to a newly selected server.
      if (values.url && connection && new URL(values.url).origin !== connection.url && !process.env.GRAPHYARD_TOKEN && !values['token-stdin']) workerToken = undefined;
      return print(await setupRepository(root, { url: selectedUrl, cliPath: resolve(values['cli-path'] ?? await context.activeCliPath()), hostId: values['host-id'] ?? context.individualHostId(), ...(workerToken ? { token: workerToken } : {}) }, { herdr: values.herdr }));
    },
  },
  {
    name: 'doctor',
    help: [
      '  doctor [--profile PROFILE]   Inspect local discovery, live integration readiness and the',
      '                                readiness checklist for a completion profile',
    ],
    async run(context) {
      const { base, api } = context;
      const root = context.repositoryRoot();
      const discovered = await discover(root);
      const { values } = parseArgs({ args: context.rest, options: { profile: { type: 'string' } }, allowPositionals: false });
      const profile = (values.profile ?? 'through-merge') as CompletionProfile;
      if (!completionProfiles.includes(profile)) throw new Error(`Unknown completion profile ${values.profile}; choose one of ${completionProfiles.join(', ')}`);
      let live: any = null, failure: string | undefined;
      try { live = await api('status'); } catch (error: any) { failure = error.message; }
      const setup = await readSetupStatus(root).catch((error: any) => ({ error: error.message }));
      const stored = await loadProposal(root).catch(() => null);
      const appPermissions = live?.appPermissions ?? null;
      // The committed documentation policy against the deployed one (GY-293): the control plane
      // reads only GRAPHYARD_DOCUMENTATION, so an unredeployed graphyard.json edit is drift.
      const committedDocumentation = await readDocumentationConfig(root).catch((error: any) => ({ error: error.message as string }));
      const documentation = committedDocumentation && 'error' in committedDocumentation ? { committed: null, deployed: live?.documentation ?? null, drift: null, error: committedDocumentation.error }
        : { committed: committedDocumentation, deployed: live?.documentation ?? null, drift: live?.documentation ? documentationDrift(committedDocumentation, live.documentation)?.attention ?? null : null };
      // Capacity drift and production lag are the two installation facts a deploy can break
      // silently; the server reports both and doctor repeats them beside the App preflight.
      const delegationLimits = live?.delegationLimits ?? null, production = live?.production ?? null;
      // Validation definitions are readable by operators and readers; every other credential
      // leaves the runner-path items `unknown` with the command that reads them.
      let definitions: { kind: string; id: string; revision: number; role?: string; enabled?: boolean }[] | null = null;
      if (live && ['admin', 'reader'].includes(live.actor?.role)) { try { definitions = (await api('validation/definitions')).definitions; } catch { definitions = null; } }
      const readiness = readinessChecklist(profile, {
        repository: discovered.repository ?? null,
        server: { url: base, reachable: !!live, role: live?.actor?.role, github: !!live?.github, githubPermissions: live?.githubPermissions ?? {}, appPermissions, mainGuard: live?.mainGuard ?? null, failure },
        setup: 'error' in setup ? { proposal: null, appliedAt: null, githubApp: null, drift: [], unreadable: [String(setup.error)] } : { ...setup, unreadable: setup.unreadable.filter((entry): entry is string => typeof entry === 'string') },
        proposal: stored?.proposal ?? null,
        validation: definitions ? summarizeDefinitions(definitions) : null,
      });
      // The machine-local prerequisites docs/setup-from-zero.md depends on (GY-1352), each naming its step.
      const checks = await setupFromZeroChecks({ root, status: live, failure, environments: agentEnvironmentRoot() });
      const setupFromZero = { ready: checks.every(check => check.status === 'pass'), lines: checks.map(setupLine) };
      // A ready checklist still deploys nothing: once every item is ready, capacity drift and
      // an undeployed merge are the next actions; until then the checklist's own gap comes first.
      const firstFailed = checks.find(check => check.status === 'fail');
      const next = firstFailed && !live ? setupLine(firstFailed)
        : !readiness.ready ? readiness.next
        : firstFailed ? setupLine(firstFailed)
        : delegationLimits?.drift?.length ? `Set ${delegationLimits.drift.map((entry: any) => `${entry.variable}=${entry.required}`).join(' ')} on the deployment: ${delegationLimits.drift[0].reason}`
        : documentation.drift ? documentation.drift
        : production?.incidents?.length ? `Production has not deployed ${production.incidents.map((incident: any) => incident.key).join(', ')}: ${production.incidents[0].reason}`
        : readiness.next;
      return context.print({ discovered, server: base, cliPath: await context.activeCliPath(), hostId: context.individualHostId(), connected: !!live, githubConfigured: !!live?.github, role: live?.actor?.role, release: live?.release ?? null, failure,
        setup,
        appPermissions: appPermissions ? { verifiedAt: appPermissions.verifiedAt, missing: appPermissions.missing, attention: appPermissions.attention, installationUrl: appPermissions.installationUrl } : null,
        heldJobs: live?.heldJobs ?? 0,
        mainGuard: live?.mainGuard ?? null,
        build: live?.build ?? null,
        delegationLimits: delegationLimits ? { limits: delegationLimits.limits, deployed: delegationLimits.deployed, drift: delegationLimits.drift, attention: delegationLimits.attention } : null,
        production: production ? { provider: production.provider, serving: production.serving, running: production.running, aheadBy: production.ahead?.by ?? null, incidents: production.incidents, attention: production.attention, error: production.error } : null,
        documentation,
        setupFromZero,
        readiness,
        next,
        limits: ['CI discovery is a proposal, not executed-test inventory', 'Herdr two-host recovery and GitHub refusal-to-acceptance must be demonstrated', 'A ready checklist is configuration, never evidence: the first real PR must visibly pass every gate'] });
    },
  },
  {
    name: 'github-setup',
    help: [
      '  github-setup HTTPS_URL [--reviewer NAME]',
      '                                Register the control-plane or a reviewer GitHub App',
      '                                through the local App-manifest browser flow',
      '  github-setup --update-permissions [--reviewer NAME] [--wait SECONDS]',
      '                                Compare a registered App with its declared permissions,',
      '                                print the exact migration steps, and verify acceptance',
    ],
    async run(context) {
      const root = context.repositoryRoot();
      const discovered = await discover(root);
      if (!discovered.repository) throw new Error('Set origin to the GitHub repository being managed first');
      const { values, positionals } = parseArgs({ args: [context.id, ...context.args].filter((value): value is string => value !== undefined), options: { reviewer: { type: 'string' }, 'update-permissions': { type: 'boolean' }, wait: { type: 'string' } }, allowPositionals: true });
      if (values['update-permissions']) {
        const waitSeconds = values.wait === undefined ? 0 : Number(values.wait);
        if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) throw new Error('Use --wait with whole seconds up to 3600');
        const result = await updateAppPermissions(root, { reviewer: values.reviewer, waitMs: waitSeconds * 1000 });
        context.print(result);
        if (!result.verified) process.exitCode = 1;
        return;
      }
      if (values.wait !== undefined) throw new Error('--wait only applies to --update-permissions');
      const deployment = positionals[0];
      if (!deployment || positionals.length > 1) throw new Error('Use github-setup HTTPS_URL to register an App, or github-setup --update-permissions to migrate a registered one');
      const setup = await startGithubSetup(root, discovered.repository, deployment, 4311, {}, values.reviewer);
      console.log(`Open ${setup.url} in your browser. On SSH, forward port 4311 to this machine first. Credentials stay in ${setup.file}; do not share that file. Press Ctrl+C when finished.`);
      const stop = () => setup.http.close(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    },
  },
]);
