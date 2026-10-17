<!-- page: Operate Graphyard | 5 | loop, merges. -->
# Master-agent operating mode

The master (`coordinator`) routes and administers GitHub unasked, never implementing, reviewing or proving; it no longer hand-decomposes goals ([goal pipeline](how-graphyard-works.md#from-goal-to-work-items)). Human-only: goals and priorities, spending money or opening third-party accounts, issuing credentials to people ([who decides](glossary.md#who-decides)); it decides the rest. `master guide` prints its role instructions, then this page; AGENTS.md carries the worker block.

## Operate

Keep cycling: `master status`; `master run` dispatches; merge gate-passing candidates; rework findings; deployment verification (`master verify-deployment GY-N`, [refusals](operations-reference.md#perpetual-master-loop)); control plane performs "Close finished agent sessions". Deployment-verification records each loop-owned observation's due reading on the serving release (pass → `delivered-observation`; fail escalates, naming values); `master reading GY-N pass|fail DETAIL` records one by hand. Live Confirm-access fixtures: [`master browser capture`](master-agent-reference.md#github-administration-through-the-browser), never a human. Stop only when every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, merges verified against the exact deployed release or deployment-blocked. Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. `controlPlane.production`: main ahead of production.

`master restart` (stalled loop) runs `systemctl --user restart graphyard-master.service` if the [unit](onboarding.md#the-loop-must-be-supervised)'s ExecStart is node `cliPath` (or pin) `master run`, else detached; never from [dirty/non-forward checkouts](master-agent-sessions.md#the-coordinator-checkout-is-confined-at-the-os-level). Loop sleeps `run.intervalSeconds` (≤30s if actionable).

### System-driven items

Unless created `"systemDriven": false`, items refuse hand `dispatch`, `merge`, `review`, `decide attest|merge`, loop-owned `decide rework` (`--precedent` answers refusals), except stopped-loop recovery, unproduced `manual:` attestations, `decide merge` unauthorized or operator-agent-less. The loop attests unproduced `manual:` proofs via an independent approver per head, base and policy revision.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing sessions is not the master's manual duty.** Sweeps run every automatic-dispatch tick (`run.dispatchIntervalSeconds`, default 10, 30 at most); a handle closes at the second consecutive sweep that misses it; one a lease or request names is held until it ends; an unobserved one is left alone for its first 3 minutes. A handle another host launched is left to that host's loop. Closures: **Vanished** (unnamed by attempt or request, missing twice; request-less reviews relaunch), **Ended** (agentless pane, terminal state; `idle`, `done` and `blocked` are deliberately not terminal; unlisted after its attempt or request ended), **Superseded** (review/proof session for a head the item moved past, delivered items too; implementation follows lease), **Duplicate** (older per role/head). A closure decides no gate, ends no lease, stops no process; concurrency and busy names count live sessions. Past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, 12h coordination) a session is flagged, not closed.

**Instead of closing sessions by hand:** do nothing for a finished or dead session (`graphyard master run --once` sweeps); attach to an overlong one with its handle's command. Never mark another session's handle finished to free a slot. The loop and `master approver` relaunch never-started approvers (`done`, `idle`) past the start bound.

`blocked` frees its slot; [classes](protocol/leases.md#blocked-work-unblocks-itself) self-clear: `github-credential`, `sandbox-path`, `github-outage`, `control-plane-error`, `outside-scope-test-failure`, `runtime-denial`, `worktree-mismatch`, `dispatch-failure`, `runtime-exhaustion`, `host-supervisor`; `master-role` a master-role identity runs and unblocks; `planned-file-scope`, `needs-decision` approver. `genuine`/`human-only` escalate; a loop-held item's unleased inability report clears.

### System invariants

Per cycle (`daemon.invariants.lines`): `follow-ups-per-parent` (1), `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min), `cycle-p90` (30 s), `untriaged-backlog` (24 h), `deploy-lease-loss` (0). Thresholds: `invariants` in `.graphyard/master.json`; `tests/soak-*.test.ts` enforce.

## Research and diagnosis

`Recurring <class>` and `invariant:` faults past `invariantBoundMinutes` get diagnostician (`run.diagnostician`; none for parks); fix `plannedFiles` as `master create`; `stale`/`withdrawn` decisions, stale backlog releases re-request ≤3×, then `decision-stale`; refused `create` 409/400 is `fix-item`.

## Machine-filed backlog

Review follow-ups fixed in-PR; Pi (`run.research`) triages follow-ups, faults.

## Automatic dispatch at submit

Past the build gate (`autoDispatch`): a producer request per proof group (`unit`, `integration`; `manual` with `producerProofs`; github mode only), then a review once passed. **The loop launches each request within 30 seconds**, starting the reviewer (`run.reviewerProfile`) and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json); `.graphyard/reviews.json`, `.graphyard/producers.json`). Reviewer launches await head's bot reviews (`run.awaitReviewers`) ≤`awaitReviewersMinutes` (8, 0 disables), skipping a bot under a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`, `dispatch.botReviewers`).

- **Concurrency is per role**: `concurrency` (1–20, default 1; above 1 each takes a name unique to its request; `run.reviewerProfile` and producer profiles default to 4 sessions) applies without a restart; lowering it drains first (`longestWaitMs`); starved minutes: `counts.concurrencyStarved`.
- `pane_not_found` panes close. No request outlives its own token: one expired and unreported by Herdr settles `expired` (`dispatch.sessionReconcile.stuck` counts pending). Unanswered sessions relaunch, then `dispatch.abandoned`; exhausted producers raise `escalation:proof-exhausted`, then rework.
- **Every role fails over on spent quota** or waits as one `capacity` line.

The master never launches reviews or producers by hand, except `master review GY-N [PROFILE]` once relaunching stops.

### Proofs must exercise their criterion

A passing producer records `"exercise"`: rerun without the criterion's behaviour must fail an executed case, else the pass is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`). Unexercised `manual:` proofs re-attest.

## GitHub merges

GitHub merges gate-passing heads under the `github` merger ([delivery](delivery.md#one-delivery-path)), the [merge writer](delivery-redesign.md#merge-writer) under `control-plane`; failing heads need two-party `master decide GY-N merge`; skew: `… deploy main first`; a check the base fails too is a [base failure](development.md#base-failures). Unresolved review threads are reviewer inputs, not merge blockers (`reviewThreads`); approvals list each under `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).
