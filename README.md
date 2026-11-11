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
