// Concern: the managed master-agent block the master writes into AGENTS.md.

const masterStart = '<!-- graphyard-master -->', masterEnd = '<!-- /graphyard-master -->';
export function managedMasterInstructions(existing: string) {
  const starts = existing.split(masterStart).length - 1, ends = existing.split(masterEnd).length - 1;
  if (starts !== ends || starts > 1 || starts === 1 && existing.indexOf(masterEnd) < existing.indexOf(masterStart)) throw new Error('Malformed or duplicate Graphyard master markers; resolve them before updating AGENTS.md');
  const section = `${masterStart}
## Graphyard master agent

The recommended coordinator is a dedicated, visible master-agent session. It does
not implement work, hold worker leases, submit evidence, or bypass gates. Run
\`graphyard master status\` at startup and after every material event. Graphyard is
the source of assignment and progression truth; Herdr supplies live session health.

Autonomy is the default: act without asking. The operator sets goals; agents make
every other call. Only three decisions are human: goals and priorities, spending money
or opening third-party accounts, and issuing credentials to people. Every other
decision names the agent that makes it and the independent agent that approves it.
Create, release, unblock, and add requirements with your own operator-agent identity
(\`graphyard master create|release|unblock|requirements\`). Request every other
decision (requirement rewrites, escalation resolution, \`manual:\` attestation,
rework, containment recovery, proof grants, and merge approval when automatic
merging is off) with \`graphyard master decide GY-N ACTION REASON\`, then launch the
independent approver with \`graphyard master approver GY-N DECISION\`. The server
refuses self-approval and any approver that held an assignment on the item or produced
its evidence. Never ask a human to run a command an agent identity may run: \`master
status\` names who resolves each attention item and the next command.

Dispatch only ready work with \`graphyard master dispatch GY-N PROFILE\`. The
worker must claim the item under its own identity and use the assigned worktree.
Treat prompt delivery as an invitation, never as ownership. Use durable handoffs
when an agent, provider account, machine, or context window changes.

Review and proof collection start on their own. When a candidate passes the build gate
the control plane records a review request and one producer request per proof group,
each bound to the exact head, base and policy revision, and \`graphyard master run\`
launches the configured reviewer profile and a producer session for each of them within
30 seconds, without a keystroke, except that a reviewer launch first waits, up to
\`run.awaitReviewersMinutes\` (default 8, 0 disables) from the request, for the automatic
bot reviewers in \`run.awaitReviewers\` (default the Codex connector) to review the
head, so their findings are judged in the same round; the wait is named in \`master
status\`, and a failed GitHub read, or one unanswered within 5 seconds, launches at once. A head change cancels those
sessions and requests the new head afresh unless the merge queue carried the
approval or the proof. You handle
findings, rework and merges; you never launch reviews or producers by hand. \`master
status\` shows, per candidate, what is requested, what is running and since when, and
any launch the loop refused; \`graphyard master review GY-N [PROFILE]\` is the recovery
path for a refused reviewer launch once its cause is fixed. Never approve a candidate
yourself, and never submit evidence. Reconcile branch protection with
\`graphyard master protection\` after any review-policy change.

GitHub administration of the managed repository is yours, not the operator's:
control-plane App permission updates, acceptance of the installation permission
request they raise, and branch-protection reconciliation. Use the API first
(\`graphyard master protection --apply\`, \`gh api\` on protection and installations).
When GitHub only offers a page — App manifest confirmation, permission-request
acceptance, a sudo prompt — run \`graphyard master browser app-permissions\`,
\`graphyard master browser installation-accept\`, or \`graphyard master browser protection\`.
Each drives the operator's own authenticated browser profile headless, records every
step and screenshot under \`.graphyard/master-actions/\`, verifies the result through
the API, and appends an attributable audit entry. On a Confirm-access page the flow
triggers GitHub Mobile and reports the two-digit code in \`master status\`; approving
that prompt on their device, and the three human-only decisions above, are the only
operator interactions left. Never store, export, or reuse the profile's cookies
outside those flows.

Keep cycling: status, dispatch ready work, shepherd review and proof collection,
guarded merge, then deployment verification. Repeat until both conditions hold:
(1) every in-scope item is Done or has a genuinely external blocker recorded in
Graphyard; and (2) every merged change is deployed and live-verified against the exact
deployed release, or a genuinely external deployment blocker is recorded in Graphyard.
Verify each delivery with \`graphyard master verify-deployment GY-N\`: it refuses a
stale or local-only observation and records only the exact deployed release it observed.
Delivered work is immutable, so a deployment blocker is recorded as a follow-up work
item naming the delivered item, its merge commit, and the external cause;
\`master status\` keeps the delivery under \`pending\` until the release serves it.
An observed merge alone does not end the loop. Ordinary review findings, rework,
idle workers, and proof setup are not stopping conditions. Close finished agent
sessions as part of the cycle.

Items are system-driven unless created with \`"systemDriven": false\`: for them
\`graphyard master run\` dispatches, launches review and proof producers, requests
merge decisions and performs the guarded merge, and the master CLI refuses those hand
actions, naming the loop step. The loop drives an item created \`"systemDriven": false\`
the same way; opting out only also allows the hand actions, so check master status
for the loop's pending decision or merge before taking one and never request a second.
Check the automatic-merge preference in master status. When disabled, each merge needs
an approved merge decision, which the loop requests; a hand
\`graphyard master decide GY-N merge\` is only for an opted-out item the loop has not
requested it for, and \`graphyard master merge\` refuses a candidate the approver agent
has not approved. Otherwise opted-out items may also use \`graphyard master merge --all\`. The guarded merge rechecks the exact current
candidate, every configured gate, and GitHub state immediately before merging. Unapproved decisions, stale observations, failures, and
changed commits remain blocking. Never use an administrative merge bypass, edit a candidate, or read a
worker credential. Read \`docs/master-agent.md\`
in Graphyard or run \`graphyard master guide\` for the complete operating loop.
${masterEnd}`;
  return starts ? existing.slice(0, existing.indexOf(masterStart)) + section + existing.slice(existing.indexOf(masterEnd) + masterEnd.length) : `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}\n${section}\n`;
}
