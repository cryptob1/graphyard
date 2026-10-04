import { mkdir } from 'node:fs/promises';
import { ghJson, headSha, type GitHubCli } from './github.js';
import { shellQuote, type Transport } from './transport.js';
import type { PlanAction, PreflightItem } from './types.js';
import { type DeliveryPolicy, type DeploymentAdapterName } from '../model/delivery-policy.js';

// ---------------------------------------------------------------------------
// The managed repository's deployment target (GY-1102): where a release candidate runs in UAT and
// where a promoted one runs in production, behind one small adapter. This is the managed
// application's own deployment, distinct from the provider that hosts the Graphyard control plane.
//
// `install --plan` lists every UAT and production resource an adapter would create and applies
// nothing. A resource that costs money or opens an account is a human decision: its plan action
// carries `human` naming the cost, and `--apply` creates it only when the operator also passed
// --create-environments; otherwise the exact command is left in the next steps. Free wiring —
// the release branches and the GitHub environments the workflows deploy through — happens on
// --apply.
// ---------------------------------------------------------------------------

export const releaseBranchNames = { uat: 'release/uat', production: 'release/production' } as const;
export const releaseEnvironments = ['uat', 'production'] as const;
export type ReleaseEnvironment = (typeof releaseEnvironments)[number];

export interface DeploymentContext {
  repository: string;
  installId: string;
  baseBranch: string;
  policy: DeliveryPolicy;
  /**
   * The Graphyard-owned directory the Railway CLI links for the managed application's
   * environments. Never the managed checkout: a checkout already linked to the user's own project
   * must not be provisioned as if it were this one, the guard runRailway keeps for the control plane.
   */
  railwayDir: string;
  workspace: string | null;
  transport: Transport;
  /** The plan action ids an earlier --apply created, from the install record. */
  created: readonly string[];
  /** The operator passed --create-environments: the cost-bearing resources are to be created. */
  createEnvironments: boolean;
}

export interface DeploymentAdapter {
  adapter: DeploymentAdapterName;
  preflight(ctx: DeploymentContext): Promise<PreflightItem[]>;
  /** Every UAT and production resource the adapter needs, in order; cost-creating ones carry `human`. */
  plan(ctx: DeploymentContext): PlanAction[];
  /** Creates what the plan lists. Paid resources only with `createPaid`; the rest are returned as pending. */
  provision(ctx: DeploymentContext, options: { createPaid: boolean }): Promise<{ created: string[]; pending: PlanAction[] }>;
}

const costNote = (resource: string) => `Costs money: ${resource} bills your Railway account for as long as it runs. --apply creates it only with --create-environments, after you approve this cost; otherwise run the command yourself.`;
const railwayProjectName = (ctx: DeploymentContext) => ctx.policy.deploy.project ?? `${ctx.repository.split('/')[1]}-app`;
const railwayService = (ctx: DeploymentContext, environment: ReleaseEnvironment) => `${ctx.repository.split('/')[1]}-${environment}`;

/**
 * A Railway action's invocations as argument vectors, so a project or workspace name with spaces
 * stays one argument; `command` is only their display form, quoted the way a shell would need it.
 */
type RailwayAction = PlanAction & { steps: string[][] };
const shellWord = (word: string) => /^[\w@%+=:,./-]+$/.test(word) ? word : shellQuote(word);
const displayed = (steps: string[][]) => steps.map(step => step.map(shellWord).join(' ')).join(' && ');
const planned = ({ steps: _steps, ...action }: RailwayAction): PlanAction => action;

function railwayActions(ctx: DeploymentContext): RailwayAction[] {
  const state = (id: string) => ctx.created.includes(id) ? 'satisfied' as const : 'create' as const;
  const project = ctx.policy.deploy.project;
  const workspace = ctx.workspace ? ['--workspace', ctx.workspace] : [];
  const link = [['railway', 'link', '--project', project ?? '']];
  const init = [['railway', 'init', '--name', railwayProjectName(ctx), ...workspace]];
  return [
    project
      ? { id: 'release.railway.project', target: 'provider', state: 'satisfied', title: `Use the existing Railway project ${project} for the application's uat and production environments`, steps: link, command: displayed(link) }
      : { id: 'release.railway.project', target: 'provider', state: state('release.railway.project'), title: `Create the Railway project ${railwayProjectName(ctx)} that holds the application's uat and production environments`, steps: init, command: displayed(init),
        human: 'Opens a billable Railway project on your account. Approve it, then rerun --apply with --create-environments, or name an existing project as delivery.deploy.project in graphyard.json.' },
    ...releaseEnvironments.map(environment => {
      const service = railwayService(ctx, environment);
      const steps = [['railway', 'environment', 'new', environment], ['railway', 'add', '--service', service, '--repo', ctx.repository, '--branch', releaseBranchNames[environment]], ['railway', 'environment', environment], ['railway', 'service', service], ['railway', 'domain']];
      return {
        id: `release.railway.${environment}`, target: 'provider' as const, state: state(`release.railway.${environment}`),
        title: `Create the Railway ${environment} environment with service ${service} deploying ${releaseBranchNames[environment]} (never ${ctx.baseBranch})${environment === 'uat' ? ', holding no GITHUB_* credential' : ''}`,
        steps, command: displayed(steps),
        // `railway add --branch` sets the service's source branch, so it deploys the release branch
        // from its first build; `applyWiring` creates both branches before provision runs.
        human: `${costNote(`the ${environment} environment and its running service`)} After it exists, store its URL as ${environment === 'uat' ? 'UAT_URL' : 'PRODUCTION_URL'} on the ${environment} GitHub environment.`,
      };
    }),
  ];
}

async function runRailway(ctx: DeploymentContext, steps: string[][]) {
  // Each step is one railway invocation, run in the Graphyard-owned link directory.
  for (const [program, ...args] of steps) await ctx.transport.exec(program, args, { cwd: ctx.railwayDir, timeout: 600_000 });
}

export const railwayDeploymentAdapter: DeploymentAdapter = {
  adapter: 'railway',
  async preflight(ctx) {
    const detail = `uat and production environments in Railway project ${railwayProjectName(ctx)}`;
    // Only creating the environments needs the CLI; without --create-environments they stay listed.
    if (!ctx.createEnvironments) return [{ name: 'Release deployment (railway)', ok: true, detail: `${detail}; created only with --create-environments` }];
    const version = await ctx.transport.exec('railway', ['--version'], { allowFailure: true, timeout: 60_000 });
    return [version.code === 0
      ? { name: 'Release deployment (railway)', ok: true, detail }
      : { name: 'Release deployment (railway)', ok: false, detail: 'the railway CLI is missing or not authenticated', fix: 'Install the Railway CLI (npm i -g @railway/cli) and run: railway login' }];
  },
  plan: ctx => railwayActions(ctx).map(planned),
  async provision(ctx, options) {
    const actions = railwayActions(ctx), wanted = actions.filter(action => action.state !== 'satisfied');
    if (!options.createPaid || !wanted.length) return { created: [], pending: wanted.map(planned) };
    await mkdir(ctx.railwayDir, { recursive: true, mode: 0o700 });
    const created: string[] = [];
    if (ctx.policy.deploy.project) await runRailway(ctx, actions[0].steps);
    for (const action of wanted) { await runRailway(ctx, action.steps); created.push(action.id); }
    return { created, pending: [] };
  },
};

/**
 * The generic adapter: the operator's own commands deploy $GRAPHYARD_CANDIDATE_SHA to UAT and to
 * production from the generated workflows. Graphyard creates no resource and invents no command:
 * an unconfigured environment is listed as the step the operator owns.
 */
export const commandDeploymentAdapter: DeploymentAdapter = {
  adapter: 'command',
  async preflight(ctx) {
    const missing = releaseEnvironments.filter(environment => !ctx.policy.deploy[environment]);
    return [{ name: 'Release deployment (command)', ok: true, detail: missing.length
      ? `no ${missing.join(' or ')} deploy command is configured yet; the plan lists it as the operator's step`
      : 'uat and production deploy through the configured commands' }];
  },
  plan(ctx) {
    return releaseEnvironments.map(environment => {
      const command = ctx.policy.deploy[environment];
      return { id: `release.command.${environment}`, target: 'provider' as const, state: command ? 'satisfied' as const : 'create' as const,
        title: command ? `${environment} is deployed by the configured command with GRAPHYARD_CANDIDATE_SHA: ${command}` : `Configure the command that deploys GRAPHYARD_CANDIDATE_SHA to ${environment}`,
        command: command ?? `set delivery.deploy.${environment} in graphyard.json, then rerun graphyard init --scan --apply`,
        human: `Graphyard creates no ${environment} resource: the environment this command deploys to is yours to provide, and any account or cost it needs is your decision.` };
    });
  },
  async provision(ctx) {
    return { created: [], pending: this.plan(ctx).filter(action => action.state !== 'satisfied') };
  },
};

export const deploymentAdapters: Record<DeploymentAdapterName, DeploymentAdapter> = { railway: railwayDeploymentAdapter, command: commandDeploymentAdapter };

/** What GitHub already holds for the pipeline: the release branches and the deployment environments. */
export async function observeReleaseWiring(gh: GitHubCli, repository: string) {
  const branches: Record<ReleaseEnvironment, boolean> = { uat: false, production: false };
  for (const environment of releaseEnvironments)
    branches[environment] = !!await ghJson(gh, ['api', `repos/${repository}/git/ref/heads/${releaseBranchNames[environment]}`], null);
  const listed = await ghJson(gh, ['api', `repos/${repository}/environments`], null) as any;
  const names = new Set<string>((Array.isArray(listed?.environments) ? listed.environments : []).map((entry: any) => String(entry?.name ?? '')));
  return { branches, environments: Object.fromEntries(releaseEnvironments.map(environment => [environment, names.has(environment)])) as Record<ReleaseEnvironment, boolean> };
}

/** The free wiring every candidate pipeline needs, whichever adapter deploys it. */
export function wiringActions(ctx: DeploymentContext, observed: Awaited<ReturnType<typeof observeReleaseWiring>> | null): PlanAction[] {
  const branchesThere = !!observed && releaseEnvironments.every(environment => observed.branches[environment]);
  const environmentsThere = !!observed && releaseEnvironments.every(environment => observed.environments[environment]);
  return [
    { id: 'release.branches', target: 'github', state: branchesThere ? 'satisfied' : 'create',
      title: `Create ${releaseBranchNames.uat} and ${releaseBranchNames.production} at ${ctx.baseBranch}'s tip; only \`graphyard release\` moves them, to a candidate's exact SHA`,
      command: `gh api --method POST repos/${ctx.repository}/git/refs -f ref=refs/heads/${releaseBranchNames.uat} -f sha=<${ctx.baseBranch} tip>` },
    { id: 'release.github-environments', target: 'github', state: environmentsThere ? 'satisfied' : 'create',
      title: 'Create the uat and production GitHub environments the generated workflows deploy through (UAT_URL and PRODUCTION_URL are stored on them)',
      command: releaseEnvironments.map(environment => `gh api --method PUT repos/${ctx.repository}/environments/${environment}`).join(' && ') },
  ];
}

/** Applies the free wiring. Idempotent: what GitHub already holds is left alone. */
export async function applyWiring(gh: GitHubCli, ctx: DeploymentContext) {
  const observed = await observeReleaseWiring(gh, ctx.repository);
  const done: string[] = [];
  const missingBranches = releaseEnvironments.filter(environment => !observed.branches[environment]);
  if (missingBranches.length) {
    const sha = await headSha(gh, ctx.repository, ctx.baseBranch);
    for (const environment of missingBranches) await gh(['api', '--method', 'POST', `repos/${ctx.repository}/git/refs`, '-f', `ref=refs/heads/${releaseBranchNames[environment]}`, '-f', `sha=${sha}`]);
    done.push('release.branches');
  }
  const missingEnvironments = releaseEnvironments.filter(environment => !observed.environments[environment]);
  for (const environment of missingEnvironments) await gh(['api', '--method', 'PUT', `repos/${ctx.repository}/environments/${environment}`]);
  if (missingEnvironments.length) done.push('release.github-environments');
  return done;
}
