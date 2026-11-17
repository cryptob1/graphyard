# Graphyard

**Run AI coding agents like Claude Code and Codex, ship each goal to production with independent review and proof.**

[![Graphyard walkthrough: goal through review, merge trial, deploy, revert](docs/diagrams/how-graphyard-works.gif)](docs/diagrams/how-graphyard-works.mp4)

## Why Graphyard

- **You decide goals, money, credentials.** They wait under Needs you; blockers are the Master's.
- **Every change is proven.** Workers build, agents review, main trials each head.
- **Production stays safe.** Main deploys itself; failures revert automatically.

Prerequisites: Linux 7.0+ with Landlock ABI 9+ (`uname -r`; Ubuntu 26.04: `sudo apt install linux-image-oem-7.3`); Node 24+/npm (`node --version`, `npm --version`; Ubuntu/Debian: `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt install nodejs`, Arch: `sudo pacman -S nodejs npm`, macOS: `brew install node@24`); Git (`git --version`, `git remote -v`); Docker (`docker version`, `docker compose version`); GitHub CLI (`gh auth status`); bubblewrap (`bwrap --version`); Python (`python3 --version`); Herdr (`herdr --version`; install: `curl -fsSL https://herdr.dev/install.sh | sh`); systemd (`systemctl --user status`). [Setup guide](docs/setup.md).

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

The Setup link connects worker and reviewer accounts, file goals under **New work item**: title and optional description; the master writes the criteria; **Advanced** takes full detail. Work's **Taste** feed shows recent deliveries with why and evidence: **Looks good** records your call, **Send back** turns your note into a follow-up item and a proposed master lesson; nothing waits on a taste. `graphyard master status`; `graphyard upgrade --plan` then `graphyard upgrade`; `graphyard doctor` verifies. Sharing: one machine, many installs, one port each; two locks: tailnet plus per-install sign-in.

## Where things run

![Where every Graphyard part runs, on the host and outside it](docs/diagrams/where-things-run.svg)

`graphyard guide infra` lists every part.

## Learn more

- `graphyard guide setup`, `graphyard guide publishing`, `graphyard guide TOPIC` and `graphyard master guide` print procedures.
- [Shared server](docs/shared-server.md), [Re-render the walkthrough](docs/walkthrough.md), [Contributing](AGENTS.md), [Apache 2.0](LICENSE)
