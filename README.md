# Graphyard

**Run AI coding agents like Claude Code and Codex, ship each goal to production with independent review and proof.**

[![Graphyard walkthrough: goal through review, merge trial, deploy, revert](docs/diagrams/how-graphyard-works.gif)](docs/diagrams/how-graphyard-works.mp4)

## Why Graphyard

- **You decide goals, money, credentials.** An AI master plans the rest.
- **Every change is proven.** Workers build, agents review, heads are trialled on main.
- **Production stays safe.** Main deploys itself; failures revert automatically.

Prerequisites (Linux host): Linux 7.0+ with Landlock ABI 9+ (`uname -r`); Node/npm (`node --version`, `npm --version`); Git durable SSH checkout (`git --version`, `git remote -v`); Docker and Compose (merge trials need them even `--local`) (`docker version`, `docker compose version`); GitHub CLI admin login (`gh auth status`); bubblewrap (`bwrap --version`); Python (`python3 --version`); Herdr (`herdr --version`); systemd (`systemctl --user status`). `graphyard guide setup` explains.

## Where things run

![Diagram of where every part of Graphyard runs: the host's units, containers, Herdr, agent worktrees and files, and the outside services](docs/diagrams/where-things-run.svg)

One Linux host runs everything. Two systemd user units — `graphyard-master-OWNER-NAME.service` (the loop: dispatch, merge writer, batch gate; `journalctl --user -u graphyard-master-OWNER-NAME.service`) and `graphyard-deploy-OWNER-NAME.service` (the deploy watch; `journalctl --user -u graphyard-deploy-OWNER-NAME.service`) — work from one shared checkout whose `.graphyard/` holds the connection, the units record and every agent worktree; credentials and CLI releases stay in `~/.config/graphyard/<install>/`. Docker runs the control-plane server `graphyard-OWNER-NAME-server-1` (serving the dashboard on 127.0.0.1:4310; `docker logs graphyard-OWNER-NAME-server-1`) beside its Postgres `graphyard-OWNER-NAME-db-1` (`docker logs graphyard-OWNER-NAME-db-1`), one short-lived `graphyard-trial-…` container per merge trial, and any compose services a check declares. The master pane lives in Herdr; headless workers, reviewers and producers run confined by bubblewrap and Landlock. Outside the host: GitHub (every part fetches; only the merge writer pushes), agent providers, npm/GHCR (published by GitHub Actions), and your browser over localhost or the tailnet. `graphyard guide infra` tabulates it, and the Setup page's panel shows this install's own values.

## Quick start

```sh
npx @cryptob1/graphyard up --repo OWNER/NAME
```

The Setup link connects worker and reviewer accounts, file goals under **New work item**: title and optional description; the master writes the criteria; **Advanced** takes full detail. Workers and reviewers run headless, logged per item (`graphyard guide runtimes`). Where a SAML organization or org policy blocks deploy keys, `--push-auth gh` pushes with your gh login instead of a deploy key. Watch: `graphyard master status`; update: `graphyard upgrade --plan` then `graphyard upgrade`; `graphyard doctor` verifies. Setup invites or revokes viewers and maintainers.

## Learn more

- `graphyard guide TOPIC` and `graphyard master guide` print every procedure.
- Verified deploys publish `@cryptob1/graphyard` with npm OIDC provenance plus both GHCR images via Actions — no host publish token. `graphyard guide publishing` covers owner setup.
- [Re-render the walkthrough](docs/walkthrough.md) · [Contributing](AGENTS.md) · [Apache 2.0](LICENSE)
