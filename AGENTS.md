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

Submit the PR with `complete GY-N EPOCH PR_NUMBER`. This reports implementation
completion; it does not set Done. CI, trusted evidence, independent review, and
Graphyard's merge gate decide progression. Report blockers explicitly.
Never use an operator/producer token for implementation or weaken proof requirements.
Herdr runs sessions; Graphyard remains the source of ownership truth.
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

Check the automatic-merge preference in master status. When disabled, wait for
explicit operator approval for each merge. Otherwise routine merges may use
`graphyard master merge --all`. The command rechecks the
exact current candidate, every configured gate, and GitHub state immediately before
merging. Human gates, stale observations, failures, and changed commits remain
blocking. Never use an administrative merge bypass. Read `docs/master-agent.md`
in Graphyard or run `graphyard master guide` for the complete operating loop.
<!-- /graphyard-master -->
