// Operator-only bootstrap helper. Default is a plan; no credentials are printed or committed.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { contracts } from './contracts.mjs';
import { register } from 'tsx/esm/api';
register();
const { delegationLimitAssignments, readDeployedDelegationLimits } = await import('../src/install/limits.ts');
const { ciProducerId, ciProducerSecret, ciProducerGrants, withCiProducer } = await import('../src/install/ci-proofs.ts');
const apply = process.argv.includes('--apply');
const root = new URL('../', import.meta.url), repository = 'cryptob1/graphyard';
const url = 'https://graphyard-production.up.railway.app';
const railway = ['--yes', '--cache', '/tmp/graphyard-npm-cache', '@railway/cli'];
let stage = 'read local setup';
try {
  let app;
  try { app = JSON.parse(await readFile(new URL('.graphyard/github-app.json', root), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!apply) {
    console.log(JSON.stringify({ repository, url, appRegistered: !!app?.appId, installationVerified: !!app?.installationId,
      changes: ['Restrict graphyard-reporting environment to main only', 'Send App credentials to Railway secret variables', `Generate a producer scoped to ${Object.keys(contracts).join(' and ')} in memory; store only in Railway and the restricted GitHub environment`, `Generate the ${ciProducerId} CI producer scoped to ${ciProducerGrants.join(' and ')} (never manual:* or e2e:*) with runtime github-actions (its token is kept when .graphyard/credentials.json carries one, otherwise rotated like the reporter credential); store it only in Railway and as ${ciProducerSecret} in the restricted environment`, 'Derive the GRAPHYARD_MAX_*/MIN_* capacity variables from the principal set including that producer, report drift against the deployed values, and set them beside GRAPHYARD_PRINCIPALS', 'Set Graphyard URL on that environment', 'Stage variables without deploying; preview Railway IaC before rollout'],
      blockedBy: !app?.installationId ? 'Complete graphyard github-setup and install the App first' : null }, null, 2));
    process.exit(0);
  }
  if (!app?.installationId || app.repository !== repository) throw new Error('Complete local App registration and installation first');
  const principals = JSON.parse(await readFile(new URL('.graphyard/credentials.json', root), 'utf8'));
  const gh = (args, input) => execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const endpoint = `repos/${repository}/environments/graphyard-reporting`;
  stage = 'restrict reporter environment';
  gh(['api', '--method', 'PUT', endpoint, '--input', '-'], JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }));
  let policies = JSON.parse(gh(['api', `${endpoint}/deployment-branch-policies`])).branch_policies;
  if (!policies.length) gh(['api', '--method', 'POST', `${endpoint}/deployment-branch-policies`, '--input', '-'], JSON.stringify({ name: 'main', type: 'branch' }));
  policies = JSON.parse(gh(['api', `${endpoint}/deployment-branch-policies`])).branch_policies;
  if (policies.length !== 1 || policies[0].name !== 'main' || policies[0].type !== 'branch') throw new Error('Reporter environment must allow only main');
  // The reporter may publish exactly the protected contract inventories and nothing else.
  const producer = { id: 'trusted-acceptance', role: 'producer', proofs: Object.keys(contracts), token: randomBytes(32).toString('hex') };
  // The CI lane's producer publishes what the protected workflow ran on each candidate push. Its
  // token is kept when credentials.json carries one; otherwise a rerun rotates it with the secret.
  const roster = withCiProducer([...principals.filter(p => p.id !== producer.id), producer]);
  const ciProducer = roster.find(p => p.id === ciProducerId);
  // The producer generated here counts toward GRAPHYARD_MAX_REVIEWERS like every other one, so the
  // capacity variables are derived from the roster this run deploys — not from credentials.json
  // alone — and drift against what the deployment runs with now is reported before they are set.
  stage = 'derive delegation capacity variables';
  let deployed = null;
  const operator = principals.find(p => p.role === 'admin');
  if (operator) {
    const live = await readDeployedDelegationLimits(url, operator.token);
    if (live.error) console.error(live.error);
    deployed = live.deployed;
  }
  const limits = delegationLimitAssignments(roster, deployed);
  for (const entry of limits.drift) console.error(`Drift: ${entry.reason}`);
  const variables = { GITHUB_APP_ID: String(app.appId), GITHUB_INSTALLATION_ID: String(app.installationId), GITHUB_PRIVATE_KEY: app.privateKey, GITHUB_WEBHOOK_SECRET: app.webhookSecret,
    GRAPHYARD_PRINCIPALS: JSON.stringify(roster), ...limits.variables };
  stage = 'stage Railway secret variables';
  for (const [key, value] of Object.entries(variables)) execFileSync('npx', [...railway, 'variable', 'set', '--service', 'graphyard', '--skip-deploys', '--stdin', key], { input: value, stdio: ['pipe', 'ignore', 'pipe'] });
  stage = 'store restricted reporter credential';
  gh(['secret', 'set', 'GRAPHYARD_PRODUCER_TOKEN', '--repo', repository, '--env', 'graphyard-reporting'], producer.token);
  gh(['secret', 'set', ciProducerSecret, '--repo', repository, '--env', 'graphyard-reporting'], ciProducer.token);
  gh(['variable', 'set', 'GRAPHYARD_URL', '--repo', repository, '--env', 'graphyard-reporting', '--body', url]);
  console.log(`Integrations configured without printing credentials; capacity set to ${limits.lines.join(' ')}${limits.drift.length ? ` (corrected ${limits.drift.map(entry => entry.variable).join(', ')})` : ''}. No deployment triggered. Preview .railway/railway.ts, deploy reviewed code, then verify the App-owned check before requiring it.`);
} catch { console.error(`Configuration stopped at: ${stage}. No credential values are logged. Correct the setup and rerun; a rerun rotates the dedicated reporter credential.`); process.exitCode = 1; }
