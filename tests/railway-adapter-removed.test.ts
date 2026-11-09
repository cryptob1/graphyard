import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deliveryPolicySchema } from '../src/model-boundary/delivery-policy.js';
import { loadProjectDelivery } from '../src/model-boundary/project-applications.js';
import { detectDeploy, detectStack, proposeDelivery } from '../src/onboarding.js';
import { readInstallRecord } from '../src/install/secrets.js';
import { guideText } from '../src/guide.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3204: the schema-only Railway adapter is gone. Railway deploys each app from git on its own and
// Graphyard observes each app's versionUrl; what older files committed or stored still parses.

const oldDelivery = { mode: 'release-candidate', mergeGate: { preMerge: [], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'railway', project: 'huck', uat: null, production: null } };
const files = { 'package.json': JSON.stringify({ name: 'huck', scripts: { test: 'node --test' } }), 'railway.json': '{}', 'graphyard.json': JSON.stringify({ delivery: oldDelivery }) };
const scan = { files: Object.keys(files), contents: files as Record<string, string> };

test('unit:railway-adapter-removed — an old graphyard.json naming the railway adapter and a project parses as the command adapter', async () => {
  const policy = deliveryPolicySchema.parse(oldDelivery);
  assert.deepEqual(policy.deploy, { adapter: 'command', uat: null, production: null }, 'adapter railway reads as command and project is dropped');
  const stack = detectStack(scan);
  const proposed = proposeDelivery(scan, detectDeploy(scan, stack), stack);
  assert.equal(proposed.mode, 'release-candidate', 'the committed delivery is kept, not refused');
  assert.deepEqual(proposed.deploy, { adapter: 'command', uat: null, production: null });
  const root = await temporaryDirectory('railway-adapter-removed');
  await writeFile(join(root, 'graphyard.json'), files['graphyard.json']);
  assert.equal(loadProjectDelivery({}, root).mode, 'release-candidate', 'the control plane reads the old file without an error');
});

test('unit:railway-adapter-removed — an old install record holding the railway release adapter still parses, the value dropped', async () => {
  const directory = await temporaryDirectory('railway-adapter-record');
  await writeFile(join(directory, 'install.json'), JSON.stringify({ version: 1, installId: 'huck', repository: 'acme/huck', provider: 'local', baseBranch: 'main',
    release: { adapter: 'railway', created: ['railway-project'] }, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }));
  const record = await readInstallRecord(directory);
  assert.equal(record?.repository, 'acme/huck');
  assert.equal(record?.release, undefined);
});

test('unit:railway-adapter-removed — onboarding, the example proposal and the guide say Railway deploys from git while Graphyard observes each versionUrl', async () => {
  const stack = detectStack(scan), deploy = detectDeploy(scan, stack);
  assert.equal(deploy.target, 'railway', 'onboarding still detects Railway');
  assert.match(deploy.verification, /^Railway deploys each application from git on its own; Graphyard deploys nothing there\. Declare each app's versionUrl/);
  const example = JSON.parse(await readFile(new URL('../examples/setup-proposal.json', import.meta.url), 'utf8'));
  assert.equal(example.deploy.verification, deploy.verification);
  assert.match(guideText('master'), /Railway deploys each application from git on its own; Graphyard deploys nothing there and uses no Railway credential for it\. It observes each app's versionUrl/);
});
