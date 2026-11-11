# Graphyard

**Run AI coding agents like Claude Code and Codex on your repository, and ship each goal from one sentence to production with independent review and proof.**

[![Graphyard walkthrough: a goal moves from the master to a worker, through spec check, independent review and a merge trial on the latest main, then deploys, with automatic revert on failure](docs/diagrams/how-graphyard-works.gif)](docs/diagrams/how-graphyard-works.mp4)

## Why Graphyard

- **You decide only goals, money and credentials.** An AI master plans everything else.
- **Every change is proven.** Workers build, a separate agent reviews, and the merge writer trials each head on the latest main.
- **Production stays safe.** Main deploys itself; a failing release is reverted automatically.

## Quick start

In your repository's checkout, on a Linux host with Node 24+, Git, Docker and the GitHub CLI signed in (`gh auth login --scopes repo`):

```sh
npx @cryptob1/graphyard up --repo OWNER/NAME
```

It installs Graphyard and prints a Setup link: open it and connect accounts for the worker and reviewer roles (`--master codex` runs a Codex master; `--local` skips Docker for the control plane). Then file a goal in **New work item** with acceptance criteria and required proof names, and watch it with `npx @cryptob1/graphyard master status`. Graphyard updates itself daily; `npx @cryptob1/graphyard upgrade --plan`, then `npx @cryptob1/graphyard upgrade`, updates it now. Installs share your main Herdr.

## Learn more

- `graphyard guide TOPIC` and `graphyard master guide` print the procedures agents follow; `graphyard --help` lists every command.
- [Re-render the walkthrough](docs/walkthrough.md) · [Contributing](AGENTS.md) · [Apache 2.0](LICENSE)

Operators and maintainers can change priority (P0–P3) on a work row or item page. Changes record who changed it and why in History; the next dispatch uses the new priority. Existing P4 items retain P4 until changed. `graphyard priority GY-N 0|1|2|3 REASON` and `graphyard master priority GY-N 0|1|2|3 REASON` require an audit reason.
