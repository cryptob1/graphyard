<!-- page: Operate Graphyard | 4 | worker setup and multiple machines. -->
# Herdr integration

Herdr launches, shows and stops sessions; Graphyard owns leases, evidence and progression.

## Install the plugin

Requires Node 24 and Herdr 0.7.1+ (0.9.1+ and an authenticated `muse` executable for Muse). From the managed repository, with an individual worker token:

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Paste the token, Enter, Ctrl-D. Commit the updated `AGENTS.md` and `.gitignore`, never `.graphyard/`. Rerun `init` after moving the checkout or changing servers.

## Use the ledger

**Open Graphyard control plane** in Herdr accepts `list`, `show GY-1`, `claim GY-1`, `handoff GY-1`, `heartbeat GY-1 1`, `release GY-1 1`, `quit`. Run workers supervised:

```sh
node "$GRAPHYARD_CLI" watch GY-1 EPOCH -- YOUR_AGENT_COMMAND
```

On Windows `watch` stops only the direct child; master-created launches need Linux with a systemd user manager. For several workers use the [master agent](master-agent.md); Muse is `kind: "muse"` in a launch profile ([Muse](master-agent-sessions.md#muse)).

## Multiple machines

All machines share one Graphyard URL. Each worker needs its own principal, a stable host ID, its own worktree, and a GitHub identity that cannot merge the protected branch. Master launch profiles run on the coordinator host.

## First fleet check

1. Race two workers for one item; one claim wins.
2. Stop the winner; reclaim after expiry.
3. Confirm the old epoch is refused.
4. Submit stale evidence; acceptance stays closed.
5. Supply current review and proof, merge through the master, observe Done.

## Automated recovery contract

`integration:herdr-recovery` (`scripts/herdr-recovery-contract.mjs`) proves steps 1–3 over the HTTP API with two workers and two hosts. It refuses candidates that shorten the two-minute fences and does not prove a real process stopped; see the [two-machine drill](coordination.md#two-machine-operational-drill), [operations](operations.md#lost-worker-before-submission) and [adding a trusted contract](first-pr.md#adding-a-trusted-contract).
