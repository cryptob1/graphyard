<!-- page: Agent protocol | 4 | creating work and every `POST /api/work/UUID/COMMAND` mutation. -->
# Work commands

Create with `POST /api/work` using [examples/work.json](../../examples/work.json). `title` and `criteria` are required; each criterion has a unique `AC-N` id, text and at least one proof, and may carry `bootstrap` ([bootstrap mode](bootstrap-mode.md)). Optional: `dependencies` (UUIDs), `exclusiveResources`, `plannedFiles` (enforced by the [regression guard](regression-guard.md#submit-time-regression-guard)), and `producerProofs`, the `manual:` proofs a launched producer may run ([automatic dispatch](github-webhook.md#automatic-dispatch-at-submit)).

`POST /api/intake` and `POST /api/work/UUID/lead-ruling` record intake and slice-lead rulings ([delegation](../delegation.md)).

Other commands are `POST /api/work/UUID/COMMAND` (display keys work too):

| Command | Body and who |
| --- | --- |
| `requirements` | Full criteria, dependencies, plannedFiles, exclusiveResources, producerProofs, `expectedPolicyRevision`, `reason`; `admin`, or additively an operator agent with `policy:requirements` |
| `ready`, `unblock` | Admin `{}` / `{"reason":…}`; operator agent `{"expectedRevision":12,"reason":"…"}` |
| `resolve` | `{"trigger":"security-concern","expectedRevision":12,"reason":"…"}`; human `admin`, or any `admin` with `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` for an explained `lease-loss` ([leases](leases.md)) |
| `rework` | `{"reason":"…","previousWorkerStopped":true}`; `admin` |
| `recover` | `{"reason":"…","previousWorkerStopped":true}`; `admin`, delivered quarantine only |
| `autosettle` | See [containment settlement](containment-settlement.md) |
| `claim` | `{}` |
| `heartbeat`, `release` | `{"epoch":1}` |
| `blocked` | `{"epoch":1,"reason":"…"}`; null clears |
| `workspace` | `{"epoch":1,"host":"build-machine-a","path":"/work/GY-1","branch":"graphyard/gy-1-1"}` |
| `submit` | `{"epoch":1,"pr":123}` |
| `evidence`, `revoke` | See [evidence](evidence.md#revocation) |
| `deployment` | `{"sha":"…","mergeSha":"…","source":"endpoint","observedAt":"…"}`; coordinator or admin, delivered work, once ([smoke proof](../github.md#post-deployment-smoke-proof)) |

No endpoint sets lifecycle state. `complete` maps to `submit`. Delivered work accepts only `deployment` and `e2e:deploy-smoke` evidence.
