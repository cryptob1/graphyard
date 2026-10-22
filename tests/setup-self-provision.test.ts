import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { REDACTED } from '../src/install/index.js';
import { fingerprint, Vault } from '../src/install/secrets.js';
import { variableMarker, type AdapterContext, type ProviderAdapter } from '../src/install/adapters.js';
import { masterSetup, setupAuditFile } from '../src/cli/master-setup.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1416: an installation deployed before the plan derived a variable never got it, although the
// credential it derives from sat on this host. `master setup` finds every derived variable the
// deployment lacks and, with --apply, sets it through the provider adapter. GY-2010: the install
// record's credentials are the only source; no GitHub App registration derives anything.

const principals = JSON.stringify([{ id: 'owner-project-operator', role: 'admin', token: 'p'.repeat(48) }]);
const derivedNames = ['GITHUB_BASE_BRANCH', 'GRAPHYARD_GENERATED_FILES', 'GRAPHYARD_PRINCIPALS'];
const derived = (source = 'the install plan\'s credentials') => [
  { name: 'GITHUB_REPOSITORY', value: 'owner/project', secret: false, source },
  { name: 'GITHUB_BASE_BRANCH', value: 'main', secret: false, source },
  { name: 'GRAPHYARD_GENERATED_FILES', value: 'docs/index.md', secret: false, source },
  { name: 'GRAPHYARD_PRINCIPALS', value: principals, secret: true, source },
];

/** A deployment whose `graphyard` service runs with DEPLOYED set and no other derived variable, behind a scripted adapter that sets variables in place and redeploys. */
function deployment(deployed: Record<string, string>, faults: { listing?: boolean; redeploys?: number } = {}) {
  const calls: { kind: 'observe' | 'set' | 'redeploy'; values?: { name: string; value: string; secret: boolean }[] }[] = [];
  const context = { provider: 'local', service: 'graphyard', repository: 'owner/project', installId: 'owner-project', vault: new Vault() } as unknown as AdapterContext;
  const adapter = {
    provider: 'local',
    async observe() {
      calls.push({ kind: 'observe' });
      return { installed: true, compute: true, database: true, app: true, url: null, detail: [], variablesObserved: !faults.listing,
        variables: faults.listing ? {} : Object.fromEntries(Object.entries(deployed).map(([name, value]) => [name, variableMarker(name, value)])) };
    },
    async applyVariables(_context: AdapterContext, values: { name: string; value: string; secret: boolean }[]) {
      // The adapter keeps what is set, deployed or not; a failed redeploy throws, as the local transport does.
      if (values.length) calls.push({ kind: 'set', values });
      for (const value of values) deployed[value.name] = value.value;
      if (faults.redeploys && faults.redeploys-- > 0) throw new Error('systemctl exited 1: redeploy failed');
      calls.push({ kind: 'redeploy' });
    },
  } as unknown as ProviderAdapter;
  return { adapter, context, calls };
}

async function fixture() {
  const root = await temporaryDirectory('setup-self-provision');
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: '/opt/graphyard/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] }) as MasterConfig;
  const { adapter, context, calls } = deployment({ GITHUB_REPOSITORY: 'owner/project' });
  // The install record derives GITHUB_REPOSITORY too; the deployment has it, so it is never touched.
  const locate = async () => ({ adapter, context, derived: derived() });
  return { root, master, calls, locate };
}

test('unit:setup-self-provision — master setup plans the derived variables the deployment lacks from the install record\'s credentials on this host, and --apply sets exactly those through the adapter, the secret never printed, one audit entry each', async () => {
  const { root, master, calls, locate } = await fixture();
  try {
    // Without --apply: the plan names each missing variable, the secret only by fingerprint, and nothing is set.
    const plan = await masterSetup(root, master, { apply: false }, { locate });
    assert.deepEqual(plan.target, { provider: 'local', service: 'graphyard' });
    assert.equal(plan.mode, 'plan');
    assert.deepEqual(plan.missing.map(value => value.name), derivedNames, 'GITHUB_REPOSITORY is already deployed');
    assert.deepEqual(plan.missing.slice(0, 2).map(value => value.value), ['main', 'docs/index.md']);
    assert.deepEqual(plan.missing[2], { name: 'GRAPHYARD_PRINCIPALS', value: REDACTED, secret: true, fingerprint: fingerprint(principals), source: 'the install plan\'s credentials' });
    assert.equal(plan.next, 'graphyard master setup --apply');
    assert.deepEqual(plan.set, []);
    assert.equal(calls.some(call => call.kind === 'set' || call.kind === 'redeploy'), false, 'a plan sets nothing');
    await assert.rejects(readFile(setupAuditFile(root), 'utf8'), { code: 'ENOENT' }, 'and audits nothing');

    // --apply: the missing variables handed to the adapter in one write, the secret among them by value, then one redeploy.
    calls.length = 0;
    const applied = await masterSetup(root, master, { apply: true }, { locate, now: () => Date.parse('2026-10-07T05:00:00.000Z') });
    assert.deepEqual(applied.set, derivedNames);
    assert.equal(applied.next, null);
    const writes = calls.filter(call => call.kind !== 'observe');
    assert.deepEqual(writes.map(call => call.kind), ['set', 'redeploy']);
    assert.deepEqual(writes[0].values!.map(value => [value.name, value.secret]), [['GITHUB_BASE_BRANCH', false], ['GRAPHYARD_GENERATED_FILES', false], ['GRAPHYARD_PRINCIPALS', true]]);
    assert.equal(writes[0].values!.find(value => value.name === 'GRAPHYARD_PRINCIPALS')!.value, principals, 'the secret reaches the adapter by value');

    // Redaction: neither the report nor the audit carries the secret.
    for (const [where, text] of [['report', JSON.stringify(applied)], ['audit', await readFile(setupAuditFile(root), 'utf8')]] as const) {
      assert.ok(!text.includes('p'.repeat(48)), `the ${where} never carries the secret`);
    }

    // One audit entry per variable set, by fingerprint.
    const audit = (await readFile(setupAuditFile(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(audit, applied.audit);
    assert.deepEqual(audit.map(entry => [entry.variable, entry.secret, entry.fingerprint, entry.provider, entry.service, entry.at]), [
      ['GITHUB_BASE_BRANCH', false, fingerprint('main'), 'local', 'graphyard', '2026-10-07T05:00:00.000Z'],
      ['GRAPHYARD_GENERATED_FILES', false, fingerprint('docs/index.md'), 'local', 'graphyard', '2026-10-07T05:00:00.000Z'],
      ['GRAPHYARD_PRINCIPALS', true, fingerprint(principals), 'local', 'graphyard', '2026-10-07T05:00:00.000Z'],
    ]);

    // A host that recorded no deployment names the install that records one, and sets nothing.
    const unnamed = await masterSetup(root, master, { apply: true }, { locate: async () => null });
    assert.equal(unnamed.target, null);
    assert.match(unnamed.next, /graphyard install --provider compose\|local --repo owner\/project --apply/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-self-provision — a deployment that already has every derived variable (one file-mounted), or an adapter that cannot set variables in place, is never written', async () => {
  const { root, master } = await fixture();
  try {
    const mounted = deployment({ GITHUB_REPOSITORY: 'owner/project', GITHUB_BASE_BRANCH: 'release', GRAPHYARD_GENERATED_FILES: 'docs/index.md', GRAPHYARD_PRINCIPALS_FILE: '/run/graphyard/principals.json' });
    const present = await masterSetup(root, master, { apply: true }, { locate: async () => ({ ...mounted, derived: derived() }) });
    assert.deepEqual([present.missing, present.set, present.next], [[], [], null], 'a present variable, whatever its value, is the deployment\'s own');
    assert.equal(mounted.calls.some(call => call.kind === 'redeploy'), false);

    const bundle = deployment({});
    const { applyVariables: _omitted, ...rewrites } = bundle.adapter;
    const planned = await masterSetup(root, master, { apply: true }, { locate: async () => ({ context: { ...bundle.context, provider: 'compose' as const }, adapter: { ...rewrites, provider: 'compose' as const }, derived: derived() }) });
    assert.deepEqual(planned.set, []);
    assert.equal(planned.canApply, false);
    assert.match(planned.next!, /rewrites the whole environment: graphyard install --provider compose --repo owner\/project --apply/);

    // A variable listing that could not be read is not an empty one: nothing is applied from it.
    const unread = deployment({}, { listing: true });
    const refused = await masterSetup(root, master, { apply: true }, { locate: async () => ({ ...unread, derived: derived() }) });
    assert.deepEqual([refused.observed, refused.missing, refused.set], [false, [], []]);
    assert.match(refused.next!, /variables could not be read on local; nothing is applied/);
    assert.equal(unread.calls.some(call => call.kind === 'set' || call.kind === 'redeploy'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-self-provision — the first derivation of a name wins, and variables set before a failed redeploy are redeployed by the next run', async () => {
  const { root, master } = await fixture();
  try {
    const deployed: Record<string, string> = {};
    const staged = deployment(deployed, { redeploys: 1 });
    const locate = async () => ({ ...staged, derived: [...derived(), { name: 'GITHUB_BASE_BRANCH', value: 'stale', secret: false, source: 'a later derivation' }] });
    const plan = await masterSetup(root, master, { apply: false }, { locate });
    assert.equal(plan.missing.find(value => value.name === 'GITHUB_BASE_BRANCH')?.value, 'main', 'the first derivation, not the later one');

    const names = ['GITHUB_REPOSITORY', ...derivedNames];
    await assert.rejects(masterSetup(root, master, { apply: true }, { locate }), /redeploy failed/);
    assert.deepEqual(Object.keys(deployed), names, 'set, but never redeployed');
    const owed = await masterSetup(root, master, { apply: false }, { locate });
    assert.deepEqual([owed.missing, owed.pendingRedeploy, owed.next], [[], names, 'graphyard master setup --apply'], 'present variables still owe their redeploy');
    staged.calls.length = 0;
    const retried = await masterSetup(root, master, { apply: true }, { locate });
    assert.deepEqual([retried.set, retried.redeployed, retried.pendingRedeploy], [[], names, []]);
    assert.deepEqual(staged.calls.filter(call => call.kind !== 'observe').map(call => call.kind), ['redeploy'], 'only the redeploy, nothing set again');
    const settled = await masterSetup(root, master, { apply: true }, { locate });
    assert.deepEqual([settled.redeployed, settled.next], [[], null], 'and only once');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-self-provision — an audit entry that failed to append after the variables were set is written by the next run, once each', async () => {
  const { root, master } = await fixture();
  try {
    const deployed: Record<string, string> = { GITHUB_REPOSITORY: 'owner/project' };
    const bundle = deployment(deployed);
    const locate = async () => ({ ...bundle, derived: derived() });
    // The audit log is a directory for the first run, so every append fails after the variables are set and redeployed.
    await rm(setupAuditFile(root), { force: true });
    await mkdir(setupAuditFile(root), { recursive: true });
    await assert.rejects(masterSetup(root, master, { apply: true }, { locate }));
    assert.deepEqual(Object.keys(deployed), ['GITHUB_REPOSITORY', ...derivedNames], 'set and redeployed');
    await rm(setupAuditFile(root), { recursive: true, force: true });
    bundle.calls.length = 0;
    const owed = await masterSetup(root, master, { apply: false }, { locate });
    assert.equal(owed.next, 'graphyard master setup --apply', 'the unwritten audit is still owed');
    const retried = await masterSetup(root, master, { apply: true }, { locate });
    assert.deepEqual([retried.set, retried.redeployed, retried.audit.map(entry => entry.variable)], [[], [], derivedNames]);
    assert.equal(bundle.calls.some(call => call.kind === 'set' || call.kind === 'redeploy'), false, 'nothing set or redeployed again');
    const lines = (await readFile(setupAuditFile(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.variable), derivedNames, 'one entry per variable');
    const settled = await masterSetup(root, master, { apply: true }, { locate });
    assert.deepEqual([settled.audit, settled.next], [[], null]);
    assert.equal((await readFile(setupAuditFile(root), 'utf8')).trim().split('\n').length, 3, 'never repeated');
  } finally { await rm(root, { recursive: true, force: true }); }
});
