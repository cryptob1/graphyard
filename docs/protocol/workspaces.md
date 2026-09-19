<!-- page: Agent protocol | 7 | worktree registration, branch and path uniqueness, and the launch fence. -->
# Workspaces

Herdr may create worktrees itself. Register the exact branch and a stable machine ID before submitting the PR. Branches must begin `graphyard/`. A branch is globally unique in this control plane; paths are unique per host, including historical reservations. Use the assignment epoch in path and branch names.

Paths are normalized lexically; aliases through `..`, repeated separators, and nested reservations on the same host are rejected as overlaps. The server cannot resolve remote symlinks or detect two host IDs naming the same machine. Use canonical paths and stable host IDs. For submitted rework, `next` includes the item and `worktree` preserves the linked PR branch. Fetch that branch first in a replacement clone; Git refuses if it is already checked out locally. No force-checkout or automatic cleanup is performed.

```sh
node /path/to/graphyard/bin/graphyard.mjs register GY-1 workspace.json
```

The server never assumes it can run Git on a remote host. Host/path registration is worker-reported; PR branch matching is provider-observed. Workspace cleanup is manual and must preserve uncommitted work.

The quarantine and live lease form the final launch fence. Its idempotent control-plane acknowledgement precedes process creation, and rework is transactionally refused for the entire live-lease response window. A stale, reassigned, expired, mismatched, or ambiguous acknowledgement never spawns the child; the supervisor retains its signal handlers through acknowledgement and any cancellation or settlement.
