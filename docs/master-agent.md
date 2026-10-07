<!-- page: Operate Graphyard | 5 | loop, merges. -->
# Master-agent operating mode

The master (`coordinator`) routes and administers GitHub unasked, never implementing, reviewing or proving. Human-only: goals and priorities, spending money or opening third-party accounts, issuing credentials to people ([who decides](glossary.md#who-decides)); the rest it decides itself or via an approver agent.

## Operate

Keep cycling: `master status`; `master run` dispatches (`schedule.order`); merge gate-passing candidates; rework findings; deployment verification (`master verify-deployment GY-N`, [refusals](operations-reference.md#perpetual-master-loop)); Close finished agent sessions. Stop only when every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merge is verified against the exact deployed release or deployment-blocked. Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. `controlPlane.production` flags main ahead of production.

`master run` is the `graphyard-master.service` unit ([supervision](onboarding.md#the-loop-must-be-supervised)); on `daemon.liveness` `stalled`/`absent`: `systemctl --user restart graphyard-master`, never from a [dirty or non-forward checkout](master-agent-sessions.md#the-coordinator-checkout-is-confined-at-the-os-level).

### System-driven items

Unless created `"systemDriven": false`, items refuse hand `dispatch`, `merge`, `review` and `decide attest|merge`, except stopped-loop recovery, unproduced `manual:` attestations and `decide merge` without an operator agent.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing sessions is not the master's manual duty.** A sweep runs every automatic-dispatch tick (`run.dispatchIntervalSeconds`, default 10, 30 at most); a handle closes at the second consecutive sweep that misses it, and an unobserved one is left alone for its first 3 minutes. A handle another host launched is left to that host's loop. Closures: **Vanished** (missing from two listings running), **Ended** (agentless pane or terminal state; `idle`, `done` and `blocked` are deliberately not terminal), **Superseded** (a review or proof session for a head the item moved past; a delivered item is closed the same way as any other), **Duplicate** (the older session for one role and head). A closure decides no gate, ends no lease, and stops no process; a profile's concurrency is counted against live sessions only, and a name is busy only while a live session has it. A session past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, 12h coordination) is flagged, not closed.

**So what an operator or a master does instead of closing sessions by hand:** nothing, for a session that finished or died (`graphyard master run --once` sweeps); for an overlong one, attach to it with the command on the handle. Never mark another session's handle finished to free a slot.

`blocked` frees the slot; [classes](protocol/leases.md#blocked-work-unblocks-itself) `github-credential`, `control-plane-error`, `sandbox-path`, `worktree-mismatch`, `outside-scope-test-failure`, `dispatch-failure`, `planned-file-scope`, `needs-decision` self-clear; `genuine`/`human-only` escalate.

### System invariants

Each cycle (`daemon.invariants.lines`): `follow-ups-per-parent` (1 open), `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min), `cycle-p90` (30 s), `untriaged-backlog` (24 h), `deploy-lease-loss` (0). Fault thresholds: `invariants` in `.graphyard/master.json`; `tests/soak-*.test.ts` enforce.

The loop's [doctor](onboarding.md#the-pipeline-doctor-on-by-default) fixes stuck work every `run.doctor.intervalMinutes`, never merging, dispatching or evidencing.

## Research and diagnosis

Recurring and `invariant:` faults get a read-only diagnostician (`run.diagnostician`), whose quota refusals wait; stale decisions are re-requested, then escalated; [plane-wide](operations.md#incident-decision-tree) failures retry faultlessly.

## Machine-filed backlog

Review follow-ups are never filed (findings are fixed in-PR); Pi (`run.research`, `triageConcurrency` 2) triages fault items.

## Automatic dispatch at submit

Past the build gate (`autoDispatch`): a producer request per proof group (`manual` only with `producerProofs`), then a review request. **The loop launches each request within 30 seconds**: it starts the reviewer profile (`run.reviewerProfile`) and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json); `.graphyard/producers.json`). Reviewer launches await bot reviews (`run.awaitReviewers`), skipping a bot that posted a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`, `dispatch.botReviewers`).

- **Concurrency is per role**: `concurrency` (above 1, each session takes a name unique to its request) applies without a restart (`run.reviewerProfile` and producer profiles default to 4 sessions); lowering it drains first (`longestWaitMs`); starved minutes count in `counts.concurrencyStarved`.
- Requests always settle: `pane_not_found` panes close. No request outlives its own token (`expired`; `dispatch.sessionReconcile.stuck`).
- **Every role fails over on spent quota.**

The master never launches reviews or producers by hand, except `master review GY-N [PROFILE]` after relaunching stops.

### Proofs must exercise their criterion

A passing producer records `"exercise"`: rerun without the criterion's behaviour, the proof must fail with a case executed, else the pass is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`); `manual:` proofs re-attest instead.

## GitHub merges

GitHub merges a head whose gates pass ([delivery](delivery.md#one-delivery-path)); a failing head's merge is a violation until two-party `master decide GY-N merge`; skew: `… deploy main first`; a check the base head fails too is a [base failure](development.md#base-failures). Unresolved review threads are the reviewer's inputs, not merge blockers; approvals list each under `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).
