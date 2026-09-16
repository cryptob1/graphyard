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

A direct `watch` invocation stops the worker process group on Unix. On Windows it can stop only the direct child, so use external containment if the agent may spawn descendants. Master-created foreground Herdr launches require Linux with a working systemd user manager. See [operations](operations.md) for recovery.

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

## Automated recovery contract

`integration:herdr-recovery` is the trusted contract behind steps 1 to 3 of that check. It runs from protected source in `scripts/herdr-recovery-contract.mjs` against a candidate container that holds no producer credential, and it drives only the public HTTP API with the identities Graphyard authenticates: two worker principals, two host IDs, and two non-overlapping worktree reservations.

Its fixed inventory is:

| Case | What it establishes |
| --- | --- |
| `exclusive-claim` | Sixteen concurrent claims from two machine identities produce one lease and one claim event. |
| `expiry-recovery` | The lease expires without a heartbeat, the stopped machine cannot renew it, and the second machine claims the next epoch. |
| `stale-owner-refused` | Heartbeat, release, workspace, submit, blocked, quarantine, launch, and a fresh claim all refuse for the superseded owner. |
| `isolated-worktrees` | The replacement cannot reserve the stopped machine's branch or an overlapping path, registers its own worktree, and the earlier reservation is retained. |
| `supervised-fence-recovery` | A supervised worker that quarantined containment and stopped without settling keeps the item fenced until operator rework; afterwards its settlement capability no longer applies and the second machine owns the work. |

The contract waits on the lease and launch fences the candidate itself reports, measured by the candidate's clock, so it exercises the shipped two-minute defaults rather than a test-only timeout. Dispatch it as described in [repository bootstrap](first-pr.md#bootstrap-sequence).

This proves the control-plane contract for cross-machine recovery. It does not start Herdr, does not run two physical hosts, and does not prove that a disconnected agent process stopped. The [two-machine operational drill](coordination.md#two-machine-operational-drill) remains the procedure for real hosts, and [operations](operations.md#lost-worker-before-submission) covers recovery in production.

For exact API behavior, read the [agent protocol](protocol.md). For the complete installation path, read [onboarding](onboarding.md).
