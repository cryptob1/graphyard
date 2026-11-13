import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyProjectMemory, masterLessons, updateProjectMemoryFromWork, type MemoryNote, type ProductBrief, type ProjectMemory } from './model/project-memory.js';
import { projectMemorySchema } from './model-boundary/project-memory.js';
import type { Work } from './model/work.js';

export { emptyProjectMemory, isNoteRoleRelevant, masterBriefSection, masterLessonCharacterLimit, masterLessonKind, masterLessonWordTotal, masterLessons, masterLessonsSection, productBriefExcerpt, productBriefHeadings, productBriefSectionWords, productBriefWordLimit, productBriefWorkingHeadings, projectMemoryDigest, projectMemoryWordBudget, recentChangesWindowMs, recordChangeInMemory, recordMasterLesson, recordNoteInMemory, reconcileMasterMemory, removeMasterLesson, retainedMasterLessons, retainedMemoryChanges, retainedMemoryNotes, retainedProductBriefChanges, setProductBrief, boundMemoryNotes, updateProjectMemoryFromWork, type MemoryChange, type MemoryNote, type ProjectMemory, type ProductBrief, type ProductBriefChange, type SessionRole } from './model/project-memory.js';
export { projectMemorySchema, productBriefSchema, productBriefChangeSchema } from './model-boundary/project-memory.js';

export const projectMemoryPath = (root: string) => resolve(root, '.graphyard', 'project-memory.json');

/**
 * What the master session wrote to `.graphyard/project-memory.json` (GY-3274) — its lessons and the
 * product brief — or null when that file is absent or unreadable: the loop reads them back from the
 * file rather than trusting its own older copy.
 */
export async function recordedMasterMemory(root: string): Promise<{ lessons: MemoryNote[]; brief: ProductBrief | null } | null> {
  try {
    const memory = projectMemorySchema.parse(JSON.parse(await readFile(projectMemoryPath(root), 'utf8')));
    return { lessons: masterLessons(memory), brief: memory.brief };
  } catch { return null; }
}

export async function readProjectMemory(root: string): Promise<ProjectMemory> {
  const file = projectMemoryPath(root);
  try {
    const raw = await readFile(file, 'utf8');
    return projectMemorySchema.parse(JSON.parse(raw));
  } catch (error: any) {
    if (error.code === 'ENOENT') return emptyProjectMemory(new Date().toISOString());
    throw error;
  }
}

export async function writeProjectMemory(root: string, memory: ProjectMemory): Promise<void> {
  const file = projectMemoryPath(root);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(projectMemorySchema.parse(memory), null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

/**
 * Updates project memory from operator answers and merges.
 * Never updates from an agent's unreviewed claim.
 */
export async function syncProjectMemory(
  options: {
    root?: string;
    existing?: ProjectMemory;
    work?: readonly Work[];
    now?: number;
  }
): Promise<ProjectMemory> {
  const now = options.now ?? Date.now();
  let memory = options.existing ?? (options.root ? await readProjectMemory(options.root).catch(() => emptyProjectMemory(new Date(now).toISOString())) : emptyProjectMemory(new Date(now).toISOString()));

  // 1. Update from work items (operator answers and merges)
  if (options.work?.length) {
    memory = updateProjectMemoryFromWork(memory, options.work, now);
  }

  // Save to disk if root provided
  if (options.root) {
    await writeProjectMemory(options.root, memory).catch(() => {});
  }

  return memory;
}
