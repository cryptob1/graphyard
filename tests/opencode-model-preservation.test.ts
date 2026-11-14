import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registryCommand } from '../src/cli/master-registry.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes, repinRuntime, type AgentRegistry } from '../src/model/registry.js';
import { accountLaunch, registryLaunchArgs } from '../src/master/environments.js';
import { registryHeadlessLaunch } from '../src/runner/roles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-3301: an account's explicitly selected model survives every writer that touches the fleet
 * after it, and launches receive the model's concrete id.
 *
 * The OpenCode reset this item investigates was intentional, not a product overwrite: on
 * 2026-11-05T05:28Z the master session (claude-b, transcript .graphyard/master-records/
 * 3d55ec1a-8c30-4221-9683-894b682ef3e7.jsonl) pinned the model at the runtime level
 * (OPENCODE_CONFIG_CONTENT) and reset opencode-a/b/c to opencode-default with a recorded reason,
 * as the workaround for opencode's TUI rejecting `--model` until GY-3118 landed. The registry
 * history's 500-event window no longer reaches that day (it stops at Nov 11), so the transcript is
 * the attributable record. This test covers what remained broken in the writer chain once the
 * accounts were restored: a typed `account set` after an operator's quota mark was refused
 * (`quotaDecision` is not a field a write names), so the explicit model change the owner asked for
 * could not even be written.
 */

const HOST = 'agent-host-1';
const glmId = 'zai-coding-plan/glm-5.3';
const scratch = await temporaryDirectory('opencode-model-preservation');
after(() => rm(scratch, { recursive: true, force: true }));

// One OpenCode login on this host, as discovery finds it: an isolated environment with its login file.
const directory = join(scratch, '.coding_agents');
await mkdir(join(directory, 'opencode-a', 'opencode'), { recursive: true });
await writeFile(join(directory, 'opencode-a', 'opencode', 'auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: 'zai-fixture-key-not-a-credential' } }), { mode: 0o600 });
const home = join(scratch, 'home');
await mkdir(home, { recursive: true });

let registry: AgentRegistry = emptyRegistry();
const written: { path: string; data: unknown }[] = [];
const api = {
  read: async (path: string) => { assert.equal(path, 'agent-registry/document'); return registry; },
  write: async (path: string, data: any) => {
    written.push({ path, data });
    const { reason, ...rest } = data;
    const quota = /^agent-registry\/accounts\/([^/]+)\/quota$/.exec(path);
    const kind = path === 'agent-registry/apply' ? 'apply'
      : quota ? 'account.quota'
      : path === 'agent-registry/accounts' ? 'account.set'
      : path === 'agent-registry/models' ? 'model.set'
      : path === 'agent-registry/roles' ? 'role.set'
      : path === 'agent-registry/runtimes' ? 'runtime.set' : null;
    if (!kind) throw new Error(`the fixture refuses ${path}`);
    registry = applyRegistryMutation(registry, kind, quota ? { name: decodeURIComponent(quota[1]), ...rest, reason } : { ...rest, reason }, { actor: 'operator', at: new Date().toISOString() }).registry;
    return { revision: registry.revision, registry };
  },
};
const registryArgs = (...args: string[]) => registryCommand({ hostId: HOST }, args, api, { home, executables: () => false, install: () => null });

/** The account as a launch receives it from the registry: its runtime contract and its model's id. */
const launchAccount = () => {
  const entry = registry.accounts.find(account => account.name === 'opencode-a')!;
  const runtime = registry.runtimes.find(candidate => candidate.name === entry.runtime)!;
  const model = registry.models.find(candidate => candidate.name === entry.model)!;
  return { name: entry.name, kind: runtime.launch.kind, home: entry.credential.home,
    fleet: { runtime: runtime.name, contract: runtime.launch, model: model.name, modelId: model.id, session: 's-1', reason: 'chosen' } } as never;
};
/** The model id an interactive OpenCode launch runs on: OPENCODE_CONFIG_CONTENT's `model`, or null when none reaches it. */
const interactiveModel = () => {
  const { environment } = accountLaunch({ approvals: 'auto', agentArgs: [], environment: {} }, launchAccount());
  return environment.OPENCODE_CONFIG_CONTENT ? (JSON.parse(environment.OPENCODE_CONFIG_CONTENT) as { model?: string }).model ?? null : null;
};
const selectedModel = () => registry.accounts.find(account => account.name === 'opencode-a')!.model;

test('e2e:opencode-model-preservation — an explicit glm-5.3 account selection survives fleet refresh, canary repin and unrelated partial updates, keeps feeding launches its concrete id, and an explicit model change still works', async t => {
  const savedDataHome = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME; // discovery sees only the fixture's logins, never this host's own
  t.after(() => { if (savedDataHome !== undefined) process.env.XDG_DATA_HOME = savedDataHome; });

  // The fleet as production held it: an OpenCode account on the id-less default, and glm-5.3 named.
  registry = applyRegistryMutation(registry, 'apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'opencode')!],
    models: [
      { name: 'opencode-default', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'fast', contextTokens: null } },
      { name: 'glm-5.3', id: glmId, cost: { inputPerMTok: 1.4, outputPerMTok: 4.4 }, capability: { tier: 'strong', contextTokens: null } },
    ],
    accounts: [{ name: 'opencode-a', runtime: 'opencode', model: 'opencode-default', credential: { host: HOST, home: join(directory, 'opencode-a') }, enabled: true, maxSessions: null }],
    roles: [{ name: 'worker', accounts: ['opencode-a'], concurrency: 4 }],
    reason: 'fixture',
  }, { actor: 'operator', at: '2026-11-01T00:00:00.000Z' }).registry;
  assert.equal(selectedModel(), 'opencode-default');
  assert.equal(interactiveModel(), null, 'an id-less model selection reaches no launch: OpenCode runs its own default, the free model');

  // The implicated writer, as the restore used it: a typed account set naming the model.
  await registryArgs('account', 'set', 'opencode-a', '--runtime', 'opencode', '--model', 'glm-5.3', '--reason', 'the operator pays for the Z.AI coding plan');
  assert.equal(selectedModel(), 'glm-5.3');
  assert.equal(interactiveModel(), glmId, 'an interactive launch receives the model entry\'s concrete id');
  assert.ok(!registryLaunchArgs(launchAccount()).includes('--model'), 'OpenCode never sees --model: the TUI refuses it (GY-3118)');
  assert.equal(registryHeadlessLaunch(launchAccount()).model, glmId, 'a headless run receives the same concrete id');

  // Fleet refresh, which is also the install/upgrade accounts step (`graphyard up` runs this
  // writer): discovery proposes only logins the registry does not hold, so nothing is rewritten.
  const writesBefore = written.length;
  const refresh = await registryArgs('propose', '--directory', directory, '--apply', '--reason', 'fleet refresh') as { applied: boolean; next: string };
  assert.equal(refresh.applied, false);
  assert.equal(written.length, writesBefore, 'the registry already holds every login found: the refresh writes nothing');
  assert.match(refresh.next, /already holds every login/);
  assert.equal(selectedModel(), 'glm-5.3'); assert.equal(interactiveModel(), glmId);

  // A runtime canary that passes switches the runtime by runtime.set with a repinned PATH (GY-3103).
  const pinned = registry.runtimes.find(runtime => runtime.name === 'opencode')!;
  await api.write('agent-registry/runtimes', { runtime: repinRuntime(pinned, '/opt/installs/opencode/2.3.0/node_modules/.bin'), reason: 'Canary GY-1 epoch 1 on opencode 2.3.0 ran 90 s' });
  assert.equal(selectedModel(), 'glm-5.3'); assert.equal(interactiveModel(), glmId);

  // Unrelated partial updates: none names the model, so none may change it.
  await registryArgs('account', 'set', 'opencode-a', '--max-sessions', '2', '--note', 'shared login', '--reason', 'session limit only');
  assert.equal(selectedModel(), 'glm-5.3'); assert.equal(interactiveModel(), glmId);
  await registryArgs('model', 'set', 'glm-5.3', '--input-cost', '1.5', '--reason', 'price read');
  assert.equal(registry.models.find(model => model.name === 'glm-5.3')!.id, glmId, 'an unrelated model edit keeps the concrete id');
  await registryArgs('role', 'set', 'worker', 'opencode-a', '--concurrency', '4', '--reason', 'role touch');
  assert.equal(selectedModel(), 'glm-5.3'); assert.equal(interactiveModel(), glmId);
  await registryArgs('account', 'quota', 'opencode-a', 'available', '--reason', 'quota mark');
  assert.equal(selectedModel(), 'glm-5.3'); assert.equal(interactiveModel(), glmId);

  // An explicit model change still works — the November 13 restore's own writer, on an account a
  // quota mark has touched: the registry echoes quotaDecision back through a typed account set,
  // which the write boundary refused (GY-3301).
  await registryArgs('account', 'set', 'opencode-a', '--model', 'opencode-default', '--reason', 'explicit change back to the account\'s own default');
  assert.equal(selectedModel(), 'opencode-default');
  assert.equal(interactiveModel(), null, 'an explicit change to an id-less model is honoured: no model reaches the launch');
  await registryArgs('account', 'set', 'opencode-a', '--model', 'glm-5.3', '--reason', 'restore');
  assert.equal(selectedModel(), 'glm-5.3'); assert.equal(interactiveModel(), glmId);
});
