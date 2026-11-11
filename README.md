# Graphyard

**Run AI coding agents like Claude Code and Codex on your repository, and ship each goal from one sentence to production with independent review and proof.**

[![Graphyard walkthrough: a goal moves from the master to a worker, through spec check, independent review and a merge trial on the latest main, then deploys, with automatic revert on failure](docs/diagrams/how-graphyard-works.gif)](docs/diagrams/how-graphyard-works.mp4)

The four roles are worker, reviewer, producer and master.

## Why Graphyard

- **You decide only goals, money and credentials.** An AI master plans the rest.
- **Every change is proven.** Workers build, another agent reviews, and each head is trialled on the latest main.
- **Production stays safe.** Main deploys itself; failing releases revert automatically.

## Prerequisites

| Prerequisite (Linux host) | Check |
| --- | --- |
| Linux 7.0+ with Landlock ABI 9+ enabled | `uname -r` (doctor checks the ABI) |
| Node.js 24+ and npm | `node --version && npm --version` |
| Git; durable checkout with an SSH origin | `git --version && git rev-parse --show-toplevel && git remote -v` |
| Docker Engine usable by your user (merge trials need it even with `--local`) | `docker version` |
| Docker Compose plugin | `docker compose version` |
| GitHub CLI signed in with repo scope and admin access | `gh auth status && gh repo view OWNER/NAME --json viewerPermission` |
| Bubblewrap (worker confinement) | `bwrap --version` |
| Python 3 (Landlock probe) | `python3 --version` |
| Herdr (`up` installs it if absent) | `herdr --version` |
| systemd user manager | `systemctl --user status` |

Install bubblewrap with `sudo apt install bubblewrap` or `sudo pacman -S bubblewrap`; sign in with `gh auth login --scopes repo`. If deploy keys are disallowed, pass `--merge-token-stdin` a fine-grained token with Contents read/write. No GitHub App is needed. Preview `up`'s checks with `npx @cryptob1/graphyard install --repo OWNER/NAME --plan` (`--provider local` for local mode).

## Quick start

From your repository's checkout:

```sh
npx @cryptob1/graphyard up --repo OWNER/NAME
```

It prints a Setup link: open it and connect accounts for the worker and reviewer roles (`--master codex` runs a Codex master; `--local` skips Docker for the control plane). File a goal in **New work item** with acceptance criteria and required proof names; watch with `npx @cryptob1/graphyard master status`. Graphyard updates daily; `npx @cryptob1/graphyard upgrade --plan`, then `npx @cryptob1/graphyard upgrade`, updates now. In Setup, the operator can invite viewers or maintainers with a one-time sign-in link and revoke invitations made there.

Run `npx @cryptob1/graphyard doctor` in the checkout to check credentials, agent logins, confinement, the kernel and services; failed checks print the fix.

## Reviewer runtimes

Reviews run once, headlessly, on the host master loop, with the selected account home, tool policy and credential masking. Workers and the master still use Herdr. Claude, Codex, Cursor, Pi, OpenCode and Muse have built-in one-task forms. Other runtimes require `launch.headlessArgs` in their registry runtime (`master registry runtime set NAME --headless-arg=ARG … --reason REASON`, or `NAME|@FILE`).

`headlessArgs` replaces `launch.args` and the built-in one-task form. It must contain exactly one `{request}` argument and must exit after answering. A leading subcommand comes first, then the launch's approval, role-policy, model, tool and harness flags, then the remaining contract arguments. For example:

```json
{"name":"muse","launch":{"kind":"muse","headlessArgs":["exec","{request}"]}}
{"name":"custom","launch":{"kind":"kilo","headlessArgs":["ONE_TASK_SUBCOMMAND","--prompt","{request}"]}}
```

Replace the custom example with that runtime's documented one-task arguments. Arguments and the prompt are passed literally, without shell expansion or a PTY; the shared detached supervisor only records output and exit status. Missing contracts are configuration refusals, never pane fallbacks. Dispatch observes each child's first second: an early login or limit exit holds its account and starts the next eligible account before returning; a still-running review continues in the background under the existing timeout. A confined master leaves its durable request for the host loop. `.graphyard/reviews.json` links each stable `headless.id` and actual `headless.kind` to its exact head/base/policy and verdict ID, including after restart adoption.

## Learn more

- `graphyard guide TOPIC` and `graphyard master guide` print the procedures agents follow; `graphyard --help` lists every command.
- [Re-render the walkthrough](docs/walkthrough.md) · [Contributing](AGENTS.md) · [Apache 2.0](LICENSE)

## Publishing

When a verified commit deploys, Graphyard pushes its `vYYYY.M.D-<sha12>` tag. GitHub Actions then publishes `@cryptob1/graphyard` with npm OIDC provenance, and both GHCR images (`graphyard`, `graphyard-trial`) with `GITHUB_TOKEN`; the host holds no publish token. Publishing runs apart from merge and deploy; `graphyard master status` shows npm's latest version.

One-time owner setup:

1. From your npm login, publish a `@cryptob1/graphyard` placeholder `0.0.0` with `npm publish --access public`.
2. In npm package settings, add a **Trusted Publisher**: GitHub Actions, **cryptob1/graphyard**, workflow **publish.yml**.
3. In each GHCR package (**graphyard**, **graphyard-trial**), grant **cryptob1/graphyard** Actions write access.
