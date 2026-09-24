<!-- page: Operate Graphyard | 5 | routing, recovery, and guarded merges. -->
# Master-agent operating mode

The master is the coordinator: a `coordinator` principal run as the durable `master run` loop plus an optional visible session. It routes work, handles findings, requests guarded merges, verifies deployments, and administers the GitHub App and branch protection. It never implements, holds a worker lease, reviews, or produces evidence. Graphyard is the source of truth; Herdr reports session health. Terms: [glossary](glossary.md).

`master guide` prints this loop. [Sessions](master-agent-sessions.md) covers install, profiles and launches; the [reference](master-agent-reference.md) covers commands, executors, GitHub administration and recovery.

## Autonomy: agents approve agents

Autonomy is the default: the master acts without asking. Only three decisions are human-only: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. Every other decision names the agent that makes it and the independent agent that approves it ([who decides](glossary.md#who-decides)):

- **Intent the master applies alone**, as its operator-agent identity and never weakening: `master create FILE REASON`, `master release GY-N REASON`, `master unblock GY-N REASON`, and `master requirements GY-N FILE REASON` for additions.
- **Two-party decisions**: requirement rewrites, escalation resolution, `manual:` attestation, rework and containment recovery, proof grants, and merge approval when automatic merging is off. Request with `master decide GY-N ACTION [JSON|@FILE] REASON`, launch the approver with `master approver GY-N DECISION`, and read outcomes with `master decisions GY-N`. The approver runs `master approve|refuse GY-N DECISION REASON` from its own session; a decline is recorded, never expressed by exiting. The server refuses self-approval and any approver that held an assignment on the item, produced its evidence, or would receive the grant.
- **Routine operations** need no approval: principal rotation, `master restart`, GitHub administration, dispatch, and the guarded merge.

A refused decision is re-requested only with a `REASON` citing it and adding something new (`terminalDecisions`); one whose approver vanished needs a fresh approver (`unansweredDecisions`).

`master autonomy --admin-token-stdin --apply` provisions the operator-agent and approver identities once. Every attention item in `master status` carries `attentionOwner`: the resolving role (`master`, `reviewer`, `control plane`, or `human` only for the three human decisions), whether an approver must approve, and the `next` command. Never ask a human to run a command an agent identity is permitted to run.

## Operate

The master is a perpetual coordinator. Keep cycling: status, dispatch ready work, shepherd review and proof collection, guarded merge, then deployment verification. Repeat until both conditions hold: (1) every in-scope item is Done or has a genuinely external blocker recorded in Graphyard; and (2) every merged change is deployed and live-verified against the exact deployed release, or a genuinely external deployment blocker is recorded in Graphyard.

1. Run `master status` at startup and after every material event.
2. Dispatch ready work with `master dispatch GY-N PROFILE`, in `schedule.order`; `schedule.held` items wait for the item ahead to merge ([conflict avoidance](master-agent-reference.md#conflict-avoidance)). Prompt delivery is an invitation, not ownership: the worker claims under its own identity.
3. Route review findings and failed proofs to rework; the loop, never you, launches reviewers and producers.
4. Request a guarded merge only when the exact candidate passes every gate.
5. Verify each delivery with `master verify-deployment GY-N` ([deployment verification](#deployment-verification)).
6. Close finished agent sessions, then return to status.

Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. An observed merge alone does not end the loop: Done marks a merge, not a deployed release. In-scope work is every released item, in the operator's priority order. A session gone quiet without a `blocked` record is work to dispatch again.

Delivered work is immutable, so a deployment blocker is recorded as a follow-up work item naming the delivered item, its merge commit, and the external cause; `daemon.deployment` keeps the delivery `pending` until the release serves it. For a failed smoke proof, see [operations](operations.md#delivered-with-a-failed-smoke-proof).

### Deployment verification

`master verify-deployment GY-42` runs after delivery, never as a pre-merge gate. It:

1. observes the deployed release (`--deployment-url`, or the provider's deployment record), refusing when nothing answers, the observation is over five minutes old, or the release lacks the item's merge commit;
2. refuses a local-only reading: the checkout must be clean and at the deployed release;
3. for Graphyard's own repository, checks that `master guide` and a fresh `init` both carry the loop above;
4. records one `delivery.deployment` observation bound to the exact commit, merge commit, source and time (a later rollout needs a follow-up item).

A refusal prints every reason and records nothing.

## Durable loop

Run coordination as a supervised process, not a chat session:

```sh
node "$GRAPHYARD_CLI" master run              # cycle until stopped
node "$GRAPHYARD_CLI" master run --once       # one cycle
```

Supervise it with systemd ([`examples/master/graphyard-master.service`](../examples/master/graphyard-master.service)); `systemctl --user restart graphyard-master` or `master restart` restarts it. `master init` sets `--interval`, `--dispatch-interval`, `--reviewer-profile`, `--producer-timeout`, `--proof-workflow`, `--smoke-workflow` and `--deployment-url`. `master config FIELD=VALUE…` changes them. The loop re-reads `.graphyard/master.json` every cycle, so profile and `run` changes need no restart; `url`, `repository` and credential paths need `master restart`.

Each cycle:

1. closes finished worker sessions and decides [scope requests](master-agent-reference.md#scope-requests);
2. reclaims finished worktrees' dependency directories ([worktree disk](master-agent-reference.md#worktree-disk));
3. keeps a dead worker's uncommitted work as an unpushed `WIP:` commit and settles its quarantine once verified dead;
4. dispatches claimable work to a healthy worker profile, smallest planned scope first, holding items that overlap in-flight work;
5. requests routine decisions and launches an approver for each ([unattended decisions](#unattended-decisions));
6. shepherds reviews and proofs ([automatic dispatch at submit](#automatic-dispatch-at-submit));
7. runs the guarded merge for green candidates;
8. verifies the deployed SHA and requests the smoke workflow where the policy sets `deploySmoke`.

`daemon.liveness` is `running`, `slow` (a long cycle; `daemon.cost` names the step), `stalled` or `absent`; fix the last two with `master restart`. A failed cycle backs off, doubling up to five minutes; three in a row raise an attention item (`daemon.failures`). One loop owns a repository at a time. `daemon.silence.longestIdleMs`, the longest actionable wait, becomes an attention item past twenty minutes.

### Unattended decisions

| What the loop sees | What it requests | Approved by |
| --- | --- | --- |
| A change request standing on the exact current head | `rework`, then dispatches the next attempt | approver agent |
| A base branch the control plane could not merge in | `rework` naming the conflict | approver agent |
| A delivered item still fenced by a quarantine verified dead | `recover` | approver agent |
| Every gate green with automatic merging off | `merge` for that exact candidate | approver agent |
| A lapsed quarantine verified dead on this host | nothing: it settles the quarantine itself | — |

The loop attests a stopped worker only once verified, requests rework only from a GitHub observation under two minutes old, and never approves its own request. It watches each decision (`daemon.approvals`): a dead or silent approver is replaced, up to three sessions; a refused decision is escalated, never requested again. It never reads the approver's credential, claims a lease, submits evidence, or revises a requirement. Anything else reaches `master status` with its owner and next command.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing finished sessions is not the master's
manual duty.** A dead session reports nothing, so a sweep checks every recorded handle.

**On what interval.** The sweep runs on every automatic-dispatch tick: `run.dispatchIntervalSeconds`, 10 seconds by default and 30 at most. A handle the runtime stops reporting gets a 60-second grace, counted from the first sweep
that missed it. So a vanished session's record is closed within 90 seconds of the runtime dropping it. A handle another host launched is left to
that host's loop. `dispatch.sessionReconcile` in `master status` reports what the last tick closed.

**What it closes:**

- **Vanished**: absent from the runtime's listing for the whole grace.
- **Ended**: listed in a runtime terminal state (today only Muse has any). `idle`, `done` and
  `blocked` are deliberately not terminal: each is a live session waiting at its prompt.
- **Superseded**: a review or proof session for a head the item moved past, merged, or reworked. A delivered item is closed the same
  way as any other. Implementation sessions are never closed this way; the lease decides.
- **Duplicate**: the older of two live review or proof sessions for one role and head.

A closure is a record: it decides no gate, ends no lease, and stops no process.

**The role slot follows the reconciled record.** A profile's concurrency is counted against live
sessions only, and a name is busy only while a live session has it.

**A session running with no progress** is surfaced, not closed: one attention item per session past its role's maximum: 4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, and 12h coordination.

**So what an operator or a master does instead of closing sessions by hand:** nothing, for a session
that finished or died. With the loop stopped, `graphyard master run --once` sweeps once. For a live but overlong session, attach to it with the command on the handle and stop it if stuck. Never mark
another session's handle finished to free a slot.

## Automatic dispatch at submit

Review and proof collection start on their own. When a candidate passes the build gate, the control plane records requests under `autoDispatch`, each bound to the exact head, base and policy revision:

- one **review request**, when the policy expects a GitHub verdict and no approval binds the head, raised only once the criteria's unit and integration proofs pass on that head;
- one **producer request per proof group** (`unit`, `integration`, and `manual` for proofs in `producerProofs`), covering every proof no trusted evidence binds.

A head, base or policy change cancels them and requests the new head afresh, unless the merge queue carried the approval or proof.

**The loop launches them within 30 seconds.** Every `dispatchIntervalSeconds` (5–30, default 10), the loop launches the reviewer profile (`run.reviewerProfile`, or the only one) and one producer session per proof group on an independent producer profile. Add one with `master producer add FILE` ([template](../examples/master/claude-producer.json)). A producer profile never shares a worker's principal and is skipped for an item its principal worked on. Sessions are recorded in `.graphyard/reviews.json` and `.graphyard/producers.json`, one live session per request. A failed session is relaunched after 1, 4 and 16 minutes, four sessions in all. `master review GY-N [PROFILE]` forces the next attempt once the cause is fixed; a stuck producer request is recovered with a `rework` decision.

**Concurrency is per role.** A profile's `concurrency` (1–20, default 1) is how many sessions it runs at once. Above one, each session takes a name unique to its request. A raised limit applies on the next tick without a restart; after lowering it, nothing launches until running sessions drain. `master status` reports `concurrency` per role (`running`, `limit`, `waiting`, `longestWaitMs`); a role starved for ten minutes raises an attention item (`counts.concurrencyStarved`).

**Requests always settle.** A pane that is already gone (`pane_not_found`) counts as closed. No request outlives its own token: once expired, with Herdr no longer reporting its session, it settles as `expired`. One still pending after that is counted in `dispatch.sessionReconcile.stuck`; close its pane and the next `master status` settles it.

The master handles findings, reworks and merges; it never launches reviews or producers by hand, approves a candidate, or submits evidence. Per candidate, `master status` shows what is requested, what is running and since when, and any launch the loop refused.

### Proofs must exercise their criterion

A proof that passes against an unchanged tree proves nothing. With a pass, the producer records `"exercise"`: the same proof run in a second worktree of the head with the criterion's behaviour removed.

```json
"exercise": { "criterion": "AC-1", "behaviour": "the lease expiry check in claim()", "result": "fail", "executed": 4 }
```

A pass is trusted only when that stripped run failed with a case executed. Otherwise it stays untrusted, recorded as not exercising its criterion rather than as passing: it carries `unexercised`, history gains `evidence.exercise.refused`, and the worker must strengthen the proof.

## Guarded merges

`master merge GY-N` or `--all` merges only under a current authorization for the exact PR head, base and policy, rechecking just before the GitHub call:

- every gate and its evidence;
- the head and the base, read from `refs/heads/<base>` and never from the cached `baseRefOid`;
- draft state, mergeability, the review identity and branch protection;
- a single-use merge execution.

It never uses an administrative merge bypass; Done follows the observed merge. Running `master merge` beside the loop is safe: one stands down. A server whose merge protocol differs from the CLI's refuses with `server runs <sha>, CLI expects <sha>: deploy main first`. `controlPlane.production` in `master status` says when main is ahead of production. Never downgrade the CLI to match a stale server.

With `master init --no-auto-merge`, `master merge` refuses a candidate without an approved `master decide GY-N merge REASON`.

### Unresolved review threads

With required conversation resolution, each unresolved thread fails the merge gate (`reviewThreads`). An unresolved review thread is a finding to fix: the head's reviewer resolves those fixed there; route others with `master decide GY-N rework REASON`. Resolving a thread the master did not write is not the master's call.

## Merge queue

Candidates passing their own gates land in order through one merge queue. Only its head can hold a merge authorization, so `master merge --all` merges one entry per pass. `master status` lists `queue` entries with `position`, `predictedTip`, refusal `reasons` and a `binding` per approval and proof: `exact`, `carried`, or `required`. Graphyard re-bases the entries behind the head: never request rework over a changed position or tip; launch a review or proof only for a `required` binding. See [speculative tips](master-agent-reference.md#speculative-tips-and-branch-protection) and [GitHub enforcement](github.md#merge-queue).

