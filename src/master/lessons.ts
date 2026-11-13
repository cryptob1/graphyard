// Concern: the master's durable lessons (GY-3274) — `master lesson add|remove|list`, recorded in
// project memory, carried by every master launch prompt and, when marked for workers, by worker prompts.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { readProjectMemory, writeProjectMemory } from '../project-memory.js';
import { masterLessons, recordMasterLesson, removeMasterLesson } from '../model/project-memory.js';

export const lessonUsage = 'Use master lesson add TEXT [--for workers] | master lesson remove ID | master lesson list';

/** What `master lesson` needs beyond the checkout: the control plane's word on a credential. */
export interface LessonDependencies {
  /** The control plane's status for one credential, naming the actor it belongs to. */
  status: (credential: string) => Promise<{ actor?: { id?: string; role?: string } }>;
  /** The credential the invoking environment carries, when any: the master's own session runs with none. */
  callerCredential?: () => Promise<string | undefined>;
  now?: () => number;
}

/**
 * Records, removes and lists the master's own lessons in `.graphyard/project-memory.json`. The
 * lessons are the master's alone: an environment carrying a worker's credential is refused, so a
 * worker session can never write the memory its own prompt reads.
 */
export async function lessonCommand(root: string, by: string, args: string[], deps: LessonDependencies) {
  const caller = await deps.callerCredential?.().catch(() => undefined);
  if (caller) {
    const actor = (await deps.status(caller)).actor;
    if (actor?.role === 'worker') throw new Error(`A worker identity (${actor.id ?? 'unknown'}) cannot record the master's lessons; they are the master's own`);
  }
  const now = () => new Date(typeof deps.now === 'function' ? deps.now() : Date.now()).toISOString();
  if (args[0] === 'add') {
    const { values, positionals } = parseArgs({ args, options: { for: { type: 'string' } }, allowPositionals: true });
    if (values.for !== undefined && values.for !== 'workers') throw new Error(lessonUsage);
    const text = positionals.slice(1).join(' ').trim();
    if (!text) throw new Error(lessonUsage);
    const memory = await readProjectMemory(root);
    const lesson = recordMasterLesson(memory, { id: randomUUID(), text, by, at: now(), forWorkers: values.for === 'workers' });
    await writeProjectMemory(root, memory);
    return { recorded: lesson, lessons: masterLessons(memory).length };
  }
  if (args[0] === 'remove') {
    const id = args[1];
    if (!id) throw new Error(lessonUsage);
    const memory = await readProjectMemory(root);
    const removed = removeMasterLesson(memory, id);
    await writeProjectMemory(root, memory);
    return { removed, lessons: masterLessons(memory).length };
  }
  if (args[0] === 'list') {
    const lessons = masterLessons(await readProjectMemory(root));
    return { lessons: lessons.map(lesson => ({ id: lesson.id, at: lesson.at, forWorkers: lesson.forWorkers ?? false, text: lesson.text })) };
  }
  throw new Error(lessonUsage);
}
