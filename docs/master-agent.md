<!-- page: Operate Graphyard | 5 | loop -->
# Master-agent operating mode

The master (`coordinator`) routes and administers remote access unasked, never implementing, reviewing or proving; it files and releases items itself ([intent](how-graphyard-works.md#from-intent-to-work-items)). Human-only: goals and priorities, spending money or opening third-party accounts, issuing credentials to people.

## Operate

Cycle until every in-scope item is Done or carries a recorded blocker and the serving commit is main's tip. `master status` prints one page: the serving commit against main's tip, each open item's stage, owner, head and blocker, the merge writer's queue and last merge, live sessions and free worker profiles. Review findings, rework, idle workers and proof setup are not stopping conditions.

## The loop

`master run` runs one cycle every `run.intervalSeconds`: five steps in order, each under one timeout; a failed step is one log line and runs again next cycle.

1. **snapshot**: the work snapshot and Herdr's session list.
2. **close**: end sessions whose item left the stage they were launched for; reconcile leases that lapsed unsubmitted; remove ended attempts' worktrees.
3. **dispatch**: claimable items to free worker profiles; unmergeable heads back to a worker; reviewer and producer requests; the master session, launched when absent.
4. **merge writer**: trial and merge each submitted head in order ([delivery](delivery.md)).
5. **persist**: the loop cursor.

`master restart` restarts `graphyard-master.service`; from the confined master session it files a request the loop serves. The loop restarts itself when [graphyard-deploy.service](delivery.md) serves a commit it did not load.

### System-driven items

Unless created `"systemDriven": false`, items refuse hand `dispatch`, `merge`, `review`, loop-owned `rework`. The master attests unproduced `manual:` proofs per head, base and policy revision.

### Session liveness is reconciled, not trusted

Each dispatch reconciles reviewer and producer sessions; a handle closes at the second consecutive miss. `blocked` frees its slot; its [reason](protocol/work-commands.md#blocked-work) stays on the item until the master clears it.

## Automatic dispatch at submit

Past the build gate: a producer request per proof group (`unit`, `integration`; `manual` with `producerProofs`), then a review once passed (`run.reviewerProfile`, producer profiles, 4 sessions each; **concurrency is per role**, 1–20, default 1). Unanswered sessions relaunch, then `dispatch.abandoned`.
