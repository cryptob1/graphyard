<!-- page: Agent protocol | 2 | every mutation. -->
# Work commands

For an integration author: every mutation a principal may send, with its JSON body.

- **Notation:** `METHOD /path`; `:id` or an upper-case word is a placeholder, `(a|b)` alternatives, `[…]` optional
- `POST /api/work`: Create from [examples/work.json](../../examples/work.json) — `title` and nonempty `criteria`, each with a unique `AC-N` ID, text and at least one proof; policy defaults to checks `test` and `typecheck` plus independent review; dependencies are existing UUIDs
- `POST /api/work/:id/COMMAND`: Every command below; `:id` is the UUID or display key

## Commands

- `requirements`: Full criteria, dependencies, plannedFiles, exclusiveResources, optional producerProofs, `expectedPolicyRevision` and reason; `admin`, or an operator agent holding `policy:requirements` (additive only) — see [coordination](../coordination.md#revise-requirements-explicitly)
- `ready`: Admin `{}`; operator-agent `{"expectedRevision":12,"reason":"Requirements approved"}`
- `unblock`: Admin `{"reason":"Contract verified"}`; operator-agent with `expectedRevision` and a nonblank reason
- `resolve`: `{"trigger":"security-concern","expectedRevision":12,"reason":"…"}` naming one standing trigger; declared human `admin` only, except that `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` lets any `admin` settle a control-plane-raised `lease-loss` the ledger explains
- `rework`: `{"reason":"Retry implementation","previousWorkerStopped":true}`; `admin` only
- `recover`: `{"reason":"Verified delivered worker stopped","previousWorkerStopped":true}`; `admin` only, delivered quarantine only
- `autosettle`: `{"epoch":1,"settlementHash":"…","reason":"…","verification":{…}}`; `coordinator` or `admin` ([containment settlement](leases.md#automatic-containment-settlement))
- `decide`, `approve`: `{action, input, reason}` and `{decision, reason}` for a [two-party decision](../operator-automation.md#two-party-decisions)
- `claim`, `heartbeat`, `release`: `{}` returning the lease and epoch; `{"epoch":1}` for the other two
- `blocked`: `{"epoch":1,"reason":"Waiting for API contract"}`; `null` clears
- `workspace`: `{"epoch":1,"host":"build-machine-a","path":"/work/GY-1","branch":"graphyard/gy-1-1"}`
- `scope` (`scope-request`): `{"epoch":1,"paths":[…],"reason":"…"}` records the worker's [scope request](../coordination.md#schedule-by-overlap-smallest-scope-first), empty `paths` withdrawing it; one carrying `remove` or `criteria` is refused and escalated
- `autoscope`: `{"epoch":1}`; `coordinator` or `admin` — the control plane [decides the open request](../master-agent.md#scope-requests-the-loop-decides) itself
- `quarantine`, `launch`, `settle`: `{epoch, settlementHash, scope?}`, `{epoch, settlementHash}` and `{epoch, settlementToken}` — the supervisor's [containment fence](leases.md)
- `submit`: `{"epoch":1,"pr":123}`; the server observes the pull request first and refuses, naming the files, when it reverts, deletes or rewrites anything outside `plannedFiles`
- `evidence`, `revoke`: See [evidence and proof authority](evidence.md)
- `reviewpolicy`, `rereview`: See [review providers](github-webhook.md)
- `deployment`: `{"sha":"<serving commit>","mergeSha":"<the item's merge commit>","source":"endpoint","observedAt":"…"}`; coordinator or admin, delivered work only, once per delivery

## Submit-time regression guard

- **Observed before `submit` is recorded:** the pull request, through the control plane's App, outside the coordination transaction
- **Classified:** every changed file against `plannedFiles` ([the rule](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope)), each out-of-scope file compared by blob identity with the commit the candidate is bound to — the base-branch tip, or the predicted base of a published speculative tip
- **Refusal:** `409` with `Submission refused for GY-N: DETAIL`, one entry per file; it writes nothing and leaves no receipt, so the same idempotency key may be retried once the branch is fixed
- **Branch:** the observed head branch must be the workspace branch registered for the epoch
- **Without GitHub configured:** no pre-check runs, though the reconciliation job still evaluates the candidate

## Deployment observations

`POST /api/deployments` records one deployment-provider observation; it feeds [flow analytics](../flow-analytics.md) without moving a gate.

- **Credential:** `producer` or `admin`, never a worker
- **Body:** `provider`, `externalId`, `environment`, the full artifact `sha`, one to 200 verified `containedMergeShas`, `state` (`succeeded`, `failed` or `rolled_back`), `startedAt`/`finishedAt`
- **Append-only, unique per provider, external ID and state:** a repeat replaying every immutable field returns `duplicate`; one that differs is refused

## Other mutations

Each requires `Idempotency-Key` and replays the original result, so a lost response never duplicates immutable history.

- `POST /api/intake`: Records a backlog intake item; human-only origins require a credential declaring `sessionKind: "human"`
- `POST /api/work/:id/lead-ruling`: Records a [slice-lead ruling](../delegation.md)
- `POST /api/work/:id/(decide|approve)`, `GET /api/work/:id/decisions`: [Two-party decisions](../operator-automation.md#two-party-decisions)
- `POST /api/work/:id/merge-(acquire|cancel|verify|commit)`: The [guarded merge](../github.md#the-guarded-merge)'s execution authority; `coordinator` or `admin`
- `POST /api/production-observations`: A [production deployment](../shipping-pulse.md); a `producer` whose `deploymentProviders` names the provider, else 403 — missing, empty or mismatched alike — and never a worker or the CI producer
- `GET|POST /api/scenarios`: Lists or defines an [E2E scenario](../test-cases.md)
- `POST /api/delivery/(build|release|approve|select|lease|observe|notify|sweep|rollback|rollback-claim|rollback-settle|rollback-resolve)`: [Delivery](../delivery.md) and [rollback](../recovery.md)
- `POST /api/validation/(define|build|candidate|request|dispatch|ack|heartbeat|collection-authority|collection-heartbeat|result|cancel|settle|retry)`: The [validation path](../validation.md)
- `POST /api/validation/(replay|reuse|artifacts|artifacts/migrate)`, `GET /api/validation/(replays|reuse|analytics|artifacts/REQUEST_ID/NAME)`: [Replay and reuse](../evidence-reuse.md), [artifacts](../recovery.md)
- `POST /api/proof-grants/:id/(grant|revoke)`: [Proof authority](evidence.md)
- `GET|POST /api/operator-agents`, `POST /api/operator-agents/:id/(configure|rotate|revoke)`, `GET /api/principals`: [Operator agents](../operator-automation.md); the credential-free roster is for `admin`, `coordinator` and operator agents
- `POST /api/github/webhook`: [HMAC-verified](github-webhook.md), no bearer token

