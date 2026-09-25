/**
 * The autonomy contract: the one statement of how every agent Graphyard launches behaves, for
 * every installation (GY-184). Graphyard is a heavily automated system — the control plane
 * requests independent review, proof and approval on its own — so a session that stops to ask a
 * human stalls its item until someone notices. The text is part of the instruction of every
 * session Graphyard launches (worker, reviewer, producer, approver, escalation handler, master:
 * master.ts `startAgentSession` puts it in the session's role file when the runtime loads one, and
 * at the start of its first request otherwise), and of the coordination section onboarding writes
 * into a connected repository's AGENTS.md, so an agent started outside the launcher reads it too.
 *
 * It is one line so that it survives the whitespace folding a role file gets, and is found
 * verbatim wherever it is carried.
 */
export const autonomyContract = 'Graphyard autonomy contract: act without asking. Never ask a human for review, approval or confirmation, and never ask a human to run a command an agent identity may run; the control plane requests independent review, proof and approval on its own. When you genuinely cannot continue, record the blocker in Graphyard with its CLI (blocked, park, or master decide) rather than asking in chat. Stop for a human only before an irreversible destructive action.';

/**
 * A session's launch text with the contract carried: in the role text when the runtime loads a
 * role file (`carriesRole`), otherwise at the start of the request. Text that already carries the
 * contract is returned as it is, so it is never stated twice.
 */
export function withAutonomyContract(carriesRole: boolean, text: { request: string; role?: string | null }) {
  const role = text.role ?? null;
  if (carriesRole) return { request: text.request, role: role?.includes(autonomyContract) ? role : role ? `${autonomyContract} ${role}` : autonomyContract };
  return { request: text.request.startsWith(autonomyContract) ? text.request : `${autonomyContract} ${text.request}`, role };
}
