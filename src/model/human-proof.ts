// Concern: GY-2986 — real-world checks a person must make. A criterion may name a `human:NAME` proof
// when its text says what physical thing is checked: a phone call, a printed page, a card in a
// terminal. No session can run that and a master attestation proves nothing about a device, so when
// the head is otherwise ready the loop records one request on Needs you with the steps, the exact
// commit and the preview URL. The person's pass or fail with a note is a trusted run bound to that
// commit: a pass lets the item merge, a fail returns it to rework, and a new head asks again. It is
// not a way to ask people questions, and never stands in for the three human-only decisions.
import { currentEvidence } from './evidence.js';
import { evidenceProves } from './mechanical-proofs.js';
import { parkedOnHuman, type HumanRequestRow } from './human-request.js';
import type { Work } from './work.js';

/** The physical things a person checks: what the text of a criterion with a `human:` proof must name. */
const physical = /\b(phones?|calls?|printed|printers?|prints?|paper|cards?|terminals?|devices?|hardware|receipts?|cameras?|scanners?|sms|qr|badges?|cables?|batter(?:y|ies)|bluetooth|nfc|sensors?|labels?|stickers?|envelopes?|letters?|parcels?|physical(?:ly)?|in person)\b/i;

/** Why create or a revision refuses these criteria, or null: a `human:` proof whose criterion names nothing physical is a question, not a check. */
export function physicalCheckRefusal(criteria: readonly { id: string; text: string; proofs: readonly string[] }[]): string | null {
  const vague = criteria.find(criterion => criterion.proofs.some(proof => proof.startsWith('human:')) && !physical.test(criterion.text));
  return vague ? `${vague.id} names a human: proof but nothing physical to check: say what a person checks with a real device (a phone call, a printed page, a card in a terminal), or prove it another way` : null;
}

/** One request: what the person checks and the exact commit, with their answer once given. */
export interface HumanProofRequest {
  id: string; proof: string; criterion: string;
  sha: string; baseSha: string; policyRevision: number;
  ask: string; steps: string[];
  at: string; requestedBy: string;
  answer: { by: string; at: string; outcome: 'pass' | 'fail'; note: string; photo: string | null } | null;
}

declare module './work.js' {
  interface Work {
    /** GY-2986: every real-world check asked on this item, newest last. */
    humanProofs?: HumanProofRequest[];
  }
}

const short = (sha: string) => sha.slice(0, 12);
export const humanProofsOf = (work: Pick<Work, 'criteria'>) => [...new Set(work.criteria.filter(criterion => !criterion.bootstrap).flatMap(criterion => criterion.proofs.filter(proof => proof.startsWith('human:'))))];

/** The one request per proof, commit and policy: a new head or a revised requirement asks again. */
export const requestFor = (work: Pick<Work, 'humanProofs' | 'policyRevision'>, proof: string, sha: string) =>
  (work.humanProofs ?? []).find(request => request.proof === proof && request.sha === sha && request.policyRevision === work.policyRevision) ?? null;

const waitingReason = /^human:\S+ waits for a person/;
/** Whether a review gate refusal is a wait on a person's check, which the loop asks for rather than a review. */
export const humanProofWaiting = (reason: string) => waitingReason.test(reason);

/** What the review gate refuses a head for: each `human:` proof no person has passed on this commit, with the note of one that failed. */
export function humanProofHolds(work: Work, now: Date): string[] {
  const candidate = work.candidate;
  if (!candidate || work.observation?.candidate.sha !== candidate.sha) return [];
  return humanProofsOf(work).flatMap(proof => {
    const evidence = currentEvidence(work, proof, now);
    if (evidence && evidenceProves(proof, evidence)) return [];
    const answer = requestFor(work, proof, candidate.sha)?.answer;
    return [answer?.outcome === 'fail' ? `${proof} failed a person's check on ${short(candidate.sha)}: ${answer.note}` : `${proof} waits for a person's pass on Needs you for commit ${short(candidate.sha)}`];
  });
}

/** The checks the loop asks for now: the head is otherwise ready, so the review gate refuses only these waits, and none is asked yet. */
export function dueHumanProofs(work: Work): string[] {
  const candidate = work.candidate, review = work.gates.find(gate => gate.name === 'review');
  if (!candidate || work.stage === 'done' || !work.submission || work.reworkRequested || work.observation?.merged || parkedOnHuman(work)) return [];
  if (!work.gates.find(gate => gate.name === 'build')?.passed || !review || review.passed || !review.reasons.every(humanProofWaiting)) return [];
  return humanProofsOf(work).filter(proof => !requestFor(work, proof, candidate.sha) && review.reasons.some(reason => reason.startsWith(`${proof} `)));
}

/** The answered fail standing against the current head, which returns the item to its worker with the person's note. */
export function failedHumanProof(work: Pick<Work, 'humanProofs' | 'candidate' | 'policyRevision'>): HumanProofRequest | null {
  return (work.humanProofs ?? []).find(request => request.answer?.outcome === 'fail' && request.sha === work.candidate?.sha && request.policyRevision === work.policyRevision) ?? null;
}

/** Whether a person can still answer: unanswered, under the current policy, naming the head the item carries. */
export const answerableHumanProof = (work: Pick<Work, 'candidate' | 'policyRevision' | 'reworkRequested'>, request: HumanProofRequest) =>
  !request.answer && !work.reworkRequested && request.policyRevision === work.policyRevision && (!work.candidate || work.candidate.sha === request.sha);

/** The Needs you rows of one item's open checks. */
export function humanProofRows(work: Work, refusal: string, now: number): HumanRequestRow[] {
  return (work.humanProofs ?? []).filter(request => answerableHumanProof(work, request)).map(request => {
    const choice = (label: string, outcome: 'pass' | 'fail') => ({ label, input: 'text' as const, declines: false, body: { request: request.id, outcome }, note: 'note' });
    return {
      rule: 'human-proof', work: work.key, id: work.id, title: work.title,
      request: { id: request.id, kind: 'human-proof', epoch: work.epoch, at: request.at, requestedBy: request.requestedBy, ask: request.ask, steps: request.steps,
        needed: `${request.proof} on commit ${request.sha}`, reason: `${request.criterion} of ${work.key} names a check only a person can make`,
        why: 'Your answer is the proof for this exact commit: a pass lets it merge, a fail sends it back to its worker with your note.' },
      waitedMs: Math.max(0, now - Date.parse(request.at)), decision: 'a real-world check', refusal,
      choices: [choice('Pass, with this note…', 'pass'), choice('Fail, with this note…', 'fail')],
      answer: { cli: `POST /api/work/${work.key}/human-proof {"request":"${request.id}","outcome":"pass","note":"…"}`, decline: `POST /api/work/${work.key}/human-proof {"request":"${request.id}","outcome":"fail","note":"…"}`, dashboard: 'Work → Needs you', api: `POST /api/work/${work.key}/human-proof`,
        post: { command: 'human-proof', body: { request: request.id }, field: 'note', submit: 'Record the answer', decline: null } },
    };
  });
}
