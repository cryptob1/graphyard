# Herdr integration

Herdr is Graphyard's first launch integration. The root `herdr-plugin.toml` follows the installed Herdr plugin format and declares a ledger pane and an action to open it. The adapter uses the public HTTP API; Graphyard does not depend on Herdr internals to enforce ownership.

## Install

Requires Node 24 and Herdr with native plugin support (manifest minimum 0.7.1). From a local checkout:

```sh
herdr plugin link /absolute/path/to/graphyard --enabled
herdr plugin config-dir graphyard
```

Create `config.json` in the printed directory:

```json
{
  "url": "https://YOUR-GRAPHYARD-HOST",
  "token": "YOUR_INDIVIDUAL_WORKER_OR_READER_TOKEN"
}
```

Restrict the file to your user with `chmod 600 config.json`. Alternatively supply `GRAPHYARD_URL` and `GRAPHYARD_TOKEN` to Herdr's plugin environment. Do not configure an operator or trusted CI credential in an implementation agent's environment.

Once this repository is accessible to Herdr's installer, `herdr plugin install cryptob1/graphyard` is the intended repository install route. Private repository access depends on your Herdr/GitHub authentication; the local-link path is the reproducible bootstrap route.

## Use

Invoke **Open Graphyard control plane** from Herdr's plugin actions. The ledger pane supports:

```text
list
show GY-1
claim GY-1
heartbeat GY-1 1
release GY-1 1
quit
```

The pane displays each task's current stage, owner, and first refusal. Claiming work does not launch another agent, acknowledge a prompt, or start a background heartbeat. It returns the assignment epoch and next commands. The lease expires after two minutes unless a worker acknowledges ownership through renewal.

For execution, create or register an isolated worktree, then launch the desired agent under the CLI supervisor in that workspace:

```sh
graphyard watch GY-1 1 -- YOUR_AGENT_COMMAND
```

Here `graphyard` means the locally installed bin or `node /path/to/graphyard/bin/graphyard.mjs`; the npm package has not been published. If Herdr owns process launch, it can instead call the HTTP heartbeat endpoint and stop the agent when renewal fails. Do not heartbeat merely because prompt delivery succeeded: renew only for an acknowledged live worker.

## Many machines

Every machine points to the same Graphyard URL and receives individual worker credentials. Use stable, unique host IDs for worktree registration. Herdr's remote session transport is independent of Graphyard's network protocol.

The Graphyard server never needs SSH access or local paths mounted from worker machines. Worktree actions execute where Herdr or the agent runs. The server validates reservations and provider-observed PR branches.

## First fleet test

After the MVP is deployed and GitHub protection is active:

1. Create two independent work items and one dependent item.
2. Launch workers on two hosts in distinct worktrees with distinct credentials.
3. Race both workers for one item and confirm exactly one gets a lease.
4. Stop a worker before submission, wait for expiry, and reclaim from the other host.
5. Attempt a heartbeat and submission with the old epoch; both must refuse.
6. Submit a PR, attach stale evidence, and confirm merging remains blocked.
7. Produce current trusted evidence and review; verify the required check passes.
8. Merge and observe completion, then confirm the dependency becomes claimable.

Record actual evidence in Graphyard. The automated local race tests are useful kernel validation; they are not a substitute for this Herdr/multi-host acceptance test.

## Next plugin work

Automated dispatch/ACK handling, agent-specific lifecycle hooks, and rich Herdr pane rendering are intentionally deferred until this basic protocol is exercised with real sessions. No multiple-agent session is launched during the initial single-agent build.
