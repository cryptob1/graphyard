import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { deploymentTarget, REDACTED } from '../src/install/index.js';
import { fingerprint } from '../src/install/secrets.js';
import type { Transport } from '../src/install/transport.js';
import { loopProvisionDelay, loopSelfProvision, masterSetup, setupApplyNext, setupAuditFile, setupHealth } from '../src/cli/master-setup.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { mainGuardReadiness } from '../src/main-guard.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1416: production was installed before GY-1352 derived the main guard's revert approver from the
// reviewer App, so it never got GRAPHYARD_REVERT_APPROVER_*; GY-1365 then parked that on the human
// although the reviewer App's registration sat on this host. `master setup` finds every derived
// variable the deployment lacks and, with --apply, sets it through the provider adapter.

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const reviewerApp = { appId: 4242, installationId: 99, slug: 'graphyard-reviewer', repository: 'owner/project', privateKey };
const revertNames = ['GRAPHYARD_REVERT_APPROVER_APP_ID', 'GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY'];

/** A Railway project whose `graphyard` service runs with the control-plane App but no revert approver. */
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
  const credentialFile = join(root, 'reviewer.json');
  await writeFile(credentialFile, JSON.stringify(reviewerApp), { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: '/opt/graphyard/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
    reviewer: { appId: reviewerApp.appId, installationId: reviewerApp.installationId, slug: reviewerApp.slug, credentialFile, boundAt: '2026-10-01T00:00:00.000Z' } }) as MasterConfig;
  const { transport, calls } = railway({ GITHUB_APP_ID: '1234', GITHUB_PRIVATE_KEY: 'deployed-control-plane-key-material', GITHUB_REPOSITORY: 'owner/project' });
  const target = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport });
  // The install record would derive GITHUB_APP_ID too; the deployment has it, so it is never touched.
  const locate = async () => ({ ...target, derived: [{ name: 'GITHUB_APP_ID', value: '1234', secret: false, source: 'the control-plane App registration' }] });
  return { root, master, calls, locate };
}

test('unit:setup-self-provision — master setup plans the revert approver variables the deployment lacks from the reviewer App registration saved on this host, and --apply sets exactly those through Railway with the key over stdin, never printed, one audit entry each', async () => {
  const { root, master, calls, locate } = await fixture();
  try {
    // Without --apply: the plan names each missing variable, the key only by fingerprint, and nothing is set.
    const plan = await masterSetup(root, master, { apply: false }, { locate });
    assert.deepEqual(plan.target, { provider: 'railway', service: 'graphyard' });
    assert.equal(plan.mode, 'plan');
    assert.deepEqual(plan.missing.map(value => value.name), revertNames, 'the revert approver only: GITHUB_APP_ID is already deployed');
    assert.deepEqual(plan.missing.slice(0, 2).map(value => value.value), ['4242', '99']);
    assert.deepEqual(plan.missing[2], { name: 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY', value: REDACTED, secret: true, fingerprint: fingerprint(privateKey), source: `the reviewer App graphyard-reviewer registration ${master.reviewer!.credentialFile}` });
    assert.equal(plan.next, 'graphyard master setup --apply');
    assert.deepEqual(plan.set, []);
    assert.equal(calls.some(call => call.args[0] === 'variable' || call.args.includes('--set') || call.args[0] === 'redeploy'), false, 'a plan sets nothing');
    await assert.rejects(readFile(setupAuditFile(root), 'utf8'), { code: 'ENOENT' }, 'and audits nothing');

    // --apply: the two ids as arguments, the key over stdin, then one redeploy, every command from the link directory.
    calls.length = 0;
    const applied = await masterSetup(root, master, { apply: true }, { locate, now: () => Date.parse('2026-10-07T05:00:00.000Z') });
    assert.deepEqual(applied.set, revertNames);
    assert.equal(applied.next, null);
    const writes = calls.filter(call => call.args[0] !== 'status' && !(call.args[0] === 'variables' && call.args.includes('--json')) && call.args[0] !== 'domain');
    assert.deepEqual(writes.map(call => call.args), [
      ['variables', '--service', 'graphyard', '--skip-deploys', '--set', 'GRAPHYARD_REVERT_APPROVER_APP_ID=4242', '--set', 'GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID=99'],
      ['variable', 'set', '--service', 'graphyard', '--skip-deploys', '--stdin', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY'],
      ['redeploy', '--service', 'graphyard', '--yes'],
    ]);
    assert.equal(writes[1].input, privateKey, 'the key goes over standard input');
    assert.ok(calls.every(call => call.cwd === root), 'every railway command runs in the link directory');
    assert.ok(calls.every(call => !call.args.join(' ').includes('PRIVATE KEY')), 'never as an argument');

    // Redaction: neither the report nor the audit carries the key.
    for (const [where, text] of [['report', JSON.stringify(applied)], ['audit', await readFile(setupAuditFile(root), 'utf8')]] as const) {
      assert.ok(!text.includes('BEGIN PRIVATE KEY') && !text.includes(privateKey.split('\n')[1]), `the ${where} never carries the key`);
    }

    // One audit entry per variable set, by fingerprint.
    const audit = (await readFile(setupAuditFile(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(audit, applied.audit);
    assert.deepEqual(audit.map(entry => [entry.variable, entry.secret, entry.fingerprint, entry.provider, entry.service, entry.at]), [
      ['GRAPHYARD_REVERT_APPROVER_APP_ID', false, fingerprint('4242'), 'railway', 'graphyard', '2026-10-07T05:00:00.000Z'],
      ['GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID', false, fingerprint('99'), 'railway', 'graphyard', '2026-10-07T05:00:00.000Z'],
      ['GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY', true, fingerprint(privateKey), 'railway', 'graphyard', '2026-10-07T05:00:00.000Z'],
    ]);

    // A host that recorded no deployment says how to name one, and sets nothing.
    const unnamed = await masterSetup(root, master, { apply: true }, { locate: async () => null });
    assert.equal(unnamed.target, null);
    assert.match(unnamed.next, /master setup --provider railway --service NAME --link-dir DIR --apply/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-self-provision — a deployment that already has the key file-mounted, or an adapter that cannot set variables in place, is never written', async () => {
  const { root, master } = await fixture();
  try {
    const mounted = railway({ GRAPHYARD_REVERT_APPROVER_APP_ID: '4242', GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID: '99', GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY_FILE: '/run/graphyard/revert-approver-private-key.pem' });
    const target = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport: mounted.transport });
    const present = await masterSetup(root, master, { apply: true }, { locate: async () => ({ ...target, derived: [] }) });
    assert.deepEqual([present.missing, present.set, present.next], [[], [], null]);
    assert.equal(mounted.calls.some(call => call.args[0] === 'redeploy'), false);

    const bundle = railway({});
    const whole = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport: bundle.transport });
    const { applyVariables: _omitted, ...rewrites } = whole.adapter;
    const planned = await masterSetup(root, master, { apply: true }, { locate: async () => ({ context: whole.context, adapter: { ...rewrites, provider: 'compose' }, derived: [] }) });
    assert.deepEqual(planned.set, []);
    assert.equal(planned.canApply, false);
    assert.match(planned.next!, /rewrites the whole environment: graphyard install --provider railway --repo owner\/project --apply/);

    // A variable listing that could not be read is not an empty one: nothing is applied from it.
    const unread = railway({}, { listing: true });
    const blind = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport: unread.transport });
    const refused = await masterSetup(root, master, { apply: true }, { locate: async () => ({ ...blind, derived: [{ name: 'GITHUB_APP_ID', value: '1234', secret: false, source: 'the control-plane App registration' }] }) });
    assert.deepEqual([refused.observed, refused.missing, refused.set], [false, [], []]);
    assert.match(refused.next!, /variables could not be read on railway; nothing is applied/);
    assert.equal(unread.calls.some(call => call.args[0] === 'variable' || call.args.includes('--set') || call.args[0] === 'redeploy'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-self-provision — the reviewer bound now wins over the install record\'s, and variables set before a failed redeploy are redeployed by the next run', async () => {
  const { root, master } = await fixture();
  try {
    const deployed: Record<string, string> = {};
    const staged = railway(deployed, { redeploys: 1 });
    const target = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport: staged.transport });
    // The install record still derives the reviewer it was installed with; `master reviewer bind` has since bound another.
    const recorded = [{ name: 'GRAPHYARD_REVERT_APPROVER_APP_ID', value: '1111', secret: false, source: 'the reviewer App registration in the install record' }];
    const locate = async () => ({ ...target, derived: recorded });
    const plan = await masterSetup(root, master, { apply: false }, { locate });
    assert.equal(plan.missing.find(value => value.name === 'GRAPHYARD_REVERT_APPROVER_APP_ID')?.value, '4242', 'the bound reviewer, not the recorded one');

    await assert.rejects(masterSetup(root, master, { apply: true }, { locate }), /redeploy failed/);
    assert.deepEqual(Object.keys(deployed), revertNames, 'set, but never redeployed');
    const owed = await masterSetup(root, master, { apply: false }, { locate });
    assert.deepEqual([owed.missing, owed.pendingRedeploy, owed.next], [[], revertNames, 'graphyard master setup --apply'], 'present variables still owe their redeploy');
    staged.calls.length = 0;
    const retried = await masterSetup(root, master, { apply: true }, { locate });
    assert.deepEqual([retried.set, retried.redeployed, retried.pendingRedeploy], [[], revertNames, []]);
    assert.deepEqual(staged.calls.filter(call => !['status', 'domain'].includes(call.args[0]) && !call.args.includes('--json')).map(call => call.args), [['redeploy', '--service', 'graphyard', '--yes']], 'only the redeploy, nothing set again');
    const settled = await masterSetup(root, master, { apply: true }, { locate });
    assert.deepEqual([settled.redeployed, settled.next], [[], null], 'and only once');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-self-provision — an audit entry that failed to append after the variables were set is written by the next run, once each', async () => {
  const { root, master } = await fixture();
  try {
    const deployed: Record<string, string> = {};
    const bundle = railway(deployed);
    const target = deploymentTarget({ provider: 'railway', repository: 'owner/project', service: 'graphyard', linkDirectory: root, transport: bundle.transport });
    const locate = async () => ({ ...target, derived: [] });
    // The audit log is a directory for the first run, so every append fails after the variables are set and redeployed.
    await rm(setupAuditFile(root), { force: true });
    await mkdir(setupAuditFile(root), { recursive: true });
    await assert.rejects(masterSetup(root, master, { apply: true }, { locate }));
    assert.deepEqual(Object.keys(deployed), revertNames, 'set and redeployed');
    await rm(setupAuditFile(root), { recursive: true, force: true });
    bundle.calls.length = 0;
    const owed = await masterSetup(root, master, { apply: false }, { locate });
    assert.equal(owed.next, 'graphyard master setup --apply', 'the unwritten audit is still owed');
    const retried = await masterSetup(root, master, { apply: true }, { locate });
    assert.deepEqual([retried.set, retried.redeployed, retried.audit.map(entry => entry.variable)], [[], [], revertNames]);
    assert.equal(bundle.calls.some(call => call.args[0] === 'variable' || call.args[0] === 'redeploy'), false, 'nothing set or redeployed again');
    const lines = (await readFile(setupAuditFile(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.variable), revertNames, 'one entry per variable');
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
    assert.equal((await setupHealth(root, master, host, null, async () => null)).setup.selfProvision, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:setup-attention-owner — a missing derivable deployment variable is the master\'s attention, naming master setup --apply, never the human; the loop\'s setup step runs it itself and a status read never does', async () => {
  const root = await temporaryDirectory('setup-attention-owner');
  try {
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: '/opt/graphyard/bin/graphyard.mjs',
      repository: 'owner/attention', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-attention', autoMerge: true, mergeMethod: 'merge', workers: [],
      browser: { profile: 'Default' } }) as MasterConfig;
    const host = { platform: 'linux' as NodeJS.Platform, temporaryDirectories: [] as string[], home: root, run: () => '' };
    const { setup, attention } = await setupHealth(root, master, host, { mainGuard: mainGuardReadiness({ github: true, required: ['test'], revertApprover: null }) }, async () => null);
    const item = attention.find(entry => /revert approver is missing/.test(entry.text))!;
    assert.ok(item, JSON.stringify(attention));
    assert.deepEqual([item.subject, item.role, item.human, item.humanOnly], ['setup', 'master', false, null], 'owned by the master, never the human');
    assert.ok(item.next.startsWith('graphyard master setup --apply'), item.next);
    assert.equal(item.next, setupApplyNext);
    assert.equal(attention.some(entry => entry.human && /revert approver|variable/i.test(entry.text)), false, 'no human item for a derivable variable');
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
    assert.deepEqual((await setupHealth(root, master, host, null, async () => null)).setup.selfProvision, done, 'the setup section reports what the loop did');
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
    const failedItem = (await setupHealth(root, master, host, null, async () => null)).attention.find(entry => /master setup --apply failed/.test(entry.text));
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
