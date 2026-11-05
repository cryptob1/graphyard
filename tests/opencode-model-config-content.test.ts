import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLaunch } from '../src/master/environments.js';
import { headlessArgs } from '../src/headless-session.js';
import { proposedRuntimes } from '../src/model/registry-proposal.js';

// GY-3118: opencode 2.2.5's interactive TUI exits on --model, so a registry model id reaches
// OpenCode through OPENCODE_CONFIG_CONTENT on every launch, interactive and `run` alike.
const account = (modelFlag: string | null, environment: Record<string, string> = {}) => ({ name: 'opencode-a', kind: 'opencode', home: '/accounts/opencode-a',
  fleet: { runtime: 'opencode', model: 'glm', modelId: 'zai-coding-plan/glm-5.3', session: 's-1', reason: 'chosen',
    contract: { kind: 'opencode', args: [], environment, homeVariable: 'XDG_DATA_HOME', modelFlag, login: null, loginFile: null } } });

test('unit:opencode-model-via-config-content — an opencode registry model rides in OPENCODE_CONFIG_CONTENT, never --model', () => {
  assert.equal(proposedRuntimes.find(runtime => runtime.name === 'opencode')!.launch.modelFlag, null, 'the default runtime names no model flag');
  // A runtime stored before the fix still names --model; it is not passed either.
  for (const flag of [null, '--model']) {
    const launch = accountLaunch({ approvals: 'auto', agentArgs: [], environment: {} }, account(flag) as never);
    assert.ok(!launch.args.includes('--model'), `interactive args carry no --model (stored flag ${flag})`);
    assert.ok(!headlessArgs('opencode', launch.args, 'go').includes('--model'), 'headless run args carry no --model');
    assert.deepEqual(JSON.parse(launch.environment.OPENCODE_CONFIG_CONTENT!), { model: 'zai-coding-plan/glm-5.3' });
  }
  // A runtime's own config content is kept, with the account's model merged in.
  const merged = accountLaunch({ approvals: 'auto', agentArgs: [], environment: {} }, account(null, { OPENCODE_CONFIG_CONTENT: '{"model":"old","theme":"dark"}' }) as never);
  assert.deepEqual(JSON.parse(merged.environment.OPENCODE_CONFIG_CONTENT!), { model: 'zai-coding-plan/glm-5.3', theme: 'dark' });
});
