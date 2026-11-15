// Concern: GY-3399 — lessons become code. A master lesson the master marked mechanically
// enforceable (`master lesson add TEXT --enforceable`, also how it records a repeated rework reason
// a reviewer keeps judging) gets one item that turns it into a lint rule, type or test; once that
// item is delivered the lesson leaves every prompt, and the removal counts toward "gates removed
// this week" beside the batch gate's reverts this week.
import type { Work } from './work.js';
import type { z } from 'zod';
import type { removedGateSchema } from '../model-boundary/project-memory.js';
import { masterLessons, type MemoryNote, type ProjectMemory } from './project-memory.js';

export type RemovedGate = z.infer<typeof removedGateSchema>;
export const weekMs = 7 * 24 * 3_600_000;
export const retainedRemovedGates = 100;

/** The enforceable lessons that have no item yet. */
export const lessonsToFile = (memory: ProjectMemory) => masterLessons(memory).filter(lesson => lesson.enforceable && !lesson.filedAs);

/** The item that turns one lesson into code. */
export const lessonCodeItem = (lesson: MemoryNote) => ({
  title: `Lesson to code: ${lesson.text}`.slice(0, 200), type: 'chore' as const, priority: 2, dependencies: [],
  description: `The master marked this lesson mechanically enforceable: "${lesson.text}". Today an agent reads it in every prompt and a reviewer judges it by hand. Enforce it in code instead — a lint rule, a type or a test that fails when it is broken — so it no longer needs to be said. Once this item is delivered the loop removes the lesson (id ${lesson.id}).`,
  criteria: [{ id: 'AC-1', text: `A lint rule, type or test enforces the lesson and fails when it is broken: ${lesson.text}`.slice(0, 500), proofs: [`unit:lesson-${lesson.id.slice(0, 8).toLowerCase()}-enforced`] },
    { id: 'AC-2', text: 'The app still serves its smoke case', proofs: ['e2e:smoke'] }],
  reason: 'Filed by the master loop: a lesson marked mechanically enforceable becomes code (GY-3399)',
});

/** Removes each filed lesson whose item the snapshot shows delivered, recording the removal; returns the removals. */
export function removeDeliveredLessons(memory: ProjectMemory, work: readonly Work[], now: number): RemovedGate[] {
  const delivered = new Set(work.filter(item => item.stage === 'done' && !item.closure && (item.delivery?.mergedAt || item.observation?.merged)).map(item => item.key));
  const removed = masterLessons(memory).filter(lesson => lesson.filedAs && delivered.has(lesson.filedAs))
    .map(lesson => ({ id: lesson.id, text: lesson.text, key: lesson.filedAs!, at: new Date(now).toISOString() }));
  if (!removed.length) return [];
  const gone = new Set(removed.map(entry => entry.id));
  memory.notes = memory.notes.filter(note => !gone.has(note.id));
  const recorded = new Set((memory.removedGates ?? []).map(entry => entry.id));
  memory.removedGates = [...memory.removedGates ?? [], ...removed.filter(entry => !recorded.has(entry.id))].slice(-retainedRemovedGates);
  return removed;
}

/** The gates removed in the seven days before `now`, newest first. */
export const gatesRemovedThisWeek = (memory: Pick<ProjectMemory, 'removedGates'> | null | undefined, now: number) =>
  (memory?.removedGates ?? []).filter(entry => now - Date.parse(entry.at) < weekMs).reverse();

/** The batch gate's reverts in the seven days before `now`, newest first. */
export const revertsThisWeek = (record: { reverts?: { item: string; at: string }[] } | null | undefined, now: number) =>
  (record?.reverts ?? []).filter(entry => now - Date.parse(entry.at) < weekMs).reverse();

/** What master status and the dashboard header show: the week's reverts beside the week's removed gates, each naming its items. */
export const thisWeek = (memory: Pick<ProjectMemory, 'removedGates'> | null | undefined, record: { reverts?: { item: string; at: string }[] } | null | undefined, now: number) => {
  const reverts = revertsThisWeek(record, now), gates = gatesRemovedThisWeek(memory, now);
  return { reverts: reverts.length, revertedItems: [...new Set(reverts.map(entry => entry.item))], gatesRemoved: gates.length, gatesRemovedItems: [...new Set(gates.map(entry => entry.key))] };
};
export type ThisWeek = ReturnType<typeof thisWeek>;
