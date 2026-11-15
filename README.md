# Graphyard

**Run AI coding agents like Claude Code and Codex, ship each goal to production with independent review and proof.**

[![Graphyard walkthrough: goal through review, merge trial, deploy, revert](docs/diagrams/how-graphyard-works.gif)](docs/diagrams/how-graphyard-works.mp4)

## Why Graphyard

- **You decide goals, money, credentials.** An AI master plans the rest.
- **Every change is proven.** Workers build, agents review, heads are trialled on main.
- **Production stays safe.** Main deploys itself; failures revert automatically.

Prerequisites: Linux 7.0+ with Landlock ABI 9+ (`uname -r`; Ubuntu 26.04: `sudo apt install linux-image-oem-7.3`); Node/npm (`node --version`, `npm --version`); Git SSH checkout (`git --version`, `git remote -v`); Docker and Compose, even `--local` (`docker version`, `docker compose version`; AppArmor hosts: up loads `graphyard-trial` with sudo); GitHub CLI admin login (`gh auth status`); bubblewrap (`bwrap --version`); Python (`python3 --version`); Herdr (`herdr --version`; install: `curl -fsSL https://herdr.dev/install.sh | sh`); systemd (`systemctl --user status`). `graphyard guide setup` explains.

## Quick start

```sh
git clone https://github.com/cryptob1/graphyard.git && cd graphyard
npm ci
npm run build
node bin/graphyard.mjs up --repo OWNER/NAME
```

Once published to npm:

```sh
npx @cryptob1/graphyard up --repo OWNER/NAME
```

The Setup link connects worker and reviewer accounts, file goals under **New work item**: title and optional description; the master writes the criteria; **Advanced** takes full detail. Workers and reviewers run headless, logged per item (`graphyard guide runtimes`). Where org policy blocks deploy keys, `--push-auth gh` pushes with your gh login. Watch: `graphyard master status`; update: `graphyard upgrade --plan` then `graphyard upgrade`; `graphyard doctor` verifies. Setup invites or revokes viewers and maintainers.

## Where things run

![Diagram of where every part of Graphyard runs, on the host and outside it](docs/diagrams/where-things-run.svg)

`graphyard guide infra` lists every part and its logs.

## Learn more

- `graphyard guide TOPIC` and `graphyard master guide` print procedures.
- Deploys publish `@cryptob1/graphyard` and both GHCR images; `graphyard guide publishing` covers setup.
- [Re-render the walkthrough](docs/walkthrough.md) · [Contributing](AGENTS.md) · [Apache 2.0](LICENSE)
