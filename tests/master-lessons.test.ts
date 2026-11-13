import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { ChildRun } from '../src/child-runner.js';
import { emptyRegistry, proposedRuntimes, unobservedQuota, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import type { FleetClient } from '../src/fleet.js';
import { launchMasterSession } from '../src/master/master-session.js';
import { masterConfinementVariable } from '../src/master/confinement.js';
import { lessonCommand } from '../src/master/lessons.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { emptyProjectMemory, masterLessons, recordNoteInMemory, reconcileMasterMemory } from '../src/model/project-memory.js';
import { readProjectMemory, recordedMasterMemory } from '../src/project-memory.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3274: the master keeps durable lessons in project memory. `master lesson add` stores one the
// next master launch prompt contains; a lesson added `--for workers` appears in a worker's prompt
// and one without it does not; the 41st lesson drops the oldest; remove deletes by id; a worker
// identity is refused. The launch fixture runs the real launchMasterSession against the executable
// credential-free runtime fixture (tests/fixtures/master-runtime.mjs) through a stub Herdr.

/** A lesson command's deps: the control plane's word on a credential, and a movable clock. */
const lessonDeps = (actors: Record<string, { id: string; role: string }>, clock = { at: 0 }) => ({
  status: async (credential: string) => ({ actor: actors[credential] ?? { id: 'graphyard-master', role: 'coordinator' } }),
  now: () => clock.at,
});

test('e2e:master-lessons — lesson add stores a lesson the next master launch prompt contains; a --for workers lesson reaches worker prompts and a plain one does not', { timeout: 180_000 }, async () => {
  const scratch = await temporaryDirectory('master-lessons');
  const root = await realpath(await temporaryDirectory('checkout', scratch)), homes = await temporaryDirectory('accounts', scratch);
  const credentials = await temporaryDirectory('coordinator', scratch);
  // A settings file directly above the checkout keeps the fixture clear of any host's Claude settings.
  await mkdir(join(scratch, '.claude'), { recursive: true });
  await writeFile(join(scratch, '.claude', 'settings.json'), '{}');
  execFileSync('git', ['init', '-q', root]);
  const binary = join(root, 'bin');
  await mkdir(binary, { recursive: true });
  const runtime = fileURLToPath(new URL('fixtures/master-runtime.mjs', import.meta.url));
  await writeFile(join(binary, 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${runtime}' "$@"\n`, { mode: 0o700 });
  // This fixture's Herdr builds no namespace: its bwrap is a pass-through stub that runs the
  // command after the wrapper's `--`, so the launch runs on hosts that cannot nest namespaces too.
  await writeFile(join(binary, 'bwrap'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--" ]; then shift; exec "$@"; fi; shift; done\necho "fixture bwrap stub: no -- separator" >&2\nexit 1\n', { mode: 0o700 });
  const home = await temporaryDirectory('claude-a', homes);
  const account = { name: 'claude-a', runtime: 'claude', model: 'test', credential: { host: 'test-host', home }, enabled: true, maxSessions: null, quota: { ...unobservedQuota } };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/lessons', baseBranch: 'main', hostId: 'test-host', credentialFile: join(credentials, 'coordinator.token'), cliPath: '/bin/graphyard', githubAppId: 1, workers: [], masterAgentName: 'lessons-master', run: { launchStartSeconds: 10 } });
  const registry: AgentRegistry = { ...emptyRegistry(), accounts: [account],
    runtimes: proposedRuntimes.filter(entry => entry.name === 'claude').map(entry => ({ ...entry, launch: { ...entry.launch, args: [...entry.launch.args, '--setting-sources', 'user'], environment: { PATH: `${binary}:${process.env.PATH}`, GY_RUNTIME: entry.name } } })),
    models: [{ name: 'test', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } }],
    roles: [{ name: 'master', accounts: ['claude-a'], concurrency: 1 }] };
  let allocation = 0;
  const client: FleetClient = { document: async () => registry, end: async () => {}, select: async () => {
    const fleetRuntime = registry.runtimes.find(entry => entry.name === account.runtime)!;
    const session: FleetSession = { id: `allocation-${++allocation}`, role: 'master', account: account.name, runtime: fleetRuntime.name, model: 'test', host: 'test-host', work: null, principal: 'master', selectedAt: new Date().toISOString(), selectedBy: 'master', reason: 'fixture account', skipped: [], endedAt: null, endReason: null };
    return { selected: true, reason: 'fixture account', skipped: [], session, account, runtime: fleetRuntime, model: registry.models[0], revision: 1 };
  } };
  const panes = new Map<string, { env: NodeJS.ProcessEnv; child?: ChildProcess }>();
  const resultFile = (pane: string) => join(root, '.graphyard', `${pane}.result.json`);
  let paneId = 0;
  const stop = async () => { for (const pane of panes.values()) { const child = pane.child; if (child && child.exitCode === null) { child.stdin?.end(); await once(child, 'exit').catch(() => {}); } } };
  const run: ChildRun = async (_command, args) => {
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'tab' && args[1] === 'create') {
      const pane = `pane-${++paneId}`;
      const env: NodeJS.ProcessEnv = { ...process.env, GY_RESULT: resultFile(pane) };
      for (let index = 0; index < args.length; index++) if (args[index] === '--env') { const value = args[++index], at = value.indexOf('='); env[value.slice(0, at)] = value.slice(at + 1); }
      panes.set(pane, { env });
      return json({ pane_id: pane, tab_id: `tab-${paneId}` });
    }
    if (args[0] === 'pane' && args[1] === 'run') {
      // A pane shell would evaluate the launch command; so does this one, running the fixture runtime.
      const pane = panes.get(args[2])!;
      pane.child = spawn('/bin/sh', ['-c', args[3]], { cwd: root, env: pane.env });
      pane.child.stderr!.on('data', () => {});
      return json({});
    }
    if (args[0] === 'agent' && args[1] === 'get') {
      const pane = panes.get(args[2])!;
      return json({ agent: { agent: 'claude', agent_status: pane.child?.exitCode === null ? 'working' : 'exited' } });
    }
    if (args[0] === 'agent' && args[1] === 'rename') return json({});
    if (args[0] === 'pane' && args[1] === 'read') return json({ text: 'Claude Code fixture runtime ready' });
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    if (args[0] === 'pane' && args[1] === 'close') { const child = panes.get(args[2])?.child; if (child?.exitCode === null) { child.stdin?.end(); await once(child, 'exit').catch(() => {}); } return json({}); }
    throw new Error(`Unexpected fixture Herdr command ${args.join(' ')}`);
  };

  const clock = { at: Date.parse('2026-11-12T08:00:00Z') };
  const deps = lessonDeps({}, clock);
  const plain = 'The trial host answers slowly on Mondays; extend its timeout before re-running';
  const shared = 'Check the gate record before filing a batch item';
  await lessonCommand(root, 'lessons-master', ['add', plain], deps);
  clock.at += 60_000;
  const recorded = await lessonCommand(root, 'lessons-master', ['add', shared, '--for', 'workers'], deps) as { recorded: { id: string } };
  assert.ok(recorded.recorded.id, 'add reports the stored lesson');

  // The stored file holds both lessons, newest first.
  const memory = await readProjectMemory(root);
  assert.deepEqual(masterLessons(memory).map(lesson => lesson.text), [shared, plain]);

  // The next master launch prompt contains them, after the role text and before the handover.
  // The fixture process stands inside its own boundary already (its Herdr never builds one), so the
  // launcher needs no fresh namespace probe here — the same marker a real master session carries.
  const confinement = masterConfinementVariable, hadConfinement = process.env[confinement];
  process.env[confinement] = 'master';
  try {
    const launched = await launchMasterSession(root, config, { agents: [], available: true }, 'Handover: continue from master status.', run,
      { registry: client, quota: false, smoke: async () => ({ ok: true, error: null }) });
    const result = JSON.parse(await readFile(resultFile(launched.pane), 'utf8'));
    const request: string = result.request;
    assert.match(request, /Master lessons, your own recorded experience, newest first:/);
    assert.ok(request.includes(shared), 'the launch prompt carries the shared lesson');
    assert.ok(request.includes(plain), 'the launch prompt carries the master-only lesson');
    assert.ok(request.indexOf('Master lessons') < request.indexOf('Handover: continue from master status.'), 'the lessons come before the task handover');
    assert.ok(request.indexOf('dedicated Graphyard master agent') < request.indexOf('Master lessons'), 'the lessons come after the role text that names AGENTS.md');
    assert.equal(result.id, launched.continuity!.current.nativeId, 'the launch really ran the fixture runtime');
  } finally {
    if (hadConfinement === undefined) delete process.env[confinement]; else process.env[confinement] = hadConfinement;
    await stop();
  }

  // A worker's prompt carries only the lesson marked for it, under the project-memory digest.
  const worker = workerPrompt({ cliPath: '/bin/graphyard' }, { key: 'GY-9', title: 'Any item' }, { principal: 'graphyard-worker-1' }, 1, null, memory);
  assert.ok(worker.includes('Master lessons for workers:'), 'the digest names the workers\' section');
  assert.ok(worker.includes(shared), 'the for-workers lesson reaches the worker');
  assert.ok(!worker.includes(plain), 'a plain master lesson never reaches the worker');
});

test('e2e:master-lessons — the 41st lesson drops the oldest, remove deletes by id, the loop adopts file lessons, and a worker identity is refused', async () => {
  const root = await temporaryDirectory('master-lessons-retention');
  const clock = { at: Date.parse('2026-11-12T08:00:00Z') };
  const deps = lessonDeps({}, clock);
  for (let index = 0; index < 41; index++) {
    clock.at += 1_000;
    await lessonCommand(root, 'lessons-master', ['add', `Lesson number ${index} of the retention run`], deps);
  }
  let memory = await readProjectMemory(root);
  const lessons = masterLessons(memory);
  assert.equal(lessons.length, 40, 'at most 40 lessons are kept');
  assert.equal(lessons[0].text, 'Lesson number 40 of the retention run', 'newest first');
  assert.ok(!lessons.some(lesson => lesson.text.includes('number 0 ')), 'the 41st lesson dropped the oldest');
  assert.ok(lessons.some(lesson => lesson.text === 'Lesson number 1 of the retention run'), 'the second-oldest survives');

  // A lesson over the character limit is refused, and so is empty text.
  clock.at += 1_000;
  await assert.rejects(lessonCommand(root, 'lessons-master', ['add', 'x'.repeat(301)], deps), /A lesson is at most 300 characters/);
  await assert.rejects(lessonCommand(root, 'lessons-master', ['add'], deps), /Use master lesson add/);

  // Remove deletes by id.
  const removed = await lessonCommand(root, 'lessons-master', ['remove', lessons[0].id], deps) as { removed: { text: string }; lessons: number };
  assert.equal(removed.removed.text, 'Lesson number 40 of the retention run');
  assert.equal(removed.lessons, 39);
  assert.ok(!(await readProjectMemory(root)).notes.some(note => note.id === lessons[0].id), 'the file no longer holds it');
  await assert.rejects(lessonCommand(root, 'lessons-master', ['remove', 'no-such-id'], deps), /No master lesson no-such-id/);

  // The loop adopts the file's lessons — additions and removals — beside its own notes (GY-3274).
  const state = emptyProjectMemory('2026-11-12T07:00:00Z');
  recordNoteInMemory(state, { id: 'note-1', key: 'GY-1', kind: 'human-answer', text: 'An operator answer', by: 'operator', at: '2026-11-12T07:00:00Z' });
  const stale = { ...state, notes: [...state.notes, { id: 'gone', key: 'master', kind: 'master-lesson', text: 'A lesson the master removed', by: 'lessons-master', at: '2026-11-12T06:00:00Z' }] };
  const reconciled = reconcileMasterMemory(stale, await recordedMasterMemory(root));
  assert.deepEqual(masterLessons(reconciled), masterLessons(await readProjectMemory(root)), 'the file is the lessons\' truth, removals included');
  assert.ok(!reconciled.notes.some(note => note.id === 'gone'), 'a lesson removed from the file leaves the loop\'s copy');
  assert.ok(reconciled.notes.some(note => note.id === 'note-1'), 'the loop\'s own notes survive');

  // A worker identity is refused, whatever it tries to record.
  const workerDeps = lessonDeps({ 'worker-token': { id: 'implementer-1', role: 'worker' } }, clock);
  await assert.rejects(lessonCommand(root, 'lessons-master', ['add', 'A worker wrote this'], { ...workerDeps, callerCredential: async () => 'worker-token' }),
    /A worker identity \(implementer-1\) cannot record the master's lessons/);
  await assert.rejects(lessonCommand(root, 'lessons-master', ['list'], { ...workerDeps, callerCredential: async () => 'worker-token' }),
    /A worker identity \(implementer-1\) cannot record the master's lessons/);
  // The master's own session carries no credential, and a non-worker credential is not refused.
  const listed = await lessonCommand(root, 'lessons-master', ['list'], { ...lessonDeps({ 'operator-token': { id: 'human-operator', role: 'admin' } }, clock), callerCredential: async () => 'operator-token' }) as { lessons: { id: string; text: string }[] };
  assert.equal(listed.lessons.length, 39);
});
