# Herdr integration

Herdr is Graphyard's first launch integration. The root `herdr-plugin.toml` follows the installed Herdr plugin format and declares a ledger pane and an action to open it. The adapter uses the public HTTP API; Graphyard does not depend on Herdr internals to enforce ownership.

## Install

Requires Node 24 and Herdr with native plugin support (manifest minimum 0.7.1). From the repository you want to manage, invoke a local Graphyard checkout:

```sh
node /absolute/path/to/graphyard/bin/graphyard.mjs init --url https://YOUR-GRAPHYARD-HOST --herdr --token-stdin
```

Supply an individual worker token on standard input, then EOF (Ctrl-D). A password manager can pipe it in; do not put it in command arguments or shell history. `GRAPHYARD_TOKEN` is also supported. The npm package has not been published.

Setup authenticates the credential and requires the worker role. It saves the connection in ignored `.graphyard/connection.json` with mode 0600, updates one managed section in `AGENTS.md` while preserving your surrounding instructions, links the Herdr plugin disabled, saves its private configuration, and enables it last. Output contains connection metadata, never the token. Commit the updated `AGENTS.md`, not the local connection file.

Rerunning updates the managed section without duplicating it. Malformed markers and non-regular setup files are refused. A failed Herdr command can leave repository setup saved; fix the installation and rerun. Keep the Graphyard checkout at its configured absolute path, or rerun with the new launcher path. Linked worktrees inherit the main checkout's connection without copying credentials.

Without `--herdr`, setup only configures repository instructions and the CLI connection. Without a token, it saves an unverified connection and tells you to finish authentication. An explicit server change does not forward a saved token; supply the new server's credential explicitly.

For a read-only plugin, manually link it and configure a reader credential. Automated worker setup deliberately rejects reader, operator, and producer tokens. Never configure privileged credentials in an implementation agent's environment.

## Use

Invoke **Open Graphyard control plane** from Herdr's plugin actions. The ledger pane supports:

```text
list
show GY-1
claim GY-1
handoff GY-1
heartbeat GY-1 1
release GY-1 1
quit
```

The pane displays each task's current stage, owner, and first refusal. Claiming work does not launch another agent, acknowledge a prompt, or start a background heartbeat. It returns the assignment epoch and next commands. The lease expires after two minutes unless a worker acknowledges ownership through renewal.

After claiming, run `handoff GY-1` in the pane. It checks your live lease and machine identity, then prints worktree setup commands or the assigned workspace and supervisor command. It refuses expired ownership and workspaces on another host. Follow those commands to launch your desired agent:

```sh
graphyard watch GY-1 1 -- YOUR_AGENT_COMMAND
```

Here `graphyard` means the locally installed bin or `node /path/to/graphyard/bin/graphyard.mjs`; the npm package has not been published. If Herdr owns process launch, it can instead call the HTTP heartbeat endpoint and stop the agent when renewal fails. Do not heartbeat merely because prompt delivery succeeded: renew only for an acknowledged live worker.

## Many machines

Every machine points to the same Graphyard URL and receives individual worker credentials. Use stable, unique host IDs for worktree registration: pass `--host-id YOUR_MACHINE_ID` to init (default: hostname). Each independently running worker needs its own identity; do not share one worker token across concurrent sessions. The local plugin configuration currently selects one server and worker identity at a time. Herdr's remote session transport is independent of Graphyard's network protocol.

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
