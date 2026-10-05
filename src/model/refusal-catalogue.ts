import type { NextActionKind } from './action-kinds.js';
import { ciCheckRefusalPattern, ciCheckRefusalSource } from './ci-refusal.js';
import { requiredCheckFailurePattern } from './required-check-refusal.js';

/**
 * The refusals the engine can produce, declared beside the mapping that has to cover them.
 *
 * `refusalRules` is total by construction — its last rule matches everything — but totality over
 * *rules* proves nothing about totality over *outcomes*: a refusal nobody anticipated lands on the
 * catch-all and is called an escalation, which is an answer only if a judgment really is what it
 * needs. This is the other half of the proof. Each entry is one refusal shape `model/gates.ts`
 * (with `merge-queue.ts`, `regression-guard.ts`, `escalation.ts`, `delegation.ts` and
 * `evidence.ts`) can word, with a sample worded exactly as the engine words it and the kinds the
 * mapping may name for it — several, where the same sentence means different things depending on
 * what the item's own record says. `tests/action-totality.test.ts` drives the real evaluator over
 * a battery of states and asserts three things against this list: every refusal the engine
 * produced is a shape declared here, every declared shape maps inside its declared kinds, and
 * every rule in `refusalRules` is reachable from some shape. A refusal added to a gate without an
 * entry here fails that test rather than reaching production as a silent escalation.
 */
export interface RefusalShape {
  gate: string;
  /** What this refusal is about, short enough to name in a failure message. */
  id: string;
  match: RegExp;
  /** One refusal of this shape, worded as the engine words it. */
  example: string;
  /** Every action kind the mapping may name for it; more than one where the item's record decides. */
  kinds: NextActionKind[];
  /**
   * True for a refusal whose text a person or a provider wrote, so its wording cannot be pinned.
   * Such a shape catches anything its gate raises that no earlier shape claimed, which is why a
   * gate that admits free text can never prove that a *new* structured refusal was declared here.
   */
  free?: boolean;
}
/** Matches the refusal `mechanicalReviewHold` (src/mechanical-findings.ts) words: an approval's mechanical nits awaiting their bot round. */
export const mechanicalHoldPattern = /^Approval (\d+ )?of [0-9a-f]+ names \d+ findings? classified mechanical, which the worker bot fixes before the reviewer's fresh read \(GY-971\)/;
export const gateRefusalCatalogue: RefusalShape[] = [
  // ready
  { gate: 'ready', id: 'not-released', match: /^Not released from backlog$/, example: 'Not released from backlog', kinds: ['escalate'] },
  { gate: 'ready', id: 'dependency', match: /^Dependency .+ is unfinished$/, example: 'Dependency GY-9 is unfinished', kinds: ['dispatch'] },
  { gate: 'ready', id: 'blocker', match: /.*/, example: 'The staging database is unreachable', kinds: ['escalate'], free: true },
  // build
  { gate: 'build', id: 'not-submitted', match: /^Worker has not submitted implementation for this attempt$/, example: 'Worker has not submitted implementation for this attempt', kinds: ['dispatch'] },
  { gate: 'build', id: 'not-observed', match: /^Pull request has not been independently observed$/, example: 'Pull request has not been independently observed', kinds: ['resync'] },
  { gate: 'build', id: 'no-workspace', match: /^No workspace registered$/, example: 'No workspace registered', kinds: ['dispatch'] },
  { gate: 'build', id: 'base-conflict', match: /cannot be brought onto base branch tip .* without resolving a conflict/, kinds: ['request-rework'],
    example: 'Candidate aaaaaaaaaaaa cannot be brought onto base branch tip bbbbbbbbbbbb without resolving a conflict, which is content nobody reviewed or proved: merge conflict. Run graphyard sync GY-1, resolve it and push; the approval and proofs bound to aaaaaaaaaaaa do not survive the resolution.' },
  { gate: 'build', id: 'diff-not-compared', match: /^Candidate diff has not been compared against the base branch tip/, kinds: ['resync'],
    example: 'Candidate diff has not been compared against the base branch tip; a fresh GitHub observation is required' },
  { gate: 'build', id: 'out-of-scope-count', match: /^Candidate changes \d+ files? outside its planned files/, kinds: ['request-rework'],
    example: 'Candidate changes 2 files outside its planned files that must match the base branch byte-for-byte; run graphyard sync GY-1, restore each file from origin/<base>, and push again' },
  { gate: 'build', id: 'out-of-scope-file', match: /^Out-of-scope regression: /, example: 'Out-of-scope regression: src/other.ts reverts GY-2', kinds: ['request-rework'] },
  { gate: 'build', id: 'landing-count', match: /^Landing the candidate on /, kinds: ['request-rework'],
    example: 'Landing the candidate on cccccccccccc, the commit it would merge onto, would revert 2 files outside its planned files; run graphyard sync GY-1, restore each file as its owner shipped it, and push again' },
  { gate: 'build', id: 'landing-file', match: /^Landing regression: /, kinds: ['request-rework'],
    example: 'Landing regression: src/a.ts: deleted; that commit still holds it (owned by GY-A, ahead of it and not yet landed)' },
  // A mechanical proof that failed on the head returns it to its worker before review (GY-115).
  { gate: 'build', id: 'mechanical-proof-failed', match: /the head returns to its worker before review$/, kinds: ['request-rework'],
    example: 'AC-1: integration:claim failed on aaaaaaaaaaaa (trusted evidence from producer-a); the head returns to its worker before review' },
  // review — one sentence per provider, all of them meaning "no verdict binds this head"; which
  // action that needs is decided by `reviewStandstill` from the item's own record, not the text
  // (a head whose mechanical proofs have not passed yet is the producers' dispatch, GY-115).
  { gate: 'review', id: 'changes-requested', match: /^Outstanding change requests must be resolved through a new review$/, kinds: ['request-rework'],
    example: 'Outstanding change requests must be resolved through a new review' },
  // An approval naming nits classified mechanical holds the head for the worker bot's round (GY-971).
  { gate: 'review', id: 'mechanical-hold', match: mechanicalHoldPattern, kinds: ['request-rework'],
    example: "Approval 901 of aaaaaaaaaaaa names 2 findings classified mechanical, which the worker bot fixes before the reviewer's fresh read (GY-971); the head is not merged before that round, or before 2026-10-05T15:00:00.000Z if it never starts" },
  { gate: 'review', id: 'github-approval', match: /^Independent approval of the current commit is required$/, kinds: ['request-review', 'request-rework', 'resync', 'escalate', 'dispatch'],
    example: 'Independent approval of the current commit is required' },
  { gate: 'review', id: 'github-reset', match: /^A new independent GitHub approval after the requirement-review baseline is required$/, kinds: ['request-review', 'request-rework', 'resync', 'escalate', 'dispatch'],
    example: 'A new independent GitHub approval after the requirement-review baseline is required' },
  { gate: 'review', id: 'codex', match: /^Verified clean Codex review of the current commit is required$/, kinds: ['request-review', 'request-rework', 'resync', 'escalate', 'dispatch'],
    example: 'Verified clean Codex review of the current commit is required' },
  { gate: 'review', id: 'agent-profile', match: /^Verified approval from reviewer profile .+ is required for the current commit$/, kinds: ['request-review', 'request-rework', 'resync', 'escalate', 'dispatch'],
    example: 'Verified approval from reviewer profile reviewer-a is required for the current commit' },
  { gate: 'review', id: 'profiles-exhausted', match: /^Every configured reviewer profile is exhausted for this candidate/, kinds: ['request-review', 'request-rework', 'resync', 'escalate', 'dispatch'],
    example: 'Every configured reviewer profile is exhausted for this candidate (reviewer-a); add reviewer capacity or select another review provider' },
  { gate: 'review', id: 'provider-reason', match: /.*/, example: 'Pull request is draft; mark it ready to request code review', kinds: ['request-review', 'request-rework', 'resync', 'escalate', 'dispatch'], free: true },
  // test
  { gate: 'test', id: 'check-not-passed', match: ciCheckRefusalPattern, kinds: ['resync', 'request-rework'],
    example: 'Required CI check test has not passed on the current candidate' },
  { gate: 'test', id: 'required-check-failed', match: requiredCheckFailurePattern, kinds: ['request-rework'],
    example: 'Required check secrets failed on the current candidate' },
  // merge
  { gate: 'merge', id: 'github-unobserved', match: /^GitHub has not been observed at the current candidate$/, example: 'GitHub has not been observed at the current candidate', kinds: ['resync'] },
  // The same shape covers GitHub's not-yet-computed mergeability (GY-548), worded apart from a refusal.
  { gate: 'merge', id: 'not-mergeable', match: /^(Pull request is not mergeable against the current base$|GitHub is computing mergeability against the current base)/, example: 'Pull request is not mergeable against the current base', kinds: ['resync'] },
  { gate: 'merge', id: 'escalation', match: /^Unresolved .+ escalation requires operator resolution: /, kinds: ['escalate'],
    example: 'Unresolved security-concern escalation requires operator resolution: the candidate ships a credential' },
  { gate: 'merge', id: 'lead-hold', match: /^Slice lead .+ ruled .+ under rule .+; delivery is blocked until the authorized recovery: /, kinds: ['escalate'],
    example: 'Slice lead lead-a ruled send-back under rule R-1; delivery is blocked until the authorized recovery: the slice is frozen for the release' },
  { gate: 'merge', id: 'conversation-protection', match: /^Branch protection still requires conversation resolution, which Graphyard's review gate does not use: /, kinds: ['escalate'],
    example: "Branch protection still requires conversation resolution, which Graphyard's review gate does not use: GitHub refuses the merge of 0123456789ab while 1 thread stays open (chatgpt-codex-connector on docs/a.md:1). graphyard master protection --apply removes the requirement; the reviewer's approval of the head is the review gate" },
];

/** The shape that claims a refusal of this gate, most specific first; null when none does. */
export function refusalShape(gate: string, refusal: string): RefusalShape | null {
  return gateRefusalCatalogue.find(shape => shape.gate === gate && shape.match.test(refusal)) ?? null;
}
