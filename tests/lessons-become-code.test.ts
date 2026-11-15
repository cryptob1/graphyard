import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { repeatedFailureCause } from '../src/daemon/repeated-failure.js';
import { bootstrapGate, gateRecordPath, writeGateRecord } from '../src/batch-gate.js';
import { lessonCommand } from '../src/master/lessons.js';
import { masterConfigSchema } from '../src/master.js';
import { masterLessons, readProjectMemory, recordedMasterMemory, thisWeekReport, writeProjectMemory } from '../src/project-memory.js';
import type { Work } from '../src/model/work.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3399: lessons become code. Given master lessons and a repeated rework reason, the loop's
// master pass files one item for each lesson marked mechanically enforceable (never for a plain
// one, and never twice across cycles); that item's delivery removes the lesson it turned into
// code, and the week's gates-removed count is computed from those removals beside the week's reverts.

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/game', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-game', workers: [] });
const day = 24 * 3_600_000;

test('integration:lessons-become-code — the master pass files an item per enforceable lesson or rework reason, delivery removes the lesson, and the week counts the removals', async () => {
  const root = await temporaryDirectory('lessons-become-code');
  const clock = { at: Date.parse('2026-11-15T08:00:00Z') };
  const deps = { status: async () => ({ actor: { id: 'graphyard-master', role: 'coordinator' } }), now: () => clock.at };

  // A review refusal repeated twice: the master's wake names the command that makes it code.
  const reason = 'Every new route must be listed in the route registry test';
  const cause = repeatedFailureCause({ key: 'GY-40', kind: 'review', signature: 'review:x', reasons: [reason, reason], count: 2, rework: null, handedIn: null, seen: [] });
  assert.match(cause!.detail, /master lesson add REASON --enforceable/, 'a repeated rework reason points the master at --enforceable');

  // The master records a plain lesson, an enforceable lesson and the enforceable rework reason.
  const plain = 'The trial host answers slowly on Mondays';
  const enforceable = 'Never import from src/server inside src/model';
  await lessonCommand(root, 'graphyard-master', ['add', plain], deps);
  clock.at += 1_000;
  const lesson = (await lessonCommand(root, 'graphyard-master', ['add', enforceable, '--enforceable'], deps) as { recorded: { id: string } }).recorded;
  clock.at += 1_000;
  const check = (await lessonCommand(root, 'graphyard-master', ['add', reason, '--enforceable'], deps) as { recorded: { id: string } }).recorded;

  const filed: { key: string; title: string; proofs: string[] }[] = [];
  let writes = Promise.resolve(), work: Work[] = [], written = '';
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(clock.at).toISOString() }),
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => ({ pane: 'p1', epoch: 1 }),
    mergeWriter: { createWork: async (input: { title: string; criteria: { proofs: string[] }[] }, key: string) => {
      filed.push({ key, title: input.title, proofs: input.criteria.flatMap(criterion => criterion.proofs) });
      return { key: `GY-${500 + filed.length}` };
    } } as unknown as MergeWriterReads,
    recordedMasterMemory: () => recordedMasterMemory(root),
    // As the production persist does: the loop's copy of project memory is mirrored to the file when it changed.
    persist: async state => { const memory = JSON.stringify(state.projectMemory); if (memory !== written) { written = memory; writes = writes.then(() => writeProjectMemory(root, JSON.parse(memory))); } await writes; },
  };
  // The loop's state starts as a loop already running would hold it: its copy mirrored to the file already.
  const state = emptyDaemonState(config);
  written = JSON.stringify(state.projectMemory);
  const cycle = () => runCycle(config, state, effects, () => clock.at, undefined, () => {}).then(() => writes);

  await cycle();
  assert.deepEqual(filed.map(entry => entry.key).sort(), [`lesson-to-code:${check.id}`, `lesson-to-code:${lesson.id}`].sort(), 'one item per enforceable lesson, none for the plain one');
  assert.ok(filed.every(entry => entry.title.startsWith('Lesson to code: ') && entry.proofs[0].startsWith('unit:lesson-')), 'each item asks for a lint rule, type or test');
  const recorded = masterLessons(await readProjectMemory(root));
  const filedAs = Object.fromEntries(recorded.filter(entry => entry.filedAs).map(entry => [entry.id, entry.filedAs]));
  assert.equal(Object.keys(filedAs).length, 2, 'the file records the item each enforceable lesson was filed as');
  const lessonItem = filedAs[lesson.id]!;

  // Repeated cycles file nothing new.
  clock.at += 60_000;
  await cycle();
  assert.equal(filed.length, 2, 'a filed lesson is never filed again');

  // The lesson's item is delivered: the next pass removes the lesson; the other stays.
  clock.at += 60_000;
  const stale = await readProjectMemory(root);
  work = [{ id: 'w-1', key: lessonItem, stage: 'done', delivery: { mergedAt: new Date(clock.at).toISOString(), mergeSha: 'a'.repeat(40) } } as unknown as Work];
  await cycle();
  const memory = await readProjectMemory(root);
  assert.deepEqual(masterLessons(memory).map(entry => entry.text).sort(), [plain, reason].sort(), 'the delivered lesson left memory and every prompt');
  assert.deepEqual(memory.removedGates?.map(entry => ({ id: entry.id, key: entry.key })), [{ id: lesson.id, key: lessonItem }]);
  // The master writing the file again from its stale copy neither restores the lesson nor counts the removal twice.
  await writeProjectMemory(root, stale);
  clock.at += 60_000;
  await cycle();
  assert.ok(!masterLessons(state.projectMemory).some(entry => entry.id === lesson.id), 'the removed lesson stays removed');
  assert.equal(state.projectMemory.removedGates?.length, 1);
  await writeProjectMemory(root, state.projectMemory); // the loop's next mirror of its copy, at its next memory change

  // The week's count: one gate removed, beside the batch gate's reverts this week.
  await writeGateRecord(gateRecordPath(root), { ...bootstrapGate('owner/game', 'c'.repeat(40)), reverts: [{ item: 'GY-77', at: new Date(clock.at - 8 * day).toISOString() }, { item: 'GY-88', at: new Date(clock.at - day).toISOString() }] });
  assert.deepEqual(await thisWeekReport(root, clock.at), { reverts: 1, revertedItems: ['GY-88'], gatesRemoved: 1, gatesRemovedItems: [lessonItem] });
  assert.deepEqual(await thisWeekReport(root, clock.at + 8 * day), { reverts: 0, revertedItems: [], gatesRemoved: 0, gatesRemovedItems: [] }, 'removals older than a week leave the count');
});
