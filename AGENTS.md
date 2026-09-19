# Working on Graphyard

Keep the control plane independent of agent runtimes. Herdr is the first integration, not the source of ownership truth.

The initial MVP is a single-agent bootstrap under the operator's supervision. Do not launch other agents for bootstrap work. Once Graphyard's own repository is connected and its gates are active, claim subsequent implementation work in Graphyard and use its assigned worktree.

Domain mutations must be transactional, append history, and enforce principal identity and lease epochs. Never add a client-controlled arbitrary lifecycle-state endpoint. Do not grant implementation workers trusted evidence-producer credentials. Never weaken a task's requirements to make its implementation pass.

Run `npm run build` and `npm test` for domain/API changes. Tests run a temporary real Postgres database; do not substitute production data. Update the relevant guide under `docs/` when behavior changes. Keep external I/O outside coordination transactions.

No secrets belong in Git. `.graphyard/credentials.json` and `.env` are local-only. Deployment changes use the Dockerfile and `.railway/railway.ts`; preview infrastructure changes before applying.

<!-- graphyard -->
## Graphyard coordination

This repository uses Graphyard at https://graphyard-production.up.railway.app for ownership and delivery gates.
Repository setup stores machine-specific CLI and connection settings in ignored
`.graphyard/connection.json`. Never put credentials in AGENTS.md or Git.

Before editing, claim an authorized work item and use its assigned worktree.
Check dependencies, blockers, current owner, and lease epoch. Use `handoff GY-N`
to obtain the workspace and launch command for this machine.

Run agents through `watch GY-N EPOCH -- YOUR_AGENT_COMMAND`. The supervisor supplies
`GRAPHYARD_CLI`, `GRAPHYARD_URL`, and worker identity to the child. Inside that
session, invoke the CLI as `node "$GRAPHYARD_CLI" status GY-N` (or other commands).
For manual startup, use the CLI path printed by `init` or Herdr's handoff command.

Renew ownership at least every 30 seconds while actively working. Stop editing and
pushing on lease loss; an expired or superseded epoch does not authorize more work.
Register the assigned host/path/branch before submission. Do not reuse another
assignment's worktree or quietly remove historical reservations.

Run `sync GY-N` before every push. It merges the base branch (`git fetch origin &&
git merge origin/BASE`; never rebase) and lists every file outside the item's
plannedFiles that no longer matches origin/BASE. Files outside plannedFiles must match
origin/BASE byte-for-byte: restore them, never re-resolve a merge in favour of your
branch. Only an operator can widen plannedFiles, through an audited requirements revision.

Submit the PR with `complete GY-N EPOCH PR_NUMBER`. This reports implementation
completion and ends your lease in the same transaction; it does not set Done. It is
refused, naming the files and the shipped work they belong to, when the PR reverts,
deletes or rewrites files outside plannedFiles; the same check runs again on every new
head. Make `complete` your last action: do not heartbeat, edit, or push after it. The
next renewal is refused and the supervisor stops the session; that is the attempt
ending, not lease loss. CI, trusted evidence, independent review, and Graphyard's
merge gate decide progression. Report blockers explicitly.
Never use an operator/producer token for implementation or weaken proof requirements.
Herdr runs sessions; Graphyard remains the source of ownership truth.

A dedicated master coordinator must keep cycling: status, dispatch ready work,
shepherd review and proof collection, guarded merge, then deployment verification.
Repeat until both conditions hold: (1) every in-scope item is Done or has a genuinely
external blocker recorded in Graphyard; and (2) every merged change is deployed and
live-verified against the exact deployed release, or a genuinely external deployment
blocker is recorded in Graphyard. Delivered work is immutable, so a deployment
blocker is recorded as a follow-up work item naming the delivered item, its merge
commit, and the external cause; the delivery stays pending until the release serves it.
An observed merge alone does not end the loop. Ordinary review findings, rework,
idle workers, and proof setup are not stopping conditions. Close finished agent
sessions as part of the cycle.
<!-- /graphyard -->

<!-- graphyard-master -->
## Graphyard master agent

The recommended coordinator is a dedicated, visible master-agent session. It does
not implement work, hold worker leases, submit evidence, or bypass gates. Run
`graphyard master status` at startup and after every material event. Graphyard is
the source of assignment and progression truth; Herdr supplies live session health.

Dispatch only ready work with `graphyard master dispatch GY-N PROFILE`. The
worker must claim the item under its own identity and use the assigned worktree.
Treat prompt delivery as an invitation, never as ownership. Use durable handoffs
when an agent, provider account, machine, or context window changes.

Independent review is launched, never performed by the master:
`graphyard master review GY-N [PROFILE]` verifies the exact candidate, launches the
bound reviewer identity read-only, and `master status` closes that session when the
verdict lands. Never approve a candidate yourself. Reconcile branch protection with
`graphyard master protection` after any review-policy change.

GitHub administration of the managed repository is yours, not the operator's:
control-plane App permission updates, acceptance of the installation permission
request they raise, and branch-protection reconciliation. Use the API first
(`graphyard master protection --apply`, `gh api` on protection and installations).
When GitHub only offers a page — App manifest confirmation, permission-request
acceptance, a sudo prompt — run `graphyard master browser app-permissions`,
`graphyard master browser installation-accept`, or `graphyard master browser protection`.
Each drives the operator's own authenticated browser profile headless, records every
step and screenshot under `.graphyard/master-actions/`, verifies the result through
the API, and appends an attributable audit entry. On a Confirm-access page the flow
triggers GitHub Mobile and reports the two-digit code in `master status`; approving
that prompt on their device, and decisions the docs mark human-only, are the only
operator interactions left. Never store, export, or reuse the profile's cookies
outside those flows.

Keep cycling: status, dispatch ready work, shepherd review and proof collection,
guarded merge, then deployment verification. Repeat until both conditions hold:
(1) every in-scope item is Done or has a genuinely external blocker recorded in
Graphyard; and (2) every merged change is deployed and live-verified against the exact
deployed release, or a genuinely external deployment blocker is recorded in Graphyard.
Verify each delivery with `graphyard master verify-deployment GY-N`: it refuses a
stale or local-only observation and records only the exact deployed release it observed.
Delivered work is immutable, so a deployment blocker is recorded as a follow-up work
item naming the delivered item, its merge commit, and the external cause;
`master status` keeps the delivery under `pending` until the release serves it.
An observed merge alone does not end the loop. Ordinary review findings, rework,
idle workers, and proof setup are not stopping conditions. Close finished agent
sessions as part of the cycle.

Check the automatic-merge preference in master status. When disabled, wait for
explicit operator approval for each merge. Otherwise routine merges may use
`graphyard master merge --all`. The command rechecks the
exact current candidate, every configured gate, and GitHub state immediately before
merging. Human gates, stale observations, failures, and changed commits remain
blocking. Never use an administrative merge bypass, edit a candidate, or read a
worker credential. Read `docs/master-agent.md`
in Graphyard or run `graphyard master guide` for the complete operating loop.
<!-- /graphyard-master -->
