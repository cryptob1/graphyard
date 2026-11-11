import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { appendFile, readFile, mkdir, writeFile, symlink, unlink } from 'node:fs/promises';
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
      type: 'bug', criteria: [{ id: 'AC-1', text: 'Specified work', proofs: ['e2e:fixture'] }], dependencies: [], evidence: [], gates: [], workspaces: [], blocker: 'Deployment incident', createdAt: new Date(now).toISOString() }] as unknown as Work[];
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


for (const initialized of [false, true]) test(`integration:master-large-transcript-wake — absent master launches once after actual native read failure (continuity ${initialized})`, async t => {
  const root = await temporaryDirectory('absent-unreadable-master'), home = await temporaryDirectory('absent-master-login');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/project', baseBranch: 'main',
    hostId: 'test', masterAgentName: 'master', credentialFile: join(root, 'coordinator.token'), cliPath: '/bin/graphyard', workers: [] });
  const folder = join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  const original = join(root, 'original.jsonl'), transcript = join(folder, 'old.jsonl');
  const bytes = JSON.stringify({ type: 'user', uuid: 'person', message: { content: 'Original operator goal' } }) + '\n';
  await writeFile(original, bytes);
  await symlink(original, transcript);
  const origins = masterInputs(root, 'master');
  await mkdir(join(root, '.graphyard/launch'), { recursive: true });
  await writeFile(origins, JSON.stringify({ origin: 'launch', event: 'launch' }) + '\n');
  const adopt = () => adoptConversation(root, { runtime: 'claude', account: 'old-account', environment: { CLAUDE_CONFIG_DIR: home }, origins, prompts: [] });
  let state = emptyDaemonState(config);
  state.master = { ...state.master, agentName: 'master', account: 'old-account', runtime: 'claude', session: 'old-session', startedAt: new Date().toISOString(), continuity: initialized ? await adopt() : null };
  const requestFile = join(root, '.graphyard/launch/master.request');
  await writeFile(requestFile, 'Original operator goal');
  await writeFile(config.credentialFile, 'fixture-only-token'.repeat(3), { mode: 0o600 });
  const registry = createServer((_request, response) => response.end(JSON.stringify({ accounts: [{ name: 'old-account', runtime: 'claude', credential: { home } }],
    runtimes: [{ name: 'claude', launch: { kind: 'claude', homeVariable: 'CLAUDE_CONFIG_DIR' } }] })));
  await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => registry.close(() => resolve())));
  config.url = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
  const initialize = masterSessionEffects(root, () => config).initialize!;
  const old = structuredClone(state.master), originBytes = await readFile(origins);
  const recordBytes = old.continuity ? await readFile(old.continuity.current.record) : null;
  // An injected directory at the native read path causes real EISDIR, even under root.
  // The complete original file and previous read-only record remain untouched.
  await unlink(transcript);
  await symlink(root, transcript);
  let launches = 0, present = false, ended = 0;
  let child: ReturnType<typeof spawn> | undefined;
  const work = [{ id: 'item', key: 'GY-1', title: 'Ship the operator goal', priority: 1, stage: 'build', ready: false, epoch: 0, revision: 1, policyRevision: 1,
    type: 'bug', criteria: [{ id: 'AC-1', text: 'Specified work', proofs: ['e2e:fixture'] }], dependencies: [], evidence: [], gates: [], workspaces: [], blocker: 'Delivery blocked on repair', candidate: { sha: 'candidate-head' },
    humanRequest: { kind: 'goals-and-priorities', needed: 'Finish the current release', answer: 'Go ahead' }, createdAt: new Date().toISOString() }] as unknown as Work[];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date().toISOString() }), agents: () => present ? [{ name: 'master', pane_id: 'replacement', agent_status: 'working' }] : [],
    credentials: async () => ({}), closeSession: () => assert.fail('do not close a healthy replacement'), dispatch: async () => assert.fail('no worker'), persist: async () => {},
    masterSession: { initialize, end: async session => { assert.equal(session, 'old-session'); ended++; }, launch: async (handoff, previous) => {
      launches++;
      await writeFile(requestFile, handoff);
      assert.equal(previous, null, 'unread history is not represented as recovered or resumed');
      assert.match(handoff, /NOT been recovered/);
      assert.match(handoff, /EISDIR/);
      assert.match(handoff, /Delivery blocked on repair/);
      assert.match(handoff, /candidate-head/);
      assert.match(handoff, /Finish the current release/);
      child = spawn(process.execPath, [fileURLToPath(new URL('fixtures/master-runtime.mjs', import.meta.url)), '--session-id', 'replacement', handoff], {
        cwd: root, env: { ...process.env, GY_RUNTIME: 'claude', CLAUDE_CONFIG_DIR: join(home, 'fresh'), GY_RESULT: join(root, 'replacement.json') },
      });
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
      assert.equal((await lines.next()).value, 'ready');
      present = true;
      // Select by the new launch input, as the real launcher does.
      const continuity = await adoptConversation(root, { runtime: 'claude', account: 'new-account', environment: { CLAUDE_CONFIG_DIR: join(home, 'fresh') },
        prompts: [{ origin: 'launch', text: handoff }] });
      return { agentName: 'master', pane: 'replacement', runtime: 'claude', account: 'new-account', session: 'new-session', continuity };
    } },
  };
  try {
    await runCycle(config, state, effects);
    assert.equal(launches, 1);
    assert.equal(ended, 1);
    assert.equal(state.actions['master:continuity'].state, 'failed');
    assert.match(state.actions['master:continuity'].detail, /EISDIR/);
    assert.equal(state.master.continuity?.current.nativeId, 'replacement');
    const archived = state.master.recoveryFailures[0].master;
    assert.deepEqual(archived, { ...(({ recoveryFailures, ...rest }) => rest)(old), launchRequestRecord: archived.launchRequestRecord });
    if (!initialized) {
      assert.ok(archived.launchRequestRecord);
      assert.equal(await readFile(archived.launchRequestRecord, 'utf8'), 'Original operator goal', 'replacement delivery cannot erase the original handoff');
    }
    assert.equal(await readFile(original, 'utf8'), bytes);
    assert.deepEqual(await readFile(origins), originBytes);
    if (old.continuity) assert.deepEqual(await readFile(old.continuity.current.record), recordBytes);
    state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state)));
    await runCycle(config, state, effects);
    assert.equal(launches, 1, 'restart adopts the replacement without a duplicate launch');
    assert.equal(state.master.recoveryFailures.length, 1);
    await unlink(transcript);
    await symlink(original, transcript);
    const recovered = !initialized ? await initialize({ ...state.master.recoveryFailures[0].master, recoveryFailures: [] })
      : await adoptConversation(root, { runtime: 'claude', account: 'old-account', environment: { CLAUDE_CONFIG_DIR: home }, origins,
        prompts: [{ origin: 'launch', text: 'Original operator goal' }] });
    assert.equal(recovered.current.nativeId, 'old', 'preserved native history can be recovered after repair without approval');
    assert.equal(await readFile(recovered.current.record, 'utf8'), bytes);
  } finally {
    if (child) { child.stdin!.end(); const [code] = await once(child, 'exit'); assert.equal(code, 0); }
  }
});
