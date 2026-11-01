import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { adoptConversation, assertConversationRuntime, captureConversation, conversationArgs, conversationEvents, conversationHandover, graphyardInput, masterInputs, masterRecords, type Conversation } from '../src/master/conversation.js';
import { emptyDaemonState, emptyMasterSession, readDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master/profiles.js';

test('unit:master-session-resumes — native forms name the current conversation; unsupported master runtimes refuse', () => {
  assert.deepEqual(conversationArgs('claude', 'current', true), ['--resume', 'current']);
  assert.deepEqual(conversationArgs('codex', 'current', true), ['resume', 'current']);
  for (const kind of ['claude', 'codex']) assert.doesNotThrow(() => assertConversationRuntime(kind));
  for (const kind of ['cursor', 'opencode', 'pi', 'custom']) assert.throws(() => assertConversationRuntime(kind), /unsupported.*previous conversation is retained/);
});

test('unit:master-session-resumes — native event metadata distinguishes person inputs, tools, partials, finals and recorded deliveries', async () => {
  const root = await temporaryDirectory('master-events');
  const launch = randomUUID(), origins = masterInputs(root, launch);
  const automated = await graphyardInput(origins, 'launch', 'Automated launch');
  const wake = await graphyardInput(origins, 'wake', 'Automated wake');
  const retry = await graphyardInput(origins, 'retry', 'Automated wake');
  const conversation: Conversation = { launch, runtime: 'claude', account: 'a', nativeId: 'native-a', transcript: join(root, 'source.jsonl'), record: join(masterRecords(root), 'a.jsonl'), origins, predecessor: null, supersededBy: null };
  const user = (id: string, text: unknown) => ({ type: 'user', uuid: id, message: { content: text } });
  const rows = [user('launch', automated), user('person-1', 'Keep my exact question?\nAnd this line.'),
    { type: 'assistant', message: { stop_reason: 'tool_use' } }, user('tool', [{ type: 'tool_result', content: 'Tool output' }]),
    { type: 'assistant', message: { stop_reason: null } }, user('wake', wake), user('retry', retry)];
  await writeFile(conversation.transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal(await captureConversation(conversation), 'Keep my exact question?\nAnd this line.');
  assert.match(await conversationHandover(conversation), /Last unanswered person message: "Keep my exact question\?\\nAnd this line\."/);
  const associations = (await readFile(origins, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.event);
  assert.deepEqual(associations.map(row => row.event), ['launch', 'wake', 'retry']);
  assert.equal(await readFile(conversation.record, 'utf8'), await readFile(conversation.transcript, 'utf8'), 'the record is the full native transcript');
  await appendFile(conversation.transcript, JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' } }) + '\n');
  assert.equal(await captureConversation(conversation), null);
  assert.match(await conversationHandover(conversation), /Last unanswered person message: none$/);
  // Quoting a previous launch is a new person input, rather than a second automatic delivery.
  await appendFile(conversation.transcript, JSON.stringify(user('quoted', `Why did you send this? ${automated}`)) + '\n');
  assert.equal(await captureConversation(conversation), `Why did you send this? ${automated}`);
  // A final belongs to its response branch, not a newer user input on another branch.
  await appendFile(conversation.transcript, JSON.stringify({ type: 'assistant', uuid: 'old-final', parentUuid: 'person-1', message: { stop_reason: 'end_turn' } }) + '\n');
  assert.equal(await captureConversation(conversation), `Why did you send this? ${automated}`);
  assert.deepEqual(conversationEvents('codex', [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Question' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'Tool output' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Partial' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ].map(row => JSON.stringify(row)).join('\n')).map(event => event.type), ['input', 'final']);
  const codex = { ...conversation, runtime: 'codex', transcript: join(root, 'codex.jsonl') };
  await writeFile(codex.transcript, [
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-b', item: { type: 'UserMessage', id: 'person-b', content: [{ type: 'text', text: 'New turn question' }] } } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } },
  ].map(row => JSON.stringify(row)).join('\n'));
  assert.equal(await captureConversation(codex), 'New turn question');
  await appendFile(codex.transcript, '\n' + [
    { type: 'event_msg', payload: { type: 'user_message', turn_id: 'turn-c', message: 'A newer question, subsequently answered' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-c' } },
  ].map(row => JSON.stringify(row)).join('\n'));
  assert.equal(await captureConversation(codex), 'New turn question', 'answering a newer turn does not erase an older interrupted input batch');
});

test('unit:master-session-resumes — current and superseded identities survive state replacement and daemon reload separately from allocations', async () => {
  const root = await temporaryDirectory('master-continuity-state');
  execFileSync('git', ['init', '-q', root]);
  const credentials = await temporaryDirectory('master-continuity-credentials');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/repo', baseBranch: 'main', hostId: 'host', masterAgentName: 'test-master', credentialFile: join(credentials, 'coordinator.token'), cliPath: '/bin/graphyard', githubAppId: 1, workers: [] });
  const source = (launch: string, runtime: string): Conversation => ({ launch, runtime, account: launch, nativeId: `native-${launch}`, transcript: join(root, `${launch}.jsonl`), record: join(masterRecords(root), `${launch}.jsonl`), origins: masterInputs(root, launch), predecessor: null, supersededBy: null });
  const a = source('a', 'claude'), b = { ...source('b', 'codex'), predecessor: 'a' };
  const continuity = { current: b, predecessor: { ...a, supersededBy: b.launch } };
  const state = emptyDaemonState(config);
  state.master = { ...emptyMasterSession(), continuity, session: 'registry-allocation-b' };
  await writeDaemonState(config, state);
  const loaded = await readDaemonState(root, config);
  assert.deepEqual(loaded.master.continuity, continuity);
  assert.equal(loaded.master.session, 'registry-allocation-b');
  assert.equal(loaded.master.continuity?.current.nativeId, 'native-b');
});

test('unit:master-session-resumes — an adopted pre-upgrade Claude record imports known prompt event origins', async () => {
  const root = await temporaryDirectory('master-adopt'), home = await temporaryDirectory('master-adopt-account');
  const folder = join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'legacy-native.jsonl'), [
    { type: 'user', uuid: 'launch', message: { content: 'Legacy launcher request' } },
    { type: 'user', uuid: 'person', message: { content: 'A person still needs an answer' } },
    { type: 'user', uuid: 'wake', message: { content: 'Legacy wake' } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const adopted = await adoptConversation(root, { runtime: 'claude', account: 'legacy', environment: { CLAUDE_CONFIG_DIR: home },
    prompts: [{ origin: 'launch', text: 'Legacy launcher request' }, { origin: 'wake', text: 'Legacy wake' }] });
  assert.equal(adopted.current.nativeId, 'legacy-native');
  assert.equal(await captureConversation(adopted.current), 'A person still needs an answer');
});
