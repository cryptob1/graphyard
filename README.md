# Graphyard

**Turn a fleet of coding agents into an engineering system.**

Graphyard is an open-source control plane for coordinating coding agents across machines and worktrees. Agent runtimes write code. Graphyard records ownership, dependencies, evidence, gate decisions, and the exact change allowed to merge.

```text
Backlog → Ready → Build → Review → Test → Acceptance → Merge → Done
```

A card stops at its first refusing gate and explains what is missing. `graphyard complete` submits an implementation; only an observed, authorized merge makes work Done.

[How it works](docs/how-graphyard-works.md) · [Onboard a repository](docs/onboarding.md) · [Documentation](docs/README.md)

## Why Graphyard

Running more agents creates coordination problems faster than it creates shared understanding:

- two workers can claim overlapping work;
- a dead process can leave ownership ambiguous;
- a green check may belong to an old commit;
- an agent can say “done” without proving the requested behavior;
- a merge can bypass the path the team intended.

Graphyard makes those facts explicit and durable.

| Capability | Current behavior |
| --- | --- |
| Work ledger | Intent, dependencies, blockers, ownership, and append-only history |
| Claims and worktrees | Atomic claims, expiring leases, fenced epochs, reserved branches and workspaces |
| Evidence-backed gates | Proof bound to the candidate commit, base commit, and policy revision |
| GitHub enforcement | PR, review, CI, protection, and merge observations with an App-owned required check |
| Herdr integration | Repository setup, a work ledger pane, supervised workers, and a dedicated master mode |
| Delivery view | Kanban and a graph showing every item at its first refusal |
| Test definitions | Versioned E2E scenarios and a packaged Playwright runner/collector path |

Graphyard currently governs work through a verified GitHub merge. The packaged Playwright path is available; environment observations and production verification are still in development.

## Boundaries

- **Git** owns source history.
- **GitHub** owns PR and merge facts.
- **Agent runtimes** own live sessions.
- **Trusted runners** produce allowed evidence.
- **Graphyard** owns coordination and progression.

Herdr is the first packaged runtime integration. Codex, Claude, OpenCode, custom agents, and humans can use the same CLI and HTTP protocol.

## Try it locally

Requires Node 24, Git, Docker Engine, and Docker Compose.

```sh
git clone https://github.com/cryptob1/graphyard.git
cd graphyard
npm ci
cp .env.example .env
# Replace every example credential in .env.
docker compose up -d db
npm run build
npm start
```

Open `http://localhost:4310`. Use the operator token from `.env`.

For a real repository with Railway, GitHub protection, Herdr, a master, and workers, follow [repository onboarding](docs/onboarding.md). The package is not published to npm yet; run the CLI from a Graphyard checkout.

## Deploy

Graphyard is one application container plus Postgres. Use the included Dockerfile with [Railway or Docker Compose](docs/deployment.md). It does not require Temporal, LangGraph, Redis, or Kubernetes.

## Documentation

Start at the [documentation index](docs/README.md). It separates setup and daily-use guides from operator reference, internals, roadmap, and historical records.

## Contribute

Read [AGENTS.md](AGENTS.md) and the [development guide](docs/development.md), then run:

```sh
npm run build
npm test
```

Apache 2.0 licensed.
