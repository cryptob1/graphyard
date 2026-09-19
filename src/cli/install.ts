import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { availableRuntimes, discover } from '../onboarding.js';
import { startGithubSetup, updateAppPermissions } from '../github-setup.js';
import { applyProposal, loadAppliedSetup, loadProposal, readSetupStatus, repositoryScanDifference, saveProposal, scanProposal, setupDrift, setupRepository } from '../repository-setup.js';
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

/** Repository onboarding: propose and apply the delivery workflow, register Apps, inspect readiness. */
export const installCommands = defineCommands([
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
          return print({ proposal: stored.file, ...result });
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
    help: ['  doctor                       Inspect local discovery and live integration readiness'],
    async run(context) {
      const root = context.repositoryRoot();
      const discovered = await discover(root);
      let live: any = null, failure: string | undefined;
      try { live = await context.api('status'); } catch (error: any) { failure = error.message; }
      const appPermissions = live?.appPermissions ?? null;
      // Capacity drift and production lag are the two installation facts a deploy can break
      // silently; the server reports both and doctor repeats them beside the App preflight.
      const delegationLimits = live?.delegationLimits ?? null, production = live?.production ?? null;
      return context.print({ discovered, server: context.base, cliPath: await context.activeCliPath(), hostId: context.individualHostId(), connected: !!live, githubConfigured: !!live?.github, role: live?.actor?.role, failure,
        setup: await readSetupStatus(root).catch((error: any) => ({ error: error.message })),
        appPermissions: appPermissions ? { verifiedAt: appPermissions.verifiedAt, missing: appPermissions.missing, attention: appPermissions.attention, installationUrl: appPermissions.installationUrl } : null,
        heldJobs: live?.heldJobs ?? 0,
        build: live?.build ?? null,
        delegationLimits: delegationLimits ? { limits: delegationLimits.limits, deployed: delegationLimits.deployed, drift: delegationLimits.drift, attention: delegationLimits.attention } : null,
        production: production ? { provider: production.provider, serving: production.serving, running: production.running, aheadBy: production.ahead?.by ?? null, incidents: production.incidents, attention: production.attention, error: production.error } : null,
        next: !live ? 'Configure GRAPHYARD_URL and an individual token' : !live.github ? 'Complete github-setup and configure the server App credentials'
          : appPermissions?.missing?.length ? `Run graphyard github-setup --update-permissions: ${appPermissions.attention[0]}`
          : delegationLimits?.drift?.length ? `Set ${delegationLimits.drift.map((entry: any) => `${entry.variable}=${entry.required}`).join(' ')} on the deployment: ${delegationLimits.drift[0].reason}`
          : production?.incidents?.length ? `Production has not deployed ${production.incidents.map((incident: any) => incident.key).join(', ')}: ${production.incidents[0].reason}`
          : 'Submit a real PR and inspect every gate; configured is not proof of enforcement',
        limits: ['CI discovery is a proposal, not executed-test inventory', 'Herdr two-host recovery and GitHub refusal-to-acceptance must be demonstrated'] });
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
