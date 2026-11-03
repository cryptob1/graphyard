import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { largeTranscript } from './helpers/large-transcript.js';
import { adoptConversation, captureConversation, masterInputs } from '../src/master/conversation.js';
import { masterSessionEffects } from '../src/master/master-session.js';
import { emptyDaemonState, daemonStateSchema } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import type { Work } from '../src/model.js';

// This exercises an already-live process. No new master is launched by the loop,
// and the production launch/confinement path remains covered by its existing suite.
test('e2e:master-large-transcript-wake — live native process receives incidents during recovery failure, then recovers its >2 GiB record', async () => {
  const root = await temporaryDirectory('large-live-master'), home = await temporaryDirectory('large-live-login');
  const child = spawn(process.execPath, [fileURLToPath(new URL('fixtures/master-runtime.mjs', import.meta.url)), '--session-id', 'native', 'Original launch'], {
    cwd: root, env: { ...process.env, GY_RUNTIME: 'claude', CLAUDE_CONFIG_DIR: home, GY_RESULT: join(root, 'result.json') },
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = async (command: object) => { child.stdin.write(JSON.stringify(command) + '\n'); assert.equal((await lines.next()).value, 'recorded'); };
  try {
    assert.equal((await lines.next()).value, 'ready');
    const { transcript } = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
    const user = (uuid: string, content: string) => ({ type: 'user', uuid, message: { content } });
    await largeTranscript(transcript, [user('launch', 'Original launch')], [user('person', 'Keep this exact pending question')]);
    await appendFile(transcript, '\n');
    await assert.rejects(readFile(transcript), { code: 'ERR_FS_FILE_TOO_LARGE' });
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/project', baseBranch: 'main',
      hostId: 'test', masterAgentName: 'master', credentialFile: join(root, 'coordinator.token'), cliPath: '/bin/graphyard', workers: [] });
    let now = Date.now(), broken = true, deliveries = 0, retries = 0;
    let state = emptyDaemonState(config);
    const work = [{ id: 'item', key: 'GY-1', title: 'Repair incident', stage: 'build', ready: false, epoch: 0, revision: 1, policyRevision: 1,
      type: 'bug', criteria: [], dependencies: [], evidence: [], gates: [], workspaces: [], blocker: 'Deployment incident', createdAt: new Date(now).toISOString() }] as unknown as Work[];
    const native = masterSessionEffects(root, () => config, async (_command, args) => {
      if (args[0] === 'agent' && args[1] === 'prompt') { deliveries++; await send({ input: args[3], partial: true }); return JSON.stringify({ result: {} }); }
      throw new Error(`Unexpected Herdr call: ${args.join(' ')}`);
    });
    const effects: DaemonEffects = {
      snapshot: async () => ({ work, now: new Date(now).toISOString() }), agents: () => [{ name: 'master', pane_id: 'live', agent_status: 'working' }],
      credentials: async () => ({}), closeSession: () => assert.fail('keep the live master'), dispatch: async () => assert.fail('no worker'), persist: async () => {},
      masterSession: { wake: native.wake, launch: async () => assert.fail('retain the live conversation'), initialize: async () => {
        retries++;
        return adoptConversation(root, { runtime: 'claude', account: 'account', environment: { CLAUDE_CONFIG_DIR: broken ? join(home, 'unavailable') : home },
          origins: masterInputs(root, config.masterAgentName), prompts: [{ origin: 'launch', text: 'Original launch' }] });
      } },
    };
    await runCycle(config, state, effects, () => now);
    assert.equal(deliveries, 1);
    assert.match(state.actions['master:continuity'].detail, /Cannot recover/);
    state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state)));
    await runCycle(config, state, effects, () => now);
    assert.equal(deliveries, 1, 'restart does not repeat the incident or error prompt');
    now += 31 * 60_000;
    await runCycle(config, state, effects, () => now);
    assert.equal(deliveries, 2);
    assert.equal(state.master.lastWake?.heartbeat, true);
    broken = false;
    await runCycle(config, state, effects, () => now);
    assert.equal(retries, 4);
    assert.equal(state.actions['master:continuity'].state, 'done');
    assert.equal(state.master.continuity?.current.nativeId, 'native');
    assert.equal(await captureConversation(state.master.continuity!.current), 'Keep this exact pending question', 'all fallback wakes retain automated origin identity after recovery');
    assert.equal(deliveries, 2);
  } finally {
    child.stdin.end();
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  }
});
