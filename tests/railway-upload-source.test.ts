import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterContext } from '../src/install/adapters.js';
import { applyInstall, buildPlan, prepareInstall } from '../src/install/index.js';
import { Vault } from '../src/install/secrets.js';
import { fakeTransport } from '../src/install/transport.js';
import { harness } from './install-harness.js';

// GY-1864: `railway up` runs from the private link directory, so a Graphyard source anywhere
// else must be uploaded with --path-as-root or the CLI fails with "prefix not found".
const LINK = '/home/operator/.config/graphyard/owner-project/railway';
const SOURCE = '/srv/graphyard-checkout';
const MANAGED = '/home/operator/code/huck';
// Imported when a test runs, so an exercise against the base fails these cases rather than the file.
const adapters = () => import('../src/install/adapters.js');

function context(overrides: Partial<AdapterContext>, responses: Parameters<typeof fakeTransport>[0] = {}) {
  const transport = fakeTransport(responses);
  const vault = new Vault();
  const ctx = { provider: 'railway', service: 'graphyard-owner-project', sourceRoot: SOURCE, railwayDir: LINK, managedRoot: MANAGED, vault, transport, ...overrides } as AdapterContext;
  return { ctx, transport, vault };
}

test('unit:railway-upload-path-as-root — a source that is not the cwd uploads with --path-as-root from the link directory; a source that is the cwd uploads as before', async () => {
  const { railwayAdapter } = await adapters();
  const away = context({});
  await railwayAdapter.deploy(away.ctx);
  assert.equal(away.transport.commands.length, 1);
  const [up] = away.transport.commands;
  assert.equal(up.program, 'railway');
  assert.equal(up.cwd, LINK, 'the upload left the private link directory');
  assert.deepEqual(up.args, ['up', SOURCE, '--service', 'graphyard-owner-project', '--ci', '--detach', '--path-as-root']);

  const here = context({ sourceRoot: LINK });
  await railwayAdapter.deploy(here.ctx);
  assert.deepEqual(here.transport.commands[0].args, ['up', LINK, '--service', 'graphyard-owner-project', '--ci', '--detach'], 'a cwd source changed its upload');
  assert.equal(here.transport.commands[0].cwd, LINK);
});

test('unit:railway-upload-receipts-and-source — a failed upload is a failed step with its exit code and message that stops the apply, a success records exit 0, and --observe-only never uploads the managed tree', async () => {
  const { railwayAdapter, railwayUploadReceipts } = await adapters();
  // A success records the native exit code and the CLI's message.
  const ok = context({}, { responses: [{ match: 'railway up', result: 'Indexed\nUploaded\nBuild Logs: https://railway.example/build' }] });
  const receipt = await railwayAdapter.deploy(ok.ctx).then(() => railwayUploadReceipts(ok.ctx));
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].ok, true);
  assert.equal(receipt[0].code, 0);
  assert.equal(receipt[0].step, 'provider.deploy');
  assert.match(receipt[0].command, /^railway up \/srv\/graphyard-checkout .*--path-as-root$/);
  assert.match(receipt[0].message, /Build Logs/);

  // A non-zero exit is a failed step carrying the exit code and the scrubbed CLI message.
  const secret = 'railway-token-5f2c9e1a';
  const failed = context({}, { responses: [{ match: 'railway up', result: { stdout: '', stderr: `error: prefix not found (token ${secret})`, code: 3 } }] });
  failed.vault.add(secret);
  await assert.rejects(railwayAdapter.deploy(failed.ctx), (error: any) => {
    assert.match(error.message, /^provider\.deploy failed: railway up exited with 3: error: prefix not found/);
    assert.ok(!error.message.includes(secret), 'the failure echoed a secret');
    assert.equal(error.receipt.code, 3);
    assert.equal(error.receipt.ok, false);
    return true;
  });
  assert.deepEqual(railwayUploadReceipts(failed.ctx).map(entry => [entry.code, entry.ok]), [[3, false]]);

  // Under --observe-only the managed repository's tree, or a directory containing it, is refused before anything runs.
  for (const sourceRoot of [MANAGED, '/home/operator/code']) {
    const managed = context({ observeOnly: true, sourceRoot });
    await assert.rejects(railwayAdapter.deploy(managed.ctx), /provider\.deploy refused: under --observe-only the upload source .* is the managed repository's tree/);
    assert.equal(managed.transport.commands.length, 0, 'the refused upload ran a command');
  }
  // The managed tree defaults to the process cwd, the checkout the runbook runs from.
  const cwd = context({ observeOnly: true, sourceRoot: process.cwd(), managedRoot: undefined });
  await assert.rejects(railwayAdapter.deploy(cwd.ctx), /refused/);
  assert.equal(cwd.transport.commands.length, 0);
  // The Graphyard source is uploaded as usual under --observe-only.
  const graphyard = context({ observeOnly: true });
  await railwayAdapter.deploy(graphyard.ctx);
  assert.equal(graphyard.transport.commands.length, 1);

  // Through a full apply, a failed upload stops it: nothing after the deploy step runs.
  const fixture = await harness({ provider: 'railway', extraResponses: [{ match: 'railway up', result: { stdout: '', stderr: 'prefix not found', code: 1 } }] });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'railway' }, { ...fixture.deps, sourceRoot: SOURCE });
    await assert.rejects(applyInstall(session, await buildPlan(session)), { message: 'provider.deploy failed: railway up exited with 1: prefix not found' });
    const railway = fixture.transport.commands.filter(command => command.program === 'railway');
    assert.equal(railway.at(-1)!.args[0], 'up', 'the apply continued past the failed upload');
    assert.ok(railway.at(-1)!.args.includes('--path-as-root'));
  } finally { await fixture.cleanup(); }
});
