import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAgentEnvironments, setupMaster } from '../src/master.js';
import { saveReviewerProfile } from '../src/reviewer.js';
import { registryCommand } from '../src/cli/master-registry.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes, type AgentRegistry } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3242: after `master registry account remove a`, `master environments --apply` takes a out of
// every launch profile, deletes a profile left with no account and reports both changes.
test('e2e:environments-drop-removed-account — environments --apply drops a removed registry account from every profile', async () => {
  const root = await temporaryDirectory('drop-account'), credentials = await temporaryDirectory('drop-account-credentials'), environments = await temporaryDirectory('drop-account-envs');
  const previous = process.env.GRAPHYARD_AGENT_ENVIRONMENTS; process.env.GRAPHYARD_AGENT_ENVIRONMENTS = environments;
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const status = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials, herdrWorkspace: 'workspace-graphyard' }, status as typeof fetch);
    await saveReviewerProfile(root, { name: 'review-pair', agentName: 'review-pair', kind: 'claude', accounts: ['a', 'b'] });
    await saveReviewerProfile(root, { name: 'review-solo', agentName: 'review-solo', kind: 'claude', accounts: ['a'] });

    // The control plane's registry, in memory, behind the same API the CLI writes to.
    const context = () => ({ actor: 'master', at: new Date().toISOString() });
    let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', {
      runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'default', id: null }],
      accounts: ['a', 'b'].map(name => ({ name, runtime: 'claude', model: 'default', credential: { host: 'host-1', home: null } })), roles: [], reason: 'fixture',
    }, context()).registry;
    const api = {
      read: async (path: string) => { assert.equal(path, 'agent-registry/document'); return structuredClone(registry); },
      write: async (path: string, data: any) => {
        const name = /^agent-registry\/accounts\/([^/]+)\/remove$/.exec(path)![1];
        registry = applyRegistryMutation(registry, 'account.remove', { name: decodeURIComponent(name), reason: data.reason }, context()).registry; return { revision: registry.revision };
      },
    };
    await registryCommand({ hostId: 'host-1' }, ['account', 'remove', 'a', '--reason', 'retired'], api);

    const applied = await setupAgentEnvironments(root, { apply: true, verify: async () => ({}), registry: () => api.read('agent-registry/document') });
    const config = JSON.parse(await readFile(join(root, '.graphyard/master.json'), 'utf8'));
    assert.deepEqual(config.reviewers.map((profile: any) => [profile.name, profile.accounts]), [['review-pair', ['b']]], 'the first profile names only b; the second is gone');
    assert.deepEqual(applied.profiles.map(change => [change.profile, change.action, change.accounts, change.dropped]),
      [['review-pair', 'accounts', ['b'], ['a']], ['review-solo', 'removed', [], ['a']]], 'the apply output lists both changes');
  } finally {
    if (previous === undefined) delete process.env.GRAPHYARD_AGENT_ENVIRONMENTS; else process.env.GRAPHYARD_AGENT_ENVIRONMENTS = previous;
    for (const directory of [root, credentials, environments]) await rm(directory, { recursive: true, force: true });
  }
});
