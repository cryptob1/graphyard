import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DaemonState } from './daemon/state.js';
import { faultClassPolicyDefaults, recurringClasses, type FaultClassPolicy } from './model/fault-classes.js';
import {
  emptyProjectMemory,
  projectMemorySchema,
  recordChangeInMemory,
  recordDecisionInMemory,
  recordPitfallInMemory,
  updateProjectMemoryFromWork,
  type ProjectMemory,
} from './model/project-memory.js';
import type { Work } from './model/work.js';

export {
  emptyProjectMemory,
  isDecisionRoleRelevant,
  isPitfallRoleRelevant,
  projectMemoryDigest,
  projectMemorySchema,
  projectMemoryWordBudget,
  recentChangesWindowMs,
  recordChangeInMemory,
  recordDecisionInMemory,
  recordPitfallInMemory,
  retainedMemoryChanges,
  retainedMemoryDecisions,
  retainedMemoryPitfalls,
  sanctionedRemedies,
  updateProjectMemoryFromWork,
  type MemoryChange,
  type MemoryDecision,
  type MemoryPitfall,
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
 * Updates project memory from settled decisions, recurring fault classes, and merges.
 * Never updates from an agent's unreviewed claim.
 */
export async function syncProjectMemory(
  options: {
    root?: string;
    existing?: ProjectMemory;
    work?: readonly Work[];
    state?: DaemonState;
    now?: number;
    policy?: FaultClassPolicy;
  }
): Promise<ProjectMemory> {
  const now = options.now ?? Date.now();
  let memory = options.existing ?? (options.root ? await readProjectMemory(options.root).catch(() => emptyProjectMemory()) : emptyProjectMemory());

  // 1. Update from work items (operator answers and merges)
  if (options.work?.length) {
    memory = updateProjectMemoryFromWork(memory, options.work, now);
  }

  // 2. Update from settled decisions in daemon state approvals
  if (options.state?.approvals) {
    for (const [key, watch] of Object.entries(options.state.approvals)) {
      if (watch.settledAt) {
        recordDecisionInMemory(memory, {
          id: watch.decision,
          key: watch.work,
          action: watch.action,
          reason: `Settled approved ${watch.action} decision on ${watch.work}`,
          state: 'applied',
          approvedBy: watch.agentName ?? 'graphyard-approver',
          at: watch.settledAt,
        });
      }
    }
  }

  // 3. Update from recurring fault classes in daemon state
  if (options.state?.faults) {
    const policy = options.policy ?? faultClassPolicyDefaults;
    const work = options.work ?? [];
    const recurring = recurringClasses(options.state.faults.instances, work, policy, now);
    for (const item of recurring) {
      if (item.count >= policy.threshold) {
        recordPitfallInMemory(memory, {
          faultClass: item.faultClass,
          count: item.count,
          at: item.recent.at(-1)?.at ?? new Date(now).toISOString(),
        });
      }
    }
  }

  // Save to disk if root provided
  if (options.root) {
    await writeProjectMemory(options.root, memory).catch(() => {});
  }

  return memory;
}
