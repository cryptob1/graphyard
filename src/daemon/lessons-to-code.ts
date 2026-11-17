// Concern: GY-3399 — the master pass that turns enforceable lessons into code: it files one item per
// lesson the master marked mechanically enforceable, and removes the lesson once that item is delivered.
import type { Work } from '../model/work.js';
import type { ProjectMemory } from '../model/project-memory.js';
import { lessonCodeItem, lessonsToFile, removeDeliveredLessons } from '../model/lessons-to-code.js';
import type { RelandInput } from '../merge-writer/serve-revert.js';

/**
 * One pass over the memory: each delivered lesson-to-code item removes its lesson, then each
 * enforceable lesson without an item gets one, under a create key bound to the lesson so a retried
 * filing is the same item. A filed lesson is never filed again, so repeated cycles file nothing new.
 */
export async function lessonsToCode(memory: ProjectMemory, work: readonly Work[], now: number,
  createWork: ((input: RelandInput, key: string) => Promise<{ key?: string } | null>) | undefined, log: (line: string) => void) {
  for (const removed of removeDeliveredLessons(memory, work, now)) log(`[graphyard-master] ${removed.key} delivered: removed the lesson it turned into code: ${removed.text}`);
  if (!createWork) return;
  for (const lesson of lessonsToFile(memory)) {
    try {
      const created = await createWork(lessonCodeItem(lesson), `lesson-to-code:${lesson.id}`);
      if (created?.key) { lesson.filedAs = created.key; log(`[graphyard-master] filed ${created.key} to turn a lesson into code: ${lesson.text}`); }
    } catch (error) { log(`[graphyard-master] the lesson-to-code item for lesson ${lesson.id} was not filed and is filed again next cycle: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
