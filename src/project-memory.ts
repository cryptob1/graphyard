import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  emptyProjectMemory,
  projectMemorySchema,
  updateProjectMemoryFromWork,
  type ProjectMemory,
} from './model/project-memory.js';
import type { Work } from './model/work.js';

export {
  emptyProjectMemory,
  isDecisionRoleRelevant,
  projectMemoryDigest,
  projectMemorySchema,
  projectMemoryWordBudget,
  recentChangesWindowMs,
  recordChangeInMemory,
  recordDecisionInMemory,
  retainedMemoryChanges,
  retainedMemoryDecisions,
  updateProjectMemoryFromWork,
  type MemoryChange,
  type MemoryDecision,
  type ProjectMemory,
  type SessionRole,
} from './model/project-memory.js';

export const projectMemoryPath = (root: string) => resolve(root, '.graphyard', 'project-memory.json');

export async function readProjectMemory(root: string): Promise<ProjectMemory> {
  const file = projectMemoryPath(root);
  try {
    const raw = await readFile(file, 'utf8');
    return projectMemorySchema.parse(JSON.parse(raw));
  } catch (error: any) {
    if (error.code === 'ENOENT') return emptyProjectMemory();
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
 * Updates project memory from settled decisions and merges.
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
  let memory = options.existing ?? (options.root ? await readProjectMemory(options.root).catch(() => emptyProjectMemory()) : emptyProjectMemory());

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
