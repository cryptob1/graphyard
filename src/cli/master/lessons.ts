// Concern: `graphyard master lesson` — the master's own durable lessons (GY-3274).
import { lessonCommand } from '../../master/lessons.js';
import { unhandled, type MasterSession } from './session.js';

export async function lessonsCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, masterApi, coordinator } = session;
  if (id !== 'lesson') return unhandled;
  return print(await lessonCommand(root, coordinator?.actor?.id ?? 'master', args, {
    status: credential => masterApi('status', credential),
    callerCredential: () => session.context.individualToken(),
  }));
}
