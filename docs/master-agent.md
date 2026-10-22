<!-- page: Operate Graphyard | 5 | loop -->
# Master-agent operating mode

The master (`coordinator`) routes and administers remote access unasked, never implementing, reviewing or proving; it files and releases items itself ([intent](how-graphyard-works.md#from-intent-to-work-items)). Human-only: goals and priorities, spending money or opening third-party accounts, issuing credentials to people.

## Operate

Keep cycling: `master status`; `master run` dispatches; merge gate-passing candidates; rework findings; deployment verification (one release health line; an item is delivered at merge); control plane performs "Close finished agent sessions". A loop-owned observation item's due reading is recorded on the serving release; `master reading GY-N pass|fail DETAIL` records one by hand. The [browser flows](master-agent-reference.md#github-administration-through-the-browser) refuse: the deploy key is the only remote credential. Stop only when every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, release health healthy or deployment-blocked. Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions.

`master restart` (stalled loop) runs `systemctl --user restart graphyard-master.service` if the [unit](onboarding.md#the-loop-must-be-supervised)'s ExecStart is node `cliPath` `master run`, else detached; never from [dirty checkouts](master-agent-sessions.md#the-coordinator-checkout-is-confined-at-the-os-level). Loop sleeps `run.intervalSeconds` (≤30s actionable).

### System-driven items

Unless created `"systemDriven": false`, items refuse hand `dispatch`, `merge`, `review`, loop-owned `rework`. The loop attests unproduced `manual:` proofs per head, base and policy revision.

### Session liveness is reconciled, not trusted

Sweeps run every automatic-dispatch tick; a handle closes at the second consecutive miss. Closures: **Vanished**, **Ended** (terminal; `idle`/`done`/`blocked` are not terminal), **Superseded**, **Duplicate** — a closure decides no gate. Past its role's maximum a session is flagged, not closed.

`blocked` frees its slot; its [reason](protocol/work-commands.md#blocked-work) stays in `master status` until the master clears it.

`invariant:` lines are attention, never items. Review follow-ups are ordinary backlog items the master releases.

## Automatic dispatch at submit

Past the build gate: a producer request per proof group (`unit`, `integration`; `manual` with `producerProofs`), then a review once passed. **The loop launches each request within 30 seconds** (`run.reviewerProfile`, producer profiles, 4 sessions each). Reviewer launches await head's bot reviews ≤`awaitReviewersMinutes` (8, 0 disables), skipping a bot under a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`, `dispatch.botReviewers`).

**Concurrency is per role** (1–20, default 1). Unanswered sessions relaunch, then `dispatch.abandoned`; exhausted producers rework. **Every role fails over on spent quota** or waits as one `capacity` line.

### System invariants

Per cycle (`daemon.invariants.lines`): `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min); `invariants` in `.graphyard/master.json`; `tests/soak-*.test.ts`.
