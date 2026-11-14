import { admin } from '../../model.js';
import type { Ctx } from './types.js';

/**
 * GY-3298: a durable message to whichever worker holds the item. It stays unread on the item until
 * a worker's sync shows it and acknowledges it under that worker's epoch, so a restart keeps it and
 * a successor's prompt carries what an ended attempt never read.
 */
export function run({ actor, work, data, now }: Ctx) {
  if (actor.role !== 'operator-agent') admin(actor);
  const messages = work.messages ?? [];
  work.messages = [...messages, { id: `m${messages.length + 1}`, at: now.toISOString(), by: actor.id, text: data.text }];
}
