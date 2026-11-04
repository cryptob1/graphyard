<!-- page: Agent protocol | 1 | claim, submit and report results -->
# Work commands

Except `/healthz`, requests need `Authorization: Bearer TOKEN`. Mutations need `Idempotency-Key`, reused only for identical retries. Errors return `{"error":"reason"}`; 409 is a refusal, not a transport retry.

## Create and change work

`POST /api/work` takes title/criteria, optionally dependencies, plannedFiles, exclusiveResources and producerProofs ([example](../../examples/work.json)). Review uses a recorded reviewer-session verdict; retired `codex` and `agent` policy providers are refused. The UI offers no provider selector. Mutations use `POST /api/work/KEY/COMMAND`:

| Command | Required data/rule |
| --- | --- |
| requirements | Document, expectedPolicyRevision, reason; admin or additive operator-agent changes. Stale revision refuses first. |
| ready, unblock | Reason; operator agents send expectedRevision. Master unblock retries stale revisions up to three times. |
| rework | Reason and previousWorkerStopped; waits for another standing candidate. |
| repair | Coordinator/admin rebuilds a head carrying unlanded commits. |
| claim | Empty body. |
| heartbeat, release | Epoch; release cause/failure records workspace.failed. |
| blocked | Epoch and reason; reason releases, null clears. |
| workspace | Epoch, host, path, branch. |
| review-launch, review-verdict | [Candidate binding](../coordination.md#review-gate-verdicts-not-threads). |
| deployment | Coordinator observation. |

Loop-owned items refuse ready/unblock. Owner-held items (`Owner hold:`, explicit owner release or `manual:owner-schedules…`) need the human admin's recorded answer.

## Submit a commit

`complete GY-N EPOCH --head SHA` submits without pushing and ends the lease. The writer allocates `candidate.pr`/`submission.pr` as change numbers; pull request numbers are refused. No endpoint sets lifecycle state.

Complete reruns cases named by the latest trial-test refusal. Each head retry and base run owns and removes a short directory under durable `/var/tmp`, outside the checkout, with fresh writable HOME/XDG directories and sticky scratch; it never writes to the operator’s home. Own-proof failure refuses with case/file/line. Other failures retry on head and base: retry passes record flakes; base failures are recorded; failing head with passing base refuses. An indeterminate rerun records its cause and last 20 lines and leaves judgment to the merge trial. Failed retro checks return 409.

## Reads

`GET /healthz` is public. `/api/status` reports principal, integrations, jobs, writer and clock. `/api/work/ID|KEY` reads one item; `/api/work` lists full open work and summarized deliveries. `/api/github/*` returns 404.

## Leases, evidence, pipeline

Claims last 120 seconds; renew at least every 30 seconds. Owner mutations need the current epoch. Register assigned host/path/branch before submitting. Stop immediately on lease loss.

`complete GY-N EPOCH` submits the worktree's HEAD, as does a bare `--head`; `--head SHA` names another commit. Head observation happens before the submission transaction; that transaction checks lease expiry, including recorded renewal grace.

### Watch

`watch GY-N EPOCH -- COMMAND` supervises the worker, supplies its identity, removes server/database secrets and terminates its process group on lease loss (SIGTERM then SIGKILL). Transport 5xx/408/429 retry with backoff; refusals stop. Exit records a cause; dead-supervisor leases expire. Workers push nothing.

### How a lease ends

Submit, park, blocked or expiry ends the attempt. Complete must be the last action. Coordinator capacity/exhausted frees another account. Expiry classes: blocked-awaiting-operator, stopped-by-attestation, exhausted-capacity, control-plane-stall, control-plane-deploy and no-submission-bound.

### Blocked work

`blocked GY-N EPOCH REASON` commits changes, releases and records plain text. `master unblock GY-N REASON` clears it. For the human's three decisions, read `guide park`.

### Evidence and pipeline

`POST /api/work/UUID/evidence` takes proof, sha, baseSha, policyRevision, result and executed. The server sets identity/time/trust; out-of-grant proofs are untrusted and later failures supersede passes. Admin revoke withdraws a tuple's records. Commands append history, never set gates. Control-plane acceptance reads trial counts for unit/integration/E2E; producer evidence cannot replace them. Workers supply no trusted evidence for their own work.

## Other commands and routes

Retired reads (`events/stats`, `actions`, attribution analytics and manifests, validation `seal-authority`, and registry `connect/hosts`) return 404 after authentication. The dashboard uses board, snapshot and detail routes.

`graphyard help` lists commands. Exact API schemas live under `src/server/routes/` and `src/model/`.
