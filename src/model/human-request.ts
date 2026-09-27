import { z } from 'zod';
import { operatorCredentialRefusal, operatorOnlyDecision, refusedReconciliations, type Decision } from './approval.js';
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

export const humanRequestSchema = z.object({
  epoch: z.number().int().positive(),
  kind: z.enum(humanDecisionKinds),
  /** Why the item cannot continue without the decision. */
  reason: z.string().trim().min(1).max(2000),
  /** The exact thing the human is asked for: the account to open, the priority to set, the credential to issue. */
  needed: z.string().trim().min(1).max(2000),
}).strict();
export const humanAnswerSchema = z.object({
  request: z.string().uuid(),
  /** `provided`: the thing asked for now exists, so the item resumes. `declined`: it will not, and the item stays parked with the answer as its blocker. */
  outcome: z.enum(['provided', 'declined']).default('provided'),
  answer: z.string().trim().min(1).max(4000),
}).strict();

/** `withdrawn`: nobody answered; the item was closed and the question no longer stands (model/closure.ts). */
export interface HumanAnswer { by: string; at: string; outcome: 'provided' | 'declined' | 'withdrawn'; text: string; waitedMs: number }
/**
 * The fields every request only a human may answer carries, whatever raised it: the exact thing
 * needed, why, who asked, and when. A `park` request is one; an approval the server will take
 * only from the operator's own credential is another, and is modelled with the same fields so
 * the list, the page and the CLI read one shape (GY-102).
 */
export interface HumanOnlyRequest {
  id: string; kind: string; reason: string; needed: string;
  requestedBy: string; epoch: number; at: string;
}
export interface HumanRequest extends HumanOnlyRequest {
  kind: HumanDecisionKind;
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

/**
 * How the operator answers one request from the page, in their own authenticated session: the
 * work command it posts to, the fields that body always carries, and the field their own words
 * go in. A rule with a refusing answer carries that too. The command lines beside the form are
 * the equivalent, never the way to answer: handling a credential on a command line is the defect
 * this surface exists to remove (GY-102).
 */
export interface HumanOnlyPost {
  command: string;
  body: Record<string, unknown>;
  field: string;
  submit: string;
  decline: { body: Record<string, unknown>; submit: string } | null;
}
export interface HumanRequestRow {
  /** The rule that raised it (`humanOnlyRules`); the page asks that rule whether this session may answer. */
  rule: string;
  work: string; id: string; title: string; request: HumanOnlyRequest;
  waitedMs: number; decision: string;
  /** What an agent identity is told when it attempts this, in the server's own words. */
  refusal: string;
  answer: { cli: string; decline: string; dashboard: string; api: string; post: HumanOnlyPost };
}
/** A row as `master status` reports it: what is needed, why, who asked, how long, and where it is answered. */
export function humanOnlyStatusRow(row: HumanRequestRow) {
  return { work: row.work, rule: row.rule, decision: row.decision, needed: row.request.needed, reason: row.request.reason,
    requestedBy: row.request.requestedBy, requestedAt: row.request.at, waitedMs: row.waitedMs, answerOn: row.answer.dashboard, refusesAgents: row.refusal };
}
/** Every open human-only request, longest wait first: the human-facing list. */
export function openHumanRequests(work: readonly { id: string; key: string; title: string; stage: string; humanRequest?: HumanRequest | null }[], now: number): HumanRequestRow[] {
  return work.filter(item => item.stage !== 'done' && parkedOnHuman(item)).map(item => {
    const request = item.humanRequest!;
    return {
      rule: parkRule.kind, work: item.key, id: item.id, title: item.title, request,
      waitedMs: Math.max(0, now - Date.parse(request.at)), decision: humanDecisionLabel[request.kind],
      refusal: parkRule.refuse({ id: 'an agent identity', role: 'operator-agent', sessionKind: 'ai' })!,
      answer: { cli: answerCommand(item.key, request), decline: declineCommand(item.key, request), dashboard: 'Work → Needs you → Answer', api: `POST /api/work/${item.key}/answer {"request":"${request.id}","answer":"…"}`,
        post: { command: 'answer', body: { request: request.id, outcome: 'provided' }, field: 'answer', submit: `Answer and resume ${item.key}`,
          decline: { body: { request: request.id, outcome: 'declined' }, submit: 'Decline' } } },
    };
  }).sort((a, b) => b.waitedMs - a.waitedMs);
}

// ---------------------------------------------------------------------------
// The human surface (GY-102).
//
// `park` is not the only thing the server takes from the operator's own credential. An approval
// whose decision no agent identity can complete is another, and before this table it reached the
// operator as a sentence in `master status` telling them to put an admin token on a command
// line. Every such action is a rule here: what the server refuses an agent identity, and how to
// find the open instances of it. The page, the CLI list and `GET /api/human-requests` render
// this table and nothing else, so a rule added here is listed for the human without a second
// change anywhere, and a human-only action can never be silently absent from the surface.
// ---------------------------------------------------------------------------

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
      const request: HumanOnlyRequest = { id: decision.id, kind: operatorApprovalRule.kind, needed: operatorOnly.needed, reason: decision.reason,
        requestedBy: decision.requestedBy, epoch: work.epoch, at: decision.requestedAt };
      return [{
        rule: operatorApprovalRule.kind, work: work.key, id: work.id, title: work.title, request,
        waitedMs: Math.max(0, now - Date.parse(decision.requestedAt)), decision: operatorApprovalLabel,
        refusal: operatorCredentialRefusal({ id: 'an agent identity', role: 'operator-agent' })!,
        answer: {
          cli: `GRAPHYARD_TOKEN_FILE=ADMIN_TOKEN_FILE graphyard master approve ${work.key} ${decision.id} REASON`,
          decline: `graphyard master withdraw ${work.key} ${decision.id} REASON, run by the identity that requested it`,
          dashboard: 'Work → Needs you → Approve',
          api: `POST /api/work/${work.key}/approve {"decision":"${decision.id}","reason":"…"}`,
          post: { command: 'approve', body: { decision: decision.id }, field: 'reason', submit: `Approve and deliver ${work.key}`, decline: null },
        },
      }];
    });
  },
};

/** The rule name a research question's row carries; it is answered under the park rule's refusal, as every goals-and-priorities request is. */
export const researchQuestionRule = 'research-question';
/**
 * Every unanswered product question a research brief asked (src/research.ts), as a row of the
 * human surface: the question, why it matters, the recommended answer the build already proceeds
 * on, and the deadline. The answer is posted to `research-answer`; it never parks or releases the
 * item, and one that differs from the recommendation returns a built head for rework. Derived
 * here beside the rule table (GY-401), so the server's human-only list — the page, `graphyard
 * human-requests`, `master status`, and every count or notification built from it — carries the
 * questions with the rules, instead of each client merging them from the work documents alone.
 */
export function researchQuestionRows(work: readonly Pick<Work, 'id' | 'key' | 'title' | 'stage' | 'epoch' | 'researchBrief'>[], now: number): HumanRequestRow[] {
  return work.filter(item => item.stage !== 'done').flatMap(item => (item.researchBrief?.questions ?? []).filter(question => !question.answer).map(question => ({
    rule: researchQuestionRule, work: item.key, id: item.id, title: item.title,
    request: { id: question.id, kind: question.kind, needed: question.question, requestedBy: 'the research step',
      reason: `${question.why} Recommended: ${question.recommendation}. The build proceeds on this recommendation, provisionally; answer by ${question.deadline} to settle it before the head is built.`,
      epoch: item.epoch, at: question.at },
    waitedMs: Math.max(0, now - Date.parse(question.at)), decision: humanDecisionLabel[question.kind],
    refusal: parkRule.refuse({ id: 'an agent identity', role: 'operator-agent', sessionKind: 'ai' })!,
    answer: { cli: `POST /api/work/${item.key}/research-answer {"question":"${question.id}","answer":"…"}`, decline: 'Leave it unanswered: the recommendation stands',
      dashboard: 'Work → Needs you → Answer', api: `POST /api/work/${item.key}/research-answer {"question":"${question.id}","answer":"…"}`,
      post: { command: 'research-answer', body: { question: question.id }, field: 'answer', submit: `Answer for ${item.key}`, decline: null } },
  })));
}
/** The research brief's product questions as a rule of the table: no ledger reads, refused like the park rule's. */
export const researchRule: HumanOnlyRule = {
  kind: researchQuestionRule,
  refuse: actor => parkRule.refuse(actor),
  open: (subject, now) => researchQuestionRows([subject.work], now),
};

/**
 * Every rule, in the order the surface lists them. Enforcement reads this table and so does the
 * page: adding a rule here is the one change a new human-only action needs.
 */
export const humanOnlyRules: HumanOnlyRule[] = [parkRule, operatorApprovalRule, researchRule];
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
