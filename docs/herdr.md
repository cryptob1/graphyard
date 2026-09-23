<!-- page: Operate Graphyard | 4 | workers, hosts. -->
# Herdr integration

For an operator installing workers, and what a live session does not prove.

## Install the plugin


```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

## Use the ledger

Run **Open Graphyard control plane** from Herdr.

- **Pane commands:** `list`, `show GY-1`, `claim GY-1`, `handoff GY-1`, `heartbeat GY-1 1`, `release GY-1 1` and `quit`; `claim` returns an epoch but proves no session started, `handoff` prints the assigned worktree and launch command
- **Master-created foreground launches:** Linux with a systemd user manager

## Multiple machines

All machines use the same Graphyard URL.


## Automated recovery contract

`integration:herdr-recovery` is the trusted contract, run from protected source against a candidate container holding no producer credential, driving only the public HTTP API with two worker principals, two host IDs and two non-overlapping worktree reservations:

- **`exclusive-claim`:** sixteen concurrent claims from two machines produce one lease and one claim event
- **`expiry-recovery`:** lease expires without a heartbeat, the stopped machine cannot renew it, the second claims the next epoch
- **`stale-owner-refused`:** heartbeat, release, workspace, submit, blocked, quarantine, launch, rereview and a fresh claim all refuse for the superseded owner
