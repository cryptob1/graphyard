<!-- page: Agent protocol | 2 | creating work and every mutation. -->
# Work commands

For an integration author: every mutation a principal may send, with its JSON body.

- `requirements`: Full criteria, dependencies, plannedFiles, exclusiveResources, optional producerProofs, `expectedPolicyRevision` and reason; `admin`, or an operator agent holding `policy:requirements` (additive only) — see [coordination](../coordination.md#revise-requirements-explicitly)
- `ready`: Admin `{}`; operator-agent `{"expectedRevision":12,"reason":"Requirements approved"}`
- `unblock`: Admin `{"reason":"Contract verified"}`; operator-agent with `expectedRevision` and a nonblank reason
- `resolve`: `{"trigger":"security-concern","expectedRevision":12,"reason":"…"}` naming one standing trigger; declared human `admin` only, except that `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` lets any `admin` settle a control-plane-raised `lease-loss` the ledger explains, verified server-side
- `rework`: `{"reason":"Retry implementation","previousWorkerStopped":true}`; `admin` only
- `recover`: `{"reason":"Verified delivered worker stopped","previousWorkerStopped":true}`; `admin` only, delivered quarantine only
- `autosettle`: `{"epoch":1,"settlementHash":"…","reason":"…","verification":{…}}`; `coordinator` or `admin` ([containment settlement](leases.md#automatic-containment-settlement))
- `decide`, `approve`: `{action, input, reason}` and `{decision, reason}` for a [two-party decision](../operator-automation.md#two-party-decisions)
- `claim`, `heartbeat`, `release`: `{}` returning the lease and epoch; `{"epoch":1}` for the other two
- `blocked`: `{"epoch":1,"reason":"Waiting for API contract"}`; `null` clears
- `workspace`: `{"epoch":1,"host":"build-machine-a","path":"/work/GY-1","branch":"graphyard/gy-1-1"}`
- `scope`, `scope-request`: The master approves requested paths; a worker requests them while keeping its lease
- `submit`: `{"epoch":1,"pr":123}`; the server observes the pull request first and refuses, naming the files, when it reverts, deletes or rewrites anything outside `plannedFiles`
- `evidence`, `revoke`: See [evidence and proof authority](evidence.md)
- `reviewpolicy`, `rereview`: See [review providers](github-webhook.md)
- `deployment`: `{"sha":"<serving commit>","mergeSha":"<the item's merge commit>","source":"endpoint","observedAt":"…"}`; coordinator or admin, delivered work only, once per delivery

## Submit-time regression guard

Before `submit` is recorded, the control plane observes the pull request through its App, outside the coordination transaction, and classifies every changed file against `plannedFiles` ([the rule](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope)). Each out-of-scope file is compared by blob identity with the commit the candidate is bound to — the base-branch tip, or the predicted base of a published speculative tip. The refusal is `409` with `Submission refused for GY-N: DETAIL`, one entry per file; it writes nothing and leaves no receipt, so the same idempotency key may be retried once the branch is fixed. The observed head branch must also be the workspace branch registered for the epoch, and without GitHub configured no pre-check runs, while the reconciliation job still evaluates the candidate.

## Deployment observations

`POST /api/deployments` records one deployment-provider observation from a `producer` or `admin` credential; workers cannot. It carries `provider`, `externalId`, `environment`, the full artifact `sha`, one to 200 independently verified full `containedMergeShas`, a `state` of `succeeded`, `failed` or `rolled_back`, and `startedAt`/`finishedAt`. Records are append-only and unique per provider, external ID and state: a repeat replaying every immutable field returns `duplicate`, one that differs is refused. They feed [flow analytics](../flow-analytics.md) and never move a gate.
