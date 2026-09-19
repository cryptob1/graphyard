import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { availableRuntimes, discover } from '../onboarding.js';
import { startGithubSetup, updateAppPermissions } from '../github-setup.js';
import { applyProposal, loadAppliedSetup, loadProposal, readSetupStatus, repositoryScanDifference, saveProposal, scanProposal, setupDrift, setupRepository } from '../repository-setup.js';
import { applyInstall, buildPlan, prepareInstall, providers, type InstallInputs } from '../install/index.js';
import { runManifestFlow } from '../install/manifest.js';
import { delegationLimitAssignments } from '../install/limits.js';
import { completionProfiles, readinessChecklist, summarizeDefinitions, type CompletionProfile } from '../readiness.js';
import { defineCommands } from './registry.js';
import { readSecretFromStdin } from './context.js';


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
      '          [--producer-proof PROOF] [--ssh-host HOST] [--ssh-user USER] [--port N]',
      '          [--workspace NAME-OR-ID] [--image REF]',
      '                                Install or reconcile a complete control plane.',
      '                                --plan prints every action with secrets redacted and',
      '                                changes nothing; --apply executes the same plan.',
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
        'ssh-host': { type: 'string' }, 'ssh-user': { type: 'string' }, 'server-name': { type: 'string' }, workspace: { type: 'string' },
        'server-type': { type: 'string' }, location: { type: 'string' }, port: { type: 'string' }, logs: { type: 'boolean' },
      }, allowPositionals: false });
      if (!values.repo) throw new Error('Use --repo OWNER/NAME');
      if (!values.provider || !providers.includes(values.provider as any)) throw new Error(`Use --provider ${providers.join('|')}`);
      if (values.plan && values.apply) throw new Error('Choose either --plan or --apply');
      const reviewPolicy = values['review-policy'];
      if (reviewPolicy && !['github', 'agent'].includes(reviewPolicy)) throw new Error('Use --review-policy github or agent');
      // A count that silently became NaN would install a control plane with no worker principal
      // or an unusable port, so a non-numeric value stops the command instead.
      const count = (flag: string, value: string) => { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${flag} takes a whole number`); return parsed; };
      const inputs: InstallInputs = { repository: values.repo, provider: values.provider as InstallInputs['provider'],
        ...(values['base-branch'] ? { baseBranch: values['base-branch'] } : {}),
        ...(values.domain ? { domain: values.domain } : {}), ...(values.workers ? { workers: count('workers', values.workers) } : {}),
        ...(values.port ? { port: count('port', values.port) } : {}),
        ...(values.reviewer ? { reviewer: values.reviewer } : {}), ...(values.image ? { image: values.image } : {}),
        ...(values['producer-proof']?.length ? { producerProofs: values['producer-proof'] } : {}),
        ...(reviewPolicy ? { reviewPolicy: reviewPolicy as 'github' | 'agent' } : {}),
        ...(values['required-check']?.length ? { requiredChecks: values['required-check'] } : {}),
        ...(values['review-count'] ? { reviewCount: count('review-count', values['review-count']) } : {}),
        ...(values['ssh-host'] ? { sshHost: values['ssh-host'] } : {}), ...(values['ssh-user'] ? { sshUser: values['ssh-user'] } : {}),
        ...(values['server-name'] ? { serverName: values['server-name'] } : {}), ...(values.workspace ? { workspace: values.workspace } : {}),
        ...(values['server-type'] ? { serverType: values['server-type'] } : {}), ...(values.location ? { location: values.location } : {}) };
      const session = await prepareInstall(process.cwd(), inputs, {
        cliPath: await context.activeCliPath(), hostId: context.individualHostId(), log: line => console.error(line),
        githubApp: request => runManifestFlow(request.root, request.repository, request.origin, { reviewer: request.reviewer, announce: line => console.error(line) }),
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
      '                                Scan and propose the delivery workflow (--scan), or apply the reviewed proposal (--apply)',
    ],
    async run(context) {
      const { base, connection, print } = context;
      const root = context.repositoryRoot();
      const { values } = parseArgs({ args: context.rest, options: { url: { type: 'string' }, herdr: { type: 'boolean' }, 'token-stdin': { type: 'boolean' }, 'host-id': { type: 'string' }, 'cli-path': { type: 'string' }, scan: { type: 'boolean' }, apply: { type: 'boolean' } }, allowPositionals: false });
      if (values.scan || values.apply) {
        if (values.herdr || values['token-stdin']) throw new Error('--scan/--apply propose and apply the delivery workflow; run them as the operator before any worker credential setup');
        const fresh = await scanProposal(root, { url: values.url ?? null, runtimes: availableRuntimes() });
        if (values.apply) {
          const stored = await loadProposal(root);
          if (!stored) throw new Error('No stored setup proposal to apply. Run init --scan, review .graphyard/setup-proposal.json, then rerun with --apply');
          const differences = repositoryScanDifference(fresh, stored.proposal);
          if (differences.length) throw new Error(`${differences.join('; ')}. Rerun init --scan, review the refreshed proposal, then apply it again. The stored proposal was left unchanged.`);
          const url = values.url ?? stored.proposal.server;
          if (!url) throw new Error('Applying requires the Graphyard server URL; pass --url');
          const result = await applyProposal(root, stored.proposal, { url, githubSetup: interactiveGithubSetup(root) });
          return print({ proposal: stored.file, ...result, capacity: await capacityForPrincipals(result.principalsFile, () => context.api('status')) });
        }
        await saveProposal(root, fresh);
        const applied = await loadAppliedSetup(root);
        return print({ proposalFile: '.graphyard/setup-proposal.json', proposal: fresh,
          applied: applied ? { at: applied.appliedAt, githubApp: applied.artifacts.githubApp } : null,
          drift: setupDrift(applied, fresh),
          appliedNothingElse: true,
          next: 'Review .graphyard/setup-proposal.json, then rerun init --scan --apply --url SERVER_URL to apply the reviewed proposal' });
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
      // Capacity drift and production lag are the two installation facts a deploy can break
      // silently; the server reports both and doctor repeats them beside the App preflight.
      const delegationLimits = live?.delegationLimits ?? null, production = live?.production ?? null;
      // Validation definitions are readable by operators and readers; every other credential
      // leaves the runner-path items `unknown` with the command that reads them.
      let definitions: { kind: string; id: string; revision: number; role?: string; enabled?: boolean }[] | null = null;
      if (live && ['admin', 'reader'].includes(live.actor?.role)) { try { definitions = (await api('validation/definitions')).definitions; } catch { definitions = null; } }
      const readiness = readinessChecklist(profile, {
        repository: discovered.repository ?? null,
        server: { url: base, reachable: !!live, role: live?.actor?.role, github: !!live?.github, githubPermissions: live?.githubPermissions ?? {}, appPermissions, failure },
        setup: 'error' in setup ? { proposal: null, appliedAt: null, githubApp: null, drift: [], unreadable: [String(setup.error)] } : { ...setup, unreadable: setup.unreadable.filter((entry): entry is string => typeof entry === 'string') },
        proposal: stored?.proposal ?? null,
        validation: definitions ? summarizeDefinitions(definitions) : null,
      });
      // A ready checklist still deploys nothing: once every item is ready, capacity drift and
      // an undeployed merge are the next actions; until then the checklist's own gap comes first.
      const next = !readiness.ready ? readiness.next
        : delegationLimits?.drift?.length ? `Set ${delegationLimits.drift.map((entry: any) => `${entry.variable}=${entry.required}`).join(' ')} on the deployment: ${delegationLimits.drift[0].reason}`
        : production?.incidents?.length ? `Production has not deployed ${production.incidents.map((incident: any) => incident.key).join(', ')}: ${production.incidents[0].reason}`
        : readiness.next;
      return context.print({ discovered, server: base, cliPath: await context.activeCliPath(), hostId: context.individualHostId(), connected: !!live, githubConfigured: !!live?.github, role: live?.actor?.role, release: live?.release ?? null, failure,
        setup,
        appPermissions: appPermissions ? { verifiedAt: appPermissions.verifiedAt, missing: appPermissions.missing, attention: appPermissions.attention, installationUrl: appPermissions.installationUrl } : null,
        heldJobs: live?.heldJobs ?? 0,
        build: live?.build ?? null,
        delegationLimits: delegationLimits ? { limits: delegationLimits.limits, deployed: delegationLimits.deployed, drift: delegationLimits.drift, attention: delegationLimits.attention } : null,
        production: production ? { provider: production.provider, serving: production.serving, running: production.running, aheadBy: production.ahead?.by ?? null, incidents: production.incidents, attention: production.attention, error: production.error } : null,
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
