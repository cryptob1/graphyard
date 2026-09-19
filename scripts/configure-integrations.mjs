// Operator-only bootstrap helper. Default is a plan; no credentials are printed or committed.
//
// Principal rotation is a merge into the roster the deployment runs with, never a replacement by
// whatever .graphyard/credentials.json happens to hold: the live GRAPHYARD_PRINCIPALS is read from
// Railway first, local entries update or add by id, and a live principal leaves only when named
// with --remove ID. The preview names ids, roles and token changes and never a token. A token is
// rotated only when named with --rotate ID (or when none exists yet), and a rotated producer token
// reaches its GitHub secret only after the deployed server authenticates it, so the secret and the
// deployed roster never disagree.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const trustedAcceptanceId = 'trusted-acceptance';
/** The GitHub secret each generated producer's token is stored in, beside the deployed roster. */
export const producerSecrets = { [trustedAcceptanceId]: 'GRAPHYARD_PRODUCER_TOKEN', 'ci-proofs': 'GRAPHYARD_CI_PRODUCER_TOKEN' };

/** The command-line choices: --apply, --deploy, and each --rotate ID / --remove ID. */
export function parseOptions(argv) {
  const named = flag => argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]] : value.startsWith(`${flag}=`) ? [value.slice(flag.length + 1)] : []);
  return { apply: argv.includes('--apply'), deploy: argv.includes('--deploy'), rotate: named('--rotate'), remove: named('--remove') };
}

/**
 * The roster this run deploys: every live principal, each local entry replacing the live one of its
 * id or adding a new one, less the principals named for removal. Nothing live is dropped because a
 * local file happens to be partial.
 */
export function mergeRoster(live, local, remove = []) {
  const merged = new Map(live.map(entry => [entry.id, entry]));
  for (const entry of local) merged.set(entry.id, entry);
  for (const id of remove) merged.delete(id);
  return [...merged.values()];
}

/** A generated producer: its live token kept unless it is named for rotation or has none yet. */
export function generatedProducer(live, id, shape, rotate = [], token = () => randomBytes(32).toString('hex')) {
  const kept = live.find(entry => entry.id === id)?.token;
  return { ...shape, id, token: !rotate.includes(id) && typeof kept === 'string' && kept.length >= 32 ? kept : token() };
}

/**
 * Refuses a roster that drops the coordinator, an admin, or any live principal that was not named
 * with --remove, and a --rotate or --remove naming nobody. Returns nothing when the roster is safe.
 */
export function assertRosterSafe(live, next, { remove = [], rotate = [] } = {}) {
  const ids = new Set(next.map(entry => entry.id));
  const refusals = [];
  for (const id of [...remove, ...rotate]) if (!live.some(entry => entry.id === id) && !(rotate.includes(id) && ids.has(id))) refusals.push(`${id} is not in the live roster`);
  const dropped = live.filter(entry => !ids.has(entry.id));
  for (const entry of dropped) if (!remove.includes(entry.id)) refusals.push(`${entry.id} (${entry.role}) is live and would be dropped; name it with --remove ${entry.id} to remove it`);
  // A coordinator or admin demoted by a local entry is dropped from its role just the same.
  for (const entry of live) {
    const after = next.find(candidate => candidate.id === entry.id);
    if (after && after.role !== entry.role && ['coordinator', 'admin'].includes(entry.role) && !remove.includes(entry.id)) refusals.push(`${entry.id} would change role from ${entry.role} to ${after.role}; name it with --remove ${entry.id} and add it again to change it`);
  }
  if (refusals.length) throw new Error(`Refusing the principal roster: ${refusals.join('; ')}`);
}

/** What changes, by id and role, with every token described and none printed. */
export function rosterPreview(live, next) {
  const rows = next.map(entry => {
    const before = live.find(candidate => candidate.id === entry.id);
    const token = !before ? 'new' : before.token === entry.token ? 'unchanged' : 'rotated';
    const change = !before ? 'added' : before.role !== entry.role ? `role ${before.role} -> ${entry.role}` : token === 'rotated' || JSON.stringify({ ...before, token: null }) !== JSON.stringify({ ...entry, token: null }) ? 'updated' : 'kept';
    return { id: entry.id, role: entry.role, change, token };
  });
  for (const entry of live) if (!next.some(candidate => candidate.id === entry.id)) rows.push({ id: entry.id, role: entry.role, change: 'removed', token: 'removed' });
  return rows;
}

/** The GitHub secrets whose producer token this roster changes; only these are ever set. */
export function secretsToSync(live, next) {
  return Object.entries(producerSecrets).flatMap(([id, secret]) => {
    const after = next.find(entry => entry.id === id);
    return after && live.find(entry => entry.id === id)?.token !== after.token ? [{ id, secret, token: after.token }] : [];
  });
}

/**
 * Waits until the deployed server authenticates each token as its principal. Only then may the
 * GitHub secret holding it change; a token the deployment does not serve yet stays unsynced.
 */
export async function awaitServedTokens(url, principals, { fetcher = fetch, timeoutMs = 600_000, intervalMs = 10_000, wait = ms => sleep(ms), clock = Date.now } = {}) {
  const deadline = clock() + timeoutMs;
  let pending = [...principals];
  for (;;) {
    const results = await Promise.all(pending.map(async entry => {
      try {
        const response = await fetcher(`${url}/api/status`, { headers: { Authorization: `Bearer ${entry.token}` }, signal: AbortSignal.timeout(15_000) });
        return response.ok && (await response.json())?.actor?.id === entry.id;
      } catch { return false; }
    }));
    pending = pending.filter((_, index) => !results[index]);
    if (!pending.length || clock() >= deadline) break;
    await wait(intervalMs);
  }
  return { served: principals.filter(entry => !pending.includes(entry)).map(entry => entry.id), pending: pending.map(entry => entry.id) };
}

async function main() {
  const { register } = await import('tsx/esm/api');
  register();
  const { contracts } = await import('./contracts.mjs');
  const { delegationLimitAssignments, readDeployedDelegationLimits } = await import('../src/install/limits.ts');
  const { ciProducerId, ciProducerSecret, ciProducerGrants, withCiProducer } = await import('../src/install/ci-proofs.ts');
  const options = parseOptions(process.argv.slice(2));
  const apply = options.apply;
  const root = new URL('../', import.meta.url), repository = 'cryptob1/graphyard';
  const url = 'https://graphyard-production.up.railway.app';
  const railway = ['--yes', '--cache', '/tmp/graphyard-npm-cache', '@railway/cli'];
  let stage = 'read local setup';
  try {
    let app;
    try { app = JSON.parse(await readFile(new URL('.graphyard/github-app.json', root), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!apply) {
      console.log(JSON.stringify({ repository, url, appRegistered: !!app?.appId, installationVerified: !!app?.installationId,
        changes: ['Restrict graphyard-reporting environment to main only', 'Send App credentials to Railway secret variables', 'Read the live GRAPHYARD_PRINCIPALS from Railway and merge .graphyard/credentials.json into it by id; a live principal leaves only when named with --remove ID, and the coordinator, admins and live principals are never dropped silently', `Keep the ${trustedAcceptanceId} producer scoped to ${Object.keys(contracts).join(' and ')} and its live token; rotate it only with --rotate ${trustedAcceptanceId}`, `Keep the ${ciProducerId} CI producer scoped to ${ciProducerGrants.join(' and ')} (never manual:* or e2e:*) with runtime github-actions and its live token; rotate it only with --rotate ${ciProducerId}`, 'Print the roster preview by id, role and token change (never a token value)', 'Derive the GRAPHYARD_MAX_*/MIN_* capacity variables from the merged roster, report drift against the deployed values, and set them beside GRAPHYARD_PRINCIPALS', 'Set Graphyard URL on that environment', 'Stage variables without deploying when no token changes; a changed token requires --deploy, which redeploys and sets its GitHub secret only once the deployment authenticates it'],
        options, blockedBy: !app?.installationId ? 'Complete graphyard github-setup and install the App first' : null }, null, 2));
      process.exit(0);
    }
    if (!app?.installationId || app.repository !== repository) throw new Error('Complete local App registration and installation first');
    const local = JSON.parse(await readFile(new URL('.graphyard/credentials.json', root), 'utf8'));
    stage = 'read the live principal roster';
    const liveVariables = JSON.parse(execFileSync('npx', [...railway, 'variable', 'list', '--service', 'graphyard', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const live = liveVariables.GRAPHYARD_PRINCIPALS ? JSON.parse(liveVariables.GRAPHYARD_PRINCIPALS) : [];
    const principals = mergeRoster(live, local, options.remove).map(entry => entry.id === ciProducerId && options.rotate.includes(ciProducerId) ? { ...entry, token: undefined } : entry);
    const gh = (args, input) => execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const endpoint = `repos/${repository}/environments/graphyard-reporting`;
    // The reporter may publish exactly the protected contract inventories and nothing else.
    const producer = generatedProducer(live, trustedAcceptanceId, { role: 'producer', proofs: Object.keys(contracts) }, options.rotate);
    // The CI lane's producer publishes what the protected workflow ran on each candidate push. Its
    // token is kept from the live roster; --rotate ci-proofs rotates it with the secret.
    const roster = withCiProducer([...principals.filter(p => p.id !== producer.id), producer]);
    stage = 'check the merged roster';
    assertRosterSafe(live, roster, options);
    const secrets = secretsToSync(live, roster);
    console.log(JSON.stringify({ roster: rosterPreview(live, roster), secrets: secrets.map(entry => ({ id: entry.id, secret: entry.secret })) }, null, 2));
    if (secrets.length && !options.deploy) throw Object.assign(new Error(`The roster changes the token behind ${secrets.map(entry => entry.secret).join(', ')}; rerun with --deploy so the deployment and the secret change together`), { visible: true });
    stage = 'restrict reporter environment';
    gh(['api', '--method', 'PUT', endpoint, '--input', '-'], JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }));
    let policies = JSON.parse(gh(['api', `${endpoint}/deployment-branch-policies`])).branch_policies;
    if (!policies.length) gh(['api', '--method', 'POST', `${endpoint}/deployment-branch-policies`, '--input', '-'], JSON.stringify({ name: 'main', type: 'branch' }));
    policies = JSON.parse(gh(['api', `${endpoint}/deployment-branch-policies`])).branch_policies;
    if (policies.length !== 1 || policies[0].name !== 'main' || policies[0].type !== 'branch') throw new Error('Reporter environment must allow only main');
    // The producer generated here counts toward GRAPHYARD_MAX_REVIEWERS like every other one, so the
    // capacity variables are derived from the roster this run deploys — not from credentials.json
    // alone — and drift against what the deployment runs with now is reported before they are set.
    stage = 'derive delegation capacity variables';
    let deployed = null;
    const operator = roster.find(p => p.role === 'admin');
    if (operator) {
      const liveLimits = await readDeployedDelegationLimits(url, operator.token);
      if (liveLimits.error) console.error(liveLimits.error);
      deployed = liveLimits.deployed;
    }
    const limits = delegationLimitAssignments(roster, deployed);
    for (const entry of limits.drift) console.error(`Drift: ${entry.reason}`);
    const variables = { GITHUB_APP_ID: String(app.appId), GITHUB_INSTALLATION_ID: String(app.installationId), GITHUB_PRIVATE_KEY: app.privateKey, GITHUB_WEBHOOK_SECRET: app.webhookSecret,
      GRAPHYARD_PRINCIPALS: JSON.stringify(roster), ...limits.variables };
    stage = 'stage Railway secret variables';
    for (const [key, value] of Object.entries(variables)) execFileSync('npx', [...railway, 'variable', 'set', '--service', 'graphyard', '--skip-deploys', '--stdin', key], { input: value, stdio: ['pipe', 'ignore', 'pipe'] });
    gh(['variable', 'set', 'GRAPHYARD_URL', '--repo', repository, '--env', 'graphyard-reporting', '--body', url]);
    if (!secrets.length) {
      console.log(`Integrations configured without printing credentials; capacity set to ${limits.lines.join(' ')}${limits.drift.length ? ` (corrected ${limits.drift.map(entry => entry.variable).join(', ')})` : ''}. No token changed, so no GitHub secret changed and no deployment was triggered. Preview .railway/railway.ts, deploy reviewed code, then verify the App-owned check before requiring it.`);
      return;
    }
    stage = 'deploy the staged roster';
    execFileSync('npx', [...railway, 'redeploy', '--service', 'graphyard', '--yes'], { stdio: ['ignore', 'ignore', 'pipe'] });
    stage = 'wait for the deployment to serve the rotated tokens';
    const served = await awaitServedTokens(url, secrets.map(entry => ({ id: entry.id, token: entry.token })));
    stage = 'store the served producer credentials';
    for (const entry of secrets.filter(candidate => served.served.includes(candidate.id))) gh(['secret', 'set', entry.secret, '--repo', repository, '--env', 'graphyard-reporting'], entry.token);
    if (served.pending.length) throw Object.assign(new Error(`The deployment does not authenticate ${served.pending.join(', ')} yet, so ${secrets.filter(entry => served.pending.includes(entry.id)).map(entry => entry.secret).join(', ')} was left unchanged; rerun with --deploy once the deployment is live`), { visible: true });
    console.log(`Integrations configured without printing credentials; capacity set to ${limits.lines.join(' ')}. Deployed the merged roster and updated ${secrets.map(entry => entry.secret).join(', ')} only after the deployment authenticated ${served.served.join(', ')}.`);
  } catch (error) { console.error(error?.visible || stage === 'check the merged roster' ? error.message : `Configuration stopped at: ${stage}. No credential values are logged. Correct the setup and rerun; the live roster is merged again and no token rotates unless named with --rotate.`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
