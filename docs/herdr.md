<!-- page: Operate Graphyard | 4 | worker installation, multi-machine use. -->
# Herdr integration

For an operator installing workers, and what a live session does not prove.

## Install the plugin

Requires Node 24, Herdr 0.7.1 or newer and a Graphyard checkout; supervised Muse launch and lifecycle detection need Herdr 0.9.1 or newer and an installed, provider-authenticated `muse` executable.

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

## Use the ledger

Run **Open Graphyard control plane** from Herdr. The pane supports `list`, `show GY-1`, `claim GY-1`, `handoff GY-1`, `heartbeat GY-1 1`, `release GY-1 1` and `quit`. `claim` returns an epoch but does not prove a session started; `handoff` prints the assigned worktree and launch command. Run worker sessions under lease supervision with `node "$GRAPHYARD_CLI" watch GY-1 EPOCH -- YOUR_AGENT_COMMAND`: `watch` stops the worker process group on Unix, but on Windows only the direct child, so use external containment if the session may spawn descendants. Master-created foreground launches need Linux with a working systemd user manager.

## Multiple machines

All machines use the same Graphyard URL. Give each worker a unique principal and token, a stable host ID, its own local worktree and a GitHub identity that cannot merge the protected base branch. Graphyard needs no SSH access or mounted worker filesystems: it records workspace reservations and verifies the pull-request branch through GitHub. Optional `displayName` and `runtime` fields in `GRAPHYARD_PRINCIPALS` control labels such as **Atlas · Codex**, but the authenticated principal determines ownership, and renaming affects future claims without rewriting history.

## Automated recovery contract

`integration:herdr-recovery` is the trusted contract behind those steps. It runs from protected source against a candidate container holding no producer credential, driving only the public HTTP API with the identities Graphyard authenticates: two worker principals, two host IDs and two non-overlapping worktree reservations.

- `exclusive-claim`: Sixteen concurrent claims from two machine identities produce one lease and one claim event
- `expiry-recovery`: The lease expires without a heartbeat, the stopped machine cannot renew it, and the second machine claims the next epoch
- `stale-owner-refused`: Heartbeat, release, workspace, submit, blocked, quarantine, launch, rereview and a fresh claim all refuse for the superseded owner
- `isolated-worktrees`: The replacement cannot reserve the stopped machine's branch or an overlapping path, registers its own worktree, and the earlier reservation is retained
- `supervised-fence-recovery`: A supervised worker that quarantined containment and stopped without settling keeps the item fenced: rework is refused while the fences are live, and surrendering the lease does not lift launch authority. After both expire, rework succeeds and the second machine owns the work

