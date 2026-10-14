<!-- page: Operate Graphyard | 5 | loop, merges. -->
# Master-agent operating mode

The master (`coordinator`) routes and administers GitHub unasked, never implementing, reviewing or proving; it no longer hand-decomposes goals ([goal pipeline](how-graphyard-works.md#from-goal-to-work-items)). Human-only: goals and priorities, spending money or opening third-party accounts, issuing credentials to people ([who decides](glossary.md#who-decides)); it decides the rest without asking a human to run what an agent may. `master guide` prints its role instructions, then this page; AGENTS.md carries the worker block.

## Operate

Keep cycling: `master status`; `master run` dispatches (`schedule.order`); merge gate-passing candidates; rework findings; deployment verification (`master verify-deployment GY-N`, [refusals](operations-reference.md#perpetual-master-loop)); control plane performs "Close finished agent sessions". Deployment verification also records loop-owned post-deploy follow-ups' due readings on the serving release (`pendingReadings`): a pass closes the item `delivered-observation` and its superseded pull request; a fail records it and raises the item's escalation naming the measured values; one this host cannot take records why; `master reading GY-N pass|fail DETAIL` records it by hand. Live Confirm-access fixtures: [`master browser capture`](master-agent-reference.md#github-administration-through-the-browser), never a human. Stop only when every in-scope item is Done or has an external blocker recorded in Graphyard and every merge is verified against the exact deployed release or deployment-blocked; review findings, rework, idle workers and proof setup are not stopping conditions. `controlPlane.production`: main ahead of production.

`master restart` (stalled loop) runs `systemctl --user restart graphyard-master.service` if the [unit](onboarding.md#the-loop-must-be-supervised)'s ExecStart is node `cliPath` (or pin) `master run`, else detached, never from [dirty/non-forward checkouts](master-agent-sessions.md#the-coordinator-checkout-is-confined-at-the-os-level) ([confined](master-agent-sessions.md#the-coordinator-checkout-is-confined-at-the-os-level): a loop request).

**Cycle cadence.** Loop sleeps `run.intervalSeconds` (≤30 s if actionable); dispatcher ticks wake it per new subject.

### System-driven items

Unless created `"systemDriven": false`, items refuse hand `dispatch`, `merge`, `review`, `decide attest|merge`, loop-owned `decide rework` (`--precedent` answers refusals), except stopped-loop recovery, unproduced `manual:` attestations, `decide merge` unauthorized or operator-agent-less. The loop attests unproduced `manual:` proofs via an independent approver once per head, base, policy revision (`loopDecisions.attestations`). Refused review (or other-check) reworks never hold a same-head failed-check rework.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing sessions is not the master's duty.** Sweeps run every automatic-dispatch tick (`run.dispatchIntervalSeconds`, default 10, max 30); a handle closes at the second sweep missing it; one a lease or request names is held until it ends; an unobserved one waits 3 minutes; another host's is its loop's. Closures: **Vanished** (unnamed by attempt or request, missing twice; request-less reviews relaunch), **Ended** (agentless pane, terminal state, never `idle`, `done` or `blocked`; or unlisted after its attempt or request ended), **Superseded** (review/proof session for a head the item moved past or delivered; implementation follows lease), **Duplicate** (older per role, head). A closure decides no gate, ends no lease, stops no process (bar [lingering submitted attempts](protocol/leases.md#watch)); concurrency counts live sessions only. A session past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes` producer, 12h coordination) is flagged, not closed.

**Instead of closing sessions by hand:** do nothing for a finished or dead session (`master run --once` sweeps); attach to an overlong one with its handle's command; never mark another session's handle finished to free a slot. The loop and `master approver` relaunch never-started approvers (`done`, still-screened `idle`) past the start bound; replaced hand-launched panes [bind](master-agent-sessions.md#the-start-bound-reads-the-pane).

`blocked` frees its slot; [classes](protocol/leases.md#blocked-work-unblocks-itself) self-clear: `github-credential`, `sandbox-path`, `github-outage`, `control-plane-error`, `outside-scope-test-failure`, `runtime-denial`, `worktree-mismatch`, `dispatch-failure`, `runtime-exhaustion`, `host-supervisor`; `master-role` a master-role identity runs and unblocks; `planned-file-scope`, `needs-decision` approver. `genuine`/`human-only` escalate, but a loop-held item's unleased inability report clears itself.

### System invariants

Per cycle (`daemon.invariants.lines`): `follow-ups-per-parent` (1 open), `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min), `cycle-p90` (30 s), `untriaged-backlog` (24 h), `deploy-lease-loss` (0); thresholds: `invariants` in `.graphyard/master.json`, enforced by `tests/soak-*.test.ts`.

## Research and diagnosis

`Recurring <class>` and `invariant:` faults past `invariantBoundMinutes` get diagnostician (`run.diagnostician`; none for parks); fix `plannedFiles` as `master create`; quota refusals wait `retryAt` (`daemon.diagnoses`); `stale`/`withdrawn` decisions, stale backlog releases: re-requested ≤3×, then `decision-stale`; raced/delivered, [plane-wide](operations.md#incident-decision-tree) requests retry faultless; refused `create` 409/400 is `fix-item`; matching close 409 adopted, mismatched held; no `loop` fault for restart-lost diagnoses or approver refusals, nor `merge` for base conflicts <30m.

## Machine-filed backlog

Review follow-ups are fixed in-PR; Pi (`run.research`) triages the rest.

## Automatic dispatch at submit

Past the build gate (`autoDispatch`): a producer request per proof group (`unit`, `integration`; `manual` with `producerProofs`; github mode only), then a review once passed (before: `proofs-pending`). **The loop launches each request within 30 seconds**: the reviewer (`run.reviewerProfile`) and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json); `.graphyard/reviews.json`, `.graphyard/producers.json`). Reviewer launches await the head's bot reviews (`run.awaitReviewers`) ≤`awaitReviewersMinutes` (8, 0 disables), skipping a bot under a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`, `dispatch.botReviewers`).

- **Concurrency is per role**: `concurrency` (1–20, default 1; above 1 each session takes a name unique to its request; `run.reviewerProfile` and producer profiles default to 4) applies without a restart; lowering it drains first (`longestWaitMs`); starved minutes: `counts.concurrencyStarved`.
- `pane_not_found` panes close. No request outlives its token: one expired, unreported by Herdr, settles `expired` (`dispatch.sessionReconcile.stuck` counts pending). Unanswered sessions relaunch (≤12 per request, then `dispatch.abandoned`); exhausted producer runs raise `escalation:proof-exhausted`, then rework.
- **Every role fails over on spent quota** or waits as one uncounted `capacity` line.

Hand review launch: only `master review GY-N [PROFILE]` once relaunching stops.

### Proofs must exercise their criterion

A passing producer records `"exercise"`: rerun without the criterion's behaviour, it must fail an executed case, else the pass is recorded as not exercising its criterion (`unexercised`, `evidence.exercise.refused`); next: `request-rework` naming proof, criterion and surviving mutation. Unexercised `manual:` proofs re-attest.

## GitHub merges

GitHub merges gate-passing heads under the `github` merger ([delivery](delivery.md#one-delivery-path)), the [merge writer](delivery-redesign.md#merge-writer) under `control-plane`; failing heads need two-party `master decide GY-N merge`; skew: `… deploy main first`; a check the base fails too is a [base failure](development.md#base-failures). Review threads are not merge blockers (`reviewThreads`); approvals list each under `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).

**Shadow gate.** Named failures fail the verdict; an exit naming none is host failure (diagnostic, retries, attention), never `shadow-only-fail`.
