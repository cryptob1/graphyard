import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deploymentTarget, REDACTED } from '../src/install/index.js';
import { fingerprint } from '../src/install/secrets.js';
import type { Transport } from '../src/install/transport.js';
import { loopProvisionDelay, loopSelfProvision, masterSetup, setupApplyNext, setupAuditFile, setupHealth } from '../src/cli/master-setup.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
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

/** A Railway project whose `graphyard` service runs with its repository set but no other derived variable. */
function railway(deployed: Record<string, string>, faults: { listing?: boolean; redeploys?: number } = {}) {
  const calls: { args: string[]; input?: string; cwd?: string }[] = [];
  const transport: Transport = {
    description: 'scripted railway',
    async exec(program, args, options = {}) {
      assert.equal(program, 'railway');
      calls.push({ args, ...(options.input !== undefined ? { input: options.input } : {}), cwd: options.cwd });
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ name: 'graphyard', services: { edges: [{ node: { name: 'graphyard' } }, { node: { name: 'Postgres' } }] } }), stderr: '' };
      if (args[0] === 'variables' && args.includes('--json')) return faults.listing ? { code: 1, stdout: '', stderr: 'Unauthorized' } : { code: 0, stdout: JSON.stringify(deployed), stderr: '' };
      // Railway keeps what is set, deployed or not.
      args.forEach((arg, index) => { if (args[index - 1] === '--set') deployed[arg.slice(0, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1); });
      if (args[0] === 'variable' && args[1] === 'set') deployed[args[args.length - 1]] = options.input ?? '';
      // As the local transport does, a failure without allowFailure throws.
      if (args[0] === 'redeploy' && faults.redeploys && faults.redeploys-- > 0) throw new Error('railway redeploy exited 1: redeploy failed');
      if (args[0] === 'domain') return { code: 1, stdout: '', stderr: 'no domain' };
      return { code: 0, stdout: '', stderr: '' };
    },
    async putFile() { throw new Error('Railway variables are never written as files'); },
  };
  return { transport, calls };
}

async function fixture() {
  const root = await temporaryDirectory('setup-self-provision');
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: '/opt/graphyard/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] }) as MasterConfig;
  const { transport, calls } = railway({ GITHUB_REPOSITORY: 'owner/project' });
  const target = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport });
  // The install record derives GITHUB_REPOSITORY too; the deployment has it, so it is never touched.
  const locate = async () => ({ ...target, derived: derived() });
  return { root, master, calls, locate };
}

test('unit:setup-self-provision — master setup plans the derived variables the deployment lacks from the install record\'s credentials on this host, and --apply sets exactly those through Railway with the secret over stdin, never printed, one audit entry each', async () => {
  const { root, master, calls, locate } = await fixture();
  try {
    // Without --apply: the plan names each missing variable, the secret only by fingerprint, and nothing is set.
    const plan = await masterSetup(root, master, { apply: false }, { locate });
    assert.deepEqual(plan.target, { provider: 'railway', service: 'graphyard' });
    assert.equal(plan.mode, 'plan');
    assert.deepEqual(plan.missing.map(value => value.name), derivedNames, 'GITHUB_REPOSITORY is already deployed');
    assert.deepEqual(plan.missing.slice(0, 2).map(value => value.value), ['main', 'docs/index.md']);
    assert.deepEqual(plan.missing[2], { name: 'GRAPHYARD_PRINCIPALS', value: REDACTED, secret: true, fingerprint: fingerprint(principals), source: 'the install plan\'s credentials' });
    assert.equal(plan.next, 'graphyard master setup --apply');
    assert.deepEqual(plan.set, []);
    assert.equal(calls.some(call => call.args[0] === 'variable' || call.args.includes('--set') || call.args[0] === 'redeploy'), false, 'a plan sets nothing');
    await assert.rejects(readFile(setupAuditFile(root), 'utf8'), { code: 'ENOENT' }, 'and audits nothing');

    // --apply: the plain values as arguments, the secret over stdin, then one redeploy, every command from the link directory.
    calls.length = 0;
    const applied = await masterSetup(root, master, { apply: true }, { locate, now: () => Date.parse('2026-10-07T05:00:00.000Z') });
    assert.deepEqual(applied.set, derivedNames);
    assert.equal(applied.next, null);
    const writes = calls.filter(call => call.args[0] !== 'status' && !(call.args[0] === 'variables' && call.args.includes('--json')) && call.args[0] !== 'domain');
    assert.deepEqual(writes.map(call => call.args), [
      ['variables', '--service', 'graphyard', '--skip-deploys', '--set', 'GITHUB_BASE_BRANCH=main', '--set', 'GRAPHYARD_GENERATED_FILES=docs/index.md'],
      ['variable', 'set', '--service', 'graphyard', '--skip-deploys', '--stdin', 'GRAPHYARD_PRINCIPALS'],
      ['redeploy', '--service', 'graphyard', '--yes'],
    ]);
    assert.equal(writes[1].input, principals, 'the secret goes over standard input');
    assert.ok(calls.every(call => call.cwd === root), 'every railway command runs in the link directory');
    assert.ok(calls.every(call => !call.args.join(' ').includes('p'.repeat(48))), 'never as an argument');

    // Redaction: neither the report nor the audit carries the secret.
    for (const [where, text] of [['report', JSON.stringify(applied)], ['audit', await readFile(setupAuditFile(root), 'utf8')]] as const) {
      assert.ok(!text.includes('p'.repeat(48)), `the ${where} never carries the secret`);
    }

    // One audit entry per variable set, by fingerprint.
    const audit = (await readFile(setupAuditFile(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(audit, applied.audit);
    assert.deepEqual(audit.map(entry => [entry.variable, entry.secret, entry.fingerprint, entry.provider, entry.service, entry.at]), [
      ['GITHUB_BASE_BRANCH', false, fingerprint('main'), 'railway', 'graphyard', '2026-10-07T05:00:00.000Z'],
      ['GRAPHYARD_GENERATED_FILES', false, fingerprint('docs/index.md'), 'railway', 'graphyard', '2026-10-07T05:00:00.000Z'],
      ['GRAPHYARD_PRINCIPALS', true, fingerprint(principals), 'railway', 'graphyard', '2026-10-07T05:00:00.000Z'],
    ]);

    // A host that recorded no deployment says how to name one, and sets nothing.
    const unnamed = await masterSetup(root, master, { apply: true }, { locate: async () => null });
    assert.equal(unnamed.target, null);
    assert.match(unnamed.next, /master setup --provider railway --service NAME --link-dir DIR --apply/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-self-provision — a deployment that already has every derived variable (one file-mounted), or an adapter that cannot set variables in place, is never written', async () => {
  const { root, master } = await fixture();
  try {
    const mounted = railway({ GITHUB_REPOSITORY: 'owner/project', GITHUB_BASE_BRANCH: 'release', GRAPHYARD_GENERATED_FILES: 'docs/index.md', GRAPHYARD_PRINCIPALS_FILE: '/run/graphyard/principals.json' });
    const target = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport: mounted.transport });
    const present = await masterSetup(root, master, { apply: true }, { locate: async () => ({ ...target, derived: derived() }) });
    assert.deepEqual([present.missing, present.set, present.next], [[], [], null], 'a present variable, whatever its value, is the deployment\'s own');
    assert.equal(mounted.calls.some(call => call.args[0] === 'redeploy'), false);

    const bundle = railway({});
    const whole = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport: bundle.transport });
    const { applyVariables: _omitted, ...rewrites } = whole.adapter;
    const planned = await masterSetup(root, master, { apply: true }, { locate: async () => ({ context: whole.context, adapter: { ...rewrites, provider: 'compose' }, derived: derived() }) });
    assert.deepEqual(planned.set, []);
    assert.equal(planned.canApply, false);
    assert.match(planned.next!, /rewrites the whole environment: graphyard install --provider railway --repo owner\/project --apply/);

    // A variable listing that could not be read is not an empty one: nothing is applied from it.
    const unread = railway({}, { listing: true });
    const blind = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport: unread.transport });
    const refused = await masterSetup(root, master, { apply: true }, { locate: async () => ({ ...blind, derived: derived() }) });
    assert.deepEqual([refused.observed, refused.missing, refused.set], [false, [], []]);
    assert.match(refused.next!, /variables could not be read on railway; nothing is applied/);
    assert.equal(unread.calls.some(call => call.args[0] === 'variable' || call.args.includes('--set') || call.args[0] === 'redeploy'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-self-provision — the first derivation of a name wins, and variables set before a failed redeploy are redeployed by the next run', async () => {
  const { root, master } = await fixture();
  try {
    const deployed: Record<string, string> = {};
    const staged = railway(deployed, { redeploys: 1 });
    const target = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport: staged.transport });
    const locate = async () => ({ ...target, derived: [...derived(), { name: 'GITHUB_BASE_BRANCH', value: 'stale', secret: false, source: 'a later derivation' }] });
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
    assert.deepEqual(staged.calls.filter(call => !['status', 'domain'].includes(call.args[0]) && !call.args.includes('--json')).map(call => call.args), [['redeploy', '--service', 'graphyard', '--yes']], 'only the redeploy, nothing set again');
    const settled = await masterSetup(root, master, { apply: true }, { locate });
    assert.deepEqual([settled.redeployed, settled.next], [[], null], 'and only once');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-self-provision — an audit entry that failed to append after the variables were set is written by the next run, once each', async () => {
  const { root, master } = await fixture();
  try {
    const deployed: Record<string, string> = { GITHUB_REPOSITORY: 'owner/project' };
    const bundle = railway(deployed);
    const target = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport: bundle.transport });
    const locate = async () => ({ ...target, derived: derived() });
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
    assert.equal(bundle.calls.some(call => call.args[0] === 'variable' || call.args[0] === 'redeploy'), false, 'nothing set or redeployed again');
    const lines = (await readFile(setupAuditFile(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.variable), derivedNames, 'one entry per variable');
    const settled = await masterSetup(root, master, { apply: true }, { locate });
    assert.deepEqual([settled.audit, settled.next], [[], null]);
    assert.equal((await readFile(setupAuditFile(root), 'utf8')).trim().split('\n').length, 3, 'never repeated');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-attention-owner — a corrupt self-provision status file reads as no report and never fails master status', async () => {
  const root = await temporaryDirectory('setup-attention-corrupt');
  try {
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: '/opt/graphyard/bin/graphyard.mjs',
      repository: 'owner/corrupt', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-corrupt', autoMerge: true, mergeMethod: 'merge', workers: [],
      browser: { profile: 'Default' } }) as MasterConfig;
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await writeFile(join(root, '.graphyard', 'setup-self-provision.json'), '{"at":"2026-10-07T0');
    const host = { platform: 'linux' as NodeJS.Platform, temporaryDirectories: [] as string[], home: root, run: () => '' };
    assert.equal((await setupHealth(root, master, host, async () => null)).setup.selfProvision, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-attention-owner — a missing derivable deployment variable is the master\'s attention, naming master setup --apply, never the human; the loop\'s setup step runs it itself and a status read never does', async () => {
  const root = await temporaryDirectory('setup-attention-owner');
  try {
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: '/opt/graphyard/bin/graphyard.mjs',
      repository: 'owner/attention', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-attention', autoMerge: true, mergeMethod: 'merge', workers: [],
      browser: { profile: 'Default' } }) as MasterConfig;
    const host = { platform: 'linux' as NodeJS.Platform, temporaryDirectories: [] as string[], home: root, run: () => '' };
    const { setup, attention } = await setupHealth(root, master, host, async () => null);
    assert.equal(attention.some(entry => entry.human && /variable/i.test(entry.text)), false, 'no human item for a derivable variable');
    assert.equal(setup.selfProvision, null, 'a status read runs nothing');

    // The loop's own run: master setup --apply, at most once an hour.
    const runs: boolean[] = [];
    const setupStub = (async (_root: string, _master: unknown, options: { apply: boolean }) => { runs.push(options.apply); return { set: ['GRAPHYARD_REVERT_APPROVER_APP_ID'], redeployed: [], next: null }; }) as unknown as typeof masterSetup;
    const now = Date.parse('2026-10-07T05:00:00.000Z');
    assert.equal((await loopSelfProvision(root, master, { now, setup: setupStub })).outcome, 'running');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(runs, [true], 'the loop runs master setup --apply');
    const done = { at: '2026-10-07T05:00:00.000Z', outcome: 'set GRAPHYARD_REVERT_APPROVER_APP_ID', failed: false };
    assert.deepEqual(await loopSelfProvision(root, master, { now: now + 60_000, setup: setupStub }), done);
    assert.deepEqual(runs, [true], 'not again within the hour');
    assert.deepEqual((await setupHealth(root, master, host, async () => null)).setup.selfProvision, done, 'the setup section reports what the loop did');
    await loopSelfProvision(root, master, { now: now + 3_600_000, setup: setupStub });
    assert.deepEqual(runs, [true, true], 'and again after it');
    await new Promise(resolve => setTimeout(resolve, 20));

    // A failed run fails the loop's next step, is kept for master status in another process, and is retried ten minutes on.
    const failing = (async () => { runs.push(true); throw new Error('railway is not logged in'); }) as unknown as typeof masterSetup;
    await loopSelfProvision(root, master, { now: now + 7_200_000, setup: failing });
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(loopSelfProvision(root, master, { now: now + 7_260_000, setup: failing }), /setup self-provision failed: railway is not logged in/);
    const kept = JSON.parse(await readFile(join(root, '.graphyard', 'setup-self-provision.json'), 'utf8'));
    assert.deepEqual([kept.failed, kept.outcome], [true, 'failed: railway is not logged in']);
    const failedItem = (await setupHealth(root, master, host, async () => null)).attention.find(entry => /master setup --apply failed/.test(entry.text));
    assert.deepEqual([failedItem?.role, failedItem?.human], ['master', false], 'the failure is the master\'s attention');
    assert.equal((await loopSelfProvision(root, master, { now: now + 7_260_000, setup: failing })).failed, true, 'reported once, not retried at once');
    assert.equal(runs.length, 3);
    await loopSelfProvision(root, master, { now: now + 7_800_000, setup: setupStub });
    assert.equal(runs.length, 4, 'retried ten minutes after the failure');
    // Failures in a row back off, doubling from ten minutes to at most a day: a setup that keeps failing is retried a bounded number of times a day.
    assert.deepEqual([0, 1, 2, 3, 8, 9, 20].map(loopProvisionDelay), [3_600_000, 600_000, 1_200_000, 2_400_000, 76_800_000, 86_400_000, 86_400_000]);

    // The step is the cycle's own: every cycle offers it, isolated, and a throw fails only that step.
    let offered = 0;
    const effects: DaemonEffects = {
      agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date(now).toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
      selfProvision: async () => { offered++; if (offered === 2) throw new Error('railway is not logged in'); },
    };
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => now);
    await runCycle(master, state, effects, () => now);
    assert.equal(offered, 2, 'each cycle runs the setup step');
    assert.match(Object.values(state.actions).find(action => action.kind === 'config')?.detail ?? '', /setup self-provision.*railway is not logged in/, 'a failed run is its own action');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// GY-1692 (GY-1691): the uat GRAPHYARD_RELEASE_TOKEN predated the operator agent graphyard-release-follow-up,
// so every failed candidate's filing was refused, and the fix — issue the identity, store its token as the
// secret — was parked on the human as a credential decision. The identity is an agent's, the install's admin
// credential is saved on the host, and the host's gh login administers the repository: `master setup --apply`
// keeps the credential current, and the loop runs it itself.
import { credentialIssuedAt, handoffProvesSecret, provisionReleaseFiling, releaseFilingAdministratorStep, releaseFilingTransitionSeconds, secretPredatesCredential, type ReleaseFilingDeps, type ReleaseFilingHandoff } from '../src/master/release-filing.js';

const fingerprintOf = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 16);
/**
 * A control plane's operator-agent API as the admin sees it, GitHub's uat secret as gh reads and sets it (a store lands
 * at `storeUpdatedAt`, to the second), and the master's handoff record on this host (`handoff`, none by default).
 */
function releaseFilingHost(options: { agents?: any[]; secretUpdatedAt?: string | null; admin?: string | null; setFails?: boolean; storeUpdatedAt?: string; handoff?: ReleaseFilingHandoff | null } = {}) {
  const agents: any[] = options.agents ?? [];
  let secret = options.secretUpdatedAt === undefined ? '2026-10-05T04:08:40Z' : options.secretUpdatedAt;
  let handoff: ReleaseFilingHandoff | null = options.handoff ?? null;
  const planeCalls: { path: string; method: string; body: any; token: string | null }[] = [], ghCalls: { args: string[]; input?: string }[] = [];
  /** The plane's rotate route refuses while set (a mutation that fails after an earlier one in the same run succeeded). */
  const faults = { rotateFails: false };
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://graphyard.example/api/', ''), body = init.body ? JSON.parse(String(init.body)) : undefined;
    planeCalls.push({ path, method: init.method ?? 'GET', body, token: String((init.headers as Record<string, string>).Authorization ?? '').replace('Bearer ', '') || null });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (planeCalls.at(-1)!.token !== 'admin-token-' + 'a'.repeat(32)) return json(403, { error: 'Administrator permission required' });
    if (path === 'operator-agents' && init.method === 'GET') return json(200, agents);
    // The document as src/operator-agent.ts keeps it: credentialIssuedAt set by setup and rotate, kept through configure (GY-1692).
    if (path === 'operator-agents') {
      const existing = agents.find(entry => entry.id === body.id);
      if (existing && !existing.revokedAt) return json(409, { error: 'Operator agent already exists' });
      // Setup of a revoked identity reinstates it under the new credential, its fingerprints kept (GY-1692).
      const document = { ...(existing ?? { createdAt: '2026-10-11T06:00:00.000Z', fingerprints: [], revision: 0 }), id: body.id, displayName: body.displayName, role: 'operator-agent', capabilities: body.capabilities, scope: body.scope, revision: (existing?.revision ?? 0) + 1, revokedAt: null,
        lastMutation: { kind: 'setup', at: '2026-10-11T06:00:00.000Z', reason: body.reason, ...(existing ? { reinstatedAfter: existing.revokedAt } : {}) }, credentialIssuedAt: '2026-10-11T06:00:00.000Z' };
      document.fingerprints = [...(existing?.fingerprints ?? []), fingerprintOf(body.token)];
      if (existing) agents.splice(agents.indexOf(existing), 1, document); else agents.push(document);
      return json(200, document);
    }
    const match = /^operator-agents\/([^/]+)\/(configure|rotate)$/.exec(path);
    if (match) {
      const agent = agents.find(entry => entry.id === decodeURIComponent(match[1]));
      if (match[2] === 'configure') { if (body.expectedRevision !== agent.revision) return json(409, { error: 'Operator-agent revision changed' }); agent.capabilities = body.capabilities; agent.scope = body.scope; }
      if (match[2] === 'rotate') { if (faults.rotateFails) return json(503, { error: 'the credential store is unavailable' }); agent.credentialIssuedAt = '2026-10-11T06:30:00.000Z'; agent.fingerprints = [...(agent.fingerprints ?? []), fingerprintOf(body.token)]; }
      agent.revision++; agent.lastMutation = { kind: match[2], at: '2026-10-11T06:30:00.000Z', ...(match[2] === 'rotate' ? { transitionEndsAt: 'later' } : {}) };
      return json(200, agent);
    }
    return json(404, { error: `no route ${path}` });
  }) as unknown as typeof fetch;
  const gh: NonNullable<ReleaseFilingDeps['gh']> = async (args, input) => {
    ghCalls.push({ args, ...(input === undefined ? {} : { input }) });
    if (args[0] === 'secret' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(secret ? [{ name: 'GRAPHYARD_RELEASE_TOKEN', updatedAt: secret }] : []), stderr: '' };
    if (args[0] === 'secret' && args[1] === 'set') { if (options.setFails) return { code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by personal access token' }; secret = options.storeUpdatedAt ?? '2026-10-11T06:31:00.000Z'; return { code: 0, stdout: '', stderr: '' }; }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  const audits: any[] = [];
  const deps: ReleaseFilingDeps = { adminToken: async () => options.admin === undefined ? 'admin-token-' + 'a'.repeat(32) : options.admin, fetch: fetcher, gh, token: () => 'b'.repeat(64), now: () => Date.parse('2026-10-11T06:30:00.000Z'), audit: async entry => { audits.push(entry); },
    handoff: { read: async () => handoff, write: async record => { handoff = record; } } };
  return { agents, deps, planeCalls, ghCalls, audits, faults, secretUpdatedAt: () => secret, handoff: () => handoff };
}
const filingMaster = { url: 'https://graphyard.example', repository: 'cryptob1/graphyard' };
const filingScope = { repositories: ['cryptob1/graphyard'], workItems: ['*'] };

test('manual:intervention-pattern-human-only-decision-build — GY-1691 (GY-1692): master setup --apply issues graphyard-release-follow-up with the install\'s admin credential and stores its token as the uat GRAPHYARD_RELEASE_TOKEN through gh, the token never printed; a plan only names the steps', async () => {
  // As recorded: no identity, a secret stored 2026-10-05 that predates it.
  const host = releaseFilingHost();
  const planned = await provisionReleaseFiling(filingMaster, { apply: false }, host.deps);
  assert.equal(planned.state, 'planned');
  assert.match(planned.detail, /graphyard master setup --apply would issue graphyard-release-follow-up holding only intent:create over cryptob1\/graphyard and store its token as the uat GRAPHYARD_RELEASE_TOKEN \(the one stored 2026-10-05T04:08:40Z predates the identity\)/);
  assert.deepEqual(host.planeCalls.map(call => call.method), ['GET'], 'a plan reads and writes nothing');
  assert.deepEqual(host.ghCalls.map(call => call.args.slice(0, 2).join(' ')), ['secret list']);
  const applied = await provisionReleaseFiling(filingMaster, { apply: true }, host.deps);
  assert.equal(applied.state, 'provisioned', applied.detail);
  assert.match(applied.detail, /provisioned graphyard-release-follow-up \(intent:create over cryptob1\/graphyard\) and stored its token as the uat GRAPHYARD_RELEASE_TOKEN of cryptob1\/graphyard through gh/);
  const setup = host.planeCalls.find(call => call.path === 'operator-agents' && call.method === 'POST')!;
  assert.deepEqual([setup.body.id, setup.body.displayName, setup.body.capabilities, setup.body.scope, setup.body.token], ['graphyard-release-follow-up', 'Release follow-up', ['intent:create'], filingScope, 'b'.repeat(64)]);
  assert.match(setup.body.reason, /^A failed release candidate files its follow-up\. GY-1692/);
  const stored = host.ghCalls.find(call => call.args[1] === 'set')!;
  assert.deepEqual(stored.args, ['secret', 'set', 'GRAPHYARD_RELEASE_TOKEN', '--repo', 'cryptob1/graphyard', '--env', 'uat']);
  assert.equal(stored.input, 'b'.repeat(64), 'the token goes to gh over standard input, never as an argument');
  assert.ok(!JSON.stringify(applied).includes('b'.repeat(64)) && !JSON.stringify(host.audits).includes('b'.repeat(64)), 'neither the report nor the audit carries the token');
  assert.deepEqual(host.audits.map(entry => [entry.variable, entry.secret, entry.provider, entry.service, entry.at, entry.fingerprint.length]), [['GRAPHYARD_RELEASE_TOKEN', true, 'github', 'cryptob1/graphyard/environments/uat', '2026-10-11T06:30:00.000Z', 16]]);
  // The store is read back and recorded as the master's handoff: the credential by fingerprint and the store as GitHub reports it, never the token.
  assert.deepEqual(host.handoff(), { at: '2026-10-11T06:30:00.000Z', fingerprint: fingerprintOf('b'.repeat(64)), secretUpdatedAt: '2026-10-11T06:31:00.000Z' });
  // Current afterwards: the secret stored is the credential the master stored.
  const current = await provisionReleaseFiling(filingMaster, { apply: true }, host.deps);
  assert.equal(current.state, 'current', current.detail);
  assert.match(current.detail, /is the credential the master stored/);
  assert.equal(host.ghCalls.filter(call => call.args[1] === 'set').length, 1, 'nothing is stored again');
});

test('manual:intervention-pattern-human-only-decision-build — GY-1691 (GY-1692): a secret older than the identity\'s credential is rotated with a transition, a broader identity is narrowed, a failed store is retried by the next run, and a host without the admin credential names the administrator\'s step in the setup attention, never a park', async () => {
  // The secret predates the credential the identity holds: rotate, the replaced credential staying valid for a running workflow.
  const stale = releaseFilingHost({ agents: [{ id: 'graphyard-release-follow-up', role: 'operator-agent', capabilities: ['intent:create'], scope: filingScope, revision: 3, createdAt: '2026-10-09T00:00:00.000Z', lastMutation: { kind: 'rotate', at: '2026-10-10T00:00:00.000Z' } }] });
  assert.equal(credentialIssuedAt(stale.agents[0]), '2026-10-10T00:00:00.000Z');
  const rotated = await provisionReleaseFiling(filingMaster, { apply: true }, stale.deps);
  assert.equal(rotated.state, 'rotated', rotated.detail);
  const rotate = stale.planeCalls.find(call => call.path.endsWith('/rotate'))!;
  assert.deepEqual([rotate.body.token, rotate.body.transitionSeconds], ['b'.repeat(64), releaseFilingTransitionSeconds]);
  assert.match(rotated.detail, /the replaced credential stays valid 60 minutes/);
  assert.equal(stale.secretUpdatedAt(), '2026-10-11T06:31:00.000Z');
  // A missing secret rotates too; a secret as new as the credential does not.
  const missing = releaseFilingHost({ secretUpdatedAt: null, agents: [{ id: 'graphyard-release-follow-up', role: 'operator-agent', capabilities: ['intent:create'], scope: filingScope, revision: 1, createdAt: '2026-10-09T00:00:00.000Z', lastMutation: { kind: 'setup', at: '2026-10-09T00:00:00.000Z' } }] });
  assert.equal((await provisionReleaseFiling(filingMaster, { apply: false }, missing.deps)).detail.includes('(none is stored)'), true);
  assert.equal((await provisionReleaseFiling(filingMaster, { apply: true }, missing.deps)).state, 'rotated');
  // Broader than filing needs: narrowed to intent:create over this repository alone, the secret untouched.
  const broad = releaseFilingHost({ secretUpdatedAt: '2026-10-10T12:00:00.000Z', agents: [{ id: 'graphyard-release-follow-up', role: 'operator-agent', capabilities: ['intent:create', 'intent:ready'], scope: { repositories: ['cryptob1/graphyard', 'cryptob1/other'], workItems: ['*'] }, revision: 2, createdAt: '2026-10-09T00:00:00.000Z', lastMutation: { kind: 'configure', at: '2026-10-10T00:00:00.000Z' } }] });
  const narrowed = await provisionReleaseFiling(filingMaster, { apply: true }, broad.deps);
  assert.equal(narrowed.state, 'configured', narrowed.detail);
  assert.match(narrowed.detail, /also holds intent:ready/);
  const configure = broad.planeCalls.find(call => call.path.endsWith('/configure'))!;
  assert.deepEqual([configure.body.expectedRevision, configure.body.capabilities, configure.body.scope], [2, ['intent:create'], filingScope]);
  assert.equal(broad.ghCalls.some(call => call.args[1] === 'set'), false);
  // gh refuses the store: the identity was rotated, so the next run sees the secret older than the credential and rotates again.
  const refusedStore = releaseFilingHost({ setFails: true, agents: [{ id: 'graphyard-release-follow-up', role: 'operator-agent', capabilities: ['intent:create'], scope: filingScope, revision: 1, createdAt: '2026-10-10T00:00:00.000Z', lastMutation: { kind: 'setup', at: '2026-10-10T00:00:00.000Z' } }] });
  const failedStore = await provisionReleaseFiling(filingMaster, { apply: true }, refusedStore.deps);
  assert.equal(failedStore.state, 'failed');
  assert.match(failedStore.detail, /rotated but storing GRAPHYARD_RELEASE_TOKEN in the uat environment of cryptob1\/graphyard failed \(gh exited 1\): HTTP 403.*the next run rotates it again/);
  assert.deepEqual(refusedStore.audits, [], 'nothing stored, nothing audited');
  assert.equal((await provisionReleaseFiling(filingMaster, { apply: false }, refusedStore.deps)).state, 'planned', 'the next run plans the rotation again');
  // A revoked identity is reinstated through setup under a fresh credential, which is stored: every credential it held stays revoked, nothing is rotated.
  const revoked = releaseFilingHost({ agents: [{ id: 'graphyard-release-follow-up', role: 'operator-agent', capabilities: ['intent:create'], scope: filingScope, revision: 3, createdAt: '2026-10-09T00:00:00.000Z', revokedAt: '2026-10-10T00:00:00.000Z', fingerprints: ['old1old1old1old1', 'old2old2old2old2'], lastMutation: { kind: 'revoke', at: '2026-10-10T00:00:00.000Z', reason: 'token leaked in a workflow log' } }] });
  const reinstatePlan = await provisionReleaseFiling(filingMaster, { apply: false }, revoked.deps);
  assert.match(reinstatePlan.detail, /would reinstate graphyard-release-follow-up, revoked 2026-10-10T00:00:00.000Z \(token leaked in a workflow log\), under a fresh credential holding only intent:create over cryptob1\/graphyard and store its token as the uat GRAPHYARD_RELEASE_TOKEN \(the one stored 2026-10-05T04:08:40Z predates the credential\)/);
  const reinstated = await provisionReleaseFiling(filingMaster, { apply: true }, revoked.deps);
  assert.equal(reinstated.state, 'reinstated', reinstated.detail);
  assert.match(reinstated.detail, /^reinstated graphyard-release-follow-up .*every credential revoked 2026-10-10T00:00:00.000Z stays revoked$/);
  const reinstate = revoked.planeCalls.find(call => call.method === 'POST')!;
  assert.deepEqual([reinstate.path, reinstate.body.id, reinstate.body.capabilities, reinstate.body.scope], ['operator-agents', 'graphyard-release-follow-up', ['intent:create'], filingScope], 'reissued through setup, never rotated');
  assert.match(reinstate.body.reason, /reinstated after the revocation of 2026-10-10T00:00:00.000Z: token leaked in a workflow log/);
  assert.deepEqual([revoked.agents[0].revokedAt, revoked.agents[0].revision, revoked.agents[0].fingerprints], [null, 4, ['old1old1old1old1', 'old2old2old2old2', fingerprintOf('b'.repeat(64))]]);
  assert.equal(revoked.ghCalls.filter(call => call.args[1] === 'set').length, 1);
  assert.equal((await provisionReleaseFiling(filingMaster, { apply: true }, revoked.deps)).state, 'current');
  // A credential the plane refuses is a failure the master owns.
  const notAdmin = releaseFilingHost({ admin: 'worker-token-' + 'w'.repeat(32) });
  assert.match((await provisionReleaseFiling(filingMaster, { apply: true }, notAdmin.deps)).detail, /Graphyard refused operator-agents \(403\): Administrator permission required/);
  // No admin credential on this host: the one case a person is needed, named as a setup step with the exact commands, and nothing is called.
  const absent = releaseFilingHost({ admin: null });
  const unavailable = await provisionReleaseFiling(filingMaster, { apply: true }, absent.deps);
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.next, releaseFilingAdministratorStep('cryptob1/graphyard'));
  // One token, minted first and handed to both commands: setup reads it from standard input and prints the document, never the token.
  assert.match(unavailable.next!, /TOKEN=\$\(openssl rand -hex 32\); printf %s "\$TOKEN" \| graphyard operator-agent setup FILE --token-stdin; printf %s "\$TOKEN" \| gh secret set GRAPHYARD_RELEASE_TOKEN --repo cryptob1\/graphyard --env uat; unset TOKEN/);
  assert.ok(!/printed token/.test(unavailable.next!), 'the step never says the token is printed');
  assert.deepEqual([absent.planeCalls, absent.ghCalls], [[], []]);

  // Through master setup and the loop's own run: the report and the kept outcome carry the step, and the setup attention owns it.
  const root = await temporaryDirectory('release-filing-setup');
  try {
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: '/opt/graphyard/bin/graphyard.mjs',
      repository: 'cryptob1/graphyard', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-graphyard', autoMerge: true, mergeMethod: 'merge', workers: [], browser: { profile: 'Default' } }) as MasterConfig;
    const provisioning = releaseFilingHost();
    const report = await masterSetup(root, master, { apply: true }, { locate: async () => null, releaseFiling: { ...provisioning.deps, audit: undefined } });
    assert.equal(report.releaseFiling.state, 'provisioned', report.releaseFiling.detail);
    const audit = (await readFile(setupAuditFile(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(audit.map(entry => [entry.variable, entry.provider, entry.service]), [['GRAPHYARD_RELEASE_TOKEN', 'github', 'cryptob1/graphyard/environments/uat']], 'the setup audit records the store by fingerprint');
    assert.ok(!(await readFile(setupAuditFile(root), 'utf8')).includes('b'.repeat(64)));
    const host = { platform: 'linux' as NodeJS.Platform, temporaryDirectories: [] as string[], home: root, run: () => '' };
    const now = Date.parse('2026-10-11T07:00:00.000Z');
    for (const [step, expectHuman, text] of [[unavailable, true, /cannot be issued from this host: no installation admin credential/], [failedStore, false, /left the release filing credential failed \(.*retried from ten minutes on, backing off\)/]] as const) {
      const stubRuns: number[] = [];
      const setupStub = (async () => { stubRuns.push(1); return { set: [], redeployed: [], next: null, releaseFiling: step }; }) as unknown as typeof masterSetup;
      const kept = await loopSelfProvision(join(root, step.state), master, { now, setup: setupStub });
      assert.equal(kept.outcome, 'running');
      await new Promise(resolve => setTimeout(resolve, 20));
      // A step that failed is a failed run (GY-1692): the cycle records it on the next step, and it is retried ten minutes on, not an hour; an
      // unavailable step is the host's standing condition, a success that waits the hour.
      if (step.state === 'failed') await assert.rejects(loopSelfProvision(join(root, step.state), master, { now: now + 1000, setup: setupStub }), /setup self-provision failed: release filing failed: .*gh exited 1/);
      const settled = await loopSelfProvision(join(root, step.state), master, { now: now + 1000, setup: setupStub });
      assert.deepEqual(settled.releaseFiling, step, 'the loop keeps what the step did');
      assert.ok(settled.outcome.includes(`release filing ${step.state}: `), settled.outcome);
      assert.equal(settled.failed, step.state === 'failed', `a ${step.state} step ${step.state === 'failed' ? 'is' : 'is not'} a failed run`);
      assert.deepEqual(JSON.parse(await readFile(join(root, step.state, '.graphyard', 'setup-self-provision.json'), 'utf8')).failed, step.state === 'failed', 'master status in another process reads the same');
      await loopSelfProvision(join(root, step.state), master, { now: now + 599_000, setup: setupStub });
      assert.equal(stubRuns.length, 1, 'not retried before ten minutes');
      await loopSelfProvision(join(root, step.state), master, { now: now + 600_000, setup: setupStub });
      assert.equal(stubRuns.length, step.state === 'failed' ? 2 : 1, step.state === 'failed' ? 'a failed filing step is retried ten minutes on' : 'an unavailable step waits the hour');
      await new Promise(resolve => setTimeout(resolve, 20));
      const health = await setupHealth(join(root, step.state), master, host, async () => null);
      const item = health.attention.find(entry => text.test(entry.text))!;
      assert.ok(item, `${step.state} is attention: ${JSON.stringify(health.attention)}`);
      assert.deepEqual([item.human, item.role, item.next], [expectHuman, expectHuman ? 'human' : 'master', expectHuman ? step.next : setupApplyNext]);
      if (expectHuman) assert.equal(item.humanOnly, 'issuing credentials to people');
      assert.ok(health.setup.attention.includes(item.text), `${step.state} is in the setup section too, so setup health never reads clear while filing is blocked`);
      assert.equal(health.attention.filter(entry => entry.subject === 'setup' && /release filing credential|master setup --apply failed/.test(entry.text)).length, 1, 'the filing diagnostic is the run\'s one item, not doubled by a generic failed-run item');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('manual:intervention-pattern-human-only-decision-build — GY-1691 (GY-1692): the credential issue time survives a later configure, so a narrowing that succeeds before its rotation fails leaves the stale secret stale for the next run; an unrecorded issue is bounded by the last mutation; a store within the rotation\'s second is current only through the master\'s own handoff record, and one the master did not make is rotated', async () => {
  // Rotated out of band at T1 (the secret, stored T0 < T1, was never updated) and since widened: this run narrows,
  // then the plane refuses the rotation. lastMutation now reads configure, but credentialIssuedAt still reads T1.
  const wide = { repositories: ['cryptob1/graphyard', 'cryptob1/other'], workItems: ['*'] };
  const host = releaseFilingHost({ secretUpdatedAt: '2026-10-09T12:00:00.000Z', agents: [{ id: 'graphyard-release-follow-up', role: 'operator-agent', capabilities: ['intent:create'], scope: wide, revision: 4, createdAt: '2026-10-09T00:00:00.000Z', credentialIssuedAt: '2026-10-10T00:00:00.000Z', lastMutation: { kind: 'rotate', at: '2026-10-10T00:00:00.000Z' } }] });
  host.faults.rotateFails = true;
  const first = await provisionReleaseFiling(filingMaster, { apply: true }, host.deps);
  assert.equal(first.state, 'failed', first.detail);
  assert.match(first.detail, /Graphyard refused operator-agents\/graphyard-release-follow-up\/rotate \(503\)/);
  assert.deepEqual(host.planeCalls.filter(call => call.method === 'POST').map(call => call.path.split('/').at(-1)), ['configure', 'rotate'], 'the narrowing succeeded before the rotation was refused');
  assert.deepEqual([host.agents[0].lastMutation.kind, host.agents[0].credentialIssuedAt, host.agents[0].scope], ['configure', '2026-10-10T00:00:00.000Z', filingScope]);
  assert.equal(credentialIssuedAt(host.agents[0]), '2026-10-10T00:00:00.000Z', 'the issue time is the rotation, not the configure that followed it');
  // The next run still finds the secret stale: it plans the rotation alone (nothing left to narrow), and with the plane back it rotates and stores.
  const planned = await provisionReleaseFiling(filingMaster, { apply: false }, host.deps);
  assert.equal(planned.state, 'planned', planned.detail);
  assert.match(planned.detail, /would rotate graphyard-release-follow-up's credential .*the one stored 2026-10-09T12:00:00.000Z is not proven newer than the credential issued 2026-10-10T00:00:00.000Z/);
  assert.ok(!planned.detail.includes('narrow'), planned.detail);
  const stillRefused = await provisionReleaseFiling(filingMaster, { apply: true }, host.deps);
  assert.equal(stillRefused.state, 'failed', 'a run while the plane still refuses never reads the secret as current');
  host.faults.rotateFails = false;
  const rotated = await provisionReleaseFiling(filingMaster, { apply: true }, host.deps);
  assert.equal(rotated.state, 'rotated', rotated.detail);
  assert.equal(host.planeCalls.filter(call => call.path.endsWith('/configure')).length, 1, 'the identity is narrowed once');
  assert.equal((await provisionReleaseFiling(filingMaster, { apply: true }, host.deps)).state, 'current');
  assert.equal(host.ghCalls.filter(call => call.args[1] === 'set').length, 1, 'the secret is stored once, by the rotation that succeeded');

  // A document kept before credentialIssuedAt was recorded: its last mutation bounds the issue from above, so a
  // configure after an unseen rotation still rotates once more, and a secret newer than every mutation is current.
  const legacy = { id: 'graphyard-release-follow-up', role: 'operator-agent', capabilities: ['intent:create'], scope: filingScope, revision: 5, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-10T06:00:00.000Z', lastMutation: { kind: 'configure', at: '2026-10-10T06:00:00.000Z' } };
  assert.equal(credentialIssuedAt(legacy), '2026-10-10T06:00:00.000Z');
  assert.equal(credentialIssuedAt({ createdAt: '2026-10-09T00:00:00.000Z' }), '2026-10-09T00:00:00.000Z');
  assert.equal((await provisionReleaseFiling(filingMaster, { apply: true }, releaseFilingHost({ secretUpdatedAt: '2026-10-10T03:00:00.000Z', agents: [{ ...legacy }] }).deps)).state, 'rotated', 'a secret older than the last mutation is rotated');
  assert.equal((await provisionReleaseFiling(filingMaster, { apply: true }, releaseFilingHost({ secretUpdatedAt: '2026-10-10T07:00:00.000Z', agents: [{ ...legacy }] }).deps)).state, 'current', 'a secret newer than every mutation is current');

  // GitHub records the store to the second: a store is proven newer than the credential only when its second begins after the
  // issue's instant. One within the issue's second may have landed before the rotation (stored 06:30:00.100, rotated 06:30:00.700,
  // both read 06:30:00): not proven, so it is stale unless the master's own handoff record proves it stored this credential.
  assert.equal(secretPredatesCredential('2026-10-11T06:30:01Z', '2026-10-11T06:30:00.700Z'), false);
  assert.equal(secretPredatesCredential('2026-10-11T06:30:00Z', '2026-10-11T06:30:00.700Z'), true, 'a store within the rotation\'s second is not proven newer');
  assert.equal(secretPredatesCredential('2026-10-11T06:30:00Z', '2026-10-11T06:30:00.000Z'), true, 'nor one in the second a rotation on the second begins');
  assert.equal(secretPredatesCredential('2026-10-11T06:29:59Z', '2026-10-11T06:30:00.700Z'), true);
  const newest = fingerprintOf('oob'.repeat(22)), rotatedDocument = { id: 'graphyard-release-follow-up', role: 'operator-agent', capabilities: ['intent:create'], scope: filingScope, revision: 2, createdAt: '2026-10-09T00:00:00.000Z', fingerprints: [fingerprintOf('t0'.repeat(32)), newest], credentialIssuedAt: '2026-10-11T06:30:00.700Z', lastMutation: { kind: 'rotate', at: '2026-10-11T06:30:00.700Z' } };
  // The administrator stored the old token at 06:30:00.100 and rotated at 06:30:00.700: GitHub reports 06:30:00, and no handoff record
  // names that store, so the expired token is not read as current — the master rotates, stores, and records the handoff.
  const storedBeforeRotation = releaseFilingHost({ secretUpdatedAt: '2026-10-11T06:30:00Z', storeUpdatedAt: '2026-10-11T06:30:00Z', agents: [{ ...rotatedDocument, fingerprints: [...rotatedDocument.fingerprints] }] });
  const planned2 = await provisionReleaseFiling(filingMaster, { apply: false }, storedBeforeRotation.deps);
  assert.equal(planned2.state, 'planned', planned2.detail);
  assert.match(planned2.detail, /would rotate .*the one stored 2026-10-11T06:30:00Z is not proven newer than the credential issued 2026-10-11T06:30:00.700Z/);
  const rotatedAgain = await provisionReleaseFiling(filingMaster, { apply: true }, storedBeforeRotation.deps);
  assert.equal(rotatedAgain.state, 'rotated', rotatedAgain.detail);
  assert.deepEqual(storedBeforeRotation.planeCalls.filter(call => call.method === 'POST').map(call => call.path.split('/').at(-1)), ['rotate']);
  assert.deepEqual(storedBeforeRotation.handoff(), { at: '2026-10-11T06:30:00.000Z', fingerprint: fingerprintOf('b'.repeat(64)), secretUpdatedAt: '2026-10-11T06:30:00Z' }, 'the handoff records the master\'s own store, within the rotation\'s second');
  // The master's own store landed in its rotation's second too (GitHub still reads 06:30:00): the record proves it, so the next run is current and nothing is rotated again.
  const afterwards = await provisionReleaseFiling(filingMaster, { apply: true }, storedBeforeRotation.deps);
  assert.equal(afterwards.state, 'current', afterwards.detail);
  assert.match(afterwards.detail, /is the credential the master stored \(issued 2026-10-11T06:30:00.000Z\)/);
  assert.equal(storedBeforeRotation.planeCalls.filter(call => call.method === 'POST').length, 1, 'one rotation, not one per run');
  // The record proves only the credential it names at the store it saw: a rotation since, or a store since, falls back to time.
  const record = { at: '2026-10-11T06:30:00.700Z', fingerprint: newest, secretUpdatedAt: '2026-10-11T06:30:00Z' };
  assert.equal(handoffProvesSecret(record, rotatedDocument, { updatedAt: '2026-10-11T06:30:00Z' }), true);
  assert.equal(handoffProvesSecret(record, { ...rotatedDocument, fingerprints: [...rotatedDocument.fingerprints, fingerprintOf('later'.repeat(13))] }, { updatedAt: '2026-10-11T06:30:00Z' }), false, 'a later rotation is not the credential the record stored');
  assert.equal(handoffProvesSecret(record, rotatedDocument, { updatedAt: '2026-10-11T06:30:05Z' }), false, 'a store since is not the one the record saw');
  assert.equal(handoffProvesSecret(record, rotatedDocument, null), false);
  assert.equal(handoffProvesSecret(null, rotatedDocument, { updatedAt: '2026-10-11T06:30:00Z' }), false);
  const proven = releaseFilingHost({ secretUpdatedAt: '2026-10-11T06:30:00Z', handoff: record, agents: [{ ...rotatedDocument, fingerprints: [...rotatedDocument.fingerprints] }] });
  assert.equal((await provisionReleaseFiling(filingMaster, { apply: true }, proven.deps)).state, 'current');
  assert.deepEqual(proven.planeCalls.map(call => call.method), ['GET'], 'nothing is rotated for a store the master\'s record proves');
  // Without the record (another host, or a lost file) the same store is rotated once more — never read as current.
  const unrecorded = releaseFilingHost({ secretUpdatedAt: '2026-10-11T06:30:00Z', agents: [{ ...rotatedDocument, fingerprints: [...rotatedDocument.fingerprints] }] });
  assert.equal((await provisionReleaseFiling(filingMaster, { apply: true }, unrecorded.deps)).state, 'rotated');
});
