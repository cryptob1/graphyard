# Graphyard

**A control plane for software work performed by many agents across many machines.**

Graphyard records who owns work, which isolated workspace belongs to it, what must be proven, and why delivery is blocked. Herdr and other execution tools run the agents. Graphyard owns workflow decisions.

This is the first MVP, with a Postgres-backed coordination engine, HTTP API, CLI, React delivery graph and work board, GitHub App adapter, and native Herdr plugin. It is intended for initial dogfooding, not a claim that all distributed engineering risks are solved.

## Start here

| Goal | Guide |
| --- | --- |
| Run locally and complete your first task | [Quickstart](docs/quickstart.md) |
| Understand the model and correctness guarantees | [Architecture](docs/architecture.md) |
| Deploy on Railway or Docker | [Deployment](docs/deployment.md) |
| Make Graphyard a required GitHub merge check | [GitHub enforcement](docs/github.md) |
| Connect workers and trusted evidence producers | [Agent protocol and API](docs/protocol.md) |
| Store and version E2E test cases | [Test-case registry](docs/test-cases.md) |
| Use Graphyard from Herdr | [Herdr plugin](docs/herdr.md) |
| Recover from failures and operate the service | [Operations](docs/operations.md) |
| Contribute and build Graphyard with Graphyard | [Development and dogfooding](docs/development.md) |
| Compare the implementation with the product specification | [Implementation audit](docs/implementation-audit.md) |

## What works in v0.1

- Work items with immutable acceptance requirements, dependencies, priority, and append-only history.
- Atomic claims across server replicas, two-minute leases, and monotonically increasing assignment epochs that fence stale commands.
- Host-specific worktree registration, unique branch reservations, and local worktree creation through the CLI.
- A delivery graph and Kanban view, with explicit gate refusals, ownership, evidence, integration errors, and history.
- GitHub PR, review, CI check, and merge observation. A required App-owned check blocks merging when configured in branch protection.
- Evidence scoped to commit, base commit, and policy revision, with producer permissions, executed-test counts, and skipped-test rejection.
- Durable reconciliation jobs, deduplicated webhooks, retry-safe commands, and periodic recovery.
- A Herdr plugin to inspect work and acquire or release claims; the CLI handles agent process supervision.

The initial lifecycle is `Backlog → Ready → Build → Review → Test → Acceptance → Merge → Done`. Review and required CI checks are configurable per item. The topology itself is fixed in this release. `Done` means an observed merge with satisfied gates; it does **not** mean deployed to production.

## Local launch

Requires Node 24, Git, and Docker Compose:

```sh
npm ci
cp .env.example .env
# Replace example credentials in .env with unique random secrets.
docker compose up -d db
npm run build
npm start
```

Open `http://localhost:4310` and enter an individual access token. Follow the [quickstart](docs/quickstart.md) to create and claim work. GitHub gates remain closed until the App and branch protection are configured.

The package is not published to npm yet. Use `npm run cli -- ...` or `node bin/graphyard.mjs ...` from the checkout. Do not assume `npx graphyard` installs this project.

## Deployment

Railway builds the repository's Dockerfile. A single application container serves the UI/API and reconciles work; Postgres stores durable state. The service can be replicated because coordination locks and jobs live in Postgres. [Deployment instructions](docs/deployment.md) explain credentials, networking, and upgrades.

No LangGraph, Temporal, Redis, or Kubernetes is required. These would add operational dependencies without supplying the domain-specific correctness rules Graphyard still needs to own.

## Validation

```sh
npm run build
npm test
```

Tests start a real, isolated Postgres instance from development dependencies and exercise concurrent claims across pools, lease expiry, idempotency, stale evidence, provenance, workspace uniqueness, durable jobs, append-only history, and the HTTP boundary. Tests require local socket access and a non-root account.

## Scope and limitations

One GitHub repository and one protected base branch per control plane. Many workers, machines, and worktrees can use that control plane. GitHub App installation is required for external enforcement. Cross-repository graphs, deployment observations, automatic E2E execution, custom topology, semantic conflict detection, SSO, and automatic agent dispatch are future work.

A Graphyard lease cannot revoke Git credentials or filesystem access. GitHub check publication is eventually consistent with database decisions, and completed GitHub checks do not expire when Graphyard is offline. Read the [enforcement boundary](docs/github.md#enforcement-boundary) before relying on the system.

Licensed under [Apache 2.0](LICENSE).
