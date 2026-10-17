import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { availableRuntimes, describeMergeGate, discover, installedOnboarding } from '../onboarding.js';
import { deliveryModes, type DeliveryMode } from '../model/delivery-policy.js';
import { appPageBusy, appPagePortFree, startGithubSetup, updateAppPermissions } from '../github-setup.js';
import { applyProposal, loadAppliedSetup, loadProposal, repositoryScanDifference, saveProposal, scanProposal, setupDrift, setupRepository } from '../repository-setup.js';
import { protectionRun } from '../protection.js';
import { acquireApplyLock, appCommand, applyInstall, applyRosterChange, appStepWait, buildPlan, InstallPaused, installHerdrOnly, installIdFor, installProfilesOnly, installRequestFromArgs, prepareInstall, repositoryRoot, type InstallDependencies } from '../install/index.js';
import { installDirectory, readInstallRecord, recordedRoster, removeRosterEntry, rosterEntry, upsertRosterEntry } from '../install/secrets.js';
import { runManifestFlow } from '../install/manifest.js';
import { delegationLimitAssignments } from '../install/limits.js';
import { ciProducerProvisioningSteps, readRoster, registerCiProducer } from '../install/ci-proofs.js';
import { defineCommands } from './registry.js';
import { readSecretFromStdin } from './context.js';
import { upCommand, upHelpRequested, upUsage } from '../up.js'; import { mergerFromStatus } from './install-merger.js'; import { runDoctor } from './install-doctor.js';

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
/**
 * `graphyard principal add|remove` (GY-1879): one entry of this host's installation roster. The
 * install.json record is the roster; `add` judges the entry as the planner judges its own
 * (`rosterEntry`: a producer needs an explicit grant), and `applyRosterChange` writes its
 * credential, hands the deployment GRAPHYARD_PRINCIPALS alone and reads the served roster back.
 * The installer's own principals are refused: `install --apply` plans them. Repeating either
 * command changes nothing and only reads the roster back.
 */
export async function principalCommand(args: string[], dependencies: InstallDependencies & { cwd: string }) {
  const [action, id, ...rest] = args;
  const { values } = parseArgs({ args: rest, options: { role: { type: 'string' }, 'session-kind': { type: 'string' }, grant: { type: 'string', multiple: true }, repo: { type: 'string' } }, allowPositionals: false });
  if ((action !== 'add' && action !== 'remove') || !id) throw new Error('Use principal add ID --role ROLE [--session-kind ai|human] [--grant NAME]... [--repo OWNER/NAME], or principal remove ID [--repo OWNER/NAME]');
  if (action === 'remove' && (values.role || values['session-kind'] || values.grant?.length)) throw new Error('principal remove takes only ID and --repo');
  const entry = action === 'add' ? rosterEntry({ id, role: values.role, sessionKind: values['session-kind'], grants: values.grant }) : null;
  const root = repositoryRoot(dependencies.cwd);
  const repository = values.repo ?? (await discover(root)).repository;
  if (!repository) throw new Error('Use --repo OWNER/NAME, or run from a checkout whose origin is the managed repository');
  const directory = installDirectory(installIdFor(repository), dependencies.configHome);
  if (!await readInstallRecord(directory)) throw new Error(`No installation of ${repository} is recorded under ${directory}; run graphyard install --apply first`);
  // The edit holds the installation's apply lock from reading the roster until it is persisted and read back,
  // so two edits, or an edit and an install --apply, never each deploy a roster missing the other's entry.
  const release = await acquireApplyLock(directory, (dependencies.now ?? Date.now)());
  try { return await editRoster(root, directory, id, entry, dependencies); } finally { await release(); }
}
async function editRoster(root: string, directory: string, id: string, entry: ReturnType<typeof rosterEntry> | null, dependencies: InstallDependencies & { cwd: string }) {
  const record = await readInstallRecord(directory);
  if (!record) throw new Error(`No installation is recorded under ${directory}; run graphyard install --apply first`);
  const { roster, changed } = entry ? upsertRosterEntry(recordedRoster(record), entry) : removeRosterEntry(recordedRoster(record), id);
  // The deployment is reached where install --apply reached it: its SSH host and user, local mode, port and image.
  const at = record.deployment;
  if (!at?.sshHost && !at?.local && (record.provider === 'docker-host' || record.provider === 'host')) throw new Error(`${directory}/install.json does not record the host this installation runs on; rerun graphyard install --apply once to record it, then edit the roster`);
  const session = await prepareInstall(root, { repository: record.repository, provider: record.provider, baseBranch: record.baseBranch, reviewPolicy: record.reviewPolicy, ...(record.domain ? { domain: record.domain } : {}), ...(record.service ? { serverName: record.service } : {}), ...(record.selfContained ? { selfContained: true } : {}), ...(record.noGithubApp ? { noGithubApp: true } : {}),
    ...(at ? { sshUser: at.sshUser, ...(at.sshHost ? { sshHost: at.sshHost } : {}), ...(at.local ? { local: true } : {}), ...(at.port ? { port: at.port } : {}), ...(at.image ? { image: at.image } : {}) } : {}) }, dependencies, 'apply');
  return applyRosterChange(session, record, roster, { id, changed, entry });
}
/** Repository onboarding: install a control plane, propose and apply the delivery workflow, register Apps, inspect readiness. */
export const installCommands = defineCommands([
  {
    name: 'up',
    help: [
      '  up --repo OWNER/NAME [--provider compose|railway|hetzner|local] [--local] [--reviewer NAME]',
      '     [--master claude|codex] [--agent] [--goal FILE] [--browser-profile PROFILE]',
      '     [--confirm-price X | --max-monthly N] [--ssh-key NAME] [--ssh-host HOST] [--ssh-user USER]',
      '     [--reuse-app SLUG]... [--github-mobile] [--wait MINUTES] [--no-wait] [--share-tailnet]',
      '  up --sudo-code CODE|email',
      '                                First-run setup in one command: preflight, control plane, host supervisor and',
      '                                Herdr, onboarding, agent accounts, harness and master loop, resumable (.graphyard/up.json;',
      '                                a rerun reuses its --repo/--provider). Ctrl-C stops the install too. Onboarding files are',
      '                                published as a pull request; the goal waits for it to merge. Price and SSH flags pass to',
      '                                install. A step that needs a person prints one one-time link that signs in to the',
      '                                dashboard Setup page, and waits for it to turn green. Accounts registers host agent',
      '                                logins first (registry propose --apply), asking only for an empty role. A green run',
      '                                ends with one fresh sign-in link (signIn). A Tailscale host prints its tailnet-only',
      '                                `tailscale serve` URL; --share-tailnet runs it, links use it (reachableUrl); never public.',
      '                                --agent runs every step non-interactively (JSON events on stderr), Apps in the given,',
      '                                master\'s or same-login other install\'s Chrome profile (none: exit 2), handing off only',
      '                                device approvals. Confirm access: GitHub Mobile when offered (its number; 3 prompts; password link',
      '                                after 60 s); else the page\'s methods, re-checked each 10 s: your Chrome (shared profile; a copy:',
      '                                the App page in your browser), --sudo-code an authenticator or email code typed in 2 s (email:',
      '                                GitHub sends one), or app import both Apps, --reuse-app each (--no-wait exits 3 saying so). A drive',
      '                                giving up hands off the page; a GitHub rejection exits 1 quoting it. --wait MINUTES bounds a wait',
      '                                (agent: 20); rerun resumes Confirm access; up --help: options, exit codes.',
    ],
    // `up` installs the control plane and records the connection; it never reads a stale one.
    readsConnection: () => false,
    async run(context) {
      if (upHelpRequested([context.id, ...context.args])) { console.log(upUsage); return; }
      const result = await upCommand(context.repositoryRoot(), () => context.activeCliPath(), [context.id, ...context.args].filter((value): value is string => value !== undefined));
      context.print(result);
      if ('exitCode' in result) process.exitCode = result.exitCode;
    },
  },
  {
    name: 'install',
    help: [
      '  install --provider railway|hetzner|docker-host|compose|local --repo OWNER/NAME',
      '          [--plan|--apply] [--domain HOST] [--workers N] [--reviewer NAME]',
      '          [--producer-proof PROOF] [--ssh-host HOST] [--ssh-user USER]',
      '          [--ssh-key NAME] [--port N] [--workspace NAME-OR-ID] [--image REF]',
      '          [--create-environments] [--herdr-rebind | --no-herdr]',
      '                                Install or reconcile a complete control plane.',
      '  install --target host|hetzner --repo OWNER/NAME [--plan|--apply]',
      '          [--ssh-host HOST | --local] [--migrate] [--max-monthly N | --confirm-price X]',
      '          [--github-app FILE] [--reuse-app SLUG]... [--herdr-only | --profiles-only]',
      '                                Self-contained host: server, Postgres, loop, executors,',
      '                                Herdr and agent runtimes on one machine (hetzner creates it',
      '                                and needs its monthly price confirmed). --migrate moves an',
      '                                installation there from GRAPHYARD_MIGRATE_DATABASE_URL.',
      '                                An App already saved for the repository (--github-app,',
      '                                or .graphyard/github-app.json) is reused: no browser step.',
      '                                --reuse-app SLUG reuses an App saved on this host and',
      '                                installed on the account: the repository is added to its',
      '                                installation with gh after its permissions are checked; a',
      '                                control-plane App whose webhook serves another install is',
      '                                refused. The App page offers the same reuse.',
      '                                --plan prints every action with secrets redacted and',
      '                                changes nothing; --apply executes the same plan. UAT and',
      '                                production resources that cost money are created only with --create-environments.',
      '                                A Herdr plugin bound elsewhere is repointed only with --herdr-rebind; --herdr-only sets up Herdr alone;',
      '                                --profiles-only (with --apply) writes the reviewer and worker profiles on the host (master environments --apply there).',
      '                                An App step nobody confirms within 900 s (under up: its --wait,',
      '                                plus a minute) exits 1 with a JSON summary and the exact resume command.',
      '                                See docs/install.md for the agent-executable runbook.',
    ],
    // The installer creates the connection file; it must never read a stale one.
    readsConnection: () => false,
    async run(context) {
      const { values, request: inputs } = installRequestFromArgs(context.rest);
      const session = await prepareInstall(process.cwd(), inputs, {
        cliPath: await context.activeCliPath(), hostId: context.individualHostId(), log: line => console.error(line),
        githubApp: request => runManifestFlow(request.root, request.repository, request.origin, { reviewer: request.reviewer, announce: line => console.error(line), ...appStepWait(process.env), dependencies: { file: request.file, ...(request.reuse ? { reusable: request.reuse.slugs, reuse: request.reuse.adopt } : {}) } }),
      }, values.apply ? 'apply' : 'plan');
      if (values.logs) return console.log(await session.adapter.logs(session.context));
      if (values['herdr-only']) { const result = await installHerdrOnly(session); context.print(result); if (!result.herdr) process.exitCode = 1; return; }
      if (values['profiles-only']) return context.print(await installProfilesOnly(session));
      const plan = await buildPlan(session);
      if (!values.apply) return context.print(plan);
      try { return context.print(await applyInstall(session, plan)); }
      catch (error) {
        // An App step nobody confirmed is a pause (GY-1413): print what was completed and how to resume.
        if (!(error instanceof InstallPaused)) throw error;
        console.error(error.message);
        context.print(error.summary);
        process.exitCode = 1;
      }
    },
  },
  {
    name: 'init',
    help: [
      '  init [--scan] [--apply] [--url URL] [--herdr [--herdr-rebind]] [--token-stdin]',
      '       [--delivery local|release-candidate|per-pr] [--candidate-cron CRON|off]',
      '                                Scan and propose the delivery workflow (--scan), or apply the reviewed proposal (--apply);',
      '                                the scan shows the merge-gate split (pre-merge vs per-candidate checks) before anything is applied;',
      '                                after graphyard install, --apply reuses the install\'s identities and App and writes no principals file',
    ],
    async run(context) {
      const { base, connection, print } = context;
      const root = context.repositoryRoot();
      const { values } = parseArgs({ args: context.rest, options: { url: { type: 'string' }, herdr: { type: 'boolean' }, 'herdr-rebind': { type: 'boolean' }, 'token-stdin': { type: 'boolean' }, 'host-id': { type: 'string' }, 'cli-path': { type: 'string' }, scan: { type: 'boolean' }, apply: { type: 'boolean' },
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
        // GY-1901: the recorded merger chooses the default model; an explicit github merger keeps the GitHub pipeline.
        const recordedMerger = await mergerFromStatus(() => context.api('status'));
        const fresh = await scanProposal(root, { url: values.url ?? null, runtimes: availableRuntimes(), delivery: { ...(values.apply ? { ...reviewed, ...choices } : choices), merger: recordedMerger } });
        if (values.apply) {
          if (!stored) throw new Error('No stored setup proposal to apply. Run init --scan, review .graphyard/setup-proposal.json, then rerun with --apply');
          // An install that owns this repository supplies the identities and the App (GY-1413);
          // when it cannot yet — its App step is still waiting — this refuses before anything else.
          // It owns them only for the server it installed, so the selected server must be that one.
          const selected = values.url ?? stored.proposal.server ?? null;
          const installed = await installedOnboarding(root, stored.proposal.repository, selected);
          const differences = repositoryScanDifference(fresh, stored.proposal);
          if (differences.length) throw new Error(`${differences.join('; ')}. Rerun init --scan, review the refreshed proposal, then apply it again. The stored proposal was left unchanged.`);
          const url = selected ?? installed?.url;
          if (!url) throw new Error('Applying requires the Graphyard server URL; pass --url');
          const merger = recordedMerger;
          if (installed) {
            const result = await applyProposal(root, stored.proposal, { url, installed, github: protectionRun, merger });
            return print({ proposal: stored.file, ...result, installed: installed.directory });
          }
          // Apply rewrites the registry from the reviewed proposal; the CI producer's token is read
          // first so a re-run keeps the repository secret valid, then the entry is merged back in.
          const roster = await readRoster(resolve(root, '.graphyard/principals.json'));
          // The App page init would open needs port 4311; a busy one refuses here, before any write.
          if (!(await loadAppliedSetup(root))?.artifacts.githubApp && !await readFile(resolve(root, '.graphyard/github-app.json')).then(() => true, () => false) && !await appPagePortFree()) throw appPageBusy(4311);
          const result = await applyProposal(root, stored.proposal, { url, githubSetup: interactiveGithubSetup(root), github: protectionRun, writeCredentials: true, merger });
          if (!result.principalsFile) throw new Error('applyProposal wrote no principals registry');
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
      if (values['herdr-rebind'] && !values.herdr) throw new Error('--herdr-rebind repoints the Herdr plugin; pass it with --herdr');
      return print(await setupRepository(root, { url: selectedUrl, cliPath: resolve(values['cli-path'] ?? await context.activeCliPath()), hostId: values['host-id'] ?? context.individualHostId(), ...(workerToken ? { token: workerToken } : {}) }, { herdr: values.herdr, herdrRebind: values['herdr-rebind'] }));
    },
  },
  {
    name: 'doctor',
    help: [
      '  doctor [--profile PROFILE]   Inspect local discovery, live integration readiness and the',
      '                                readiness checklist for a completion profile',
    ],
    async run(context) { return runDoctor(context); },
  },
  { name: 'principal', help: ['  principal add ID --role admin|coordinator|worker|reader|producer [--session-kind ai|human] [--grant external-runs:import|delivery:observe-sha] [--repo OWNER/NAME]',
    '  principal remove ID [--repo OWNER/NAME]',
    '                                Add or remove one principal of this host\'s installation: writes its credential and its',
    '                                install.json roster entry, sets GRAPHYARD_PRINCIPALS alone on the deployment, and reads the',
    '                                roster back from the control plane. A producer needs an explicit --grant; delivery:observe-sha',
    '                                is held alone, by a dedicated observer principal; a later',
    '                                install --apply keeps the entry. Repeating either command changes nothing.'], readsConnection: () => false,
    async run(context) { context.print(await principalCommand([context.id, ...context.args].filter((value): value is string => value !== undefined), { cwd: process.cwd(), cliPath: await context.activeCliPath(), hostId: context.individualHostId(), log: line => console.error(line) })); } },
  { name: 'app', help: ['  app import --app-id ID --key-file PEM [--role control-plane|reviewer|revert-approver] [--repo R]', '  app list [--repo OWNER/NAME]  Import an App made elsewhere (key proven by an App JWT, saved 0600,',
    '                                never printed) for --reuse-app without sudo; list reusable Apps per role',
    '  app bind SLUG [--plan] [--ssh-host H] [--workspace W]  Bind an imported App to the observe-only install'], readsConnection: () => false,
    async run(context) { context.print(await appCommand([context.id, ...context.args].filter((value): value is string => value !== undefined), { root: context.repositoryRoot() })); } },
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
