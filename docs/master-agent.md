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

When merge validation refuses a queued head for a shared base failure, the loop sends the diagnosis (including assertion or crash detail) and next repair action to the registered master, even if Herdr still labels it working. An absent master receives the unresolved cause in its launch handover. The cursor records `lastWake` and subject digests: repeated cycles and restarts do not prompt again for unchanged causes; changed details or base wake again, and resumed delivery clears the subject. Failed delivery stays pending for retry. `master status` separates the coordinator's session state from `delivery`, naming a shared-base stall, its reason and next agent action. The master files or advances the repair without human approval; every test and merge requirement remains in force.

The same handoff includes unresolved worker blockers, failed launch/review/proof operations and abandoned requests, with affected work and the recorded reason. A failed deployment of the managed repository also reaches its master. Resolved causes disappear. While scoped work remains, `run.masterHeartbeatMinutes` (default 30) bounds the fallback re-prompt since the last wake or session start, including stale working labels; successful wakes reset that timer across loop restarts. Routine repair uses typed agent actions without relaxing gates.

### System-driven items

Unless created `"systemDriven": false`, items refuse hand `dispatch`, `merge`, `review`, loop-owned `rework`. The master attests unproduced `manual:` proofs per head, base and policy revision.

### File every item with an e2e: proof

Every item carries a criterion with an `e2e:NAME` proof bound to `e2e/cases/NAME.json` — new or existing, run by the merge trial against the served head. There is no chore exemption and no opt-out sentence: `master create` and `master requirements` refuse anything else, naming the case format ([validation](validation.md)). Loop repairs name `e2e:create-work-item`; follow-ups reuse delivered cases (legacy items: `create-work-item`); onboarding names the repository's first case.

### Session liveness is reconciled, not trusted

Each dispatch reconciles reviewer and producer sessions; a handle closes at the second consecutive miss, and so does the agent-registry session a restarted loop left standing — the ledger record names its pane, and the role's slot frees with it. A completed review (including COMMENTED and post-merge) releases its registry slot on the first readable inventory that shows its pane gone, after launch grace, even when its delivered item is absent from open work. Its verdict and review requirements stay unchanged. `blocked` frees its slot; its [reason](protocol/work-commands.md#blocked-work) stays on the item until the master clears it.

The GY-3052 incidents completed within launch grace: GY-3007 launched at 21:36:42Z and closed at 21:37:15Z; GY-3004 launched at 21:41:44Z and closed at 21:42:24Z. Manual release at 21:41:37Z and 21:47:02Z preceded two eligible missing-pane snapshots. The old second-miss path therefore had not fired; delivered items also lacked an open-work handle for normal close. Completed ledger records now suffice on the first eligible miss, without making COMMENTED an approval.

## Automatic dispatch at submit

Past the build gate: a producer request per proof group (`unit`, `integration`; `manual` with `producerProofs`), then a review once passed (`run.reviewerProfile`, producer profiles, 4 sessions each; **concurrency is per role**, 1–20, default 1). Unanswered sessions relaunch, then `dispatch.abandoned`.

Reviewer requests launch on the first eligible dispatch tick without waiting for GitHub bot reviews. An exact-head control-plane approval lets the head proceed to the merge writer's trial immediately. Old settings files still load with `run.awaitReviewers` and `run.awaitReviewersMinutes` ignored; old dispatch cursors load with `botReviewers` discarded.
