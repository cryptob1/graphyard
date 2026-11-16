// Concern: GY-3393 — the owner's taste of one delivered item, recorded from the Work page's Taste feed.
//
// A taste is recorded after delivery and gates nothing: the delivered item is never reopened, its
// stage and delivery stay as they are, and no other item waits on a taste. `good` records the look.
// `send-back` files the note as a follow-up item — the note is its reason — in the same transaction,
// beside a proposed master lesson carrying the note (on the follow-up's `origin`), which the master
// keeps (`graphyard master lesson add`) or drops by recording nothing.
import { admin, demand, isDelivered, type Taste, type Work } from '../../model.js';
import { open as openCreated } from './create.js';
import type { Ctx } from './types.js';

/**
 * The follow-up one send-back files, worded like a post-merge review's (model/post-merge-review.ts):
 * a bug at priority 1 whose reason is the note, reusing the delivered item's E2E cases beside its
 * own unit proof — legacy Graphyard items with no E2E proof use create-work-item.
 */
export function tasteFollowUp(delivered: Pick<Work, 'key' | 'title' | 'policy'> & Partial<Pick<Work, 'criteria'>>, note: string, by: string, at: string) {
  const e2e = delivered.criteria?.flatMap(criterion => criterion.proofs).filter(proof => proof.startsWith('e2e:')) ?? [];
  return {
    title: `Taste send-back of ${delivered.key}: ${note}`.slice(0, 200),
    why: 'The owner tasted this delivery and asked for the change its note names.',
    simplest: 'A follow-up item reuses the delivery loop rather than reopening the merge.',
    description: `Sent back from the Work page's Taste feed by ${by} at ${at}. The note is this item's reason:\n\n${note}\n\nProposed master lesson carrying the note — keep it with \`graphyard master lesson add "${note.slice(0, 280)}"\` or drop it by recording nothing.`,
    type: 'bug' as const, priority: 1, summary: `Sent back from Taste: ${note}`.slice(0, 400), dependencies: [], systemDriven: true,
    criteria: [{ id: 'AC-1', text: `The send-back note is addressed: ${note}`.slice(0, 2000), proofs: ['unit:taste-follow-up', ...(e2e.length ? [...new Set(e2e)] : ['e2e:create-work-item'])] }],
    policy: { checks: delivered.policy?.checks ?? ['test', 'typecheck'], review: true },
    origin: { proposedLesson: { text: note, from: delivered.key, by, at } },
  };
}

export async function run(c: Ctx) {
  const { actor, data, now, work } = c;
  admin(actor);
  demand(isDelivered(work), `${work.key} has not shipped; Taste tastes delivered work`, 409);
  const already = work.taste;
  demand(!already, `${work.key} was already tasted (${already?.verdict === 'good' ? 'looks good' : `sent back: ${already?.note}`})`, 409);
  const at = now.toISOString();
  let followUp: Work | undefined;
  if (data.verdict === 'send-back') {
    followUp = await openCreated({ ...c, command: 'create', id: null, data: tasteFollowUp(work, data.note, actor.id, at) });
    // `open` inserts before the item's key is assigned; write the keyed document back, as the create command's own save does.
    await c.db.query('UPDATE work_items SET document=$2 WHERE id=$1', [followUp.id, JSON.stringify(followUp)]);
  }
  const taste: Taste = { verdict: data.verdict, at, by: actor.id, ...(followUp ? { note: data.note, followUp: { id: followUp.id, key: followUp.key } } : {}) };
  work.taste = taste;
}

export function delivered() {
  // A taste is recorded only on a delivered item (run's own demand), and it extends the delivery
  // with the owner's judgement: the item is neither reopened nor re-evaluated, so nothing waits on it.
  return true;
}
