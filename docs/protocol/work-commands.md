<!-- page: Agent protocol | 1 | work mutations. -->
# Work commands

All endpoints but `/healthz` need `Authorization: Bearer TOKEN` ([roles](../glossary.md#the-roles-at-a-glance)); mutations need an `Idempotency-Key`, reused only to retry the identical request (replaying its result). Errors are `{"error":"reason"}`; a `409` is a coordination refusal: read it, never retry blindly.

`POST /api/work` creates ([example](../../examples/work.json)): required `title`, `criteria`; optional `dependencies`, `exclusiveResources`, `plannedFiles`, `producerProofs` (`manual:` proofs a producer may run). Others are `POST /api/work/KEY/COMMAND`:

- `requirements`: the whole document, `expectedPolicyRevision`, `reason`; `admin`, or additively an operator agent.
- `ready`, `unblock`: `{"reason":…}` (operator agents add `expectedRevision`).
- `resolve`: `{"trigger":…,"expectedRevision":…,"reason":…}`; a human `admin`, or any `admin` with `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` for an explained `lease-loss`.
- `rework`, `recover` (delivered quarantine): `{"reason":…,"previousWorkerStopped":true}`; `admin`.
- `claim` `{}`; `heartbeat`, `release` `{"epoch":1}`; `blocked` `{"epoch":1,"reason":…}` (null clears).
- `workspace`: `{"epoch":1,"host":…,"path":…,"branch":"graphyard/gy-1-1"}`.
- `submit`: `{"epoch":1,"pr":123}`; `409` when a file outside `plannedFiles` [regresses shipped code](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope).
- `deployment`: `{"sha":…,"mergeSha":…,"source":"endpoint","observedAt":…}`; coordinator or admin, delivered work, once.
- `followups` `{findings,reason}` (master), batch reads and `promote` `{index}`: [follow-ups](../followups.md); appending to a closed legacy follow-up item is a `409`. `triage` `{judgement}` (coordinator), `POST /api/followups/migrate` (once): [backlog](../master-agent.md#machine-filed-backlog).
- `POST /api/retro/synthesize` (coordinator/admin) drafts [retro artefacts](../operations-reference.md#retro-synthesis) under the caller; `POST /api/retro/ID/approve|refuse` `{reason}`: an AI admin or operator agent holding `decision:approve`, never a human session, the drafter or an identity that recorded the instances (`403`; `409` once judged). `submit` is also refused while the candidate fails an applied retro check.
No endpoint sets lifecycle state.
