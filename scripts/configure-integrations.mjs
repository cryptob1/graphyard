// Operator-only bootstrap helper. Default is a plan; no credentials are printed or committed.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
      changes: ['Restrict graphyard-reporting environment to main only', 'Send App credentials to Railway secret variables', 'Generate a proof-scoped producer in memory; store only in Railway and the restricted GitHub environment', 'Set Graphyard URL on that environment', 'Stage variables without deploying; preview Railway IaC before rollout'],
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
  const producer = { id: 'trusted-acceptance', role: 'producer', proofs: ['integration:claim-safety', 'integration:merge-authorization'], token: randomBytes(32).toString('hex') };
  const variables = { GITHUB_APP_ID: String(app.appId), GITHUB_INSTALLATION_ID: String(app.installationId), GITHUB_PRIVATE_KEY: app.privateKey, GITHUB_WEBHOOK_SECRET: app.webhookSecret,
    GRAPHYARD_PRINCIPALS: JSON.stringify([...principals.filter(p => p.id !== producer.id), producer]) };
  stage = 'stage Railway secret variables';
  for (const [key, value] of Object.entries(variables)) execFileSync('npx', [...railway, 'variable', 'set', '--service', 'graphyard', '--skip-deploys', '--stdin', key], { input: value, stdio: ['pipe', 'ignore', 'pipe'] });
  stage = 'store restricted reporter credential';
  gh(['secret', 'set', 'GRAPHYARD_PRODUCER_TOKEN', '--repo', repository, '--env', 'graphyard-reporting'], producer.token);
  gh(['variable', 'set', 'GRAPHYARD_URL', '--repo', repository, '--env', 'graphyard-reporting', '--body', url]);
  console.log('Integrations configured without printing credentials. No deployment triggered. Preview .railway/railway.ts, deploy reviewed code, then verify the App-owned check before requiring it.');
} catch { console.error(`Configuration stopped at: ${stage}. No credential values are logged. Correct the setup and rerun; a rerun rotates the dedicated reporter credential.`); process.exitCode = 1; }
