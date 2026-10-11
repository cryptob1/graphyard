// Concern: why a park is refused before it reaches the human (GY-1395) — the asks an agent identity on the host can take itself (GY-1416, GY-1692).

/**
 * Why a park is refused before it reaches the human, or null when it may park (GY-1395): a scope
 * widening (GY-1113) is `scope-request`'s, and NEEDED names every human step, never deferring one.
 * GY-1416: work an agent identity on the host can do is never the human's (`hostDoableAsk`) — a
 * repository the host's gh login creates or administers (GY-1384), a deployment variable derived
 * from saved credentials (GY-1365) or a credential the host already holds. GY-1692 adds three more
 * such asks, each parked once at the build stage in the week to 2026-10-11: a Confirm-access view
 * recorded in the operator's signed-in browser (GY-1470; `master browser capture` records it through
 * the profile lent to the master), the coordinator checkout's moved HEAD and unit record (GY-1666;
 * `master checkout-restore` restarts the loop onto a clean moved HEAD, and the loop records its own
 * units from the unit serving it), and an operator-agent identity issued to an agent whose
 * token is a repository secret (GY-1691; `master setup --apply` issues it with the install's admin
 * credential and stores it through the host's gh login). Goals and priorities, money or paid
 * accounts, and credentials issued to people still park.
 */
const scopeWideningAsk = /\bplanned ?files\b|\bscope[- ]request\b|\bmaster scope\b|\bwiden(?:s|ed|ing)?\b[^.]{0,60}\bscope\b/i;
const deferredAsk = /\bone at a time\b|\bpark (?:once )?(?:again|more)\b|\bpark (?:it )?later\b/i;
export interface HostDoableAsk { class: 'repository' | 'deployment-variable' | 'host-credential' | 'browser-capture' | 'coordinator-checkout' | 'agent-identity'; what: string; route: string; command: string }
const hostDoable: (HostDoableAsk & { test: RegExp })[] = [
  { class: 'deployment-variable', what: 'a deployment variable derived from credentials saved on this host', test: /\b(?:GRAPHYARD_REVERT_APPROVER_[A-Z_]+|GITHUB_(?:APP_ID|INSTALLATION_ID|PRIVATE_KEY(?:_FILE)?|WEBHOOK_SECRET|CI_APP_IDS)|GRAPHYARD_(?:PRINCIPALS|REVIEWER_APPS))\b|\bprovision-railway\b|\b[Ss]et\b[^.;]{0,80}\b(?:[Dd]eployment|[Ee]nvironment|[Rr]ailway|[Cc]ontrol[- ]plane) variables?\b/,
    route: 'the master derives it from the saved App registrations and sets it through the provider adapter, secrets piped and never printed', command: 'graphyard master setup --apply' },
  { class: 'repository', what: 'a repository the host\'s gh login can create or administer', test: /\b(?:create|make|configure|administer|set up)\b[^.;]{0,80}\brepositor(?:y|ies)\b|\brepositor(?:y|ies)\b[^.;]{0,60}\b(?:reachable|admin)|\bgh login\b[^.;]{0,60}\badmin/i,
    route: 'the master does it under the host\'s own gh login, outside the worker sandbox', command: 'gh repo create OWNER/NAME (or gh api repos/OWNER/NAME) as the host\'s gh login, then graphyard master unblock GY-N REASON' },
  { class: 'host-credential', what: 'a credential the host already holds for this purpose', test: /\b(?:paste|provide|give|send|share|supply)\b[^.;]{0,80}\b(?:github|gh|admin|app|railway)\b[^.;]{0,40}\b(?:token|private key|pem|credential)s?\b/i,
    route: 'the master supplies it from the host: the gh login (gh auth token), the App registration saved under the install directory, or the provider CLI\'s own login', command: 'gh auth token (or the saved App registration) in the master\'s session, then graphyard master unblock GY-N REASON' },
  // GY-1692 (GY-1470): a recording of GitHub's Confirm-access view, which renders only in a signed-in
  // session — the browser profile the operator lent the master (master init --browser-profile). Only
  // that view: a recording of an authenticator screen with no Confirm-access or GitHub sudo context
  // (a person's enrolment, say) is not the master's to make.
  { class: 'browser-capture', what: 'a recording of a GitHub Confirm-access view made in the operator\'s signed-in browser', test: /\b(?:recording|capture|markup|outerHTML)\b[^.;]{0,160}\b(?:confirm[- ]access|sudo)\b|\b(?:confirm[- ]access|sudo)\b[^.;]{0,120}\b(?:recording|capture|markup|outerHTML)\b|\bgithub\b[^.;]{0,80}\bauthenticator\b[^.;]{0,80}\b(?:recording|capture|markup|outerHTML)\b/i,
    route: 'the master records every Confirm-access view the page offers through the browser profile lent to it, redacted, submitting nothing (GY-1686)', command: 'graphyard master browser capture, then graphyard master unblock GY-N REASON' },
  // GY-1692 (GY-1666): the coordinator checkout's HEAD moved onto commits the loop does not run, and
  // the install's unit record. The loop's checkout-restore saves every dirty path under a ref and
  // restarts onto a clean moved HEAD (GY-1680, the adoption GY-1531 sanctions); it records its own
  // units from the unit serving it. `master init` names this only for the unit record: run for a
  // browser profile (--browser-profile) it lends the operator's session, which stays theirs.
  { class: 'coordinator-checkout', what: 'the coordinator checkout\'s HEAD or its unpushed commits, or this install\'s unit record', test: /\bcoordinator checkout\b|\bunpushed\b[^.;]{0,60}\bcommits?\b|\bdetached (?:HEAD|at)\b|\bmaster init\b[^.;]{0,100}\bunits?\b|\bunits\.json\b/i,
    route: 'the loop saves every dirty path under refs/graphyard/checkout-restore/ and restarts onto a clean moved HEAD, discarding nothing (GY-1680); it records its own units from the unit serving it', command: 'graphyard master checkout-restore REASON' },
  // GY-1692 (GY-1691): an identity issued to an agent, not a person, whose token is a repository or
  // environment secret the host's gh login sets; the install's admin credential is saved on the host.
  { class: 'agent-identity', what: 'an operator-agent identity issued to an agent, with its token stored as a repository or environment secret', test: /\boperator-agent setup\b|\bgraphyard-release-follow-up\b|\bGRAPHYARD_RELEASE_TOKEN\b|\bgh secret set\b|\b(?:operator[- ]agent|agent) identit(?:y|ies)\b/i,
    route: 'the master issues or rotates it with the install\'s admin credential saved on this host and stores the token through the host\'s gh login, the loop running it itself; a host without that credential names the administrator\'s step in master status', command: 'graphyard master setup --apply' },
];
/** Who a credential is issued to, when it is a person: that stays the human's (`credentials-for-people`). */
const personRecipient = /\b(?:teammate|contractor|colleague|employee|engineer|person|people|developer|new hire)s?\b/i;
/** An identity, token or sign-in a person is to receive (GY-1692): `agent-identity` and `browser-capture` never claim it, whatever agent or view it also names. */
const personIssued = /\b(?:to|for|give|gives|issue[sd]?|provide[sd]?|hand)\b[^.;]{0,40}\b(?:teammate|contractor|colleague|employee|engineer|person|people|developer|new hire)s?\b|\b(?:teammate|contractor|colleague|employee|engineer|person|people|developer|new hire)s?\b[^.;]{0,30}\b(?:identity|identities|token|sign-in|credential)s?\b/i;
/** A credential asked under `credentials-for-people` is the host's only when an agent's work is its stated purpose. */
const agentPurpose = /\b(?:pilot|worker|agent|master|loop|host|install(?:er|ation)?|deployment|control plane|CI|webhooks?)\b/i;
/** A step only the human takes, which a host-doable step beside it never hides: money, opening any third-party account (free or paid), a goal. */
const humanStep = /\b(?:paid|pay|purchase|buy|billing|subscription|budget|spend|invoice|goals?|priorit(?:y|ies|ize))\b|\b(?:open|create|register|sign(?:ing)? up for)\b[^.;]{0,40}\baccounts?\b|\bsign(?:ing)?[- ]?up\b|[€$]\s?\d|\b\d+(?:\.\d+)?\s?(?:EUR|USD)\b|\/month\b|\ba month\b/i;
export function hostDoableAsk(needed: string, kind?: string): HostDoableAsk | null {
  if (humanStep.test(needed)) return null;
  const found = hostDoable.find(entry => entry.test.test(needed)
    && !(entry.class === 'host-credential' && (personRecipient.test(needed) || (kind === 'credentials-for-people' && !agentPurpose.test(needed))))
    && !((entry.class === 'agent-identity' || entry.class === 'browser-capture') && personIssued.test(needed)));
  return found ? { class: found.class, what: found.what, route: found.route, command: found.command } : null;
}
export const hostDoableRefusal = (ask: HostDoableAsk) => `Not a human-only decision: NEEDED asks for ${ask.what}, which an agent identity on the host can do; it is the master's owed action, not the human's. Agent route: ${ask.route} — ${ask.command}`;
export function parkRefusal(data: { needed: string; kind?: string }): string | null {
  if (scopeWideningAsk.test(data.needed)) return 'A scope widening is not a human-only decision: ask for it with graphyard scope-request GY-N EPOCH PATH… -- REASON, which an approver decides';
  if (deferredAsk.test(data.needed)) return 'Ask for every human step the item still needs in this one request: NEEDED may not leave steps to later parks';
  const doable = hostDoableAsk(data.needed, data.kind);
  return doable ? hostDoableRefusal(doable) : null;
}
