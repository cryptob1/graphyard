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

## Publishing

After a verified commit deploys successfully, Graphyard pushes its `vYYYY.M.D-<sha12>` tag with the merge writer's deploy key. GitHub Actions publishes `@cryptob1/graphyard` with npm OIDC provenance and both GHCR images (`graphyard` and `graphyard-trial`, tagged by commit and `verified`) with `GITHUB_TOKEN`. The host holds no registry publish token. Publication runs separately from merge and deployment; `graphyard master status` shows npm's latest version alongside Graphyard's serving commit.

One-time owner setup:

1. From your own npm login, publish a minimal `@cryptob1/graphyard` placeholder at version `0.0.0` with `npm publish --access public` (the package must exist first).
2. In the npm package's settings, add a **Trusted Publisher**: GitHub Actions, owner **cryptob1**, repository **graphyard**, workflow **publish.yml**.
3. In each GHCR package's settings (**graphyard** and **graphyard-trial**), grant the **cryptob1/graphyard** repository Actions write access.

Actions and the offline installation proof both run `node scripts/build-publisher.mjs` to build `scripts/publish-verified.mjs` from TypeScript. The script reads `GRAPHYARD_PUBLISH_COMMIT`, `GRAPHYARD_IMAGE_REGISTRY`, `npm_config_registry` and `GITHUB_TOKEN` from its environment; Actions passes `--provenance` and uses Node 24, npm 11.5.2 and a fresh buildx builder. Local registry tests alone supply `NPM_TOKEN` through their environment. The post-deploy live check waits for owner setup, then checks the next release's npm version, embedded commit, workflow-linked provenance and both commit-tagged images.
