import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { availableRuntimes, describeMergeGate, discover, installedOnboarding } from '../onboarding.js';
import { deliveryModes, type DeliveryMode } from '../model/delivery-policy.js';
import { appPageBusy, appPagePortFree, startGithubSetup, updateAppPermissions } from '../github-setup.js';
import { applyProposal, loadAppliedSetup, loadProposal, readDocumentationConfig, readSetupStatus, repositoryScanDifference, saveProposal, scanProposal, setupDrift, setupRepository } from '../repository-setup.js';
import { protectionRun } from '../protection.js';
import { appCommand, applyInstall, appStepWait, buildPlan, InstallPaused, installHerdrOnly, installRequestFromArgs, prepareInstall } from '../install/index.js';
import { runManifestFlow } from '../install/manifest.js';
import { delegationLimitAssignments } from '../install/limits.js';
import { ciProducerProvisioningSteps, readRoster, registerCiProducer } from '../install/ci-proofs.js';
import { completionProfiles, readinessChecklist, summarizeDefinitions, type CompletionProfile } from '../readiness.js';
import { defineCommands } from './registry.js';
import { readSecretFromStdin } from './context.js';
import { documentationDrift } from '../model/documentation.js';
import { agentEnvironmentRoot } from '../master/environments.js';
import { masterCredential, planeAnswers, planeRequest, setupFromZeroChecks, setupLine, setupNext } from '../setup-from-zero.js';
import { mergerDoctorLine } from './merger.js'; import { upCommand, upHelpRequested, upUsage } from '../up.js';

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
      '                                device approvals. Confirm access: GitHub Mobile whenever offered (its number; 3 fresh prompts',
      '                                at most; password link after 60 s); else the page\'s methods, re-checked every 10 s: your',
      '                                Chrome (shared profile only), --sudo-code a 6-digit authenticator/email code (email: GitHub',
      '                                sends one), or app import both Apps and --reuse-app each (--no-wait exits 3 saying so). A drive',
      '                                giving up hands off the still-served page; a GitHub rejection exits 1 quoting it. --wait MINUTES',
      '                                bounds each human wait (agent: 20); a rerun resumes Confirm access; up --help: options, exit codes.',
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
      '          [--github-app FILE] [--reuse-app SLUG]... [--herdr-only]',
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
      '                                A Herdr plugin bound elsewhere is repointed only with --herdr-rebind; --herdr-only sets up Herdr alone.',
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
      '       [--delivery release-candidate|per-pr] [--candidate-cron CRON|off]',
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
        const fresh = await scanProposal(root, { url: values.url ?? null, runtimes: availableRuntimes(), delivery: values.apply ? { ...reviewed, ...choices } : choices });
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
          if (installed) {
            const result = await applyProposal(root, stored.proposal, { url, installed, github: protectionRun });
            return print({ proposal: stored.file, ...result, installed: installed.directory });
          }
          // Apply rewrites the registry from the reviewed proposal; the CI producer's token is read
          // first so a re-run keeps the repository secret valid, then the entry is merged back in.
          const roster = await readRoster(resolve(root, '.graphyard/principals.json'));
          // The App page init would open needs port 4311; a busy one refuses here, before any write.
          if (!(await loadAppliedSetup(root))?.artifacts.githubApp && !await readFile(resolve(root, '.graphyard/github-app.json')).then(() => true, () => false) && !await appPagePortFree()) throw appPageBusy(4311);
          const result = await applyProposal(root, stored.proposal, { url, githubSetup: interactiveGithubSetup(root), github: protectionRun, writeCredentials: true });
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
    async run(context) {
      const { base } = context;
      const root = context.repositoryRoot();
      // With no GRAPHYARD_TOKEN(_FILE), doctor reads as the master identity install --apply recorded (GY-1412).
      const master = await masterCredential(root, base);
      const api = master ? planeRequest(base, master.token) : context.api;
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
      const checks = await setupFromZeroChecks({ root, status: live, failure, reachable: !!live || await planeAnswers(base), masterCredential: master?.file, environments: agentEnvironmentRoot() });
      const setupFromZero = { ready: checks.every(check => check.status === 'pass'), lines: checks.map(setupLine) };
      // A ready checklist still deploys nothing: once every item is ready, capacity drift and
      // an undeployed merge are the next actions; until then the checklist's own gap comes first.
      const firstFailed = checks.find(check => check.status === 'fail');
      const next = !readiness.ready ? setupNext(readiness, checks)
        : firstFailed ? setupLine(firstFailed)
        : delegationLimits?.drift?.length ? `Set ${delegationLimits.drift.map((entry: any) => `${entry.variable}=${entry.required}`).join(' ')} on the deployment: ${delegationLimits.drift[0].reason}`
        : documentation.drift ? documentation.drift
        : production?.incidents?.length ? `Production has not deployed ${production.incidents.map((incident: any) => incident.key).join(', ')}: ${production.incidents[0].reason}`
        : readiness.next; console.error(mergerDoctorLine(live?.mergeWriter));
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
  { name: 'app', help: ['  app import --app-id ID --key-file PEM [--role control-plane|reviewer|revert-approver] [--repo R]', '  app list [--repo OWNER/NAME]  Import an App made elsewhere (key proven by an App JWT, saved 0600,',
    '                                never printed) for --reuse-app without sudo; list reusable Apps per role'], readsConnection: () => false,
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
