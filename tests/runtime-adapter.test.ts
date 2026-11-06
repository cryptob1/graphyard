import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { assertLaunchable, launchPlan, runtimeEndedStates } from '../src/harness.js';
import { launchCommand, launchDelivery, launchProgram, writeLaunchFiles } from '../src/master/launch.js';
import { detectRuntimeExhaustion } from '../src/master/runtime-prompt.js';
import { registerRuntimeAdapter, runtimeAdapter } from '../src/master/runtimes.js';
import { freshLaunch, resumePlan } from '../src/master/session-resume.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3034 AC-1: everything Graphyard knows of a runtime lives in its one adapter record, so a new
// runtime is added by registering its adapter: nothing else is edited for it to launch, resume,
// deliver its first request on its command line and report its provider's limit notice.
test('unit:runtime-adapter — a registered adapter is launchable, resumable and reports usage limits with no other file changed', async () => {
  assert.throws(() => assertLaunchable('nimbus'), /no non-interactive launch contract for nimbus/, 'an unknown kind is refused before its adapter exists');
  registerRuntimeAdapter({
    kind: 'nimbus',
    recipe: { program: 'nimbus-cli', args: ['--approve', 'all'], environment: { NIMBUS_TRUST: '1' }, prompts: 'approval prompts', tradeoff: 'Nimbus runs every tool without asking.' },
    request: reference => `--ask ${reference}`,
    resume: { fresh: id => ['--name', id], resume: id => ['--continue', id] },
    limitNotices: [/\bnimbus credits spent\b/i],
    endedStates: ['finished'],
  });
  assert.equal(runtimeAdapter('nimbus')?.kind, 'nimbus');

  assert.doesNotThrow(() => assertLaunchable('nimbus'), 'the registered kind launches with no registry contract of its own');
  const plan = launchPlan('nimbus');
  assert.equal(plan.refusal, null);
  assert.equal(plan.applied, true);
  assert.deepEqual(plan.args, ['--approve', 'all'], 'the adapter recipe supplies the no-approval flags');
  assert.deepEqual(plan.environment, { NIMBUS_TRUST: '1' });
  assert.match(launchPlan('nimbus', 'auto', ['--approve', 'some']).refusal ?? '', /--approve some/, 'a contrary flag is refused as for a built-in runtime');

  assert.equal(launchDelivery('nimbus'), 'request', 'the first request goes on the command line, never pasted');
  assert.equal(launchProgram('nimbus'), 'nimbus-cli');
  const directory = await temporaryDirectory('runtime-adapter');
  try {
    const files = writeLaunchFiles(directory, 'session', { request: 'Implement GY-1' });
    const command = launchCommand('nimbus', plan.args, files);
    assert.match(command, /nimbus-cli --approve all --ask "\$\(cat "\$GY\.request"\)"$/, 'the command line runs the adapter program with its request contract');
  } finally { await rm(directory, { recursive: true, force: true }); }

  const fresh = freshLaunch('nimbus', null);
  assert.deepEqual(fresh.args, ['--name', fresh.session]);
  const resumed = resumePlan({ epoch: 1, runtime: 'nimbus', account: 'nimbus-a', session: 'abc' }, { kind: 'nimbus', account: 'nimbus-a' });
  assert.deepEqual(resumed, { resume: true, from: 1, session: 'abc', args: ['--continue', 'abc'] });

  assert.ok(detectRuntimeExhaustion('Error: Nimbus credits spent', 'nimbus', Date.now()), 'the adapter limit notice reports the account spent');
  assert.equal(detectRuntimeExhaustion('Error: Nimbus credits spent', 'codex', Date.now()), null, 'another runtime does not read it');
  assert.ok(runtimeEndedStates('nimbus').includes('finished'));
});
