# Graphyard

**Run AI coding agents like Claude Code and Codex on your repository, and ship each goal from one sentence to production with independent review and proof.**

[![Graphyard walkthrough: a goal moves from the master to a worker, through spec check, independent review and a merge trial on the latest main, then deploys, with automatic revert on failure](docs/diagrams/how-graphyard-works.gif)](docs/diagrams/how-graphyard-works.mp4)

## Why Graphyard

- **You decide only goals, money and credentials.** An AI master plans everything else.
- **Every change is proven.** Workers build, a separate agent reviews, and the merge writer trials each head on the latest main.
- **Production stays safe.** Main deploys itself; a failing release is reverted automatically.

## Quick start

1. On a Linux host with Node 24+, Git, the GitHub CLI and Docker, clone Graphyard, run `npm ci`, put `bin/` on your PATH and run `gh auth login --scopes repo`.
2. In your repository's checkout, run `graphyard up --repo OWNER/NAME --provider compose --master claude` (or `--master codex`; `--provider local` skips Docker).
   Installs share your main Herdr, each in a `graphyard-OWNER-NAME` workspace.
3. Open the printed Setup link and connect accounts for the worker and reviewer roles.
4. File a goal in **New work item** with acceptance criteria and required proof names; watch it with `graphyard master status`.
5. Update with `graphyard upgrade --plan`, then `graphyard upgrade`.

## Learn more

- `graphyard guide TOPIC` and `graphyard master guide` print the procedures agents follow; `graphyard --help` lists every command.
- [Re-render the walkthrough](docs/walkthrough.md) · [Contributing](AGENTS.md) · [Apache 2.0](LICENSE)
