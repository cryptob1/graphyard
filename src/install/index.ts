import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { discover } from '../onboarding.js';
import { adapterFor, carriesCredential, variableMarker, type AdapterContext, type AdapterObservation, type ProviderAdapter, DEFAULT_IMAGE } from './adapters.js';
import { applyProtection, appClient, configureWebhook, detectCiAppIds, effectiveReviewCount, headSha, githubCli, installationClient, protectionSatisfied, readProtection, readWebhookConfig, triggerDelivery, verifyDelivery, webhookUrlFor, CHECK_NAME, type AppFacts, type DeliveryProof } from './github.js';
import { detectHerdr, detectRuntimes, masterRuntime, reviewerProfiles, workerProfiles, type DetectedRuntime, type HerdrState, type ReviewerProfileDraft, type WorkerProfileDraft } from './runtimes.js';
import { assertOutsideRepository, ensureTokens, fingerprint, installDirectory, installRecordSchema, plannedPrincipals, prepareInstallDirectory, principalOfRole, principalsVariable, readInstallRecord, tokenFile, workerPrincipals, writeInstallRecord, Vault, type InstallRecord } from './secrets.js';
import { localTransport, sshTransport, type Transport } from './transport.js';
import { installIdFor, REDACTED, SERVER_PORT, type EnvValue, type InstallInputs, type InstallPlan, type PlanAction, type PlanDrift, type PlanValue, type PlannedPrincipal, type Provider } from './types.js';

export * from './types.js';
export { adapterFor, type ProviderAdapter } from './adapters.js';

export interface ProfileRegistration {
  repository: { connected: boolean; herdr: boolean; detail: string };
  master: { configured: boolean; kind: string | null; detail: string };
  workers: { name: string; principal: string; kind: string }[];
  reviewers: ReviewerProfileDraft[];
}

export interface InstallDependencies {
  transport?: Transport;
  ssh?: (host: string, user?: string) => Transport;
  fetch?: typeof fetch;
  configHome?: string;
  sourceRoot?: string;
  cliPath?: string;
  hostId?: string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  detectRuntimes?: (transport: Transport) => Promise<DetectedRuntime[]>;
  detectHerdr?: (transport: Transport) => Promise<HerdrState>;
  /** Runs the App-manifest browser flow and resolves once the human has confirmed. */
  githubApp?: (request: { root: string; repository: string; origin: string; reviewer?: string }) => Promise<AppFacts & { slug: string; botUserId?: number }>;
  registerProfiles?: (request: ProfileRequest) => Promise<ProfileRegistration>;
  runHerdr?: (args: string[]) => string;
  /** Test seam: exercise the orchestration against a scripted provider. */
  adapter?: ProviderAdapter;
}

export interface ProfileRequest {
  root: string; url: string; cliPath: string; hostId: string; installDirectory: string;
  coordinatorToken: string; workerTokens: { principal: string; token: string }[];
  runtimes: DetectedRuntime[]; herdr: HerdrState;
  workers: WorkerProfileDraft[]; reviewers: ReviewerProfileDraft[]; masterKind: string | null;
  runHerdr?: (args: string[]) => string;
}

export interface InstallSession {
  root: string; inputs: Required<Pick<InstallInputs, 'repository' | 'provider' | 'baseBranch'>> & InstallInputs;
  installId: string; directory: string; adapter: ProviderAdapter; context: AdapterContext;
  principals: PlannedPrincipal[]; tokens: Map<string, string>; vault: Vault;
  record: InstallRecord | null; reviewers: { name: string; appId: number; botUserId: number }[];
  mode: 'plan' | 'apply';
  /** True once every principal credential exists on disk, so fingerprints are real. */
  materialized: boolean;
  deps: Required<Pick<InstallDependencies, 'fetch' | 'now' | 'wait' | 'log'>> & InstallDependencies;
  reviewPolicy: 'github' | 'agent'; requiredChecks: string[]; reviewCount: number;
}

const CORE_HUMAN_STEPS = [
  'Authenticate the provider CLI and GitHub CLI once (the installer prints the exact command when either is missing).',
  'Confirm the Graphyard GitHub App in the browser page the installer opens, and install it on the managed repository.',
  'Approve the printed plan before rerunning with --apply.',
];

export function repositoryRoot(cwd: string) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error('Run graphyard install from the checkout of the repository being managed'); }
}

export async function prepareInstall(cwd: string, rawInputs: InstallInputs, dependencies: InstallDependencies = {}, mode: 'plan' | 'apply' = 'apply'): Promise<InstallSession> {
  const provider = rawInputs.provider;
  if (!provider) throw new Error('Use --provider railway|hetzner|docker-host|compose');
  const installId = installIdFor(rawInputs.repository);
  const root = repositoryRoot(cwd);
  const detected = await discover(root);
  if (detected.repository && detected.repository.toLowerCase() !== rawInputs.repository.toLowerCase()) throw new Error(`This checkout is ${detected.repository}; rerun from ${rawInputs.repository} or correct --repo`);
  const vault = new Vault();
  const directory = installDirectory(installId, dependencies.configHome);
  // Preparing inspects; it never creates, in either mode. `--apply` has to be able to refuse
  // on a failed preflight having changed nothing, so the credential directory, the tokens and
  // the database password are minted by `materializeInstall` after that gate — not here.
  assertOutsideRepository(directory, root);
  const principals = plannedPrincipals(installId, { workers: rawInputs.workers, producerProofs: rawInputs.producerProofs });
  const tokens = await ensureTokens(directory, principals, vault, false);
  const record = await readInstallRecord(directory);
  const reviewPolicy = rawInputs.reviewPolicy ?? 'github';
  const inputs = { ...rawInputs, provider, baseBranch: rawInputs.baseBranch ?? 'main' };
  const transport = dependencies.transport ?? localTransport();
  const ssh = dependencies.ssh ?? ((host: string, user = inputs.sshUser ?? 'root') => sshTransport(host, user, transport));
  // A self-hosted database password is generated once and reused, so re-apply never
  // rewrites a running database's credential out from under it. An installation that already
  // exists yields its real value here, which is what keeps drift reporting exact on re-apply.
  const databasePassword = vault.add(await stableDatabasePassword(directory, false));
  const materialized = tokens.size === principals.length && !!databasePassword;
  const context: AdapterContext = {
    provider, repository: inputs.repository, installId,
    service: inputs.serverName ?? `graphyard-${installId}`,
    domain: inputs.domain ?? null,
    image: inputs.image ?? (provider === 'compose' ? `graphyard-local:${installId}` : DEFAULT_IMAGE),
    workdir: provider === 'compose' ? `${directory}/compose` : `/opt/graphyard/${installId}`,
    sourceRoot: dependencies.sourceRoot ?? fileURLToPath(new URL('../..', import.meta.url)),
    sshHost: inputs.sshHost ?? null, sshUser: inputs.sshUser ?? 'root',
    serverType: inputs.serverType ?? 'cx22', location: inputs.location ?? 'nbg1',
    databasePassword, port: inputs.port ?? SERVER_PORT, dataPath: provider === 'hetzner' ? '/mnt/graphyard' : null,
    wait: dependencies.wait ?? ((ms: number) => new Promise(accept => setTimeout(accept, ms))),
    transport, ssh, fetch: dependencies.fetch ?? fetch, vault,
  };
  return {
    root, inputs, installId, directory, adapter: dependencies.adapter ?? adapterFor(provider), context, principals, tokens, vault, record,
    reviewers: record?.reviewers ?? [], mode, materialized,
    reviewPolicy, requiredChecks: inputs.requiredChecks?.length ? inputs.requiredChecks : detected.proposedChecks,
    reviewCount: reviewPolicy === 'agent' ? 0 : Math.max(0, inputs.reviewCount ?? 1),
    deps: { fetch: dependencies.fetch ?? fetch, now: dependencies.now ?? Date.now, wait: dependencies.wait ?? ((ms: number) => new Promise(accept => setTimeout(accept, ms))), log: dependencies.log ?? (() => {}), ...dependencies },
  };
}

/**
 * Creates what an installation owns on this machine: the credential directory, one token per
 * principal, and the self-hosted database password. It runs only after the preflight gate has
 * passed, so a refused `--apply` leaves the machine exactly as it found it. Idempotent — an
 * existing installation keeps every credential it already has.
 */
export async function materializeInstall(session: InstallSession): Promise<InstallSession> {
  if (session.mode !== 'apply') throw new Error('Apply requires a session prepared in apply mode; --plan sessions create nothing');
  if (session.materialized) return session;
  await prepareInstallDirectory(session.directory, session.root);
  for (const [principal, token] of await ensureTokens(session.directory, session.principals, session.vault, true)) session.tokens.set(principal, token);
  session.context.databasePassword = session.vault.add(await stableDatabasePassword(session.directory, true));
  session.materialized = session.tokens.size === session.principals.length && !!session.context.databasePassword;
  if (!session.materialized) throw new Error(`Could not generate one credential per principal under ${session.directory}`);
  return session;
}

/** Generated once and reused: a re-apply must not lock a running database out of itself. */
async function stableDatabasePassword(directory: string, create: boolean) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const file = `${directory}/database.password`;
  try { const value = (await readFile(file, 'utf8')).trim(); if (value.length >= 32) return value; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (!create) return '';
  const password = randomBytes(24).toString('base64url');
  await writeFile(file, `${password}\n`, { mode: 0o600 });
  return password;
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export function coreEnv(session: InstallSession): EnvValue[] {
  const { context, inputs } = session;
  const databaseUrl = context.provider === 'railway' ? '${{Postgres.DATABASE_URL}}' : `postgres://graphyard:${context.databasePassword}@db:5432/graphyard`;
  return [
    { name: 'HOST', value: '0.0.0.0', secret: false },
    { name: 'PORT', value: String(SERVER_PORT), secret: false },
    { name: 'DATABASE_URL', value: databaseUrl, secret: carriesCredential('DATABASE_URL', databaseUrl) },
    { name: 'GRAPHYARD_PRINCIPALS', value: principalsVariable(session.principals, session.tokens), secret: true },
    { name: 'GITHUB_REPOSITORY', value: inputs.repository, secret: false },
    { name: 'GITHUB_BASE_BRANCH', value: inputs.baseBranch, secret: false },
    { name: 'GRAPHYARD_REVIEWER_APPS', value: JSON.stringify(session.reviewers.map(reviewer => ({ id: reviewer.name, runtime: reviewer.name.replace(/-reviewer$/, ''), appId: reviewer.appId, botUserId: reviewer.botUserId }))), secret: false },
  ];
}

export function githubEnv(facts: AppFacts, ciAppIds: number[]): EnvValue[] {
  return [
    { name: 'GITHUB_APP_ID', value: String(facts.appId), secret: false },
    { name: 'GITHUB_INSTALLATION_ID', value: String(facts.installationId), secret: false },
    { name: 'GITHUB_PRIVATE_KEY', value: facts.privateKey, secret: true },
    { name: 'GITHUB_WEBHOOK_SECRET', value: facts.webhookSecret, secret: true },
    { name: 'GITHUB_CI_APP_IDS', value: ciAppIds.join(','), secret: false },
  ];
}

const PENDING = 'generated on apply';
const planValue = (value: EnvValue, materialized: boolean): PlanValue => value.secret
  ? { name: value.name, value: REDACTED, secret: true, ...(materialized ? { fingerprint: fingerprint(value.value) } : { note: PENDING }) }
  : { name: value.name, value: value.value, secret: false };

function variableDrift(session: InstallSession, action: string, values: EnvValue[], observed: Record<string, string>): PlanDrift[] {
  if (!Object.keys(observed).length) return [];
  return values.flatMap(value => {
    // A credential this machine has not generated yet cannot be compared to a running one.
    if (value.secret && !session.materialized) return [];
    const expected = variableMarker(value.name, value.value);
    const current = observed[value.name];
    // Both sides are markers for anything carrying a credential, so drift is reportable
    // verbatim: an observed value only ever reaches the plan as `sha:<fingerprint>`.
    if (current === undefined) return [{ action, field: value.name, expected, observed: 'absent' }];
    return current === expected ? [] : [{ action, field: value.name, expected, observed: current }];
  });
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function buildPlan(session: InstallSession): Promise<InstallPlan> {
  const { adapter, context, record } = session;
  const preflight = await adapter.preflight(context);
  const gh = githubCli(context.transport);
  const ghStatus = await gh(['auth', 'status'], { allowFailure: true });
  preflight.push(ghStatus.code === 0
    ? { name: 'GitHub CLI', ok: true, detail: 'authenticated for branch protection and CI discovery' }
    : { name: 'GitHub CLI', ok: false, detail: 'gh is missing or not authenticated', fix: `Install GitHub CLI and run: gh auth login --scopes repo,admin:repo_hook (the account must administer ${session.inputs.repository})` });
  const observation = preflight.every(item => item.ok) ? await adapter.observe(context) : { installed: false, database: false, app: false, url: null, variables: {}, detail: ['provider preflight is incomplete; the installation was not inspected'] } as AdapterObservation;

  const core = coreEnv(session);
  const drift: PlanDrift[] = [];
  const actions: PlanAction[] = [];
  const existing = !!record || observation.installed;

  actions.push({
    id: 'local.credentials', target: 'local', state: record ? 'satisfied' : 'create',
    title: `Generate one credential per principal under ${session.directory} (mode 0600) and never write it to the repository`,
    values: session.principals.map(principal => {
      const token = session.tokens.get(principal.id);
      const role = `${principal.role}${principal.proofs?.length ? ` limited to ${principal.proofs.join(', ')}` : ''}`;
      return { name: principal.id, value: REDACTED, secret: true, note: token ? role : `${role}; ${PENDING}`, ...(token ? { fingerprint: fingerprint(token) } : {}) };
    }),
  });
  actions.push(...adapter.plan(context, observation));

  const coreDrift = variableDrift(session, 'provider.env.core', core, observation.variables);
  drift.push(...coreDrift);
  actions.push({ id: 'provider.env.core', target: 'provider', state: !observation.installed ? 'create' : coreDrift.length ? 'update' : 'satisfied', title: 'Set the control-plane variables on the application service', values: core.map(value => planValue(value, session.materialized)), drift: coreDrift });
  actions.push({ id: 'provider.deploy', target: 'provider', state: observation.app ? 'update' : 'create', title: 'Deploy the application and wait for it to become healthy' });
  actions.push({ id: 'provider.url', target: 'provider', state: observation.url ? 'satisfied' : 'create', title: context.domain ? `Bind ${context.domain} to the service over HTTPS` : 'Obtain the public HTTPS URL of the service', values: observation.url ? [{ name: 'url', value: observation.url, secret: false }] : [] });
  actions.push({ id: 'verify.health', target: 'graphyard', state: 'update', title: 'Verify GET /healthz returns {"ok":true}' });

  const appConfigured = !!record?.github;
  actions.push({ id: 'github.app', target: 'github', state: appConfigured ? 'satisfied' : 'create', title: 'Register the Graphyard GitHub App through the manifest flow and install it on the managed repository', human: 'One browser confirmation: create the App, then choose the managed repository. GitHub returns the App ID, private key, and webhook secret directly to this machine.' });
  actions.push({ id: 'github.env', target: 'provider', state: appConfigured ? 'satisfied' : 'create', title: 'Write the App ID, installation ID, private key, and webhook secret to the server', values: [
    { name: 'GITHUB_APP_ID', value: record?.github ? String(record.github.appId) : '<from the App manifest flow>', secret: false },
    { name: 'GITHUB_INSTALLATION_ID', value: record?.github ? String(record.github.installationId) : '<from the App installation>', secret: false },
    { name: 'GITHUB_PRIVATE_KEY', value: REDACTED, secret: true },
    { name: 'GITHUB_WEBHOOK_SECRET', value: REDACTED, secret: true, ...(record?.github ? { fingerprint: record.github.webhookFingerprint } : { note: 'returned by the App manifest flow' }) },
  ] });
  actions.push({ id: 'github.webhook', target: 'github', state: appConfigured ? 'update' : 'create', title: `Point the App webhook at ${observation.url ? webhookUrlFor(observation.url) : '<service URL>/api/github/webhook'} with the shared secret the server holds` });
  actions.push({ id: 'github.ci-app-ids', target: 'github', state: record?.github?.ciAppIds.length ? 'satisfied' : 'create', title: `Detect the GitHub App IDs publishing checks on ${session.inputs.baseBranch} and set GITHUB_CI_APP_IDS`, values: record?.github?.ciAppIds.length ? [{ name: 'GITHUB_CI_APP_IDS', value: record.github.ciAppIds.join(','), secret: false }] : [] });

  const protection = preflight.some(item => item.name === 'GitHub CLI' && item.ok) ? await readProtection(gh, session.inputs.repository, session.inputs.baseBranch) : null;
  const protectionInputs = { repository: session.inputs.repository, branch: session.inputs.baseBranch, requiredChecks: session.requiredChecks, graphyardAppId: record?.github?.appId ?? null, reviewCount: session.reviewCount };
  const protectionOk = protectionSatisfied(protectionInputs, protection);
  // A branch that already demands more reviewers keeps its own count; the plan says so.
  const plannedReviews = effectiveReviewCount(protectionInputs, protection);
  const reviewPhrase = plannedReviews > session.reviewCount
    ? `${plannedReviews} approving review(s), the stricter count this branch already requires`
    : `at least ${session.reviewCount} approving review(s) for the ${session.reviewPolicy} review policy`;
  if (protection && !protectionOk) drift.push({ action: 'github.protection', field: 'branch protection', expected: `strict checks ${[...session.requiredChecks, CHECK_NAME].join(', ')}; at least ${session.reviewCount} approving review(s); admin enforcement; conversation resolution`, observed: describeProtection(protection) });
  actions.push({ id: 'github.protection', target: 'github', state: protectionOk ? 'satisfied' : protection ? 'update' : 'create', title: `Require strict status checks (${[...session.requiredChecks, CHECK_NAME].join(', ')}), ${reviewPhrase}, conversation resolution, and administrator enforcement on ${session.inputs.baseBranch}` });
  if (session.inputs.reviewer) actions.push({ id: 'github.reviewer', target: 'github', state: record?.reviewers.some(reviewer => reviewer.name === session.inputs.reviewer) ? 'satisfied' : 'create', title: `Register the reviewer App "${session.inputs.reviewer}" and add its identity to GRAPHYARD_REVIEWER_APPS`, human: 'One additional browser confirmation, because a reviewer is a separate GitHub identity with no control-plane authority.' });

  actions.push({ id: 'verify.status', target: 'graphyard', state: 'update', title: 'Verify authenticated GET /api/status reports the admin actor, the managed repository, and the bound App' });
  actions.push({ id: 'verify.webhook', target: 'graphyard', state: 'update', title: 'Publish one neutral check run and confirm GitHub delivered it to the server' });
  actions.push({ id: 'local.profiles', target: 'local', state: record?.profiles.length ? 'satisfied' : 'create', title: 'Register master, reviewer, and worker profiles for authenticated agent runtimes on this machine' });
  actions.push({ id: 'local.herdr', target: 'local', state: 'update', title: 'Bind Herdr when it is installed: link and enable the Graphyard plugin for this repository' });

  if (record && record.provider !== context.provider) drift.push({ action: 'local.credentials', field: 'provider', expected: context.provider, observed: record.provider });
  if (record && record.repository.toLowerCase() !== session.inputs.repository.toLowerCase()) drift.push({ action: 'local.credentials', field: 'repository', expected: session.inputs.repository, observed: record.repository });
  if (record && (record.domain ?? null) !== (context.domain ?? null)) drift.push({ action: 'provider.url', field: 'domain', expected: context.domain ?? 'provider-assigned', observed: record.domain ?? 'provider-assigned' });

  const plan: InstallPlan = {
    version: 1, repository: session.inputs.repository, provider: context.provider, installId: session.installId,
    installDirectory: session.directory, baseBranch: session.inputs.baseBranch, reviewPolicy: session.reviewPolicy,
    domain: context.domain, url: observation.url ?? record?.url ?? null, existing, secretsRedacted: true,
    preflight, principals: session.principals, actions, drift,
    humanSteps: [...CORE_HUMAN_STEPS, ...(session.inputs.reviewer ? [`Confirm the separate reviewer App "${session.inputs.reviewer}" in the browser.`] : [])],
  };
  const serialized = JSON.stringify(plan);
  session.vault.assertClean(serialized, 'the installation plan');
  return session.vault.scrub(plan);
}

function describeProtection(protection: any) {
  const checks = (protection?.required_status_checks?.checks ?? []).map((check: any) => `${check.context}${check.app_id ? ` (app ${check.app_id})` : ''}`);
  return `strict=${!!protection?.required_status_checks?.strict}; checks ${checks.join(', ') || 'none'}; reviews ${protection?.required_pull_request_reviews?.required_approving_review_count ?? 0}; enforce_admins=${!!protection?.enforce_admins?.enabled}; conversation_resolution=${!!protection?.required_conversation_resolution?.enabled}; force_pushes=${!!protection?.allow_force_pushes?.enabled}; deletions=${!!protection?.allow_deletions?.enabled}`;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface InstallSummary {
  repository: string; provider: Provider; installId: string; installDirectory: string;
  url: string; webhookUrl: string; check: string; reviewers: { name: string; appId: number; botUserId: number }[];
  principals: { id: string; role: string; fingerprint: string; tokenFile: string }[];
  github: { appId: number; installationId: number; slug: string; ciAppIds: number[] } | null;
  protection: string; health: boolean; status: { actor: string; role: string; repository: string; githubAppId: number | null };
  webhook: DeliveryProof; profiles: ProfileRegistration; drift: PlanDrift[]; nextSteps: string[];
}

export async function applyInstall(session: InstallSession, plan: InstallPlan): Promise<InstallSummary> {
  const { adapter, context, deps, vault } = session;
  if (session.mode !== 'apply') throw new Error('Apply requires a session prepared in apply mode; --plan sessions create nothing');
  const log = (line: string) => deps.log(vault.scrub(line));
  // The gate comes before anything is written, so "changed nothing" is literally true: at this
  // point not even a credential file exists yet for a first install.
  const blocked = plan.preflight.filter(item => !item.ok);
  if (blocked.length) throw new Error(`Preflight is incomplete; the installer changed nothing.\n${blocked.map(item => `- ${item.name}: ${item.detail}${item.fix ? `\n  Run: ${item.fix}` : ''}`).join('\n')}`);
  await materializeInstall(session);

  const observation = await adapter.observe(context);
  log(`Provisioning ${context.provider} for ${session.inputs.repository}`);
  await adapter.provision(context, observation);
  await adapter.setEnv(context, coreEnv(session));
  await adapter.deploy(context);
  const url = await adapter.url(context);
  log(`Service URL: ${url}`);
  const health = await waitForHealth(session, url);
  if (!health) throw new Error(`The service at ${url} did not become healthy. Inspect: graphyard install --provider ${context.provider} --repo ${session.inputs.repository} --logs`);

  let record = session.record ?? emptyRecord(session, url);
  record = { ...record, url, domain: context.domain, provider: context.provider, baseBranch: session.inputs.baseBranch, reviewPolicy: session.reviewPolicy, principals: session.principals.map(principal => ({ id: principal.id, role: principal.role, ...(principal.proofs?.length ? { proofs: principal.proofs } : {}), fingerprint: fingerprint(session.tokens.get(principal.id)!) })), updatedAt: new Date(deps.now()).toISOString() };
  await writeInstallRecord(session.directory, record, vault);

  // GitHub: the App manifest flow needs the live HTTPS origin, so it runs after the URL exists.
  const facts = await resolveApp(session, url, record);
  vault.add(facts.privateKey); vault.add(facts.webhookSecret);
  if (session.inputs.reviewer && !session.reviewers.some(reviewer => reviewer.name === session.inputs.reviewer)) {
    const reviewerFacts = await deps.githubApp!({ root: session.root, repository: session.inputs.repository, origin: url, reviewer: session.inputs.reviewer });
    if (!reviewerFacts.botUserId) throw new Error('GitHub did not return the reviewer bot identity; rerun the reviewer registration');
    if (reviewerFacts.appId === facts.appId) throw new Error('A reviewer App must be a different identity from the Graphyard control-plane App');
    session.reviewers = [...session.reviewers, { name: session.inputs.reviewer, appId: reviewerFacts.appId, botUserId: reviewerFacts.botUserId }];
    log(`Registered reviewer App ${session.inputs.reviewer} (app ${reviewerFacts.appId})`);
  }
  const gh = githubCli(context.transport);
  const ciApps = await detectCiAppIds(gh, session.inputs.repository, session.inputs.baseBranch, facts.appId);
  log(`CI App identities on ${session.inputs.baseBranch}: ${ciApps.map(app => `${app.slug} (${app.appId})`).join(', ') || 'none observed yet'}`);
  await adapter.setEnv(context, [...coreEnv(session), ...githubEnv(facts, ciApps.map(app => app.appId))]);
  await adapter.deploy(context);
  if (!await waitForHealth(session, url)) throw new Error('The service did not return to health after the GitHub credentials were written');

  const app = appClient(facts, deps.fetch);
  const webhookConfig = await readWebhookConfig(app);
  if (webhookConfig?.url !== webhookUrlFor(url)) log(`Repointing the App webhook to ${webhookUrlFor(url)}`);
  await configureWebhook(app, url, facts.webhookSecret);

  const protectionInputs = { repository: session.inputs.repository, branch: session.inputs.baseBranch, requiredChecks: session.requiredChecks, graphyardAppId: facts.appId, reviewCount: session.reviewCount };
  const current = await readProtection(gh, session.inputs.repository, session.inputs.baseBranch);
  // The App-bound merge check is added only once Graphyard has published it; requiring a
  // context that does not exist yet would block every pull request on the repository.
  const mergeCheckExists = (current?.required_status_checks?.checks ?? []).some((check: any) => check.context === CHECK_NAME)
    || (await detectCiAppIds(gh, session.inputs.repository, session.inputs.baseBranch, null)).some(entry => entry.appId === facts.appId);
  const applied = protectionSatisfied(protectionInputs, current) ? null : await applyProtection(gh, { ...protectionInputs, graphyardAppId: mergeCheckExists ? facts.appId : null });
  const protectionDetail = applied
    ? `strict checks ${applied.required_status_checks.checks.map(check => check.context).join(', ')}; ${applied.required_pull_request_reviews.required_approving_review_count} approving review(s); admin enforcement`
    : `already matches the ${session.reviewPolicy} review policy`;

  const status = await authenticatedStatus(session, url);
  const installation = installationClient(facts, deps.fetch);
  const since = deps.now();
  let webhook: DeliveryProof;
  try {
    await triggerDelivery(installation, session.inputs.repository, await headSha(gh, session.inputs.repository, session.inputs.baseBranch));
    webhook = await verifyDelivery(app, since, deps.wait);
  } catch (error: any) { webhook = { delivered: false, statusCode: null, event: null, at: null, detail: vault.scrub(`Could not publish the verification event: ${error.message}`) }; }

  const profiles = await registerProfiles(session, url);
  record = installRecordSchema.parse({
    ...record,
    github: { appId: facts.appId, installationId: facts.installationId, slug: facts.slug, webhookFingerprint: fingerprint(facts.webhookSecret), ciAppIds: ciApps.map(entry => entry.appId) },
    reviewers: session.reviewers,
    profiles: [
      ...(profiles.master.configured ? [{ name: 'master', principal: principalOfRole(session.principals, 'coordinator').id, kind: profiles.master.kind ?? 'unknown', role: 'master' as const }] : []),
      ...profiles.workers.map(worker => ({ name: worker.name, principal: worker.principal, kind: worker.kind, role: 'worker' as const })),
      ...profiles.reviewers.map(reviewer => ({ name: reviewer.name, principal: reviewer.name, kind: reviewer.runtime, role: 'reviewer' as const })),
    ],
    updatedAt: new Date(deps.now()).toISOString(),
  });
  await writeInstallRecord(session.directory, record, vault);

  const summary: InstallSummary = {
    repository: session.inputs.repository, provider: context.provider, installId: session.installId, installDirectory: session.directory,
    url, webhookUrl: webhookUrlFor(url), check: CHECK_NAME, reviewers: session.reviewers,
    principals: session.principals.map(principal => ({ id: principal.id, role: principal.role, fingerprint: fingerprint(session.tokens.get(principal.id)!), tokenFile: tokenFile(session.directory, principal.id) })),
    github: { appId: facts.appId, installationId: facts.installationId, slug: facts.slug, ciAppIds: ciApps.map(entry => entry.appId) },
    protection: protectionDetail, health, status, webhook, profiles, drift: plan.drift,
    nextSteps: nextSteps(session, url, mergeCheckExists, webhook, profiles),
  };
  const serialized = JSON.stringify(summary);
  vault.assertClean(serialized, 'the installation summary');
  return vault.scrub(summary);
}

function emptyRecord(session: InstallSession, url: string): InstallRecord {
  const at = new Date(session.deps.now()).toISOString();
  return installRecordSchema.parse({ version: 1, installId: session.installId, repository: session.inputs.repository, provider: session.context.provider, baseBranch: session.inputs.baseBranch, reviewPolicy: session.reviewPolicy, domain: session.context.domain, url, principals: [], github: null, reviewers: [], profiles: [], createdAt: at, updatedAt: at });
}

async function waitForHealth(session: InstallSession, url: string, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await session.adapter.health(session.context, url)) return true;
    await session.deps.wait(3_000);
  }
  return false;
}

async function authenticatedStatus(session: InstallSession, url: string) {
  const admin = principalOfRole(session.principals, 'admin');
  const token = session.tokens.get(admin.id)!;
  const response = await session.deps.fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Authenticated /api/status failed (${response.status}); the server did not accept the generated admin credential`);
  const body = await response.json() as any;
  if (body?.actor?.role !== 'admin') throw new Error('The generated admin credential did not authenticate as an admin actor');
  if (String(body?.repository ?? '').toLowerCase() !== session.inputs.repository.toLowerCase()) throw new Error('The server is bound to a different repository than the one being installed');
  return { actor: String(body.actor.id), role: String(body.actor.role), repository: String(body.repository), githubAppId: body.githubAppId ?? null };
}

async function resolveApp(session: InstallSession, url: string, record: InstallRecord): Promise<AppFacts & { slug: string }> {
  const { deps } = session;
  if (!deps.githubApp) throw new Error('No GitHub App flow is available in this environment');
  const facts = await deps.githubApp({ root: session.root, repository: session.inputs.repository, origin: url });
  if (record.github && record.github.appId !== facts.appId) session.deps.log(`GitHub App changed from ${record.github.appId} to ${facts.appId}`);
  return facts;
}

async function registerProfiles(session: InstallSession, url: string): Promise<ProfileRegistration> {
  const { context, deps } = session;
  const runtimes = await (deps.detectRuntimes ?? detectRuntimes)(context.transport);
  const herdr = await (deps.detectHerdr ?? detectHerdr)(context.transport);
  const workerIds = workerPrincipals(session.principals).map(principal => principal.id);
  const workers = workerProfiles(session.installId, workerIds, runtimes, principal => tokenFile(session.directory, principal));
  const reviewers = reviewerProfiles(runtimes, session.inputs.reviewer ?? null);
  const master = masterRuntime(runtimes);
  const request: ProfileRequest = {
    root: session.root, url, cliPath: deps.cliPath ?? fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url)),
    hostId: deps.hostId ?? hostname(), installDirectory: session.directory,
    coordinatorToken: session.tokens.get(principalOfRole(session.principals, 'coordinator').id)!,
    workerTokens: workerIds.map(principal => ({ principal, token: session.tokens.get(principal)! })),
    runtimes, herdr, workers, reviewers, masterKind: master?.kind ?? null,
    ...(deps.runHerdr ? { runHerdr: deps.runHerdr } : {}),
  };
  if (deps.registerProfiles) return deps.registerProfiles(request);
  const { registerLocalProfiles } = await import('./profiles.js');
  return registerLocalProfiles(request);
}

function nextSteps(session: InstallSession, url: string, mergeCheckExists: boolean, webhook: DeliveryProof, profiles: ProfileRegistration) {
  const steps = [
    `Open ${url} and sign in with the credential in ${tokenFile(session.directory, principalOfRole(session.principals, 'admin').id)}.`,
    'Create the first work item with acceptance criteria, mark it ready, and dispatch a worker.',
  ];
  if (!mergeCheckExists) steps.push(`Rerun "graphyard install --provider ${session.context.provider} --repo ${session.inputs.repository} --apply" after Graphyard publishes "${CHECK_NAME}" on the first pull request, so branch protection can require the App-bound check.`);
  if (!webhook.delivered) steps.push(`Webhook delivery is unconfirmed: ${webhook.detail}`);
  if (!profiles.workers.length) steps.push('No authenticated agent runtime was found on this machine; sign in to a supported runtime and rerun --apply, or add a worker profile with "graphyard master worker add".');
  if (!session.principals.some(principal => principal.role === 'producer')) steps.push('No proof producer was created. Add one with --producer-proof NAME for each proof that CI may submit; a producer must never be given to an implementation worker.');
  steps.push('Never copy an admin, coordinator, or producer credential into a worker session.');
  return steps;
}
