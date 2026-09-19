<!-- page: Agent protocol | 4 | creating work and every `POST /api/work/UUID/COMMAND` mutation. -->
# Work commands

Create with `POST /api/work` and the structure in [examples/work.json](../../examples/work.json). Required fields are `title` and nonempty `criteria`; each criterion requires a unique `AC-N` ID, text, and at least one proof, and may carry an operator-only `bootstrap` declaration. The policy defaults to checks `test` and `typecheck`, plus independent review. Dependencies refer to existing UUIDs. Operator requirement revisions explicitly reject cycles. Optional `exclusiveResources` reserves named resources during active ownership; `plannedFiles` declares the change boundary the [regression guard](regression-guard.md#submit-time-regression-guard) enforces at submit and the scopes overlap warnings compare.

Human-only intake origins additionally require a credential declaring `sessionKind: "human"`; routine origins are unchanged. `POST /api/intake` records a backlog intake item and `POST /api/work/UUID/lead-ruling` records a slice-lead ruling; both require `Idempotency-Key` and replay the original result, so a lost response never duplicates immutable history. See [slice-lead delegation](../delegation.md).

Other commands use `POST /api/work/UUID/COMMAND` (display keys also work):

| Command | JSON body |
| --- | --- |
| `requirements` | Full criteria, dependencies, plannedFiles, exclusiveResources, expectedPolicyRevision and reason; operator only, see [coordination](../coordination.md). A criterion may carry `bootstrap`, see [bootstrap mode](bootstrap-mode.md) |
| `ready` | Admin: `{}`. Operator-agent: `{"expectedRevision":12,"reason":"Requirements approved"}` with the current work revision and a nonblank audit reason. |
| `unblock` | Admin: `{"reason":"Contract verified"}`. Operator-agent: `{"expectedRevision":12,"reason":"Contract verified"}` with the current work revision and a nonblank audit reason. |
| `resolve` | `{"trigger":"security-concern","expectedRevision":12,"reason":"Dependency change reviewed"}` naming one standing escalation trigger, the current work revision, and a nonblank audit reason; admin credentials declaring `sessionKind: "human"` only |
| `rework` | `{"reason":"Retry implementation","previousWorkerStopped":true}`; operator only |
| `recover` | `{"reason":"Verified delivered worker stopped","previousWorkerStopped":true}`; operator only, delivered quarantine only |
| `autosettle` | `{"epoch":1,"settlementHash":"...","reason":"Supervisor verified dead","verification":{...}}`; coordinator or operator, see [automatic containment settlement](containment-settlement.md) |
| `claim` | `{}`; returns current lease and epoch |
| `heartbeat` | `{"epoch":1}` |
| `release` | `{"epoch":1}` |
| `blocked` | `{"epoch":1,"reason":"Waiting for API contract"}`; null clears |
| `workspace` | `{"epoch":1,"host":"build-machine-a","path":"/work/GY-1","branch":"graphyard/gy-1-1"}` |
| `submit` | `{"epoch":1,"pr":123}`; the server observes the pull request first and refuses, naming the files, when it reverts, deletes or rewrites files outside `plannedFiles` relative to the base it is bound to, see [regression guard](regression-guard.md#submit-time-regression-guard) |
| `evidence` | See below |
| `revoke` | See [revocation](evidence.md#revocation) |
| `deployment` | `{"sha":"<serving commit>","mergeSha":"<the item's merge commit>","source":"endpoint","observedAt":"2026-09-18T10:00:00Z"}`; coordinator or admin, delivered work only, once per delivery. Whether the serving commit is the merge itself or a descendant is derived, never asserted. See [post-deployment smoke proof](../github.md#post-deployment-smoke-proof) |

No endpoint sets arbitrary lifecycle state. `complete` in the CLI maps to `submit`, not `done`. Delivered work accepts only `deployment` and `e2e:deploy-smoke` evidence, which extend the delivery snapshot without re-evaluating it.
