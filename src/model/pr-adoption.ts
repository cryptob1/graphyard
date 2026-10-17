import { z } from 'zod';

/**
 * GY-1849: one existing pull request adopted into one Graphyard item, on its same branch and head.
 *
 * `graphyard master adopt GY-N --pr NUMBER --head SHA [--source-key KEY --source-url URL] REASON`
 * binds this repository, the pull request number and the exact head it names — with the original
 * source's key and URL, kept on the item — to the item as one appended fact. The binding is refused
 * when the pull request's live head differs from the one named (a moved head) or when another item
 * or another open attempt already holds that pull request or its branch (a second owner), naming
 * the holder. Repeating the same adoption is an idempotent no-op that records no second binding,
 * item, pull request or dispatch. An attempt on an adopted item works on the adopted pull request's
 * own branch from its existing commits, and `complete` on it accepts only that pull request, so no
 * replacement pull request is created. Adoption itself writes nothing to GitHub — it never
 * force-pushes, retargets, renames, closes or comments on the pull request — and it never weakens
 * the item's criteria: checks and reviews the old head earned stay history, and the next head is
 * gated afresh. Releasing the adopted item is a separate decision.
 */

/** The intent `master adopt` records; the control plane re-reads the live pull request itself. */
export const adoptSchema = z.object({
  pr: z.number().int().positive(),
  head: z.string().regex(/^[0-9a-f]{40}$/),
  sourceKey: z.string().trim().min(1).max(300).optional(),
  sourceUrl: z.url().max(2000).optional(),
  reason: z.string().trim().min(1).max(2000),
}).strict();
export type Adopt = z.infer<typeof adoptSchema>;

/** The pull request as the provider reports it live, read outside any coordination transaction. */
export interface AdoptedPull { head: string; branch: string; state: 'open' | 'closed' }

/** The binding an accepted adoption records on the item, once. */
export interface PrAdoption {
  pr: number; head: string; branch: string; repository: string;
  /** The adopted work's origin outside Graphyard, kept on the item beside the binding. */
  sourceKey?: string; sourceUrl?: string;
  adoptedBy: string; adoptedAt: string;
}

/** A peer item as the holder judgement reads it: identity, pull-request holdings, attempts, reservations. */
export interface AdoptionPeer {
  id: string; key: string;
  submission?: { epoch: number; pr: number } | null;
  prAdoption?: PrAdoption | null;
  pipeline?: { attempts: { epoch: number; endedAt: string | null }[] } | null;
  workspaces?: { epoch: number; branch: string }[];
}

/** The moved-head refusal: it names the head the provider reports now, so the master can re-adopt. */
export function movedHeadRefusal(pr: number, live: AdoptedPull, named: string): string {
  return `Pull request #${pr} moved: its live head is ${live.head}, not ${named.slice(0, 12)}; adoption binds a live head, so read it again and adopt naming it`;
}

/** A closed or merged pull request cannot be adopted: no attempt on it could ever submit it. */
export function closedPullRefusal(pr: number): string {
  return `Pull request #${pr} is closed; adoption binds an open pull request`;
}

/**
 * Whose pull request is it already. A second owner is refused naming the holder: another item's
 * submission or adoption of the same number, or its reservation of the adopted branch — the hold
 * the adopted item's own attempt would meet at its workspace. The item's own holds are its own.
 */
export function adoptionHolderRefusal(all: readonly AdoptionPeer[], work: Pick<AdoptionPeer, 'id' | 'key'>, pr: number, branch: string): string | null {
  for (const item of all) {
    if (item.id === work.id) continue;
    if (item.submission?.pr === pr) return `${item.key} already holds pull request #${pr} as its submission (epoch ${item.submission.epoch})`;
    if (item.prAdoption?.pr === pr) return `${item.key} already adopted pull request #${pr} at head ${item.prAdoption.head.slice(0, 12)} on ${item.prAdoption.branch}`;
    const reserved = (item.workspaces ?? []).find(space => space.branch === branch);
    if (reserved) return `${item.key} reserves ${branch} (epoch ${reserved.epoch}); the adopted pull request's branch is already held`;
  }
  return null;
}

/** The same adoption recorded again — one binding, one head, one repository: the idempotent no-op. */
export function sameAdoption(binding: PrAdoption, intent: { pr: number; head: string }, repository: string): boolean {
  return binding.pr === intent.pr && binding.head === intent.head && binding.repository === repository;
}

/** The binding built from an accepted adoption: the intent and the live read, named and stamped. */
export function prAdoptionOf(intent: Adopt, live: AdoptedPull, repository: string, by: string, now: Date): PrAdoption {
  return { pr: intent.pr, head: intent.head, branch: live.branch, repository,
    ...(intent.sourceKey ? { sourceKey: intent.sourceKey } : {}), ...(intent.sourceUrl ? { sourceUrl: intent.sourceUrl } : {}),
    adoptedBy: by, adoptedAt: now.toISOString() };
}
