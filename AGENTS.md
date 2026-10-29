# Working on Graphyard

Keep it simple. Build the simplest thing that meets the criteria and gives users a good experience. Do not over-engineer: no defensive layers, extra gates, permission checks or tests for hypothetical cases. Prefer deleting code to adding it. Agents are capable: do not build process around corner cases.

Keep the control plane independent of agent runtimes. Herdr is the first integration, not the source of ownership truth.

The initial MVP is a single-agent bootstrap under the operator's supervision. Do not launch other agents for bootstrap work. Once Graphyard's own repository is connected and its gates are active, claim subsequent implementation work in Graphyard and use its assigned worktree.

Autonomy is the default: agents act without asking. The human operator keeps exactly three decisions: goals and priorities, money and accounts, and credentials for people. The master applies every other decision (release, unblock, requirements, rework, close, grant, attest) at once with its own operator-agent identity (see `docs/glossary.md#who-decides`). Never ask a human to run a command an agent identity is permitted to run.

Domain mutations must be transactional, append history, and enforce principal identity and lease epochs. Never add a client-controlled arbitrary lifecycle-state endpoint. Do not grant implementation workers trusted evidence-producer credentials. Never weaken a task's requirements to make its implementation pass.

Run `npm run build` and `npm test` for domain/API changes. Tests run a temporary real Postgres database; do not substitute production data. Tests create every temporary directory with `temporaryDirectory(label[, parent])` from `tests/helpers/temp-dirs.ts`. Update the relevant guide under `docs/` when behavior changes. Keep external I/O outside coordination transactions.

No secrets belong in Git. `.graphyard/credentials.json` and `.env` are local-only. Installation credentials belong under `~/.config/graphyard/<install>/` with mode 0600, never in a repository. Installation and deployment changes go through `src/install/`, the Dockerfile and `compose.yaml`. Preview infrastructure changes with `graphyard install --plan` before applying (no GitHub App, branch protection or Actions gates; the merge writer deploy key is the only GitHub access).

<!-- graphyard -->
## Graphyard coordination

This repository uses Graphyard for ownership and delivery gates; ignored
`.graphyard/connection.json` names the control plane and the machine-specific
CLI and connection settings. Never put credentials in AGENTS.md or Git.

Before editing, claim an authorized work item and use its assigned worktree.
Never weaken requirements, and never use an operator/producer token for
implementation or proof. Act without asking, and record blockers with the CLI.
Submit with `complete GY-N EPOCH --head SHA`; make `complete` your last action.
For any procedure, run `node $GRAPHYARD_CLI guide TOPIC`
(topics: claim, sync, complete, park, blocked, review, proof, master).
<!-- /graphyard -->
