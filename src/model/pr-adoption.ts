import { z } from 'zod';

/**
 * GY-1849: one existing pull request adopted into one Graphyard item, on its same branch and head.
 *
 * `graphyard master adopt GY-N --pr NUMBER --head SHA [--source-key KEY --source-url URL] REASON`
 * binds this repository, the pull request number and the exact head it names — with the original
 * source's key and URL, kept on the item — to the item as one appended fact. The binding is refused
 * when the pull request's live head differs from the one named (a moved head) or when another item
 * or another open attempt already holds that pull request or its branch (a second owner), naming
 * the holder; a draft is refused until its author marks it ready, an install whose merge writer is
 * the control plane refuses every adoption (no GitHub pull request could ever complete there), and
 * a first adoption waits for any live attempt on the item to end. Repeating the same adoption is an
 * idempotent no-op that records no second binding, item, pull request or dispatch, and a re-adopt
 * at a new live head rebinds while nothing is submitted. An attempt on an adopted item works on the
 * adopted pull request's own branch from its existing commits, and `complete` on it accepts only
 * that pull request at the adopted head — a head the pull request has moved to since is refused
 * naming both shas, and the master re-adopts at the live head — so no replacement pull request is
 * created. Adoption itself writes nothing to GitHub — it never force-pushes, retargets, renames,
 * closes or comments on the pull request — and it never weakens the item's criteria: checks and
 * reviews the old head earned stay history, and the next head is gated afresh. Releasing the
 * adopted item is a separate decision.
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
export interface AdoptedPull { head: string; branch: string; state: 'open' | 'closed'; draft: boolean; headRepository: string | null; baseRepository: string | null; baseRef: string | null }

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

/** A draft's author is still reshaping it, so its adoption waits until it is marked ready for review. */
export function draftPullRefusal(pr: number): string {
  return `Pull request #${pr} is a draft; adoption binds a pull request marked ready for review`;
}

/**
 * A fork's head cannot be fetched or pushed through the managed repository's origin, so an attempt
 * on it could never work or complete: the same-repository invariant the observation path holds.
 */
export function forkedPullRefusal(pr: number, headRepository: string | null, baseRepository: string | null, repository: string): string {
  return `Pull request #${pr} lives on ${headRepository ?? 'an unknown head repository'} against ${baseRepository ?? 'an unknown base repository'}, not ${repository}; adoption binds a same-repository pull request the managed origin can fetch and push`;
}

/** A pull request against another branch never lands on the managed base, so its adoption could never complete. */
export function foreignBaseRefusal(pr: number, base: string | null, managed: string): string {
  return `Pull request #${pr} targets base ${base ?? 'an unknown branch'}, not ${managed}; adoption binds a pull request against the managed base branch`;
}

/**
 * Why an item with work in flight takes no adoption: a live lease means an attempt is working the
 * item now, and adoption never races it (the master adopts once the attempt ends); a recorded
 * candidate is the same fact in head form. Ended attempts are no hold at all.
 */
export function attemptLiveRefusal(work: { key: string; lease: { epoch: number; expiresAt: string } | null; candidate: unknown }, now: Date): string | null {
  if (work.candidate) return `${work.key} already holds a candidate head; adoption binds an item with nothing in flight`;
  if (work.lease && Date.parse(work.lease.expiresAt) > now.getTime()) return `${work.key}'s attempt (epoch ${work.lease.epoch}) holds a live lease; adoption waits for the attempt to end`;
  return null;
}

/**
 * Whether the attempt that reserved a workspace is still open: an ended attempt holds nothing, so
 * its recorded workspace is history the hold judgement reads past. A peer with no timeline recorded
 * is judged as holding — the absence of the record is no proof the attempt is over.
 */
const attemptOpen = (item: AdoptionPeer, epoch: number) =>
  !item.pipeline?.attempts?.length || (item.pipeline.attempts.find(entry => entry.epoch === epoch)?.endedAt ?? null) === null;

/**
 * Whose pull request is it already. A second owner is refused naming the holder: another item's
 * submission or adoption of the same number, or its live attempt's reservation of the adopted
 * branch — the hold the adopted item's own attempt would meet at its workspace. The item's own
 * holds are its own.
 */
export function adoptionHolderRefusal(all: readonly AdoptionPeer[], work: Pick<AdoptionPeer, 'id' | 'key'>, pr: number, branch: string): string | null {
  for (const item of all) {
    if (item.id === work.id) continue;
    if (item.submission?.pr === pr) return `${item.key} already holds pull request #${pr} as its submission (epoch ${item.submission.epoch})`;
    if (item.prAdoption?.pr === pr) return `${item.key} already adopted pull request #${pr} at head ${item.prAdoption.head.slice(0, 12)} on ${item.prAdoption.branch}`;
    const reserved = (item.workspaces ?? []).find(space => space.branch === branch && attemptOpen(item, space.epoch));
    if (reserved) return `${item.key} reserves ${branch} (epoch ${reserved.epoch}); the adopted pull request's branch is already held`;
  }
  return null;
}

/**
 * Whether an open attempt holds the adopted branch: the workspace reservation rule for that branch.
 * Every attempt on the adopted item shares the pull request's one branch, so an ended attempt's
 * record — the item's own earlier epoch or a peer's — holds nothing, by the same judgement the
 * holder check reads at adopt, and the two checks never disagree.
 */
export function adoptedBranchHeld(all: readonly AdoptionPeer[], branch: string): AdoptionPeer | null {
  return all.find(item => (item.workspaces ?? []).some(space => space.branch === branch && attemptOpen(item, space.epoch))) ?? null;
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
