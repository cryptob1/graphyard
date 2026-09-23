import { z } from 'zod';
import { proofSchema } from './proof.js';
import { decideScopeRequest } from './scope.js';
import type { Work } from './work.js';

// ---------------------------------------------------------------------------
// Closed-question criteria (GY-109).
//
// Some criteria are mechanical: "does the diff add the CLI flag the criterion names", "does the
// guide state the timeout the code uses". Judging one used to mean launching a producer session
// that spent forty minutes reading the repository to answer a yes-or-no question. A criterion may
// instead declare that its proof is answerable as a closed question: the question, the closed set
// of answers offered, which answer means the proof passes, and the state it is asked against.
// Graphyard binds that state to the exact candidate, hashes it, asks the configured responder,
// and records the answer — with its probability and the threshold applied — as evidence any
// reader can re-run and disagree with.
//
// An answer is evidence and nothing more. It never satisfies a two-party decision, never stands
// in for one of the three human-only decisions, and never approves a scope widening the criteria
// do not name (see `closedQuestionRefusal`). An answer below the threshold is never a verdict: it
// is recorded as untrusted, naming its probability, and the proof escalates to the path it would
// otherwise have used.
// ---------------------------------------------------------------------------

/**
 * What the question is asked against. `file` is a path in the candidate's own tree, `changed-files`
 * the list of paths the candidate changes, `criterion` the criterion text itself. The last two are
 * text an untrusted party may author — a pull request's body and its conversation — and the
 * responder configuration excludes them unless an operator deliberately admits them (see
 * `untrustedSourceKinds` and docs/onboarding.md).
 */
export const stateSourceKinds = ['file', 'changed-files', 'criterion', 'pull-request-body', 'comments'] as const;
export type StateSourceKind = typeof stateSourceKinds[number];
/** Sources whose text anyone who can open or comment on a pull request writes: excluded by default. */
export const untrustedSourceKinds: readonly StateSourceKind[] = ['pull-request-body', 'comments'];
const repositoryPath = z.string().min(1).max(500).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/, 'A state path is repository-relative and never climbs out of it');
export const stateSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: repositoryPath }).strict(),
  z.object({ kind: z.literal('changed-files') }).strict(),
  z.object({ kind: z.literal('criterion') }).strict(),
  z.object({ kind: z.literal('pull-request-body') }).strict(),
  z.object({ kind: z.literal('comments') }).strict(),
]);
export type StateSource = z.infer<typeof stateSourceSchema>;

/** The default confidence an answer must reach before it is a verdict. */
export const defaultClosedQuestionThreshold = 0.9;
const probability = z.number().min(0).max(1);
export const closedQuestionSchema = z.object({
  /** The criterion whose proof this answers, and the proof. */
  criterion: z.string().regex(/^AC-\d+$/),
  proof: proofSchema,
  question: z.string().trim().min(1).max(2000),
  /** The closed set of answers offered to the responder; nothing outside it is an answer. */
  criteria: z.array(z.string().trim().min(1).max(200)).min(2).max(10).refine(options => new Set(options).size === options.length, 'The answers offered must be distinct'),
  /** The offered answer that means the proof passes; every other answer is a failure. */
  pass: z.string().trim().min(1).max(200),
  state: z.array(stateSourceSchema).min(1).max(20),
  /** Overrides the responder's configured threshold for this question; never below it. */
  threshold: probability.optional(),
}).strict().refine(question => question.criteria.includes(question.pass), 'The passing answer must be one of the answers offered');
export type ClosedQuestion = z.infer<typeof closedQuestionSchema>;
export const closedQuestionsSchema = z.array(closedQuestionSchema).max(50)
  .refine(questions => new Set(questions.map(question => question.proof)).size === questions.length, 'One closed question per proof');

/** The candidate a judgement binds, exactly as evidence binds it. */
export const closedQuestionRequestSchema = z.object({
  proof: proofSchema,
  sha: z.string().regex(/^[a-f0-9]{40}$/), baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  policyRevision: z.number().int().positive(),
}).strict();

/** One hashed part of the bound state; the hash covers the text the responder was given. */
export interface StatePart { kind: StateSourceKind; path?: string; sha256: string; bytes: number }
/** The record an answer leaves on its evidence: everything a reader needs to re-run it and disagree. */
export interface ClosedQuestionRecord {
  criterion: string; question: string; criteria: string[]; pass: string;
  /** sha256 over the canonical state the responder was given, and each part of it. */
  stateHash: string; state: StatePart[];
  responder: { id: string; version: string };
  answer: string; probability: number; threshold: number;
  /** `decided`: the answer is the verdict. `escalated`: it was not confident enough to be one. */
  verdict: 'decided' | 'escalated';
  /** Where the proof went instead, and why — the probability that prompted it, in words. */
  escalation?: { path: EscalationPath; reason: string };
}
export type EscalationPath = 'producer-session' | 'attestation-decision';

/** The declaration a proof carries on this item, if any. */
export const closedQuestionFor = (work: Pick<Work, 'closedQuestions'>, proof: string) => (work.closedQuestions ?? []).find(question => question.proof === proof);
/**
 * A manual proof no producer may run is established only by an approved `attest` decision — a
 * requester and a second, independent approver. That is a two-party decision, which an answer
 * never satisfies, so such a proof is never judged by one.
 */
export const reservedForAttestation = (work: Pick<Work, 'producerProofs'>, proof: string) => proof.startsWith('manual:') && !(work.producerProofs ?? []).includes(proof);
/** The path a proof takes when no answer decides it. */
export const escalationPath = (work: Pick<Work, 'producerProofs'>, proof: string): EscalationPath => reservedForAttestation(work, proof) ? 'attestation-decision' : 'producer-session';

/**
 * Why an answer may not be used on this item right now, or null. An answer is evidence for one
 * proof; each refusal names the authority it would otherwise be standing in for.
 */
export function closedQuestionRefusal(work: Work, proof: string): string | null {
  const declared = closedQuestionFor(work, proof);
  if (!declared) return `${work.key} declares no closed question for ${proof}; it is proven by its ordinary path`;
  if (!work.criteria.some(criterion => criterion.id === declared.criterion && criterion.proofs.includes(proof))) return `${declared.criterion} of ${work.key} does not require ${proof}`;
  if (reservedForAttestation(work, proof))
    return `${proof} is established only by an approved attest decision — a two-party decision an answer never satisfies; request it with graphyard master decide ${work.key} attest`;
  if (work.humanRequest && !work.humanRequest.answer)
    return `${work.key} waits on a human-only decision (${work.humanRequest.kind}); an answer never stands in for one, and only the human's answer resumes the item`;
  const scope = work.scopeRequest;
  if (scope) {
    const verdict = decideScopeRequest(work, scope);
    if (verdict.state === 'refused')
      return `${work.key} has an open scope request its criteria do not name (${verdict.reason}); an answer never approves a scope widening — an operator decides it`;
  }
  return null;
}

/** The threshold applied: the question's own, never below the responder's configured floor. */
export const appliedThreshold = (question: Pick<ClosedQuestion, 'threshold'>, configured: number) => Math.max(configured, question.threshold ?? configured);

/**
 * The verdict an answer carries. At or above the threshold it decides the proof; below it the
 * answer is kept, untrusted, as what prompted the escalation to the proof's ordinary path.
 */
export function judgeAnswer(work: Pick<Work, 'producerProofs'>, question: ClosedQuestion, answer: { answer: string; probability: number }, threshold: number) {
  const confident = answer.probability >= threshold;
  const result: 'pass' | 'fail' = answer.answer === question.pass ? 'pass' : 'fail';
  if (confident) return { trusted: true, result, verdict: 'decided' as const, escalation: undefined };
  const path = escalationPath(work, question.proof);
  return {
    trusted: false, result: 'fail' as const, verdict: 'escalated' as const,
    escalation: { path, reason: `The responder answered "${answer.answer}" with probability ${answer.probability} (below the threshold ${threshold}); an answer this unsure is not a verdict, so ${question.proof} escalates to its ${path === 'producer-session' ? 'producer session' : 'attest decision'}` },
  };
}

// ---------------------------------------------------------------------------
// The accuracy study (AC-4): the same criteria judged both ways over past candidates whose real
// outcome is known. Adoption follows from this repository's own numbers, never a vendor's.
// ---------------------------------------------------------------------------

export interface StudyCase {
  /** Item and head the case was judged on, for the report. */
  key: string; sha: string; proof: string;
  /** What really happened: the outcome the delivered history settled on. */
  known: 'pass' | 'fail';
  /** What the producer session concluded on that head, when one ran. */
  session?: 'pass' | 'fail' | null;
  /** The responder's answer, mapped through the question's passing answer, and its probability. */
  answer: 'pass' | 'fail'; probability: number;
}
export interface StudyReport {
  cases: number; threshold: number;
  /** Confident answers only: those that would have been verdicts. */
  confident: number; agreement: number; disagreement: number; escalated: number;
  /** Every case where the fast answer was confident and wrong, in full. */
  confidentWrong: StudyCase[];
  /** Sessions judged on the same cases, for the comparison the adoption rests on. */
  session: { judged: number; agreement: number };
  recommendation: 'adopt' | 'refuse'; reason: string;
}
export const studyMinimumCases = 20;

/**
 * Adoption is recommended only when at least twenty past candidates were judged, no confident
 * answer was wrong more often than `maxConfidentWrong` allows (none, by default), and confident
 * answers agreed with the known outcome at least as often as the sessions they replace did.
 */
export function accuracyStudy(cases: readonly StudyCase[], threshold: number, options: { maxConfidentWrong?: number } = {}): StudyReport {
  const confident = cases.filter(entry => entry.probability >= threshold);
  const agreeing = confident.filter(entry => entry.answer === entry.known);
  const confidentWrong = confident.filter(entry => entry.answer !== entry.known);
  const sessions = cases.filter(entry => entry.session === 'pass' || entry.session === 'fail');
  const sessionAgreement = sessions.filter(entry => entry.session === entry.known).length;
  const rate = (hits: number, total: number) => total ? hits / total : 0;
  const allowed = options.maxConfidentWrong ?? 0;
  const refusals = [
    ...(cases.length < studyMinimumCases ? [`only ${cases.length} past candidates were judged; the study needs at least ${studyMinimumCases}`] : []),
    ...(confidentWrong.length > allowed ? [`${confidentWrong.length} confident answer(s) were wrong (${confidentWrong.map(entry => `${entry.key} ${entry.proof} at ${entry.sha.slice(0, 12)}`).join('; ')}); at most ${allowed} is acceptable`] : []),
    ...(sessions.length && rate(agreeing.length, confident.length) < rate(sessionAgreement, sessions.length) ? [`confident answers agreed with the known outcome ${agreeing.length}/${confident.length} times, below the sessions' ${sessionAgreement}/${sessions.length}`] : []),
    ...(!confident.length ? ['no answer reached the threshold, so nothing would have been decided faster'] : []),
  ];
  return {
    cases: cases.length, threshold, confident: confident.length, agreement: agreeing.length, disagreement: confidentWrong.length,
    escalated: cases.length - confident.length, confidentWrong: [...confidentWrong],
    session: { judged: sessions.length, agreement: sessionAgreement },
    recommendation: refusals.length ? 'refuse' : 'adopt',
    reason: refusals.length ? refusals.join('; ') : `${agreeing.length}/${confident.length} confident answers agreed with the known outcome over ${cases.length} past candidates, none confidently wrong beyond ${allowed}, against the sessions' ${sessionAgreement}/${sessions.length}`,
  };
}
