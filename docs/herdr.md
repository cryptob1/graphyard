# Herdr integration

Herdr runs visible agent sessions. Graphyard remains authoritative for work ownership, leases, evidence, and progression.

## Install the plugin

Requires Node 24, Herdr 0.7.1 or newer, and a Graphyard checkout.

From the managed repository, with an individual worker token:

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
node "$GRAPHYARD_CLI" init \
  --url https://YOUR-GRAPHYARD-HOST \
  --herdr \
  --host-id UNIQUE_MACHINE_NAME \
  --token-stdin
```

Paste the token, press Enter, then press Ctrl-D to send EOF. Setup verifies the worker and repository, updates the managed `AGENTS.md` section, stores the connection in ignored `.graphyard/connection.json`, and enables the plugin. Commit `AGENTS.md` and `.gitignore`; never commit `.graphyard/`.

Rerun `init` after moving the Graphyard checkout or changing servers. Each concurrent worker needs its own principal and token.

## Use the ledger

Run **Open Graphyard control plane** from Herdr. The pane supports:

```text
list
show GY-1
claim GY-1
handoff GY-1
heartbeat GY-1 1
release GY-1 1
quit
```

`claim` returns an epoch. It does not prove an agent started. `handoff` prints the assigned workspace and launch command. Run workers under lease supervision:

```sh
node "$GRAPHYARD_CLI" watch GY-1 EPOCH -- YOUR_AGENT_COMMAND
```

Durable `watch` containment requires Linux with a working systemd user manager. On Windows it can stop only the direct child, and macOS foreground supervision is refused; use a Linux VM/container or an external supervisor that terminates the full process tree. See [operations](operations.md) for recovery.

## Master mode

For several workers, use the [master-agent mode](master-agent.md). It joins Graphyard work state with Herdr session health, dispatches trusted local launch profiles, and requests guarded merges.

A visible session is health information, not ownership. Graphyard recognizes ownership only after the worker's authenticated claim.

## Multiple machines

All machines use the same Graphyard URL. Give each worker:

- a unique worker principal and token;
- a stable host ID;
- its own local worktree;
- a GitHub identity that cannot merge the protected base branch.

Graphyard does not need SSH access or mounted worker filesystems. It records workspace reservations and verifies the PR branch through GitHub.

Local master launch profiles run on the coordinator host. Version 0.1 does not remotely start supervised Herdr tabs across hosts. Remote workers claim work through their local plugin or CLI after the master routes it.

## Assignment names

Optional `displayName` and `runtime` fields in `GRAPHYARD_PRINCIPALS` control labels such as **Atlas · Codex**. The authenticated principal still determines ownership. Renaming a principal affects future claims and does not rewrite history.

## First fleet check

Before scaling:

1. race two identities for one item and confirm one claim wins;
2. stop the winner and reclaim after lease expiry;
3. confirm the old epoch is refused;
4. submit stale evidence and confirm acceptance stays closed;
5. supply current review and proof, merge through the master, and observe Done.

For exact API behavior, read the [agent protocol](protocol.md). For the complete installation path, read [onboarding](onboarding.md).
