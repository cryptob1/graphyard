# Master-agent operating mode

The master is a dedicated coordinator session. It reads Graphyard, watches Herdr health, routes ready work, handles handoffs, and requests guarded merges. It does not implement work, hold worker leases, or produce evidence.

Graphyard remains the source of truth. Herdr only reports live session health.

## Install

Create a `coordinator` principal on the Graphyard server. From a clean coordinator checkout, list Herdr workspaces and bind the master to this repository's workspace:

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
herdr workspace list
node "$GRAPHYARD_CLI" master init \
  --url https://YOUR-GRAPHYARD-HOST \
  --herdr-workspace HERDR_WORKSPACE_ID \
  --token-stdin
node "$GRAPHYARD_CLI" master start codex
```

At the token prompt, paste the token, press Enter, then press Ctrl-D to send EOF. Use `master start claude` if preferred. Setup preserves existing repository instructions and stores the coordinator token outside the repository.

Run the coordinator under a dedicated OS identity or machine. Implementation agents running as the same OS user may read its GitHub CLI credentials; Graphyard tokens cannot create a filesystem boundary.

## Add a worker

Use a template:

- [Codex](../examples/master/codex-worker.json)
- [Claude](../examples/master/claude-worker.json)
- [existing session](../examples/master/existing-worker.json)

A launch profile points to a mode-0600 worker-token file outside every repository worktree:

```sh
node "$GRAPHYARD_CLI" master worker add /path/to/profile.json
node "$GRAPHYARD_CLI" master status
```

Provider login and Graphyard identity are separate. Profiles cannot contain Graphyard variables or secret-looking environment values.

`launch` profiles are supervised and can receive new work. `existing` profiles add health visibility for a session that already owns work; Graphyard will not inject a new assignment into an unsupervised process.

Local dispatch requires Linux with a working systemd user manager for durable containment. On macOS or Linux without user systemd, route work to a separately supervised remote worker instead.

## Operate

```sh
node "$GRAPHYARD_CLI" master status
node "$GRAPHYARD_CLI" master dispatch GY-42 codex-primary
node "$GRAPHYARD_CLI" master merge GY-42
node "$GRAPHYARD_CLI" master merge --all
```

Run `status` at startup, after dispatch, when a worker reports completion, and when an integration event arrives. Owners, stages, refusals, and merge candidates come from Graphyard. Missing Herdr telemetry never erases an assignment.

Dispatch:

1. verifies the item is claimable;
2. authenticates the selected worker profile;
3. fetches the current base;
4. claims under the worker's identity;
5. creates the assigned worktree;
6. launches the agent under `graphyard watch`;
7. cleans up and releases only when failed launch shutdown is confirmed.

Prompt delivery is an invitation, not ownership.

## Secure multi-machine topology

The recommended boundary is:

- master and merge-capable GitHub CLI on a coordinator machine or OS identity;
- workers on separate machines or identities;
- worker GitHub credentials can push and open PRs but cannot merge the protected branch.

Version 0.1 cannot remotely launch a supervised Herdr tab on another host. The master selects the item; the remote worker claims it through its local plugin or CLI. Local launch profiles are for trusted dogfooding or a real isolation boundary.

## Guarded merges

A master merge succeeds only when Graphyard has a current authorization for the exact PR head, base, and policy. Immediately before the GitHub call, Graphyard rechecks:

- every gate and current evidence;
- PR head, base, draft state, and mergeability;
- CI producer identity and current-head review;
- strict branch protection and the App-owned required check;
- a short-lived, single-use merge execution.

The command never uses an admin bypass. Graphyard marks Done only after independently observing the matching merge. Direct or late merges remain visible violations.

Use `master init --no-auto-merge` when an operator must approve each merge request. This preference does not weaken the checks.

For the full correctness model, see [GitHub enforcement](github.md) and [architecture](architecture.md).

## Recovery

For a dead worker or provider change:

1. stop the old worker and supervisor;
2. release or let the lease expire;
3. request operator rework if a candidate was already submitted;
4. claim with the replacement worker at a higher epoch;
5. create a fresh workspace and preserve the old attempt.

The master does not clear blockers, revise requirements, or satisfy human gates on its own. See [operations](operations.md) for recovery commands.
