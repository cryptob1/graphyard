<!-- page: Agent protocol | 1 | every work mutation. -->
# Work commands

Every endpoint except `/healthz` requires `Authorization: Bearer TOKEN` ([roles](../glossary.md#the-roles-at-a-glance)). Every mutation requires an `Idempotency-Key`, reused only to retry the identical request, which replays the original result. Errors are `{ "error": "reason" }`; a `409` is a coordination refusal to read, not retry blindly.

Create with `POST /api/work` ([example](../../examples/work.json)): `title` and `criteria` are required; `dependencies`, `exclusiveResources`, `plannedFiles` and `producerProofs` (the `manual:` proofs a producer may run) are optional. Other commands are `POST /api/work/KEY/COMMAND`:

- `requirements`: the whole document with `expectedPolicyRevision` and `reason`; `admin`, or additively an operator agent.
- `ready`, `unblock`: `{"reason":…}` (operator agents add `expectedRevision`).
- `resolve`: `{"trigger":…, "expectedRevision":…, "reason":…}`; a human `admin`, or any `admin` with `"attestation":{"kind":"blocked"|"stopped-worker","epoch":N}` for an explained `lease-loss`.
- `rework`, `recover`: `{"reason":…, "previousWorkerStopped":true}`; `admin` (`recover` for a delivered quarantine).
- `claim` `{}`; `heartbeat`, `release` `{"epoch":1}`; `blocked` `{"epoch":1,"reason":…}` (null clears).
- `workspace`: `{"epoch":1,"host":…,"path":…,"branch":"graphyard/gy-1-1"}`.
- `submit`: `{"epoch":1,"pr":123}`, refused with `409` when a file outside `plannedFiles` [regresses shipped code](../coordination.md#refuse-candidates-that-revert-shipped-code-outside-their-scope).
- `deployment`: `{"sha":…, "mergeSha":…, "source":"endpoint", "observedAt":…}`; coordinator or admin, delivered work, once.
- `followups` `{findings,reason}` (master; `409` unless open), `triage` `{judgement}` (coordinator), `POST /api/followups/migrate` (once): [backlog](../master-agent.md#machine-filed-backlog).

No endpoint sets lifecycle state.
