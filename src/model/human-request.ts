import { z } from 'zod';
import { operatorCredentialRefusal, operatorOnlyDecision, refusedReconciliations, type Decision } from './approval.js';
import { shortAskIssues } from './human-ask.js';
import type { HumanAnswer } from './human-answer.js';
import type { Work } from './work.js';

// ---------------------------------------------------------------------------
// Decisions only a human may make, as typed state (GY-89).
//
// Agents decide everything except three things: goals and priorities, spending money or opening
// third-party accounts, and issuing credentials to people. An attempt that reaches one of those
// used to say so in a free-text blocker and keep its lease, so the item sat owned by a session
// that could not act until a master session read the prose. It now records a typed request — which
// of the three decisions, why, and the exact thing needed — and that one transaction ends the
// attempt's lease and parks the item. Nothing else waits: the rest of the graph keeps moving, the
// request is listed for the human with how long it has waited and how to answer it, and the
// answer itself returns the item to the loop, which dispatches it without a master session.
// ---------------------------------------------------------------------------

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
  // An account or spend is approved or set up in words (GY-1395): a bare Approve resumed GY-1384 and
  // GY-1365 with nothing provided, and the resumed worker could only ask again.
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
/**
 * What a request's recommendation misses (GY-1410), naming the field; empty when it has one. Every
 * request tells the human what its requester advises: the choice it recommends or, for a value to
 * provide, the safest way to obtain it (a fine-grained token scoped to one repository, with a short
 * expiry and only the permissions needed), plus WHY, one plain sentence of why. A request with
 * choices to press names one by its label, so the card can preselect it; a value request (a secret
 * choice, or every choice but Decline asking for the human's words) may advise in its own words.
 */
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
/**
 * Why a park is refused before it reaches the human, or null when it may park (GY-1395): a scope
 * widening (GY-1113) is `scope-request`'s, and NEEDED names every human step, never deferring one.
 * GY-1416: work an agent identity on the host can do is never the human's (`hostDoableAsk`) — a
 * repository the host's gh login creates or administers (GY-1384), a deployment variable derived
 * from saved credentials (GY-1365) or a credential the host already holds. Goals and priorities,
 * money or paid accounts, and credentials issued to people still park.
 */
const scopeWideningAsk = /\bplanned ?files\b|\bscope[- ]request\b|\bmaster scope\b|\bwiden(?:s|ed|ing)?\b[^.]{0,60}\bscope\b/i;
const deferredAsk = /\bone at a time\b|\bpark (?:once )?(?:again|more)\b|\bpark (?:it )?later\b/i;
export interface HostDoableAsk { class: 'repository' | 'deployment-variable' | 'host-credential'; what: string; route: string; command: string }
const hostDoable: (HostDoableAsk & { test: RegExp })[] = [
  { class: 'deployment-variable', what: 'a deployment variable derived from credentials saved on this host', test: /\b(?:GRAPHYARD_REVERT_APPROVER_[A-Z_]+|GITHUB_(?:APP_ID|INSTALLATION_ID|PRIVATE_KEY(?:_FILE)?|WEBHOOK_SECRET|CI_APP_IDS)|GRAPHYARD_(?:PRINCIPALS|REVIEWER_APPS))\b|\bprovision-railway\b|\b[Ss]et\b[^.;]{0,80}\b(?:[Dd]eployment|[Ee]nvironment|[Rr]ailway|[Cc]ontrol[- ]plane) variables?\b/,
    route: 'the master derives it from the saved App registrations and sets it through the provider adapter, secrets piped and never printed', command: 'graphyard master setup --apply' },
  { class: 'repository', what: 'a repository the host\'s gh login can create or administer', test: /\b(?:create|make|configure|administer|set up)\b[^.;]{0,80}\brepositor(?:y|ies)\b|\brepositor(?:y|ies)\b[^.;]{0,60}\b(?:reachable|admin)|\bgh login\b[^.;]{0,60}\badmin/i,
    route: 'the master does it under the host\'s own gh login, outside the worker sandbox', command: 'gh repo create OWNER/NAME (or gh api repos/OWNER/NAME) as the host\'s gh login, then graphyard master unblock GY-N REASON' },
  { class: 'host-credential', what: 'a credential the host already holds for this purpose', test: /\b(?:paste|provide|give|send|share|supply)\b[^.;]{0,80}\b(?:github|gh|admin|app|railway)\b[^.;]{0,40}\b(?:token|private key|pem|credential)s?\b/i,
    route: 'the master supplies it from the host: the gh login (gh auth token), the App registration saved under the install directory, or the provider CLI\'s own login', command: 'gh auth token (or the saved App registration) in the master\'s session, then graphyard master unblock GY-N REASON' },
];
/** Who a credential is issued to, when it is a person: that stays the human's (`credentials-for-people`). */
const personRecipient = /\b(?:teammate|contractor|colleague|employee|engineer|person|people|developer|new hire)s?\b/i;
/** A credential asked under `credentials-for-people` is the host's only when an agent's work is its stated purpose. */
const agentPurpose = /\b(?:pilot|worker|agent|master|loop|host|install(?:er|ation)?|deployment|control plane|CI|webhooks?)\b/i;
/** A step only the human takes, which a host-doable step beside it never hides: money, opening any third-party account (free or paid), a goal. */
const humanStep = /\b(?:paid|pay|purchase|buy|billing|subscription|budget|spend|invoice|goals?|priorit(?:y|ies|ize))\b|\b(?:open|create|register|sign(?:ing)? up for)\b[^.;]{0,40}\baccounts?\b|\bsign(?:ing)?[- ]?up\b|[€$]\s?\d|\b\d+(?:\.\d+)?\s?(?:EUR|USD)\b|\/month\b|\ba month\b/i;
export function hostDoableAsk(needed: string, kind?: string): HostDoableAsk | null {
  if (humanStep.test(needed)) return null;
  const found = hostDoable.find(entry => entry.test.test(needed) && !(entry.class === 'host-credential' && (personRecipient.test(needed) || (kind === 'credentials-for-people' && !agentPurpose.test(needed)))));
  return found ? { class: found.class, what: found.what, route: found.route, command: found.command } : null;
}
export const hostDoableRefusal = (ask: HostDoableAsk) => `Not a human-only decision: NEEDED asks for ${ask.what}, which an agent identity on the host can do; it is the master's owed action, not the human's. Agent route: ${ask.route} — ${ask.command}`;
export function parkRefusal(data: { needed: string; kind?: string }): string | null {
  if (scopeWideningAsk.test(data.needed)) return 'A scope widening is not a human-only decision: ask for it with graphyard scope-request GY-N EPOCH PATH… -- REASON, which an approver decides';
  if (deferredAsk.test(data.needed)) return 'Ask for every human step the item still needs in this one request: NEEDED may not leave steps to later parks';
  const doable = hostDoableAsk(data.needed, data.kind);
  return doable ? hostDoableRefusal(doable) : null;
}

/**
 * The fields every request only a human may answer carries, whatever raised it: the exact thing
 * needed, why, who asked, and when. A `park` request is one; an approval the server will take
 * only from the operator's own credential is another, and is modelled with the same fields so
 * the list, the page and the CLI read one shape (GY-102).
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
export const describeHumanRequest = (request: Pick<HumanRequest, 'kind' | 'needed'>) => `${humanRequestBlocker} (${humanDecisionLabel[request.kind]}): ${request.needed}`;
export const parkedOnHuman = (work: { humanRequest?: HumanRequest | null }) => !!work.humanRequest && !work.humanRequest.answer;

/** How to answer, exactly as the list and `master status` print it. */
export const answerCommand = (key: string, request: Pick<HumanRequest, 'id'>) => `graphyard answer ${key} ${request.id} ANSWER`;
export const declineCommand = (key: string, request: Pick<HumanRequest, 'id'>) => `graphyard answer ${key} ${request.id} --decline REASON`;

/** One button on a card (GY-738): the whole body it posts, whether it asks for words or a secret, and the field an optional note goes in (null when it takes none). */
export interface HumanOnlyChoice { label: string; input: HumanChoice['input']; declines: boolean; body: Record<string, unknown>; note: string | null; recommended?: boolean }
/** The choices with the recommended one first (GY-1410). */
export const recommendedFirst = (choices: readonly HumanOnlyChoice[]) => [...choices.filter(choice => choice.recommended), ...choices.filter(choice => !choice.recommended)];
/**
 * How the operator answers one request from the page, in their own session: the work command it posts to, the fields
 * that body always carries, the field their words go in, and a refusing answer. The command lines beside the form are
 * the equivalent, never the way to answer: a credential on a command line is the defect this surface removes (GY-102).
 */
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
export type HumanOnlyDecision = Omit<Decision, 'state'> & { state: string };
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
 * A decision only a human may make, parked by the worker that reached it. The server refuses an
 * answer from anything but a declared human session (server/waits.ts `answerHumanDecision`, which
 * asks this rule): the three decisions are human by definition, and an agent holding an admin
 * credential is still an agent.
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
 * An approval whose decision the server takes from the operator's admin credential alone
 * (model/approval.ts `operatorOnlyDecision`): a requested merge decision that overrides a
 * reconciliation the record refused. Every agent identity is refused it — approved by the
 * master's own pair it applies and then delivers nothing — so it waits for the operator here,
 * with the same fields as a parked request: what is needed, why, who asked, how long it has waited.
 */
export const operatorApprovalRule: HumanOnlyRule = {
  kind: 'operator-approval',
  // Only an item whose record has refused a reconciliation can carry one of these, so the ledger
  // read the surface pays for is bounded to the items that could answer it.
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
        // Declining is the operator's considered refusal on the same route (`{ action: 'refuse' }`,
        // server/decision-refusal.ts): terminal, with their reason, as Decline is on a park request.
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
