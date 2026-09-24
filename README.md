# Graphyard

**Turn a fleet of coding agents into an engineering system.**

Graphyard is an open-source control plane for coordinating coding agents across machines and worktrees. Agent sessions, hosted by runtimes such as Herdr, write the code. Graphyard records ownership, dependencies, evidence, gate decisions, and the exact change allowed to merge.

```text
Backlog → Ready → Build → Review → Test → Acceptance → Merge → Done
```

A card stops at its first refusing gate and says what is missing. `graphyard complete` submits an implementation; only an observed, authorized merge makes work Done.

[Install](docs/install.md) · [How it works](docs/how-graphyard-works.md) · [Glossary](docs/glossary.md) · [Onboard a repository](docs/onboarding.md) · [Documentation](docs/README.md)

## Why Graphyard

More agents means more coordination failures: overlapping claims, ownership left by dead processes, green checks on old commits, "done" without proof, merges that bypass the intended path. Graphyard makes those facts explicit and durable:

| Capability | Behavior |
| --- | --- |
| Work ledger | Intent, dependencies, blockers, ownership, append-only history |
| Claims and worktrees | Atomic claims, expiring leases, fenced epochs, reserved branches |
| Evidence-backed gates | Proof bound to candidate commit, base commit and policy revision |
| GitHub enforcement | PR, review, CI, protection and merge observations with an App-owned required check |
| Herdr integration | Setup, a ledger pane, supervised workers, a master mode |
| Test definitions | Versioned E2E scenarios and a packaged Playwright runner |

Git owns source history, GitHub owns PR and merge facts, agent runtimes own live sessions, proof producers produce evidence, and Graphyard owns coordination and progression. Codex, Claude Code, opencode and custom agents use the same CLI and HTTP protocol.

## Install

One command installs Postgres, the application, an HTTPS URL, every credential, the GitHub App and webhook, branch protection, agent profiles, and a verification pass:

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
cd /path/to/your-repository
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --plan
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply
```

`--plan` changes nothing; `--apply` is idempotent. Providers are `railway`, `hetzner`, `docker-host` and `compose`. **[docs/install.md](docs/install.md) is the primary install path**, written so a coding agent can follow it. Run the CLI from a Graphyard checkout (it is not on npm). [Deployment](docs/deployment.md) is the provider reference, including the variables table and a manual fallback.

To evaluate on one machine, use `--provider compose` and the [quickstart](docs/quickstart.md).

## Contribute

Read [AGENTS.md](AGENTS.md) and the [development guide](docs/development.md), then run `npm run build` and `npm test`. Apache 2.0 licensed.
