import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicPrivateWrite, loadStoredMasterConfig, masterConfigSchema, setupMaster } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1918: `master init` rebuilt .graphyard/master.json field by field and dropped every field its
// own list did not name — the operator-agent and approver identities `master autonomy --apply`
// records among them — and `up`'s master-loop step reruns `master init` on every start, after
// master-autonomy has run, so every rerun unprovisioned the identities and the loop's acceptance
// step returned silently, stranding every goal in acceptance-drafting with no attention item.
// setupMaster now keeps every field of the previous config it does not itself set.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const rerunToken = 'rerun-token-'.padEnd(40, 'y');
const config = (root: string) => join(root, '.graphyard/master.json');

async function repository() {
  const root = await temporaryDirectory('master-init-keep');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}
const coordinatorStatus = (overrides: Record<string, unknown> = {}) => async () =>
  new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, ...overrides }));

/** What `master autonomy --apply` writes: the identities recorded beside the coordinator's token, re-parsed through the schema. */
async function applyAutonomyIdentities(root: string, credentials: string, extra: Record<string, unknown> = {}) {
  const stored = await loadStoredMasterConfig(root);
  await atomicPrivateWrite(config(root), masterConfigSchema.parse({ ...stored, supervision: 'autonomous',
    operatorAgent: { id: 'graphyard-master-project-operator', credentialFile: join(credentials, 'masters', 'operator.token') },
    approver: { id: 'graphyard-approver-project', credentialFile: join(credentials, 'masters', 'approver.token') }, ...extra }));
}

test('unit:master-init-keeps-identities — a master init rerun keeps the operator-agent and approver identities byte-equal while updating the fields init owns', async () => {
  const root = await repository(); const credentials = await temporaryDirectory('master-init-credentials');
  try {
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, hostId: 'machine-a' }, coordinatorStatus() as typeof fetch);
    await applyAutonomyIdentities(root, credentials);
    const before = JSON.parse(await readFile(config(root), 'utf8'));
    assert.equal(before.supervision, 'autonomous');
    assert.deepEqual(before.operatorAgent, { id: 'graphyard-master-project-operator', credentialFile: join(credentials, 'masters', 'operator.token') });

    // The rerun `up`'s master-loop step makes: fresh coordinator credential, another launcher, and a
    // control plane reporting a different base branch and GitHub App id.
    const secondLauncher = join(credentials, 'launcher-b.mjs'); await writeFile(secondLauncher, 'export {}\n');
    await setupMaster(root, { url: 'https://graphyard.example', token: rerunToken, cliPath: secondLauncher, credentialDirectory: credentials, hostId: 'machine-b' }, coordinatorStatus({ baseBranch: 'develop', githubAppId: 5678 }) as typeof fetch);
    const after = JSON.parse(await readFile(config(root), 'utf8'));
    const kept = await loadStoredMasterConfig(root);
    assert.equal(JSON.stringify(after.operatorAgent), JSON.stringify(before.operatorAgent), 'the operator-agent identity survives byte-equal');
    assert.equal(JSON.stringify(after.approver), JSON.stringify(before.approver), 'the approver identity survives byte-equal');
    assert.equal(after.supervision, 'autonomous', 'autonomy itself survives');
    // init still owns its own fields: each is written from the rerun's inputs, not left stale.
    assert.equal(kept.baseBranch, 'develop');
    assert.equal(kept.githubAppId, 5678);
    assert.equal(kept.hostId, 'machine-b');
    assert.equal(kept.cliPath, resolve(secondLauncher));
    assert.equal(kept.credentialFile, before.credentialFile, 'the credentialFile stays the path the url hashes to');
    assert.equal(await readFile(kept.credentialFile, 'utf8'), rerunToken, 'and holds the rerun credential');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});

test('unit:master-init-keeps-unowned-fields — every previous field init does not set survives the re-init, so no command-written field is dropped', async () => {
  const root = await repository(); const credentials = await temporaryDirectory('master-init-unowned');
  try {
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials }, coordinatorStatus() as typeof fetch);
    // Fields other commands write, none of which setupMaster names: supervised mode and the operator
    // login (`up --local`), the environment inventory and account pinning (`master environments`),
    // the upstream filing target, the invariant thresholds, delivery-speed targets and the review cap.
    const unowned = {
      supervision: 'supervised' as const, operatorLogin: 'vish',
      environments: [{ name: 'host-claude', kind: 'claude' as const, home: '/opt/agent-home/claude' }],
      herdrInstance: { configHome: '/opt/herdr-config', session: 'gy' },
      upstream: { url: 'https://upstream.example', credentialFile: '/opt/graphyard/upstream.token' },
      invariants: masterConfigSchema.parse({ version: 1, url: 'u', credentialFile: 'c', cliPath: 'c', repository: 'o/p', baseBranch: 'main', githubAppId: 1, hostId: 'h', masterAgentName: 'm', invariants: {} }).invariants,
      deliverySpeed: { readyToMergedP90Ms: 7_200_000, mergedToProductionP90Ms: 28_800_000 },
      reviewRoundCap: 3, mergeQueue: { rerunFailedChecks: 2 },
    };
    await applyAutonomyIdentities(root, credentials, unowned);
    const before = JSON.parse(await readFile(config(root), 'utf8'));
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials }, coordinatorStatus() as typeof fetch);
    const after = JSON.parse(await readFile(config(root), 'utf8'));
    for (const field of Object.keys(unowned)) assert.deepEqual(after[field], before[field], `${field} survives the re-init unchanged`);
    assert.deepEqual(after.operatorAgent, before.operatorAgent, 'the operator-agent identity survives beside them');
    assert.deepEqual(after.approver, before.approver, 'the approver identity survives beside them');
    // The kept config still loads and validates with every field in place.
    const kept = await loadStoredMasterConfig(root);
    assert.equal(kept.operatorLogin, 'vish'); assert.equal(kept.reviewRoundCap, 3); assert.equal(kept.upstream?.url, 'https://upstream.example');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});
