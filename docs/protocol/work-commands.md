<!-- page: Agent protocol | 1 | work mutations. -->
# Work commands

All but `/healthz` need `Authorization: Bearer TOKEN` ([roles](../glossary.md#the-roles-at-a-glance)); mutations `Idempotency-Key`, reused only for identical retries. Errors: `{"error":"reason"}`; `409`: refusal, not retried.

`POST /api/work` ([example](../../examples/work.json)): `title`, `criteria`; optionally `dependencies`, `exclusiveResources`, `split` ([decomposition](#splitting-an-item) opt-out/in), `producerProofs`. Others: `POST /api/work/KEY/COMMAND`:

- `requirements`: document, `expectedPolicyRevision`, `reason`; `admin`, operator agents additively; stale revisions refused first.
- `decomposition` (coordinator): `decided` (`payload.children`) [splits](#splitting-an-item).
- `ready`, `unblock` `{"reason":…}` (operator agents: `expectedRevision`; `master unblock` retries stale ≤3); loop-owned items refuse them, and owner-held ones (`Owner hold:` title, "until the owner releases it", `manual:owner-schedules…`) refuse all but a human admin session until a provided answer to a human-only request on the item records the owner's decision.
- `rework`: `{"reason":…,"previousWorkerStopped":true}`, waiting while another candidate stands; `repair` (coordinator/admin) rebuilds a head carrying another item's unlanded commits.
- `claim` `{}`; `heartbeat`; `release` `{"epoch":1}` (`"cause"` or `"failure":{…}` → `workspace.failed`); `blocked` `{"epoch":1,…}` (reason releases, null clears); `blocker-probe` (`pass` clears a routine [blocker](#blocked-work-unblocks-itself)); `review-launch`/`review-verdict` ([review](../coordination.md#review-gate-verdicts-not-threads)); `workspace` `{epoch, host, path, branch}`.
- `submit`: `{"epoch":1,"head":SHA}` (`complete GY-N EPOCH --head [SHA]`; nothing is pushed): the control plane, the only [merger](../delivery-redesign.md#the-merger), allocates one change number per head into `candidate.pr`/`submission.pr`; the older `{"epoch":1,"pr":123}` form answers only pre-merge-writer changes. complete first re-runs the failing tests the latest `trial failed: tests …` refusal names, refusing while one fails. `409` if applied retro check fails.
- `deployment`, `triage` `{judgement}` (coordinator).

No endpoint sets lifecycle state.

## Reads

`GET /healthz` (unauthenticated); `/api/status`: principal, integrations, jobs, `mergeWriter`, `leadTime`, clock; `/api/github/*` answers 404. `GET /api/work/ID|KEY`: one item; `/api/work`: the fleet (open items whole, settled deliveries summarized), `?pr=N` only the item whose candidate or submission carries that legacy number (else `[]`).

## Leases, evidence, pipeline

Claims last 120s, renewed every ≤30s; owner mutations carry epoch. Register branch, path, host first.

### Watch

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials; lease loss SIGTERM→SIGKILLs the process group. Calls ride 5xx/408/429 with backoff; refusals stop at once; on exit `watch` ends the attempt with cause; a dead supervisor's lease lapses and the item is claimable again. Workers get no remote credential and push nothing.

### How a lease ends

- `submit`; later heartbeats are told to stop after `complete`.
- `park` (human-only request naming every human step) or `blocked` releases; coordinator `capacity` (`event: "exhausted"`) frees another account.
- Expiry classes (`lease.expired`): `blocked-awaiting-operator`, `stopped-by-attestation`, `exhausted-capacity`, `control-plane-stall`, `control-plane-deploy`, `no-submission-bound`; any lapse ends the attempt.

### Blocked work unblocks itself

`blocked GY-N EPOCH REASON` commits uncommitted work, releases, carries the reason over. The `blockers` step probes environmental [classes](../master-agent.md#session-liveness-is-reconciled-not-trusted); `host-supervisor` revives an unanswering user manager (`loginctl enable-linger`). A pass (`POST /api/work/KEY/blocker-probe`) emits `blocker.cleared`; `genuine`, `human-only`, `master-role` stay in `master status`. An unleased loop-owned item blocked only on the worker's missing reading self-clears (GY-1768).

### Evidence and pipeline

`POST /api/work/UUID/evidence` (`proof`, `sha`, `baseSha`, `policyRevision`, `result`, `executed`): the server sets identity, time, trust; ungranted proofs store untrusted; later failures supersede passes; `POST /api/work/:id/revoke` (`admin`) withdraws one tuple's records. Lifecycle commands append to each item's `pipeline`, never moving a gate.

## Splitting an item

Over `run.decomposition` bounds a read-only Pi session (`run.research`) proposes 2–10 children; `"split": true` forces it. Last delivery delivers the parent.

## Other commands and routes

`graphyard help` lists commands. Routes: `/api/actions[/claim]`, `/api/assignments/claim`, `/api/agent-registry[/apply|select|observe|document|history|connect]`, `/api/validation/[analytics|capacity|definitions|artifacts|replay|reuse|collection-authority|cancel|settle|retry]`, `/api/delivery/[observations|select|sweep]`, `/api/direct-merges[/on|off]`, `/api/events/stats`, `/api/human-requests`, `/api/intake`, `/api/operator-agents`, `/api/principals`, `/api/production-environment`, `/api/scenarios`, and pattern routes under `/api/work/ID` and `/api/agent-registry`.
