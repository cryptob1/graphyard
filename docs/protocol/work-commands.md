<!-- page: Agent protocol | 2 | every mutation. -->
# Work commands

For an integration author: every mutation a principal may send, with its JSON body.

- **Notation:** `METHOD /path`; `:id` or an upper-case word is a placeholder, `(a|b)` alternatives, `[…]` optional
- `POST /api/work`: Create from [examples/work.json](../../examples/work.json): `title` and nonempty `criteria`, each with a unique `AC-N` ID, text and at least one proof; policy defaults to checks `test` and `typecheck` plus independent review; dependencies are existing UUIDs
- `POST /api/work/:id/COMMAND`: Every command below; `:id` is the UUID or display key

## Commands

- `requirements`: Full criteria, dependencies, plannedFiles, exclusiveResources, optional producerProofs, `expectedPolicyRevision` and reason; `admin`, or an operator agent holding `policy:requirements` (additive only); [coordination](../coordination.md#revise-requirements-explicitly)
- `ready`: Admin `{}`; operator-agent `{"expectedRevision":12,"reason":"Requirements approved"}`
- `unblock`: Admin `{"reason":"Contract verified"}`; operator-agent with `expectedRevision` and a nonblank reason
- `resolve`: `{"trigger":"security-concern","expectedRevision":12,"reason":"…"}` naming one standing trigger; declared human `admin` only, but `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` lets any `admin` settle a control-plane-raised `lease-loss` the ledger explains
- `rework`: `{"reason":"Retry implementation","previousWorkerStopped":true}`; `admin` only
- `recover`: `{"reason":"Verified delivered worker stopped","previousWorkerStopped":true}`; `admin` only, delivered quarantine only
- `autosettle`: `{"epoch":1,"settlementHash":"…","reason":"…","verification":{…}}`; `coordinator` or `admin` ([containment settlement](leases.md#automatic-containment-settlement))
- `decide`, `approve`: `{action, input, reason}` and `{decision, reason}` for a [two-party decision](../operator-automation.md#two-party-decisions)
- `claim`, `heartbeat`, `release`: `{}` returning the lease and epoch; `{"epoch":1}` for the other two
- `blocked`: `{"epoch":1,"reason":"Waiting for API contract"}`; `null` clears
- `workspace`: `{"epoch":1,"host":"build-machine-a","path":"/work/GY-1","branch":"graphyard/gy-1-1"}`
- `scope` (`scope-request`): `{"epoch":1,"paths":[…],"reason":"…"}` records the worker's [scope request](../coordination.md#schedule-by-overlap-smallest-scope-first), empty `paths` withdrawing it; one carrying `remove` or `criteria` is refused and escalated
- `autoscope`: `{"epoch":1}`; `coordinator` or `admin`; the control plane [decides the open request](../coordination.md#scope-requests-the-loop-decides)
- `quarantine`, `launch`, `settle`: `{epoch, settlementHash, scope?}`, `{epoch, settlementHash}` and `{epoch, settlementToken}`: the supervisor's [containment fence](leases.md)
- `submit`: `{"epoch":1,"pr":123}`; refused, naming the files, when the pull request reverts, deletes or rewrites anything outside `plannedFiles` ([guard](#submit-time-regression-guard))
- `evidence`, `revoke`: See [evidence and proof authority](evidence.md)
- `reviewpolicy`, `rereview`: See [review providers](github-webhook.md)
- `deployment`: `{"sha":"<serving commit>","mergeSha":"<the item's merge commit>","source":"endpoint","observedAt":"…"}`; coordinator or admin, delivered work only, once per delivery

## Submit-time regression guard

- **Observed before `submit` is recorded:** the pull request, through the control plane's App, outside the coordination transaction
- **Classified:** every changed file against `plannedFiles` ([the rule](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope)), each out-of-scope file compared by blob identity with the commit the candidate is bound to: the base-branch tip, or a published speculative tip's predicted base
- **Refusal:** `409` with `Submission refused for GY-N: DETAIL`, one entry per file; writes nothing, leaves no receipt: the same idempotency key may retry once the branch is fixed
- **Branch:** the observed head branch must be the epoch's registered workspace branch
- **Without GitHub configured:** no pre-check runs; the reconciliation job still evaluates the candidate

## Deployment observations

`POST /api/deployments` records one deployment-provider observation, feeding [flow analytics](../flow-analytics.md) and moving no gate.

- **Credential:** `producer` or `admin`, never a worker
- **Body:** `provider`, `externalId`, `environment`, the full artifact `sha`, one to 200 verified `containedMergeShas`, `state` (`succeeded`, `failed` or `rolled_back`), `startedAt`/`finishedAt`
- **Append-only, unique per provider, external ID and state:** a repeat replaying every immutable field returns `duplicate`; a differing one is refused

## Other mutations

Each `POST` but the webhook requires an [`Idempotency-Key`](roles.md#requests-and-retries).

- `POST /api/intake`: Records a backlog intake item; human-only origins need a credential declaring `sessionKind: "human"`
- `POST /api/work/:id/lead-ruling`: Records a [slice-lead ruling](../delegation.md)
- `POST /api/work/:id/(decide|approve)`, `GET /api/work/:id/decisions`: [Two-party decisions](../operator-automation.md#two-party-decisions)
- `POST /api/work/:id/merge-(acquire|cancel|verify|commit)`: The [guarded merge](../github.md#the-guarded-merge)'s execution authority; `coordinator` or `admin`
- `POST /api/production-observations`: A [production deployment](../shipping-pulse.md); a `producer` whose `deploymentProviders` names the provider, else 403 (missing, empty or mismatched alike), never a worker or the CI producer
- `GET|POST /api/scenarios`: Lists or defines an [E2E scenario](../test-cases.md)
- `POST /api/delivery/(build|release|approve|select|lease|observe|notify|sweep|rollback|rollback-claim|rollback-settle|rollback-resolve)`: [Delivery](../delivery.md) and [rollback](../recovery.md)
- `POST /api/validation/(define|build|candidate|request|dispatch|ack|heartbeat|collection-authority|collection-heartbeat|result|cancel|settle|retry)`: The [validation path](../validation.md)
- `POST /api/validation/(replay|reuse|artifacts|artifacts/migrate)`, `GET /api/validation/(replays|reuse|analytics|artifacts/REQUEST_ID/NAME)`: [Replay and reuse](../evidence-reuse.md), [artifacts](../recovery.md); `?preview=1` serves a PNG, JSON or plain-text artifact up to 1 MB inline
- `POST /api/proof-grants/:id/(grant|revoke)`: [Proof authority](evidence.md)
- `GET|POST /api/operator-agents`, `POST /api/operator-agents/:id/(configure|rotate|revoke)`, `GET /api/principals`: [Operator agents](../operator-automation.md); the credential-free roster for `admin`, `coordinator` and operator agents
- `POST /api/github/webhook`: [HMAC-verified](github-webhook.md), no bearer token

## CLI environment

- `GRAPHYARD_URL`, `GRAPHYARD_TOKEN` or the file `GRAPHYARD_TOKEN_FILE` names: override the saved connection
- `GRAPHYARD_REQUEST_ID`: the command's `Idempotency-Key`, otherwise generated; set it only to retry the same command after a network failure. Heartbeats, automatic ones included, and new polling attempts always use fresh keys
- `GRAPHYARD_HOST_ID`: for hostnames not globally unique; default the connection's `--host-id`, then the hostname
- **Session markers, set by launchers only:** `GRAPHYARD_MASTER=1` (`master approve` refuses under it), `GRAPHYARD_APPROVER=1`, `GRAPHYARD_REVIEW` and `GRAPHYARD_PRODUCER` (the `GY-N@SHA` answered), `GRAPHYARD_HERDR_AGENT_KIND` (with `HERDR_ENV=1`, `watch` launches contained in the foreground); worker launches strip `GRAPHYARD_TOKEN`, `GRAPHYARD_MASTER_TOKEN` and `GRAPHYARD_REQUEST_ID`
