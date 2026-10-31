<!-- page: Operate Graphyard | 5 | loop -->
# Master-agent operating mode

The master (`coordinator`) administers access, never implementing, reviewing or proving; it files items itself, and its loop releases backlog to keep the pipeline full ([intent](how-graphyard-works.md#from-intent-to-work-items)). Human-only: goals and priorities, spending money or opening third-party accounts, issuing credentials to people.

## Operate

Cycle until scoped items are Done or blocked and releases healthy. `master status` prints the serving commit against main, scoped items' stage, worker and human owner, head and blocker, the merge queue, sessions and free profiles. Serving describes the managed repository's deployment, never the control plane's build; without a provider it is `unconfigured`. A repository declaring [`.graphyard/serve.json`](deployment.md#serving-the-managed-repositorys-app) reports its served commit, `atMain`, URL and last build failure. Review, rework and proof setup are not stopping conditions.

Items carry an optional `owner`, a principal with `sessionKind: "human"`, separate from the worker lease. Set it in `master create` or change it through `master requirements`; `null` returns it to the install. Requirements still enforce revisions and active leases. In the install checkout, `master init --for PERSON --token-stdin` registers a personal master without replacing identities or installing another supervisor. The loop launches each person's master and dispatches only their items; the install master dispatches unowned items. Scopes share capacity, backlog release, reconciliation, review/proof dispatch and one merge writer. A personal master's creates default to its person. Signed-in people open Work → Now for exactly their items, stage and next step; Work remains the shared board.

## The loop

`master run` runs one cycle every `run.intervalSeconds`: five steps in order, each under one timeout; a failed step is one log line and runs again next cycle.

1. **snapshot**: the work snapshot and Herdr's session list.
2. **close**: end sessions whose item left the stage they were launched for; keep what an attempt ended by its lapsed lease had not committed and record it for the redispatch's handoff — whether the lapsed lease is still on the record or the control plane's reconciliation already cleared it (GY-2956); reconcile leases that lapsed unsubmitted; remove ended attempts' worktrees.
3. **dispatch**: backlog released while the pipeline sits under its concurrency — the highest-priority item whose dependencies are done, oldest first on ties; a parked item never releases; claimable items to free worker profiles; unmergeable heads back to a worker; reviewer and producer requests; the master session, launched when absent.
4. **merge writer**: trial and merge each submitted head in order ([delivery](delivery.md)).
5. **persist**: the loop cursor.

`master restart` restarts `graphyard-master.service`; from the confined master session it files a request the loop serves. The loop restarts itself when [graphyard-deploy.service](delivery.md) serves a commit it did not load.

### System-driven items

Unless created `"systemDriven": false`, items refuse hand `dispatch`, `merge`, `review`, loop-owned `rework`. The master attests unproduced `manual:` proofs per head, base and policy revision.

### File user-facing items with an e2e: proof by default

Every `feature` or `bug` item the master files carries a criterion with an `e2e:NAME` proof bound to `e2e/cases/NAME.json` — the case the merge trial runs against the served head — unless the change has nothing a user can see, and then the description opens `No user-facing change: <reason>`. `master create` and `master requirements` refuse anything else, naming the case format and the opt-out ([validation](validation.md)).

### Session liveness is reconciled, not trusted

Each dispatch reconciles reviewer and producer sessions; a handle closes at the second consecutive miss, and so does the agent-registry session a restarted loop left standing — the ledger record names its pane, and the role's slot frees with it. `blocked` frees its slot; its [reason](protocol/work-commands.md#blocked-work) stays on the item until the master clears it.

## Automatic dispatch at submit

Past the build gate: a producer request per proof group (`unit`, `integration`; `manual` with `producerProofs`), then a review once passed (`run.reviewerProfile`, producer profiles, 4 sessions each; **concurrency is per role**, 1–20, default 1). Unanswered sessions relaunch, then `dispatch.abandoned`.
