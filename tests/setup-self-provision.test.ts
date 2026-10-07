import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { deploymentTarget, REDACTED } from '../src/install/index.js';
import { fingerprint } from '../src/install/secrets.js';
import type { Transport } from '../src/install/transport.js';
import { loopSelfProvision, masterSetup, setupApplyNext, setupAuditFile, setupHealth } from '../src/cli/master-setup.js';
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
function railway(deployed: Record<string, string>) {
  const calls: { args: string[]; input?: string; cwd?: string }[] = [];
  const transport: Transport = {
    description: 'scripted railway',
    async exec(program, args, options = {}) {
      assert.equal(program, 'railway');
      calls.push({ args, ...(options.input !== undefined ? { input: options.input } : {}), cwd: options.cwd });
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ name: 'graphyard', services: { edges: [{ node: { name: 'graphyard' } }, { node: { name: 'Postgres' } }] } }), stderr: '' };
      if (args[0] === 'variables' && args.includes('--json')) return { code: 0, stdout: JSON.stringify(deployed), stderr: '' };
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
    const setupStub = (async (_root: string, _master: unknown, options: { apply: boolean }) => { runs.push(options.apply); return { set: ['GRAPHYARD_REVERT_APPROVER_APP_ID'], next: null }; }) as unknown as typeof masterSetup;
    const now = Date.parse('2026-10-07T05:00:00.000Z');
    assert.equal(loopSelfProvision(root, master, { now, setup: setupStub }).outcome, 'running');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(runs, [true], 'the loop runs master setup --apply');
    assert.deepEqual(loopSelfProvision(root, master, { now: now + 60_000, setup: setupStub }), { at: '2026-10-07T05:00:00.000Z', outcome: 'set GRAPHYARD_REVERT_APPROVER_APP_ID' });
    assert.deepEqual(runs, [true], 'not again within the hour');
    assert.deepEqual((await setupHealth(root, master, host, null, async () => null)).setup.selfProvision, { at: '2026-10-07T05:00:00.000Z', outcome: 'set GRAPHYARD_REVERT_APPROVER_APP_ID' }, 'the setup section reports what the loop did');
    loopSelfProvision(root, master, { now: now + 3_600_000, setup: setupStub });
    assert.deepEqual(runs, [true, true], 'and again after it');

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
