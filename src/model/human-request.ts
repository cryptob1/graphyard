import { z } from 'zod';
import { operatorCredentialRefusal, operatorOnlyDecision, refusedReconciliations } from './operator-decision.js'; // not approval.ts's re-export: approval → park-withdrawal → here would read it uninitialized (GY-1815)
import { hostDoableAsk, hostDoableRefusal, parkRefusal as classifiedParkRefusal, type HostDoableAsk } from './park-refusal.js';
import { shortAskIssues } from './human-ask.js';
import type { HumanAnswer } from './human-answer.js';
import type { Work } from './work.js';

// ------------------------------------------------------------
// Decisions only a human may make, as typed state (GY-89).
//
// Agents decide everything except three things: goals and priorities, spending money or opening
// third-party accounts, and issuing credentials to people. Reaching one records a typed request —
// which of the three, why, and the exact thing needed — and that one transaction ends the
// attempt's lease and parks the item: the request is listed for the human with how long it has
// waited and how to answer it, and the answer returns the item to the loop, which dispatches it.
// ------------------------------------------------------------

export const humanDecisionKinds = ['goals-and-priorities', 'money-or-accounts', 'credentials-for-people'] as const;
export type HumanDecisionKind = typeof humanDecisionKinds[number];
/** Each kind is one of the three decisions the operator keeps (master.ts `humanOnlyDecisions`), in the same words. */
export const humanDecisionLabel = {
  'goals-and-priorities': 'goals and priorities',
  'money-or-accounts': 'spending money or opening third-party accounts',
  'credentials-for-people': 'issuing credentials to people',
} as const satisfies Record<HumanDecisionKind, string>;

/**
 * One ready-made answer the requester offers (GY-738): a button on the card. `text` asks for the
 * operator's own words beside it (a different cap); `secret` asks for a value that is sealed to
 * the requesting host's key and never recorded in the clear.
 */
export const humanChoiceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  label: z.string().trim().min(1).max(120),
  outcome: z.enum(['provided', 'declined']),
  input: z.enum(['none', 'text', 'secret']).default('none'),
}).strict();
export type HumanChoice = z.infer<typeof humanChoiceSchema>;
const decline: HumanChoice = { id: 'decline', label: 'Decline', outcome: 'declined', input: 'none' };
/** The choices a request offers when its requester named none: one per kind, always ending with Decline. */
export function defaultChoices(kind: HumanDecisionKind, sealed = false): HumanChoice[] {
  // An account or spend is approved or set up in words (GY-1395): a bare Approve resumed GY-1384 with nothing
  // provided, and the resumed worker could only ask again.
  if (kind === 'money-or-accounts') return [{ id: 'approve', label: 'Approve, saying what you approved or set up…', outcome: 'provided', input: 'text' }, { id: 'approve-other', label: 'Approve with a different cap…', outcome: 'provided', input: 'text' }, decline];
  if (kind === 'credentials-for-people') return [sealed ? { id: 'provide', label: 'Provide now', outcome: 'provided', input: 'secret' } : { id: 'provided', label: 'Provided it', outcome: 'provided', input: 'text' }, decline];
  return [{ id: 'agree', label: 'Go ahead as asked', outcome: 'provided', input: 'none' }, { id: 'differently', label: 'Go ahead differently…', outcome: 'provided', input: 'text' }, decline];
}
/** The choices a request carries: the requester's, with Decline added when they left it out, or the kind's defaults. */
export function requestChoices(request: { kind: HumanDecisionKind; choices?: HumanChoice[] | null; sealTo?: string | null }): HumanChoice[] {
  const named = request.choices?.length ? request.choices : defaultChoices(request.kind, !!request.sealTo);
  return named.some(choice => choice.outcome === 'declined') ? named : [...named, decline];
}

export const humanRequestSchema = z.object({
  epoch: z.number().int().positive(),
  kind: z.enum(humanDecisionKinds),
  /** Why the item cannot continue without the decision. */
  reason: z.string().trim().min(1).max(2000),
  /** The exact thing the human is asked for: the account to open, the priority to set, the credential to issue. */
  needed: z.string().trim().min(1).max(2000),
  /** The short note the human reads (GY-1408): one sentence naming their action, a few plain steps, one plain why. NEEDED and REASON are the agents' detail. */
  ask: z.string().trim().min(1).optional(),
  steps: z.array(z.string().trim().min(1)).min(1).optional(), why: z.string().trim().min(1).optional(),
  /** What the requester recommends (GY-1410), shown first: a choice it offers, or the safest way to get a value. `recommendationIssues` requires it and WHY. */
  recommendation: z.string().trim().min(1).max(600).optional(),
  /** The buttons the card offers, chosen by the requester; the kind's defaults when omitted. */
  choices: z.array(humanChoiceSchema).min(1).max(6).refine(choices => new Set(choices.map(choice => choice.id)).size === choices.length, 'Choice ids must be distinct').optional(),
  /** The requesting host's public key (PEM): a `secret` choice's value is sealed to it. */
  sealTo: z.string().trim().min(1).max(4000).optional(),
}).strict().refine(data => data.sealTo || !data.choices?.some(choice => choice.input === 'secret'), 'A secret choice needs sealTo, the requesting host\'s public key')
  .superRefine((data, context) => { for (const message of shortAskIssues(data)) context.addIssue({ code: 'custom', message }); });
/** What a request's recommendation misses (GY-1410), naming the field; empty when it has one: the choice recommended or the safest way to obtain a value, plus WHY. A request with choices names one by its label; a value request may advise freely. */
export function recommendationIssues(data: { kind?: HumanDecisionKind; choices?: HumanChoice[] | null; sealTo?: string | null; recommendation?: string; why?: string }): string[] {
  const choices = data.kind ? requestChoices({ kind: data.kind, choices: data.choices, sealTo: data.sealTo }) : [];
  const valueRequest = choices.some(choice => choice.input === 'secret') || choices.every(choice => choice.outcome === 'declined' || choice.input !== 'none');
  const unnamed = data.kind && data.recommendation?.trim() && !valueRequest && !recommendedChoice({ ...data, kind: data.kind });
  return [
    ...(data.recommendation?.trim() ? [] : ['A park needs RECOMMEND (field recommendation): the choice you recommend, or the safest way to obtain the value asked for']),
    ...(unnamed ? [`A park with choices needs RECOMMEND (field recommendation) to name one by its label: ${choices.map(choice => `"${choice.label}"`).join(', ')}`] : []),
    ...(data.why?.trim() ? [] : ['A park needs WHY (field why): one plain sentence of why you recommend it']),
  ];
}
/** The id of the choice a request's recommendation names, by label or id, or null when it names none. */
export function recommendedChoice(request: { kind: HumanDecisionKind; choices?: HumanChoice[] | null; sealTo?: string | null; recommendation?: string | null }): string | null {
  const key = (words: string) => words.trim().replace(/[….:]+$/, '').toLowerCase();
  const advice = request.recommendation ? key(request.recommendation) : null;
  return advice ? requestChoices(request).find(choice => key(choice.id) === advice || key(choice.label) === advice)?.id ?? null : null;
}
// The park-refusal classifier (GY-1395, GY-1416, GY-1692) lives in park-refusal.ts; `parkRefusal` here refuses a criterion-rewrite question first (GY-1816).
export { hostDoableAsk, hostDoableRefusal, type HostDoableAsk };

/** GY-1818: per sentence, any order — is a requirements object named, and does a change operation target it. */
const criterionId = /\bAC-\d+\b/i, criterionName = /\b(?:acceptance\s+)?criteri(?:a|on)\b|\brequirements?\b/i, itemKey = /\bGY-\d+\b/i, testsReference = /\btests?\/\S*|\b(?:tests?|assertions?|suites?)\b/i,
  requirementsObject = (sentence: string) => criterionId.test(sentence) || criterionName.test(sentence) || (itemKey.test(sentence) && testsReference.test(sentence)),
  /** GY-1819: the bare noun alone — no criterion id, criteria word or key with tests — names the rewrite as work, not the requirements: its change-noun never asks while the change word keeps a predicate of its own; ordering that work is goals and priorities. */
  bareNounOnly = (sentence: string) => !criterionId.test(sentence) && !/\b(?:acceptance\s+)?criteri(?:a|on)\b/i.test(sentence) && !(itemKey.test(sentence) && testsReference.test(sentence));
const changeStems = String.raw`rewrit|revis|revers|updat|amend|chang|edit|delet|remov|reconcil|match|align|weaken|relax|soften|narrow|merg|replac|drop`, keyStems = 'match|align|reconcil|revers|revert',
  changeNoun = /\b(?:AC-\d+|criteri(?:a|on)|requirements?)(?:'s)?\s+(?:rewrit\w*|revis\w*|updat\w*|amend\w*|chang\w*|edit\w*|delet\w*|remov\w*|reconcil\w*|align\w*|weaken\w*|relax\w*|narrow\w*|revers\w*|merg\w*|replac\w*|drops?)\b/i,
  /** GY-1819 review: the change word is the work's noun only while a predicate of its own follows ("the requirements rewrite lands", "succeeded", "should it succeed?"), whatever that verb; clause end, or an object's opening word — determiner, pronoun, quantifier, number, preposition, conjunction, "to", "so", "as" or a named object — leaves it the verb ("the requirements change", "drop this clause"), which objectThenVerb refuses. */
  objectOpening = String.raw`(?:the|a|an|this|that|these|those|its|his|her|hers|their|theirs|our|ours|your|yours|my|mine|it|them|us|him|me|you|we|they|he|she|i|one|all|every|each|any|some|both|either|neither|no|none|more|most|less|least|several|many|much|few|other|another|such|what|which|who|whom|whose|\d\w*|to|so|as|than|and|or|but|nor|yet|because|when|whenever|where|while|whilst|if|unless|although|though|since|for|with|without|in|into|onto|on|at|by|from|of|off|over|under|up|down|out|about|across|through|via|per|toward|towards|against|around|between|among|within|beyond|along|like|AC-\d+|GY-\d+|tests?\/\S*|(?:acceptance\s+)?criteri(?:a|on)|requirements?)`,
  ownPredicate = String.raw`(?=\s+(?:\w+ly\s+)*(?!${objectOpening}(?![\w/-])|\w+ly\b)[a-z]\w*)`;
/** Verb and object in one clause, either order, across only determiners, auxiliaries, -ly words or a scoping qualifier, never "to"; another noun's change counts nowhere; a key only of alignment or reversal, never "drop GY-1700"; an aligned tests/ path counts beside a key. */
const auxiliaries = String.raw`(?:should|shall|may|might|must|can|could|would|will|needs?|needed|is|are|was|were|be|been|being|gets?|got|has|have|had|to|not|never|no longer|also|still|instead|now|again|once)`,
  verbThenObject = new RegExp(String.raw`\b(?:${changeStems})\w*(?:(?:\s+|,\s*)(?:the|a|an|its|their|our|your|this|that|these|those|another|each|acceptance|\w+ly))*(?:\s+|,\s*)(?:acceptance\s+)?(?:AC-\d+|criteri(?:a|on)|requirements?)(?:'s)?\b|\b(?:${keyStems})\w*(?:\s+(?:the|\w+ly))*\s+GY-\d+`, 'gi');
const qualifier = String.raw`(?:\s+(?:for|in|of|on|under|about|within|at)(?:\s+[\w'-]+){1,4}?(?=(?:\s+|,\s*)${auxiliaries}\b))?`,
  objectThenVerb = new RegExp(String.raw`\b(?:AC-\d+|criteri(?:a|on)|requirements?)(?:'s)?${qualifier}(?:(?:\s+|,\s*)${auxiliaries}\b|\s+\w+ly)*(?:\s+|,\s*)(?:${changeStems})\w*`, 'gi'),
  keyThenVerb = new RegExp(String.raw`\bGY-\d+(?:'s)?(?:(?:\s+|,\s*)${auxiliaries}\b|\s+\w+ly)*(?:\s+|,\s*)(?:is|are|was|were|be|been|being|gets?|got)\b(?:(?:\s+|,\s*)${auxiliaries}\b|\s+\w+ly)*(?:\s+|,\s*)(?:${keyStems})\w*`, 'gi'),
  pathAligned = new RegExp(String.raw`\b(?:match|align|reconcil)\w*(?:(?:\s+|,\s*)(?:the|a|an|its|their|our|your|this|that|these|those|each|\w+ly))*(?:\s+|,\s*)tests?\/\S+|\btests?\/\S+(?:(?:\s+|,\s*)${auxiliaries}\b|\s+\w+ly)*(?:\s+|,\s*)(?:match|align|reconcil)\w*`, 'gi');
/** "the tests that match GY-1700" names tests, aligns nothing. A change-noun is scheduled only when its own predicate is tied to an ordering relation; a bare "lands", a need ("is needed before") or "first or the docs land" schedules nothing. */
const namedNotAligned = /\b(?:match|align|reconcil)\w*(?:ing|ed)(?=\s+(?:tests?|assertions?|suites?)\b(?!\/))|(?<=\b(?:tests?|assertions?|suites?)\s+(?:that|which)\s+)(?:match|align|reconcil)\w*(?:\s+GY-\d+(?:'s)?)?/gi,
  scheduledChange = new RegExp(String.raw`${changeNoun.source}(?:\s+(?:should|shall|may|might|must|can|could|would|will|is|are|was|were|be|been|being|gets?|got|has|have|had|also|still|now|\w+ly))*\s+(?:(?:preced|follow)\w*\s+\w|(?!(?:to|needs?|needed|requires?|required|necessary|wanted)\b)\w+(?:\s+\w+ly)?\s+(?:before|after|until|till|first|then|next|last|later|earlier|sooner|above|below|behind|ahead\s+of)\b(?!,?\s+(?:or|and)\s+(?:the|a|an|its|this|that|these|those)\b))`, 'gi');
/** A negated change asks only in a question, from the last clause break and never past an although, though or but boundary (GY-1819). A sentence asks when it targets a named requirements object or names unscheduled change work. */
const question = (sentence: string) => /\?|\b(?:whether|if)\b/i.test(sentence) || /^(?:should|shall|may|might|must|can|could|would|will|do|does|did|is|are|was|were|has|have)\b/i.test(sentence.trim()),
  verbChain = (text: string, end: number) => { const before = text.slice(0, end), lower = before.toLowerCase(); return before.slice(1 + Math.max(...[',', ';', ' but ', ' although ', ' though ', ' so ', ' and ', ' or '].map(boundary => lower.lastIndexOf(boundary)))); };
const requirementsQuestion = (text: string) => (text.match(/(?:[^.;\n?]|\.(?=\S))+\??/g) ?? []).some(sentence => {
  const asked = sentence.replace(new RegExp(changeNoun.source + ownPredicate, 'gi'), 'work').replace(namedNotAligned, '');
  const targeted = [...asked.matchAll(verbThenObject), ...asked.matchAll(objectThenVerb), ...asked.matchAll(keyThenVerb), ...asked.matchAll(pathAligned)].some(found => !/\b(?:not|never|no longer)\b/i.test(`${found[0]} ${verbChain(asked, found.index!)}`) || question(sentence));
  return requirementsObject(sentence) && (targeted || !bareNounOnly(sentence) && changeNoun.test(sentence.replace(scheduledChange, 'work'))); });
/** A park's own words: the kind it claims, and every text the human would read. */
export interface ParkQuestion { kind?: string; needed: string; ask?: string | null; reason?: string | null }
/** Why a goals-and-priorities park asks a criterion rewrite (GY-1816, structural since GY-1818; the bare noun alone names work, not the requirements — GY-1819) — or null: the master requests rewrites, an approver approves. */
export function requirementsQuestionRefusal(data: ParkQuestion): string | null {
  if (data.kind !== 'goals-and-priorities') return null;
  const questioned = [data.ask, data.needed, data.reason].some(text => !!text?.trim() && requirementsQuestion(text));
  return questioned ? 'Not a human-only decision: the request asks whether this item\'s criteria are rewritten, revised or matched to another item\'s tests — a requirements decision, never the human\'s. Agent route: record the conflict with `graphyard blocked GY-N EPOCH REASON`, so the master requests the requirements decision (`graphyard master decide GY-N requirements …`) for an independent approver to approve; the item never parks.' : null;
}
/** The park refusals in the order they fire: a criterion-rewrite question first (GY-1816), then the classifier's own (GY-1395, GY-1416, GY-1692). */
export const parkRefusal = (data: ParkQuestion): string | null => requirementsQuestionRefusal(data) ?? classifiedParkRefusal(data);

/** The fields every request only a human may answer carries, whatever raised it: the exact thing
 * needed, why, who asked, and when. A park request and an approval the server takes only from the
 * operator's own credential share them, so the list, page and CLI read one shape (GY-102).
 */
export interface HumanOnlyRequest {
  id: string; kind: string; reason: string; needed: string;
  requestedBy: string; epoch: number; at: string;
  /** The short note the card leads with (GY-1408); absent on older requests, which lead with `needed`'s first sentence (`humanAsk`). */
  ask?: string | null; steps?: string[] | null; why?: string | null;
  /** What the requester recommends (GY-1410), shown first with `why`; absent only on requests recorded before it was required. */
  recommendation?: string | null;
}
export interface HumanRequest extends HumanOnlyRequest {
  kind: HumanDecisionKind;
  choices?: HumanChoice[];
  sealTo?: string | null;
  answer?: HumanAnswer | null;
}
export const retainedHumanRequests = 20;

/** The blocker a parked item carries, and the prefix the answer clears it by. */
export const humanRequestBlocker = 'Waiting on a human-only decision';
/** How dispatch's refusal of an item parked on a human opens (assertDispatchable): a designed wait whose text names the answer that resumes it. */
export const dispatchHumanWait = 'Dispatch waits on a human-only decision';
export const describeHumanRequest = (request: Pick<HumanRequest, 'kind' | 'needed'>) => `${humanRequestBlocker} (${humanDecisionLabel[request.kind]}): ${request.needed}`;
export const parkedOnHuman = (work: { humanRequest?: HumanRequest | null }) => !!work.humanRequest && !work.humanRequest.answer;

/** How to answer, exactly as the list and `master status` print it. */
export const answerCommand = (key: string, request: Pick<HumanRequest, 'id'>) => `graphyard answer ${key} ${request.id} ANSWER`;
export const declineCommand = (key: string, request: Pick<HumanRequest, 'id'>) => `graphyard answer ${key} ${request.id} --decline REASON`;

/** One button on a card (GY-738): the whole body it posts, whether it asks for words or a secret, and the field an optional note goes in (null when it takes none). */
export interface HumanOnlyChoice { label: string; input: HumanChoice['input']; declines: boolean; body: Record<string, unknown>; note: string | null; recommended?: boolean }
/** The choices with the recommended one first (GY-1410). */
export const recommendedFirst = (choices: readonly HumanOnlyChoice[]) => [...choices.filter(choice => choice.recommended), ...choices.filter(choice => !choice.recommended)];
/** How the operator answers one request from the page: the command posted to, the body's fixed fields, the field
 * their words go in, and a refusing answer. The command lines beside the form are equivalents, never the way to answer (GY-102). */
export interface HumanOnlyPost { command: string; body: Record<string, unknown>; field: string; submit: string; decline: { body: Record<string, unknown>; submit: string } | null }
export interface HumanRequestRow {
  /** The rule that raised it (`humanOnlyRules`); the page asks that rule whether this session may answer. */
  rule: string;
  work: string; id: string; title: string; request: HumanOnlyRequest;
  waitedMs: number; decision: string;
  /** What an agent identity is told when it attempts this, in the server's own words. */
  refusal: string;
  /** The ready-made answers, one button each, posted to `answer.post.command`: the primary way to answer. */
  choices?: HumanOnlyChoice[];
  answer: { cli: string; decline: string; dashboard: string; api: string; post: HumanOnlyPost };
}
/** A row as `master status` reports it: what is needed, why, who asked, how long, and where it is answered. */
export function humanOnlyStatusRow(row: HumanRequestRow) {
  return { work: row.work, rule: row.rule, decision: row.decision, needed: row.request.needed, reason: row.request.reason, recommendation: row.request.recommendation ?? null,
    requestedBy: row.request.requestedBy, requestedAt: row.request.at, waitedMs: row.waitedMs, answerOn: row.answer.dashboard, refusesAgents: row.refusal };
}
/** Every open human-only request, longest wait first: the human-facing list. */
export function openHumanRequests(work: readonly { id: string; key: string; title: string; stage: string; humanRequest?: HumanRequest | null }[], now: number): HumanRequestRow[] {
  return work.filter(item => item.stage !== 'done' && parkedOnHuman(item)).map(item => {
    const request = item.humanRequest!, recommended = recommendedChoice(request);
    return {
      rule: parkRule.kind, work: item.key, id: item.id, title: item.title, request,
      waitedMs: Math.max(0, now - Date.parse(request.at)), decision: humanDecisionLabel[request.kind],
      refusal: parkRule.refuse({ id: 'an agent identity', role: 'operator-agent', sessionKind: 'ai' })!,
      choices: recommendedFirst(requestChoices(request).map(choice => ({ label: choice.label, input: choice.input, declines: choice.outcome === 'declined', body: { request: request.id, choice: choice.id }, note: 'note', recommended: choice.id === recommended }))),
      answer: { cli: answerCommand(item.key, request), decline: declineCommand(item.key, request), dashboard: 'Work → Needs you → Answer', api: `POST /api/work/${item.key}/answer {"request":"${request.id}","answer":"…"}`,
        post: { command: 'answer', body: { request: request.id, outcome: 'provided' }, field: 'answer', submit: `Answer and resume ${item.key}`,
          decline: { body: { request: request.id, outcome: 'declined' }, submit: 'Decline' } } },
    };
  }).sort((a, b) => b.waitedMs - a.waitedMs);
}

// The human surface (GY-102). `park` is not the only thing the server takes from the operator's own credential: an
// approval no agent identity can complete is another. Every such action is a rule here — what the server refuses an agent
// identity, and how to find its open instances. The page, the CLI list and `GET /api/human-requests` render this table and
// nothing else, so a rule added here is listed for the human without a second change, and none is silently absent.

/** A session as a rule judges it: the identity, the role it holds, and the kind of session it declared. */
export interface HumanOnlyActor { id?: string; role?: string | null; sessionKind?: string | null }
/** Undeclared is reported as undeclared: an unlabelled session is never treated as human (delegation.ts `sessionKind`). */
const declaredKind = (actor: HumanOnlyActor) => actor.sessionKind ?? 'undeclared';

/** A decision as the surface reads it: the server folds extra terminal states onto the model's own. */
export type HumanOnlyDecision = Omit<import('./approval.js').Decision, 'state'> & { state: string };
/** One item as the rules read it: its document, and its two-party decisions when a rule needs them. */
export interface HumanOnlySubject {
  work: Work;
  /** Folded from the ledger by the caller; `reads` says which rules require it. */
  decisions?: readonly HumanOnlyDecision[];
}
export interface HumanOnlyRule {
  /** Stable name, carried on every row the rule raises. */
  kind: string;
  /** A cheap pre-filter: whether this item's decisions must be folded from the ledger before `open` can answer for it. */
  reads?(work: Work): boolean;
  /** Why this session may not answer one of these, or null when it may: the refusal the server raises. */
  refuse(actor: HumanOnlyActor): string | null;
  /** Every open instance of this rule on one item. */
  open(subject: HumanOnlySubject, now: number): HumanRequestRow[];
}

/**
 * A decision only a human may make, parked by the worker that reached it: the server refuses an
 * answer from anything but a declared human session (server/waits.ts `answerHumanDecision`). The
 * three decisions are human by definition; an agent holding an admin credential is still an agent.
 */
export const parkRule: HumanOnlyRule = {
  kind: 'human-request',
  refuse: actor => actor.role !== 'admin' ? 'Only the human operator answers a human-only request'
    : declaredKind(actor) !== 'human' ? `A human-only request needs a declared human session; ${actor.id} is ${declaredKind(actor)}` : null,
  open: (subject, now) => openHumanRequests([subject.work], now),
};

/** The fourth decision the operator keeps, beside the three of `humanDecisionLabel`. */
export const operatorApprovalLabel = 'authorizing what no agent identity may authorize';
/**
 * An approval the server takes from the operator's admin credential alone
 * (model/approval.ts `operatorOnlyDecision`): a requested merge decision overriding a
 * reconciliation the record refused. Every agent identity is refused it — the master's own pair
 * approving it would deliver nothing — so it waits here, with a parked request's fields.
 */
export const operatorApprovalRule: HumanOnlyRule = {
  kind: 'operator-approval',
  // Only an item with a refused reconciliation carries one: the ledger read is bounded to items that could answer it.
  reads: work => refusedReconciliations(work).length > 0,
  refuse: operatorCredentialRefusal,
  open(subject, now) {
    const work = subject.work;
    return (subject.decisions ?? []).filter(decision => decision.state === 'requested').flatMap(decision => {
      const operatorOnly = operatorOnlyDecision(decision, work);
      if (!operatorOnly) return [];
      // The requester asked for this decision, so approving it is what it recommends (GY-1410).
      const request: HumanOnlyRequest = { id: decision.id, kind: operatorApprovalRule.kind, needed: operatorOnly.needed, reason: decision.reason,
        requestedBy: decision.requestedBy, epoch: work.epoch, at: decision.requestedAt,
        recommendation: 'Approve', why: `${decision.requestedBy} asked for this decision, and only a human admin may approve it.` };
      return [{
        rule: operatorApprovalRule.kind, work: work.key, id: work.id, title: work.title, request,
        waitedMs: Math.max(0, now - Date.parse(decision.requestedAt)), decision: operatorApprovalLabel,
        refusal: operatorCredentialRefusal({ id: 'an agent identity', role: 'operator-agent' })!,
        // Declining is the operator's considered refusal on the same route (server/decision-refusal.ts), terminal with their reason, as on a park request.
        choices: [{ label: `Approve and deliver ${work.key}`, input: 'none', declines: false, body: { decision: decision.id, reason: 'Approved by the operator' }, note: 'reason', recommended: true },
          { label: 'Decline', input: 'none', declines: true, body: { action: 'refuse', decision: decision.id, reason: 'Declined by the operator' }, note: 'reason' }],
        answer: {
          cli: `GRAPHYARD_TOKEN_FILE=ADMIN_TOKEN_FILE graphyard master approve ${work.key} ${decision.id} REASON`,
          decline: `GRAPHYARD_TOKEN_FILE=ADMIN_TOKEN_FILE graphyard master refuse ${work.key} ${decision.id} REASON`,
          dashboard: 'Work → Needs you → Approve or Decline',
          api: `POST /api/work/${work.key}/approve {"decision":"${decision.id}","reason":"…"}`,
          post: { command: 'approve', body: { decision: decision.id }, field: 'reason', submit: `Approve and deliver ${work.key}`, decline: { body: { action: 'refuse', decision: decision.id }, submit: 'Decline' } },
        },
      }];
    });
  },
};

/**
 * Every rule, in the order the surface lists them. Enforcement reads this table and so does the
 * page: adding a rule here is the one change a new human-only action needs.
 */
export const humanOnlyRules: HumanOnlyRule[] = [parkRule, operatorApprovalRule];
export const humanOnlyRule = (kind: string, rules: readonly HumanOnlyRule[] = humanOnlyRules) => rules.find(rule => rule.kind === kind) ?? null;
/**
 * Why this session may not answer a row of that rule, or null when it may. A rule this reader
 * does not know refuses: a client older than the server that raised the row must not offer a
 * form for a refusal it cannot state.
 */
export function humanOnlyRefusal(kind: string, actor: HumanOnlyActor, rules: readonly HumanOnlyRule[] = humanOnlyRules): string | null {
  const rule = humanOnlyRule(kind, rules);
  return rule ? rule.refuse(actor) : `No ${kind} rule is known here; reload before answering it`;
}
/** Whether any rule needs this item's decisions read before the table can answer for it. */
export const humanOnlyReadsDecisions = (work: Work, rules: readonly HumanOnlyRule[] = humanOnlyRules) => rules.some(rule => rule.reads?.(work) === true);
/** Every open human-only action, longest wait first: the whole human-facing surface. */
export function openHumanOnly(subjects: readonly HumanOnlySubject[], now: number, rules: readonly HumanOnlyRule[] = humanOnlyRules): HumanRequestRow[] {
  return subjects.filter(subject => subject.work.stage !== 'done')
    .flatMap(subject => rules.flatMap(rule => rule.open(subject, now)))
    .sort((a, b) => b.waitedMs - a.waitedMs);
}
