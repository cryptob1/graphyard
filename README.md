# Graphyard

**Turn a fleet of coding agents into an engineering system.**

Graphyard is an open-source control plane for coding agents across machines and worktrees. Agent sessions, hosted by runtimes such as Herdr, write the code; Graphyard records ownership, dependencies, evidence, gate decisions, and the exact change allowed to merge.

```text
Backlog → Ready → Build → Review → Test → Acceptance → Merge → Done
```

A card stops at its first refusing gate and says what is missing. Only an observed, authorized merge makes work Done.

[Install](docs/install.md) · [How it works](docs/how-graphyard-works.md) · [Glossary](docs/glossary.md) · [Onboard a repository](docs/onboarding.md) · [Documentation](docs/README.md)

## What it does

- **Work ledger** — intent, dependencies, blockers, ownership, append-only history.
- **Claims and worktrees** — atomic claims, expiring leases, fenced epochs, reserved branches.
- **Evidence-backed gates** — proof bound to the candidate commit, base and policy revision.
- **GitHub enforcement** — PR, review, CI and merge observations with an App-owned required check.
- **Runtimes** — Herdr first; Codex, Claude Code, opencode and custom agents use the same CLI and HTTP protocol.

## Install

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
cd /path/to/your-repository
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --plan
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply
```

One command sets up Postgres, the application, HTTPS, credentials, the GitHub App, branch protection and agent profiles; `--plan` changes nothing and `--apply` is idempotent. **[docs/install.md](docs/install.md) is the primary install path**, written for a coding agent to follow; [deployment](docs/deployment.md) is the provider reference. To evaluate locally, use `--provider compose` ([quickstart](docs/quickstart.md)).

## Contribute

Read [AGENTS.md](AGENTS.md) and the [development guide](docs/development.md); run `npm run build` and `npm test`. Apache 2.0.
