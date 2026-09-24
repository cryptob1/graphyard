<!-- page: Operate Graphyard | 5 | routing, recovery, and guarded merges. -->
# Master-agent operating mode

The master is the coordinator: a `coordinator` principal run as the durable `master run` loop plus an optional visible master session. It routes work, handles findings, requests guarded merges, verifies deployments, and administers the repository's GitHub App and branch protection. It never implements work, holds a worker lease, reviews a candidate, or produces evidence. Graphyard is the source of truth; Herdr only reports session health. Terms follow the [glossary](glossary.md).

This page is the operating loop (`master guide` prints it). [Master-agent sessions](master-agent-sessions.md) covers install, profiles and launches; the [reference](master-agent-reference.md) holds the command table, executors, GitHub administration and recovery.

## Autonomy: agents approve agents

Autonomy is the default: the master acts without asking. Only three decisions are human-only: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. Approving a GitHub sudo prompt on the operator's own device counts as the third. Every other decision names the agent that makes it and the independent agent that approves it ([who decides](glossary.md#who-decides)):

- **Intent the master applies alone**, as its operator-agent identity: `master create FILE REASON`, `master release GY-N REASON`, `master unblock GY-N REASON`, and `master requirements GY-N FILE REASON` for additions. None of it weakens anything.
- **Two-party decisions**: requirement rewrites, escalation resolution, `manual:` attestation, rework and containment recovery, proof grants, and merge approval when automatic merging is off. Request with `master decide GY-N ACTION [JSON|@FILE] REASON`, launch the approver with `master approver GY-N DECISION`, and read the outcome with `master decisions GY-N`. The approver runs `master approve GY-N DECISION REASON` or `master refuse GY-N DECISION REASON` from its own session. A decline is recorded, never expressed by exiting. The server refuses self-approval, and it refuses any approver that held an assignment on the item, produced its evidence, or would receive the grant.
- **Routine operations** need nobody's approval: principal rotation, `master restart`, GitHub administration, dispatch, and the guarded merge.

A refused decision is requested again only with a `REASON` that cites it and adds something new (`terminalDecisions` in `master status`); one whose approver vanished is a stall for a fresh approver (`unansweredDecisions`).

`master autonomy --admin-token-stdin --apply` provisions the operator-agent and approver identities once. Every attention item in `master status` carries `attentionOwner`: the resolving role (`master`, `reviewer`, `control plane`, or `human` for the three human-only decisions only), whether an approver must approve, and the `next` command. Never ask a human to run a command an agent identity is permitted to run.

## Operate

The master is a perpetual coordinator. Keep cycling: status, dispatch ready work, shepherd review and proof collection, guarded merge, then deployment verification. Repeat until both conditions hold: (1) every in-scope item is Done or has a genuinely external blocker recorded in Graphyard; and (2) every merged change is deployed and live-verified against the exact deployed release, or a genuinely external deployment blocker is recorded in Graphyard.

1. Run `master status` at startup and after every material event. Graphyard is progression truth.
2. Dispatch ready work with `master dispatch GY-N PROFILE`, in `schedule.order`. Leave `schedule.held` items for the item ahead of them to merge ([conflict avoidance](master-agent-reference.md#conflict-avoidance)). Prompt delivery is an invitation, not ownership: the worker claims under its own identity.
3. Route review findings and failed proofs to rework. The loop launches reviewers and producers; you never do.
4. Request a guarded merge only when the exact candidate passes every gate.
5. Verify each delivery with `master verify-deployment GY-N` ([deployment verification](#deployment-verification)).
6. Close finished agent sessions, then return to status.

Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. An observed merge alone does not end the loop: Done marks a merge, not a deployed release. In-scope work is every released item; release backlog in the operator's priority order. A session that went quiet without a `blocked` record is work to dispatch again.

Delivered work is immutable, so a deployment blocker is recorded as a follow-up work item naming the delivered item, its merge commit, and the external cause. `daemon.deployment` keeps that delivery under `pending` until the release serves it. For a failed smoke proof, see [operations](operations.md#delivered-with-a-failed-smoke-proof).

### Deployment verification

`master verify-deployment GY-42` runs after delivery. It is never a pre-merge gate. The command:

1. observes the deployed release (`--deployment-url`, or the provider's deployment record). It refuses when nothing answers, when the observation is older than five minutes, or when the release lacks the item's merge commit;
2. refuses a local-only reading: the launcher's checkout must be clean and at the deployed release;
3. for Graphyard's own repository, checks that `master guide` and a fresh `init` both carry the loop above;
4. records one `delivery.deployment` observation, bound to the exact commit, the merge commit, the source and the time. A later rollout is verified through a follow-up item.

A refusal prints every reason and records nothing.

## Durable loop

Run the mechanical part of coordination as a supervised process, not a chat session:

```sh
node "$GRAPHYARD_CLI" master run              # cycle until stopped
node "$GRAPHYARD_CLI" master run --once       # one cycle
```

Supervise it with systemd using [`examples/master/graphyard-master.service`](../examples/master/graphyard-master.service). `systemctl --user restart graphyard-master` or `master restart` restarts it. `master init` takes its settings: `--interval`, `--dispatch-interval`, `--reviewer-profile`, `--producer-timeout`, `--proof-workflow`, `--smoke-workflow` and `--deployment-url`. `master config FIELD=VALUE…` changes the settings the master owns. The loop re-reads `.graphyard/master.json` every cycle, so profile and `run` changes apply without a restart; `url`, `repository` and credential paths need `master restart`.

Each cycle:

1. closes finished worker sessions;
2. decides open worker [scope requests](master-agent-reference.md#scope-requests);
3. reclaims dependency directories of finished worktrees ([worktree disk](master-agent-reference.md#worktree-disk));
4. keeps a dead worker's uncommitted work as an unpushed `WIP:` commit, then settles its quarantine when this host verifies it dead;
5. dispatches claimable work to a healthy worker profile, smallest planned scope first, and holds items that overlap in-flight work;
6. requests routine decisions and launches an approver for each ([unattended decisions](#unattended-decisions));
7. shepherds reviews and proofs ([automatic dispatch at submit](#automatic-dispatch-at-submit));
8. runs the guarded merge for candidates whose gates are green;
9. verifies the deployed SHA, and requests the smoke workflow where the policy sets `deploySmoke`.

Everything lands in `master status` under `daemon`. `daemon.liveness` is `running`, `slow` (inside a long cycle; `daemon.cost` names the step), `stalled` or `absent`; the fix for the last two is `master restart`. A failed cycle backs off, doubling up to five minutes. Three consecutive failures raise an attention item naming the failing call (`daemon.failures`). The loop is safe to restart, and one loop owns a repository at a time. `daemon.silence.longestIdleMs` is the longest actionable wait; past twenty minutes it becomes an attention item.

### Unattended decisions

| What the loop sees | What it requests | Approved by |
| --- | --- | --- |
| A change request standing on the exact current head | `rework`, then dispatches the next attempt | approver agent |
| A base branch the control plane could not merge in | `rework` naming the conflict | approver agent |
| A delivered item still fenced by a quarantine verified dead | `recover` | approver agent |
| Every gate green with automatic merging off | `merge` for that exact candidate | approver agent |
| A lapsed quarantine verified dead on this host | nothing: it settles the quarantine itself | — |

The loop attests a stopped worker only after verifying it. It requests rework only from a GitHub observation less than two minutes old, and it never approves what it requested. It watches each decision (`daemon.approvals`): a dead or silent approver is replaced, up to three sessions, and a refused decision is escalated, never requested again. The loop never reads the approver's credential, claims a lease, submits evidence, or revises a requirement. Judgement no rule covers reaches `master status` with its owner and next command.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing finished sessions is not the master's
manual duty.** A session that dies reports nothing, so a sweep checks every recorded handle.

**On what interval.** The sweep runs on every automatic-dispatch tick: `run.dispatchIntervalSeconds`, 10 seconds by default and 30 at most. A handle the runtime no longer reports gets a 60-second grace, counted from the first sweep
that missed it. So a vanished session's record is closed within 90 seconds of the runtime dropping it. A handle another host launched is left to
that host's loop. `dispatch.sessionReconcile` in `master status` reports what the last tick closed.

**What it closes:**

- **Vanished**: absent from the runtime's listing for the whole grace.
- **Ended**: listed in one of its runtime's terminal states; today only Muse has any. `idle`, `done` and
  `blocked` are deliberately not terminal: each is a live session waiting at its prompt.
- **Superseded**: a review or proof session for a head the item has moved past, merged, or returned to rework. A delivered item is closed the same
  way as any other. An implementation session is never closed this way; its lease decides.
- **Duplicate**: the older of two live review or proof sessions for one role and head.

A closure is a record: it decides no gate, ends no lease, and stops no process.

**The role slot follows the reconciled record.** A profile's concurrency is counted against live
sessions only, and a name is busy only while a live session has it.

**A session running with no progress** is not closed; it is surfaced. `master status` raises one attention item per session past its role's maximum: 4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, and 12h coordination.

**So what an operator or a master does instead of closing sessions by hand:** nothing, for a session
that finished or died. When the loop is stopped, `graphyard master run --once` runs one sweep. For a live but overlong session, attach to it with the command on the handle, and stop it there if it is stuck. Never mark
another session's handle finished to free a slot.

## Automatic dispatch at submit

Review and proof collection start on their own. When a candidate passes the build gate, the control plane records requests under `autoDispatch`, each bound to the exact head, base and policy revision:

- one **review request**, when the policy expects a GitHub verdict and no approval binds the head. It is raised only after the unit and integration proofs the criteria name have passed on that head;
- one **producer request per proof group** (`unit`, `integration`, and `manual` for the proofs listed in `producerProofs`), covering every proof that no trusted evidence binds.

A head, base or policy change cancels the requests and requests the new head afresh, unless the merge queue carried the approval or proof.

**The loop launches them within 30 seconds.** Every `dispatchIntervalSeconds` (5–30, default 10), `master run` launches the reviewer profile (`run.reviewerProfile`, or the only one) and one producer session per proof group on an independent producer profile. Add one with `master producer add FILE`; the template is [examples/master/claude-producer.json](../examples/master/claude-producer.json). A producer profile never shares a principal with a worker, and is skipped for an item its principal worked on. The loop records sessions in `.graphyard/reviews.json` and `.graphyard/producers.json`, with one live session per request. A failed session is relaunched after 1, 4 and 16 minutes, up to four sessions in all. `master review GY-N [PROFILE]` forces the next attempt once the cause is fixed. A stuck producer request is recovered with a `rework` decision.

**Concurrency is per role.** A profile's `concurrency` (1–20, default 1) is how many sessions it runs at once. Above one, each session takes a name unique to its request. Raising the limit takes effect on the next tick without a restart. After lowering it, no new session launches until the running ones drain. `master status` reports `concurrency` per role with `running`, `limit`, `waiting` and `longestWaitMs`. A role starved for ten minutes raises an attention item, counted in `counts.concurrencyStarved`.

**Requests always settle.** A pane that is already gone (`pane_not_found`) counts as closed. No request outlives its own token: once it has expired and Herdr no longer reports its session, it settles as `expired`. A request still pending after that is counted in `dispatch.sessionReconcile.stuck`. Close its pane, and the next `master status` settles it.

The master handles findings, reworks and merges. It never launches reviews or producers by hand, never approves a candidate, and never submits evidence. For each candidate, `master status` shows what is requested, what is running and since when, and any launch the loop refused.

### Proofs must exercise their criterion

A proof that passes against an unchanged tree proves nothing. With a pass, the producer records `"exercise"`: the same proof, run in a second worktree of the head with the criterion's behaviour removed.

```json
"exercise": { "criterion": "AC-1", "behaviour": "the lease expiry check in claim()", "result": "fail", "executed": 4 }
```

A pass is trusted only when that stripped run failed with a case executed. Otherwise it is kept untrusted and recorded as not exercising its criterion rather than as passing. It carries `unexercised`, the item's history gains `evidence.exercise.refused`, and the finding goes back to the worker to strengthen the proof.

## Guarded merges

`master merge GY-N`, or `master merge --all`, merges only under a current authorization for the exact PR head, base and policy. Immediately before the GitHub call it rechecks:

- every gate and its evidence;
- the head and the base, read from `refs/heads/<base>` and never from the cached `baseRefOid`;
- draft state and mergeability;
- the review identity and branch protection;
- a single-use merge execution.

It never uses an administrative merge bypass. Done follows the observed merge. Running `master merge` beside the loop is safe: one of the two stands down. When the server's merge protocol differs from the CLI's, the merge is refused with `server runs <sha>, CLI expects <sha>: deploy main first`. `controlPlane.production` in `master status` says when main is ahead of production, and why. Never downgrade the CLI to match a stale server.

With `master init --no-auto-merge`, each merge needs an approved decision: request `master decide GY-N merge REASON`, and `master merge` refuses any candidate without one.

### Unresolved review threads

Under required conversation resolution, each unresolved thread fails the merge gate (`reviewThreads` on the row). An unresolved review thread is a finding to fix: route it the way a `CHANGES_REQUESTED` verdict is routed, with `master decide GY-N rework REASON`. Resolving a thread the master did not write is not the master's call.

## Merge queue

Candidates that pass their own gates enter a single merge queue and land in order. Only the head of the queue can hold a merge authorization, so `master merge --all` merges one entry per pass. `master status` lists `queue` entries with `position`, `predictedTip`, refusal `reasons` and a `binding` for each approval and proof: `exact`, `carried`, or `required`. Graphyard re-bases the entries behind the head: never request rework because a position or tip changed, and launch a review or proof only for a `required` binding. See [speculative tips](master-agent-reference.md#speculative-tips-and-branch-protection) and [GitHub enforcement](github.md#merge-queue).

