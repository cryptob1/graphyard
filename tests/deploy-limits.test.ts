import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server, type Credential } from '../src/server.js';
import { ProofGrants } from '../src/proof-grants.js';
import { defaultDelegationLimits, delegationLimitDrift, delegationLimits, requiredDelegationLimits, validateDelegationPrincipals } from '../src/delegation.js';
import { delegationLimitAssignments, readDeployedDelegationLimits } from '../src/install/limits.js';
import { capacityForPrincipals } from '../src/cli/install.js';
import { controlPlaneAttention } from '../src/master.js';
import { revertApproverVariables } from '../src/main-guard.js';
// @ts-expect-error Dependency-free provisioning script.
import { principalNarrowing, revertApproverAssignment, revertApproverVariables as provisionedApproverVariables, setRevertApproverVariables, verifyRevertApprover } from '../scripts/provision-railway.mjs';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-59 AC-1 / AC-2: the reviewer limit derives from the configured roster, an over-limit
// roster of already-running principals starts with an attention item, only a newly added
// principal beyond the limit refuses, and installers set the variables from the principal set.

const operator: Principal = { id: 'operator', role: 'admin' };
const producers: Principal[] = ['builder', 'observer', 'promoter', 'acceptance'].map(id => ({ id, role: 'producer' as const }));
const lead: Principal = { id: 'lead-product', role: 'slice-lead', slice: 'product', sessionKind: 'ai' };
const credential = (p: Principal): Credential => ({ ...p, token: `${p.id}-${'t'.repeat(32)}` });

test('unit:deploy-limit-derivation — an unset limit derives from the configured principals and drift names the variable and value', () => {
  // Defaults are unchanged for a roster inside them, and for no roster at all.
  assert.deepEqual(delegationLimits({}), defaultDelegationLimits);
  assert.deepEqual(delegationLimits({}, [operator, producers[0], producers[1]]), defaultDelegationLimits);
  // Four producers with GRAPHYARD_MAX_REVIEWERS unset: the limit is the roster size, not the default.
  const derived = delegationLimits({}, [operator, ...producers]);
  assert.equal(derived.maxReviewers, 4); assert.equal(derived.maxLeads, 3);
  // An explicit value stays authoritative even when it is below the roster; the drift report says so.
  assert.equal(delegationLimits({ GRAPHYARD_MAX_REVIEWERS: '2' }, [operator, ...producers]).maxReviewers, 2);
  const unset = delegationLimitDrift([operator, ...producers], {});
  assert.equal(unset.length, 1);
  assert.deepEqual({ variable: unset[0].variable, deployed: unset[0].deployed, required: unset[0].required }, { variable: 'GRAPHYARD_MAX_REVIEWERS', deployed: null, required: '4' });
  assert.match(unset[0].reason, /GRAPHYARD_MAX_REVIEWERS is unset .* 4 producer principals .* Set GRAPHYARD_MAX_REVIEWERS=4/);
  const explicit = delegationLimitDrift([operator, ...producers], { GRAPHYARD_MAX_REVIEWERS: '2' });
  assert.match(explicit[0].reason, /GRAPHYARD_MAX_REVIEWERS=2 no longer covers the 4 producer principals .* Set GRAPHYARD_MAX_REVIEWERS=4/);
  assert.deepEqual(delegationLimitDrift([operator, ...producers], { GRAPHYARD_MAX_REVIEWERS: '4' }), []);
  // Leads derive the same way.
  const leads = [lead, { ...lead, id: 'lead-infra', slice: 'infrastructure' as const }, { ...lead, id: 'lead-docs', slice: 'docs-experience' as const }];
  assert.equal(delegationLimits({ GRAPHYARD_MAX_SLICE_LEADS: '1' }, leads).maxLeads, 1);
  assert.equal(delegationLimitDrift(leads, { GRAPHYARD_MAX_SLICE_LEADS: '1' })[0].variable, 'GRAPHYARD_MAX_SLICE_LEADS');

  // The required values an installer sets: defaults widened to the roster, never narrowed below a deployed value.
  assert.deepEqual(requiredDelegationLimits([operator, ...producers]), { GRAPHYARD_MAX_SLICE_LEADS: '3', GRAPHYARD_MAX_ENGINEERS_PER_LEAD: '2', GRAPHYARD_MIN_REVIEWERS: '1', GRAPHYARD_MAX_REVIEWERS: '4' });
  assert.equal(requiredDelegationLimits([operator, producers[0]], { GRAPHYARD_MAX_REVIEWERS: '6' }).GRAPHYARD_MAX_REVIEWERS, '6');
  assert.equal(requiredDelegationLimits([operator], { GRAPHYARD_MAX_REVIEWERS: 'many' }).GRAPHYARD_MAX_REVIEWERS, '2');

  // Roster validation: known over-limit principals warn; a new principal beyond the limit refuses.
  const explicitTwo = delegationLimits({ GRAPHYARD_MAX_REVIEWERS: '2' }, [operator, ...producers]);
  const known = producers.map(p => p.id);
  const started = validateDelegationPrincipals([operator, ...producers], explicitTwo, known);
  assert.equal(started.attention.length, 1);
  assert.match(started.attention[0], /Independent review\/proof agent limit exceeded: 4\/2; .* Set GRAPHYARD_MAX_REVIEWERS=4/);
  assert.throws(() => validateDelegationPrincipals([operator, ...producers, { id: 'fifth', role: 'producer' }], explicitTwo, known), /limit exceeded: 5\/2; set GRAPHYARD_MAX_REVIEWERS=5 on the deployment before adding fifth/);
  // Without a known set every principal is new: the strict check a fresh configuration gets.
  assert.throws(() => validateDelegationPrincipals([operator, ...producers], explicitTwo), /Independent review\/proof agent limit exceeded: 4\/2; set GRAPHYARD_MAX_REVIEWERS=4/);
  // A derived limit covers the roster, so nothing warns from the roster check itself.
  assert.deepEqual(validateDelegationPrincipals([operator, ...producers], derived, known).attention, []);
  // Separation-of-duties rules still refuse regardless of what is known.
  assert.throws(() => validateDelegationPrincipals([lead, { ...producers[0], slice: 'product' }], derived, [lead.id, producers[0].id]), /must remain independent of every slice/);
});

test('integration:deploy-limit-install — installers derive the variables from the principal set and a re-run reports drift', async () => {
  const roster = [operator, ...producers, { id: 'worker-1', role: 'worker' as const }];
  const fresh = delegationLimitAssignments(roster);
  assert.deepEqual(fresh.lines, ['GRAPHYARD_MAX_SLICE_LEADS=3', 'GRAPHYARD_MAX_ENGINEERS_PER_LEAD=2', 'GRAPHYARD_MIN_REVIEWERS=1', 'GRAPHYARD_MAX_REVIEWERS=4']);
  assert.deepEqual(fresh.drift, [], 'a fresh install has no deployment to drift from');
  // Re-run against a deployment whose variable is known to be unset: the default no longer covers the roster.
  const unset = delegationLimitAssignments(roster, { GRAPHYARD_MAX_REVIEWERS: null });
  assert.match(unset.drift[0].reason, /GRAPHYARD_MAX_REVIEWERS is unset .* Set GRAPHYARD_MAX_REVIEWERS=4/);
  // Re-run against a deployment that still carries the old value: drift is reported and the corrected value set.
  const rerun = delegationLimitAssignments(roster, { GRAPHYARD_MAX_REVIEWERS: '2', GRAPHYARD_MAX_SLICE_LEADS: '3' });
  assert.equal(rerun.drift.length, 1); assert.equal(rerun.drift[0].variable, 'GRAPHYARD_MAX_REVIEWERS');
  assert.match(rerun.drift[0].reason, /GRAPHYARD_MAX_REVIEWERS=2 no longer covers the 4 producer principals/);
  assert.equal(rerun.variables.GRAPHYARD_MAX_REVIEWERS, '4');
  // A deployed value above the roster is kept, never narrowed.
  assert.equal(delegationLimitAssignments(roster, { GRAPHYARD_MAX_REVIEWERS: '8' }).variables.GRAPHYARD_MAX_REVIEWERS, '8');

  // Every adapter reads what the deployment runs with from the server's status with the operator credential.
  const calls: { url: string; auth: string | undefined }[] = [];
  const stub = (body: unknown, ok = true, status = 200): typeof fetch => async (input: any, init: any) => { calls.push({ url: String(input), auth: init?.headers?.Authorization }); return { ok, status, json: async () => body } as Response; };
  const read = await readDeployedDelegationLimits('https://graphyard.example/', 'operator-token', stub({ delegationLimits: { deployed: { GRAPHYARD_MAX_REVIEWERS: '2', GRAPHYARD_MAX_SLICE_LEADS: null } } }));
  assert.deepEqual(read, { deployed: { GRAPHYARD_MAX_REVIEWERS: '2', GRAPHYARD_MAX_SLICE_LEADS: null }, error: null });
  assert.deepEqual(calls, [{ url: 'https://graphyard.example/api/status', auth: 'Bearer operator-token' }]);
  assert.match(delegationLimitAssignments(roster, read.deployed).drift[0].reason, /GRAPHYARD_MAX_REVIEWERS=2 no longer covers the 4 producer principals/);
  // A server that cannot be read, or one older than this release, is reported rather than treated as drift-free.
  const older = await readDeployedDelegationLimits('https://graphyard.example', 'operator-token', stub({ ok: true }));
  assert.equal(older.deployed, null); assert.match(older.error!, /reports no delegationLimits; deploy main first/);
  const denied = await readDeployedDelegationLimits('https://graphyard.example', 'operator-token', stub({ error: 'forbidden' }, false, 403));
  assert.equal(denied.deployed, null); assert.match(denied.error!, /HTTP 403.*no drift can be reported/);
  const down = await readDeployedDelegationLimits('https://graphyard.example', 'operator-token', async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(down.deployed, null); assert.match(down.error!, /ECONNREFUSED; no drift can be reported/);

  // The Railway provisioning adapter sets exactly these lines and reports drift on every run.
  const script = (name: string) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const adapter = await script('scripts/provision-railway.mjs');
  assert.match(adapter, /readDeployedDelegationLimits\(url, operator\.token\)/);
  assert.match(adapter, /delegationLimitAssignments\(principals, deployed\)/);
  assert.match(adapter, /\.\.\.limits\.lines/);
  assert.match(adapter, /for \(const entry of limits\.drift\) console\.error\(`Drift: \$\{entry\.reason\}`\)/);
  // The integrations adapter generates two more producers (the dispatched reporter and the CI producer): its limits derive from the roster it deploys, not from credentials.json alone.
  const integrations = await script('scripts/configure-integrations.mjs');
  assert.match(integrations, /const roster = withCiProducer\(\[\.\.\.principals\.filter\(p => p\.id !== producer\.id\), producer\]\)/);
  assert.match(integrations, /readDeployedDelegationLimits\(url, operator\.token\)/);
  assert.match(integrations, /delegationLimitAssignments\(roster, deployed\)/);
  assert.match(integrations, /GRAPHYARD_PRINCIPALS: JSON\.stringify\(roster\), \.\.\.limits\.variables/);
  assert.match(integrations, /for \(const entry of limits\.drift\) console\.error\(`Drift: \$\{entry\.reason\}`\)/);
  const generated = delegationLimitAssignments([...roster, { id: 'trusted-acceptance', role: 'producer' }], { GRAPHYARD_MAX_REVIEWERS: '4' });
  assert.equal(generated.variables.GRAPHYARD_MAX_REVIEWERS, '5');
  assert.match(generated.drift[0].reason, /GRAPHYARD_MAX_REVIEWERS=4 no longer covers the 5 producer principals/);
  // The Railway IaC preserves every variable the adapters set, so `railway config apply` cannot drop them.
  const iac = await script('.railway/railway.ts');
  for (const variable of ['GRAPHYARD_PRINCIPALS', 'GRAPHYARD_MAX_SLICE_LEADS', 'GRAPHYARD_MAX_ENGINEERS_PER_LEAD', 'GRAPHYARD_MIN_REVIEWERS', 'GRAPHYARD_MAX_REVIEWERS', 'RAILWAY_API_TOKEN', ...revertApproverVariables]) assert.match(iac, new RegExp(`${variable}: preserve\\(\\)`), `.railway/railway.ts preserves ${variable}`);

  // `init --scan --apply` prints the lines for the principals it registered and compares them with the deployment.
  const principalsFile = join(await temporaryDirectory('init-capacity'), 'principals.json');
  await writeFile(principalsFile, JSON.stringify({ version: 1, principals: [operator, { id: 'master', role: 'coordinator' }, { id: 'worker-1', role: 'worker' }, { id: 'evidence', role: 'producer' }, { id: 'acceptance', role: 'producer' }, { id: 'observer', role: 'producer' }] }));
  const capacity = await capacityForPrincipals(principalsFile, async () => ({ delegationLimits: { deployed: { GRAPHYARD_MAX_REVIEWERS: '2' } } }));
  assert.equal(capacity.variables.GRAPHYARD_MAX_REVIEWERS, '3');
  assert.deepEqual(capacity.lines, ['GRAPHYARD_MAX_SLICE_LEADS=3', 'GRAPHYARD_MAX_ENGINEERS_PER_LEAD=2', 'GRAPHYARD_MIN_REVIEWERS=1', 'GRAPHYARD_MAX_REVIEWERS=3']);
  assert.match(capacity.next, /Set GRAPHYARD_MAX_SLICE_LEADS=3 .*GRAPHYARD_MAX_REVIEWERS=3 beside GRAPHYARD_PRINCIPALS .*drift: GRAPHYARD_MAX_REVIEWERS=2 no longer covers the 3 producer principals/);
  const unreachable = await capacityForPrincipals(principalsFile, async () => { throw new Error('Configure GRAPHYARD_URL'); });
  assert.deepEqual(unreachable.drift, []);
  assert.match(unreachable.next, /no drift can be reported because the server could not be read \(Configure GRAPHYARD_URL\)/);
  const predates = await capacityForPrincipals(principalsFile, async () => ({ ok: true }));
  assert.match(predates.next, /reports no delegationLimits; deploy main first/);
});

// GY-1353: provisioning carries the main guard's revert approver App, so an armed guard is never
// provisioned without one, and verifies the live deployment reports it after the redeploy.
const pem = '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n';
const armedLive = (revertApprover: number | null, githubAppId = 100) => ({ githubAppId, mainGuard: { armed: true, required: ['test', 'typecheck'], revertApprover, attention: revertApprover ? null : 'missing' } });

test('unit:provision-sets-revert-approver-credentials — provisioning sets the three revert approver variables from the operator record, the key only over stdin and never printed, and --verify checks the live deployment', async () => {
  assert.deepEqual(provisionedApproverVariables, [...revertApproverVariables], 'the script sets exactly the variables the control plane reads');
  const set = await revertApproverAssignment({ appId: 200, installationId: 300, privateKey: pem }, armedLive(null));
  assert.equal(set.error, undefined); assert.equal(set.appId, 200);
  assert.deepEqual(set.variables, { GRAPHYARD_REVERT_APPROVER_APP_ID: '200', GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID: '300', GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY: pem });
  // A key file is read, and an unreadable server still provisions (the guard counts as armed).
  const fromFile = await revertApproverAssignment({ appId: '200', installationId: '300', privateKeyFile: '/keys/approver.pem' }, null, async (path: string) => { assert.equal(path, '/keys/approver.pem'); return pem; });
  assert.equal(fromFile.variables!.GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY, pem);
  // The control-plane App can never approve its own reverts, and a bad key is refused without echoing it.
  assert.match((await revertApproverAssignment({ appId: 100, installationId: 300, privateKey: pem }, armedLive(null))).error!, /App 100 is the control-plane App/);
  const badKey = (await revertApproverAssignment({ appId: 200, installationId: 300, privateKey: 'secret-value' }, null)).error!;
  assert.match(badKey, /must be the PEM/); assert.doesNotMatch(badKey, /secret-value/);
  // The script sends the key over --stdin, sets only the two ids as arguments, and prints no credential.
  const adapter = await readFile(new URL('../scripts/provision-railway.mjs', import.meta.url), 'utf8');
  assert.match(adapter, /'--stdin', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY'\], \{ input: approver\.variables\.GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY, stdio: \['pipe', 'ignore', 'inherit'\] \}/);
  assert.match(adapter, /revertApproverVariables\.slice\(0, 2\)/);
  assert.match(adapter, /--revert-approver-stdin/); assert.match(adapter, /parseApprover\(/); assert.match(adapter, /revert-approver\.json/);
  for (const line of adapter.split('\n').filter(line => /console\.(log|error)/.test(line))) assert.doesNotMatch(line, /privateKey|variables\.GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY|record\)/, `no credential printed: ${line.trim()}`);
  // --verify: ready only once the live main guard reports this approver with no attention.
  assert.deepEqual(verifyRevertApprover(armedLive(200), 200), { ok: true, line: "The deployment's main guard reports revert approver App 200; graphyard doctor lists revert-approver ready" });
  assert.equal(verifyRevertApprover(armedLive(null), 200).ok, false);
  assert.match(verifyRevertApprover(armedLive(201), 200).line, /App 201, not 200/);
  assert.match(verifyRevertApprover({}, 200).line, /does not report the main guard/);
});

test('unit:provision-names-missing-revert-approver — with the guard armed and no approver record, provisioning fails naming all three variables; a disarmed guard or an already-deployed approver provisions', async () => {
  for (const live of [null, armedLive(null)]) {
    const missing = await revertApproverAssignment(null, live);
    assert.equal(missing.variables, undefined);
    for (const variable of revertApproverVariables) assert.match(missing.error!, new RegExp(variable), `the failure names ${variable}`);
    assert.match(missing.error!, /other than the control-plane App/);
  }
  assert.match((await revertApproverAssignment({ appId: 0, installationId: 300, privateKey: pem }, null)).error!, new RegExp(revertApproverVariables.join(', ')));
  assert.deepEqual(await revertApproverAssignment(null, { mainGuard: { armed: false, required: [], revertApprover: null, attention: null } }), { variables: null, appId: null, note: 'the main guard is not armed; no revert approver is needed' });
  assert.equal((await revertApproverAssignment(null, armedLive(200))).appId, 200);
  // Without a live answer the service's Railway variables decide: the guard arms only under GitHub delivery.
  const readKey = async () => pem;
  assert.match((await revertApproverAssignment(null, null, readKey, { GITHUB_APP_ID: '100' })).error!, new RegExp(revertApproverVariables.join(', ')));
  assert.equal((await revertApproverAssignment(null, null, readKey, {})).note, 'the main guard is not armed; no revert approver is needed');
  assert.equal((await revertApproverAssignment(null, null, readKey, { GITHUB_APP_ID: '100', GRAPHYARD_REVERT_APPROVER_APP_ID: '200', GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID: '300', GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY: pem })).appId, 200);
  assert.match((await revertApproverAssignment({ appId: 100, installationId: 300, privateKey: pem }, null, readKey, { GITHUB_APP_ID: '100' })).error!, /App 100 is the control-plane App/);
  // The script stops before setting anything when the assignment fails.
  const adapter = await readFile(new URL('../scripts/provision-railway.mjs', import.meta.url), 'utf8');
  assert.ok(adapter.indexOf('if (approver.error)') < adapter.indexOf("'variable', 'set'"), 'the failure precedes every railway variable set');
  assert.match(adapter, /'variable', 'list', '--service', 'graphyard', '--json'\], \{ encoding: 'utf8', stdio: \['ignore', 'pipe', 'ignore'\] \}/, 'the deployed variables are read, never printed');
});

// GY-1365: the running control plane's principal set outgrows credentials.json, so the approver
// step must set its three variables alone, and a full run must refuse to drop deployed principals.
test('unit:provision-revert-approver-only — the approver-only run sets exactly the three variables with the key over stdin, and a full run refuses to narrow the deployed principal set or to overwrite it while Railway\'s variable list is unreadable', async () => {
  const calls: { args: string[]; input: string | undefined }[] = [];
  const approver = await revertApproverAssignment({ appId: 200, installationId: 300, privateKey: pem }, armedLive(null));
  setRevertApproverVariables(['@railway/cli'], approver, ((_: string, args: string[], options: { input?: string }) => { calls.push({ args, input: options.input }); }) as never);
  assert.deepEqual(calls.map(call => call.args.slice(1)), [
    ['variable', 'set', '--service', 'graphyard', '--skip-deploys', '--stdin', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY'],
    ['variable', 'set', '--service', 'graphyard', '--skip-deploys', 'GRAPHYARD_REVERT_APPROVER_APP_ID=200', 'GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID=300'],
  ]);
  assert.deepEqual(calls.map(call => call.input), [pem, undefined], 'the key travels over stdin only');
  const local = [{ id: 'operator', role: 'admin' }, { id: 'herdr-worker-1', role: 'worker' }];
  const deployed = JSON.stringify([...local, { id: 'graphyard-master', role: 'coordinator', token: 'secret-token' }, { id: 'graphyard-claude-1', role: 'worker', token: 'secret-token' }]);
  const refusal = principalNarrowing(local, { GRAPHYARD_PRINCIPALS: deployed })!;
  assert.match(refusal, /holds 2 principals that \.graphyard\/credentials\.json does not \(graphyard-master, graphyard-claude-1\); a full run would drop them and nothing was set/);
  assert.match(refusal, /--revert-approver-only/); assert.doesNotMatch(refusal, /secret-token/);
  assert.equal(principalNarrowing(local, { GRAPHYARD_PRINCIPALS: JSON.stringify(local) }), null);
  assert.equal(principalNarrowing(local, {}), null, 'a service with no variables yet drops nothing'); assert.equal(principalNarrowing(local, { GRAPHYARD_PRINCIPALS: 'not json' }), null, 'an unparsable value holds no principal that runs');
  assert.match(principalNarrowing(local, null)!, /did not answer `variable list`.*cannot be compared.*nothing was set/, 'an unreadable list refuses instead of overwriting the set blind');
  // The script: the approver-only run writes no credentials file and sets nothing but the approver; the full run refuses before its first variable set.
  const adapter = await readFile(new URL('../scripts/provision-railway.mjs', import.meta.url), 'utf8');
  assert.match(adapter, /const approverOnly = args\.includes\('--revert-approver-only'\)/);
  assert.match(adapter, /if \(!approverOnly\) \{\s*principals = \[/);
  const only = adapter.indexOf('if (approverOnly) {'), narrowing = adapter.indexOf('const narrowing = principalNarrowing(principals, variables)');
  assert.ok(only > 0 && only < narrowing && narrowing < adapter.indexOf("'--stdin', 'GRAPHYARD_PRINCIPALS'"), 'approver-only returns, then the narrowing refusal, before GRAPHYARD_PRINCIPALS is set');
  assert.match(adapter.slice(only, narrowing), /setRevertApproverVariables\(railway, approver\)/);
  assert.doesNotMatch(adapter.slice(only, narrowing), /GRAPHYARD_PRINCIPALS|limits|generated/);
});

test('manual:deploy-limit-docs — the deployment, install, operations and master guides document the variables, derivation, drift and observation', async () => {
  const read = (page: string) => readFile(new URL(`../docs/${page}`, import.meta.url), 'utf8');
  const deployment = await read('deployment.md');
  for (const variable of ['GRAPHYARD_MAX_SLICE_LEADS', 'GRAPHYARD_MAX_ENGINEERS_PER_LEAD', 'GRAPHYARD_MIN_REVIEWERS', 'GRAPHYARD_MAX_REVIEWERS']) assert.match(deployment, new RegExp(`\\| \`${variable}\``), `deployment.md lists ${variable}`);
  assert.match(deployment, /derive/i); assert.match(deployment, /RAILWAY_API_TOKEN/); assert.match(deployment, /GRAPHYARD_BUILD_SHA/);
  const install = await read('install.md');
  assert.match(install, /drift/); assert.match(install, /GRAPHYARD_MAX_REVIEWERS/);
  const operations = await read('operations.md');
  assert.match(operations, /deployment incident/i); assert.match(operations, /ahead of production/);
  const master = await read('master-agent.md');
  assert.match(master, /deploy main first/); assert.match(master, /ahead of production/);
});

// ---------------------------------------------------------------------------
// integration:deploy-limit-startup — the server itself
// ---------------------------------------------------------------------------
let database: EmbeddedPostgres, store: Store;
before(async () => {
  const port = Number(process.env.GRAPHYARD_DEPLOY_LIMIT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 11);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('deploy-limits'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('deploy_limits_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/deploy_limits_test`); await store.init();
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

async function start(credentials: Credential[], env: NodeJS.ProcessEnv, knownPrincipals?: string[]) {
  const engine = new Engine(store, [15368], 120, 'owner/project');
  const http = server(engine, credentials, null, undefined, { env, knownPrincipals });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const status = await (await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${credentials[0].token}` } })).json() as any;
  const health = await (await fetch(`${url}/healthz`)).json() as any;
  await new Promise<void>(resolve => http.close(() => resolve()));
  return { status, health, services: http.services };
}

test('integration:deploy-limit-startup — an existing install with more producers than the default starts, warns, and names the variable; only a new principal beyond the limit is refused', async () => {
  const credentials = [operator, ...producers].map(credential);
  // The production shape that crash-looped: four producer principals, GRAPHYARD_MAX_REVIEWERS unset.
  const { status, health, services } = await start(credentials, { GRAPHYARD_BUILD_SHA: 'f'.repeat(40) });
  assert.equal(services.limits.maxReviewers, 4);
  assert.equal(status.delegationLimits.limits.maxReviewers, 4);
  assert.equal(status.delegationLimits.deployed.GRAPHYARD_MAX_REVIEWERS, null);
  assert.equal(status.delegationLimits.drift.length, 1);
  assert.match(status.delegationLimits.attention[0], /GRAPHYARD_MAX_REVIEWERS is unset .* Set GRAPHYARD_MAX_REVIEWERS=4/);
  // The same attention reaches master status through the control-plane summary.
  const installation = controlPlaneAttention(status);
  assert.ok(installation.attention.some(line => /Set GRAPHYARD_MAX_REVIEWERS=4/.test(line)));
  assert.deepEqual(installation.delegationLimits?.drift.map(entry => [entry.variable, entry.required]), [['GRAPHYARD_MAX_REVIEWERS', '4']]);
  // The build identity is public for deployment probes and the version-skew guard, beside the
  // release and schema generation health already names for upgrades.
  assert.equal(health.ok, true);
  assert.equal(health.commit, 'f'.repeat(40)); assert.equal(health.protocol, status.build.protocol);
  assert.equal(typeof health.version, 'string'); assert.equal(typeof health.schema, 'number');
  assert.equal(status.build.commit, 'f'.repeat(40));

  // The roster this installation already ran with is the seeded proof-grant set, exactly as main() reads it.
  await new ProofGrants(store, [operator, ...producers]).seed();
  const known = (await store.pool.query('SELECT principal_id FROM proof_grants')).rows.map(row => String(row.principal_id));
  assert.deepEqual([...known].sort(), producers.map(p => p.id).sort());
  // An explicit value below the running roster warns instead of refusing an install that was already running.
  const explicit = await start(credentials, { GRAPHYARD_MAX_REVIEWERS: '2' }, known);
  assert.equal(explicit.services.limits.maxReviewers, 2);
  assert.match(explicit.status.delegationLimits.attention[0], /limit exceeded: 4\/2; .* Set GRAPHYARD_MAX_REVIEWERS=4/);
  assert.match(explicit.status.delegationLimits.attention[1], /GRAPHYARD_MAX_REVIEWERS=2 no longer covers/);
  // Only adding a principal beyond the explicit limit is refused, naming the variable and the value to set.
  assert.throws(() => server(new Engine(store, [15368], 120, 'owner/project'), [...credentials, credential({ id: 'fifth', role: 'producer' })], null, undefined, { env: { GRAPHYARD_MAX_REVIEWERS: '2' }, knownPrincipals: known }),
    /Independent review\/proof agent limit exceeded: 5\/2; set GRAPHYARD_MAX_REVIEWERS=5 on the deployment before adding fifth/);
  // With the variable unset the fifth principal derives a wider limit and only drift is reported.
  const widened = await start([...credentials, credential({ id: 'fifth', role: 'producer' })], {}, known);
  assert.equal(widened.services.limits.maxReviewers, 5);
  assert.match(widened.status.delegationLimits.attention[0], /Set GRAPHYARD_MAX_REVIEWERS=5/);
  // Set as the drift asks, nothing needs attention.
  const covered = await start([...credentials, credential({ id: 'fifth', role: 'producer' })], { GRAPHYARD_MAX_REVIEWERS: '5' }, known);
  assert.deepEqual(covered.status.delegationLimits.attention, []);
});
