# Graphyard

Graphyard is a control plane for AI agents on a repository. Agents build, verify, review and release. The human keeps three decisions: goals and priorities, spending money or opening accounts, and issuing credentials to people.

## Start here: setup and docs

One command, then the [setup checklist](docs/setup-from-zero.md):

```sh
graphyard up --agent --goal GOAL.md
```

[Install](docs/install.md) · [How it works](docs/how-graphyard-works.md) · [Onboard](docs/onboarding.md) · [Docs](docs/README.md)

**[docs/install.md](docs/install.md)** is the primary install path (`install --provider railway|hetzner|compose`). Contribute: [AGENTS.md](AGENTS.md), [development](docs/development.md). Licence: [Apache 2.0](LICENSE).

## How it works

1. You give Graphyard a goal in a plain-language file.
2. A planner turns the goal into small work items with acceptance criteria.
3. A worker builds each work item on its own branch.
4. Graphyard checks the merged tree: build, tests and the change's E2E cases against its preview, before the merge to main.
5. An independent agent reviews, before the merge for sensitive changes and after the merge for everything else, by default.
6. About every ten merges a release candidate goes to a test environment for UAT + E2E.
7. A passing candidate is promoted to production and checked there: production verified.
8. A failure anywhere is reverted or fixed by a new work item.

graphyard.json sets sensitive paths (`risk.sensitive`) and normal-change review timing (`review.normalChanges`): [delivery](docs/delivery.md). Only Graphyard writes to main, merging PRs passing every check.

```mermaid
flowchart LR
  A[Goal] --> B[Planner] --> C[Work items] --> D[Worker builds] --> E[Graphyard checks the merged tree]
  E --> F[Merge to main] -->|normal: after| G[Review]
  E -.->|sensitive: before| G -.-> F
  F --> H[Release candidate] --> I[UAT + E2E] --> J[Production verified]
  I -.->|failure: new work item| C
```

Text equivalent: steps 1-8.
