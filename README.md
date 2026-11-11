# Graphyard

**Run AI coding agents like Claude Code and Codex, ship each goal to production with independent review and proof.**

[![Graphyard walkthrough: goal through review, merge trial, deploy, revert](docs/diagrams/how-graphyard-works.gif)](docs/diagrams/how-graphyard-works.mp4)

## Why Graphyard

- **You decide goals, money, credentials.** An AI master plans the rest.
- **Every change is proven.** Workers build, agents review, heads are trialled on main.
- **Production stays safe.** Main deploys itself; failures revert automatically.

Prerequisites (Linux host): Linux 7.0+ with Landlock ABI 9+ (`uname -r`); Node/npm (`node --version`, `npm --version`); Git durable SSH checkout (`git --version`, `git remote -v`); Docker and Compose (merge trials need them even `--local`) (`docker version`, `docker compose version`); GitHub CLI admin login (`gh auth status`); bubblewrap (`bwrap --version`); Python (`python3 --version`); Herdr (`herdr --version`); systemd (`systemctl --user status`). `graphyard guide setup` explains.

## Quick start

```sh
npx @cryptob1/graphyard up --repo OWNER/NAME
```

It prints a Setup link: connect worker and reviewer accounts, file goals under **New work item** with acceptance criteria and required proof names. Reviews run headless: six built-in forms, others declare `launch.headlessArgs` (`graphyard guide runtimes`). Watch with `graphyard master status`; update via `graphyard upgrade --plan` then `graphyard upgrade`; `graphyard doctor` verifies. Setup invites or revokes viewers and maintainers.

## Learn more

- `graphyard guide TOPIC` and `graphyard master guide` print every procedure.
- Verified deploys publish `@cryptob1/graphyard` with npm OIDC provenance plus both GHCR images via Actions — no host publish token. `graphyard guide publishing` covers owner setup.
- [Re-render the walkthrough](docs/walkthrough.md) · [Contributing](AGENTS.md) · [Apache 2.0](LICENSE)
