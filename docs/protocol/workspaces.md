<!-- page: Agent protocol | 7 | worktree registration, branch and path uniqueness, and the launch fence. -->
# Workspaces

Register the exact branch, path and a stable host ID before submitting. Branches begin `graphyard/` and are globally unique; paths are unique per host, including historical reservations, and are normalized lexically (`..`, repeated separators and nesting are overlaps). Put the epoch in path and branch names.

```sh
node /path/to/graphyard/bin/graphyard.mjs register GY-1 workspace.json
```

Registration is worker-reported; the PR branch is provider-observed. For submitted rework, fetch the linked PR branch into a fresh clone. Cleanup is manual and must keep uncommitted work. The quarantine plus live lease is the final launch fence (see [leases](leases.md#watch)).
