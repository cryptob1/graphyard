import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server, type Credential } from '../src/server.js';
import { ProofGrants } from '../src/proof-grants.js';
import { defaultDelegationLimits, delegationLimitDrift, delegationLimits, requiredDelegationLimits, validateDelegationPrincipals } from '../src/delegation.js';
import { delegationLimitAssignments } from '../src/install/limits.js';
import { controlPlaneAttention } from '../src/master.js';
import type { Principal } from '../src/model.js';

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
  // The Railway adapter sets exactly these lines and reports drift on every run.
  const adapter = await readFile(new URL('../scripts/provision-railway.mjs', import.meta.url), 'utf8');
  assert.match(adapter, /delegationLimitAssignments\(principals, deployed\)/);
  assert.match(adapter, /\.\.\.limits\.lines/);
  assert.match(adapter, /for \(const entry of limits\.drift\) console\.error\(`Drift: \$\{entry\.reason\}`\)/);
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
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-deploy-limits-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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
  // The build identity is public for deployment probes and the version-skew guard.
  assert.deepEqual(health, { ok: true, commit: 'f'.repeat(40), protocol: status.build.protocol });
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
