# Graphyard

**Turn a fleet of coding agents into an engineering system.**

Graphyard is an open-source control plane for coordinating coding agents across machines and worktrees. Agent sessions, hosted by runtimes such as Herdr, write the code. Graphyard records ownership, dependencies, evidence, gate decisions, and the exact change allowed to merge.

```text
Backlog → Ready → Build → Review → Test → Acceptance → Merge → Done
```

A card stops at its first refusing gate and explains what is missing. `graphyard complete` submits an implementation; only an observed, authorized merge makes work Done.

[Install](docs/install.md) · [How it works](docs/how-graphyard-works.md) · [Glossary](docs/glossary.md) · [Onboard a repository](docs/onboarding.md) · [Documentation](docs/README.md)

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
- **Agent runtimes** such as Herdr own live agent sessions.
- **Proof producers** (CI workflows and trusted runners) produce trusted evidence.
- **Graphyard** owns coordination and progression.

Herdr is the first packaged runtime integration. Codex, Claude Code, opencode, custom agents, and human operators can use the same CLI and HTTP protocol.

## Install

One command installs a complete control plane for a GitHub repository — Postgres, the
application, an HTTPS URL, every credential, the GitHub App and webhook, branch protection,
agent profiles, and a verification pass.

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
cd /path/to/your-repository

node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --plan
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply
```

`--plan` prints every action and value with secrets redacted and changes nothing; `--apply`
executes the same plan and is idempotent. Providers are `railway`, `hetzner`, `docker-host`,
and `compose`. A person is asked for four things: which provider, the provider login, one
GitHub App confirmation click, and approval of the plan.

**[docs/install.md](docs/install.md) is the primary install path.** It is an
agent-executable runbook, so `install Graphyard for OWNER/REPO on railway following
docs/install.md` is a complete instruction for a coding agent. Graphyard is not published to
npm yet; run the CLI from a Graphyard checkout.

Graphyard is one application container plus Postgres. Every release publishes a versioned
image; the installer runs it on Railway, a Hetzner or Docker host, or Docker Compose, and
the ledger is backed up, upgraded and restored with the shipped `graphyard db` commands. It
does not require Temporal, LangGraph, Redis, or a hosted account; Kubernetes is supported
through the Helm chart, not required. [Deployment](docs/deployment.md) is the provider
reference behind the installer, including the full variables table and a manual fallback.

## Evaluate it on one machine

```sh
node "$GRAPHYARD_CLI" install --provider compose --repo OWNER/REPO --apply
```

See the [quickstart](docs/quickstart.md) for the local loop, and [repository
onboarding](docs/onboarding.md) for Herdr, a master, workers, and the first PR.

## Documentation

Start at the [documentation index](docs/README.md). It separates setup and daily-use guides from operator reference, internals, roadmap, and historical records.

## Contribute

Read [AGENTS.md](AGENTS.md) and the [development guide](docs/development.md), then run:

```sh
npm run build
npm test
```

Apache 2.0 licensed.
