import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import { harness } from './install-harness.js';

// GY-3219: an organization that disables deploy keys is refused by the plan (and so by `up` preflight and apply) before provisioning.

const org = (body: string) => [{ match: 'gh api orgs/owner', result: body }];

async function plan(extraResponses: ReturnType<typeof org>) {
  const fixture = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310', extraResponses });
  try {
    const { request } = installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--plan']);
    return (await buildPlan(await prepareInstall(fixture.root, request, fixture.deps, 'plan'))).preflight.find(item => item.name === 'Organization deploy keys');
  } finally { await fixture.cleanup(); }
}

test('unit:up-deploy-keys-disabled — false refuses naming the setting and fix; true, absent or unreadable proceed', async () => {
  const refused = await plan(org('{"deploy_keys_enabled_for_repositories":false}'));
  assert.equal(refused?.ok, false);
  assert.match(`${refused?.detail} ${refused?.fix}`, /deploy_keys_enabled_for_repositories[\s\S]*Member privileges/);
  assert.equal(await plan(org('{"deploy_keys_enabled_for_repositories":true}')), undefined);
  assert.equal(await plan(org('{"login":"owner"}')), undefined);
  assert.equal(await plan(org('not json')), undefined);
  assert.equal(await plan(org({ stdout: '', stderr: 'HTTP 404', code: 1 } as any)), undefined);
});
